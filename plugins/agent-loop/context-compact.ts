/**
 * 上下文压缩（simple_ai/compact.rs 语义的纯 TS 移植）。
 *
 * spec：docs/context-insight-plan.md §5.2。与 Rust 版的对齐点：
 * - 触发基准 = 最近一轮 input_tokens（≈ 当前上下文大小），无 usage 时字符 ÷4 估算；
 * - 压缩范围 [1, len-keepRecent)，按工具配对边界回退（不切断 assistant.tool_calls 与其 tool 结果的配对）；
 * - 区间 < 4 条跳过；压缩后仍超阈 → 会话级熔断；
 * - 摘要非流式、显式 max_tokens、截断重试一次；超预算按 turn 边界滚动分段（≤12 段）；
 * - 失败回滚（非破坏），绝不丢历史。
 *
 * 本模块**零 DOM、零 React、零副作用**（fetch 由调用方注入），纯函数可单测。
 */

/** 摘要输入序列化截断上限（对齐 compact.rs SERIALIZE_*） */
const SERIALIZE_TOOL_RESULT_CAP = 1000;
const SERIALIZE_TOOL_RESULT_HEAD_CAP = SERIALIZE_TOOL_RESULT_CAP * 3 / 5;
const SERIALIZE_TOOL_RESULT_TAIL_CAP = SERIALIZE_TOOL_RESULT_CAP * 2 / 5;
const SERIALIZE_TOOL_ARGS_CAP = 200;
/** 字符估算 token 除数（中英混合保守近似） */
export const CHARS_PER_TOKEN = 4;
/** 分段预算占窗口比例 & 段数上限 */
const SEGMENT_INPUT_BUDGET_RATIO = 0.5;
const MAX_SEGMENTS = 12;
/** 待压缩区间最小消息数（防退化自摘要） */
export const COMPACT_MIN_RANGE = 4;
/** 摘要输出预算（截断时翻倍重试一次） */
export const SUMMARY_MAX_TOKENS = 2048;
export const SUMMARY_RETRY_MAX_TOKENS = 4096;

/** shadow transcript 消息（与 agent-loop 的 ShadowMsg 结构一致，此处放宽为最小面） */
export interface ShadowMsg {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  name?: string;
}

/** 每轮 token 用量（spec §4.1 ai.usage 的压缩相关子集） */
export interface UsageSample {
  inputTokens: number;
  outputTokens: number;
  estimated?: boolean;
  at: number;
  durationMs: number;
}

/** 会话级压缩状态（UsageAccumulator + 熔断，对齐 compact.rs） */
export class UsageAccumulator {
  totalInput = 0;
  lastInput = 0;
  /** 压缩后冷却：下一轮真实 usage 刷新前不重复触发 */
  private cooled = false;
  /** 压缩无效熔断：刚压完仍超阈 → 本会话不再自动压 */
  exhausted = false;
  /** 压缩过标记（snapshot 展示用；null=从未压缩） */
  roundsSinceCompact: number | null = null;

  add(inputTokens: number): void {
    this.totalInput += Math.max(0, inputTokens);
    this.lastInput = Math.max(0, inputTokens);
    this.cooled = false;
  }

  resetLast(): void {
    this.lastInput = 0;
    this.cooled = true;
    this.roundsSinceCompact = 0;
  }

  /** 压缩后又一轮仍超阈 → 熔断（对齐 chat_loop 的 rounds_since_compact==Some(1)） */
  notePostCompactRound(stillOverThreshold: boolean): void {
    if (this.roundsSinceCompact === null) return;
    this.roundsSinceCompact += 1;
    if (stillOverThreshold && this.roundsSinceCompact >= 1) this.exhausted = true;
  }

  /** 最近一轮 input（无则估算）是否达阈值 */
  shouldCompact(window: number, threshold: number, messages: ShadowMsg[]): boolean {
    if (this.exhausted || this.cooled) return false;
    const current = this.lastInput > 0 ? this.lastInput : estimateTokens(messages);
    return current >= Math.floor(window * threshold);
  }
}

