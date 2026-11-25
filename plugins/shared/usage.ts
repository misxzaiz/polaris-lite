/**
 * usage：上游 usage 帧解析 + ai.usage 载荷构造（含无 usage 时的字符估算兜底）。
 *
 * 抽取自 real-engine（emitUsage/estimateTokens，2026-11-21）。方言知识集中于此：
 * - 缓存字段提取链对齐 simple_ai stream.rs：标准 prompt_tokens_details 优先，
 *   DeepSeek/GLM 变体（prompt_cache_hit_tokens / prompt_cache_miss_tokens）兜底；
 * - 网关未回缓存字段时缺省（0 视为「无数据」不 emit，避免把缓存占比误置 0%）。
 */

/** 上下文估算：Σ消息字符 ÷ 4（中英混合保守近似，对齐 simple_ai CHARS_PER_TOKEN） */
export function estimateTokens(messages: { content: unknown; tool_calls?: unknown }[]): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') chars += m.content.length;
    else if (Array.isArray(m.content)) {
      for (const p of m.content as { text?: string }[]) chars += typeof p?.text === 'string' ? p.text.length : 0;
    }
    if (m.tool_calls !== undefined) chars += JSON.stringify(m.tool_calls).length;
  }
  return Math.ceil(chars / 4);
}

/** 构造 ai.usage 载荷：有 wireUsage 用真实值，否则估算兜底（estimated 标记明示降级） */
export function buildUsagePayload(args: {
  sessionId: string;
  messageId: string;
  messages: { content: unknown; tool_calls?: unknown }[];
  wireUsage: import('../engine-kit/types').WireUsage | null;
  model?: string;
  maxInputTokens?: number;
  startedAt: number;
}): import('../engine-kit/types').AiUsagePayload {
  const { sessionId, messageId, messages, wireUsage, model, maxInputTokens, startedAt } = args;
  const durationMs = Date.now() - startedAt;
  const contextWindow = maxInputTokens && maxInputTokens > 0 ? maxInputTokens : undefined;
  const base = { sessionId, messageId, durationMs, ...(model ? { model } : {}), ...(contextWindow ? { contextWindow } : {}) };

  if (wireUsage && (wireUsage.prompt_tokens !== undefined || wireUsage.completion_tokens !== undefined)) {
    const inputTokens = Math.max(0, Number(wireUsage.prompt_tokens ?? 0));
    const outputTokens = Math.max(0, Number(wireUsage.completion_tokens ?? 0));
    const total = Number(wireUsage.total_tokens ?? inputTokens + outputTokens);
    // 缓存字段提取链：标准 details 优先，DeepSeek/GLM 变体兜底；0 视为「无数据」不下发
    const cached = Number(wireUsage.prompt_tokens_details?.cached_tokens ?? wireUsage.prompt_cache_hit_tokens ?? 0);
    const cacheCreation = Number(wireUsage.prompt_tokens_details?.cache_creation_tokens ?? wireUsage.prompt_cache_miss_tokens ?? 0);
    return {
      ...base,
      inputTokens,
      outputTokens,
      totalTokens: Math.max(0, Number.isFinite(total) ? total : inputTokens + outputTokens),
      ...(Number.isFinite(cached) && cached > 0 ? { cachedTokens: Math.floor(cached) } : {}),
      ...(Number.isFinite(cacheCreation) && cacheCreation > 0 ? { cacheCreationTokens: Math.floor(cacheCreation) } : {}),
    };
  }
  const est = estimateTokens(messages);
  return { ...base, inputTokens: est, outputTokens: 0, totalTokens: est, estimated: true };
}
