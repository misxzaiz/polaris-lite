/** 消息流：编辑式助手排版 + 收敛的用户消息 + 消息操作条，保留贴底跟随。
 *  P0/P1 消息操作：复制 / 编辑重答（仅最后一轮）/ 回填 / 重发 / 跳到本条开头 / 重新生成；
 *  滚动导航（回到底部胶囊 + 回顶部）锚定在 stream-area 内，不压输入框。 */
import { useEffect, useRef, useState } from 'react';
import { useSessionStore, isToolCard, hasBlocks, type StoreMessage, type ToolCardMessage } from './store';
import { EmptyState } from './EmptyState';
import { Markdown } from './markdown';
import { ToolCard } from './ToolCard';
import { PolarisMark, UserIcon, CopyIcon, CheckIcon, EditIcon, ResendIcon, RegenIcon, JumpIcon, BackfillIcon } from './icons';
import { onStreamRetry, resumeTruncated, requestCompose, resendMessage, editResendLast, regenerateLast, assistantVisibleText } from './index';
import { renderBlocks } from './BlockGroup';

/** 编辑态：一次只编辑一条；draft 进状态（确认条重建 DOM 不丢稿） */
interface EditState { msgId: string; draft: string; confirm: boolean }

/** 单条消息行：气泡（或编辑态）+ 悬浮操作条。
 *  动作范围：用户消息 = 复制 / [编辑|回填] / 重发；AI 消息 = 复制 / [开头] / [重新生成]。
 *  编辑仅最后一轮且非流式；重新生成仅末条 AI 且非流式；流式中重发转排队。 */
function MessageRow({ m, sid, isLastUser, isLast, isLong, sessionStreaming, editing, setEditing, onConfirm }: {
  m: StoreMessage;
  sid: string;
  isLastUser: boolean;
  isLast: boolean;
  isLong: boolean;
  sessionStreaming: boolean;
  editing: EditState | null;
  setEditing: (v: EditState | null) => void;
  onConfirm: (msgId: string, draft: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);

  const isUser = !isToolCard(m) && m.role === 'user';
  const isEditing = editing?.msgId === m.id;

  const doCopy = async () => {
    const text = isUser ? m.content : assistantVisibleText(m);
    if (!text.trim()) return;
    try { await navigator.clipboard.writeText(text); } catch { /* 剪贴板受限：静默 */ }
    setCopied(true);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1200);
  };

  const actions: React.ReactNode[] = [];
  actions.push(
    <button key="copy" type="button" className={`msg-act${copied ? ' done' : ''}`}
      title={isUser ? '复制原文' : '复制正文（不含思考/工具卡/提示）'}
      onClick={() => void doCopy()}>
      {copied ? <CheckIcon /> : <CopyIcon />}<span className="lbl">复制</span>
    </button>,
  );
  if (isUser) {
    if (isLastUser && !sessionStreaming && !isEditing) {
      actions.push(
        <button key="edit" type="button" className="msg-act"
          title="编辑并重答（截断此轮回复，并从所有设备上移除）"
          onClick={() => setEditing({ msgId: m.id, draft: m.content, confirm: false })}>
          <EditIcon /><span className="lbl">编辑</span>
        </button>,
      );
    }
    if (!isLastUser) {
      actions.push(
        <button key="backfill" type="button" className="msg-act" title="回填输入框（不发送，取回再编辑）"
          onClick={() => requestCompose(m.content)}>
          <BackfillIcon /><span className="lbl">回填</span>
        </button>,
      );
    }
    actions.push(
      <button key="resend" type="button" className="msg-act"
        title={sessionStreaming ? '重发（当前回复结束后自动发出）' : '重发（追加新一轮，保留历史）'}
        onClick={() => resendMessage(sid, m.id)}>
        <ResendIcon /><span className="lbl">重发</span>
      </button>,
    );
  } else {
    if (isLong) {
      actions.push(
        <button key="jump" type="button" className="msg-act" title="跳到本条消息的开头"
          onClick={() => rowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
          <JumpIcon /><span className="lbl">开头</span>
        </button>,
      );
    }
    if (isLast && !sessionStreaming) {
      actions.push(
        <button key="regen" type="button" className="msg-act" title="重新生成（同提示词重答，替换本轮回复）"
          onClick={() => void regenerateLast(sid)}>
          <RegenIcon /><span className="lbl">重新生成</span>
        </button>,
      );
    }
  }

  return (
    <div ref={rowRef} data-mid={m.id}
      className={`chat-msg ${m.role}${isEditing ? ' editing' : ''}${m.streaming ? ' streaming' : ''}`}>
      <div className="chat-avatar" aria-hidden="true">
        {isUser ? <UserIcon /> : <PolarisMark size={19} />}
      </div>
      <div className="chat-bubble-col">
        {isEditing && editing ? (
          <EditBox editing={editing} setEditing={setEditing} onConfirm={onConfirm} />
        ) : (
          <div className={`chat-bubble ${!isUser ? 'markdown' : ''}`}>
            {!isUser && hasBlocks(m)
              ? renderBlocks(m.blocks, !!m.streaming, () => resumeTruncated(sid, m.id))
              : !isUser
                ? <Markdown text={m.content} />
                : m.content}
            {m.streaming && !hasBlocks(m) && <span className="cursor" />}
          </div>
        )}
        {!isEditing && <div className="msg-actions">{actions}</div>}
      </div>
    </div>
  );
}

/** 编辑态：内联编辑框 + 保存并重答（两步：先出破坏性确认条，再确认执行）。Enter 推进 / Esc 取消。 */
function EditBox({ editing, setEditing, onConfirm }: {
  editing: EditState;
  setEditing: (v: EditState | null) => void;
  onConfirm: (msgId: string, draft: string) => void;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }, []);
  const confirmNow = () => {
    const { msgId, draft } = editing;
    setEditing(null); // 先关编辑态再提交（重答后该消息以新 id 重建）
    onConfirm(msgId, draft);
  };
  const step = () => { if (editing.confirm) confirmNow(); else setEditing({ ...editing, confirm: true }); };
  return (
    <div className="edit-box">
      <textarea
        ref={taRef}
        className="edit-textarea"
        rows={3}
        aria-label="编辑消息"
        value={editing.draft}
        onChange={(e) => setEditing({ ...editing, draft: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); setEditing(null); return; }
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); step(); }
        }}
      />
      {editing.confirm ? (
        <div className="edit-confirm" role="alert">
          <span>保存后会截断此轮之后的消息，并从所有设备上移除。</span>
          <button type="button" className="go" onClick={confirmNow}>确认截断并重答</button>
          <button type="button" onClick={() => setEditing({ ...editing, confirm: false })}>再想想</button>
        </div>
      ) : (
        <div className="edit-btns">
          <button type="button" onClick={() => setEditing(null)}>取消</button>
          <button type="button" className="primary" onClick={step}>保存并重答</button>
        </div>
      )}
    </div>
  );
}

