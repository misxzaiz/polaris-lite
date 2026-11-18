/** 消息流：编辑式助手排版 + 收敛的用户消息，保留贴底跟随。 */
import { useEffect, useRef, useState } from 'react';
import { useSessionStore } from './store';
import { EmptyState } from './EmptyState';
import { Markdown } from './markdown';
import { PolarisMark, UserIcon } from './icons';

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

  const msgCount = session?.messages.length ?? 0;
  const lastContent = session?.messages[msgCount - 1]?.content ?? '';

  useEffect(() => {
    if (!atBottom) return;
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [msgCount, lastContent, atBottom]);

  if (!activeId || !session) {
    return <div className="chat-stream" data-testid="message-stream"><EmptyState variant="no-session" /></div>;
  }
  if (session.messages.length === 0) {
    return <div className="chat-stream" data-testid="message-stream"><EmptyState variant="no-message" /></div>;
  }

  return (
    <div className="chat-stream" data-testid="message-stream" ref={streamRef}>
      <div className="chat-conversation">
        {session.messages.map((m) => (
          <div key={m.id} className={`chat-msg ${m.role}`}>
            <div className="chat-avatar" aria-hidden="true">
              {m.role === 'user' ? <UserIcon /> : <PolarisMark size={19} />}
            </div>
            <div className={`chat-bubble ${m.role === 'assistant' ? 'markdown' : ''}`}>
              {m.role === 'assistant' ? <Markdown text={m.content} /> : m.content}
              {m.streaming && <span className="cursor" />}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
