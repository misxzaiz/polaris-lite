/**
 * plugin-manager 插件：插件管理面板（启停 + 布局调整）。
 *
 * 职责：
 * - cap.plugin.admin：本插件提供的管理能力（list/setEnabled 经 server 半边落盘 registry.json）；
 * - panel 槽：两页签面板（插件清单 + 工作区布局）；
 * - 位置调整走既有 cap.ui.layout（open/close/reset），不新开布局通道。
 *
 * 禁用语义：插件在浏览器启动时装配，enabled=false 于下次加载生效；
 * 面板明确展示这一点，服务端写入时同步 bump 产物版本号保证刷新后拉新。
 */
import type { CapabilityHandler, LitePlugin, SlotHostApi } from '@sdk';
import { PluginManagerPanel, setPanelApi } from './Panel';
import './panel.css';

/** cap.plugin.admin：面板动作的薄包装（真正落盘在 server 半边 /api/plugin-admin/*） */
function createAdminHandler(): CapabilityHandler {
  return async (req) => {
    const payload = (req.payload ?? {}) as { id?: string; enabled?: boolean };
    try {
      switch (req.action) {
        case 'list':
          return await fetch('/api/plugin-admin/list', { credentials: 'include' }).then(async (r) => {
            const data = (await r.json()) as { plugins?: unknown[]; error?: string };
            if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
            return { ok: true, plugins: data.plugins ?? [] };
          });
        case 'setEnabled': {
          if (!payload.id || typeof payload.enabled !== 'boolean') {
            return { ok: false, error: 'id 与 enabled(boolean) 必填' };
          }
          const resp = await fetch('/api/plugin-admin/set-enabled', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ id: payload.id, enabled: payload.enabled }),
          });
          const data = (await resp.json().catch(() => null)) as { error?: string } | null;
          if (!resp.ok) throw new Error(data?.error ?? `HTTP ${resp.status}`);
          return { ok: true, ...(data ?? {}) };
        }
        default:
          return { ok: false, error: `unknown action: ${req.action}` };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };
}

export const pluginManagerPlugin: LitePlugin = {
  manifest: {
    id: 'plugin-manager',
    name: '插件管理',
    version: '0.1.0',
    // cap.plugin.admin：自供自用（总线按调用方权限放行，自调也要声明）；
    // cap.meta：describe 取插件权限表与视图清单；
    // cap.ui.layout：布局页签的 getTree/open/close/reset。
    capabilities: ['cap.plugin.admin', 'cap.meta', 'cap.ui.layout', 'cap.ui.layout.global'],
    provides: ['cap.plugin.admin'],
    events: [],
    contributes: {
      // 面板 order 已占用 1..10，本插件取 11；tab 名 ≤4 字
      slots: [{ slot: 'panel', component: 'PluginManagerPanel', order: 11, title: '插件' }],
    },
  },
  setup(api: SlotHostApi) {
    setPanelApi(api);
    api.registerCapability.register('cap.plugin.admin', createAdminHandler());
  },
};

export { PluginManagerPanel };
export default pluginManagerPlugin;
