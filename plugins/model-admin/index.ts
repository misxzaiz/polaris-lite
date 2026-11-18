/**
 * model-admin 插件：模型供应商管理面板（含能力配置：输入/输出 token、图片识别、思考等级）。
 *
 * 职责：
 * - 供应商配置 CRUD：配置本体存 config-manager（cap.config，namespace='model-admin'），
 *   本插件做业务编排（校验/打码/默认项管理），不再自己持久化；
 * - 面板 UI：列表 / 新增编辑表单 / key 打码 / 启用开关 / 默认供应商标记 / 连通性测试；
 * - 模型条目能力编辑：maxInputTokens / maxOutputTokens / effort / vision；
 * - 配置变更时广播 model-config-changed 事件，引擎插件监听后热更新（免刷新）。
 *
 * 安全约定：apiKey 全文只在 cap.config 存储内；对外（cap 查询/展示）一律返回 masked 值。
 */
import type { LitePlugin, SlotHostApi, CapabilityHandler } from '@/core/types';
import { ModelAdminPanel, setPanelApi } from './Panel';
import { detectProviderCapabilities } from './detect';
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

const NS = 'model-admin';

/** 内存权威缓存：读操作直接走它（同步、无闪烁），写操作穿透到 cap.config */
let cache: ProviderConfig[] | null = null;

function loadConfigs(): ProviderConfig[] {
  return cache ?? [];
}

function saveConfigs(configs: ProviderConfig[]): void {
  cache = configs;
  void hostApi
    ?.dispatch({ target: 'cap.config', action: 'setAll', payload: { namespace: NS, value: { providers: configs } } });
}

function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '*'.repeat(key.length);
  return `${key.slice(0, 3)}***${key.slice(-4)}`;
}

function publicView(c: ProviderConfig) {
  return { ...c, apiKey: maskKey(c.apiKey), hasKey: !!c.apiKey };
}

function broadcastChange(api: SlotHostApi): void {
  const configs = loadConfigs();
  const all = configs.map(publicView);
  const activeFull =
    configs.find((c) => c.isDefault && c.enabled && c.apiKey) ?? configs.find((c) => c.enabled && c.apiKey) ?? null;
  const active = activeFull ? { ...activeFull, apiKey: maskKey(activeFull.apiKey), hasKey: true } : null;
  api.emit('model-config-changed', { configs: all, active });
}

/** 初始配置：只给一组可编辑的骨架，**不内置任何 API Key**。
 *  Key 由用户在面板填写后经宿主服务端落盘（.polaris-lite/providers.json），
 *  前端永不持有明文（见 server/providers-api.mjs）。 */
function initialConfigs(): ProviderConfig[] {
  return [
    {
      id: 'default',
      name: '默认供应商',
      baseURL: '',
      apiKey: '',
      models: [],
      activeModel: '',
      enabled: false,
      isDefault: true,
    },
  ];
}

/** cap.model.admin 动作表：list / resolveActive / get / getPlain / save / remove / setDefault / detect */
function createAdminHandler(): CapabilityHandler {
  return async (req) => {
    const payload = (req.payload ?? {}) as { id?: string; config?: ProviderConfig; live?: boolean };
    switch (req.action) {
      case 'list':
        return { configs: loadConfigs().map(publicView) };
      case 'resolveActive': {
        const configs = loadConfigs();
        const active =
          configs.find((c) => c.isDefault && c.enabled && c.apiKey) ??
          configs.find((c) => c.enabled && c.apiKey) ??
          null;
        return { config: active ?? null };
      }
      case 'get': {
        const found = loadConfigs().find((c) => c.id === payload.id);
        return { config: found ? publicView(found) : null };
      }
      case 'getPlain': {
        // 供面板「连通性测试」取真实 key（本机工具形态；面板展示仍用打码值）
        const found = loadConfigs().find((c) => c.id === payload.id);
        return { config: found ?? null };
      }
      case 'save': {
        const incoming = payload.config;
        if (!incoming?.id) return { ok: false, error: 'config.id required' };
        const configs = loadConfigs();
        const idx = configs.findIndex((c) => c.id === incoming.id);
        if (idx >= 0) {
          // 编辑：apiKey 留空 = 保持原值（表单打码回显时不覆盖）
          const keepKey = !incoming.apiKey ? configs[idx].apiKey : incoming.apiKey;
          configs[idx] = { ...configs[idx], ...incoming, apiKey: keepKey };
        } else {
          configs.push({ ...incoming, apiKey: incoming.apiKey ?? '' });
        }
        if (incoming.isDefault) {
          configs.forEach((c) => { if (c.id !== incoming.id) c.isDefault = false; });
        }
        saveConfigs(configs);
        if (hostApi) broadcastChange(hostApi);
        return { ok: true, configs: configs.map(publicView) };
      }
      case 'remove': {
        let configs = loadConfigs().filter((c) => c.id !== payload.id);
        if (configs.length && !configs.some((c) => c.isDefault)) configs[0].isDefault = true;
        saveConfigs(configs);
        if (hostApi) broadcastChange(hostApi);
        return { ok: true, configs: configs.map(publicView) };
      }
      case 'setDefault': {
        const configs = loadConfigs();
        configs.forEach((c) => { c.isDefault = c.id === payload.id; });
        saveConfigs(configs);
        if (hostApi) broadcastChange(hostApi);
        return { ok: true, configs: configs.map(publicView) };
      }
      case 'detect': {
        // 能力自动识别：builtin 表 + （可选）真实链路探测；结论写回并广播。
        // manual 编辑过的模型不被覆盖（mergeCaps 内部保护）。
        const target = loadConfigs().find((c) => c.id === payload.id);
        if (!target) return { ok: false, error: `provider not found: ${payload.id}` };
        const reports = await detectProviderCapabilities(target, { live: payload.live !== false });
        const probeReports = reports.filter((r) => r.modelId !== '__catalog__');
        const catalogReport = reports.find((r) => r.modelId === '__catalog__');
        const configs = loadConfigs();
        const idx = configs.findIndex((c) => c.id === payload.id);
        if (idx >= 0) {
          configs[idx] = {
            ...configs[idx],
            models: configs[idx].models.map((m) => {
              const r = probeReports.find((x) => x.modelId === m.id);
              return r ? { ...m, capabilities: r.capabilities } : m;
            }),
          };
          saveConfigs(configs);
          if (hostApi) broadcastChange(hostApi);
        }
        return {
          ok: true,
          reports: probeReports,
          catalogNotes: catalogReport?.notes ?? [],
          configs: configs.map(publicView),
        };
      }
      default:
        return { ok: false, error: `unknown action: ${req.action}` };
    }
  };
}



export const modelAdminPlugin: LitePlugin = {
  manifest: {
    id: 'model-admin',
    name: '模型供应商管理',
    version: '0.2.0',
    capabilities: ['cap.model.admin', 'cap.config'],
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

    // 启动：优先读 cap.config 里已持久化的配置；没有则写入初始配置
    void api
      .dispatch<{ value?: { providers?: ProviderConfig[] } }>({
        target: 'cap.config',
        action: 'get',
        payload: { namespace: NS, key: 'providers' },
      })
      .then((res) => {
        const persisted = res.ok ? res.data?.value?.providers : undefined;
        if (Array.isArray(persisted) && persisted.length) {
          cache = persisted;
        } else {
          saveConfigs(initialConfigs());
        }
        if (hostApi) broadcastChange(hostApi);
      });
  },
};

export const panelComponents = { ModelAdminPanel };
export default modelAdminPlugin;