/** 粗粒度 token 估算：全部消息 content / tool_calls 字符数 ÷ CHARS_PER_TOKEN */
export function estimateTokens(messages: ShadowMsg[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += m.content?.length ?? 0;
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function isAssistantWithToolCalls(m: ShadowMsg): boolean {
  return m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
}

/**
 * 选取待压缩区间 [start, end)（对齐 compact.rs select_compact_range）：
 * - start=1：system 永不入摘要；
 * - end = len - keepRecent，再按工具配对边界回退；
 * - 区间过小 → null（跳过本轮）。
 */
export function selectCompactRange(messages: ShadowMsg[], keepRecent: number): { start: number; end: number } | null {
  const len = messages.length;
  let end = len - Math.max(1, keepRecent);
  // a) 保留区首条若是孤儿 tool，把整组回退进保留区
  while (end > 1 && end < len && messages[end]?.role === 'tool') end -= 1;
  // b) 摘要区间尾若是孤儿 assistant(tool_calls)，回退到它之前
  while (end > 1 && isAssistantWithToolCalls(messages[end - 1])) end -= 1;
  if (end <= 1 || end - 1 < COMPACT_MIN_RANGE) return null;
  return { start: 1, end };
}

/** 多字节安全截断 */
function truncateChars(s: string, cap: number): string {
  const chars = Array.from(s);
  if (chars.length <= cap) return s;
  return `${chars.slice(0, cap).join('')}…[truncated]`;
}

/** 保头保尾截断（长文结论通常在结尾） */
function truncateHeadTail(s: string, headCap: number, tailCap: number): string {
  const chars = Array.from(s);
  if (chars.length <= headCap + tailCap) return s;
  const head = chars.slice(0, headCap).join('');
  const tail = chars.slice(chars.length - tailCap).join('');
  return `${head}…[truncated, total ${chars.length} chars]…${tail}`;
}

/** 序列化单条消息为摘要输入行（对齐 compact.rs serialize_message） */
export function serializeMessage(m: ShadowMsg): string {
  const parts: string[] = [];
  if (m.content) {
    parts.push(m.role === 'tool' ? truncateHeadTail(m.content, SERIALIZE_TOOL_RESULT_HEAD_CAP, SERIALIZE_TOOL_RESULT_TAIL_CAP) : m.content);
  }
  if (m.tool_calls) {
    for (const tc of m.tool_calls) {
      parts.push(`调用工具 ${tc.function?.name ?? '?'}(${truncateChars(tc.function?.arguments ?? '', SERIALIZE_TOOL_ARGS_CAP)})`);
    }
  }
  return `[${m.role}]: ${parts.join(' ')}`;
}

/**
 * 按 turn 边界切段（只在 user 消息前切，永不切断工具配对）。
 * 段数达上限前一段即停，余下并入最后一段。
 */
export function segmentRange(messages: ShadowMsg[], start: number, end: number, perSegmentBudget: number): Array<{ start: number; end: number }> {
  const segments: Array<{ start: number; end: number }> = [];
  if (start >= end) return segments;
  const budget = Math.max(1, perSegmentBudget);
  let segStart = start;
  let acc = 0;
  for (let i = start; i < end; i += 1) {
    acc += Math.ceil((messages[i].content?.length ?? 0) / CHARS_PER_TOKEN);
    const atUserBoundary = i + 1 < end && messages[i + 1]?.role === 'user';
    const underCap = segments.length + 1 < MAX_SEGMENTS;
    if (acc >= budget && atUserBoundary && underCap) {
      segments.push({ start: segStart, end: i + 1 });
      segStart = i + 1;
      acc = 0;
    }
  }
  segments.push({ start: segStart, end });
  return segments;
}

/** 交接摘要指令（仿 codex compact prompt 语义，对齐 compact.rs COMPACT_INSTRUCTION） */
export const COMPACT_INSTRUCTION = 'You are compacting a conversation history. Summarize the following messages into a concise handoff summary: key decisions, established facts, file paths touched, outstanding errors, and the current task state. Reply with ONLY the summary, no preamble.';
/** 滚动分段合并指令 */
export const COMPACT_ROLLING_INSTRUCTION = 'You are incrementally compacting a long conversation. You are given an existing summary and a new segment of raw conversation. Merge them into a single updated handoff summary that preserves all key decisions, established facts, file paths touched, outstanding errors, and the current task state from BOTH the existing summary and the new segment. Reply with ONLY the merged summary, no preamble.';
/** 截断重试时追加的指令 */
export const COMPACT_RETRY_SUFFIX = '\nOutput the summary directly. Do NOT show any thinking or reasoning process.';

/** 非流式补全调用（由 agent-loop 注入实现：走 /api/model-relay，key 在服务端） */
export type NonStreamComplete = (body: { system: string; user: string; maxTokens: number }) => Promise<{
  text: string;
  truncated: boolean;
  inputTokens?: number;
}>;

/** 单次摘要请求：空文本区分截断（可重试）与真空响应 */
async function requestSummaryOnce(
  complete: NonStreamComplete,
  instruction: string,
  historyText: string,
  maxTokens: number,
): Promise<string> {
  const res = await complete({ system: instruction, user: historyText, maxTokens });
  if (res.text.trim()) return res.text;
  throw new Error(res.truncated ? '__COMPACT_TRUNCATED__' : '__COMPACT_EMPTY__');
}

/**
 * 滚动分段摘要：区间不超预算 → 单次；超预算 → 按 turn 边界逐段摘要并滚动合并。
 * 对齐 compact.rs summarize_range_rolling。maxTokens/suffix 由截断重试层注入。
 */
export async function summarizeRange(
  messages: ShadowMsg[],
  start: number,
  end: number,
  window: number,
  complete: NonStreamComplete,
  maxTokens: number = SUMMARY_MAX_TOKENS,
  suffix: string = '',
): Promise<string> {
  const perSegmentBudget = Math.floor(window * SEGMENT_INPUT_BUDGET_RATIO);
  const segments = segmentRange(messages, start, end, perSegmentBudget);
  const serializeSeg = (s: number, e: number): string => messages.slice(s, e).map(serializeMessage).join('\n\n');

  if (segments.length <= 1) {
    const { start: s, end: e } = segments[0] ?? { start, end };
    return requestSummaryOnce(complete, `${COMPACT_INSTRUCTION}${suffix}`, serializeSeg(s, e), maxTokens);
  }

  let running = '';
  for (const { start: s, end: e } of segments) {
    const segText = serializeSeg(s, e);
    running = running
      ? await requestSummaryOnce(
          complete,
          `${COMPACT_ROLLING_INSTRUCTION}${suffix}`,
          `<existing_summary>\n${running}\n</existing_summary>\n\n<new_segment>\n${segText}\n</new_segment>`,
          maxTokens,
        )
      : await requestSummaryOnce(complete, `${COMPACT_INSTRUCTION}${suffix}`, segText, maxTokens);
  }
  return running;
}

/**
 * 摘要请求 + 截断重试（对齐 compact.rs request_summary）。
 * 区间估算超窗口预算 → 滚动分段（summarizeRange）；否则单次摘要。
 * 抛错时 err.message === '__COMPACT_TRUNCATED__' 表示两次都截断（调用方照常回滚）。
 */
export async function requestSummaryWithRetry(
  complete: NonStreamComplete,
  messages: ShadowMsg[],
  start: number,
  end: number,
  window: number,
): Promise<string> {
  const run = (maxTokens: number, suffix: string): Promise<string> => summarizeRange(messages, start, end, window, complete, maxTokens, suffix);
  try {
    return await run(SUMMARY_MAX_TOKENS, '');
  } catch (err) {
    if (!(err instanceof Error && err.message === '__COMPACT_TRUNCATED__')) throw err;
    return run(SUMMARY_RETRY_MAX_TOKENS, COMPACT_RETRY_SUFFIX);
  }
}

export interface CompactOutcome {
  ok: boolean;
  summary?: string;
  removedMessages?: number;
  tokensBefore?: number;
  tokensAfter?: number;
  error?: string;
}

/**
 * 压缩 shadow transcript：把 [start, end) 替换为单条 [compacted summary] user 消息。
 * 非破坏：摘要失败/为空时回滚原消息。
 * keepRecent：尾部保留消息条数（会话策略，最小 2）。
 * window：上下文窗口（token）——决定滚动分段的每段预算（超预算按 turn 边界切段）。
 */
export async function compactShadow(
  shadow: ShadowMsg[],
  window: number,
  keepRecent: number,
  complete: NonStreamComplete,
): Promise<CompactOutcome> {
  const range = selectCompactRange(shadow, Math.max(2, keepRecent));
  if (!range) return { ok: false, error: 'range-too-small' };
  const { start, end } = range;
  const snapshot = shadow.slice();
  const tokensBefore = estimateTokens(shadow);
  try {
    const summary = (await requestSummaryWithRetry(complete, shadow, start, end, window)).trim();
    if (!summary) {
      return { ok: false, error: 'empty-summary' };
    }
    shadow.splice(start, end - start, { role: 'user', content: `[compacted summary]\n${summary}` });
    return { ok: true, summary, removedMessages: end - start, tokensBefore, tokensAfter: estimateTokens(shadow) };
  } catch (err) {
    // 回滚：恢复原消息（非破坏）
    shadow.length = 0;
    shadow.push(...snapshot);
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg === '__COMPACT_EMPTY__' ? 'empty-summary' : msg };
  }
}
