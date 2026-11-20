/**
 * PluginManagerPanel —— 插件管理面板（panel 槽，两页签：插件 / 布局）。
 *
 * 插件页签：全部插件清单（registry.json ∩ 运行时权限表），启停开关（服务端落盘，
 * 下次加载生效——刷新/重启；行内明确提示，不伪装即时生效）。
 * 布局页签：当前工作区树只读可视化 + 三个低风险动作（打开视图 / 关闭视图 / 恢复默认布局）。
 * 拖拽/拆分等细粒度重排走宿主既有手势（TabsView/Splitter），面板不重复造轮子。
 */
import { useCallback, useEffect, useState } from 'react';
import type { SlotHostApi } from '@sdk';

let api: SlotHostApi | null = null;
export function setPanelApi(a: SlotHostApi | null): void { api = a; }

// ── 数据形状 ────────────────────────────────────────────────────────────────

interface RegistryEntry {
  id: string;
  module: string;
  enabled: boolean;
  style?: string;
}

interface PolicyRow {
  pluginId: string;
  listed: boolean;
  capabilities: string[];
  provides: string[];
  events: string[];
  denied: { field: string; item: string }[];
}

interface PluginRow {
  id: string;
  enabled: boolean;
  listed: boolean;
  version?: string;
  name?: string;
  capabilities: string[];
  provides: string[];
  deniedCount: number;
}

interface ViewInfo {
  viewType: string;
  title: string;
  pluginId: string;
}

interface TreeNode {
  kind: 'anchor' | 'split' | 'tabs' | 'view';
  id: string;
  anchor?: string;
  viewType?: string;
  dir?: string;
  children?: TreeNode[];
}

/** 服务端 /api/plugin-admin/* 调用（同源，会话 cookie 自动携带） */
async function adminApi<T>(path: string, body?: unknown): Promise<T> {
  const resp = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await resp.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!resp.ok || !data) throw new Error(data?.error ?? `HTTP ${resp.status}`);
  return data;
}

// ── 插件页签 ────────────────────────────────────────────────────────────────

