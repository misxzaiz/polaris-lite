/**
 * cap.ai.chat / cap.agent.loop 事件词汇表 —— AI 对话事件流的事实契约。
 *
 * 背景（host-slimming-report §7.4 实证）：chat-lite 消费 17 种事件 kind，
 * 但此前词汇表不存在于任何契约文档——只在三个引擎实现里各自对齐，且
 * mock-engine 只发 2 种、全量实现仅 real-engine 一家。「新引擎照谁实现」
 * 没有答案。本表把它变成 @sdk 契约。
 *
 * 两层登记（report §7.4 核查结论：同一 kind 可能两层产生）：
 * - ENGINE：引擎插件（cap.ai.chat 提供方）经 cap.ai.chat:event 发出。
 *   如 tool.card 在 codebuddy-engine/server.mjs 由引擎层直发（CLI 侧已有卡片）；
 * - ORCHESTRATOR：编排层（agent-loop）经 cap.agent.loop:event 发出。
 *   审批流/工具执行语义只存在于编排层（引擎做纯管道，不理解工具语义）。
 * 同名 kind 在两层的载荷语义一致——消费者按订阅通道区分来源。
 */

/** 词汇分层 */
export type EventLayer = 'engine' | 'orchestrator';

export interface VocabEntry {
  kind: string;
  layer: EventLayer;
  /** 载荷关键字段（文档用，运行时不校验） */
  payload?: string[];
  /** 语义一句话 */
  desc: string;
}

export const EVENT_VOCABULARY: readonly VocabEntry[] = [
  // ---- 引擎层（cap.ai.chat:event；引擎插件发出） ----
  { kind: 'message.delta', layer: 'engine', payload: ['sessionId', 'messageId', 'delta'], desc: '正文增量（流式 token）' },
  { kind: 'message.reasoning', layer: 'engine', payload: ['sessionId', 'messageId', 'delta'], desc: '思考流增量（reasoning_content，chat-lite 渲染为思考块）' },
  { kind: 'message.done', layer: 'engine', payload: ['sessionId', 'messageId', 'finishReason?', 'partialToolCalls?', 'interrupted?'], desc: '一轮生成收敛（引擎视角）' },
  { kind: 'message.continued', layer: 'engine', payload: ['sessionId', 'messageId'], desc: '断流自动续写后的接续标记' },
  { kind: 'message.truncated', layer: 'engine', payload: ['sessionId', 'messageId'], desc: '输出被截断的如实上报' },
  { kind: 'tool.calls', layer: 'engine', payload: ['sessionId', 'messageId', 'toolCalls[]'], desc: '聚合后的工具调用请求（编排层决策执行）' },
  { kind: 'ai.usage', layer: 'engine', payload: ['sessionId', 'messageId', 'inputTokens', 'outputTokens', 'totalTokens', 'estimated?'], desc: '本轮 token 用量（真实 usage 优先，估算兜底）' },
  { kind: 'stream.error', layer: 'engine', payload: ['sessionId', 'messageId', 'message'], desc: '流级错误（收敛前最后信号）' },
  { kind: 'stream.retry', layer: 'engine', payload: ['sessionId', 'messageId', 'attempt', 'maxAttempts', 'chars'], desc: '断流自动重试提示' },
  { kind: 'engine.status', layer: 'engine', payload: ['sessionId', 'messageId', 'message'], desc: '引擎状态行（冷启动等，喂 chat-lite 看门狗）' },
  { kind: 'tool.card', layer: 'engine', payload: ['sessionId', 'messageId', 'callId', 'name', 'status'], desc: '工具卡直发（引擎侧已具卡片形态时，如 codebuddy CLI）' },
  { kind: 'tool.args.delta', layer: 'engine', payload: ['sessionId', 'messageId', 'callId', 'delta'], desc: '工具参数增量（大参数工具流式预览数据源，如 render 的 HTML）' },
  // ---- 编排层（cap.agent.loop:event；agent-loop 发出） ----
  { kind: 'tool.card', layer: 'orchestrator', payload: ['sessionId', 'messageId', 'callId', 'name', 'status'], desc: '工具卡落块（编排层创建/更新工具卡状态）' },
  { kind: 'tool.result', layer: 'orchestrator', payload: ['sessionId', 'messageId', 'callId', 'result'], desc: '工具执行结果回填' },
  { kind: 'tool.approval.required', layer: 'orchestrator', payload: ['sessionId', 'messageId', 'callId', 'name', 'command', 'argsJson'], desc: '工具审批请求（awaiting 态）' },
  { kind: 'tool.approval.resolved', layer: 'orchestrator', payload: ['sessionId', 'messageId', 'callId', 'decision'], desc: '审批决议（approved/denied）' },
  { kind: 'context.snapshot', layer: 'orchestrator', payload: ['sessionId', 'messageId'], desc: '上下文水位快照' },
  { kind: 'context.compacting', layer: 'orchestrator', payload: ['sessionId', 'messageId'], desc: '上下文压缩进行中' },
  { kind: 'context.compacted', layer: 'orchestrator', payload: ['sessionId', 'messageId'], desc: '上下文压缩完成' },
  { kind: 'context.compact-failed', layer: 'orchestrator', payload: ['sessionId', 'messageId', 'reason'], desc: '上下文压缩失败' },
] as const;

/** 消费端校验辅助：kind 是否在词汇表内（未知 kind 应告警而非静默丢弃） */
export function isKnownEventKind(kind: string): boolean {
  return EVENT_VOCABULARY.some((e) => e.kind === kind);
}
