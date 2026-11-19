/**
 * 取证正文脱敏（netTap 的 HTTP 记录与 turnStore 的用户输入共用）。
 *
 * 取证会把请求/响应/用户 prompt 原文落 IndexedDB 并支持导出 JSON/curl，
 * 因此 header 脱敏不够——用户常把密钥直接贴进 prompt。两级脱敏：
 *  1. JSON 按字段名（password/token/api_key/secret/...）整体替换；
 *  2. 任意文本按密钥形态（sk- / Bearer / JWT）正则替换。
 */
const SECRET_FIELD = /^(password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|authorization|auth|credential|private[_-]?key|session[_-]?id|cookie)$/i;
const SECRET_PATTERNS: { re: RegExp; mask: string }[] = [
  { re: /\bsk-[A-Za-z0-9_-]{16,}/g, mask: 'sk-‹已脱敏›' },
  { re: /\bBearer\s+[A-Za-z0-9._~-]{12,}/gi, mask: 'Bearer ‹已脱敏›' },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, mask: '‹JWT已脱敏›' },
];

/** 按密钥形态做正则脱敏（对任意文本，含非 JSON） */
export function maskByPattern(s: string): string {
  let out = s;
  for (const { re, mask } of SECRET_PATTERNS) out = out.replace(re, mask);
  return out;
}

/** 递归脱敏 JSON 值：字段名命中 SECRET_FIELD 则整体替换，否则继续下钻 */
export function redactJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactJson);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_FIELD.test(k) ? '‹已脱敏›' : redactJson(v);
    }
    return out;
  }
  if (typeof value === 'string') return maskByPattern(value);
  return value;
}

/** 正文脱敏入口：先按 JSON 结构，再兜底正则（覆盖非 JSON 文本与转义后的密钥串） */
export function redactSecrets(text: string | null): string | null {
  if (!text) return text;
  let out: string;
  try {
    out = JSON.stringify(redactJson(JSON.parse(text)));
  } catch {
    out = text;
  }
  return maskByPattern(out);
}
