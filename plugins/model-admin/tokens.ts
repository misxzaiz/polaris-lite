/**
 * Token 数量解析与显示（模型能力「输入/输出 tokens」字段共用）。
 *
 * 为什么需要：输入框此前用 `replace(/\D/g,'')` 剥掉非数字——用户输入「1m」
 * 会被剥成「1」存成 1 个 token（清空则回 0），上下文窗口于是永远回落默认
 * 200k。现在统一走宽松解析：接受 1m / 1M / 200k / 128000 / 1,000,000 等
 * 写法，服务端 normalize（provider-store）有同等实现做第二道防线。
 */

/** 宽松解析 token 数量：数字 / 数字串（容千分位逗号与空格）/ k / M 后缀。非法返回 null。 */
export function parseTokenCount(raw: unknown): number | null {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0) return null;
    return Math.floor(raw);
  }
  if (typeof raw !== 'string') return null;
  const s = raw.trim().replace(/[,\s_]/g, '');
  if (s === '') return 0; // 清空 = 未知（与旧语义一致）
  const m = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  const mult = m[2] === 'm' || m[2] === 'M' ? 1_000_000 : m[2] === 'k' || m[2] === 'K' ? 1_000 : 1;
  return Math.floor(n * mult);
}

/** 人读格式：≥1M 显示 M，≥1k 显示 k（一位小数去尾 0），否则原数。0 → '—' */
export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—';
  const trim = (v: number): string => {
    const s = (Math.round(v * 10) / 10).toString();
    return s.endsWith('.0') ? s.slice(0, -2) : s;
  };
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (n >= 1_000) return `${trim(n / 1_000)}k`;
  return String(n);
}
