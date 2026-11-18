/** 消息流（Polaris 对话布局第二段）——支持上滑查看历史消息 */
import { useEffect, useRef, useState } from 'react';
import { useSessionStore } from './store';
import { EmptyState } from './EmptyState';
import { Markdown } from './markdown';

export function MessageStream() {
  const activeId = useSessionStore((s) => s.activeId);
  const session = useSessionStore((s) => s.sessions.find((x) => x.id === s.activeId));
  const bottomRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<HTMLDivElement>(null);
  /** 用户是否贴近底部（距底 < 80px 视为在底部）——贴近时新消息自动跟随；上滑查看历史时不打扰 */
  const [atBottom, setAtBottom] = useState(true);

  // 监听滚动：判断是否贴近底部
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

  // 自动跟随：仅在用户贴近底部时，滚动到最新内容；上滑查看历史时不打扰
  useEffect(() => {
    if (!atBottom) return;
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [msgCount, lastContent, atBottom]);

  // 空态一：还没有任何会话（首屏）
  if (!activeId || !session) {
    return (
      <div className="chat-stream" data-testid="message-stream">
        <EmptyState variant="no-session" />
      </div>
    );
  }

  // 空态二：会话已建但还没有消息（点「+ 新会话」后的一屏）——
  // 原实现这里直接渲染空容器，用户看到纯黑，不知道下一步该做什么
  if (session.messages.length === 0) {
    return (
      <div className="chat-stream" data-testid="message-stream">
        <EmptyState variant="no-message" />
      </div>
    );
  }

  return (
    <div className="chat-stream" data-testid="message-stream" ref={streamRef}>
      {session.messages.map((m) => (
        <div key={m.id} className={`chat-msg ${m.role}`}>
          <div className="chat-avatar">{m.role === 'user' ? '你' : 'AI'}</div>
          <div className={`chat-bubble ${m.role === 'assistant' ? 'markdown' : ''}`}>
            {m.role === 'assistant' ? <Markdown text={m.content} /> : m.content}
            {m.streaming && <span className="cursor" />}
          </div>
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
