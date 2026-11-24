/**
 * plugin-market 插件：外部插件商城 + 运行时安装器（runtime-extensions-and-market-final.md P2）。
 *
 * 职责：
 * - 商城源管理：本地目录 / file:// / http(s) 源，每个源一份 index.json 清单
 *   （{name, plugins:[{id,name,version,description,downloadUrl,sha256,tags?}]}）；
 * - 安装器：下载 → sha256 强校验 → 解包校验（必须含 plugin.json 声明 + plugin.js bundle）
 *   → 落 <dataDir>/plugins/<id>/（与内置构建产物物理隔离）→ registry 双写增项
 *   （module 指向 /ext-plugins/<id>/plugin.js?v=hash8）→ 提示「刷新页面生效」；
 * - /ext-plugins/<id>/* 自服务路由：从 <dataDir>/plugins/ 读 bundle（穿越校验 + no-store）
 *   ——不复制进 dist（vite build emptyOutDir 会清掉），dev/prod 一致；
 * - 卸载 / 更新检查（源 version > 本地 version 提示）。
 *
 * 安全模型：PLITE_MARKET=0 一键禁用；sha256 必校验；路径逃逸拒绝；
 * 外部插件按 unlistedPolicy=declare 放行（面板红字提示只装可信来源——
 * 外部插件与宿主同进程运行）。
 */
import type { CapabilityHandler, LitePlugin, SlotHostApi } from '@sdk';
import { MarketPanel } from './Panel';
import './panel.css';

const MARKET_TOOL_DESCRIPTORS = [
  {
    cap: 'cap.market.tool',
    name: 'market_list',
    description: '列出商城源里可安装的插件及安装状态（含 Claude Code 商城：source 为 marketplace 名、id 为插件名的条目标记为 (cc)）。',
    parameters: { type: 'object', properties: {} },
    danger: 'read' as const,
  },
  {
    cap: 'cap.market.tool',
    name: 'market_install',
    description:
      '从商城安装插件。两种源：' +
      '（1）普通目录源——source 为已登记源名，安装其 plugin.js bundle（运行外部代码，只装可信来源）；' +
      '（2）Claude Code 商城——source 直接填 marketplace 名（如 claude-plugins-official），仅导入其声明型资源' +
      '（skills → 技能、hooks → 钩子桥、stdio mcpServers → MCP 桥），不运行外部 JS；只支持本地已 checkout 的插件。' +
      'target 决定作用域：global（默认，所有会话可见）/ project（仅当前激活项目工作区可见）。',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', description: '商城源名或 CC marketplace 名' },
        id: { type: 'string', description: '插件 id' },
        target: { type: 'string', description: '作用域：global（默认）| project', enum: ['global', 'project'] },
      },
      required: ['source', 'id'],
    },
    danger: 'execute' as const,
  },
  {
    cap: 'cap.market.tool',
    name: 'market_uninstall',
    description: '卸载一个已安装的外部插件（刷新页面生效）。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '插件 id' } },
      required: ['id'],
    },
    danger: 'write' as const,
  },
];

function createMarketToolHandler(): CapabilityHandler {
  return async (req) => {
    if (req.action === 'describe') return { descriptors: MARKET_TOOL_DESCRIPTORS };
    if (req.action === 'exec') {
      const payload = (req.payload ?? {}) as Record<string, unknown>;
      const op = String(payload.__tool ?? '');
      try {
        if (op === 'market_list') {
          const r = await fetch('/api/market/list', { credentials: 'include' });
          const j = (await r.json().catch(() => null)) as {
            items?: { id: string; name: string; version: string; installed: boolean }[];
            ccMarkets?: { name: string; pluginCount: number; installableCount: number; plugins: { id: string; installable: boolean }[] }[];
          } | null;
          const lines = (j?.items ?? []).map((i) => '- ' + i.id + ' v' + i.version + (i.installed ? ' [已安装]' : ''));
          const ccLines: string[] = [];
          for (const m of j?.ccMarkets ?? []) {
            ccLines.push(`[CC商城 ${m.name}] 共 ${m.pluginCount} 个，本地可装 ${m.installableCount} 个：`);
            for (const p of m.plugins.filter((x) => x.installable)) ccLines.push('- (cc) ' + p.id);
          }
          const all = [...lines, ...ccLines];
          return { ok: true, stdout: all.length ? all.join('\n') : '（商城暂无插件）', exitCode: 0 };
        }
        if (op === 'market_cc_install') {
          const r = await fetch('/api/market/cc-install', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ market: payload.market, id: payload.id }),
          });
          const j = (await r.json().catch(() => null)) as { ok?: boolean; error?: string; parts?: number; log?: string[] } | null;
          if (!r.ok || !j?.ok) return { ok: false, error: j?.error ?? 'HTTP ' + r.status };
          return { ok: true, stdout: `[已导入 CC 插件 ${String(payload.id)}] ${((j.log ?? []).join('；')) || '无资源'}。skills 即刻生效；hooks/mcpServers 下轮会话生效。`, exitCode: 0 };
        }
        if (op === 'market_install') {
          const r = await fetch('/api/market/install', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source: payload.source, id: payload.id, target: payload.target ?? 'global' }),
          });
          const j = (await r.json().catch(() => null)) as { ok?: boolean; error?: string; note?: string; scope?: string; project?: string } | null;
          if (!r.ok || !j?.ok) return { ok: false, error: j?.error ?? 'HTTP ' + r.status };
          const scopeNote = j.scope === 'project' ? `（项目级：${j.project}）` : '（全局）';
          return { ok: true, stdout: '[已安装 ' + String(payload.id) + '] ' + scopeNote + ' ' + String(j.note ?? '') + '。前端 bundle 类插件刷新页面生效；server 半边重启生效。', exitCode: 0 };
        }
        if (op === 'market_uninstall') {
          const r = await fetch('/api/market/uninstall', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: payload.id }),
          });
          const j = (await r.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
          if (!r.ok || !j?.ok) return { ok: false, error: j?.error ?? 'HTTP ' + r.status };
          return { ok: true, stdout: '[已卸载 ' + String(payload.id) + '] 刷新页面生效。', exitCode: 0 };
        }
        return { ok: false, error: '未知操作: ' + op };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    return { ok: false, error: 'unknown action: ' + req.action };
  };
}

export const pluginMarketPlugin: LitePlugin = {
  manifest: {
    id: 'plugin-market',
    name: '插件商城',
    version: '0.1.0',
    capabilities: ['cap.meta'],
    provides: ['cap.market.tool'],
    events: ['tool-registered'],
    contributes: {
      // 面板 order 21-23 已占（MCP/技能/钩子），本插件取 24；tab 名 ≤4 字
      slots: [{ slot: 'panel', component: 'MarketPanel', order: 24, title: '商城' }],
    },
  },
  setup(api: SlotHostApi) {
    api.registerCapability.register('cap.market.tool', createMarketToolHandler());
    api.emit('tool-registered', { cap: 'cap.market.tool', name: 'market_list' });
    // 数据面全部在 server 半边（/api/market/* + /ext-plugins/*）；面板直接 fetch（同源 cookie）
  },
};

export { MarketPanel };
export default pluginMarketPlugin;
