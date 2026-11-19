/**
 * 会话「设置工作区」弹层（参考 Polaris PermissionRequest 的收敛交互）：
 * - 列出 file-browser 登记的所有工作区根（名称+路径），当前绑定高亮 ✓；
 * - 「跟随全局」= 清除会话绑定（undefined，回落默认 workspace/全局 activeRoot）；
 * - 「新建工作区」= 输入绝对路径，经服务端 /api/fs/roots/from-path 一步登记并绑定；
 * - 选择即生效：store.setSessionWorkspace 落盘 + 关闭弹层。
 */
import { useEffect, useState } from 'react';
import type { ChatSession } from '@sdk';
import { useSessionStore } from './store';
import { CloseIcon, FolderIcon } from './icons';

interface RootRow {
  id: string;
  label: string;
  path: string;
  builtin?: boolean;
  missing?: boolean;
}

export function WorkspacePicker({
  session,
  onPick,
  onClose,
}: {
  session: ChatSession & { workspaceId?: string };
  onPick: (workspaceId: string | undefined) => void;
  onClose: () => void;
}) {
  const [roots, setRoots] = useState<RootRow[]>([]);
  const [newPath, setNewPath] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const resp = await fetch('/api/fs/roots', { credentials: 'include' });
      if (!alive) return;
      const j = (await resp.json().catch(() => null)) as { roots?: RootRow[] } | null;
      if (alive && j?.roots) setRoots(j.roots);
    })();
    return () => { alive = false; };
  }, []);

  const pick = (workspaceId: string | undefined) => {
    onPick(workspaceId);
    onClose();
  };

  const addAndPick = async () => {
    const p = newPath.trim();
    if (!p) return;
    setBusy(true);
    const resp = await fetch('/api/fs/roots/from-path', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ path: p }),
    });
    setBusy(false);
    if (resp.status !== 200) {
      setErr((await resp.json().catch(() => null))?.error ?? '登记失败');
      return;
    }
    const j = (await resp.json().catch(() => null)) as { roots?: RootRow[] } | null;
    const match = (j?.roots ?? []).find((r) => r.path.toLowerCase() === p.toLowerCase() || p.toLowerCase().includes(r.label.toLowerCase()));
    setNewPath('');
    setErr('');
    if (match) pick(match.id);
    else if (j?.roots) setRoots(j.roots);
  };

  return (
    <div className="ws-picker-mask" onClick={onClose}>
      <div className="ws-picker" data-testid="workspace-picker" onClick={(e) => e.stopPropagation()}>
        <div className="ws-picker-head">
          <FolderIcon />
          <span>设置工作区 — {session.title}</span>
          <button className="ws-picker-close" aria-label="关闭" onClick={onClose}><CloseIcon /></button>
        </div>
        <p className="ws-picker-hint">绑定后，本对话的 AI 命令将在该目录内执行（bash cwd）。</p>
        <div className="ws-picker-list">
          <button
            className={`ws-row ${!session.workspaceId ? 'active' : ''}`}
            onClick={() => pick(undefined)}
          >
            <span className="ws-row-name">跟随全局默认</span>
            <span className="ws-row-path">内建 workspace / 全局 activeRoot</span>
            {!session.workspaceId && <span className="ws-check">✓</span>}
          </button>
          {roots.map((r) => (
            <button
              key={r.id}
              className={`ws-row ${session.workspaceId === r.id ? 'active' : ''} ${r.missing ? 'missing' : ''}`}
              onClick={() => pick(r.id)}
              disabled={r.missing}
            >
              <span className="ws-row-name">{r.label}</span>
              <span className="ws-row-path" title={r.path}>{r.path}</span>
              {session.workspaceId === r.id && <span className="ws-check">✓</span>}
            </button>
          ))}
          {roots.length === 0 && <div className="ws-picker-hint">暂无已登记的工作区根。</div>}
        </div>
        <div className="ws-picker-add">
          <input
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
            placeholder="新建：输入目录绝对路径，如 D:\projects\my-app"
            onKeyDown={(e) => { if (e.key === 'Enter') void addAndPick(); }}
          />
          <button className="ws-picker-add-btn" onClick={() => void addAndPick()} disabled={!newPath.trim() || busy}>
            {busy ? '登记中…' : '登记并绑定'}
          </button>
        </div>
        {err && <div className="ws-picker-err">{err}</div>}
      </div>
    </div>
  );
}
