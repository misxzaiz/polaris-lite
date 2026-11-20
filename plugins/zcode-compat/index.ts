/**
 * zcode-compat 插件：Claude Code / ZCode 扩展资产导入器（接入层）。
 *
 * 定位（plans/extension-capability-pure-plugin-plan.md §4）：扫描 workspace/用户目录下的
 * CC/ZC 扩展文件（.mcp.json、.zcode/config.json、.agents/mcp.json、~/.claude.json、
 * .claude|.zcode|.agents/skills、settings.json#hooks、.claude-plugin/.zcode-plugin 插件），
 * 翻译成 lite 原生格式并**固化导入**（写 mcp-servers.json / skills 目录 / hooks 归一配置）。
 * 导入完成后本插件即无事可做——能力由 mcp-bridge / skill-loader / hook-bridge 承载。
 *
 * 端点（server 半边）：
 *   GET  /api/compat/scan   → 各来源发现清单 + 警告（不写任何文件）
 *   POST /api/compat/import → 执行固化导入（MCP servers → mcp-servers.json；skills → <dataDir>/skills；
 *                             hooks → <dataDir>/hooks-import.json 供 hook-bridge 读取）
 *
 * 安全：PLITE_COMPAT=0 禁用；manifest/命令路径逃逸拒绝；导入动作本身即用户确认。
 */
import type { LitePlugin, SlotHostApi } from '@sdk';

export const zcodeCompatPlugin: LitePlugin = {
  manifest: {
    id: 'zcode-compat',
    name: 'CC/ZC 扩展导入器',
    version: '0.1.0',
    capabilities: ['cap.meta'],
    provides: ['cap.compat.admin'],
    events: [],
    contributes: { slots: [] },
  },
  setup(_api: SlotHostApi) {
    // 纯导入器：无浏览器侧能力；管理走 server 半边 HTTP 端点。
  },
};

export default zcodeCompatPlugin;
