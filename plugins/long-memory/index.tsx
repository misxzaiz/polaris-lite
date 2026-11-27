/**
 * long-memory 插件 UI 半边：长期记忆管理面板（panel 槽位）。
 *
 * 形态与纪律对齐 system-prompt：只消费宿主令牌（plite-tokens.css），HTTP 走
 * 同源 /api/long-memory/*（cookie 认证），不经 cap 授权面——管理面板是纯
 * HTTP 消费者，无 cap 能力申请。开关在 chat-lite 会话设置分区（那边读写同一
 * HTTP 端点），本面板负责条目管理 + 开关同步展示 + 清空/导出。
 */
import { useEffect as useReactEffect, useReducer as useReactReducer, useState } from 'react';
import type { LitePlugin, SlotHostApi } from '@sdk';
import './panel.css';

/* ---------------- 类型 ---------------- */

interface MemoryItem {
  id: string;
  text: string;
  kind: 'fact' | 'config';
  reason?: string;
  createdAt?: number;
  updatedAt?: number;
}

interface MemorySettings {
  enabled: boolean;
  injectLimit: number;
  count: number;
}

/* ---------------- HTTP 薄封装 ---------------- */

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

async function postJson<T>(url: string, body: unknown): Promise<T | null> {
  try {
    const r = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    return (await r.json().catch(() => null)) as T | null;
  } catch {
    return null;
  }
}

const SRV = '/api/long-memory';

/* ---------------- UI ---------------- */

