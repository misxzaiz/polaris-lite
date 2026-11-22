/**
 * model-admin 插件：模型供应商管理面板（配置 + 能力 + 连通性 + 自动识别）。
 *
 * 架构变更（2026-11 密钥下沉）：
 * - 供应商配置与 API Key 存**服务端** `.polaris-lite/providers.json`；
 *   本插件只是 `/api/providers/*` 的薄客户端，前端永不持有明文 key（getPlain 已删除）；
 * - 能力识别（catalog/vision/effort）必须带 key，故探测在服务端执行，
 *   浏览器只拿结论；内置知识表与结论合并仍在前端完成（表不需要 key）；
 * - 对引擎只暴露 masked 视图：引擎不再需要 key，它把 providerId 交给中继即可。
 *
 * cap.model.admin 动作：list / resolveActive / save / remove / setDefault / test / probe /
 * fetchModels（拉取上游 /models）/ revealKey（查看明文 Key，带护栏 + 审计）
 */
import type { LitePlugin, SlotHostApi, CapabilityHandler } from '@sdk';
import { ModelAdminPanel, setPanelApi } from './Panel';
import { mergeModelCaps, type ProbeFacts } from './detect';
import './panel.css';

let hostApi: SlotHostApi | null = null;

export interface ModelCapabilities {
  /** 输入上下文窗口（token）。0/缺省=未知 */
  maxInputTokens: number;
  /** 单次回复上限。0/缺省=用引擎默认 */
  maxOutputTokens: number;
  /** 思考等级：null=该模型不支持；缺省 undefined=未知（探测后回填） */
  effort: 'minimal' | 'low' | 'medium' | 'high' | null;
  /** 是否支持图片输入。缺省=未知 */
  vision: boolean;
  /** 工具调用支持（实测/catalog）。null=未知 */
  tools?: boolean | null;
  /** 思考可关（thinking:{type:'disabled'} 是否被接受）。null=未知 */
  canDisableThinking?: boolean | null;
  /** 思考与输出共享 max_tokens 预算（截断后可能空内容）。null=未知 */
  reasoningEatsBudget?: boolean | null;
  /** 能力来源标记（自动识别结果的可信度追溯；reveal=网关限值报错揭示，权威） */
  detected?: 'builtin' | 'catalog' | 'probe' | 'reveal' | 'manual';
  /** 最近一次识别时间（epoch ms；manual 编辑不清除——人工值的"来源"仍是 manual） */
  detectedAt?: number;
}

export interface ModelInfo {
  id: string;
  capabilities: ModelCapabilities;
}

/** 服务端存储形态（含明文 key，只存在于服务端与表单提交体） */
export interface ProviderConfig {
  id: string;
  name: string;
  baseURL: string;
  apiKey: string;
  models: ModelInfo[];
  activeModel: string;
  enabled: boolean;
  isDefault?: boolean;
}

/** 服务端回给前端的脱敏形态 */
export interface PublicProvider {
  id: string;
  name: string;
  baseURL: string;
  keyMasked: string;
  hasKey: boolean;
  models: ModelInfo[];
  activeModel: string;
  enabled: boolean;
  isDefault: boolean;
}

/** 服务端 API 调用（同源、会话 cookie 自动携带；非 2xx 或 ok:false 统一抛错） */
async function callApi<T>(path: string, body?: unknown): Promise<T> {
  const resp = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  const data = (await resp.json().catch(() => null)) as
    | ({ ok?: boolean; error?: { message?: string } } & T)
    | null;
  if (!resp.ok || !data?.ok) {
    throw new Error(data?.error?.message ?? `HTTP ${resp.status}`);
  }
  return data;
}

function broadcastChange(api: SlotHostApi, configs: PublicProvider[]): void {
  const active =
    configs.find((c) => c.isDefault && c.enabled && c.hasKey) ??
    configs.find((c) => c.enabled && c.hasKey) ??
    null;
  api.emit('model-config-changed', { configs, active });
}

export interface ProbeReport {
  modelId: string;
  notes: string[];
  source: string;
}

/**
 * 识别主流程（手动「一键识别/深度识别」与保存后自动识别共用）。
 * deep=true 跑思考差分（~8k token/模型，按钮触发档）；浅层 ≤120 token/模型。
 */
async function runProbeFlow(
  id: string | undefined,
  deep: boolean,
  live: boolean = true,
  modelIds?: string[],
): Promise<{ ok: boolean; error?: string; reports?: ProbeReport[]; catalogNotes?: string[]; configs?: PublicProvider[] }> {
  if (!id) return { ok: false, error: 'id required' };
  const { configs } = await callApi<{ configs: PublicProvider[] }>('/api/providers/list');
  const target = configs.find((c) => c.id === id);
  if (!target) return { ok: false, error: `provider not found: ${id}` };
  if (!target.hasKey) return { ok: false, error: '该供应商未配置 API Key，跳过识别' };

  const facts = await callApi<ProbeFacts>('/api/providers/probe', { id, live, deep, ...(modelIds?.length ? { modelIds } : {}) });
  const mergedModels = target.models.map((m) => mergeModelCaps(m, facts));
  const reports = mergedModels.map((r, i) => ({
    modelId: target.models[i].id,
    notes: r.notes,
    source: r.model.capabilities.detected ?? 'builtin',
  }));
  const { configs: saved } = await callApi<{ configs: PublicProvider[] }>('/api/providers/save', {
    config: { ...target, models: mergedModels.map((r) => r.model) },
  });
  if (hostApi) broadcastChange(hostApi, saved);
  return { ok: true, reports, catalogNotes: facts.notes, configs: saved };
}

