/**
 * 模型能力自动识别（探测）模块。
 *
 * 三级来源（可信度从低到高覆盖，后写覆盖先写）：
 * 1. builtin —— 内置知识表（常见模型家族的静态知识，离线可用）；
 * 2. catalog —— 上游 /models 目录探测（确认模型存在 + 拉取目录；部分供应商目录带 context 上限）；
 * 3. probe   —— 真实请求探测：
 *    - vision：发送 1x1 PNG 的 image_url 消息，上游不报错即认为支持图片输入；
 *    - effort：发送 reasoning_effort=low 请求，不报 unknown parameter 即认为支持思考等级。
 *
 * 设计约束：
 * - 全部探测经宿主内嵌中继 /api/model-relay（会话 cookie 鉴权 + 域名白名单），与真实对话同链路；
 * - 探测失败 ≠ 能力为无：失败时保留原值，只把成功结论写回（宁缺毋错）；
 * - 每个结论都带 detected 来源标记，UI 可追溯。
 */
import type { ModelCapabilities, ProviderConfig } from './index';

export type DetectReport = {
  modelId: string;
  source: 'builtin' | 'catalog' | 'probe';
  capabilities: ModelCapabilities;
  notes: string[];
};

/** 1x1 透明 PNG（最小图片，探测 vision 用） */
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

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

/** 探测结果合并：probe 结论覆盖 catalog，catalog 覆盖 builtin；已有 manual 值不被覆盖 */
function mergeCaps(
  base: ModelCapabilities | undefined,
  patch: Partial<ModelCapabilities>,
  source: ModelCapabilities['detected'],
): ModelCapabilities {
  const prev = base ?? { maxInputTokens: 0, maxOutputTokens: 0, effort: null, vision: false };
  const merged: ModelCapabilities = {
    maxInputTokens: patch.maxInputTokens ?? prev.maxInputTokens,
    maxOutputTokens: patch.maxOutputTokens ?? prev.maxOutputTokens,
    // effort/vision 的"已知不支持"(null/false) 只在来源更可信时覆盖 undefined/缺省
    effort: patch.effort !== undefined ? patch.effort : (prev.effort ?? null),
    vision: patch.vision ?? prev.vision ?? false,
    detected: source,
  };
  // 人工编辑过的字段（detected==='manual'）不被自动结果回退
  if (base?.detected === 'manual') {
    return { ...base }; // 人工值权威，原样保留
  }
  return merged;
}

/** 中继请求（与对话同链路：会话 cookie 自动携带；url+body 包装） */
async function relayJson(provider: { baseURL: string; apiKey: string }, path: string, body: unknown, signal?: AbortSignal): Promise<{ status: number; json: any }> {
  const resp = await fetch('/api/model-relay', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
    body: JSON.stringify({ url: `${provider.baseURL.replace(/\/$/, '')}${path}`, body }),
    signal,
  });
  let json: any = null;
  try { json = await resp.json(); } catch { /* 非 JSON 响应 */ }
  return { status: resp.status, json };
}

/** ③a catalog 探测：GET 语义用 POST 包装（中继只放行 POST），body 里 method 标记 */
async function probeCatalog(provider: { baseURL: string; apiKey: string }): Promise<string[] | null> {
  try {
    const { status, json } = await relayJson(provider, '/models', {});
    if (status !== 200 || !json) return null;
    const ids = (json.data ?? json.models ?? [])
      .map((m: any) => (typeof m === 'string' ? m : m?.id))
      .filter((x: unknown): x is string => typeof x === 'string');
    return ids.length > 0 ? ids : null;
  } catch {
    return null;
  }
}

