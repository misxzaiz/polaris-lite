/** 消息流：编辑式助手排版 + 收敛的用户消息 + 消息操作条，保留贴底跟随。
 *  P0/P1 消息操作：复制 / 编辑重答（仅最后一轮）/ 回填 / 重发 / 跳到本条开头 / 重新生成；
 *  滚动导航（回到底部胶囊 + 回顶部）锚定在 stream-area 内，不压输入框。 */
import { Component, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSessionStore, isToolCard, hasBlocks, type StoreMessage, type ToolCardMessage } from './store';
import { EmptyState } from './EmptyState';
import { Markdown } from './markdown';
import { ToolCard } from './ToolCard';
import { PolarisMark, UserIcon, CopyIcon, CheckIcon, EditIcon, ResendIcon, RegenIcon, JumpIcon, BackfillIcon, CloseIcon } from './icons';
import { onStreamRetry, resumeTruncated, requestCompose, resendMessage, editResendLast, regenerateLast, assistantVisibleText } from './index';
import { renderBlocks } from './BlockGroup';
import { fmtMsgTime, fmtDur } from './time-fmt';
import { copyText } from '../shared/copyText';

/** 编辑态：一次只编辑一条；draft 进状态（确认条重建 DOM 不丢稿） */
interface EditState { msgId: string; draft: string; confirm: boolean }

/** 动作定义：icon 行（短标签）与动作单（全文案）共用同一份 spec，防两处行为漂移 */
interface MsgActionSpec { key: string; short: string; label: string; icon: React.ReactNode; done?: boolean; danger?: boolean; run: () => void }

/**
 * 单条消息渲染隔离罩：一条毒消息渲染抛错时只降级为错误气泡，其余消息照常显示——
 * 绝不再让单条消息崩掉整页（2026-11-22 白屏事故的横向兜底）。
 * key 绑定 msg.id，实例随消息重建；错误后该消息保持降级态直到刷新（流式中途瞬错不自动恢复，宁可少渲染不可静默错渲染）。
 */
class MessageBoundary extends Component<
  { msgId: string; children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) {
    console.error('[chat-lite] 消息渲染失败，已降级:', this.props.msgId, error);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="chat-msg assistant" data-testid="msg-render-error">
          <div className="chat-avatar" aria-hidden="true"><PolarisMark size={19} /></div>
          <div className="chat-bubble-col">
            <div className="chat-bubble markdown">
              这条消息渲染出错，已跳过（{this.state.error.message}）。其余消息不受影响。
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function MoreIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="5" r="1.6" fill="currentColor" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" />
      <circle cx="12" cy="19" r="1.6" fill="currentColor" />
    </svg>
  );
}

/** 浮层根：宿主 SlotLayout 提供的 fixed 覆盖层（空态 pointer-events:none 放行，
 *  子元素恢复 auto）——插件 CSS 门禁禁 fixed，弹层一律 absolute 挂这里锚定视口。 */
function overlayRoot(): HTMLElement | null {
  return document.getElementById('plite-overlay-root');
}

/** 单条消息行：气泡（或编辑态）+ 悬浮操作条。
 *  动作范围：用户消息 = 复制 / [编辑|回填] / 重发；AI 消息 = 复制 / [开头] / [重新生成]。
 *  编辑仅最后一轮且非流式；重新生成仅末条 AI 且非流式；流式中重发转排队。
 *  手机端（≤768px）图标标签隐藏、命中区外扩 ≥44px，另加 ⋮ 打开全文案动作单
 *  （不用气泡长按：会和 iOS 原生文本选择冲突，消息正文选择/复制是高频操作）。 */
/* __MSMETA_INJECTED__ */
/** 流式中的实时计时器：Date.now() - createdAt 每 200ms 刷新。
 *  随 streaming 消失而卸载（MsgMeta 门控），不落盘不进 store。 */
function LiveTimer({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, []);
  return <span className='live-timer'><i className='live-dot' />{fmtDur(now - since)}</span>;
}

