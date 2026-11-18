/** 模型供应商管理面板 UI：列表 + 表单 + 逐模型能力编辑 + 连通性测试 + 能力自动识别 */
import { useEffect, useState } from 'react';
import type { LitePlugin, SlotHostApi } from '@/core/types';
import type { ProviderConfig, ModelInfo } from './index';

let api: SlotHostApi | null = null;
export function setPanelApi(a: SlotHostApi | null): void { api = a; }

interface PublicConfig extends Omit<ProviderConfig, 'apiKey'> {
  apiKey: string; // 打码值
  hasKey?: boolean;
}

interface DetectReportView {
  modelId: string;
  notes: string[];
}

const EMPTY_FORM: ProviderConfig = {
  id: '',
  name: '',
  baseURL: '',
  apiKey: '',
  models: [],
  activeModel: '',
  enabled: true,
  isDefault: false,
};

const EFFORT_LABEL: Record<string, string> = {
  minimal: 'minimal', low: 'low', medium: 'medium', high: 'high',
};

/** 删除确认回退计时 */
const ARM_TIMEOUT_MS = 3000;

export function ModelAdminPanel() {
  const [configs, setConfigs] = useState<PublicConfig[]>([]);
  const [editing, setEditing] = useState<ProviderConfig | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; text: string; busy?: boolean }>>({});
  const [detectResult, setDetectResult] = useState<Record<string, { ok: boolean; reports: DetectReportView[]; catalogNotes: string[]; note?: string } | { ok: false; error: string } | undefined>>({});
  const [detectBusy, setDetectBusy] = useState<Record<string, boolean>>({});
  const [modelsText, setModelsText] = useState('');
  const [armDelete, setArmDelete] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState<string | null>(null);

  const refresh = async () => {
    if (!api) return;
    const res = await api.dispatch<{ configs: PublicConfig[] }>({ target: 'cap.model.admin', action: 'list' });
    if (res.ok && res.data) setConfigs(res.data.configs);
  };

  useEffect(() => {
    void refresh();
  }, []);

  const startNew = () => {
    setIsNew(true);
    setEditing({ ...EMPTY_FORM, id: `prov-${Date.now().toString(36)}` });
    setModelsText('');
  };

  const startEdit = (c: PublicConfig) => {
    setIsNew(false);
    setEditing({ ...c, apiKey: '' }); // 打码回显：留空 = 不改
    setModelsText(c.models.map((m) => m.id).join(', '));
  };

  const saveForm = async () => {
    if (!api || !editing) return;
    const ids = modelsText.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    // 能力字段：表单内编辑过的（editing.models）优先——它带本次人工修改（detected=manual）；
    // 仅当模型是本次新增（表单里还没有）才用默认（未知），可一键识别回填。
    const modelsWithCaps: ModelInfo[] = ids.map((id) => {
      const edited = editing.models.find((m) => m.id === id);
      return edited ?? { id, capabilities: { maxInputTokens: 0, maxOutputTokens: 0, effort: null, vision: false } };
    });
    const payload: ProviderConfig = { ...editing, models: modelsWithCaps, activeModel: editing.activeModel || ids[0] || '' };
    await api.dispatch({ target: 'cap.model.admin', action: 'save', payload: { config: payload } });
    setEditing(null);
    await refresh();
  };

  /** 两段式删除：第一击 arm，3s 内再击执行；超时/失焦回退 */
  const removeWithConfirm = async (id: string) => {
    if (!api) return;
    if (armDelete !== id) {
      setArmDelete(id);
      setTimeout(() => setArmDelete((cur) => (cur === id ? null : cur)), ARM_TIMEOUT_MS);
      return;
    }
    setArmDelete(null);
    setMoreOpen(null);
    await api.dispatch({ target: 'cap.model.admin', action: 'remove', payload: { id } });
    await refresh();
  };

  const setDefault = async (id: string) => {
    if (!api) return;
    setMoreOpen(null);
    await api.dispatch({ target: 'cap.model.admin', action: 'setDefault', payload: { id } });
    await refresh();
  };

  const toggleEnabled = async (c: PublicConfig) => {
    if (!api) return;
    await api.dispatch({
      target: 'cap.model.admin',
      action: 'save',
      payload: { config: { ...c, enabled: !c.enabled } as ProviderConfig },
    });
    await refresh();
  };

  /** 表单内：更新某个模型的能力字段（编辑本地 editing.models，保存时随表单落盘） */
  const updateModelCap = (modelId: string, patch: Partial<ModelInfo['capabilities']>) => {
    if (!editing) return;
    setEditing({
      ...editing,
      models: editing.models.map((m) =>
        m.id === modelId ? { ...m, capabilities: { ...m.capabilities, ...patch, detected: 'manual' } } : m,
      ),
    });
  };

  /** 一键识别：走 cap.model.admin/detect（内置表 + 真实链路探测），结论直接落库。
   *  busy 态期间 aria-busy + pointer-events:none 物理防重复点击。 */
  const detectCapabilities = async (id: string) => {
    if (!api || detectBusy[id]) return;
    setMoreOpen(null);
    setDetectBusy((s) => ({ ...s, [id]: true }));
    setDetectResult((s) => ({ ...s, [id]: undefined }));
    const t0 = performance.now();
    try {
      const res = await api.dispatch<{
        reports?: { modelId: string; notes: string[] }[];
        catalogNotes?: string[];
        configs?: PublicConfig[];
      }>({ target: 'cap.model.admin', action: 'detect', payload: { id } });
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      if (res.ok && res.data) {
        if (res.data.configs) setConfigs(res.data.configs);
        const anyManual = (res.data.configs ?? [])
          .some((c) => c.id === id && c.models.some((m) => m.capabilities.detected === 'manual'));
        setDetectResult((s) => ({
          ...s,
          [id]: {
            ok: (res.data!.reports ?? []).length > 0,
            reports: res.data!.reports ?? [],
            catalogNotes: res.data!.catalogNotes ?? [],
            note: anyManual ? '注：人工编辑过的模型保持原值不被覆盖' : undefined,
          },
        }));
      } else {
        setDetectResult((s) => ({ ...s, [id]: { ok: false, error: `识别失败：${res.error ?? '未知错误'}` } }));
      }
      void secs;
    } finally {
      setDetectBusy((s) => ({ ...s, [id]: false }));
    }
  };

  const testConnectivity = async (c: PublicConfig) => {
    setTestResult((s) => ({ ...s, [c.id]: { ok: false, text: '测试中…', busy: true } }));
    const t0 = performance.now();
    try {
      // 取该供应商的真实 key（cap.model.admin/getPlain；面板展示仍是打码值）
      const keyRes = await api.dispatch<{ config?: { apiKey?: string } }>({
        target: 'cap.model.admin',
        action: 'getPlain',
        payload: { id: c.id },
      });
      const plainKey = keyRes.data?.config?.apiKey ?? '';
      // 走与真实对话相同的中继链路（同源 /api/model-relay，登录会话 cookie 自动携带）
      const resp = await fetch('/api/model-relay', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${plainKey}`,
        },
        body: JSON.stringify({
          url: `${c.baseURL.replace(/\/$/, '')}/chat/completions`,
          body: { model: c.models[0]?.id ?? 'gpt-4o-mini', messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 },
        }),
      });
      const ms = Math.round(performance.now() - t0);
      const text = await resp.text();
      let detail = `HTTP ${resp.status}`;
      try {
        const j = JSON.parse(text);
        detail = j.error?.message ?? j.message ?? detail;
      } catch { /* keep */ }
      setTestResult((s) => ({ ...s, [c.id]: { ok: resp.ok, text: resp.ok ? `连通 ${ms}ms` : `${detail} (${ms}ms)` } }));
    } catch {
      const ms = Math.round(performance.now() - t0);
      setTestResult((s) => ({ ...s, [c.id]: { ok: false, text: `无法连接中继 (${ms}ms)` } }));
    }
  };

  /** 能力徽标（列表页速览）：{label, cls} 对，cls 映射语义配色 */
  const capBadges = (m: ModelInfo): { label: string; cls: string }[] => {
    const out: { label: string; cls: string }[] = [];
    if (m.capabilities.detected === 'manual') out.push({ label: '人工', cls: 't-manual' });
    else if (m.capabilities.detected === 'probe') out.push({ label: '实测', cls: 't-probe' });
    else if (m.capabilities.detected === 'builtin') out.push({ label: '内置表', cls: 't-builtin' });
    if (m.capabilities.vision) out.push({ label: '图', cls: 't-vision' });
    if (m.capabilities.effort) out.push({ label: `思${EFFORT_LABEL[m.capabilities.effort] ?? m.capabilities.effort}`, cls: 't-effort' });
    if (m.capabilities.maxInputTokens > 0) out.push({ label: `${Math.round(m.capabilities.maxInputTokens / 1000)}k`, cls: 't-ctx' });
    return out;
  };

  // ===== 表单视图 =====
  if (editing) {
    return (
      <div className="cap-panel model-admin" data-testid="model-admin">
        <h3>{isNew ? '新增供应商' : '编辑供应商'}</h3>
        <div className="ma-form">
          <label>名称</label>
          <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="OpenAI" />
          <label>Base URL</label>
          <input value={editing.baseURL} onChange={(e) => setEditing({ ...editing, baseURL: e.target.value })} placeholder="https://api.openai.com/v1" />
          <label>API Key {isNew ? '' : '(留空 = 不修改)'}</label>
          <input type="password" value={editing.apiKey} onChange={(e) => setEditing({ ...editing, apiKey: e.target.value })} placeholder="sk-..." />
          <label>模型列表（逗号分隔；保存后可逐模型编辑能力）</label>
          <input value={modelsText} onChange={(e) => setModelsText(e.target.value)} placeholder="gpt-4o-mini, gpt-4o" />
          {editing.models.length > 0 && (
            <>
              <label style={{ marginTop: 10 }}>模型能力（留 0/空 = 未知；保存后可「一键识别」自动回填）</label>
              {editing.models.map((m) => (
                <div key={m.id} className="ma-cap-card" data-testid={`ma-cap-${m.id}`}>
                  <div className="ma-cap-head">
                    <code title={m.id}>{m.id}</code>
                    {m.capabilities.detected && (
                      <span className={`ma-badge ${m.capabilities.detected === 'manual' ? '' : 'off'}`}>
                        {{ manual: '人工', probe: '实测', builtin: '内置表', catalog: '目录' }[m.capabilities.detected] ?? m.capabilities.detected}
                      </span>
                    )}
                  </div>
                  <div className="ma-cap-grid">
                    <span>输入 tokens</span>
                    <input
                      inputMode="numeric"
                      value={m.capabilities.maxInputTokens || ''}
                      onChange={(e) => updateModelCap(m.id, { maxInputTokens: Math.max(0, Number(e.target.value.replace(/\D/g, '')) || 0) })}
                      placeholder="0=未知"
                    />
                    <span>输出 tokens</span>
                    <input
                      inputMode="numeric"
                      value={m.capabilities.maxOutputTokens || ''}
                      onChange={(e) => updateModelCap(m.id, { maxOutputTokens: Math.max(0, Number(e.target.value.replace(/\D/g, '')) || 0) })}
                      placeholder="0=默认"
                    />
                    <span>图片输入</span>
                    <label className="ma-check ma-cap-inline">
                      <input
                        type="checkbox"
                        checked={!!m.capabilities.vision}
                        onChange={(e) => updateModelCap(m.id, { vision: e.target.checked })}
                      />
                      支持
                    </label>
                    <span>思考等级</span>
                    <select
                      value={m.capabilities.effort ?? ''}
                      onChange={(e) => updateModelCap(m.id, { effort: (e.target.value || null) as ModelInfo['capabilities']['effort'] })}
                    >
                      <option value="">不支持/未知</option>
                      <option value="minimal">minimal</option>
                      <option value="low">low</option>
                      <option value="medium">medium</option>
                      <option value="high">high</option>
                    </select>
                  </div>
                </div>
              ))}
            </>
          )}
          <label className="ma-check">
            <input type="checkbox" checked={editing.enabled} onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })} />
            启用
          </label>
          <label className="ma-check">
            <input type="checkbox" checked={!!editing.isDefault} onChange={(e) => setEditing({ ...editing, isDefault: e.target.checked })} />
            设为默认
          </label>
        </div>
        <div className="ma-actions">
          <button className="ma-btn primary" onClick={saveForm} disabled={!editing.name || !editing.baseURL}>保存</button>
          <button className="ma-btn" onClick={() => setEditing(null)}>取消</button>
        </div>
      </div>
    );
  }

  // ===== 列表视图 =====
  return (
    <div className="cap-panel model-admin" data-testid="model-admin" onClick={() => moreOpen && setMoreOpen(null)}>
      <h3>模型供应商</h3>
      <div className="ma-list">
        {configs.map((c) => {
          const dr = detectResult[c.id];
          return (
            <div key={c.id} className={`ma-item ${c.enabled ? '' : 'disabled'}`}>
              <div className="ma-item-head">
                <span className="ma-name" title={c.name}>
                  {c.name}
                  {c.isDefault && <span className="ma-badge">默认</span>}
                  {!c.enabled && <span className="ma-badge off">停用</span>}
                </span>
                <label className="ma-switch" title="启用/停用">
                  <input type="checkbox" checked={c.enabled} onChange={() => toggleEnabled(c)} />
                  <span />
                </label>
              </div>
              <div className="ma-meta" title={c.baseURL}>{c.baseURL}</div>
              <div className="ma-meta">
                Key: {c.hasKey ? <code>{c.apiKey}</code> : <em>未配置</em>}
              </div>
              {c.models.length > 0 && (
                <div className="ma-models">
                  {c.models.map((m) => (
                    <span key={m.id} className="ma-model-chip" title={`输入 ${m.capabilities.maxInputTokens || '?'} / 输出 ${m.capabilities.maxOutputTokens || '?'}`}>
                      <code>{m.id}</code>
                      {capBadges(m).map((b) => <em key={b.cls + b.label} className={b.cls}>{b.label}</em>)}
                    </span>
                  ))}
                </div>
              )}
              <div className={`ma-test-line ${testResult[c.id]?.busy ? 'busy' : testResult[c.id]?.ok ? 'ok' : testResult[c.id] ? 'fail' : ''}`}>
                {testResult[c.id]?.text ?? ''}
              </div>
              <div className="ma-row ma-ops">
                <button className="ma-btn small" onClick={() => startEdit(c)}>编辑</button>
                <button className="ma-btn small" onClick={() => testConnectivity(c)}>测试</button>
                <div className="ma-more">
                  <button
                    aria-haspopup="menu"
                    aria-expanded={moreOpen === c.id}
                    onClick={(e) => { e.stopPropagation(); setMoreOpen(moreOpen === c.id ? null : c.id); }}
                  >
                    更多 ▾
                  </button>
                  {moreOpen === c.id && (
                    <div className="ma-more-menu" role="menu">
                      <button
                        role="menuitem"
                        aria-busy={!!detectBusy[c.id]}
                        disabled={!c.hasKey}
                        title="自动识别各模型能力（内置知识表 + 真实链路探测，耗时数秒）"
                        onClick={(e) => { e.stopPropagation(); void detectCapabilities(c.id); }}
                      >
                        {detectBusy[c.id] ? '识别中…' : '识别模型能力'}
                      </button>
                      {!c.isDefault && (
                        <button role="menuitem" onClick={(e) => { e.stopPropagation(); void setDefault(c.id); }}>设为默认</button>
                      )}
                      <button
                        role="menuitem"
                        className={`danger ${armDelete === c.id ? 'arm' : ''}`}
                        onClick={(e) => { e.stopPropagation(); void removeWithConfirm(c.id); }}
                      >
                        {armDelete === c.id ? '确认删除？' : '删除'}
                      </button>
                    </div>
                  )}
                </div>
              </div>
              {dr && 'error' in dr && (
                <pre className="ma-detect fail">{dr.error}</pre>
              )}
              {dr && 'reports' in dr && (
                <div className={`ma-detect-report ${dr.ok ? 'ok' : 'fail'}`}>
                  <div className="ma-detect-head">
                    {dr.ok ? '✓ 识别完成' : '识别无结论'}
                    <span className="ma-detect-sub">{dr.reports.length} 个模型</span>
                  </div>
                  {dr.reports.map((r) => (
                    <div key={r.modelId} className="ma-detect-model">
                      <code>{r.modelId}</code>
                      {r.notes.length > 0 ? (
                        <ul>{r.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
                      ) : (
                        <ul><li>无结论</li></ul>
                      )}
                    </div>
                  ))}
                  {dr.catalogNotes.map((n, i) => (
                    <div key={i} className="ma-detect-model"><ul><li>{n}</li></ul></div>
                  ))}
                  {dr.note && <div className="ma-detect-note">{dr.note}</div>}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <button className="ma-btn primary wide" onClick={startNew}>+ 新增供应商</button>
      <p className="ma-hint">配置保存后广播 model-config-changed，引擎插件监听后免刷新热更新；「识别模型能力」走真实链路探测（消耗少量 token），结论自动落库。</p>
    </div>
  );
}
