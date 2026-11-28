/**
 * cron-agent 插件前端：定时任务管理面板（纯 HTTP 消费者，同 long-memory 惯例）。
 *
 * 面板经同源 /api/cron/*（cookie 认证）管理任务：新建/编辑/启停/立即试跑/删除，
 * 引擎-供应商-模型三级下拉（数据来自 /api/cron/engines）。任务到点由服务端
 * 触发完整 AI 对话（MCP/Skills/Hooks 全量），报告落会话档并推送。
 */
import { useEffect as useReactEffect, useReducer as useReactReducer, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LitePlugin, SlotHostApi } from '@sdk';
import './panel.css';

/* ---------------- HTTP 薄封装 ---------------- */

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch { return null; }
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
  } catch { return null; }
}

const SRV = '/api/cron';

/* ---------------- 类型 ---------------- */

interface CronRun {
  runId: string | null;
  sessionId: string | null;
  reason: string;
  status: 'running' | 'done' | 'failed' | 'skipped';
  startedAt: number;
  endedAt: number | null;
  error?: string | null;
}

interface CronTask {
  id: string;
  name: string;
  cron: string;
  prompt: string;
  modelRef: { engineId?: string; providerId?: string; modelId?: string; option?: string };
  enabled: boolean;
  notify: { desktop: boolean; phone: boolean };
  createdAt: number;
  lastRunAt: number | null;
  nextRunAt: number | null;
  lastError: string | null;
  runs: CronRun[];
}

interface EngineCatalog {
  engines: { id: string; kind: string; default: boolean }[];
  providers: { id: string; label: string; activeModel: string | null }[];
}

/* ---------------- UI 工具 ---------------- */

