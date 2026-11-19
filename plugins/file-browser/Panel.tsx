/**
 * 文件浏览器面板 v2：树形浏览（懒加载）+ 节点动作 + 预览。
 *
 * 结构（docs/fs-tree-analysis.md §3.3）：
 * - 树数据 = /api/fs/tree 单层懒加载；顶层骨架（L1 根 + 盘符）由服务端返回；
 * - 文件夹节点悬浮三动作：设为工作区（自动登记根）/ 关联只读 / 发到对话；
 * - 文件节点：预览 + 发到对话；
 * - activeRoot 徽标与底部胶囊提示（审批可见性同款交互语言）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SlotHostApi } from '@sdk';
import type { FsRoot } from './index';
import { setActiveRoot, toggleLinkedRoot, workspaceState } from './index';

let api: SlotHostApi | null = null;
export function setPanelApi(a: SlotHostApi | null): void { api = a; }

interface FsNode {
  name: string;
  isDir: boolean;
  path: string;          // 绝对路径（服务端统一给出）
  isRoot?: boolean;
  isDrive?: boolean;
  rootId?: string;
  builtin?: boolean;
  missing?: boolean;
  hasChildren?: boolean;
  size?: number;
}
interface Crumb { name: string; path: string }

async function fsGet<T>(path: string): Promise<{ status: number; data: T | null; error?: string }> {
  const resp = await fetch(`/api/fs/${path}`, { credentials: 'include' });
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
  const [activeRootId, setActiveRootId] = useState<string | null>(() => workspaceState().activeRootId);
  const [linked, setLinked] = useState<Set<string>>(() => new Set(workspaceState().linkedRootIds));
  const [sessionRoam, setSessionRoam] = useState(true);
  // 当前浏览点（树视图中心）：绝对路径 + 面包屑链
  const [cwd, setCwd] = useState<{ path: string; label: string }>({ path: '', label: '' });
  const [nodes, setNodes] = useState<FsNode[]>([]);
  const [filter, setFilter] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  // 预览
  const [preview, setPreview] = useState<{ name: string; path: string; isText: boolean; text?: string; data?: string; mime?: string; tooLarge?: boolean; hint?: string; size?: number } | null>(null);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  /** 当前展示的列表是否来自缓存（后台刷新中）——置灰提示而非清空列表 */
  const [stale, setStale] = useState(false);
  /**
   * 目录缓存（防跳变核心）：path → nodes。
   * 进入目录先展示缓存（若有），后台刷新后无缝替换——列表不再「清空→载入→重建」三段闪。
   * 缓存上限 60 层，超出淘汰最旧（浅拷贝 Map 重排保插入序）。
   */
  const dirCache = useRef(new Map<string, FsNode[]>());
  const cachePut = (path: string, nodes: FsNode[]) => {
    const m = dirCache.current;
    m.set(path, nodes);
    if (m.size > 60) {
      const oldest = m.keys().next().value;
      if (oldest !== undefined) m.delete(oldest);
    }
  };

  const loadDir = useCallback(async (dir: string, label: string) => {
    // 乐观渲染：有缓存先上屏（stale 置灰），无缓存才出「载入中」——列表不再清空闪烁
    const cached = dirCache.current.get(dir);
    setStale(!!cached);
    setLoading(!cached);
    setErr('');
    const q = new URLSearchParams(dir ? { dir } : {});
    const r = await fsGet<{ nodes: FsNode[]; sessionRoam?: boolean }>(`tree?${q}`);
    setLoading(false);
    setStale(false);
    if (r.status !== 200) {
      // 失败且无缓存才报错；有缓存保留旧视图（不打断浏览）
      if (!cached) setErr(r.error ?? '浏览失败');
      return;
    }
    const fresh = r.data?.nodes ?? [];
    cachePut(dir, fresh);
    setNodes(fresh);
    setCwd((prev) => (prev.path === dir && prev.label === label ? prev : { path: dir, label }));
    if (r.data?.sessionRoam !== undefined) setSessionRoam(r.data.sessionRoam);
  }, []);

  const refresh = useCallback(async () => {
    const rr = await fsGet<{ roots: FsRoot[]; sessionRoam?: boolean }>('roots');
    if (rr.data?.roots) setRoots(rr.data.roots);
    if (rr.data?.sessionRoam !== undefined) setSessionRoam(rr.data.sessionRoam);
    // 当前浏览点若仍有子内容则重拉（外部改动/新增根后刷新）
    if (cwd.path) await loadDir(cwd.path, cwd.label);
  }, [cwd.path, loadDir]);

  useEffect(() => {
    void refresh();
    // 顶层骨架（L1 根 + 盘符）也是一次 tree 拉取（dir 为空）
    if (!cwd.path) void loadDir('', '顶层');
  }, [refresh, cwd.path, loadDir]);

  const registerRoot = useCallback(async (dir: string) => {
    setBusyPath(dir);
    const r = await fetch('/api/fs/roots/from-path', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ path: dir }),
    });
    setBusyPath(null);
    // 409 = 已是根（树上重复选择同一目录时发生）：视为成功
    if (r.status !== 200 && r.status !== 409) { setErr((await r.json().catch(() => null))?.error ?? '登记失败'); return false; }
    await refresh();
    return true;
  }, [refresh]);

  /** 树上选文件夹为当前工作区：非根先自动登记（一步闭环），再标记 active */
  const makeWorkspace = useCallback(async (node: FsNode) => {
    setBusyPath(node.path);
    if (!node.isRoot) {
      const ok = await registerRoot(node.path);
      if (!ok) { setBusyPath(null); return; }
    }
    // 找到（或刚登记）的根 id
    const rr = await fsGet<{ roots: FsRoot[] }>('roots');
    const match = (rr.data?.roots ?? []).find((r) => r.path === node.path) ?? (rr.data?.roots ?? []).find((r) => r.builtin && node.path.includes('workspace'));
    if (match) { setActiveRoot(match.id); setActiveRootId(match.id); }
    setBusyPath(null);
  }, [registerRoot, refresh]);

  const toggleLink = useCallback(async (node: FsNode) => {
    setBusyPath(node.path);
    if (!node.isRoot) {
      const ok = await registerRoot(node.path);
      if (!ok) { setBusyPath(null); return; }
    }
    const rr = await fsGet<{ roots: FsRoot[] }>('roots');
    const match = (rr.data?.roots ?? []).find((r) => r.path === node.path);
    if (match) { toggleLinkedRoot(match.id); setLinked(new Set([...linked, match.id])); }
    setBusyPath(null);
    await refresh();
  }, [linked, registerRoot, refresh]);

  /** 文件/目录 → 注入对话输入框（chat-lite onCompose 通道） */
  const sendToChat = useCallback((node: FsNode) => {
    const mod = (window as unknown as Record<string, unknown>).__FILE_BROWSER_COMPOSE__ as ((text: string) => void) | undefined;
    const text = node.isDir
      ? `帮我分析这个目录的结构：${node.path}`
      : `帮我看看这个文件的内容：${node.path}`;
    if (typeof mod === 'function') mod(text);
    else {
      // 兜底：无注入通道时（理论上不会发生）退化为直接派发事件
      window.dispatchEvent(new CustomEvent('file-browser:compose', { detail: text }));
    }
  }, []);

  const openFile = useCallback(async (node: FsNode) => {
    setPreview({ name: node.name, path: node.path, isText: true, size: node.size, hint: '载入中…' });
    const q = new URLSearchParams({ path: node.path });
    const r = await fsGet<{ isText: boolean; text?: string; data?: string; mime?: string; tooLarge?: boolean; hint?: string; size?: number }>(`read?${q}`);
    if (r.status !== 200) { setPreview({ name: node.name, path: node.path, isText: true, hint: r.error ?? '读取失败' }); return; }
    setPreview({ name: node.name, path: node.path, ...r.data! });
  }, []);

  const crumbs: Crumb[] = (() => {
    const parts = cwd.path.split(/[\\/]/).filter(Boolean);
    const list: Crumb[] = [{ name: cwd.label || '顶层', path: '' }];
    let acc = parts[0] ? `${parts[0]}/` : '';
    for (let i = 1; i < parts.length; i++) {
      acc = `${acc}${parts[i]}/`;
      list.push({ name: parts[i], path: acc.slice(0, -1) });
    }
    return list;
  })();

  const filtered = filter.trim()
    ? nodes.filter((n) => n.name.toLowerCase().includes(filter.trim().toLowerCase()))
    : nodes;
  const activeRoot = roots.find((r) => r.id === activeRootId);

  return (
    <div className="cap-panel file-browser" data-testid="file-browser">
      <h3>文件</h3>

      {/* 面包屑（当前浏览点） */}
      <div className="fb-crumb">
        {crumbs.map((c, i) => (
          <button key={i} onClick={() => void loadDir(c.path, i === 0 ? (activeRoot?.label ?? '顶层') : c.name)}>{c.name}</button>
        ))}
        {sessionRoam && <span className="fb-roam-tag">会话漫游</span>}
      </div>

      {/* 过滤框 */}
      <input className="fb-filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="过滤当前层（名称包含）…" />

      {err && <div className="fb-err">{err}</div>}
      {/* 载入中：绝对定位的顶部细条 + 轻遮罩，不卸载列表、不产生高度跳动 */}
      {loading && (
        <div className="fb-loading" aria-hidden="true">
          <div className="fb-loading-bar" />
        </div>
      )}

      {/* 树单层节点 */}
      <div className="fb-entries">
        {crumbs.length > 1 && (
          <button className="fb-entry dir" onClick={() => void loadDir(crumbs[crumbs.length - 2].path, crumbs[crumbs.length - 2].name)}>..（上一级）</button>
        )}
        {filtered.map((n) => (
          <div
            key={n.path}
            className={`fb-node ${n.isDir ? 'dir' : ''} ${n.path === activeRoot?.path ? 'is-workspace' : ''}`}
            data-path={n.path}
          >
            <button className="fb-node-main" onClick={() => (n.isDir ? void loadDir(n.path, n.name) : void openFile(n))} disabled={n.missing}>
              <span className="fb-node-caret">{n.isDir ? (n.hasChildren === false ? '' : '▸') : ''}</span>
              <span className="fb-node-name" title={n.path}>{n.name}</span>
              {!n.isDir && <span className="fb-size">{fmtSize(n.size)}</span>}
            </button>
            <div className="fb-node-ops">
              {n.isDir && (
                <>
                  <button className="fb-mini" title="设为当前工作区（AI 的 bash cwd；自动登记为根）" disabled={busyPath === n.path} onClick={() => void makeWorkspace(n)}>
                    {n.path === activeRoot?.path ? '✓工作区' : '工作区'}
                  </button>
                  <button className={`fb-mini ${linked.has(roots.find((r) => r.path === n.path)?.id ?? '') ? 'on' : ''}`} title="关联为只读上下文" disabled={busyPath === n.path} onClick={() => void toggleLink(n)}>链</button>
                </>
              )}
              <button className="fb-mini" title="发到对话" onClick={() => sendToChat(n)}>发送</button>
            </div>
          </div>
        ))}
      </div>

      {/* 预览抽屉 */}
      {preview && (
        <div className="fb-preview" data-testid="fb-preview">
          <div className="fb-preview-head">
            <span className="fb-preview-name" title={preview.path}>{preview.name}</span>
            <span className="fb-size">{fmtSize(preview.size)}</span>
            <button className="fb-mini" onClick={() => setPreview(null)}>×</button>
          </div>
          {preview.tooLarge
            ? <div className="fb-hint">{preview.hint}</div>
            : preview.isText
              ? <pre className="fb-text">{preview.text}</pre>
              : <img className="fb-img" alt={preview.name} src={`data:${preview.mime ?? 'image/png'};base64,${preview.data}`} />}
        </div>
      )}
    </div>
  );
}
