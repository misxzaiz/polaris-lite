/**
 * 分享正文脱敏（与 ai-events/redact.ts 同口径，服务端版）。
 *
 * 分享页/JSON/Markdown 是免登录面向 AI 的导出，脱敏是硬边界：
 *  1. JSON 按字段名（password/token/api_key/secret/...）整体替换；
 *  2. 任意文本按密钥形态（sk- / Bearer / JWT）正则替换。
 */
const SECRET_FIELD = /^(password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|authorization|auth|credential|private[_-]?key|cookie)$/i;
const SECRET_PATTERNS = [
  { re: /\bsk-[A-Za-z0-9_-]{16,}/g, mask: '‹已脱敏›' },
  { re: /\bBearer\s+[A-Za-z0-9._~-]{12,}/gi, mask: 'Bearer ‹已脱敏›' },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, mask: '‹JWT已脱敏›' },
];

/** 任意文本按密钥形态做正则脱敏 */
export function maskByPattern(s) {
  let out = s;
  for (const { re, mask } of SECRET_PATTERNS) out = out.replace(re, mask);
  return out;
}

/** 递归脱敏 JSON 值：字段名命中则整体替换，否则继续下钻 */
export function redactJson(value) {
  if (Array.isArray(value)) return value.map(redactJson);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_FIELD.test(k) ? '‹已脱敏›' : redactJson(v);
    }
    return out;
  }
  if (typeof value === 'string') return maskByPattern(value);
  return value;
}
