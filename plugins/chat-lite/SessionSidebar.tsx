/** 会话侧栏（Polaris 对话布局第一段） */
import { useState } from 'react';
import { useSessionStore } from './store';

/** 会话标题：优先用已命名标题；仍为默认「新会话」且有消息时，用首条消息兜底 */
function displayTitle(title: string, firstMessage: string | undefined): string {
  if (title !== '新会话') return title;
  return firstMessage ? firstMessage.slice(0, 18) : title;
}

export function SessionSidebar() {
  const sessions = useSessionStore((s) => s.sessions);
  const activeId = useSessionStore((s) => s.activeId);
  const setActive = useSessionStore((s) => s.setActive);
  const createSession = useSessionStore((s) => s.createSession);
  const deleteSession = useSessionStore((s) => s.deleteSession);
  /** 待确认删除的会话 id：用行内二次确认替代原生 confirm（阻断式弹窗体验差且不可测） */
  const [confirmId, setConfirmId] = useState<string | null>(null);

  return (
    <div className="chat-sessions" data-testid="session-sidebar">
      <button className="chat-session-new" onClick={() => createSession()}>
        + 新会话
      </button>

      {sessions.length === 0 && (
        <div className="chat-sessions-empty">
          <strong>还没有会话</strong>
          <span>发送第一条消息，或点上方「+ 新会话」开始</span>
        </div>
      )}

      {sessions.map((s) => (
        <div
          key={s.id}
          className={`chat-session-item ${s.id === activeId ? 'active' : ''}`}
          onClick={() => setActive(s.id)}
        >
          <span className="title">{displayTitle(s.title, s.messages[0]?.content)}</span>
          {confirmId === s.id ? (
            <span className="chat-session-confirm" onClick={(e) => e.stopPropagation()}>
              <span>删除？</span>
              <button
                className="danger"
                onClick={() => {
                  deleteSession(s.id);
                  setConfirmId(null);
                }}
              >
                确认
              </button>
              <button onClick={() => setConfirmId(null)}>取消</button>
            </span>
          ) : (
            <span className="chat-session-actions">
              <span className="chat-session-count">{s.messages.length}</span>
              <button
                className="chat-session-del"
                title="删除会话"
                aria-label={`删除会话 ${displayTitle(s.title, s.messages[0]?.content)}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setConfirmId(s.id);
                }}
              >
                ×
              </button>
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