function PluginList({ rows, onChanged }: { rows: PluginRow[]; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggle = async (row: PluginRow) => {
    setBusy(row.id);
    setError(null);
    try {
      await adminApi('/api/plugin-admin/set-enabled', { id: row.id, enabled: !row.enabled });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  if (rows.length === 0) return <div className="pm-empty">尚未加载到插件清单</div>;

  return (
    <div className="pm-list" role="list">
      {rows.map((row) => (
        <div className="pm-row" role="listitem" key={row.id} data-enabled={row.enabled ? 'true' : 'false'}>
          <div className="pm-row-main">
            <span className="pm-row-name" title={row.id}>{row.name ?? row.id}</span>
            <span className="pm-row-id">{row.id}{row.version ? ` · v${row.version}` : ''}</span>
            {!row.listed && <span className="pm-badge pm-badge-warn" title="未在 grants.json 登记，按 manifest 自声明放行">未登记</span>}
            {row.deniedCount > 0 && (
              <span className="pm-badge pm-badge-warn" title="有权限项被 grants 收紧">收紧 {row.deniedCount}</span>
            )}
          </div>
          <div className="pm-row-meta">
            {row.provides.length > 0 && <span className="pm-cap" title="提供的能力">供 {row.provides.length}</span>}
            {row.capabilities.length > 0 && <span className="pm-cap" title="调用的能力">调 {row.capabilities.length}</span>}
            <button
              type="button"
              className={`pm-switch ${row.enabled ? 'on' : ''}`}
              role="switch"
              aria-checked={row.enabled}
              aria-label={`${row.enabled ? '禁用' : '启用'} ${row.name ?? row.id}`}
              disabled={busy === row.id}
              onClick={() => toggle(row)}
            >
              <span className="pm-switch-knob" />
            </button>
          </div>
        </div>
      ))}
      {error && <div className="pm-error" role="alert">{error}</div>}
      <p className="pm-hint">开关写入 registry.json，<strong>刷新页面 / 重启应用后生效</strong>（插件在启动时装配）。</p>
    </div>
  );
}

// ── 布局页签 ────────────────────────────────────────────────────────────────

function TreeNodeView({ node, depth, views }: { node: TreeNode; depth: number; views: Map<string, ViewInfo> }) {
  const label =
    node.kind === 'view'
      ? (views.get(node.viewType ?? '')?.title ?? node.viewType ?? node.id)
      : node.kind === 'anchor'
        ? `锚点 ${node.anchor ?? node.id}`
        : node.kind === 'tabs'
          ? '标签组'
          : `分栏 ${node.dir ?? ''}`;
  const meta = node.kind === 'view' ? node.viewType : node.id;
  return (
    <div className="pm-tree-node" style={{ paddingLeft: depth === 0 ? 0 : 14 }}>
      <div className={`pm-tree-row pm-tree-${node.kind}`}>
        <span className="pm-tree-kind">{node.kind}</span>
        <span className="pm-tree-label">{label}</span>
        {meta && <span className="pm-tree-meta">{meta}</span>}
      </div>
      {node.children?.map((c) => (
        <TreeNodeView key={c.id} node={c} depth={depth + 1} views={views} />
      ))}
    </div>
  );
}

function LayoutTab() {
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [views, setViews] = useState<ViewInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState('');
  const [anchor, setAnchor] = useState<'panel' | 'stream' | 'sidebar' | 'input'>('panel');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!api) return;
    const meta = await api.dispatch<{ views?: ViewInfo[] }>({ target: 'cap.meta', action: 'describe' });
    setViews(meta.data?.views ?? []);
    const ws = api.workspace;
    if (!ws) {
      setError('当前未授予 cap.ui.layout，布局页签不可用');
      return;
    }
    const res = await ws.getTree();
    if (res.ok) setTree(res.data as TreeNode);
    else setError(res.error?.message ?? '读取布局失败');
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const openView = async () => {
    if (!api?.workspace || !pick) return;
    setBusy(true);
    setError(null);
    const res = await api.workspace.open(pick, { where: 'tab', anchor });
    setBusy(false);
    if (!res.ok) setError(res.error?.message ?? '打开失败');
    else await refresh();
  };

  const closeNode = async (nodeId: string) => {
    if (!api?.workspace) return;
    setBusy(true);
    setError(null);
    const res = await api.workspace.close(nodeId);
    setBusy(false);
    if (!res.ok) setError(res.error?.message ?? '关闭失败');
    else await refresh();
  };

  const resetLayout = async () => {
    if (!api?.workspace) return;
    setBusy(true);
    setError(null);
    const res = await api.workspace.reset();
    setBusy(false);
    if (!res.ok) setError(res.error?.message ?? '重置失败');
    else await refresh();
  };

  const openableViews = views.filter((v) => !v.viewType.startsWith('host.'));

  return (
    <div className="pm-layout">
      <div className="pm-layout-actions">
        <select
          className="pm-select"
          value={pick}
          onChange={(e) => setPick(e.target.value)}
          aria-label="选择要打开的视图"
        >
          <option value="">选择视图…</option>
          {openableViews.map((v) => (
            <option key={v.viewType} value={v.viewType}>{v.title}（{v.viewType}）</option>
          ))}
        </select>
        <select
          className="pm-select pm-select-anchor"
          value={anchor}
          onChange={(e) => setAnchor(e.target.value as typeof anchor)}
          aria-label="落位锚点"
        >
          <option value="panel">面板</option>
          <option value="stream">主区</option>
          <option value="sidebar">侧栏</option>
          <option value="input">输入区</option>
        </select>
        <button type="button" className="pm-btn" disabled={!pick || busy} onClick={openView}>打开</button>
        <button type="button" className="pm-btn pm-btn-danger" disabled={busy} onClick={resetLayout}>恢复默认布局</button>
      </div>
      {error && <div className="pm-error" role="alert">{error}</div>}
      <div className="pm-tree">
        {tree ? <TreeNodeView node={tree} depth={0} views={new Map(views.map((v) => [v.viewType, v]))} /> : <div className="pm-empty">布局读取中…</div>}
      </div>
      {tree && <CloseButtons tree={tree} onClose={closeNode} />}
      <p className="pm-hint">细粒度重排（拖拽 tab / 调整分栏宽度）请直接在界面操作；本页提供打开 / 关闭 / 重置三个入口。</p>
    </div>
  );
}

/** 收集可关闭的视图节点（非 host.slot.*），给出关闭按钮 */
function CloseButtons({ tree, onClose }: { tree: TreeNode; onClose: (id: string) => void }) {
  const closable: { id: string; viewType: string }[] = [];
  const walk = (n: TreeNode): void => {
    if (n.kind === 'view' && n.viewType && !n.viewType.startsWith('host.')) closable.push({ id: n.id, viewType: n.viewType });
    n.children?.forEach(walk);
  };
  walk(tree);
  if (closable.length === 0) return null;
  return (
    <div className="pm-close-list">
      <span className="pm-section-title">已打开的视图</span>
      {closable.map((v) => (
        <div className="pm-close-row" key={v.id}>
          <span className="pm-close-name">{v.viewType}</span>
          <button type="button" className="pm-btn pm-btn-danger" onClick={() => onClose(v.id)}>关闭</button>
        </div>
      ))}
    </div>
  );
}

// ── 面板入口 ────────────────────────────────────────────────────────────────

type Tab = 'plugins' | 'layout';
const TABS: { key: Tab; label: string }[] = [
  { key: 'plugins', label: '插件' },
  { key: 'layout', label: '布局' },
];

export function PluginManagerPanel() {
  const [tab, setTab] = useState<Tab>('plugins');
  const [rows, setRows] = useState<PluginRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    let registryPlugins: RegistryEntry[] = [];
    try {
      const data = await adminApi<{ plugins: RegistryEntry[] }>('/api/plugin-admin/list');
      registryPlugins = data.plugins ?? [];
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    const meta = api ? await api.dispatch<{ policies?: PolicyRow[] }>({ target: 'cap.meta', action: 'describe' }) : null;
    const policies = new Map((meta?.data?.policies ?? []).map((p) => [p.pluginId, p]));
    setRows(
      registryPlugins.map((entry) => {
        const policy = policies.get(entry.id);
        return {
          id: entry.id,
          enabled: entry.enabled !== false,
          listed: policy?.listed ?? false,
          capabilities: policy?.capabilities ?? [],
          provides: policy?.provides ?? [],
          deniedCount: policy?.denied?.length ?? 0,
        };
      }),
    );
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <div className="pm-root" data-testid="plugin-manager">
      <div className="pm-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={`pm-tab ${tab === t.key ? 'active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="pm-body">
        {error && <div className="pm-error" role="alert">{error}</div>}
        {tab === 'plugins' && <PluginList rows={rows} onChanged={() => void refresh()} />}
        {tab === 'layout' && <LayoutTab />}
      </div>
    </div>
  );
}
