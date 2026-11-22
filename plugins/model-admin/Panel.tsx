/**
 * 模型供应商管理面板 UI（v0.4）：
 * 列表 + 表单（模型独立条目编辑器）+ 逐模型能力抽屉 + 拉取模型列表 + 复制/粘贴导入 + 明文 Key 查看。
 *
 * v0.4 变更（2026-11-21）：
 * - 模型不再用逗号串输入：每个模型是独立条目（单独添加/删除/编辑能力/设默认调用），
 *   保存不再做「拆字符串 → 按 id 反查能力」的脆弱映射，能力配置跟着条目走；
 * - 逐模型能力抽屉：token 上下限（1m/200k 简写）+ tri-state（工具/思考可关/思考耗预算）
 *   + 单模型重探（probe modelIds 过滤）+ 复制此模型；列表 chip 与表单条目共用；
 * - 「⟳ 拉取」：服务端 /api/providers/fetch-models 拉上游 /models，勾选并入（内置表自动带初值）；
 * - 复制配置 / 粘贴导入：polaris-provider-export / polaris-model-export 信封，不含 Key；
 * - 查看 API Key：服务端会话门禁 + PLITE_ALLOW_REVEAL 开关 + 审计；前端 10s 自动隐藏；
 * - P0：保存/启停/删除失败不再静默——表单内联错误条 + 列表页错误提示。
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { SlotHostApi } from '@sdk';
import type { ProviderConfig, ModelInfo, PublicProvider } from './index';
import { mergeModelCaps, type ProbeFacts } from './detect';
import { parseTokenCount, formatTokenCount } from './tokens';

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

const EMPTY_CAPS: ModelInfo['capabilities'] = {
  maxInputTokens: 0,
  maxOutputTokens: 0,
  effort: null,
  vision: false,
};

const EFFORT_LABEL: Record<string, string> = {
  minimal: 'minimal', low: 'low', medium: 'medium', high: 'high',
};

/** 删除确认回退计时 */
const ARM_TIMEOUT_MS = 3000;
/** 明文 Key 显示后自动隐藏秒数 */
const REVEAL_HIDE_SECONDS = 10;
/** 列表 chips 折叠阈值：超过则只显示前 N 个 + 「+N 更多」 */
const CHIP_LIMIT = 6;

/** 导出信封（跨实例复制/导入的载体；刻意不含 apiKey——Key 属于部署而非配置） */
const EXPORT_TYPE = 'polaris-provider-export';
const MODEL_EXPORT_TYPE = 'polaris-model-export';
const EXPORT_VERSION = 1;

/**
 * 总线 dispatch 的 res.ok 只代表「投递成功」；业务成败在 handler 返回值里
 * （handler catch 后返回 {ok:false, error}，总线包成 {ok:true, data:{ok:false,...}}）。
 * 不解包的话，保存失败也会被当成成功——P0「失败静默」的真正根因。
 */
function unwrapBus<T>(res: { ok: boolean; data?: T; error?: { message?: string } }): { ok: boolean; data?: T; error?: { message?: string } } {
  if (res.ok && res.data && typeof res.data === 'object' && 'ok' in (res.data as Record<string, unknown>)) {
    const d = res.data as unknown as { ok: boolean; error?: string | { message?: string } };
    if (!d.ok) {
      const msg = typeof d.error === 'string' ? d.error : d.error?.message;
      return { ok: false, error: { message: msg ?? '未知错误' } };
    }
  }
  return res;
}

/** 浮层 portal 目标：宿主 overlay root（cap.ui.overlay 实现，fixed 锚定视口）。
 *  root 未就绪时降级为原位渲染（行为退回内容锚定，不丢功能）。 */
