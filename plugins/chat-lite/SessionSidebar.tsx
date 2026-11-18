/** 会话侧栏（Polaris 对话布局第一段） */
import { useSessionStore } from '@/core/sessionStore';

export function SessionSidebar() {
  const sessions = useSessionStore((s) => s.sessions);
  const activeId = useSessionStore((s) => s.activeId);
  const setActive = useSessionStore((s) => s.setActive);
  const createSession = useSessionStore((s) => s.createSession);

  return (
    <div className="chat-sessions" data-testid="session-sidebar">
      <button className="chat-session-new" onClick={() => createSession()}>
        + 新会话
      </button>
      {sessions.map((s) => (
        <div
          key={s.id}
          className={`chat-session-item ${s.id === activeId ? 'active' : ''}`}
          onClick={() => setActive(s.id)}
        >
          <span className="title">{s.title === '新会话' && s.messages.length ? s.messages[0].content.slice(0, 18) : s.title}</span>
          <span style={{ fontSize: 11, opacity: 0.6 }}>{s.messages.length}</span>
        </div>
      ))}
    </div>
  );
}
