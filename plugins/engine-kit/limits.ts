/**
 * limits：网关限值报错揭示（error-reveal）。
 *
 * 抽取自 real-engine（parseLimitFromError / classifyLimitError），与
 * server/providers-api.mjs 同语义（本模块是其前端纯函数镜像，供引擎在流式
 * 阶段即时揭示限值）。
 */

/** 从限值报错文案里解析数字上限 */
export function parseLimitFromError(text: string): number | null {
  const patterns = [
    /between\s+\d+\s+and\s+(\d+)/i,
    /at\s+most\s+(\d+)/i,
    /(?:maximum|limit|max)[^\d]{0,24}(\d{3,})/i,
  ];
  for (const re of patterns) {
    const m = String(text ?? '').match(re);
    const v = m ? Number(m[1]) : NaN;
    if (Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

/** 限值报错分类：输出上限 vs 输入上下文（写回能力表的字段不同） */
export function classifyLimitError(msg: string): { kind: 'output' | 'input' | null; limit: number | null } {
  const limit = parseLimitFromError(msg);
  if (!limit) return { kind: null, limit: null };
  if (/output|completion|max[_ ]?tokens/i.test(msg)) return { kind: 'output', limit };
  if (/context|prompt|input|too long/i.test(msg)) return { kind: 'input', limit };
  return { kind: null, limit: null };
}
