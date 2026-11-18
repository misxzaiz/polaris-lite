/**
 * 模型能力自动识别（结论合并层）。
 *
 * 分工（密钥下沉后）：
 * - **服务端**负责真实探测：/api/providers/probe 拿服务端的 key 去打上游，
 *   返回 catalogIds 与逐模型 {vision, effort} 结论（见 server/providers-api.mjs）；
 * - **本模块**只做纯计算：内置知识表兜底 + 结论合并 + 可读 notes，
 *   不含任何网络请求，因此可以在浏览器里安全执行（也不需要 key）。
 *
 * 三级来源（可信度递增，后者覆盖前者）：
 * 1. builtin —— 内置知识表（离线可用）；
 * 2. catalog —— 上游 /models 目录（只用于确认模型存在性）；
 * 3. probe   —— 真实请求实测（vision：1x1 PNG；effort：reasoning_effort=low）。
 *
 * 约束：probe 失败 ≠ 能力为无；失败时保留原值（宁缺毋错）。人工编辑值（detected=manual）永不被覆盖。
 */
import type { ModelCapabilities, ModelInfo } from './index';

/** 服务端探测事实（不含 key、不含请求细节） */
export interface ProbeFacts {
  catalogIds: string[] | null;
  notes: string[];
  probes: Record<string, { vision: boolean | null; effort: string | null | 'unknown' }>;
}

/** ② builtin：常见模型家族静态知识表（前缀匹配；离线兜底） */
const BUILTIN_TABLE: { match: RegExp; caps: Partial<ModelCapabilities> }[] = [
  // OpenAI 家族
  { match: /^gpt-4o-mini/, caps: { maxInputTokens: 128000, maxOutputTokens: 16384, effort: null, vision: true } },
  { match: /^gpt-4o/, caps: { maxInputTokens: 128000, maxOutputTokens: 16384, effort: null, vision: true } },
  { match: /^gpt-4\.1-mini/, caps: { maxInputTokens: 1000000, maxOutputTokens: 32768, effort: null, vision: true } },
  { match: /^gpt-4\.1/, caps: { maxInputTokens: 1000000, maxOutputTokens: 32768, effort: null, vision: true } },
  { match: /^o3-mini/, caps: { maxInputTokens: 200000, maxOutputTokens: 100000, effort: 'medium', vision: false } },
  { match: /^o3/, caps: { maxInputTokens: 200000, maxOutputTokens: 100000, effort: 'medium', vision: true } },
  { match: /^o1-mini/, caps: { maxInputTokens: 128000, maxOutputTokens: 65536, effort: 'medium', vision: false } },
  { match: /^o1/, caps: { maxInputTokens: 200000, maxOutputTokens: 100000, effort: 'medium', vision: true } },
  { match: /^gpt-4-turbo/, caps: { maxInputTokens: 128000, maxOutputTokens: 4096, effort: null, vision: true } },
  { match: /^gpt-4/, caps: { maxInputTokens: 8192, maxOutputTokens: 8192, effort: null, vision: false } },
  { match: /^gpt-3\.5-turbo/, caps: { maxInputTokens: 16385, maxOutputTokens: 4096, effort: null, vision: false } },
  // Anthropic 家族
  { match: /^claude-opus-4/, caps: { maxInputTokens: 200000, maxOutputTokens: 32000, effort: 'high', vision: true } },
  { match: /^claude-sonnet-4/, caps: { maxInputTokens: 200000, maxOutputTokens: 64000, effort: 'medium', vision: true } },
  { match: /^claude-3\.7-sonnet/, caps: { maxInputTokens: 200000, maxOutputTokens: 64000, effort: 'medium', vision: true } },
  { match: /^claude-3\.5-sonnet/, caps: { maxInputTokens: 200000, maxOutputTokens: 8192, effort: null, vision: true } },
  { match: /^claude-3\.5-haiku/, caps: { maxInputTokens: 200000, maxOutputTokens: 8192, effort: null, vision: true } },
  { match: /^claude-3-opus/, caps: { maxInputTokens: 200000, maxOutputTokens: 4096, effort: null, vision: true } },
  { match: /^claude-3-haiku/, caps: { maxInputTokens: 200000, maxOutputTokens: 4096, effort: null, vision: false } },
  // DeepSeek 家族
  { match: /^deepseek-chat/, caps: { maxInputTokens: 65536, maxOutputTokens: 8192, effort: null, vision: false } },
  { match: /^deepseek-reasoner/, caps: { maxInputTokens: 65536, maxOutputTokens: 8192, effort: 'medium', vision: false } },
  // Google 家族
  { match: /^gemini-2\.5-pro/, caps: { maxInputTokens: 1048576, maxOutputTokens: 65536, effort: 'medium', vision: true } },
  { match: /^gemini-2\.5-flash/, caps: { maxInputTokens: 1048576, maxOutputTokens: 65536, effort: 'low', vision: true } },
  { match: /^gemini-2\.0-flash/, caps: { maxInputTokens: 1048576, maxOutputTokens: 8192, effort: null, vision: true } },
  { match: /^gemini-1\.5-pro/, caps: { maxInputTokens: 2097152, maxOutputTokens: 8192, effort: null, vision: true } },
  { match: /^gemini-1\.5-flash/, caps: { maxInputTokens: 1048576, maxOutputTokens: 8192, effort: null, vision: true } },
  // 国产常见
  { match: /^qwen-max/, caps: { maxInputTokens: 32768, maxOutputTokens: 8192, effort: null, vision: false } },
  { match: /^qwen-plus/, caps: { maxInputTokens: 131072, maxOutputTokens: 8192, effort: null, vision: false } },
  { match: /^qwen-turbo/, caps: { maxInputTokens: 1000000, maxOutputTokens: 8192, effort: null, vision: false } },
  { match: /^qwen-vl/, caps: { maxInputTokens: 32768, maxOutputTokens: 8192, effort: null, vision: true } },
  { match: /^qwen2\.5-vl/, caps: { maxInputTokens: 131072, maxOutputTokens: 8192, effort: null, vision: true } },
  { match: /^qwen3(?!\.)/, caps: { maxInputTokens: 131072, maxOutputTokens: 24576, effort: 'medium', vision: false } },
  { match: /^qwen2\.5(?!\.)/, caps: { maxInputTokens: 131072, maxOutputTokens: 8192, effort: null, vision: false } },
  { match: /^glm-4-plus/, caps: { maxInputTokens: 128000, maxOutputTokens: 4096, effort: null, vision: false } },
  { match: /^glm-4v/, caps: { maxInputTokens: 8192, maxOutputTokens: 1024, effort: null, vision: true } },
  { match: /^glm-4/, caps: { maxInputTokens: 128000, maxOutputTokens: 4096, effort: null, vision: false } },
  { match: /^moonshot-v1-(8k)/, caps: { maxInputTokens: 8000, maxOutputTokens: 4096, effort: null, vision: false } },
  { match: /^moonshot-v1-(32k)/, caps: { maxInputTokens: 32000, maxOutputTokens: 4096, effort: null, vision: false } },
  { match: /^moonshot-v1-(128k)/, caps: { maxInputTokens: 128000, maxOutputTokens: 4096, effort: null, vision: false } },
  // MOSI nex 家族（中转聚合，参数随上游；保守默认不猜）
  { match: /^nex/, caps: { maxInputTokens: 0, maxOutputTokens: 0, effort: null, vision: false } },
];

