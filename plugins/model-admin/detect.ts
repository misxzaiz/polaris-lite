/**
 * 模型能力自动识别（结论合并层）。
 *
 * 分工（密钥下沉后）：
 * - **服务端**负责真实探测：/api/providers/probe 拿服务端的 key 去打上游，
 *   返回 catalogIds / models.dev 目录命中 / 逐模型探针结论（见 server/providers-api.mjs）；
 * - **本模块**只做纯计算：内置知识表兜底 + 目录初值 + 探测结论合并 + 可读 notes，
 *   不含任何网络请求，因此可以在浏览器里安全执行（也不需要 key）。
 *
 * 来源优先级（低 → 高，逐层填充；高来源可覆盖低来源已写值）：
 * 1. builtin —— 内置知识表（离线兜底）；
 * 2. catalog —— 上游 /models（存在性）+ models.dev 公开目录（限值/工具/视觉初值；
 *    注意：目录是「上游裸模型」规格，网关限值可能不同，只作初值）；
 * 3. probe   —— 真实请求实测（vision / tools / 思考特性 / effort 接受性）；
 * 4. reveal  —— 网关限值报错揭示（**输出上限的权威信号**，实测 MOSI 60ms 拿到 131072）。
 *
 * 约束：probe 失败 ≠ 能力为无（失败时保留原值，宁缺毋错）；
 * 人工编辑值（detected=manual）永不被识别覆盖。
 */
import type { ModelCapabilities, ModelInfo } from './index';

/** 服务端探测事实（不含 key、不含请求细节） */
export interface CatalogEntry {
  providerId: string;
  id: string;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  toolCall: boolean | null;
  reasoning: boolean | null;
  vision: boolean | null;
  /** 目录标注的思考档位（如 ["medium","high"]；与网关实际接受集可能不同） */
  effortValues: string[] | null;
}

/** 思考特性探针结论 */
export interface ThinkingFacts {
  /** 思考是否与输出共享 max_tokens 预算（实测判定：64 预算全被思考吃掉） */
  eatsBudget: boolean | null;
  /** 思考是否可关（网关拒绝 disabled = false；方言不存在 = null 不妄断） */
  canDisable: boolean | null;
}

export interface ModelProbe {
  vision: boolean | null;
  effort: string | null | 'unknown';
  /** 输出上限揭示：revealed=网关报错给出权威上限；lenient=网关不校验（宽松） */
  outputLimit?: { kind: 'revealed' | 'lenient' | 'unknown'; limit: number | null } | null;
  tools?: boolean | null;
  thinking?: ThinkingFacts | null;
  /** 深度差分（deep:true 才有）：effort 是否真被网关执行 + 生效旋钮 */
  deep?: { effortAccepted: boolean | null; effortHonored: boolean | null; budgetKnob: string | null } | null;
}

export interface ProbeFacts {
  catalogIds: string[] | null;
  /** models.dev 目录命中（按模型 id；server/modelsdev-catalog.mjs 产出） */
  catalogEntries?: Record<string, CatalogEntry> | null;
  notes: string[];
  probes: Record<string, ModelProbe>;
}

/** 来源可信度排序（值合并按应用顺序，标记取最高已应用来源） */
const SOURCE_RANK: Record<string, number> = { builtin: 0, catalog: 1, probe: 2, reveal: 3, manual: 4 };

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
  // GLM 家族（2026-11-21 修正：glm-4 旧行 4096 输出对 4.5/4.6/5 明显偏低——
  // 实测 glm-4.5 输出 98k 级、glm-5.3-flash 输出 131072；更具体的行必须排在 ^glm-4 之前）
  { match: /^glm-4\.5/, caps: { maxInputTokens: 131072, maxOutputTokens: 98304, effort: null, vision: false } },
  { match: /^glm-4\.6/, caps: { maxInputTokens: 200000, maxOutputTokens: 131072, effort: null, vision: false } },
  { match: /^glm-5/, caps: { maxInputTokens: 131072, maxOutputTokens: 131072, effort: null, vision: false } },
  { match: /^glm-4-plus/, caps: { maxInputTokens: 128000, maxOutputTokens: 4096, effort: null, vision: false } },
  { match: /^glm-4v/, caps: { maxInputTokens: 8192, maxOutputTokens: 1024, effort: null, vision: true } },
  { match: /^glm-4/, caps: { maxInputTokens: 128000, maxOutputTokens: 4096, effort: null, vision: false } },
  { match: /^moonshot-v1-(8k)/, caps: { maxInputTokens: 8000, maxOutputTokens: 4096, effort: null, vision: false } },
  { match: /^moonshot-v1-(32k)/, caps: { maxInputTokens: 32000, maxOutputTokens: 4096, effort: null, vision: false } },
  { match: /^moonshot-v1-(128k)/, caps: { maxInputTokens: 128000, maxOutputTokens: 4096, effort: null, vision: false } },
  // MOSI nex 家族（中转聚合，参数随上游；保守默认不猜——由 catalog/probe/reveal 补）
  { match: /^nex/, caps: { maxInputTokens: 0, maxOutputTokens: 0, effort: null, vision: false } },
];

function builtinLookup(modelId: string): Partial<ModelCapabilities> | null {
  const hit = BUILTIN_TABLE.find((e) => e.match.test(modelId));
  return hit ? { ...hit.caps } : null;
}

const EMPTY_CAPS: ModelCapabilities = {
  maxInputTokens: 0,
  maxOutputTokens: 0,
  effort: null,
  vision: false,
  tools: null,
  canDisableThinking: null,
  reasoningEatsBudget: null,
};

/**
 * 把服务端探测事实合并进单个模型的能力表，返回新模型 + 可读 notes。
 * 纯函数：同入参必得同结果（now 注入，便于测试）。
 */
