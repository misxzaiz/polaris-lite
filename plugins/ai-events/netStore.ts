/**
 * HTTP 取证记录存储。
 *
 * 与轮次（turnStore）分开：一条请求可能就是几十 KB 原文，轮次是轻量摘要。
 * 进行中的请求只放内存（流式回答要实时可见），请求结束后才落 IndexedDB。
 */
import { openDb, txDone } from './turnStore';

const MAX_RECS = 300;
const PRUNE_BATCH = 100;

export type HttpKind = 'model' | 'tool' | 'fs' | 'auth' | 'app';

export interface SseSummary {
  frames: number;
  textLen: number;
  finishReason?: string;
  usage?: unknown;
  toolCalls: { name: string; args: string }[];
  /** 开头几条原始帧（看协议对不对） */
  first: string[];
  /** 结尾几条原始帧（看收尾/错误） */
  last: string[];
}

export interface HttpRecord {
  v: 1;
  id: string;
  at: number;
  durMs: number;
  kind: HttpKind;
  method: string;
  path: string;
  reqHeaders: [string, string][];
  reqBody: string | null;
  reqBytes: number;
  status: number;
  resHeaders: [string, string][];
  resBody: string | null;
  resBytes: number;
  stream: boolean;
  truncated: boolean;
  /** 响应仍在读取中（只有内存里有，不落库） */
  live?: boolean;
  error?: string;
  sse?: SseSummary;
  curl: string;
  upstream?: { url: string; curl: string };
  providerId?: string;
}

const pending = new Map<string, HttpRecord>();
const recent: HttpRecord[] = [];
const subscribers = new Set<() => void>();

function notify(): void {
  for (const fn of subscribers) fn();
}

export function subscribeNet(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

function putRec(rec: HttpRecord): Promise<void> {
  return (async () => {
    const db = await openDb();
    if (!db) return;
    try {
      const tx = db.transaction('requests', 'readwrite');
      tx.objectStore('requests').put(rec);
      await txDone(tx);
    } catch {
      /* 配额不足：保留内存副本 */
    }
  })();
}

async function prune(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  const total = await new Promise<number>((resolve) => {
    try {
      const tx = db.transaction('requests', 'readonly');
      const req = tx.objectStore('requests').count();
      req.onsuccess = () => resolve(Number(req.result) || 0);
      req.onerror = () => resolve(0);
    } catch {
      resolve(0);
    }
  });
  if (total <= MAX_RECS) return;
  const need = Math.min(PRUNE_BATCH, total - MAX_RECS + PRUNE_BATCH);
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction('requests', 'readwrite');
      const store = tx.objectStore('requests');
      const req = store.index('byAt').openCursor(null, 'next');
      let removed = 0;
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor || removed >= need) return;
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

/** 请求刚发出：先占位，界面上立刻能看到「进行中」 */
export function begin(rec: HttpRecord): void {
  pending.set(rec.id, rec);
  notify();
}

/** 中间态更新（收到响应头、读到请求体）：就地改内存记录，让面板实时刷新 */
export function patch(id: string, next: Partial<HttpRecord>): void {
  const rec = pending.get(id);
  if (!rec) return;
  Object.assign(rec, next);
  notify();
}

/** 请求收口：移出 pending，落库后通知（顺序不能反，否则面板回读不到） */
export async function finish(rec: HttpRecord): Promise<void> {
  pending.delete(rec.id);
  recent.unshift(rec);
  if (recent.length > MAX_RECS) recent.length = MAX_RECS;
  await putRec(rec);
  notify();
  void prune();
}

export async function loadRecentNet(limit = 200): Promise<HttpRecord[]> {
  const db = await openDb();
  const live = [...pending.values()].sort((a, b) => b.at - a.at);
  if (!db) return [...live, ...recent].slice(0, limit);
  const fromDb = await new Promise<HttpRecord[]>((resolve) => {
    const out: HttpRecord[] = [];
    try {
      const tx = db.transaction('requests', 'readonly');
      const req = tx.objectStore('requests').index('byAt').openCursor(null, 'prev');
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor || out.length >= limit) {
          resolve(out);
          return;
        }
        out.push(cursor.value as HttpRecord);
        cursor.continue();
      };
      req.onerror = () => resolve(out);
    } catch {
      resolve(out);
    }
  });
  // 进行中的记录还没落库，合并时排在最前
  const seen = new Set(live.map((r) => r.id));
  return [...live, ...fromDb.filter((r) => !seen.has(r.id))].slice(0, limit);
}

export async function clearNet(): Promise<void> {
  pending.clear();
  recent.length = 0;
  notify();
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction('requests', 'readwrite');
    tx.objectStore('requests').clear();
    await txDone(tx);
  } catch {
    /* 忽略 */
  }
}

export function buildNetExport(recs: HttpRecord[], scope: string): string {
  return JSON.stringify(
    {
      kind: 'plite-ai-http-export',
      v: 1,
      exportedAt: new Date().toISOString(),
      scope,
      count: recs.length,
      requests: recs.map(({ live: _live, ...rest }) => rest),
    },
    null,
    2,
  );
}