/** 消息 meta 行：时间点（createdAt）+ 轮耗时（assistant：endedAt - createdAt）。
 *  - 桌面 hover 显示（与 msg-actions 同一触发器）；手机端常显弱化（chat.css 断点）；
 *  - 流式中 live-timer 常显（活跃信号）；旧快照无 endedAt → 只显示时间点，不显示占位。 */
function MsgMeta({ m }: { m: StoreMessage }) {
  if (isToolCard(m)) return null;
  const isAsst = m.role === 'assistant';
  const dur = isAsst && !m.streaming && typeof m.endedAt === 'number' ? m.endedAt - m.createdAt : null;
  return (
    <div className='msg-meta' data-testid='msg-meta'>
      <span className='ts'>{fmtMsgTime(m.createdAt)}</span>
      {isAsst && m.streaming && <LiveTimer since={m.createdAt} />}
      {dur !== null && (
        <>
          <span className='sep'>·</span>
          <span className={`dur${dur > 60_000 ? ' long' : ''}`}>{fmtDur(dur)}</span>
        </>
      )}
    </div>
  );
}

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
  const [sheetOpen, setSheetOpen] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  // 重新生成二次确认：首次点击只进入待确认态（红色警示），再次点击才执行截断重答；
  // 点击行外或 4s 超时自动还原，防误触。重新生成会截断并替换本轮回复，属破坏性操作。
  const [regenArmed, setRegenArmed] = useState(false);
  const regenTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disarmRegen = () => {
    if (regenTimer.current) { clearTimeout(regenTimer.current); regenTimer.current = null; }
    setRegenArmed(false);
  };
  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
    if (regenTimer.current) clearTimeout(regenTimer.current);
  }, []);
  useEffect(() => {
    if (!regenArmed) return;
    const onDoc = (e: MouseEvent) => {
      if (!rowRef.current?.contains(e.target as Node)) disarmRegen();
    };
    document.addEventListener('click', onDoc, true);
    return () => document.removeEventListener('click', onDoc, true);
  }, [regenArmed]);

  const isUser = !isToolCard(m) && m.role === 'user';
  const isEditing = editing?.msgId === m.id;

  const doCopy = async () => {
    const text = isUser ? m.content : assistantVisibleText(m);
    if (!text.trim()) return;
    // 复制结果决定反馈口径：失败必须如实反馈（不标「已复制」），APK WebView/明文 http 源走 execCommand 兜底
    setCopied(await copyText(text));
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1200);
  };

  const specs: MsgActionSpec[] = [];
  specs.push({
    key: 'copy',
    short: '复制',
    label: isUser ? '复制原文' : '复制正文（不含思考/工具卡/提示）',
    icon: copied ? <CheckIcon /> : <CopyIcon />,
    done: copied,
    run: () => { void doCopy(); },
  });
  if (isUser) {
    if (isLastUser && !sessionStreaming && !isEditing) {
      specs.push({
        key: 'edit',
        short: '编辑',
        label: '编辑并重答（截断此轮回复，并从所有设备上移除）',
        icon: <EditIcon />,
        run: () => setEditing({ msgId: m.id, draft: m.content, confirm: false }),
      });
    }
    if (!isLastUser) {
      specs.push({
        key: 'backfill',
        short: '回填',
        label: '回填输入框（不发送，取回再编辑）',
        icon: <BackfillIcon />,
        run: () => requestCompose(m.content),
      });
    }
    specs.push({
      key: 'resend',
      short: '重发',
      label: sessionStreaming ? '重发（当前回复结束后自动发出）' : '重发（追加新一轮，保留历史）',
      icon: <ResendIcon />,
      run: () => resendMessage(sid, m.id),
    });
  } else {
    if (isLong) {
      specs.push({
        key: 'jump',
        short: '开头',
        label: '跳到本条消息的开头',
        icon: <JumpIcon />,
        run: () => rowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      });
    }
    if (isLast && !sessionStreaming) {
      specs.push({
        key: 'regen',
        short: regenArmed ? '确认重答？' : '重新生成',
        label: regenArmed
          ? '再点一次确认：将截断并替换本轮回复，且从所有设备上移除'
          : '重新生成（同提示词重答，替换本轮回复）——再次点击以确认',
        icon: <RegenIcon />,
        danger: regenArmed,
        run: () => {
          if (!regenArmed) {
            // 第一步：只进入待确认态，不执行
            setRegenArmed(true);
            if (regenTimer.current) clearTimeout(regenTimer.current);
            regenTimer.current = setTimeout(disarmRegen, 4000);
            return;
          }
          disarmRegen();
          void regenerateLast(sid);
        },
      });
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
              ? renderBlocks(m.blocks, !!m.streaming, () => resumeTruncated(sid, m.id), sid)
              : !isUser
                ? <Markdown text={m.content} />
                : m.content}
            {m.streaming && !hasBlocks(m) && <span className="cursor" />}
          </div>
        )}
        {!isEditing && <MsgMeta m={m} />}
        {!isEditing && (
          <div className="msg-actions">
            {specs.map((sp) => (
              <button key={sp.key} type="button" className={`msg-act${sp.done ? ' done' : ''}${sp.danger ? ' danger' : ''}`}
                title={sp.label}
                onClick={sp.run}>
                {sp.icon}<span className="lbl">{sp.short}</span>
              </button>
            ))}
            {/* 全文案动作单入口：桌面 hover 行已有完整 title，仅窄屏显示（CSS 门控） */}
            <button type="button" className="msg-act msg-more" title="更多操作" aria-label="更多操作"
              onClick={() => setSheetOpen(true)}>
              <MoreIcon />
            </button>
          </div>
        )}
      </div>
      {sheetOpen && (() => {
        const root = overlayRoot();
        return root ? createPortal(
          <div className="chat-sheet-mask" onClick={() => setSheetOpen(false)}>
            <div className="chat-sheet" role="menu" aria-label="消息操作" onClick={(e) => e.stopPropagation()}>
              <button type="button" className="chat-sheet-topbar" aria-label="返回" onClick={() => setSheetOpen(false)}>
                <span className="chat-sheet-topbar-back">‹</span>
                <span className="chat-sheet-topbar-title">消息操作</span>
                <CloseIcon />
              </button>
              {specs.map((sp) => (
                <button key={sp.key} type="button" className={`chat-sheet-item${sp.done ? ' done' : ''}${sp.danger ? ' danger' : ''}`}
                  role="menuitem" onClick={() => { setSheetOpen(false); sp.run(); }}>
                  {sp.icon}<span>{sp.label}</span>
                </button>
              ))}
              <button type="button" className="chat-sheet-cancel" onClick={() => setSheetOpen(false)}>取消</button>
            </div>
          </div>,
          root,
        ) : null;
      })()}
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

  // 跟滚分两路：新消息到达走一次 smooth（低频、动画合理）；内容增长（delta 帧）
  // 在 rAF 内直接贴底定位——流式期间反复触发 smooth 动画会互相打断，滚动位置在
  // 追赶点附近震荡，正是流式输出「抖」的主因。直接设 scrollTop 也绕开了
  // CSS scroll-behavior:smooth 与 scroll-padding-bottom 的叠加偏移。
  const prevCountForScrollRef = useRef(0);
  useEffect(() => {
    if (!atBottom) return;
    const isNewMessage = msgCount !== prevCountForScrollRef.current;
    prevCountForScrollRef.current = msgCount;
    if (isNewMessage) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
      return;
    }
    const el = streamRef.current;
    const anchor = el?.querySelector('.chat-conversation > :last-child') as HTMLElement | null;
    if (!el || !anchor) return;
    const target = anchor.offsetTop + anchor.offsetHeight;
    requestAnimationFrame(() => { el.scrollTop = target; });
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
              <MessageBoundary key={m.id} msgId={m.id}>
                <MessageRow
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
              </MessageBoundary>
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
