/**
 * Token 台账数据层（单写者，全部由 ai.usage 事件驱动）。
 *
 * 结构对齐 ai-events/turnStore.ts 的成熟模式：
 * - IndexedDB 自持库（不占 localStorage 的 1.5MB 全局额度，不阻塞主线程逐条写）
 * - 内存镜像 recent[] 供 UI 即时刷新，写库批量异步
 * - 滚动上限：token 流水比轮次更小（一条 <200B），保留 5000 条足够半年用量
 *
 * 数据来源（两路，互相独立）：
 * 1. 实时：ai.usage 事件（cap.ai.chat:event / cap.ai.chat.runner:event 双源，
 *    与 chat-lite 的 ContextMeter 同源——那是内存态 16 条，这里是全量台账）
 * 2. 回填：ai-events 插件的 IndexedDB `requests` 表里存有原始 SSE usage 帧
 *    （sse.usage + providerId + at），首次启动导入历史，老对话直接有账可看
 *
 * 去重：同一 (sessionId, messageId) 只记一次。agent-loop 会把引擎事件转发一份，
 * runner 通道与 cap 通道可能先后送达同一轮 usage，以先到者为准。
 */

const DB_NAME = 'plite-token-ledger';
const DB_VERSION = 1;
const STORE = 'usage';
/** 滚动上限（条）。一条流水 <200B，5000 条 <1MB，IndexedDB 无压力 */
const MAX_RECORDS = 5000;
const PRUNE_BATCH = 500;

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

/* ---------------- 内存镜像 ---------------- */

const recent: UsageRecord[] = [];
const seenIds = new Set<string>();
const subscribers = new Set<() => void>();
let dirty = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function notify(): void {
  for (const fn of subscribers) subscribers.size && fn();
}

export function subscribeLedger(fn: () => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/* ---------------- IndexedDB ---------------- */

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('byAt', 'at');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

/** 写入一条 usage。重复（同 id）直接丢弃，不重复记账。 */
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
  recent.unshift(rec);
  if (recent.length > MAX_RECORDS) recent.length = MAX_RECORDS;
  scheduleFlush();
  notify();
}

/* 批量落库：逐条写库会拖垮主线程，攒 400ms 一次写 */
function scheduleFlush(): void {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, 400);
}

async function flush(): Promise<void> {
  if (!dirty) return;
  dirty = false;
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    // 只写镜像头部未持久化的部分（镜像与库一致时全量 put 幂等，代价可接受）
    for (const rec of recent) store.put(rec);
    await txDone(tx);
    await prune(db);
  } catch {
    /* 忽略：写库失败不丢内存账 */
  }
}

/** 滚动清理：超上限时删最旧的 PRUNE_BATCH 条 */
async function prune(db: IDBDatabase): Promise<void> {
  const count = await new Promise<number>((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(0);
    } catch {
      resolve(0);
    }
  });
  if (count <= MAX_RECORDS) return;
  const need = Math.min(count - MAX_RECORDS + PRUNE_BATCH, count);
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).index('byAt').openCursor(null, 'next');
      let removed = 0;
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor || removed >= need) return;
        seenIds.delete(String(cursor.key));
        cursor.delete();
        removed += 1;
        cursor.continue();
      };
      void txDone(tx).then(resolve);
    } catch {
      resolve();
    }
  });
}

/** 读最近 N 条（byAt 倒序），库不可用时回退内存镜像 */
export async function loadRecentUsage(limit = MAX_RECORDS): Promise<UsageRecord[]> {
  const db = await openDb();
  if (!db) return recent.slice(0, limit);
  const fromDb = await new Promise<UsageRecord[]>((resolve) => {
    const out: UsageRecord[] = [];
    try {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).index('byAt').openCursor(null, 'prev');
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor || out.length >= limit) {
          resolve(out);
          return;
        }
        out.push(cursor.value as UsageRecord);
        cursor.continue();
      };
      req.onerror = () => resolve(out);
    } catch {
      resolve(out);
    }
  });
  // 启动后未落库的内存记录合并去重（内存为准：包含回填期同源数据）
  if (fromDb.length > 0) {
    for (const rec of fromDb) seenIds.add(rec.id);
    return fromDb;
  }
  return recent.slice(0, limit);
}

export async function clearLedger(): Promise<void> {
  recent.length = 0;
  seenIds.clear();
  notify();
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    await txDone(tx);
  } catch {
    /* 忽略 */
  }
}

/* ---------------- 历史回填：ai-events 的 requests.sse.usage ---------------- */

/** OpenAI 兼容 usage 帧的形状（prompt_tokens / completion_tokens / cache_*） */
interface WireUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_creation_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

function parseWireUsage(raw: unknown): { input: number; output: number; cached?: number; cacheCreation?: number } | null {
  if (!raw || typeof raw !== 'object') return null;
  const u = raw as WireUsage;
  const input = Number(u.prompt_tokens ?? NaN);
  const output = Number(u.completion_tokens ?? NaN);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  const cached = u.prompt_tokens_details?.cached_tokens;
  return {
    input: Math.max(0, input),
    output: Math.max(0, output),
    cached: cached != null ? Math.max(0, Number(cached)) : undefined,
    cacheCreation: u.prompt_tokens_details?.cache_creation_tokens != null
      ? Math.max(0, Number(u.prompt_tokens_details.cache_creation_tokens))
      : undefined,
  };
}

/** 回填标记：只跑一次，存 localStorage（体积极小，不挤占流水额度） */
const BACKFILL_KEY = 'plite-token-ledger.backfill';

/**
 * 从 ai-events 的 IndexedDB（plite-ai-events / requests）回填历史 usage。
 * 请求 id 作为 messageId，天然按请求去重；已 seenIds 的跳过。
 * 返回回填条数（面板首次可提示「已从网络取证导入 N 条」）。
 */
export async function backfillFromRequests(): Promise<number> {
  if (typeof indexedDB === 'undefined') return 0;
  if (localStorage.getItem(BACKFILL_KEY) === '1') return 0;
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
      const cur = tx.objectStore('requests').index('byAt').openCursor(null, 'prev');
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) {
          void txDone(tx).then(resolve);
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
  try {
    localStorage.setItem(BACKFILL_KEY, '1');
  } catch {
    /* 忽略 */
  }
  if (out.length === 0) return 0;
  out.sort((a, b) => a.at - b.at);
  // 直接批量落库 + 并入内存镜像
  const db = await openDb();
  if (db) {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (const rec of out) store.put(rec);
      await txDone(tx);
    } catch {
      /* 忽略 */
    }
  }
  for (let i = out.length - 1; i >= 0; i--) recent.unshift(out[i]);
  recent.sort((a, b) => b.at - a.at);
  if (recent.length > MAX_RECORDS) recent.length = MAX_RECORDS;
  notify();
  return out.length;
}

export function buildLedgerExport(rows: UsageRecord[], scope: string): string {
  return JSON.stringify(
    {
      kind: 'plite-token-ledger-export',
      v: 1,
      exportedAt: new Date().toISOString(),
      scope,
      count: rows.length,
      usage: rows,
    },
    null,
    2,
  );
}