function portalInto(node: ReactNode): ReactNode {
  const root = api?.overlay.root() ?? document.getElementById('plite-overlay-root');
  return root ? createPortal(node, root) : node;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function providerExportPayload(c: { name: string; baseURL: string; activeModel?: string; models: ModelInfo[] }) {
  return {
    type: EXPORT_TYPE,
    version: EXPORT_VERSION,
    provider: {
      name: c.name,
      baseURL: c.baseURL,
      activeModel: c.activeModel ?? '',
      models: c.models.map((m) => ({ id: m.id, capabilities: m.capabilities })),
    },
  };
}

function modelExportPayload(m: ModelInfo) {
  return { type: MODEL_EXPORT_TYPE, version: EXPORT_VERSION, model: { id: m.id, capabilities: m.capabilities } };
}

/** 导入能力规范化：token 接受 "64k"/数字写法；保留合法的来源标记，否则标 manual（探测不覆盖） */
function normalizeImportedCaps(caps: unknown): ModelInfo['capabilities'] {
  const c = (caps ?? {}) as Record<string, unknown>;
  const detected = c.detected;
  const validDetected = ['builtin', 'catalog', 'probe', 'reveal', 'manual'];
  return {
    maxInputTokens: parseTokenCount(c.maxInputTokens) ?? 0,
    maxOutputTokens: parseTokenCount(c.maxOutputTokens) ?? 0,
    effort: (typeof c.effort === 'string' && EFFORT_LABEL[c.effort] !== undefined ? c.effort : null) as ModelInfo['capabilities']['effort'],
    vision: c.vision === true,
    ...(typeof c.tools === 'boolean' ? { tools: c.tools } : {}),
    ...(typeof c.canDisableThinking === 'boolean' ? { canDisableThinking: c.canDisableThinking } : {}),
    ...(typeof c.reasoningEatsBudget === 'boolean' ? { reasoningEatsBudget: c.reasoningEatsBudget } : {}),
    ...(typeof detected === 'string' && validDetected.includes(detected) ? { detected: detected as ModelInfo['capabilities']['detected'] } : { detected: 'manual' }),
    ...(typeof c.detectedAt === 'number' ? { detectedAt: c.detectedAt } : {}),
  };
}

interface ImportedProvider {
  name: string;
  baseURL: string;
  activeModel: string;
  models: ModelInfo[];
}

/** 解析导入 JSON（provider / 单模型信封）；失败抛错，由调用方展示 */
function parseImportPayload(text: string): ImportedProvider {
  const data = JSON.parse(text) as Record<string, unknown>;
  if (data.type === MODEL_EXPORT_TYPE) {
    const m = (data.model ?? {}) as Record<string, unknown>;
    const id = String(m.id ?? '').trim();
    if (!id) throw new Error('model.id 缺失');
    return { name: id, baseURL: '', activeModel: id, models: [{ id, capabilities: normalizeImportedCaps(m.capabilities) }] };
  }
  if (data.type === EXPORT_TYPE) {
    const p = (data.provider ?? {}) as Record<string, unknown>;
    const rawModels = Array.isArray(p.models) ? p.models : [];
    const models = rawModels
      .map((raw) => {
        const m = (raw ?? {}) as Record<string, unknown>;
        const id = String(m.id ?? '').trim();
        return id ? { id, capabilities: normalizeImportedCaps(m.capabilities) } : null;
      })
      .filter((m): m is ModelInfo => m !== null);
    return {
      name: String(p.name ?? '').trim(),
      baseURL: String(p.baseURL ?? '').trim().replace(/\/+$/, ''),
      activeModel: String(p.activeModel ?? '').trim(),
      models,
    };
  }
  throw new Error(`不认识的信封类型：${String(data.type ?? '（无）')}`);
}

export function ModelAdminPanel() {
  const [configs, setConfigs] = useState<PublicProvider[]>([]);
  const [editing, setEditing] = useState<ProviderConfig | null>(null);
  /** 编辑态展示用的既有 key 打码值（明文永不下发到前端） */
  const [editingKeyMasked, setEditingKeyMasked] = useState('');
  const [isNew, setIsNew] = useState(false);
  /** P0：保存/启停/删除失败的可见化（此前 dispatch 结果被丢弃，失败表现为静默无效果） */
  const [formError, setFormError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; text: string; busy?: boolean }>>({});
  const [detectResult, setDetectResult] = useState<Record<string, { ok: boolean; reports: DetectReportView[]; catalogNotes: string[]; note?: string } | { ok: false; error: string } | undefined>>({});
  const [detectBusy, setDetectBusy] = useState<Record<string, boolean>>({});
  const [armDelete, setArmDelete] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState<string | null>(null);
  /** 列表 chips 折叠：模型多的供应商默认只显示前 CHIP_LIMIT 个（+N 展开），避免小字墙 */
  const [expandedChips, setExpandedChips] = useState<Record<string, boolean>>({});
  /** 轻提示（自动消失） */
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<number | null>(null);

  // ---- 独立条目编辑器状态 ----
  const [addModelText, setAddModelText] = useState('');

  // ---- 拉取模型列表 ----
  const [fetchState, setFetchState] = useState<{
    busy: boolean; open: boolean; ids: string[] | null; error: string | null; query: string;
  } | null>(null);

  // ---- 逐模型能力抽屉（列表 chip 与表单条目共用） ----
  const [chip, setChip] = useState<{ ctx: 'form' | 'list'; providerId: string; modelId: string } | null>(null);
  const [chipBusy, setChipBusy] = useState(false);

  // ---- 粘贴导入 ----
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [pastePreview, setPastePreview] = useState<{ provider: ImportedProvider; issues: { cls: 'warn' | 'bad' | 'ok'; text: string }[] } | null>(null);
  const [pasteError, setPasteError] = useState<string | null>(null);

  // ---- 明文 Key 查看 ----
  const [keyView, setKeyView] = useState<{ provider: PublicProvider; key: string | null; plain: boolean; left: number } | null>(null);
  const revealTimer = useRef<number | null>(null);

  const showNotice = (text: string): void => {
    setNotice(text);
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 2400);
  };

  const refresh = async (): Promise<void> => {
    if (!api) return;
    const res = await api.dispatch<{ configs: PublicProvider[] }>({ target: 'cap.model.admin', action: 'list' });
    if (res.ok && res.data) setConfigs(res.data.configs);
  };

  useEffect(() => {
    void refresh();
    return () => {
      if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
      if (revealTimer.current !== null) window.clearInterval(revealTimer.current);
    };
  }, []);

  // 明文 Key 倒计时：plain 态每秒递减，归零自动隐藏
  useEffect(() => {
    if (!keyView?.plain) return;
    revealTimer.current = window.setInterval(() => {
      setKeyView((cur) => {
        if (!cur?.plain) return cur;
        if (cur.left <= 1) return { ...cur, plain: false, left: 0 };
        return { ...cur, left: cur.left - 1 };
      });
    }, 1000);
    return () => {
      if (revealTimer.current !== null) window.clearInterval(revealTimer.current);
      revealTimer.current = null;
    };
  }, [keyView?.plain]);

  const startNew = (): void => {
    setIsNew(true);
    setEditing({ ...EMPTY_FORM, id: `prov-${Date.now().toString(36)}` });
    setEditingKeyMasked('');
    setAddModelText('');
    setFormError(null);
  };

  const startEdit = (c: PublicProvider): void => {
    setIsNew(false);
    // apiKey 留空 = 不修改；掩码值只用于提示，不写进输入框
    setEditing({ ...c, apiKey: '' });
    setEditingKeyMasked(c.keyMasked);
    setAddModelText('');
    setFormError(null);
  };

  /** P0：保存结果必须可见——失败留在表单并展示错误条，不再静默关闭 */
  const saveForm = async (): Promise<void> => {
    if (!api || !editing) return;
    const payload: ProviderConfig = { ...editing };
    if (!payload.activeModel && payload.models.length) payload.activeModel = payload.models[0].id;
    const res = unwrapBus(await api.dispatch<{ configs: PublicProvider[] }>({ target: 'cap.model.admin', action: 'save', payload: { config: payload } }));
    if (!res.ok) {
      setFormError(res.error?.message ?? '保存失败（未知错误）');
      return;
    }
    setEditing(null);
    setFormError(null);
    showNotice('已保存');
    await refresh();
  };

  /** 两段式删除：第一击 arm，3s 内再击执行；超时回退 */
  const removeWithConfirm = async (id: string): Promise<void> => {
    if (!api) return;
    if (armDelete !== id) {
      setArmDelete(id);
      setTimeout(() => setArmDelete((cur) => (cur === id ? null : cur)), ARM_TIMEOUT_MS);
      return;
    }
    setArmDelete(null);
    setMoreOpen(null);
    const res = unwrapBus(await api.dispatch({ target: 'cap.model.admin', action: 'remove', payload: { id } }));
    if (!res.ok) setListError(res.error?.message ?? '删除失败');
    await refresh();
  };

  const setDefault = async (id: string): Promise<void> => {
    if (!api) return;
    setMoreOpen(null);
    const res = unwrapBus(await api.dispatch({ target: 'cap.model.admin', action: 'setDefault', payload: { id } }));
    if (!res.ok) setListError(res.error?.message ?? '设置默认失败');
    await refresh();
  };

  const toggleEnabled = async (c: PublicProvider): Promise<void> => {
    if (!api) return;
    const res = unwrapBus(await api.dispatch({
      target: 'cap.model.admin',
      action: 'save',
      payload: { config: { ...c, enabled: !c.enabled } },
    }));
    if (!res.ok) setListError(`启停失败：${res.error?.message ?? '未知错误'}`);
    await refresh();
  };

  // ================= 独立条目编辑器 =================

  /** 添加条目：同供应商内 id 唯一；逗号不再是分隔符（含逗号的 id 也合法） */
  const addModelFromInput = (): void => {
    if (!editing) return;
    const id = addModelText.trim();
    if (!id) return;
    if (editing.models.some((m) => m.id === id)) {
      showNotice('该模型 id 已存在（同一供应商内需唯一）');
      return;
    }
    setEditing({
      ...editing,
      models: [...editing.models, { id, capabilities: { ...EMPTY_CAPS } }],
      activeModel: editing.activeModel || id,
    });
    setAddModelText('');
  };

  const removeModelEntry = (modelId: string): void => {
    if (!editing) return;
    const models = editing.models.filter((m) => m.id !== modelId);
    const activeModel = editing.activeModel === modelId ? (models[0]?.id ?? '') : editing.activeModel;
    setEditing({ ...editing, models, activeModel });
  };

  /** 拉取模型列表：已存供应商按 id 用服务端存储 key；新建中用表单 key（与 save 同信任边界） */
  const openFetchModels = async (): Promise<void> => {
    if (!api || !editing) return;
    if (!editing.baseURL.trim()) {
      setFormError('请先填写 Base URL 再拉取模型列表');
      return;
    }
    setFormError(null);
    setFetchState({ busy: true, open: false, ids: null, error: null, query: '' });
    const res = unwrapBus(await api.dispatch<{ ids: string[] | null; count: number }>({
      target: 'cap.model.admin',
      action: 'fetchModels',
      payload: {
        ...(isNew ? {} : { id: editing.id }),
        baseURL: editing.baseURL.trim().replace(/\/+$/, ''),
        apiKey: editing.apiKey.trim() || undefined,
      },
    }));
    if (!res.ok || !res.data) {
      setFetchState(null);
      setFormError(`拉取失败：${res.error?.message ?? '未知错误'}`);
      return;
    }
    const ids = res.data.ids ?? [];
    if (!ids.length) {
      setFetchState(null);
      setFormError('上游 /models 未返回模型（可能不支持该端点）——请手动添加模型条目');
      return;
    }
    setFetchState({ busy: false, open: true, ids, error: null, query: '' });
  };

  /** 把勾选的模型并入条目列表：命中内置知识表的自动带初值（detected=builtin） */
  const addFetchedModels = (ids: string[]): void => {
    if (!editing) return;
    const existing = new Set(editing.models.map((m) => m.id));
    const facts: ProbeFacts = { catalogIds: ids, catalogEntries: null, notes: [], probes: {} };
    const added = ids
      .filter((id) => !existing.has(id))
      .map((id) => mergeModelCaps({ id, capabilities: { ...EMPTY_CAPS } }, facts).model);
    setEditing({ ...editing, models: [...editing.models, ...added] });
    setFetchState(null);
    showNotice(`已加入 ${added.length} 个模型（内置表初值自动回填）`);
  };

  // ================= 逐模型能力抽屉 =================

  interface ChipTarget { model: ModelInfo; provider?: PublicProvider; existsOnServer: boolean }
  const resolveChip = (): ChipTarget | null => {
    if (!chip) return null;
    if (chip.ctx === 'form') {
      if (!editing) return null;
      const model = editing.models.find((m) => m.id === chip.modelId);
      return model ? { model, existsOnServer: configs.some((c) => c.id === chip.providerId) } : null;
    }
    const provider = configs.find((c) => c.id === chip.providerId);
    const model = provider?.models.find((m) => m.id === chip.modelId);
    return model ? { model, provider, existsOnServer: true } : null;
  };
  const chipTarget = resolveChip();

  /** 抽屉保存：form 上下文写回 editing.models；list 上下文走 save（key 留空保持原值） */
  const saveChip = async (model: ModelInfo): Promise<void> => {
    if (!chip) return;
    if (chip.ctx === 'form') {
      if (!editing) return;
      setEditing({ ...editing, models: editing.models.map((m) => (m.id === chip.modelId ? model : m)) });
      setChip(null);
      showNotice('模型能力已更新（来源：人工）');
      return;
    }
    const provider = configs.find((c) => c.id === chip.providerId);
    if (!provider || !api) return;
    const res = unwrapBus(await api.dispatch({
      target: 'cap.model.admin',
      action: 'save',
      payload: { config: { ...provider, models: provider.models.map((m) => (m.id === chip.modelId ? model : m)) } },
    }));
    if (!res.ok) {
      setListError(`保存失败：${res.error?.message ?? '未知错误'}`);
      return;
    }
    setChip(null);
    showNotice('模型能力已保存（来源：人工）');
    await refresh();
  };

  /** 单模型重探：服务端 modelIds 过滤探针 → 剥掉 manual 标记后前端合并（用户显式要求覆盖） */
  const reprobeChip = async (model: ModelInfo): Promise<void> => {
    if (!api || !chip) return;
    setChipBusy(true);
    try {
      const res = unwrapBus(await api.dispatch<{ facts: ProbeFacts }>({
        target: 'cap.model.admin',
        action: 'probeModels',
        payload: { id: chip.providerId, modelIds: [chip.modelId] },
      }));
      if (!res.ok || !res.data) {
        showNotice(`重探失败：${res.error?.message ?? '未知错误'}`);
        return;
      }
      const stripped: ModelInfo = {
        id: model.id,
        capabilities: { ...model.capabilities, detected: undefined, detectedAt: undefined },
      };
      const { model: merged } = mergeModelCaps(stripped, res.data.facts);
      await saveChip(merged);
    } finally {
      setChipBusy(false);
    }
  };

  // ================= 抽屉内部的受控值 =================

  const TriControl = ({ label, value, onChange }: { label: string; value: boolean | null | undefined; onChange: (v: boolean | null) => void }) => (
    <>
      <span>{label}</span>
      <span className="ma-tri" role="group">
        <button type="button" className={value == null ? 'on' : ''} onClick={() => onChange(null)}>未知</button>
        <button type="button" className={value === true ? 'on-t' : ''} onClick={() => onChange(true)}>支持</button>
        <button type="button" className={value === false ? 'on-f' : ''} onClick={() => onChange(false)}>不支持</button>
      </span>
    </>
  );

  function ChipDrawer({ target }: { target: ChipTarget }) {
    const [draft, setDraft] = useState<ModelInfo>(() => ({
      id: target.model.id,
      capabilities: { ...target.model.capabilities },
    }));
    /** token 输入框原始字面量：用原始数值初始化（格式化会舍入，131072→131.1k 再解析=131100 悄悄漂移）；用户仍可输入 1m/200k 简写 */
    const [tokenText, setTokenText] = useState<{ in: string; out: string }>(() => ({
      in: target.model.capabilities.maxInputTokens ? String(target.model.capabilities.maxInputTokens) : '',
      out: target.model.capabilities.maxOutputTokens ? String(target.model.capabilities.maxOutputTokens) : '',
    }));
    const parsedIn = parseTokenCount(tokenText.in);
    const parsedOut = parseTokenCount(tokenText.out);
    const invalid = tokenText.in.trim() !== '' && parsedIn === null
      ? '输入 tokens 写法非法（支持 128000 / 128k / 1m）'
      : tokenText.out.trim() !== '' && parsedOut === null
        ? '输出 tokens 写法非法（支持 64000 / 64k）'
        : parsedIn !== null && parsedOut !== null && parsedOut > 0 && parsedIn > 0 && parsedOut > parsedIn
          ? '输出上限大于输入上限，疑似填反'
          : null;
    const dirty = JSON.stringify(draft.capabilities) !== JSON.stringify(target.model.capabilities);

    return (
      <div className="ma-overlay sheet" role="dialog" aria-label={`编辑模型能力 ${target.model.id}`} onClick={(e) => e.stopPropagation()}>
        <div className="ma-modal">
          <div className="ma-mhead">
            <code>{target.model.id}</code>
            {target.model.capabilities.detected && (
              <span className={`ma-badge ${target.model.capabilities.detected === 'manual' ? '' : 'off'}`}>
                {{ manual: '人工', probe: '实测', builtin: '内置表', catalog: '目录', reveal: '网关' }[target.model.capabilities.detected] ?? target.model.capabilities.detected}
              </span>
            )}
            <button className="ma-x" aria-label="关闭" onClick={() => setChip(null)}>×</button>
          </div>
          <div className="ma-mbody">
            <div className="ma-cap-grid">
              <span>输入 tokens</span>
              <input
                value={tokenText.in}
                onChange={(e) => {
                  const raw = e.target.value;
                  setTokenText((t) => ({ ...t, in: raw }));
                  const parsed = parseTokenCount(raw);
                  if (parsed !== null) setDraft((d) => ({ ...d, capabilities: { ...d.capabilities, maxInputTokens: parsed } }));
                }}
                placeholder="0=未知，可写 1m / 200k"
              />
              <span>输出 tokens</span>
              <input
                value={tokenText.out}
                onChange={(e) => {
                  const raw = e.target.value;
                  setTokenText((t) => ({ ...t, out: raw }));
                  const parsed = parseTokenCount(raw);
                  if (parsed !== null) setDraft((d) => ({ ...d, capabilities: { ...d.capabilities, maxOutputTokens: parsed } }));
                }}
                placeholder="0=默认，可写 64k"
              />
              <span>图片输入</span>
              <label className="ma-check ma-cap-inline">
                <input type="checkbox" checked={!!draft.capabilities.vision} onChange={(e) => setDraft((d) => ({ ...d, capabilities: { ...d.capabilities, vision: e.target.checked } }))} />
                支持
              </label>
              <span>思考等级</span>
              <select
                value={draft.capabilities.effort ?? ''}
                onChange={(e) => setDraft((d) => ({ ...d, capabilities: { ...d.capabilities, effort: (e.target.value || null) as ModelInfo['capabilities']['effort'] } }))}
              >
                <option value="">不支持/未知</option>
                <option value="minimal">minimal</option>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
              </select>
              <TriControl label="工具调用" value={draft.capabilities.tools} onChange={(v) => setDraft((d) => ({ ...d, capabilities: { ...d.capabilities, tools: v } }))} />
              <TriControl label="思考可关" value={draft.capabilities.canDisableThinking} onChange={(v) => setDraft((d) => ({ ...d, capabilities: { ...d.capabilities, canDisableThinking: v } }))} />
              <TriControl label="思考耗预算" value={draft.capabilities.reasoningEatsBudget} onChange={(v) => setDraft((d) => ({ ...d, capabilities: { ...d.capabilities, reasoningEatsBudget: v } }))} />
            </div>
            <div className={`ma-val-line ${invalid ? 'bad' : 'dim'}`}>
              {invalid ?? `将写入：输入 ${formatTokenCount(parsedIn ?? 0)} / 输出 ${formatTokenCount(parsedOut ?? 0)}。`}
            </div>
            <div className="ma-chip-note">
              {target.model.capabilities.detectedAt ? `上次识别：${new Date(target.model.capabilities.detectedAt).toLocaleString()} · ` : ''}
              保存后来源标「人工」，人工值不会被识别覆盖。
            </div>
          </div>
          <div className="ma-mfoot">
            {target.existsOnServer && (
              <button
                className="ma-btn small"
                aria-busy={chipBusy}
                title="只重探此模型（probe modelIds 过滤），结论合并后写回"
                onClick={() => void reprobeChip(target.model)}
              >
                {chipBusy ? '重探中…' : '⟳ 重探'}
              </button>
            )}
            <button
              className="ma-btn small"
              onClick={async () => {
                const ok = await copyText(JSON.stringify(modelExportPayload(target.model), null, 2));
                showNotice(ok ? '已复制此模型 JSON（不含 Key）' : '复制失败：请检查浏览器剪贴板权限');
              }}
            >
              复制此模型
            </button>
            <span className="ma-mfoot-sp" />
            <button className="ma-btn small" onClick={() => setChip(null)}>取消</button>
            <button
              className="ma-btn small primary"
              disabled={!!invalid || !dirty}
              onClick={() => {
                const capabilities: ModelInfo['capabilities'] = {
                  ...draft.capabilities,
                  maxInputTokens: parsedIn ?? draft.capabilities.maxInputTokens,
                  maxOutputTokens: parsedOut ?? draft.capabilities.maxOutputTokens,
                  detected: 'manual',
                  detectedAt: Date.now(),
                };
                void saveChip({ id: draft.id, capabilities });
              }}
            >
              保存
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ================= 拉取模型弹窗 =================

  function FetchModal() {
    if (!fetchState?.open || fetchState.ids === null) return null;
    const q = fetchState.query.trim().toLowerCase();
    const hits = fetchState.ids.filter((id) => id.toLowerCase().includes(q));
    return (
      <div className="ma-overlay" role="dialog" aria-label="拉取模型列表" onClick={(e) => e.stopPropagation()}>
        <div className="ma-modal">
          <div className="ma-mhead">
            <span>拉取模型列表</span>
            <span className="ma-msub">{fetchState.ids.length} 个模型 · 勾选并入</span>
            <button className="ma-x" aria-label="关闭" onClick={() => setFetchState(null)}>×</button>
          </div>
          <div className="ma-mbody">
            <input
              className="ma-search"
              value={fetchState.query}
              onChange={(e) => setFetchState((s) => (s ? { ...s, query: e.target.value } : s))}
              placeholder="搜索模型 id…"
            />
            <div className="ma-cat-list">
              {hits.length === 0 && <div className="ma-cat-empty">无匹配模型</div>}
              {hits.map((id) => {
                const already = editing?.models.some((m) => m.id === id) ?? false;
                return (
                  <label key={id} className={`ma-cat-item ${already ? 'off' : ''}`}>
                    <input type="checkbox" value={id} disabled={already} />
                    <code title={id}>{id}</code>
                    {already && <em>已在列表</em>}
                  </label>
                );
              })}
            </div>
          </div>
          <div className="ma-mfoot">
            <button className="ma-btn small" onClick={() => setFetchState(null)}>取消</button>
            <span className="ma-mfoot-sp" />
            <button
              className="ma-btn small primary"
              onClick={(e) => {
                const root = (e.currentTarget.closest('.ma-modal') as HTMLElement);
                const picked = [...root.querySelectorAll('.ma-cat-item input:checked')].map((i) => (i as HTMLInputElement).value);
                if (!picked.length) return;
                addFetchedModels(picked);
              }}
            >
              加入所选
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ================= 粘贴导入弹窗 =================

  const parsePaste = (): void => {
    setPasteError(null);
    setPastePreview(null);
    try {
      const provider = parseImportPayload(pasteText);
      const issues: { cls: 'warn' | 'bad' | 'ok'; text: string }[] = [];
      if (!provider.baseURL) issues.push({ cls: 'bad', text: '缺 Base URL：导入后需补填才能保存' });
      issues.push({ cls: 'warn', text: '导出不含 API Key：导入后需补填 Key' });
      issues.push({ cls: 'warn', text: 'Base URL 白名单在保存时由服务端校验（不在白名单会保存失败并提示）' });
      issues.push({ cls: 'ok', text: `解析成功：${provider.models.length} 个模型 · 能力配置随行` });
      setPastePreview({ provider, issues });
    } catch (e) {
      setPasteError(e instanceof Error ? e.message : String(e));
    }
  };

  const importToForm = (): void => {
    if (!pastePreview) return;
    const p = pastePreview.provider;
    setIsNew(true);
    setEditing({
      id: `prov-${Date.now().toString(36)}`, // 重新生成 id，避免跨实例冲突
      name: p.name,
      baseURL: p.baseURL,
      apiKey: '',
      models: p.models,
      activeModel: p.models.some((m) => m.id === p.activeModel) ? p.activeModel : (p.models[0]?.id ?? ''),
      enabled: true,
      isDefault: false,
    });
    setEditingKeyMasked('');
    setAddModelText('');
    setFormError(null);
    setPasteOpen(false);
    setPastePreview(null);
    setPasteText('');
    showNotice('已导入到新增表单，请补 API Key 后保存');
  };

  // ================= 明文 Key 查看 =================

  const openKeyView = async (c: PublicProvider): Promise<void> => {
    if (!api) return;
    setMoreOpen(null);
    const res = unwrapBus(await api.dispatch<{ key: string }>({ target: 'cap.model.admin', action: 'revealKey', payload: { id: c.id } }));
    if (!res.ok || !res.data) {
      setListError(`查看 Key 失败：${res.error?.message ?? '未知错误'}`);
      return;
    }
    setKeyView({ provider: c, key: res.data.key, plain: false, left: REVEAL_HIDE_SECONDS });
  };

  // ================= 能力徽标 / 识别 / 测试 =================

  /** 能力徽标（列表页速览）：{label, cls} 对，cls 映射语义配色 */
  const capBadges = (m: ModelInfo): { label: string; cls: string }[] => {
    const out: { label: string; cls: string }[] = [];
    if (m.capabilities.detected === 'manual') out.push({ label: '人工', cls: 't-manual' });
    else if (m.capabilities.detected === 'probe') out.push({ label: '实测', cls: 't-probe' });
    else if (m.capabilities.detected === 'reveal') out.push({ label: '网关', cls: 't-probe' });
    else if (m.capabilities.detected === 'catalog') out.push({ label: '目录', cls: 't-builtin' });
    else if (m.capabilities.detected === 'builtin') out.push({ label: '内置表', cls: 't-builtin' });
    if (m.capabilities.vision) out.push({ label: '图', cls: 't-vision' });
    if (m.capabilities.tools === true) out.push({ label: '工', cls: 't-vision' });
    if (m.capabilities.effort) out.push({ label: `思${EFFORT_LABEL[m.capabilities.effort] ?? m.capabilities.effort}`, cls: 't-effort' });
    if (m.capabilities.reasoningEatsBudget) out.push({ label: '思耗', cls: 't-effort' });
    if (m.capabilities.maxInputTokens > 0) out.push({ label: formatTokenCount(m.capabilities.maxInputTokens), cls: 't-ctx' });
    return out;
  };

  const detectCapabilities = async (id: string, deep: boolean = false): Promise<void> => {
    if (!api || detectBusy[id]) return;
    setMoreOpen(null);
    setDetectBusy((s) => ({ ...s, [id]: true }));
    setDetectResult((s) => ({ ...s, [id]: undefined }));
    try {
      const res = await api.dispatch<{
        reports?: { modelId: string; notes: string[] }[];
        catalogNotes?: string[];
        configs?: PublicProvider[];
      }>({ target: 'cap.model.admin', action: 'probe', payload: { id, deep } });
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
  const testConnectivity = async (c: PublicProvider): Promise<void> => {
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

  const copyProviderConfig = async (c: PublicProvider): Promise<void> => {
    setMoreOpen(null);
    const ok = await copyText(JSON.stringify(providerExportPayload(c), null, 2));
    showNotice(ok ? '已复制配置 JSON（不含 Key · 粘贴到其他实例可导入）' : '复制失败：请检查浏览器剪贴板权限');
  };

  // ================= 表单视图 =================

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
          <label>模型（独立条目：单独添加 / 删除 / 编辑能力 / 设默认调用）</label>
          <div className="ma-mlist" data-testid="ma-mlist">
            {editing.models.length === 0 && (
              <div className="ma-mlist-empty">暂无模型 — 手动添加或 ⟳ 拉取</div>
            )}
            {editing.models.map((m) => (
              <div key={m.id} className="ma-mrow">
                <input
                  type="radio"
                  name="ma-active-model"
                  title="设为默认调用模型"
                  checked={editing.activeModel === m.id}
                  onChange={() => setEditing({ ...editing, activeModel: m.id })}
                />
                <code title={m.id}>{m.id}</code>
                <span className="ma-mbadges">
                  {capBadges(m).map((b) => <em key={b.cls + b.label} className={b.cls}>{b.label}</em>)}
                </span>
                <span className="ma-mops">
                  <button
                    className="ma-btn"
                    data-testid={`ma-entry-edit-${m.id}`}
                    onClick={() => { setChip({ ctx: 'form', providerId: editing.id, modelId: m.id }); }}
                  >
                    能力
                  </button>
                  <button className="ma-btn" aria-label={`移除模型 ${m.id}`} onClick={() => removeModelEntry(m.id)}>×</button>
                </span>
              </div>
            ))}
          </div>
          <div className="ma-fetchrow">
            <input
              value={addModelText}
              onChange={(e) => setAddModelText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addModelFromInput(); } }}
              placeholder="输入模型 id，回车或点「添加」"
            />
            <button className="ma-btn" onClick={addModelFromInput}>添加</button>
            <button className="ma-btn" aria-busy={fetchState?.busy ?? false} disabled={!editing.baseURL} onClick={() => void openFetchModels()}>
              {fetchState?.busy ? '拉取中…' : '⟳ 拉取'}
            </button>
          </div>
          <span className="ma-hint" style={{ marginTop: -2 }}>
            拉取命中内置知识表的模型自动带初值；点条目上的「能力」进入逐模型编辑。
          </span>
          {formError && (
            <div className="ma-error" data-testid="ma-form-error">
              <b>保存/拉取失败</b>
              <span>{formError}</span>
            </div>
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
          <button className="ma-btn primary" onClick={() => void saveForm()} disabled={!editing.name || !editing.baseURL}>保存</button>
          <button className="ma-btn" onClick={() => { setEditing(null); setFormError(null); }}>取消</button>
        </div>
        {portalInto(chipTarget ? <ChipDrawer key={`${chip?.ctx}:${chip?.providerId}:${chip?.modelId}`} target={chipTarget} /> : null)}
        {portalInto(<FetchModal />)}
        {portalInto(notice ? <div className="ma-toast">{notice}</div> : null)}
      </div>
    );
  }

  // ================= 列表视图 =================

  return (
    <div className="cap-panel model-admin" data-testid="model-admin" onClick={() => moreOpen && setMoreOpen(null)}>
      <h3>模型供应商</h3>
      {configs.length === 0 && (
        <div className="ma-empty">
          <span className="ma-empty-mark" aria-hidden="true">
            <svg viewBox="0 0 32 32" fill="none">
              <path d="m16 4 11 6-11 6L5 10l11-6ZM5 16l11 6 11-6M5 22l11 6 11-6" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
            </svg>
          </span>
          <strong>尚未接入模型</strong>
          <p>添加一个 OpenAI 兼容供应商，<br />开始第一次对话。</p>
        </div>
      )}
      {listError && (
        <div className="ma-error" data-testid="ma-list-error">
          <b>操作失败</b>
          <span>{listError}</span>
        </div>
      )}
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
                  <input type="checkbox" checked={c.enabled} onChange={() => void toggleEnabled(c)} />
                  <span />
                </label>
              </div>
              <div className="ma-meta" title={c.baseURL}>{c.baseURL}</div>
              <div className="ma-meta">
                Key: {c.hasKey ? <code>{c.keyMasked}</code> : <em>未配置</em>}
              </div>
              {c.models.length > 0 && (() => {
                const expanded = expandedChips[c.id] === true;
                const shown = expanded ? c.models : c.models.slice(0, CHIP_LIMIT);
                const hidden = c.models.length - shown.length;
                return (
                  <div className="ma-models" data-testid={`ma-models-${c.id}`}>
                    {shown.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        className="ma-model-chip"
                        data-testid={`ma-chip-${m.id}`}
                        title={`输入 ${formatTokenCount(m.capabilities.maxInputTokens)} / 输出 ${formatTokenCount(m.capabilities.maxOutputTokens)}${m.capabilities.detectedAt ? ` / 识别于 ${new Date(m.capabilities.detectedAt).toLocaleString()}` : ''} · 点击编辑模型能力`}
                        onClick={(e) => { e.stopPropagation(); setChip({ ctx: 'list', providerId: c.id, modelId: m.id }); }}
                      >
                        <code>{m.id}</code>
                        {capBadges(m).map((b) => <em key={b.cls + b.label} className={b.cls}>{b.label}</em>)}
                      </button>
                    ))}
                    {hidden > 0 && (
                      <button
                        type="button"
                        className="ma-model-chip more"
                        onClick={(e) => { e.stopPropagation(); setExpandedChips((s) => ({ ...s, [c.id]: true })); }}
                      >
                        <code>+{hidden} 更多</code>
                      </button>
                    )}
                    {expanded && c.models.length > CHIP_LIMIT && (
                      <button
                        type="button"
                        className="ma-model-chip more"
                        onClick={(e) => { e.stopPropagation(); setExpandedChips((s) => ({ ...s, [c.id]: false })); }}
                      >
                        <code>收起</code>
                      </button>
                    )}
                  </div>
                );
              })()}
              <div className={`ma-test-line ${testResult[c.id]?.busy ? 'busy' : testResult[c.id]?.ok ? 'ok' : testResult[c.id] ? 'fail' : ''}`}>
                {testResult[c.id]?.text ?? ''}
              </div>
              <div className="ma-row ma-ops">
                <button className="ma-btn small" onClick={() => startEdit(c)}>编辑</button>
                <button className="ma-btn small" onClick={() => void testConnectivity(c)}>测试</button>
                <div className="ma-more">
                  <button
                    aria-haspopup="menu"
                    aria-expanded={moreOpen === c.id}
                    onClick={(e) => { e.stopPropagation(); setMoreOpen(moreOpen === c.id ? null : c.id); }}
                  >
                    更多 <span className="ma-chevron" aria-hidden="true" />
                  </button>
                  {moreOpen === c.id && (
                    <div className="ma-more-menu" role="menu">
                      <button role="menuitem" onClick={(e) => { e.stopPropagation(); startEdit(c); }}>编辑</button>
                      <button role="menuitem" onClick={(e) => { e.stopPropagation(); void copyProviderConfig(c); }}>
                        复制配置（不含 Key）
                      </button>
                      <button role="menuitem" disabled={!c.hasKey} onClick={(e) => { e.stopPropagation(); void openKeyView(c); }}>
                        查看 API Key
                      </button>
                      <button
                        role="menuitem"
                        aria-busy={!!detectBusy[c.id]}
                        disabled={!c.hasKey}
                        title="自动识别各模型能力（目录初值 + 网关限值揭示 + 真实链路探测，耗时数秒）"
                        onClick={(e) => { e.stopPropagation(); void detectCapabilities(c.id); }}
                      >
                        {detectBusy[c.id] ? '识别中…' : '识别模型能力'}
                      </button>
                      <button
                        role="menuitem"
                        aria-busy={!!detectBusy[c.id]}
                        disabled={!c.hasKey}
                        title="深度识别：验证思考档位是否真被网关执行（行为差分，约 8k token/模型）"
                        onClick={(e) => { e.stopPropagation(); void detectCapabilities(c.id, true); }}
                      >
                        {detectBusy[c.id] ? '识别中…' : '深度识别（思考差分）'}
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
                    {dr.ok ? '识别完成' : '识别无结论'}
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
      <div className="ma-importrow">
        <button className="ma-btn" data-testid="ma-paste-import" onClick={() => { setPasteOpen(true); setPasteError(null); setPastePreview(null); }}>
          粘贴导入
        </button>
        <span className="ma-hint" style={{ margin: 0 }}>粘贴其他实例复制的配置 JSON</span>
      </div>
      <button className="ma-btn primary wide" onClick={startNew}>新增供应商</button>
      <p className="ma-hint">配置保存后广播 model-config-changed，引擎插件监听后免刷新热更新；点模型 chip 或表单条目「能力」可逐模型编辑；「识别模型能力」走真实链路探测（消耗少量 token），结论自动落库。</p>

      {/* ---- 浮层：逐模型抽屉 / 拉取 / 粘贴导入 / Key 查看（portal 到视口锚定的宿主根容器） ---- */}
      {portalInto(chipTarget ? <ChipDrawer key={`${chip?.ctx}:${chip?.providerId}:${chip?.modelId}`} target={chipTarget} /> : null)}
      {portalInto(<FetchModal />)}
      {portalInto(pasteOpen && (
        <div className="ma-overlay" role="dialog" aria-label="粘贴导入" onClick={(e) => e.stopPropagation()}>
          <div className="ma-modal">
            <div className="ma-mhead">
              <span>粘贴导入</span>
              <button className="ma-x" aria-label="关闭" onClick={() => setPasteOpen(false)}>×</button>
            </div>
            <div className="ma-mbody">
              <textarea
                className="ma-paste-ta"
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                placeholder="粘贴 polaris-provider-export / polaris-model-export JSON…"
              />
              <div className="ma-paste-ops">
                <button className="ma-btn small" onClick={() => { setPasteText(''); setPastePreview(null); setPasteError(null); }}>清空</button>
                <button className="ma-btn small" disabled={!pasteText.trim()} onClick={parsePaste}>解析预览</button>
              </div>
              {pasteError && <div className="ma-error"><b>解析失败</b><span>{pasteError}</span></div>}
              {pastePreview && (
                <div className="ma-imp-preview">
                  <div className="ttl">{pastePreview.provider.name || '（未命名）'}</div>
                  <div className="meta">
                    {pastePreview.provider.baseURL || '（无 baseURL）'}
                    {pastePreview.provider.activeModel ? ` · activeModel: ${pastePreview.provider.activeModel}` : ''}
                  </div>
                  {pastePreview.issues.map((i, idx) => (
                    <div key={idx} className={`ma-imp-issue ${i.cls}`}>
                      <span>{i.cls === 'ok' ? '√' : i.cls === 'warn' ? '!' : '×'}</span>
                      <span>{i.text}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="ma-mfoot">
              <span className="ma-msub">导入会重新生成 id</span>
              <span className="ma-mfoot-sp" />
              <button className="ma-btn small" onClick={() => setPasteOpen(false)}>取消</button>
              <button className="ma-btn small primary" disabled={!pastePreview} onClick={importToForm}>导入到表单</button>
            </div>
          </div>
        </div>
      ))}
      {portalInto(keyView && (
        <div className="ma-overlay" role="dialog" aria-label={`查看 API Key ${keyView.provider.name}`} onClick={(e) => e.stopPropagation()}>
          <div className="ma-modal">
            <div className="ma-mhead">
              <span>查看 API Key · {keyView.provider.name}</span>
              <button className="ma-x" aria-label="关闭" onClick={() => setKeyView(null)}>×</button>
            </div>
            <div className="ma-mbody">
              <div className="ma-keywarn">
                <span className="ma-warnmark">!</span>
                <span>
                  明文 Key 等同账户凭据：{REVEAL_HIDE_SECONDS} 秒后自动隐藏，本次操作已写入服务端审计日志。
                  部署可用 <code>PLITE_ALLOW_REVEAL=0</code> 整体关闭此入口。
                </span>
              </div>
              <div className="ma-keyrow">
                <code className={keyView.plain ? 'plain' : ''}>{keyView.plain ? keyView.key : keyView.provider.keyMasked}</code>
              </div>
              <div className="ma-keytimer">{keyView.plain ? `${keyView.left}s 后自动隐藏` : ''}</div>
              <div className="ma-keyops">
                <button
                  className="ma-btn small"
                  onClick={() => setKeyView((cur) => (cur ? { ...cur, plain: !cur.plain, left: cur.plain ? cur.left : REVEAL_HIDE_SECONDS } : cur))}
                >
                  {keyView.plain ? '隐藏' : '显示明文'}
                </button>
                <button
                  className="ma-btn small"
                  disabled={!keyView.plain}
                  onClick={async () => {
                    const ok = await copyText(keyView.key ?? '');
                    showNotice(ok ? '明文 Key 已复制到剪贴板' : '复制失败：请检查浏览器剪贴板权限');
                  }}
                >
                  复制
                </button>
              </div>
            </div>
            <div className="ma-mfoot">
              <span className="ma-mfoot-sp" />
              <button className="ma-btn small" onClick={() => setKeyView(null)}>关闭</button>
            </div>
          </div>
        </div>
      ))}
      {portalInto(notice ? <div className="ma-toast">{notice}</div> : null)}
    </div>
  );
}
