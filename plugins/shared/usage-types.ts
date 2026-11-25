/** usage 相关类型（自 engine-kit/types 复制；shared 目录不得引用插件目录） */

export interface WireUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_creation_tokens?: number };
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}

export interface AiUsagePayload {
  sessionId: string;
  messageId: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  durationMs: number;
  estimated?: boolean;
  cachedTokens?: number;
  cacheCreationTokens?: number;
  model?: string;
  contextWindow?: number;
}
