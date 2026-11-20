/**
 * kv-store 插件：通用键值存储能力（cap.kv）。
 *
 * 职责：为所有插件提供**服务端持久化**的键值存取——数据落 <dataDir>/stores/kv-store.db
 * （sqlite，经本插件的 server 半边 /api/kv/* 读写），浏览器侧不存业务数据。
 * 换浏览器/清缓存/多端打开看到同一份数据（与原 cap.config 的 localStorage 形态本质区别）。
 *
 * 使用约定（对齐 Polaris cap.kv）：
 * - 调用方在 manifest.capabilities 里声明 'cap.kv'；
 * - namespace 建议用插件 id（如 'pocket-ledger'），避免互相覆盖；
 * - key ≤200 字符；value ≤1MB；键空间前缀枚举用 list。
 *
 * 兼容说明：cap.config（localStorage）继续可用；新数据建议走 cap.kv。
 */
import type { CapabilityHandler, LitePlugin, SlotHostApi } from '@sdk';

async function kv<T>(action: string, payload: Record<string, unknown>): Promise<T> {
  const resp = await fetch(`/api/kv/${action}`, {
    method: action === 'get' || action === 'list' ? 'GET' : 'POST',
    credentials: 'include',
    headers: action === 'get' || action === 'list' ? undefined : { 'Content-Type': 'application/json' },
    body: action === 'get' || action === 'list' ? undefined : JSON.stringify(payload),
  });
  if (!resp.ok) {
    const j = (await resp.json().catch(() => null)) as { error?: string } | null;
    throw new Error(j?.error ?? `HTTP ${resp.status}`);
  }
  return (await resp.json()) as T;
}

function createKvHandler(): CapabilityHandler {
  return async (req) => {
    const p = (req.payload ?? {}) as { namespace?: string; key?: string; value?: unknown };
    const ns = String(p.namespace ?? '');
    const key = String(p.key ?? '');
    try {
      switch (req.action) {
        case 'get': {
          const resp = await fetch(`/api/kv/get?namespace=${encodeURIComponent(ns)}&key=${encodeURIComponent(key)}`, { credentials: 'include' });
          if (!resp.ok) throw new Error(`kv get failed: ${resp.status}`);
          const j = (await resp.json()) as { value?: unknown };
          return { ok: true, value: j.value ?? null };
        }
        case 'set': {
          await kv('set', { namespace: ns, key, value: p.value ?? null });
          return { ok: true };
        }
        case 'delete': {
          await kv('delete', { namespace: ns, key });
          return { ok: true };
        }
        case 'list': {
          const resp = await fetch(`/api/kv/list?namespace=${encodeURIComponent(ns)}`, { credentials: 'include' });
          if (!resp.ok) throw new Error(`kv list failed: ${resp.status}`);
          const j = (await resp.json()) as { keys?: string[] };
          return { ok: true, keys: j.keys ?? [] };
        }
        default:
          return { ok: false, error: `unknown action: ${req.action}` };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };
}

export const kvStorePlugin: LitePlugin = {
  manifest: {
    id: 'kv-store',
    name: '键值存储',
    version: '0.1.0',
    capabilities: [],
    provides: ['cap.kv'],
    events: [],
    contributes: { slots: [] },
  },
  setup(api: SlotHostApi) {
    api.registerCapability.register('cap.kv', createKvHandler());
  },
};

export default kvStorePlugin;
