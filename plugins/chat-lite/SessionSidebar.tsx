/** 会话侧栏：克制的内容目录 + 行内删除确认 + 会话工作区设置入口。 */
import { useState } from 'react';
import { useSessionStore } from './store';
import { PlusIcon, TrashIcon, FolderIcon } from './icons';
import { WorkspacePicker } from './WorkspacePicker';

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
  const setSessionWorkspace = useSessionStore((s) => s.setSessionWorkspace);
  const setSessionLinkedWorkspaces = useSessionStore((s) => s.setSessionLinkedWorkspaces);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  /** 正在设置工作区的会话 id（弹层） */
  const [wsPickerFor, setWsPickerFor] = useState<string | null>(null);

  const pickedSession = sessions.find((s) => s.id === wsPickerFor);

  return (
    <div className="chat-sessions" data-testid="session-sidebar">
      <div className="chat-sessions-head">
        <span>对话目录</span>
        <span>{String(sessions.length).padStart(2, '0')}</span>
      </div>
      <button className="chat-session-new" onClick={() => createSession()}>
        <PlusIcon /><span>新会话</span>
      </button>

      {sessions.length === 0 && (
        <div className="chat-sessions-empty">
          <strong>尚无对话记录</strong>
          <span>从一个想法开始，<br />这里会留下你的思考轨迹。</span>
        </div>
      )}

      <div className="chat-session-list">
        {sessions.map((s) => (
          <div
            key={s.id}
            className={`chat-session-item ${s.id === activeId ? 'active' : ''}`}
            onClick={() => setActive(s.id)}
          >
            <span className="title">
              {displayTitle(s.title, s.messages[0]?.content)}
              {s.workspaceId && <span className="chat-session-ws" title={`工作区：${s.workspaceId}`}>⌂</span>}
            </span>
            {confirmId === s.id ? (
              <span className="chat-session-confirm" onClick={(e) => e.stopPropagation()}>
                <span>删除？</span>
                <button className="danger" onClick={() => { deleteSession(s.id); setConfirmId(null); }}>确认</button>
                <button onClick={() => setConfirmId(null)}>取消</button>
              </span>
            ) : (
              <span className="chat-session-actions">
                <span className="chat-session-count">{s.messages.length}</span>
                <button
                  className="chat-session-del"
                  title="设置工作区"
                  aria-label={`设置工作区 ${displayTitle(s.title, s.messages[0]?.content)}`}
                  onClick={(e) => { e.stopPropagation(); setWsPickerFor(s.id); }}
                >
                  <FolderIcon />
                </button>
                <button
                  className="chat-session-del"
                  title="删除会话"
                  aria-label={`删除会话 ${displayTitle(s.title, s.messages[0]?.content)}`}
                  onClick={(e) => { e.stopPropagation(); setConfirmId(s.id); }}
                >
                  <TrashIcon />
                </button>
              </span>
            )}
          </div>
        ))}
      </div>

      {pickedSession && (
        <WorkspacePicker
          session={pickedSession}
          onPick={(workspaceId) => { setSessionWorkspace(pickedSession.id, workspaceId); setWsPickerFor(null); }}
          onToggleLinked={(id) => {
            const cur = pickedSession.linkedWorkspaceIds ?? [];
            const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id].slice(0, 3);
            setSessionLinkedWorkspaces(pickedSession.id, next);
          }}
          onClose={() => setWsPickerFor(null)}
        />
      )}
    </div>
  );
}