function builtinLookup(modelId: string): Partial<ModelCapabilities> | null {
  const hit = BUILTIN_TABLE.find((e) => e.match.test(modelId));
  return hit ? { ...hit.caps } : null;
}

/** 合并一层结论：patch 优先；人工值（detected=manual）原样保留 */
function mergeCaps(
  base: ModelCapabilities,
  patch: Partial<ModelCapabilities>,
  source: ModelCapabilities['detected'],
): ModelCapabilities {
  if (base.detected === 'manual') return { ...base };
  return {
    maxInputTokens: patch.maxInputTokens ?? base.maxInputTokens,
    maxOutputTokens: patch.maxOutputTokens ?? base.maxOutputTokens,
    effort: patch.effort !== undefined ? patch.effort : (base.effort ?? null),
    vision: patch.vision ?? base.vision ?? false,
    detected: source,
  };
}

const EMPTY_CAPS: ModelCapabilities = { maxInputTokens: 0, maxOutputTokens: 0, effort: null, vision: false };

/**
 * 把服务端探测事实合并进单个模型的能力表，返回新模型 + 可读 notes。
 * 纯函数：同入参必得同结果，便于测试。
 */
export function mergeModelCaps(model: ModelInfo, facts: ProbeFacts): { model: ModelInfo; notes: string[] } {
  const notes: string[] = [];
  const base = model.capabilities ?? EMPTY_CAPS;

  // ① builtin 兜底
  const builtin = builtinLookup(model.id);
  let caps = builtin
    ? mergeCaps({ ...EMPTY_CAPS, ...base }, builtin, 'builtin')
    : { ...EMPTY_CAPS, ...base };
  if (builtin) notes.push('内置知识表命中');

  // ② catalog：只确认存在性，不改能力值
  if (facts.catalogIds && !facts.catalogIds.includes(model.id)) {
    notes.push('⚠ 上游目录未列出该模型（可能是聚合中转的别名）');
  }

  const probe = facts.probes?.[model.id];
  if (probe) {
    // ③ vision
    if (probe.vision === true || probe.vision === false) {
      caps = mergeCaps(caps, { vision: probe.vision }, 'probe');
      notes.push(`图片输入：${probe.vision ? '支持' : '不支持'}（实测）`);
    } else {
      notes.push('图片输入：无法判定（保留原值）');
    }
    // ④ effort：'unknown' 表示探测遇阻（限流等），维持原值
    if (probe.effort !== 'unknown') {
      const effort = probe.effort as ModelCapabilities['effort'];
      caps = mergeCaps(caps, { effort }, 'probe');
      notes.push(`思考等级：${effort === null ? '不支持' : `支持（${effort}）`}（实测）`);
    } else {
      notes.push('思考等级：无法判定（保留原值）');
    }
  } else if (base.detected !== 'manual') {
    notes.push('未做实测（仅内置表结论）');
  }

  return { model: { ...model, capabilities: caps }, notes };
}