export function mergeModelCaps(
  model: ModelInfo,
  facts: ProbeFacts,
  now: number = Date.now(),
): { model: ModelInfo; notes: string[] } {
  const notes: string[] = [];
  const base = model.capabilities ?? EMPTY_CAPS;

  // 人工编辑值永不被识别覆盖
  if (base.detected === 'manual') {
    return { model: { ...model, capabilities: { ...base } }, notes: ['人工编辑值：识别不覆盖（如需重新识别请先清除该字段）'] };
  }

  let caps: ModelCapabilities = { ...EMPTY_CAPS, ...base };
  // 当前标记（最高已应用来源）；apply 只在来源 rank ≥ 当前标记时抬升标记
  let topSource: string = caps.detected ?? 'builtin';
  const mark = (source: keyof typeof SOURCE_RANK): void => {
    if ((SOURCE_RANK[source] ?? 0) >= (SOURCE_RANK[topSource] ?? 0)) {
      topSource = source;
      caps = { ...caps, detected: source as ModelCapabilities['detected'], detectedAt: now };
    }
  };

  // ① builtin 兜底
  const builtin = builtinLookup(model.id);
  if (builtin) {
    caps = { ...caps, ...stripUndefined(builtin) };
    mark('builtin');
    notes.push('内置知识表命中');
  }

  // ② catalog 初值：只填未知（0/null），不改已有值——目录限值可能不准（实测两个方向都会错）
  const catalogEntry = facts.catalogEntries?.[model.id] ?? null;
  if (catalogEntry) {
    const patch: Partial<ModelCapabilities> = {};
    if (!caps.maxInputTokens && catalogEntry.maxInputTokens) patch.maxInputTokens = catalogEntry.maxInputTokens;
    if (!caps.maxOutputTokens && catalogEntry.maxOutputTokens) patch.maxOutputTokens = catalogEntry.maxOutputTokens;
    if (caps.tools == null && catalogEntry.toolCall != null) patch.tools = catalogEntry.toolCall;
    if (!caps.vision && catalogEntry.vision != null) patch.vision = catalogEntry.vision;
    if (Object.keys(patch).length) {
      caps = { ...caps, ...patch };
      mark('catalog');
      notes.push('models.dev 目录初值');
    } else {
      notes.push('models.dev 目录命中（无新增初值）');
    }
    if (catalogEntry.effortValues?.length) {
      notes.push(`目录思考档位：${catalogEntry.effortValues.join('/')}`);
    }
  }

  // ③ probe 实测
  const probe = facts.probes?.[model.id];
  if (probe) {
    // vision
    if (probe.vision === true || probe.vision === false) {
      caps = { ...caps, vision: probe.vision };
      mark('probe');
      notes.push(`图片输入：${probe.vision ? '支持' : '不支持'}（实测）`);
    } else {
      notes.push('图片输入：无法判定（保留原值）');
    }
    // effort 接受性：参数被接受则写入（真支持的供应商据此填充；宽松网关忽略该参数无害——
    // 实测 MOSI 对全部档位 200 但行为无差异，"接受"≠"生效"，生效性看深度差分 notes）
    if (probe.effort !== 'unknown') {
      caps = { ...caps, effort: (probe.effort ?? null) as ModelCapabilities['effort'] };
      mark('probe');
      notes.push(`思考等级：${probe.effort === null ? '参数被拒' : `参数被接受（${probe.effort}）`}`);
    }
    // 输出上限揭示（权威）：覆盖 builtin/catalog 旧值
    if (probe.outputLimit?.kind === 'revealed' && probe.outputLimit.limit) {
      caps = { ...caps, maxOutputTokens: probe.outputLimit.limit };
      mark('reveal');
      notes.push(`输出上限：${probe.outputLimit.limit}（网关限值报错揭示，权威）`);
    } else if (probe.outputLimit?.kind === 'lenient') {
      notes.push('网关不校验输出上限（宽松），max_tokens 采目录/内置值');
    }
    // tools 实测
    if (probe.tools === true || probe.tools === false) {
      caps = { ...caps, tools: probe.tools };
      mark('probe');
      notes.push(`工具调用：${probe.tools ? '支持' : '不支持'}（实测）`);
    } else {
      notes.push('工具调用：无法判定（保留原值）');
    }
    // 思考特性
    const th = probe.thinking;
    if (th) {
      if (th.eatsBudget != null) {
        caps = { ...caps, reasoningEatsBudget: th.eatsBudget };
        mark('probe');
        notes.push(`思考吃输出预算：${th.eatsBudget ? '是（截断后可能空内容）' : '否'}（实测）`);
      }
      if (th.canDisable != null) {
        caps = { ...caps, canDisableThinking: th.canDisable };
        mark('probe');
        notes.push(`思考可关：${th.canDisable ? '是' : '否（网关拒绝 disabled）'}`);
      }
    }
    // 深度差分（deep:true 时）
    const d = probe.deep;
    if (d) {
      if (d.effortAccepted) {
        notes.push(`思考档位差分：effort ${d.effortHonored ? '生效（high 思考量显著大于 low）' : '被接受但不生效（档位由模型自决）'}`);
      } else {
        notes.push('思考档位差分：不可测（限流或无 usage）');
      }
      if (d.budgetKnob) notes.push(`思考旋钮：${d.budgetKnob}`);
    }
  } else {
    notes.push('未做实测（仅内置表/目录结论）');
  }

  return { model: { ...model, capabilities: caps }, notes };
}

/** 去掉 patch 里的 undefined（spread 时不覆盖已有值） */
function stripUndefined<T extends object>(patch: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
