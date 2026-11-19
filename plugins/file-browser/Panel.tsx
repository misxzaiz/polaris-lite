/**
 * 文件浏览器面板（原型）：盘符条 → 工作区根 → 目录网格 → 只读预览抽屉。
 * 人用交互：浏览（盘符仅导航起点）、登记工作区根、设为当前工作区（workspace-changed
 * 联动 agent-loop/agent-bash）、预览 + 「插入对话」。
 */
import { useCallback, useEffect, useState } from 'react';
import type { SlotHostApi } from '@sdk';
import type { FsRoot } from './index';
import { setActiveRoot, toggleLinkedRoot } from './index';

let api: SlotHostApi | null = null;
export function setPanelApi(a: SlotHostApi | null): void { api = a; }

interface Entry { name: string; isDir: boolean; size?: number; mtime: number }
interface Drive { id: string; path: string; label: string }
interface Crumb { name: string; rel: string }

async function fsGet<T>(path: string, init?: RequestInit): Promise<{ status: number; data: T | null; error?: string }> {
  const resp = await fetch(`/api/fs/${path}`, { credentials: 'include', ...init });
  let json: any = null;
  try { json = await resp.json(); } catch { /* */ }
  return { status: resp.status, data: json as T, error: json?.error };
}

function fmtSize(n?: number): string {
  if (n === undefined) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function FileBrowserPanel() {
  const [roots, setRoots] = useState<FsRoot[]>([]);
  const [drives, setDrives] = useState<Drive[]>([]);
  const [activeRootId, setActiveRootId] = useState<string | null>(null);
  const [linked, setLinked] = useState<Set<string>>(new Set());
  // 浏览状态：rootId + 相对路径；盘符浏览时 rootId=null（只读导航，path 为绝对盘内路径）
  const [rootId, setRootId] = useState<string | null>(null);
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  // 预览
  const [preview, setPreview] = useState<{ name: string; rel: string; isText: boolean; text?: string; data?: string; tooLarge?: boolean; hint?: string; size?: number } | null>(null);
  const [addPath, setAddPath] = useState('');
  const [addOpen, setAddOpen] = useState(false);

  const refreshRoots = useCallback(async () => {
    const r = await fsGet<{ roots: FsRoot[] }>('roots');
    if (r.data?.roots) setRoots(r.data.roots);
    const d = await fsGet<{ drives: Drive[] }>('drives');
    if (d.data?.drives) setDrives(d.data.drives);
  }, []);

  useEffect(() => { void refreshRoots(); }, [refreshRoots]);

  const openDir = useCallback(async (rid: string, rel: string) => {
    setLoading(true); setErr(''); setPreview(null);
    const q = new URLSearchParams({ rootId: rid, path: rel });
    const r = await fsGet<{ entries: Entry[] }>(`list?${q}`);
    setLoading(false);
    if (r.status !== 200) { setErr(r.error ?? '读取目录失败'); setEntries([]); return; }
    setEntries(r.data?.entries ?? []);
  }, []);

  const selectRoot = useCallback((rid: string, rel = '') => {
    setRootId(rid); setPath(rel);
    void openDir(rid, rel);
  }, [openDir]);

  // 点盘符：进入只读导航（用第一个可用 root 之外的临时视图：直接列盘符一级）
  const openDrive = useCallback(async (dpath: string) => {
    setLoading(true); setErr(''); setPreview(null);
    // 盘符一级经临时 root 方案不可行（未登记）；改为提示引导登记
    setLoading(false);
    setErr(`盘符 ${dpath} 仅作导航起点：请登记具体目录为工作区根后浏览（点下方「登记工作区」）`);
  }, []);

  const openFile = useCallback(async (rid: string, rel: string, name: string) => {
    const q = new URLSearchParams({ rootId: rid, path: rel });
    const r = await fsGet<{ isText: boolean; text?: string; data?: string; tooLarge?: boolean; hint?: string; size?: number }>(`read?${q}`);
    if (r.status !== 200) { setErr(r.error ?? '读取失败'); return; }
    setPreview({ name, rel, ...r.data! });
  }, []);

  const addRoot = useCallback(async () => {
    const p = addPath.trim();
    if (!p) return;
    const r = await fsGet<{ roots: FsRoot[] }>('roots', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p }),
    });
    if (r.status !== 200) { setErr(r.error ?? '登记失败'); return; }
    setAddPath(''); setAddOpen(false); setErr('');
    await refreshRoots();
  }, [addPath, refreshRoots]);

  const removeRoot = useCallback(async (id: string) => {
    const r = await fsGet('roots/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
    if (r.status !== 200) setErr(r.error ?? '移除失败');
    await refreshRoots();
  }, [refreshRoots]);

  const crumbs: Crumb[] = (() => {
    const parts = path.split('/').filter(Boolean);
    const list: Crumb[] = [{ name: '根', rel: '' }];
    let acc = '';
    for (const p of parts) { acc = `${acc}${p}/`; list.push({ name: p, rel: acc.slice(0, -1) }); }
    return list;
  })();

  const root = roots.find((r) => r.id === rootId);

  return (
    <div className="cap-panel file-browser" data-testid="file-browser">
      <h3>文件</h3>

      {/* 盘符条（仅导航起点） */}
      <div className="fb-drives">
        {drives.map((d) => (
          <button key={d.id} className="fb-drive" onClick={() => void openDrive(d.path)}>{d.label}</button>
        ))}
      </div>

      {/* 工作区根列表 */}
      <div className="fb-roots">
        {roots.map((r) => (
          <div key={r.id} className={`fb-root ${r.missing ? 'missing' : ''} ${r.id === activeRootId ? 'active' : ''}`}>
            <button className="fb-root-open" title={r.path} disabled={r.missing} onClick={() => selectRoot(r.id)}>
              <span className="fb-root-label">{r.label}</span>
              {r.builtin && <span className="fb-badge">内建</span>}
              {r.missing && <span className="fb-badge off">失效</span>}
            </button>
            <div className="fb-root-ops">
              <button
                className="fb-mini"
                title={r.id === activeRootId ? '当前工作区' : '设为当前工作区（AI 的 bash cwd）'}
                onClick={() => { setActiveRoot(r.id); setActiveRootId(r.id); }}
              >{r.id === activeRootId ? '✓' : '工作区'}</button>
              <button
                className={`fb-mini ${linked.has(r.id) ? 'on' : ''}`}
                title="关联为只读上下文（AI 可读不可写）"
                onClick={() => { toggleLinkedRoot(r.id); const n = new Set(linked); n.has(r.id) ? n.delete(r.id) : n.add(r.id); setLinked(n); }}
              >链</button>
              {!r.builtin && <button className="fb-mini danger" title="移除该根" onClick={() => void removeRoot(r.id)}>×</button>}
            </div>
          </div>
        ))}
      </div>
      <button className="fb-add-toggle" onClick={() => setAddOpen(!addOpen)}>{addOpen ? '收起' : '+ 登记工作区'}</button>
      {addOpen && (
        <div className="fb-addrow">
          <input value={addPath} onChange={(e) => setAddPath(e.target.value)} placeholder="D:\projects\my-app（不能是盘符根/系统目录）" />
          <button className="fb-btn" onClick={() => void addRoot()} disabled={!addPath.trim()}>登记</button>
        </div>
      )}

      {/* 目录浏览 */}
      {root && (
        <div className="fb-browser">
          <div className="fb-crumb">
            {crumbs.map((c, i) => (
              <button key={i} onClick={() => selectRoot(rootId!, c.rel)}>{c.name}</button>
            ))}
          </div>
          {loading && <div className="fb-hint">载入中…</div>}
          {err && <div className="fb-err">{err}</div>}
          <div className="fb-entries">
            {path && (
              <button className="fb-entry dir" onClick={() => {
                const parent = path.split('/').slice(0, -1).join('/');
                selectRoot(rootId!, parent);
              }}>..</button>
            )}
            {entries.map((e) => (
              <button
                key={e.name}
                className={`fb-entry ${e.isDir ? 'dir' : ''}`}
                onClick={() => {
                  const rel = path ? `${path}/${e.name}` : e.name;
                  if (e.isDir) selectRoot(rootId!, rel);
                  else void openFile(rootId!, rel, e.name);
                }}
              >
                <span className="fb-name" title={e.name}>{e.name}</span>
                {!e.isDir && <span className="fb-size">{fmtSize(e.size)}</span>}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 预览抽屉 */}
      {preview && (
        <div className="fb-preview" data-testid="fb-preview">
          <div className="fb-preview-head">
            <span className="fb-preview-name" title={preview.rel}>{preview.name}</span>
            <span className="fb-size">{fmtSize(preview.size)}</span>
            <button className="fb-mini" onClick={() => setPreview(null)}>×</button>
          </div>
          {preview.tooLarge
            ? <div className="fb-hint">{preview.hint}</div>
            : preview.isText
              ? <pre className="fb-text">{preview.text}</pre>
              : <img className="fb-img" alt={preview.name} src={`data:image/png;base64,${preview.data}`} />}
        </div>
      )}
    </div>
  );
}
