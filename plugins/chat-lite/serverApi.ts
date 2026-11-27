/**
 * 跨插件服务端端点登记表（chat-lite 的**唯一**跨插件 HTTP 出处）。
 *
 * 为什么要有这张表：chat-lite 依赖若干插件的 server 半边（对话档、供应商目录、
 * 分享、kv、文件、技能、工具、编排器）。此前这些地址散落在 9 个文件里，改一方
 * 端点不会在另一方的任何门禁里报错——正是 plugin-contract 禁止的「第二条通道」。
 *
 * 现状与边界（如实说明，不假装已是 cap）：
 * - 这些调用走同源 HTTP + 会话 cookie，**没有 per-plugin 授权**；它属于
 *   「服务端执行域」的传输通道，不是可声明的插件能力。
 * - 因此做两件事把风险收窄到可管理：① 地址只在此登记（人一眼能看全耦合面）；
 *   ② 构建期门禁禁止 chat-lite 其它源码出现 `/api/` 字面量（新增耦合必须先
 *   在这里登记，评审时可见）。
 * - 真正的 cap 化（服务端能力经总线暴露、带审计与授权）是后续项：需要给
 *   server 半边加一层 cap 桥。在此之前，插件被禁用 → 端点消失（P0-4）是兜底。
 *
 * owner 标注的是「这个端点的属主插件」，便于判断谁被禁用后哪些功能降级。
 */
export const SRV = {
  /** agent-runner：服务端编排（start/events/approve/interrupt/resume/state） */
  agent: '/api/agent',
  /** chat-store：会话索引与全文（含 live 事件 SSE） */
  chat: '/api/chat',
  /** model-admin + 宿主 providers-api：供应商目录（masked） */
  providers: '/api/providers',
  /** transcript-share：只读分享 */
  share: '/api/share',
  /** kv-store：通用键值（开场白池、通知 inbox） */
  kv: '/api/kv',
  /** file-browser：工作区根与文件树 */
  fs: '/api/fs',
  /** skill-loader：技能存在性与正文 */
  skills: '/api/skills',
  /** agent-bash：工具执行配置（模式/白名单） */
  tool: '/api/tool',
  /** long-memory：长期记忆（开关/条数；会话设置分区读写，同款 HTTP 口径） */
  longMemory: '/api/long-memory',
} as const;
