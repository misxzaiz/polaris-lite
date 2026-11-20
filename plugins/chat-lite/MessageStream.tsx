/** 消息流：编辑式助手排版 + 收敛的用户消息，保留贴底跟随。 */
import { useEffect, useRef, useState } from 'react';
import { useSessionStore, isToolCard, hasBlocks, type ToolCardMessage } from './store';
import { EmptyState } from './EmptyState';
import { Markdown } from './markdown';
import { PolarisMark, UserIcon } from './icons';
import { ToolCard } from './ToolCard';
import { renderBlocks } from './BlockGroup';

export function MessageStream() {
  const activeId = useSessionStore((s) => s.activeId);
  const session = useSessionStore((s) => s.sessions.find((x) => x.id === s.activeId));
  const bottomRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => {
    const el = streamRef.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      setAtBottom(distance < 80);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  const messages = session?.messages ?? [];
  const msgCount = messages.length;
  const lastContent = messages[msgCount - 1]?.content ?? '';

  // 自动跟随活跃度戳：blocks 模式下 content 变化不敏感（块承载文本/卡片），
  // 以「末条消息文本/块规模」参与依赖，保证流式期间持续贴底
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
    return <div className="chat-stream" data-testid="message-stream"><EmptyState variant="no-session" /></div>;
  }
  if (session.messages.length === 0) {
    return <div className="chat-stream" data-testid="message-stream"><EmptyState variant="no-message" /></div>;
  }

  return (
    <div className="chat-stream" data-testid="message-stream" ref={streamRef}>
      <div className="chat-conversation">
        {messages.map((m) =>
          isToolCard(m) ? (
            <ToolCard key={m.id} msg={m as ToolCardMessage} />
          ) : (
            <div key={m.id} className={`chat-msg ${m.role}`}>
              <div className="chat-avatar" aria-hidden="true">
                {m.role === 'user' ? <UserIcon /> : <PolarisMark size={19} />}
              </div>
              <div className={`chat-bubble ${m.role === 'assistant' ? 'markdown' : ''}`}>
                {m.role === 'assistant' && hasBlocks(m)
                  ? renderBlocks(m.blocks, !!m.streaming)
                  : m.role === 'assistant'
                    ? <Markdown text={m.content} />
                    : m.content}
                {m.streaming && !hasBlocks(m) && <span className="cursor" />}
              </div>
            </div>
          ),
        )}
        <div ref={bottomRef} />
      </div>
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
  );
}
