/**
 * 插件清单的唯一事实来源（前端产物 + 服务端半边共用）。
 *
 * build-plugins.mjs 用它决定「构建哪些 UI 产物 / registry 的 enabled」；
 * server-registry.mjs 用它决定「哪些 server 半边该被挂载」。
 * 以前两边各维护一份清单，前端关掉的插件后端还在跑——那条暗通道正是
 * 「chat-lite 硬编码 /api/codebuddy/stream 绕过插件生命周期」能长期存在的底气。
 *
 * `order` 只决定 registry 书写顺序；真正的装配顺序由 manifest.requires 拓扑排序决定。
 */

export const PLUGIN_LIST = [
  { id: 'config-manager', config: 'config-manager/vite.config.ts', dist: 'config-manager/dist', order: 1 },
  { id: 'chat-lite', config: 'chat-lite/vite.config.ts', dist: 'chat-lite/dist', order: 2 },
  { id: 'model-admin', config: 'model-admin/vite.config.ts', dist: 'model-admin/dist', order: 3 },
  // 三套 AI 引擎同时启用：它们注册各自独立的 cap.ai.chat.<id>，不再互斥。
  // 默认引擎由 manifest.aiEngine.default 声明，核心分派器据此路由。
  { id: 'real-engine', config: 'real-engine/vite.config.ts', dist: 'real-engine/dist', order: 4 },
  { id: 'agent-bash', config: 'agent-bash/vite.config.ts', dist: 'agent-bash/dist', order: 5 },
  { id: 'agent-files', config: 'agent-files/vite.config.ts', dist: 'agent-files/dist', order: 7 },
  { id: 'cap-panel', config: 'cap-panel/vite.config.ts', dist: 'cap-panel/dist', order: 8 },
  { id: 'mock-auth', config: 'mock-auth/vite.config.ts', dist: 'mock-auth/dist', order: 9 },
  { id: 'mock-engine', config: 'mock-engine/vite.config.ts', dist: 'mock-engine/dist', order: 10, enabled: false },
  { id: 'file-browser', config: 'file-browser/vite.config.ts', dist: 'file-browser/dist', order: 11 },
  { id: 'theme-switcher', config: 'theme-switcher/vite.config.ts', dist: 'theme-switcher/dist', order: 12 },
  { id: 'ai-events', config: 'ai-events/vite.config.ts', dist: 'ai-events/dist', order: 13 },
  { id: 'interactive-cards', config: 'interactive-cards/vite.config.ts', dist: 'interactive-cards/dist', order: 14 },
  { id: 'html-preview', config: 'html-preview/vite.config.ts', dist: 'html-preview/dist', order: 15 },
  { id: 'pocket-ledger', config: 'pocket-ledger/vite.config.ts', dist: 'pocket-ledger/dist', order: 16 },
  { id: 'kv-store', config: 'kv-store/vite.config.ts', dist: 'kv-store/dist', order: 17 },
  { id: 'browser-lite', config: 'browser-lite/vite.config.ts', dist: 'browser-lite/dist', order: 18 },
  // Git 能力（cap.git 提供方，server 半边）+ Git 面板（消费方；requires 保证 core 先装配）
  { id: 'git-core', config: 'git-core/vite.config.ts', dist: 'git-core/dist', order: 23 },
  { id: 'git-panel', config: 'git-panel/vite.config.ts', dist: 'git-panel/dist', order: 24 },
  { id: 'chat-store', config: 'chat-store/vite.config.ts', dist: 'chat-store/dist', order: 19 },
  { id: 'plugin-manager', config: 'plugin-manager/vite.config.ts', dist: 'plugin-manager/dist', order: 20 },
  { id: 'mobile-companion', config: 'mobile-companion/vite.config.ts', dist: 'mobile-companion/dist', order: 21 },
  // 应用更新（App 刷新引导）：版本检查 + 24h 惰性提示；server 半边提供版本端点
  { id: 'app-updater', config: 'app-updater/vite.config.ts', dist: 'app-updater/dist', order: 22 },
  { id: 'phone-agent', config: 'phone-agent/vite.config.ts', dist: 'phone-agent/dist', order: 25 },
  { id: 'standalone-mode', config: 'standalone-mode/vite.config.ts', dist: 'standalone-mode/dist', order: 26 },
  // CodeBuddy CLI 引擎（服务端半边 spawn adapter.cjs → codebuddy CLI）。
  // 与 real-engine 并存：两者注册不同 namespaced cap，默认引擎由 manifest 声明。
  { id: 'codebuddy-engine', config: 'codebuddy-engine/vite.config.ts', dist: 'codebuddy-engine/dist', order: 27 },
  // 扩展能力插件（plans/extension-capability-pure-plugin-plan.md §2）：
  // skill-loader = SKILL.md 技能发现 + read_skill 工具 + 系统提示附录（AGENTS.md/CLAUDE.md）；
  // hook-bridge  = 生命周期钩子（CC/ZC hooks 兼容，进程执行器在 server 半边）。
  { id: 'skill-loader', config: 'skill-loader/vite.config.ts', dist: 'skill-loader/dist', order: 28 },
  { id: 'hook-bridge', config: 'hook-bridge/vite.config.ts', dist: 'hook-bridge/dist', order: 29 },
  // mcp-bridge = MCP server 接入（stdio JSON-RPC client 池 + cap.tool.mcp 聚合工具 + 管理面）
  { id: 'mcp-bridge', config: 'mcp-bridge/vite.config.ts', dist: 'mcp-bridge/dist', order: 30 },
  // zcode-compat = CC/ZC 扩展文件扫描与固化导入（纯导入器，能力由上面三个插件承载）
  { id: 'zcode-compat', config: 'zcode-compat/vite.config.ts', dist: 'zcode-compat/dist', order: 31 },
  // plugin-market = 外部插件商城与运行时安装器（plans/runtime-extensions-and-market-final.md P2）
  { id: 'plugin-market', config: 'plugin-market/vite.config.ts', dist: 'plugin-market/dist', order: 32 },
  // transcript-share = AI 对话全过程只读分享（needs #069）：链接分享接口 + panel + cap.tool.transcript
  { id: 'transcript-share', config: 'transcript-share/vite.config.ts', dist: 'transcript-share/dist', order: 33 },
  // shell-chrome = 多面板 tab 条 chrome 的插件化实现（containers 契约首个消费者）
  { id: 'shell-chrome', config: 'shell-chrome/vite.config.ts', dist: 'shell-chrome/dist', order: 34 },
  // workspace-layout = 工作区布局树插件化（layout-root 容器）
  { id: 'workspace-layout', config: 'workspace-layout/vite.config.ts', dist: 'workspace-layout/dist', order: 35 },
  // personal-hub = 个人空间（自 Polaris PersonalHub 迁移）：Supabase 直连的导航/书签/待办
  { id: 'personal-hub', config: 'personal-hub/vite.config.ts', dist: 'personal-hub/dist', order: 36 },
  // voice-radio = AI 无限语音电台（cap.ai.chat 段循环 + MiMo TTS 服务端代理）
  { id: 'voice-radio', config: 'voice-radio/vite.config.ts', dist: 'voice-radio/dist', order: 37 },
  // starter-suggestions = 新会话开场建议池（cap.kv 持久化 + cap.tool.suggestions 供 AI 增改）
  { id: 'starter-suggestions', config: 'starter-suggestions/vite.config.ts', dist: 'starter-suggestions/dist', order: 38 },
  // translate = 翻译（百度翻译 server 代理 + cap.tool.translate 供 AI 调用 + panel）
  { id: 'translate', config: 'translate/vite.config.ts', dist: 'translate/dist', order: 39 },
  // notification-center = 全局通知中心：cap.ui.notify + overlay-root toast + panel
  { id: 'notification-center', config: 'notification-center/vite.config.ts', dist: 'notification-center/dist', order: 40 },
  // deploy-panel = 9826 分析实例一键部署（server 端点是 detached worker 发布器；
  // 仅 PLITE_DEPLOY_PANEL=1 的实例挂载，见 ecosystem.config.cjs 的 9826 env）
  { id: 'deploy-panel', config: 'deploy-panel/vite.config.ts', dist: 'deploy-panel/dist', order: 41 },
  // token-ledger = Token 总用量台账（ai.usage 事件旁听记账 + IndexedDB 持久化
  // + ai-events requests 表历史回填 + panel 看板；纯前端，可卸载可替换）
  { id: 'token-ledger', config: 'token-ledger/vite.config.ts', dist: 'token-ledger/dist', order: 42 },
].sort((a, b) => a.order - b.order);

/** 是否启用（缺省 true）——server-registry 用它过滤 server 半边 */
export function isPluginEnabled(id) {
  const entry = PLUGIN_LIST.find((p) => p.id === id);
  return entry ? entry.enabled !== false : true; // 仅服务端存在的插件（如 agent-runner）视为启用
}
