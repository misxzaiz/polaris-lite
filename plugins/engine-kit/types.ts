/**
 * engine-kit 类型定义。
 * 与 real-engine 内联类型同源（2026-11-21 抽取），引擎经 @sdk 风格引用。
 */

/** 上游 usage 帧（OpenAI 兼容 + DeepSeek/GLM 缓存字段变体） */
export interface WireUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_creation_tokens?: number };
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}

/** ai.usage 事件载荷（chat-lite ContextMeter 的数据源） */
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

/** tool_calls 分片聚合槽（index 维度拼接 id / name / arguments） */
export interface ToolCallAgg {
  id: string;
  name: string;
  arguments: string;
}

/** SSE 流上解析出的一条 data 事件（JSON 已剥壳） */
export interface SseEvent {
  /** raw data 行（'data:' 已剥），未解析成功时为 null */
  raw: string | null;
  /** [DONE] 标记（不算事件，reader 用它置 sawDoneMarker） */
  done: false;
}

/** SSE 读取器：逐行喂 data: 帧，自动处理半行缓冲 */
export interface SseReader {
  /** 喂入一 chunk 文本；返回本 chunk 内完整解析出的 data 列表（'[DONE]' 记为 done 标志） */
  push(chunk: string): { data: string | null; done: boolean }[];
  /** 是否已见 [DONE] 或 finish_reason 级结束标记 */
  sawDone: boolean;
  markDone(): void;
}

/** interrupt 注册表工厂的实例形状（Map<streamKey, abort>） */
export interface InterruptMap {
  set(key: string, abort: () => void): void;
  get(key: string): (() => void) | undefined;
  delete(key: string): void;
  keys(): string[];
  /** 按会话中断全部流（streamKey 前缀 `<sessionId>::`） */
  abortSession(sessionId: string): void;
}
