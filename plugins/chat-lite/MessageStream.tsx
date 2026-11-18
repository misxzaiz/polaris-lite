/** 消息流（Polaris 对话布局第二段）——支持上滑查看历史消息 */
import { useEffect, useRef, useState } from 'react';
import { useSessionStore } from './store';

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

  const lastMsg = session?.messages[session.messages.length - 1];
  const lastContent = lastMsg?.content ?? '';
  const msgCount = session?.messages.length ?? 0;

  // 自动跟随：仅在用户贴近底部时，滚动到最新内容；上滑查看历史时不打扰
  useEffect(() => {
    if (!atBottom) return;
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [msgCount, lastContent, atBottom]);

  if (!activeId || !session) {
    // 空态：logo + 标题 + 快捷建议 chips（点击即以该提示开聊）+ 渐变引导线衔接输入区
    const suggestions = ['总结一下这段代码的作用', '帮我写一个 SQL 查询', '解释这个报错信息', '把这段话翻译成英文'];
    const startWith = (text: string) => {
      void (async () => {
        const { sendUserMessage } = await import('./index');
        await sendUserMessage(text);
      })();
    };
    return (
      <div className="chat-stream" data-testid="message-stream">
        <div className="chat-empty">
          <div className="chat-empty-logo" aria-hidden="true">◈</div>
          <h2>Polaris Lite</h2>
          <p>轻量版对话已就绪，试试：</p>
          <div className="chat-empty-chips">
            {suggestions.map((s) => (
              <button key={s} className="chat-empty-chip" onClick={() => startWith(s)}>{s}</button>
            ))}
          </div>
          <div className="chat-empty-lead" aria-hidden="true" />
        </div>
      </div>
    );
  }

  return (
    <div className="chat-stream" data-testid="message-stream" ref={streamRef}>
      {session.messages.map((m) => (
        <div key={m.id} className={`chat-msg ${m.role}`}>
          <div className="chat-avatar">{m.role === 'user' ? '你' : 'AI'}</div>
          <div className="chat-bubble">
            {m.content}
            {m.streaming && <span className="cursor" />}
          </div>
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
