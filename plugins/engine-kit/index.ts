/**
 * engine-kit —— AI 引擎插件的共享构建时模块（host-slimming-report §2.7 / §4 P0-2）。
 *
 * 定位：**纯函数库**，不是插件、不经 cap 总线、不参与 grants。
 * 解决的问题：新增引擎时被迫手抄 real-engine 的非引擎逻辑——
 * SSE 解析循环（codebuddy 自认抄了 30 行）、usage 方言链（55 行）、
 * 断流重试续写、限值报错揭示、tool_calls 分片聚合、interrupt map 模式。
 * 抽取后新引擎期望成本 ≈ 100-150 行接线层（对照 codebuddy 137 行）。
 *
 * 边界纪律（report §7.5 核查结论）：
 * - 只放纯逻辑：无 fetch、无 store、无插件间引用——依赖面为零，任何插件可直接 import；
 * - 引擎特有决策（供应商选择 / 直连降级 / 独立档）留在各引擎自己那半，kit 不吞引擎；
 * - precedent：shared.plugin-config.ts 已开辟「插件构建期共享模块」路径。
 *
 * 事件词汇表（EVENT_VOCABULARY）见 vocabulary.ts：两层登记（引擎层/编排层），
 * 是 cap.ai.chat 事件流的事实契约——此前 17 种 kind 只存在于实现里，文档零登记。
 */

export type { WireUsage, AiUsagePayload, ToolCallAgg, SseEvent, SseReader, InterruptMap } from './types';
export { estimateTokens, buildUsagePayload } from './usage';
export { createSseReader, isUpstreamDisconnectFrame, aggregateToolCallDelta } from './sse';
export { parseLimitFromError, classifyLimitError } from './limits';
export { createInterruptMap } from './interrupt';
export { EVENT_VOCABULARY, isKnownEventKind, type VocabEntry, type EventLayer } from './vocabulary';