/** 单模型重探：只打指定模型的探针，返回事实（不落库——由调用方决定写回位置） */
async function probeModels(id: string | undefined, modelIds: string[]): Promise<ProbeFacts> {
  return callApi<ProbeFacts>('/api/providers/probe', { id, live: true, deep: false, modelIds });
}

function createAdminHandler(): CapabilityHandler {
  return async (req) => {
    const payload = (req.payload ?? {}) as { id?: string; config?: ProviderConfig; live?: boolean; deep?: boolean; modelIds?: string[]; baseURL?: string; apiKey?: string };
    try {
      switch (req.action) {
        case 'list':
          return await callApi<{ configs: PublicProvider[]; activeId: string | null }>('/api/providers/list');

        case 'resolveActive': {
          const { configs } = await callApi<{ configs: PublicProvider[] }>('/api/providers/list');
          const active =
            configs.find((c) => c.isDefault && c.enabled && c.hasKey) ??
            configs.find((c) => c.enabled && c.hasKey) ??
            null;
          return { config: active }; // masked：引擎只需要 id / activeModel / 能力表
        }

        case 'save': {
          const incoming = payload.config;
          if (!incoming?.id) return { ok: false, error: 'config.id required' };
          const data = await callApi<{ configs: PublicProvider[] }>('/api/providers/save', { config: incoming });
          if (hostApi) broadcastChange(hostApi, data.configs);
          // 自动识别（浅层，预算封顶 ≤120 token/模型）：保存成功后后台跑，完成后再次
          // 广播——引擎据此拿到补齐的能力表（max_tokens 不再裸奔）。失败静默：识别是
          // 增益不是门槛，面板可手动重试。
          void runProbeFlow(incoming.id, false)
            .then((r) => {
              if (r.ok && hostApi && r.configs) broadcastChange(hostApi, r.configs);
            })
            .catch(() => { /* 自动识别失败不打扰用户 */ });
          return data;
        }

        case 'remove': {
          const data = await callApi<{ configs: PublicProvider[] }>('/api/providers/remove', { id: payload.id });
          if (hostApi) broadcastChange(hostApi, data.configs);
          return data;
        }

        case 'setDefault': {
          const data = await callApi<{ configs: PublicProvider[] }>('/api/providers/set-default', { id: payload.id });
          if (hostApi) broadcastChange(hostApi, data.configs);
          return data;
        }

        case 'test':
          // 连通性测试：服务端持 key 直连上游，前端只拿结论
          return await callApi<{ ok: boolean; text: string }>('/api/providers/test', { id: payload.id });

        case 'fetchModels':
          // 拉取上游 /models：已存供应商只传 id（key 用存储值）；新建中传 baseURL + 表单 key
          return await callApi<{ ids: string[] | null; count: number }>('/api/providers/fetch-models', {
            id: payload.id,
            baseURL: payload.baseURL,
            apiKey: payload.apiKey,
          });

        case 'revealKey':
          // 明文 Key 查看：服务端会话门禁 + PLITE_ALLOW_REVEAL 开关 + 审计；前端做 10s 自动隐藏
          return await callApi<{ key: string }>('/api/providers/reveal-key', { id: payload.id });

        case 'probe':
          // 一键识别 / 深度识别：服务端真实探测 → 前端「内置表 → 目录 → 实测 → 揭示」合并 → 回写 models
          return await runProbeFlow(payload.id, payload.deep === true, payload.live !== false, payload.modelIds);

        case 'probeModels':
          // 单模型重探（逐模型抽屉）：只打指定模型，返回事实不落库
          return { facts: await probeModels(payload.id, payload.modelIds ?? []) };

        default:
          return { ok: false, error: `unknown action: ${req.action}` };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };
}

export const modelAdminPlugin: LitePlugin = {
  manifest: {
    id: 'model-admin',
    // name 为插件身份名（开发者视角）；用户可见的 tab 名由 slots[].title 给出
    name: '模型供应商管理',
    version: '0.4.0',
    // 面板自身经总线调用本插件提供的 cap.model.admin（自调同样要过 gate，故需声明）
    capabilities: ['cap.model.admin'],
    provides: ['cap.model.admin'],
    events: ['model-config-changed'],
    contributes: {
      // tab 标签用「模型」：三连 tab 在 297px 内三等分，全称会被 ellipsis 截断
      slots: [{ slot: 'panel', component: 'ModelAdminPanel', order: 2, title: '模型' }],
    },
  },
  setup(api) {
    hostApi = api;
    setPanelApi(api);
    api.registerCapability.register('cap.model.admin', createAdminHandler());

    // 启动广播一次，让引擎拿到当前生效供应商（无需等面板打开）
    void callApi<{ configs: PublicProvider[] }>('/api/providers/list')
      .then((data) => {
        if (hostApi) broadcastChange(hostApi, data.configs);
      })
      .catch(() => {
        /* 未登录时 401：登录后由面板动作再次广播 */
      });
  },
};

export const panelComponents = { ModelAdminPanel };
export default modelAdminPlugin;
