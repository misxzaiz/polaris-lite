/** 模型供应商管理面板 UI：列表 + 表单 + 逐模型能力编辑 + 连通性测试 + 能力自动识别 */
import { useEffect, useState } from 'react';
import type { SlotHostApi } from '@/core/types';
import type { ProviderConfig, ModelInfo, PublicProvider } from './index';

let api: SlotHostApi | null = null;
export function setPanelApi(a: SlotHostApi | null): void { api = a; }

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
  const [configs, setConfigs] = useState<PublicProvider[]>([]);
  const [editing, setEditing] = useState<ProviderConfig | null>(null);
  /** 编辑态展示用的既有 key 打码值（明文永不下发到前端） */
  const [editingKeyMasked, setEditingKeyMasked] = useState('');
  const [isNew, setIsNew] = useState(false);
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; text: string; busy?: boolean }>>({});
  const [detectResult, setDetectResult] = useState<Record<string, { ok: boolean; reports: DetectReportView[]; catalogNotes: string[]; note?: string } | { ok: false; error: string } | undefined>>({});
  const [detectBusy, setDetectBusy] = useState<Record<string, boolean>>({});
  const [modelsText, setModelsText] = useState('');
  const [armDelete, setArmDelete] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState<string | null>(null);

  const refresh = async () => {
    if (!api) return;
    const res = await api.dispatch<{ configs: PublicProvider[] }>({ target: 'cap.model.admin', action: 'list' });
    if (res.ok && res.data) setConfigs(res.data.configs);
  };

  useEffect(() => {
    void refresh();
  }, []);

  const startNew = () => {
    setIsNew(true);
    setEditing({ ...EMPTY_FORM, id: `prov-${Date.now().toString(36)}` });
    setEditingKeyMasked('');
    setModelsText('');
  };

  const startEdit = (c: PublicProvider) => {
    setIsNew(false);
    // apiKey 留空 = 不修改；掩码值只用于提示，不写进输入框
    setEditing({ ...c, apiKey: '' });
    setEditingKeyMasked(c.keyMasked);
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

  const toggleEnabled = async (c: PublicProvider) => {
    if (!api) return;
    await api.dispatch({
      target: 'cap.model.admin',
      action: 'save',
      payload: { config: { ...c, enabled: !c.enabled } },
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

  /** 一键识别：走 cap.model.admin/probe（服务端实测 + 前端内置表合并），结论直接落库。
   *  busy 态期间 aria-busy + pointer-events:none 物理防重复点击。 */
  const detectCapabilities = async (id: string) => {
    if (!api || detectBusy[id]) return;
    setMoreOpen(null);
    setDetectBusy((s) => ({ ...s, [id]: true }));
    setDetectResult((s) => ({ ...s, [id]: undefined }));
    try {
      const res = await api.dispatch<{
        reports?: { modelId: string; notes: string[] }[];
        catalogNotes?: string[];
        configs?: PublicProvider[];
      }>({ target: 'cap.model.admin', action: 'probe', payload: { id } });
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
        setDetectResult((s) => ({ ...s, [id]: { ok: false, error: `识别失败：${res.error?.message ?? '未知错误'}` } }));
      }
    } catch (e) {
      setDetectResult((s) => ({ ...s, [id]: { ok: false, error: `识别失败：${e instanceof Error ? e.message : String(e)}` } }));
    } finally {
      setDetectBusy((s) => ({ ...s, [id]: false }));
    }
  };

  /** 连通性测试：服务端持 key 直连上游，前端只展示结论（不再取明文 key） */
  const testConnectivity = async (c: PublicProvider) => {
    setTestResult((s) => ({ ...s, [c.id]: { ok: false, text: '测试中…', busy: true } }));
    const t0 = performance.now();
    try {
      const res = await api!.dispatch<{ ok?: boolean; text?: string }>({
        target: 'cap.model.admin',
        action: 'test',
        payload: { id: c.id },
      });
      const ms = Math.round(performance.now() - t0);
      const text = res.ok && res.data?.text ? res.data.text : (res.error?.message ?? '测试失败');
      setTestResult((s) => ({ ...s, [c.id]: { ok: !!res.ok, text: `${text} (${ms}ms)` } }));
    } catch {
      const ms = Math.round(performance.now() - t0);
      setTestResult((s) => ({ ...s, [c.id]: { ok: false, text: `无法连接宿主服务 (${ms}ms)` } }));
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
          <input
            type="password"
            value={editing.apiKey}
            onChange={(e) => setEditing({ ...editing, apiKey: e.target.value })}
            placeholder={isNew ? 'sk-...' : (editingKeyMasked ? `当前 ${editingKeyMasked}（留空保持不变）` : '未配置')}
            autoComplete="new-password"
          />
          <span className="ma-hint" style={{ marginTop: -4 }}>
            Key 由服务端保存（.polaris-lite/providers.json），浏览器不保留明文
          </span>
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
                Key: {c.hasKey ? <code>{c.keyMasked}</code> : <em>未配置</em>}
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