export function MessageStream() {
  const activeId = useSessionStore((s) => s.activeId);
  const session = useSessionStore((s) => s.sessions.find((x) => x.id === s.activeId));
  const bottomRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [showTop, setShowTop] = useState(false);
  const [missed, setMissed] = useState(0);
  const atBottomRef = useRef(true);
  const prevCountRef = useRef<{ sid: string | null; count: number }>({ sid: null, count: 0 });
  const [longMsgIds, setLongMsgIds] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<EditState | null>(null);
  // 断流自动重试提示（瞬态，不进 store/历史）：引擎每次重试推送 {attempt, max, chars}，
  // 流正常结束/报错时隐藏（retry 由引擎发完最后一次后必然跟着 done/error）
  const [retrying, setRetrying] = useState<{ attempt: number; max: number } | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = onStreamRetry((attempt, max) => {
      setRetrying({ attempt, max });
      // 保险隐藏：引擎侧退避后重试成功会发 delta/done，若事件丢失此兜底 60s 后自清
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setRetrying(null), 60_000);
    });
    return () => { off(); if (timer) clearTimeout(timer); };
  }, []);

  // 滚动监听：依赖 activeId 重绑——空态分支与主分支是不同的 .chat-stream 节点，
  // 若只在挂载时绑定一次，空态启动（ref 空）后永不重绑，atBottom 将永远为 true
  // （贴底跟随会反复把用户拉回底部，滚动胶囊永不出现）。
  useEffect(() => {
    const el = streamRef.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      const bottom = distance < 80;
      atBottomRef.current = bottom;
      setAtBottom(bottom);
      setShowTop(el.scrollTop > 400);
      if (bottom) setMissed((n) => (n !== 0 ? 0 : n));
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [activeId]);

  const messages = session?.messages ?? [];
  const msgCount = messages.length;
  const lastContent = messages[msgCount - 1]?.content ?? '';
  // 会话级在途流：编辑/重新生成按此隐藏（重发转排队），复制/开头不受限
  const sessionStreaming = messages.some((m) => !isToolCard(m) && m.streaming);
  const lastUserId = [...messages].reverse().find((mm) => !isToolCard(mm) && mm.role === 'user')?.id ?? null;

  // 错过的消息数（回到底部胶囊的「有新内容 N 条」）：同会话内消息增长且人不在底部时累计
  useEffect(() => {
    const prev = prevCountRef.current;
    if (prev.sid !== activeId) setMissed(0);
    else if (msgCount > prev.count && !atBottomRef.current) setMissed((n) => n + (msgCount - prev.count));
    prevCountRef.current = { sid: activeId, count: msgCount };
  }, [msgCount, activeId]);

  // ⑦ 长消息标记：超过大半屏的 AI 消息才显示「开头」按钮（短消息点了没意义）
  useEffect(() => {
    const el = streamRef.current;
    if (!el) return;
    const next = new Set<string>();
    el.querySelectorAll<HTMLElement>('.chat-msg.assistant[data-mid]').forEach((node) => {
      const id = node.getAttribute('data-mid');
      if (id && node.getBoundingClientRect().height > el.clientHeight * 0.6) next.add(id);
    });
    setLongMsgIds((cur) => {
      if (cur.size === next.size && [...next].every((id) => cur.has(id))) return cur;
      return next;
    });
  });

  const lastActivity = (() => {
    const last = messages[msgCount - 1];
    if (!last) return 0;
    let size = (last.content ?? '').length;
    if (hasBlocks(last)) {
      for (const b of last.blocks) {
        size += b.type === 'text' || b.type === 'thinking' ? b.text.length : 40;
      }
    }
    return size;
  })();

  useEffect(() => {
    if (!atBottom) return;
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [msgCount, lastActivity, lastContent, atBottom]);

  // 待审批计数（块内 + 旧版独立卡）
  const awaitingCallId = (() => {
    for (const m of messages) {
      if (hasBlocks(m)) {
        const blk = m.blocks.find((b) => b.type === 'tool' && b.card.status === 'awaiting');
        if (blk && blk.type === 'tool') return blk.card.callId;
      }
      if (isToolCard(m) && m.tool.status === 'awaiting') return m.tool.callId;
    }
    return null;
  })();
  const awaitingCount = messages.reduce((n, m) => {
    if (hasBlocks(m)) return n + m.blocks.filter((b) => b.type === 'tool' && b.card.status === 'awaiting').length;
    if (isToolCard(m) && m.tool.status === 'awaiting') return n + 1;
    return n;
  }, 0);
  const lastScrolledApproval = useRef<string | null>(null);

  // 审批到达 → 无视 atBottom 强制居中滚入（需要用户行动的事件，抢焦点是正确语义）
  useEffect(() => {
    if (!awaitingCallId || lastScrolledApproval.current === awaitingCallId) return;
    lastScrolledApproval.current = awaitingCallId;
    const tryScroll = (attempt: number) => {
      const el = streamRef.current?.querySelector(`[data-call-id="${awaitingCallId}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else if (attempt < 10) {
        // 块渲染在下一帧才出现：rAF 重试
        requestAnimationFrame(() => tryScroll(attempt + 1));
      }
    };
    requestAnimationFrame(() => tryScroll(0));
  }, [awaitingCallId]);

  if (!activeId || !session) {
    return <div className="stream-area"><div className="chat-stream" data-testid="message-stream" ref={streamRef}><EmptyState variant="no-session" /></div></div>;
  }
  if (session.messages.length === 0) {
    return <div className="stream-area"><div className="chat-stream" data-testid="message-stream" ref={streamRef}><EmptyState variant="no-message" /></div></div>;
  }

  return (
    <div className="stream-area">
      <div className="chat-stream" data-testid="message-stream" ref={streamRef}>
        <div className="chat-conversation">
          {messages.map((m) =>
            isToolCard(m) ? (
              <ToolCard key={m.id} msg={m as ToolCardMessage} />
            ) : (
              <MessageRow
                key={m.id}
                m={m}
                sid={session.id}
                isLastUser={m.id === lastUserId}
                isLast={m.id === messages[msgCount - 1]?.id}
                isLong={longMsgIds.has(m.id)}
                sessionStreaming={sessionStreaming}
                editing={editing}
                setEditing={setEditing}
                onConfirm={(msgId, draft) => void editResendLast(session.id, msgId, draft)}
              />
            ),
          )}
          <div ref={bottomRef} />
          {retrying && (
            <div className="stream-retry-banner" role="status">
              <span className="stream-retry-spinner" aria-hidden="true" />
              连接中断，正在自动重试 {retrying.attempt}/{retrying.max}（已生成内容会接续保留）…
            </div>
          )}
        </div>
        {/* 待审批胶囊：sticky 在滚动容器内（吸附可视区底部） */}
        {awaitingCount > 0 && (
          <button
            type="button"
            className="tc-await-pill"
            onClick={() => {
              const el = streamRef.current?.querySelector(`[data-call-id="${awaitingCallId}"]`);
              el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }}
          >
            {awaitingCount} 项工具执行待确认 · 点击定位
          </button>
        )}
      </div>
      {/* 滚动导航：锚定消息流区域，贴输入框上沿（不入输入框）；missed>0 时带「有新内容 N 条」 */}
      {!atBottom && (
        <button type="button" className="scroll-pill" onClick={() => {
          streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight, behavior: 'smooth' });
          setMissed(0);
        }}>
          {missed > 0 ? `回到底部 · 有新内容 ${missed} 条` : '回到底部'}
        </button>
      )}
      {showTop && (
        <button type="button" className="to-top" title="回到顶部" aria-label="回到顶部"
          onClick={() => streamRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}>
          <JumpIcon />
        </button>
      )}
    </div>
  );
}