/** ③b vision 探测：1x1 图片 message；2xx 视为支持（内容错误但格式被接受也算支持图片通道） */
async function probeVision(provider: { baseURL: string; apiKey: string }, modelId: string): Promise<boolean | null> {
  try {
    const { status, json } = await relayJson(provider, '/chat/completions', {
      model: modelId,
      max_tokens: 1,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'ping' },
          { type: 'image_url', image_url: { url: TINY_PNG } },
        ],
      }],
    });
    if (status >= 200 && status < 300) return true;
    // 明确的图片不支持错误 → false；其他错误（限流/鉴权）→ 未知 null
    const msg = String(json?.error?.message ?? json?.message ?? '');
    if (/image|vision|multimodal|not support|unsupported|invalid content/i.test(msg)) return false;
    return null;
  } catch {
    return null;
  }
}

/** ③c effort 探测：带 reasoning_effort=low 请求；unknown parameter 类错误 → 不支持 */
async function probeEffort(
  provider: { baseURL: string; apiKey: string },
  modelId: string,
): Promise<'minimal' | 'low' | 'medium' | 'high' | null | undefined> {
  try {
    const { status, json } = await relayJson(provider, '/chat/completions', {
      model: modelId,
      max_tokens: 1,
      reasoning_effort: 'low',
      messages: [{ role: 'user', content: 'ping' }],
    });
    if (status >= 200 && status < 300) return 'low';
    const msg = String(json?.error?.message ?? json?.message ?? '');
    if (/reasoning|effort|unknown (parameter|field)|unexpected/i.test(msg)) return null;
    return undefined; // 其他错误（限流等）：维持未知
  } catch {
    return undefined;
  }
}

export interface DetectOptions {
  /** 是否做真实请求探测（catalog/vision/effort）；false = 只用内置表（快、离线） */
  live?: boolean;
  signal?: AbortSignal;
}

/**
 * 对单个供应商的全部模型做能力识别，返回逐模型报告。
 * 顺序：builtin 兜底 → catalog 确认 → live probe 修正。任何一步失败都不影响已有结论。
 */
export async function detectProviderCapabilities(
  provider: ProviderConfig,
  options: DetectOptions = {},
): Promise<DetectReport[]> {
  const live = options.live !== false;
  const notes: string[] = [];
  const reports: DetectReport[] = [];

  // catalog 一次拉取，供全部模型做存在性确认
  let catalogIds: string[] | null = null;
  if (live && provider.apiKey) {
    catalogIds = await probeCatalog(provider);
    if (catalogIds) notes.push(`模型目录探测成功（${catalogIds.length} 个模型）`);
    else notes.push('模型目录不可用（跳过 catalog 级）');
  }

  for (const model of provider.models) {
    const capsNotes: string[] = [];
    // ① builtin 兜底
    let caps = mergeCaps(model.capabilities, builtinLookup(model.id) ?? {}, 'builtin');
    if (builtinLookup(model.id)) capsNotes.push('内置知识表命中');

    // ② catalog 确认存在性（不改能力值，只补 notes）
    if (catalogIds && !catalogIds.includes(model.id)) {
      capsNotes.push('⚠ 上游目录未列出该模型（可能是聚合中转的别名）');
    }

    // ③ live probe（vision / effort）
    if (live && provider.apiKey) {
      const vision = await probeVision(provider, model.id);
      if (vision !== null) {
        caps = mergeCaps(caps, { vision }, 'probe');
        capsNotes.push(`图片输入：${vision ? '支持' : '不支持'}（实测）`);
      } else {
        capsNotes.push('图片输入：无法判定（保留原值）');
      }
      const effort = await probeEffort(provider, model.id);
      if (effort !== undefined) {
        caps = mergeCaps(caps, { effort }, 'probe');
        capsNotes.push(`思考等级：${effort === null ? '不支持' : `支持（${effort}）`}（实测）`);
      } else {
        capsNotes.push('思考等级：无法判定（保留原值）');
      }
    }

    reports.push({ modelId: model.id, source: caps.detected ?? 'builtin', capabilities: caps, notes: capsNotes });
  }
  if (notes.length) reports.push({ modelId: '__catalog__', source: 'catalog', capabilities: { maxInputTokens: 0, maxOutputTokens: 0, effort: null, vision: false }, notes });
  return reports;
}
