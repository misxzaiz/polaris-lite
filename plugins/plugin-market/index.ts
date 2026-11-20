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
import type { LitePlugin, SlotHostApi } from '@sdk';
import { MarketPanel } from './Panel';
import './panel.css';

export const pluginMarketPlugin: LitePlugin = {
  manifest: {
    id: 'plugin-market',
    name: '插件商城',
    version: '0.1.0',
    capabilities: ['cap.meta'],
    provides: [],
    events: [],
    contributes: {
      // 面板 order 21-23 已占（MCP/技能/钩子），本插件取 24；tab 名 ≤4 字
      slots: [{ slot: 'panel', component: 'MarketPanel', order: 24, title: '商城' }],
    },
  },
  setup(_api: SlotHostApi) {
    // 数据面全部在 server 半边（/api/market/* + /ext-plugins/*）；面板直接 fetch（同源 cookie）
  },
};

export { MarketPanel };
export default pluginMarketPlugin;
