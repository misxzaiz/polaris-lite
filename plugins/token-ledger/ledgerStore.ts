/**
 * Token 台账数据层 v2：权威存储 = cap.kv（服务端 sqlite，电脑持久化）。
 *
 * 对齐 pocket-ledger/store.ts 的成熟模式（数据在实例数据目录，不在浏览器）：
 * - namespace = 'token-ledger'，key = 'day.<YYYY-MM-DD>' → 当日 UsageRecord[]
 * - key = 'totals' → { grand, months }（大数与柱状图的聚合账，无需翻明细即可渲染）
 * - 读改写合并 + id 幂等去重（服务端 sqlite，无 localStorage/IndexedDB 额度焦虑）
 *
 * 写入链路仍由浏览器侧 ai.usage 事件驱动（服务端 relay 不解析 usage），
 * 但账本落在服务端：换浏览器/清缓存/多端打开同一实例看到同一份账。
 *
 * 分页：流水按月翻页（loadMonthRows），大数/趋势走 totals 聚合键——
 * 面板永不全量拉明细，历史再长也只有当月明细在内存里。
 *
 * 滚动上限：明细保留 MAX_MONTHS=24 个月（≈几百 KB/月，sqlite 无压力），
 * 超龄月份整键删除并同步 totals；grand 由 months 全量重算，天然一致。
 *
 * 一次性迁移：旧版把账存浏览器 IndexedDB（plite-token-ledger）——首次启动
 * migrateFromIndexedDb() 搬入 kv 后删除旧库，避免双账。
 */

import type { SlotHostApi } from '@sdk';

export interface UsageRecord {
  /** 主键：sessionId + '::' + messageId（天然去重） */
  id: string;
  at: number;
  sessionId: string;
  messageId: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  cacheCreationTokens?: number;
  durationMs?: number;
  /** 字符÷4 估算兜底（供应商没回 usage），看板必须单独标识 */
  estimated?: boolean;
}

/* ---------------- kv 基础 ---------------- */

const NS = 'token-ledger';
const KEY_TOTALS = 'totals';
const KEY_META = 'meta';
/** 明细滚动上限（月）。token 流水一条 <200B，24 个月全量 < 10MB 级。 */
const MAX_MONTHS = 24;
/** 聚合天级字段 */
interface DayAgg {
  in: number;
  out: number;
  cached: number;
  turns: number;
  est: number;
  /** 真实轮（供应商回了 usage）的输入合计——缓存命中率分母，排除 estimated 估算轮 */
  realIn?: number;
  /** 供应商回传了缓存字段（cached>0）的轮数 */
  cachedTurns?: number;
}

interface Totals {
  grand: DayAgg;
  /** 'YYYY-MM' → { 'DD' (两位) → DayAgg } */
  months: Record<string, Record<string, DayAgg>>;
}

function emptyAgg(): DayAgg {
  return { in: 0, out: 0, cached: 0, turns: 0, est: 0 };
}

function emptyTotals(): Totals {
  return { grand: emptyAgg(), months: {} };
}

let api: SlotHostApi | null = null;
export function setLedgerApi(a: SlotHostApi | null): void {
  api = a;
}

async function kvGet<T>(key: string): Promise<T | null> {
  if (!api) return null;
  const res = await api.dispatch<{ value?: T }>({
    target: 'cap.kv',
    action: 'get',
    payload: { namespace: NS, key },
  });
  return res.ok ? (res.data?.value ?? null) : null;
}

async function kvSet(key: string, value: unknown): Promise<boolean> {
  if (!api) return false;
  const res = await api.dispatch<{ ok?: boolean }>({
    target: 'cap.kv',
    action: 'set',
    payload: { namespace: NS, key, value },
  });
  return res.ok;
}

async function kvDelete(key: string): Promise<void> {
  await api?.dispatch({ target: 'cap.kv', action: 'delete', payload: { namespace: NS, key } });
}

