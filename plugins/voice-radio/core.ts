/**
 * voice-radio — 共享类型与常量（自 Polaris voiceBroadcast 移植，裁剪到「无限播报」最小核）。
 */

/** 播报会话状态机状态 */
export type RadioStatus = 'idle' | 'starting' | 'playing' | 'generating' | 'stopping' | 'error';

/** 播报方向 key */
export type DirectionKind = 'study' | 'story' | 'tech' | 'news' | 'custom';

/** 播报方向（预设 key + 自由文本） */
export interface RadioDirection {
  kind: DirectionKind;
  text: string;
}

/** 单句队列项（播放器内部） */
export interface QueueItem {
  id: string;
  text: string;
  url: string | null;
  status: 'pending' | 'synthesizing' | 'ready' | 'playing' | 'done' | 'failed';
  /** 代际：stop() 时 ++，晚到音频校验用 */
  gen: number;
  /** 合成失败已重试次数（失败重试 1 次后仍失败才跳过） */
  synthAttempts?: number;
  /** 本句合成语气（来自 AI 的 [voice:…] 段标注；空 = 会话默认） */
  style?: string;
}

/** 字幕跟读单行 */
export interface TranscriptLine {
  id: string;
  text: string;
  status: QueueItem['status'];
}

/** 字幕跟读快照（null = 当前无可展示文稿） */
export interface RadioTranscript {
  lines: TranscriptLine[];
  /** 当前播放行索引（-1 = 无在播句） */
  currentIndex: number;
}

/** 停止原因（UI 反馈用） */
export type StopReason = 'manual' | 'max-rounds' | 'max-seconds' | 'sleep' | 'finished' | 'error';

/** 控制器订阅快照（面板渲染数据源） */
export interface RadioSnapshot {
  status: RadioStatus;
  direction: RadioDirection;
  segmentCount: number;
  segmentIndex: number;
  nowPlayingText: string | null;
  error: string | null;
  startedAt: number;
  transcript: RadioTranscript | null;
  sleepUntil: number;
  sleepAfterSegment: boolean;
  stopReason: StopReason | null;
  paused: boolean;
}

/** 方向 key → 中文标签 */
export const DIRECTION_LABEL: Record<DirectionKind, string> = {
  study: '学习',
  story: '故事',
  tech: '技术',
  news: '新闻',
  custom: '自定义',
};

/** 预置音色（与服务端 PRESET_VOICES 一致的静态兜底；动态表经 /api/voice-radio/voices 拉取） */
export const MIMO_VOICES: ReadonlyArray<{ id: string; label: string; desc: string }> = [
  { id: '冰糖', label: '冰糖', desc: '中文女声 · 温婉' },
  { id: '茉莉', label: '茉莉', desc: '中文女声' },
  { id: '苏打', label: '苏打', desc: '中文男声' },
  { id: '白桦', label: '白桦', desc: '中文男声' },
  { id: 'Mia', label: 'Mia', desc: '英文女声' },
  { id: 'Chloe', label: 'Chloe', desc: '英文女声' },
  { id: 'Milo', label: 'Milo', desc: '英文男声' },
  { id: 'Dean', label: 'Dean', desc: '英文男声' },
  { id: 'mimo_default', label: 'MiMo-默认', desc: '中英混合自动' },
];

/** 纠正历史存量音色值（「MiMo-默认」显示名曾被当 id 持久化，API 会 400） */
export function normalizeVoiceId(voice: string): string {
  return voice === 'MiMo-默认' ? 'mimo_default' : voice;
}

/** 预取流水线：播放当前句时最多保持多少句处于「合成中/已合成」 */
export const PREFETCH_DEPTH = 2;

/** 单句合成等待上限（ms）；超时该句标记失败跳过，不断链 */
export const SYNTH_TIMEOUT_MS = 20000;

/** 单句合成失败自动重试次数上限（1 = 失败后重试一次） */
export const SYNTH_MAX_RETRIES = 1;

/** 段级低水位（句数）：队列剩余未播句数 ≤ 此值时提前生成下一段（消除段间静默） */
export const SEGMENT_LOOKAHEAD_SENTENCES = 3;

/** 单段 AI 生成最长等待（ms），超时视作该段失败 */
export const SEGMENT_TIMEOUT_MS = 90000;

/** 连续失败阈值：达到则进入 error 态 */
export const MAX_CONSECUTIVE_ERRORS = 3;

/** 播报方向预设模板（{direction} 占位；原文自 Polaris constants.ts） */
const PRESET_PROMPTS: Record<DirectionKind, string> = {
  study: `你是一个「语音播报」内容生成助手。方向：{direction}。
规则：
1. 一次性输出一段可朗读的普通话内容（建议 150~350 字），围绕该方向，信息密度高、衔接自然。
2. 只输出正文本身，不要代码围栏、不要表格、不要 Markdown 语法符号、不要任务列表；确需列表时用口语化表述。
3. 遇到不宜朗读的内容（代码、表格、公式）自行改写为口语，或跳过。
4. 段落结尾用句号。`,
  story: `你是一个「语音播报」故事讲述者。方向：{direction}。
规则：
1. 一次性讲一段 150~350 字的普通话故事，情节连贯、有画面感。
2. 只输出正文本身，不要代码围栏、不要 Markdown、不要标题。
3. 每段结尾留一个自然悬念，为下一段衔接。
4. 不要问用户问题，不要重复开场白。`,
  tech: `你是一个「语音播报」技术讲解者。方向：{direction}。
规则：
1. 一次性讲一段 150~350 字的普通话技术内容，概念准确、通俗。
2. 只输出正文本身，不要代码围栏、不要表格、不要行内代码符号；技术名词保留原名。
3. 代码示例改为口述「例如…」。
4. 不要问用户问题。`,
  news: `你是一个「语音播报」新闻主播。方向：{direction}。
规则：
1. 一次性播一段 150~350 字的普通话新闻简报，事实清晰、节奏明快。
2. 只输出正文本身，不要 Markdown、不要列表、不要引用。
3. 不要评论，不要问用户问题。`,
  custom: `你是一个「语音播报」内容生成助手。方向：{direction}。
规则：
1. 一次性输出一段可朗读的普通话内容（建议 150~350 字），围绕该方向，信息密度高、衔接自然。
2. 只输出正文本身，不要代码围栏、不要表格、不要 Markdown 语法符号、不要任务列表。
3. 遇不宜朗读的内容自行改写为口语，或跳过。
4. 段落结尾用句号。`,
};