function fmtTime(ts?: number | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function relTime(ts?: number | null): string {
  if (!ts) return '—';
  const diff = ts - Date.now();
  const abs = Math.abs(diff);
  if (abs < 60_000) return diff >= 0 ? '即将执行' : '刚刚';
  const m = Math.floor(abs / 60_000);
  if (m < 60) return diff >= 0 ? `${m} 分钟后` : `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return diff >= 0 ? `${h} 小时后` : `${h} 小时前`;
  const day = Math.floor(h / 24);
  if (day < 30) return diff >= 0 ? `${day} 天后` : `${day} 天前`;
  return fmtTime(ts);
}

/* ---------------- 面板 ---------------- */

function CronAgentPanel() {
  const [, force] = useReactReducer((x: number) => x + 1, 0);
  const [tasks, setTasks] = useState<CronTask[]>([]);
  const [catalog, setCatalog] = useState<EngineCatalog | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState<CronTask | null>(null);
  const [creating, setCreating] = useState(false);
  const [tip, setTip] = useState('');

  const reload = async () => {
    const r = await getJson<{ tasks: CronTask[] }>(`${SRV}/tasks`);
    if (r) setTasks(r.tasks ?? []);
    setLoaded(true);
    force();
  };

  const reloadCatalog = async () => {
    const r = await getJson<EngineCatalog>(`${SRV}/engines`);
    if (r) setCatalog(r);
  };

  useReactEffect(() => {
    void reload();
    void reloadCatalog();
    const t = setInterval(() => { void reload(); }, 30_000);
    return () => { clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flash = (msg: string) => {
    setTip(msg);
    setTimeout(() => setTip(''), 2600);
  };

  const toggle = async (t: CronTask) => {
    await postJson(`${SRV}/tasks/update`, { id: t.id, enabled: !t.enabled });
    await reload();
  };

  const runNow = async (t: CronTask) => {
    const r = await postJson<{ ok: boolean }>(`${SRV}/tasks/run-now`, { id: t.id });
    flash(r?.ok ? `任务「${t.name}」已发起试跑，报告将自动推送` : '发起失败');
    setTimeout(() => { void reload(); }, 2000);
  };

  const remove = async (t: CronTask) => {
    if (!window.confirm(`删除任务「${t.name}」？执行历史一并删除。`)) return;
    await postJson(`${SRV}/tasks/delete`, { id: t.id });
    await reload();
  };

  const statusBadge = (t: CronTask) => {
    const last = t.runs?.[0];
    if (!t.enabled) return <span className="cr-badge off">停用</span>;
    if (last?.status === 'running') return <span className="cr-badge run">执行中</span>;
    if (t.lastError) return <span className="cr-badge err">上次失败</span>;
    return <span className="cr-badge on">启用</span>;
  };

  const modelText = (t: CronTask) => {
    const r = t.modelRef ?? {};
    const parts = [r.engineId, r.providerId, r.modelId, r.option].filter(Boolean);
    return parts.length ? parts.join(' / ') : '（跟随当前模型）';
  };

  return (
    <div className="cron-panel">
      <div className="cr-head">
        <div>
          <div className="cr-title">定时任务</div>
          <div className="cr-sub">到点自动触发完整 AI 对话：MCP / Skills / Hooks / 全部工具可用，报告自动推送</div>
        </div>
        <button className="cr-btn primary" onClick={() => setCreating(true)}>＋ 新建任务</button>
      </div>

      {tip && <div className="cr-tip">{tip}</div>}

      {loaded && tasks.length === 0 && (
        <div className="cr-empty">
          还没有定时任务。也可以直接在对话里对 AI 说「帮我加个每天早上 8 点报新闻的定时任务」。
        </div>
      )}

      <div className="cr-list">
        {tasks.map((t) => (
          <div key={t.id} className={`cr-task ${t.enabled ? '' : 'disabled'}`}>
            <div className="cr-task-main">
              <div className="cr-task-row1">
                <span className="cr-task-name">{t.name}</span>
                {statusBadge(t)}
              </div>
              <div className="cr-task-prompt">{t.prompt}</div>
              <div className="cr-task-meta">
                <span className="cr-cron">{t.cron}</span>
                <span>·</span>
                <span className="cr-model">{modelText(t)}</span>
              </div>
              <div className="cr-task-meta dim">
                <span>下次：{relTime(t.nextRunAt)}</span>
                {t.lastRunAt && <span>上次：{fmtTime(t.lastRunAt)}</span>}
              </div>
              {t.lastError && <div className="cr-task-error">{t.lastError}</div>}
            </div>
            <div className="cr-task-actions">
              <button className="cr-btn ghost" onClick={() => setEditing(t)}>编辑</button>
              <button className="cr-btn ghost" onClick={() => void runNow(t)}>试跑</button>
              <button className="cr-btn ghost" onClick={() => void toggle(t)}>{t.enabled ? '停用' : '启用'}</button>
              <button className="cr-btn ghost danger" onClick={() => void remove(t)}>删除</button>
            </div>
            {t.runs?.length > 0 && (
              <div className="cr-runs">
                {t.runs.map((r, i) => (
                  <div key={i} className="cr-run">
                    <span className={`cr-run-st ${r.status}`}>{r.status}</span>
                    <span>{fmtTime(r.startedAt)}</span>
                    <span className="cr-run-reason">{r.reason}</span>
                    {r.error && <span className="cr-run-err">{r.error}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {(creating || editing) && (
        <TaskModal
          task={editing}
          catalog={catalog}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={async () => { setCreating(false); setEditing(null); await reload(); }}
        />
      )}
    </div>
  );
}

/* ---------------- 任务编辑弹窗（portal 到宿主 overlay root；插件 CSS 禁 fixed）---------------- */

function useOverlayRoot(): HTMLElement | null {
  const [root, setRoot] = useState<HTMLElement | null>(null);
  useReactEffect(() => {
    const find = (): void => setRoot(document.getElementById('plite-overlay-root'));
    find();
    const iv = window.setInterval(() => {
      find();
      if (document.getElementById('plite-overlay-root')) window.clearInterval(iv);
    }, 300);
    return () => { window.clearInterval(iv); };
  }, []);
  return root;
}

function TaskModal(props: { task: CronTask | null; catalog: EngineCatalog | null; onClose(): void; onSaved(): void }) {
  const overlayRoot = useOverlayRoot();
  const t = props.task;
  const [name, setName] = useState(t?.name ?? '');
  const [cron, setCron] = useState(t?.cron ?? '0 9 * * *');
  const [prompt, setPrompt] = useState(t?.prompt ?? '');
  const [engineId, setEngineId] = useState(t?.modelRef?.engineId ?? '');
  const [providerId, setProviderId] = useState(t?.modelRef?.providerId ?? '');
  const [modelId, setModelId] = useState(t?.modelRef?.modelId ?? '');
  const [notifyDesktop, setNotifyDesktop] = useState(t?.notify?.desktop !== false);
  const [notifyPhone, setNotifyPhone] = useState(t?.notify?.phone !== false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const engines = props.catalog?.engines ?? [];
  const providers = props.catalog?.providers ?? [];
  const activeProvider = providers.find((p) => p.id === providerId);

  const save = async () => {
    if (!name.trim() || !prompt.trim()) { setErr('名称与提示词必填'); return; }
    setSaving(true);
    const body = {
      id: t?.id,
      name: name.trim(),
      cron: cron.trim(),
      prompt: prompt.trim(),
      modelRef: { engineId: engineId || undefined, providerId: providerId || undefined, modelId: modelId || undefined },
      notify: { desktop: notifyDesktop, phone: notifyPhone },
    };
    const r = t
      ? await postJson<{ ok: boolean; error?: string }>(`${SRV}/tasks/update`, body)
      : await postJson<{ ok: boolean; error?: string }>(`${SRV}/tasks`, body);
    setSaving(false);
    if (!r?.ok) { setErr(r?.error ?? '保存失败'); return; }
    props.onSaved();
  };

  const body = (
    <div className="cr-modal-bg" onClick={(e) => { if (e.target === (e.currentTarget)) props.onClose(); }}>
      <div className="cr-modal">
        <div className="cr-modal-title">{t ? '编辑任务' : '新建定时任务'}</div>

        <label className="cr-field">
          <span>任务名称</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：基金行情复查" />
        </label>

        <label className="cr-field">
          <span>Cron 表达式（分 时 日 月 周）</span>
          <input value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 9 5 * *" className="cr-cron-input" />
          <span className="cr-hint">示例：0 8 * * *（每天 8 点）· 0 9 5 * *（每月 5 号 9 点）· 30 8 * * 6（每周六 8:30）</span>
        </label>

        <label className="cr-field">
          <span>任务提示词（AI 到点收到的指令）</span>
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)}
            placeholder="复查三只基金最新净值与行情，对比定投方案给出操作建议，简短输出" />
        </label>

        <div className="cr-field">
          <span>模型选择（留空 = 跟随当前活跃模型）</span>
          <div className="cr-model-row">
            <select value={engineId} onChange={(e) => { setEngineId(e.target.value); setProviderId(''); setModelId(''); }}>
              <option value="">（默认引擎）</option>
              {engines.map((e) => <option key={e.id} value={e.id}>{e.id}{e.default ? '（默认）' : ''}</option>)}
            </select>
            <select value={providerId} onChange={(e) => { setProviderId(e.target.value); setModelId(''); }} disabled={!providers.length}>
              <option value="">（默认供应商）</option>
              {providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            <select value={modelId} onChange={(e) => setModelId(e.target.value)} disabled={!providerId}>
              <option value="">（默认模型{activeProvider?.activeModel ? `：${activeProvider.activeModel}` : ''}）</option>
              {activeProvider?.activeModel && <option value={activeProvider.activeModel}>{activeProvider.activeModel}</option>}
            </select>
          </div>
          <span className="cr-hint">轻任务（日报/天气）建议选便宜快模型；行情复盘建议强模型</span>
        </div>

        <div className="cr-field">
          <span>推送方式</span>
          <div className="cr-chk-row">
            <label><input type="checkbox" checked={notifyDesktop} onChange={(e) => setNotifyDesktop(e.target.checked)} />桌面通知</label>
            <label><input type="checkbox" checked={notifyPhone} onChange={(e) => setNotifyPhone(e.target.checked)} />手机推送</label>
          </div>
        </div>

        {err && <div className="cr-modal-err">{err}</div>}

        <div className="cr-modal-actions">
          <button className="cr-btn ghost" onClick={props.onClose} disabled={saving}>取消</button>
          <button className="cr-btn primary" onClick={() => void save()} disabled={saving}>{saving ? '保存中…' : '保存'}</button>
        </div>
      </div>
    </div>
  );
  return overlayRoot ? createPortal(body, overlayRoot) : body;
}

/* ---------------- 插件声明 ---------------- */

export const cronAgentPlugin: LitePlugin = {
  manifest: {
    id: 'cron-agent',
    name: '定时任务',
    version: '0.1.0',
    capabilities: [],
    provides: [],
    events: [],
    contributes: {
      // title ≤4 字防 panel tab 截断；order 避开已占用段（记忆=45）
      slots: [{ slot: 'panel', component: 'CronAgentPanel', order: 46, title: '定时' }],
    },
  },
  setup(_a: SlotHostApi) {
    /* 无 cap 申请：面板是纯 HTTP 消费者，任务数据在服务端 kv-store */
  },
};

export { CronAgentPanel };
export default cronAgentPlugin;