async function kvDayKeys(): Promise<string[]> {
  if (!api) return [];
  const res = await api.dispatch<{ keys?: string[] }>({
    target: 'cap.kv',
    action: 'list',
    payload: { namespace: NS },
  });
  return (res.data?.keys ?? []).filter((k) => typeof k === 'string' && k.startsWith('day.'));
}

/* ---------------- 时间工具 ---------------- */

function dayKeyOf(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `day.${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function monthOf(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function currentMonthKey(): string {
  return monthOf(Date.now());
}

/** 当前月的相邻月号（供柱状图跨月切片：往前 N 天可能落在上月） */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/* ---------------- 内存态（写缓冲 + 去重） ---------------- */

/** pending 写缓冲：dayKey → 待写记录。flush 时读改写合并进 kv。 */
const pendingDays = new Map<string, UsageRecord[]>();
/** 去重：本轮进程内已记账的 id（kv 合并时二次幂等） */
const seenIds = new Set<string>();
const subscribers = new Set<() => void>();
let dirty = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function notify(): void {
  for (const fn of subscribers) fn();
}

export function subscribeLedger(fn: () => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/** 把一条记录压入待写缓冲（不落盘），并标记 flush */
function enqueue(rec: UsageRecord): void {
  const dk = dayKeyOf(rec.at);
  const arr = pendingDays.get(dk);
  if (arr) arr.push(rec);
  else pendingDays.set(dk, [rec]);
  dirty = true;
}

/* ---------------- 写入 ---------------- */

/** 记一条 usage。重复（同 id）直接丢弃。写入经 400ms 批量缓冲，不逐条打服务端。 */
export function recordUsage(p: {
  sessionId: string;
  messageId?: string;
  at?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  cacheCreationTokens?: number;
  durationMs?: number;
  estimated?: boolean;
  model?: string;
}): void {
  if (!p.sessionId || !p.messageId) return;
  const id = `${p.sessionId}::${p.messageId}`;
  if (seenIds.has(id)) return;
  const rec: UsageRecord = {
    id,
    at: p.at ?? Date.now(),
    sessionId: p.sessionId,
    messageId: p.messageId,
    model: p.model,
    inputTokens: Math.max(0, Number(p.inputTokens ?? 0)),
    outputTokens: Math.max(0, Number(p.outputTokens ?? 0)),
    cachedTokens: p.cachedTokens != null ? Math.max(0, Number(p.cachedTokens)) : undefined,
    cacheCreationTokens:
      p.cacheCreationTokens != null ? Math.max(0, Number(p.cacheCreationTokens)) : undefined,
    durationMs: p.durationMs != null ? Math.max(0, Number(p.durationMs)) : undefined,
    estimated: p.estimated === true,
  };
  if (rec.inputTokens === 0 && rec.outputTokens === 0) return;
  seenIds.add(id);
  enqueue(rec);
  scheduleFlush();
  notify();
}

/** 批量入账（迁移/回填用）：只进缓冲，随后立即 flushAll */
function appendRows(rows: UsageRecord[]): number {
  let n = 0;
  for (const rec of rows) {
    if (seenIds.has(rec.id)) continue;
    seenIds.add(rec.id);
    enqueue(rec);
    n += 1;
  }
  return n;
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, 400);
}

function aggFromRows(rows: UsageRecord[]): DayAgg {
  const a = emptyAgg();
  let realIn = 0;
  let cachedTurns = 0;
  for (const r of rows) {
    a.in += r.inputTokens;
    a.out += r.outputTokens;
    a.cached += r.cachedTokens ?? 0;
    if (!r.estimated) realIn += r.inputTokens;
    if ((r.cachedTokens ?? 0) > 0) cachedTurns += 1;
    if (r.estimated) a.est += 1;
    a.turns += 1;
  }
  a.realIn = realIn;
  a.cachedTurns = cachedTurns;
  return a;
}

function recalcGrand(t: Totals): void {
  const g = emptyAgg();
  for (const m of Object.values(t.months)) {
    for (const d of Object.values(m)) {
      g.in += d.in;
      g.out += d.out;
      g.cached += d.cached;
      g.turns += d.turns;
      g.est += d.est;
      g.realIn = (g.realIn ?? 0) + (d.realIn ?? 0);
      g.cachedTurns = (g.cachedTurns ?? 0) + (d.cachedTurns ?? 0);
    }
  }
  t.grand = g;
}

/** 批量落库：把 pendingDays 读改写合并进 kv day 键，并同步 totals 聚合 */
export async function flush(): Promise<void> {
  if (!dirty || !api) return;
  dirty = false;
  for (const [dayKey, pend] of [...pendingDays.entries()]) {
    pendingDays.delete(dayKey);
    try {
      const existing = (await kvGet<UsageRecord[]>(dayKey)) ?? [];
      const byId = new Map(existing.map((r) => [r.id, r]));
      for (const r of pend) if (!byId.has(r.id)) byId.set(r.id, r);
      const merged = [...byId.values()].sort((a, b) => a.at - b.at);
      await kvSet(dayKey, merged);

      // 同步 totals：该天聚合从明细重算（幂等，重复 flush 不虚增）
      const totals = (await kvGet<Totals>(KEY_TOTALS)) ?? emptyTotals();
      const date = dayKey.slice(4); // 'YYYY-MM-DD'
      const month = date.slice(0, 7);
      const dd = date.slice(8);
      const months = totals.months[month] ?? {};
      months[dd] = aggFromRows(merged);
      totals.months[month] = months;
      recalcGrand(totals);
      await kvSet(KEY_TOTALS, totals);
    } catch {
      // 写失败：记录回缓冲，下轮再试（内存不丢账）
      const back = pendingDays.get(dayKey);
      if (back) back.unshift(...pend);
      else pendingDays.set(dayKey, [...pend]);
      dirty = true;
    }
  }
  if (dirty) scheduleFlush();
  await pruneMonths();
  notify();
}

/** 滚动清理：明细只留最近 MAX_MONTHS 个月，超龄整键删除 + totals 移除 */
async function pruneMonths(): Promise<void> {
  if (!api) return;
  try {
    const keys = await kvDayKeys();
    const months = [...new Set(keys.map((k) => k.slice(4, 11)))].sort();
    if (months.length <= MAX_MONTHS) return;
    const victims = months.slice(0, months.length - MAX_MONTHS);
    const totals = (await kvGet<Totals>(KEY_TOTALS)) ?? emptyTotals();
    for (const k of keys) {
      if (victims.includes(k.slice(4, 11))) await kvDelete(k);
    }
    for (const m of victims) delete totals.months[m];
    recalcGrand(totals);
    await kvSet(KEY_TOTALS, totals);
  } catch {
    /* 清理失败不致命，下轮再试 */
  }
}

/* ---------------- 读取（供面板） ---------------- */

/** 聚合账：大数与柱状图直接用它，不用翻明细 */
export async function loadTotals(): Promise<Totals> {
  const t = (await kvGet<Totals>(KEY_TOTALS)) ?? emptyTotals();
  if (!t.grand) t.grand = emptyAgg();
  if (!t.months) t.months = {};
  return t;
}

/** 有明细的月份列表（降序，供翻页下拉） */
export async function listMonths(): Promise<string[]> {
  const keys = await kvDayKeys();
  return [...new Set(keys.map((k) => k.slice(4, 11)))].sort().reverse();
}

/** 某月全部明细（at 升序）。分页单位 = 月，面板内存里永远只有一个月 */
export async function loadMonthRows(month: string): Promise<UsageRecord[]> {
  const keys = (await kvDayKeys()).filter((k) => k.startsWith(`day.${month}-`));
  const out: UsageRecord[] = [];
  for (const dk of keys) {
    const arr = await kvGet<UsageRecord[]>(dk);
    if (Array.isArray(arr)) for (const r of arr) if (r && typeof r.id === 'string') out.push(r);
  }
  out.sort((a, b) => b.at - a.at);
  return out;
}

export async function clearLedger(): Promise<void> {
  pendingDays.clear();
  seenIds.clear();
  dirty = false;
  if (api) {
    for (const k of await kvDayKeys()) await kvDelete(k);
    await kvDelete(KEY_TOTALS);
    await kvDelete(KEY_META);
  }
  notify();
}

export async function isKvReady(): Promise<boolean> {
  if (!api) return false;
  const res = await api.dispatch<{ ok?: boolean }>({
    target: 'cap.kv',
    action: 'list',
    payload: { namespace: NS },
  });
  return res.ok;
}

/** 宿主 api 是否已注入（index.ts setup 时调用 setLedgerApi） */
export function hasApi(): boolean {
  return api !== null;
}

/* ---------------- 历史回填：ai-events 的 requests.sse.usage ---------------- */

/** OpenAI 兼容 usage 帧的形状（含 DeepSeek/GLM 方言变体） */
interface WireUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_creation_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
  /** DeepSeek/GLM 方言：缓存命中 / 未命中（对齐 shared/usage.ts 提取链） */
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}

/**
 * 解析 usage 帧。缓存提取链与引擎实时链路（shared/usage.ts buildUsagePayload）完全一致：
 * 标准 prompt_tokens_details 优先，DeepSeek/GLM 变体兜底——否则回填历史会系统性少算缓存。
 */
function parseWireUsage(raw: unknown): { input: number; output: number; cached?: number; cacheCreation?: number } | null {
  if (!raw || typeof raw !== 'object') return null;
  const u = raw as WireUsage;
  const input = Number(u.prompt_tokens ?? NaN);
  const output = Number(u.completion_tokens ?? NaN);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  const cached = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens;
  const cacheCreation = u.prompt_tokens_details?.cache_creation_tokens ?? u.prompt_cache_miss_tokens;
  return {
    input: Math.max(0, input),
    output: Math.max(0, output),
    cached: cached != null && Number.isFinite(Number(cached)) ? Math.max(0, Number(cached)) : undefined,
    cacheCreation:
      cacheCreation != null && Number.isFinite(Number(cacheCreation)) ? Math.max(0, Number(cacheCreation)) : undefined,
  };
}

async function getMetaFlag(name: string): Promise<boolean> {
  const meta = (await kvGet<Record<string, unknown>>(KEY_META)) ?? {};
  return meta[name] === true;
}

async function setMetaFlag(name: string): Promise<void> {
  const meta = (await kvGet<Record<string, unknown>>(KEY_META)) ?? {};
  meta[name] = true;
  await kvSet(KEY_META, meta);
}

/**
 * 旧版迁移：浏览器 IndexedDB（plite-token-ledger）→ cap.kv。
 * 幂等：迁完置 meta.migrated=true 并删除旧库；重装/换浏览器后不重复搬。
 */
export async function migrateFromIndexedDb(): Promise<number> {
  if (typeof indexedDB === 'undefined') return 0;
  if (await getMetaFlag('migrated')) return 0;
  const rows: UsageRecord[] = [];
  await new Promise<void>((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open('plite-token-ledger', 1);
    } catch {
      resolve();
      return;
    }
    req.onupgradeneeded = () => {
      // 旧库不存在：直接放行（onupgradeneeded 会在 open 时建空库，下面再删）
      resolve();
    };
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('usage')) {
        resolve();
        return;
      }
      const tx = db.transaction('usage', 'readonly');
      const cur = tx.objectStore('usage').openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) {
          resolve();
          return;
        }
        const r = c.value as UsageRecord;
        if (r && typeof r.id === 'string' && typeof r.at === 'number') rows.push(r);
        c.continue();
      };
      cur.onerror = () => resolve();
    };
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
  const n = rows.length > 0 ? appendRows(rows) : 0;
  await setMetaFlag('migrated');
  try {
    indexedDB.deleteDatabase('plite-token-ledger');
  } catch {
    /* 忽略：旧库留着无害，meta 标记保证不再读它 */
  }
  if (n > 0) {
    dirty = true;
    await flush();
  }
  return n;
}

/**
 * 从 ai-events 的 IndexedDB（plite-ai-events / requests）回填历史 usage。
 * 请求 id 作为 messageId，天然按请求去重。
 *
 * 版本化（backfillVer）：v1 的 parseWireUsage 只认 OpenAI 标准方言，DeepSeek/GLM
 * 供应商的历史记录 cachedTokens 会丢失（缓存少算）。v2 补齐方言后，升级用户
 * 首次启动自动删除旧 bf: 记录并按新口径重导——源数据在 ai-events IndexedDB，
 * 重导幂等，不产生双账。
 */
const BACKFILL_VER = 2;

export async function backfillFromRequests(): Promise<number> {
  if (typeof indexedDB === 'undefined') return 0;
  const meta = (await kvGet<Record<string, unknown>>(KEY_META)) ?? {};
  const ver = typeof meta.backfillVer === 'number' ? meta.backfillVer : meta.backfilled === true ? 1 : 0;
  if (ver >= BACKFILL_VER) return 0;
  // v1 → v2：旧 bf: 记录按新口径重导（先删，避免同 id 被幂等跳过导致旧值残留）
  if (ver === 1) {
    const removedDays = await purgeBackfillRows();
    if (removedDays.length > 0) {
      const totals = (await kvGet<Totals>(KEY_TOTALS)) ?? emptyTotals();
      for (const dk of removedDays) {
        const arr = (await kvGet<UsageRecord[]>(dk)) ?? [];
        totals.months[dk.slice(4, 11)] ??= {};
        totals.months[dk.slice(4, 11)][dk.slice(8)] = aggFromRows(arr);
      }
      recalcGrand(totals);
      await kvSet(KEY_TOTALS, totals);
    }
  }
  const out: UsageRecord[] = [];
  await new Promise<void>((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open('plite-ai-events', 2);
    } catch {
      resolve();
      return;
    }
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('requests')) {
        resolve();
        return;
      }
      const tx = db.transaction('requests', 'readonly');
      const cur = tx.objectStore('requests').openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) {
          resolve();
          return;
        }
        const rec = c.value as {
          id?: string;
          at?: number;
          providerId?: string;
          sse?: { usage?: unknown };
        };
        if (rec.id && rec.at && rec.sse?.usage) {
          const parsed = parseWireUsage(rec.sse.usage);
          if (parsed) {
            const id = `bf:${rec.id}`;
            if (!seenIds.has(id)) {
              out.push({
                id,
                at: rec.at,
                sessionId: `relay:${rec.providerId ?? 'default'}`,
                messageId: rec.id,
                model: rec.providerId,
                inputTokens: parsed.input,
                outputTokens: parsed.output,
                cachedTokens: parsed.cached,
                cacheCreationTokens: parsed.cacheCreation,
                estimated: false,
              });
              seenIds.add(id);
            }
          }
        }
        c.continue();
      };
      cur.onerror = () => resolve();
    };
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
  await setMetaFlag('backfilled');
  const m2 = (await kvGet<Record<string, unknown>>(KEY_META)) ?? {};
  m2.backfillVer = BACKFILL_VER;
  await kvSet(KEY_META, m2);
  if (out.length === 0) return 0;
  const n = appendRows(out);
  dirty = true;
  await flush();
  return n;
}

/**
 * 删除所有 bf: 回填记录（保留实时记账），返回受影响的 dayKey 列表。
 * 用于解析口径升级后的重导前清理。
 */
async function purgeBackfillRows(): Promise<string[]> {
  const affected: string[] = [];
  for (const dk of await kvDayKeys()) {
    const arr = (await kvGet<UsageRecord[]>(dk)) ?? [];
    const kept = arr.filter((r) => !r.id.startsWith('bf:'));
    if (kept.length !== arr.length) {
      await kvSet(dk, kept);
      affected.push(dk);
      dirty = true;
    }
  }
  return affected;
}

/* ---------------- 导出 ---------------- */

export function buildLedgerExport(rows: UsageRecord[], scope: string): string {
  return JSON.stringify(
    {
      kind: 'plite-token-ledger-export',
      v: 2,
      exportedAt: new Date().toISOString(),
      scope,
      count: rows.length,
      usage: rows,
    },
    null,
    2,
  );
}
