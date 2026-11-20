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

// ── 面板顺序页签（原「布局」重构：树可视化对用户无意义，改为管理 panel 槽 tab 顺序） ──

interface SlotEntryInfo {
  slot: string;
  pluginId: string;
  component: string;
  title: string;
  order: number;
}

const PANEL_ORDER_KEY = 'plite.slot.order.panel';

function readPanelOrder(): string[] {
  try {
    const raw = localStorage.getItem(PANEL_ORDER_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

function writePanelOrder(keys: string[]): void {
  try {
    localStorage.setItem(PANEL_ORDER_KEY, JSON.stringify(keys));
  } catch {
    /* 持久化失败不阻断（会话内仍生效） */
  }
  // 通知同文档的 SlotOutlet 重读顺序（storage 事件只跨文档触发，同文档用自定义事件）
  window.dispatchEvent(new CustomEvent('plite-slot-order-changed', { detail: PANEL_ORDER_KEY }));
}

/** 纯函数：按 customOrder 重排 entries（稳定 key；未覆盖的保持原顺序排在后面） */
function applyOrder(entries: SlotEntryInfo[], customOrder: string[]): SlotEntryInfo[] {
  if (customOrder.length === 0) return entries;
  const rank = new Map(customOrder.map((k, i) => [k, i]));
  const keyOf = (e: SlotEntryInfo): string => `${e.pluginId}:${e.component}`;
  const inOrder = entries.filter((e) => rank.has(keyOf(e)));
  const rest = entries.filter((e) => !rank.has(keyOf(e)));
  inOrder.sort((a, b) => rank.get(keyOf(a))! - rank.get(keyOf(b))!);
  return [...inOrder, ...rest];
}

function OrderTab() {
  const [entries, setEntries] = useState<SlotEntryInfo[]>([]);
  const [customOrder, setCustomOrder] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    if (!api) return;
    const meta = await api.dispatch<{ slots?: SlotEntryInfo[] }>({
      target: 'cap.meta',
      action: 'describe',
      payload: { slot: 'panel' },
    });
    setEntries(meta.data?.slots ?? []);
    setCustomOrder(readPanelOrder());
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const commit = (next: string[]) => {
    setCustomOrder(next);
    writePanelOrder(next);
  };

  const keyOf = (e: SlotEntryInfo): string => `${e.pluginId}:${e.component}`;
  const ordered = applyOrder(entries, customOrder);

  /** 上移/下移：交换 customOrder 里的相邻位置（不在表里的先补进去再换） */
  const move = (key: string, dir: -1 | 1) => {
    const base = ordered.map(keyOf);
    const list = [...customOrder.filter((k) => base.includes(k)), ...base.filter((k) => !customOrder.includes(k))];
    const i = list.indexOf(key);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    commit(list);
  };

  const toTop = (key: string) => {
    const base = ordered.map(keyOf);
    const list = [...customOrder.filter((k) => base.includes(k)), ...base.filter((k) => !customOrder.includes(k))];
    commit([key, ...list.filter((k) => k !== key)]);
  };

  const resetOrder = () => {
    try { localStorage.removeItem(PANEL_ORDER_KEY); } catch { /* ignore */ }
    setCustomOrder([]);
    window.dispatchEvent(new CustomEvent('plite-slot-order-changed', { detail: PANEL_ORDER_KEY }));
  };

  return (
    <div className="pm-order">
      <div className="pm-order-actions">
        <button type="button" className="pm-btn" onClick={resetOrder} disabled={customOrder.length === 0}>
          恢复默认顺序
        </button>
      </div>
      {error && <div className="pm-error" role="alert">{error}</div>}
      <div className="pm-order-list" role="list" aria-label="面板顺序">
        {ordered.map((e, i) => {
          const key = keyOf(e);
          const customized = customOrder.includes(key);
          return (
            <div className="pm-order-row" role="listitem" key={key} data-customized={customized ? 'true' : undefined}>
              <span className="pm-order-idx">{i + 1}</span>
              <span className="pm-order-name" title={`${e.pluginId}:${e.component}`}>{e.title}</span>
              <span className="pm-order-plugin">{e.pluginId}</span>
              <span className="pm-order-btns">
                <button type="button" className="pm-icon-btn" aria-label={`上移 ${e.title}`} disabled={i === 0} onClick={() => move(key, -1)}>↑</button>
                <button type="button" className="pm-icon-btn" aria-label={`下移 ${e.title}`} disabled={i === ordered.length - 1} onClick={() => move(key, 1)}>↓</button>
                <button type="button" className="pm-icon-btn" aria-label={`置顶 ${e.title}`} disabled={i === 0} onClick={() => toTop(key)}>⤒</button>
              </span>
            </div>
          );
        })}
        {ordered.length === 0 && <div className="pm-empty">暂无面板贡献</div>}
      </div>
      <p className="pm-hint">调整面板 tab 的排列顺序，<strong>立即生效并持久保存</strong>。上移/下移/置顶只改顺序，不影响功能。</p>
    </div>
  );
}

// ── 面板入口 ────────────────────────────────────────────────────────────────

type Tab = 'plugins' | 'order';
const TABS: { key: Tab; label: string }[] = [
  { key: 'plugins', label: '插件' },
  { key: 'order', label: '排序' },
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
        {tab === 'order' && <OrderTab />}
      </div>
    </div>
  );
}