/** 根据方向 key 取提示词模板（含 {direction} 占位替换） */
export function promptForDirection(key: DirectionKind, direction: string): string {
  const preset = PRESET_PROMPTS[key] ?? PRESET_PROMPTS.custom;
  return preset.split('{direction}').join(direction);
}

/**
 * AI 自行配音协议：要求 AI 在每段正文**之前**输出一行语气标注 `[voice:…]`，
 * 前端剥离该行后把标注作为 MiMo style 指令（或映射为文本音频标签）合成。
 * MiMo 实测支持：句首 (风格) 标签 + 句中 [情绪] 标签 + 自然语言 style。
 */
export const VOICE_DIRECTION_SUFFIX = `
输出格式（严格遵守）：
0. 第一行输出语气标注，格式固定为 [voice:<播音风格描述>]，例如 [voice:低沉缓慢，像纪录片旁白]、[voice:轻快明亮，像早间新闻]。风格要贴合内容情绪，相邻段落不要千篇一律。
1. 从第二行开始输出正文本身（150~350 字），正文中不要出现方括号标注。`;

/** 从段文本中剥离首行 [voice:…] 标注，返回 { style, text }；无标注则 style 为空 */
export function extractVoiceDirection(text: string): { style: string; text: string } {
  const m = /^\s*\[voice:([^\]]+)\]\s*\n?/.exec(text);
  if (!m) return { style: '', text: text.trim() };
  return { style: m[1].trim().slice(0, 120), text: text.slice(m[0].length).trim() };
}

// ── 背景音乐（Web Audio 轻量垫乐；服务端离线合成 WAV，前端 <audio> 循环） ──

/** BGM 风格预设（按方向自动匹配，也可面板手选） */
export const BGM_STYLES = ['auto', 'none', 'calm', 'upbeat', 'story', 'tech', 'news'] as const;
export type BgmStyle = (typeof BGM_STYLES)[number];

/** 方向 → 默认 BGM 风格（auto 时按此映射） */
export const BGM_BY_DIRECTION: Record<DirectionKind, Exclude<BgmStyle, 'auto' | 'none'>> = {
  study: 'calm',
  story: 'story',
  tech: 'tech',
  news: 'upbeat',
  custom: 'calm',
};

/** BGM 循环时长（秒）：服务端一次合成，前端循环播放 */
export const BGM_LOOP_SECONDS = 48;

/** 换台岔题指令（同会话切换方向，不停声） */
export function promptForSwitchTopic(direction: string): string {
  return `用户换台了：立即切换主题，开始播报新方向「${direction}」。不要总结、告别或提及旧话题，直接从新内容第一句讲起（150~350 字）。`;
}

/** 听众插话指令：先直接回应插话（一两句），再自然接续当前话题播报 */
export function promptForInterject(text: string): string {
  return `这是听众插话：「${text}」。请先用一两句话直接回应插话，然后自然接续当前话题的播报。`;
}

/** 听众临时补充指令：立即中止当前内容，接续讲补充内容 */
export function promptForSupplement(text: string): string {
  return `听众临时补充了内容：「${text}」。请立即放下当前正在讲的内容，自然地把这个补充融入接下来的播报（先简短承接这句话，再继续当前方向的播报）。`;
}

/** 工具查证模式附加系统提示（开启时注入每段 system） */
export const TOOL_MODE_SYSTEM_SUFFIX = `
另外，本次会话可以使用工具（bash/browser/files/MCP 等）。纪律：
- 仅当播报内容需要事实核实、数据支撑或最新信息时才调用工具；查完立即继续输出播报正文。
- 每段仍以可朗读正文收尾；不要输出工具调用说明给听众。`;

/** 清洗 TTS 文本：去 Markdown/代码/链接等不宜朗读符号（对齐 Polaris cleanTextForSpeech + 表格过滤） */
export function sanitizeForSpeech(text: string): string {
  let cleaned = text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]+`/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1')
    .replace(/_{1,2}([^_]+)_{1,2}/g, '$1')
    .replace(/~~[^~]+~~/g, '')
    .replace(/^>\s*/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/^[-*_]{3,}$/gm, '')
    .replace(/<[^>]+>/g, '');
  // 丢弃 Markdown 表格块（| --- | 成行段落）与残留竖线
  cleaned = cleaned
    .split('\n')
    .filter((line) => !/^\s*\|/.test(line))
    .join('\n')
    .replace(/\s*\|\s*/g, ' ');
  return cleaned.replace(/\n{2,}/g, '\n').replace(/\s{2,}/g, ' ').trim();
}

/** 按句末标点切句（保留可朗读语义单元） */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？!?；;\n])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 生成短随机 id（句/消息用；crypto.randomUUID 不可用时降级） */
export function shortId(prefix: string): string {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return `${prefix}-${crypto.randomUUID().slice(0, 13)}`;
  } catch { /* 降级 */ }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}
