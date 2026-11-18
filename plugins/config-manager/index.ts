/**
 * config-manager 插件：通用配置中心。
 *
 * 职责：为所有插件提供统一的配置存取能力（cap.config）：
 * - set(namespace, key, value) / get(namespace, key) / list(namespace) / remove(namespace, key)
 * - 配置变更时广播 config-changed 事件（携带 namespace + key），其他插件可监听热更新；
 * - 持久化到 localStorage（本机工具形态）；未来可无缝换成宿主 kv/文件。
 *
 * 使用约定（对齐 Polaris cap.config）：
 * - 调用方在 manifest.capabilities 里声明 'cap.config'；
 * - namespace 建议用插件 id（如 'model-admin'、'real-engine'），避免互相覆盖。
 */
import type { CapabilityHandler, LitePlugin, SlotHostApi } from '@/core/types';

const STORAGE_KEY = 'config-manager.store.v1';
const CHANGE_EVENT = 'config-changed';

let hostApi: SlotHostApi | null = null;

type Store = Record<string, Record<string, unknown>>;

function readStore(): Store {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Store) : {};
  } catch {
    return {};
  }
}

function writeStore(store: Store): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

function createHandler(): CapabilityHandler {
  return (req) => {
    const payload = (req.payload ?? {}) as { namespace?: string; key?: string; value?: unknown };
    const ns = payload.namespace ?? '';
    if (!ns) return { ok: false, error: 'namespace required' };
    const store = readStore();
    const section = store[ns] ?? {};

    switch (req.action) {
      case 'get':
        return { ok: true, value: payload.key ? section[payload.key] : section };
      case 'set': {
        if (!payload.key) return { ok: false, error: 'key required' };
        const next = { ...store };
        next[ns] = { ...section, [payload.key]: payload.value };
        writeStore(next);
        hostApi?.emit(CHANGE_EVENT, { namespace: ns, key: payload.key });
        return { ok: true };
      }
      case 'setAll': {
        if (!payload.value || typeof payload.value !== 'object') return { ok: false, error: 'value object required' };
        const next = { ...store, [ns]: payload.value as Record<string, unknown> };
        writeStore(next);
        hostApi?.emit(CHANGE_EVENT, { namespace: ns, key: '*' });
        return { ok: true };
      }
      case 'remove': {
        if (!payload.key) return { ok: false, error: 'key required' };
        const next = { ...store, [ns]: Object.fromEntries(Object.entries(section).filter(([k]) => k !== payload.key)) };
        writeStore(next);
        hostApi?.emit(CHANGE_EVENT, { namespace: ns, key: payload.key });
        return { ok: true };
      }
      case 'list':
        return { ok: true, namespaces: Object.keys(store), keys: Object.keys(section) };
      default:
        return { ok: false, error: `unknown action: ${req.action}` };
    }
  };
}

export const configManagerPlugin: LitePlugin = {
  manifest: {
    id: 'config-manager',
    name: '配置中心',
    version: '0.1.0',
    capabilities: [],
    provides: ['cap.config'],
    events: [],
    contributes: { slots: [] },
  },
  setup(api: SlotHostApi) {
    hostApi = api;
    api.registerCapability.register('cap.config', createHandler());
  },
};

export default configManagerPlugin;