function fmtTime(ts?: number): string {
  if (!ts) return '';
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

export function LongMemoryPanel(): JSX.Element {
  const [, force] = useReactReducer((x: number) => x + 1, 0);
  const [settings, setSettings] = useState<MemorySettings | null>(null);
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [filterKind, setFilterKind] = useState<'all' | 'fact' | 'config'>('all');
  const [q, setQ] = useState('');
  const [note, setNote] = useState('');
  const [newText, setNewText] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);

  // 初次加载 + 手动刷新共用
  const reload = async (): Promise<void> => {
    const [s, list] = await Promise.all([
      getJson<MemorySettings>(`${SRV}/settings`),
      getJson<{ items: MemoryItem[] }>(`${SRV}/items`),
    ]);
    if (s) setSettings(s);
    setItems(Array.isArray(list?.items) ? list.items : []);
    force();
  };

  useReactEffect(() => { void reload(); }, []);

  const toggleEnabled = async (): Promise<void> => {
    if (!settings) return;
    const next = await postJson<MemorySettings>(`${SRV}/settings`, { enabled: !settings.enabled });
    if (next && typeof next.enabled === 'boolean') {
      setSettings(next);
      setNote(next.enabled ? '已开启：新对话将注入记忆，AI 也会主动记录' : '已关闭：停用注入与写入，记忆保留不清空');
    } else {
      setNote('操作失败（服务不可用？）');
    }
    force();
  };

  const addItem = async (): Promise<void> => {
    const text = newText.trim();
    if (!text) return;
    const r = await postJson<{ id?: string; error?: string }>(`${SRV}/items`, { text, kind: 'fact', reason: '面板手动添加' });
    if (r?.id) {
      setNewText('');
      setNote('已添加');
      await reload();
    } else {
      setNote(`添加失败：${r?.error ?? '服务不可用'}`);
    }
  };

  const saveEdit = async (): Promise<void> => {
    if (!editingId) return;
    const text = editDraft.trim();
    if (!text) return;
    const r = await postJson<{ ok?: boolean; error?: string }>(`${SRV}/update`, { id: editingId, text });
    if (r?.ok) {
      setEditingId(null);
      setNote('已保存');
      await reload();
    } else {
      setNote(`保存失败：${r?.error ?? '服务不可用'}`);
    }
  };

  const delItem = async (id: string): Promise<void> => {
    const r = await postJson<{ ok?: boolean; error?: string }>(`${SRV}/delete`, { id });
    if (r?.ok) {
      setNote('已删除');
      await reload();
    } else {
      setNote(`删除失败：${r?.error ?? '服务不可用'}`);
    }
  };

  const clearAll = async (): Promise<void> => {
    const r = await postJson<{ ok?: boolean; cleared?: number }>(`${SRV}/clear`, {});
    setConfirmClear(false);
    setNote(r?.ok ? `已清空 ${r.cleared ?? 0} 条` : '清空失败');
    await reload();
  };

  const exportJson = (): void => {
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), items }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `long-memory-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const shown = items.filter((it) =>
    (filterKind === 'all' || it.kind === filterKind) &&
    (!q || it.text.toLowerCase().includes(q.toLowerCase()) || String(it.reason ?? '').toLowerCase().includes(q.toLowerCase())),
  );

  return (
    <div className="lm-panel">
      <div className="lm-head">
        <button
          type="button"
          className={`lm-switch ${settings?.enabled ? 'on' : ''}`}
          onClick={() => void toggleEnabled()}
          aria-pressed={!!settings?.enabled}
          title={settings?.enabled ? '点击关闭：停用注入与写入，记忆保留' : '点击开启：新对话注入记忆，AI 主动记录'}
        >
          <span className="lm-switch-knob" aria-hidden="true" />
        </button>
        <div className="lm-head-info">
          <span className="lm-head-title">长期记忆</span>
          <span className="lm-head-sub">
            {settings === null ? '加载中…' : settings.enabled
              ? `已开启 · ${settings.count} 条（本实例）`
              : `已关闭 · ${settings.count} 条保留`}
          </span>
        </div>
        <button type="button" className="lm-btn" onClick={() => void reload()} title="重新加载">刷新</button>
      </div>

      <div className="lm-add">
        <input
          className="lm-add-input"
          value={newText}
          placeholder="手动添加一条记忆（如：用户偏好中文回复）"
          onChange={(e) => setNewText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void addItem(); }}
        />
        <button type="button" className="lm-btn" disabled={!newText.trim()} onClick={() => void addItem()}>添加</button>
      </div>

      <div className="lm-toolbar">
        <select className="lm-select" value={filterKind} onChange={(e) => setFilterKind(e.target.value as typeof filterKind)} aria-label="筛选类型">
          <option value="all">全部类型</option>
          <option value="fact">对话事实</option>
          <option value="config">配置偏好</option>
        </select>
        <input className="lm-search" value={q} placeholder="搜索记忆…" onChange={(e) => setQ(e.target.value)} />
        <span className="lm-count">{shown.length} 条</span>
        <div className="lm-toolbar-acts">
          <button type="button" className="lm-btn lm-btn-ghost" disabled={items.length === 0} onClick={exportJson} title="导出全部记忆为 JSON">导出</button>
          <button type="button" className="lm-btn lm-btn-danger" disabled={items.length === 0} onClick={() => setConfirmClear(true)}>清空</button>
        </div>
      </div>

      {confirmClear && (
        <div className="lm-confirm">
          <span>确认清空全部 {items.length} 条记忆？此操作不可恢复（导出可先备份）。</span>
          <button type="button" className="lm-btn lm-btn-danger" onClick={() => void clearAll()}>确认清空</button>
          <button type="button" className="lm-btn" onClick={() => setConfirmClear(false)}>取消</button>
        </div>
      )}

      <div className="lm-list">
        {shown.length === 0 ? (
          <div className="lm-empty">
            {items.length === 0
              ? '暂无记忆。开启后，AI 会在对话中主动记录值得长期记住的信息；也可在上方手动添加。'
              : '没有匹配的记忆条目。'}
          </div>
        ) : shown.map((it) => (
          <div key={it.id} className="lm-item">
            <span className={`lm-item-kind ${it.kind}`} title={it.kind === 'config' ? '配置偏好' : '对话事实'}>
              {it.kind === 'config' ? '配置' : '事实'}
            </span>
            {editingId === it.id ? (
              <>
                <input
                  className="lm-item-edit"
                  value={editDraft}
                  onChange={(e) => setEditDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void saveEdit(); if (e.key === 'Escape') setEditingId(null); }}
                  autoFocus
                />
                <button type="button" className="lm-btn" onClick={() => void saveEdit()}>保存</button>
                <button type="button" className="lm-btn lm-btn-ghost" onClick={() => setEditingId(null)}>取消</button>
              </>
            ) : (
              <>
                <span className="lm-item-text" title={it.text}>{it.text}</span>
                {it.reason && <span className="lm-item-reason" title={`记录理由：${it.reason}`}>ⓘ</span>}
                <span className="lm-item-time">{fmtTime(it.createdAt)}</span>
                <button
                  type="button"
                  className="lm-btn lm-btn-ghost"
                  onClick={() => { setEditingId(it.id); setEditDraft(it.text); }}
                  title="编辑"
                >改</button>
                <button type="button" className="lm-btn lm-btn-danger" onClick={() => void delItem(it.id)} title="删除">删</button>
              </>
            )}
          </div>
        ))}
      </div>

      <div className="lm-foot">
        <span className={`lm-note ${note.startsWith('失败') || note.includes('失败') ? 'lm-note-err' : ''}`}>{note}</span>
      </div>
    </div>
  );
}

/* ---------------- 插件声明 ---------------- */

export const longMemoryPlugin: LitePlugin = {
  manifest: {
    id: 'long-memory',
    name: '长期记忆',
    version: '0.1.0',
    capabilities: [],
    provides: [],
    events: [],
    contributes: {
      // title ≤4 字防 panel tab 截断；order 避开已占用段（system-prompt=44）
      slots: [{ slot: 'panel', component: 'LongMemoryPanel', order: 45, title: '记忆' }],
    },
  },
  setup(_a: SlotHostApi) {
    /* 无 cap 申请：面板是纯 HTTP 消费者 */
  },
};

export default longMemoryPlugin;
