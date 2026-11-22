/** 消息时间点/耗时格式化（chat-lite 私有 UI 关注点，不进 @sdk 契约）。
 *  口径：
 *  - 时间点：同日只显示 HH:MM:SS；跨日显示「昨天 HH:MM」/「MM-DD HH:MM」（会话历史内罕见跨周）；
 *  - 耗时：<1s → ms；<60s → x.xs；<60min → x分x秒；更长 → x.x小时。
 *  纯函数无依赖，便于单测。 */

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** 消息时间点（createdAt / endedAt → 展示串） */
export function fmtMsgTime(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const sameDay = new Date(now).toDateString() === d.toDateString();
  if (sameDay) return `${hm}:${pad2(d.getSeconds())}`;
  const yesterday = new Date(now - 86400000);
  if (yesterday.toDateString() === d.toDateString()) return `昨天 ${hm}`;
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hm}`;
}

/** 耗时（毫秒 → 展示串）：分级规则见文件头 */
export function fmtDur(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) {
    const m = Math.floor(ms / 60_000);
    const s = Math.round((ms % 60_000) / 1000);
    return s > 0 ? `${m}分${s}秒` : `${m}分`;
  }
  return `${(ms / 3_600_000).toFixed(1)}小时`;
}
