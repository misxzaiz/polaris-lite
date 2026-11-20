/** 会话侧栏：克制的内容目录 + 行内删除确认 + 会话工作区设置入口 + 多设备同步状态。 */
import { useState } from 'react';
import { useSessionStore, acceptServerVersion, forceOverrideServer } from './store';
import { PlusIcon, TrashIcon, FolderIcon } from './icons';
import { WorkspacePicker } from './WorkspacePicker';

/** 同步状态点：多设备共享的可感知性（offline/conflict 才醒目，idle/syncing 弱化） */
function SyncDot() {
  const status = useSessionStore((s) => s.syncStatus);
  const label = status === 'offline' ? '离线：改动将在恢复连接后同步'
    : status === 'conflict' ? '与服务端存在冲突，请处理'
    : status === 'syncing' ? '同步中…' : '已同步';
  return (
    <span className={`chat-sync-dot chat-sync-${status}`} title={label} aria-label={label}>
      <i />
    </span>
  );
}

/** 冲突提示条：409 后出现，二选一（以服务端为准 / 覆盖服务端） */
function ConflictBanner() {
  const conflicts = useSessionStore((s) => s.conflicts);
  const sessions = useSessionStore((s) => s.sessions);
  const ids = Object.keys(conflicts);
  if (ids.length === 0) return null;
  const titleOf = (id: string) => {
    const s = sessions.find((x) => x.id === id);
    if (!s) return id;
    return s.title !== '新会话' ? s.title : (s.messages[0]?.content?.slice(0, 18) ?? id);
  };
  return (
    <div className="chat-sync-conflict" role="alert">
      {ids.map((id) => (
        <div key={id} className="chat-sync-conflict-item">
          <span>「{titleOf(id)}」在另一台设备有更新。</span>
          <button onClick={() => void acceptServerVersion(id)}>以服务端为准</button>
          <button className="primary" onClick={() => void forceOverrideServer(id)}>覆盖服务端</button>
        </div>
      ))}
    </div>
  );
}

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
        <span className="chat-sessions-head-right">
          <SyncDot />
          {String(sessions.length).padStart(2, '0')}
        </span>
      </div>
      <ConflictBanner />
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
