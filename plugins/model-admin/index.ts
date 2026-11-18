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
 * cap.model.admin 动作：list / resolveActive / save / remove / setDefault / test / probe
 */
import type { LitePlugin, SlotHostApi, CapabilityHandler } from '@/core/types';
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
  /** 能力来源标记（自动识别结果的可信度追溯） */
  detected?: 'builtin' | 'probe' | 'manual';
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

function createAdminHandler(): CapabilityHandler {
  return async (req) => {
    const payload = (req.payload ?? {}) as { id?: string; config?: ProviderConfig; live?: boolean };
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

        case 'probe': {
          // 一键识别：服务端真实探测 → 前端「内置表 → 实测」合并 → 回写 models
          const { configs } = await callApi<{ configs: PublicProvider[] }>('/api/providers/list');
          const target = configs.find((c) => c.id === payload.id);
          if (!target) return { ok: false, error: `provider not found: ${payload.id}` };

          const facts = await callApi<ProbeFacts>('/api/providers/probe', {
            id: payload.id,
            live: payload.live !== false,
          });

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
    name: '模型供应商管理',
    version: '0.3.0',
    // 面板自身经总线调用本插件提供的 cap.model.admin（自调同样要过 gate，故需声明）
    capabilities: ['cap.model.admin'],
    provides: ['cap.model.admin'],
    events: [],
    contributes: {
      slots: [{ slot: 'panel', component: 'ModelAdminPanel', order: 2 }],
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
