/**
 * 逐跳轮次桥：把 ai-events 落在浏览器 IndexedDB 的 TurnRecord（steps 逐跳耗时/
 * approvalWaitedMs 审批等待/outcome）按会话同步到服务端（POST /api/share/turns），
 * 供分享转录的 AI 分析版使用。
 *
 * 边界：只读同源 IndexedDB（ai-events 的库），不写；打开不指定版本、store 缺失
 * 即放弃——schema 管理权归 ai-events，这里绝不做升级。每会话 60s 节流。
 */
const DB_NAME = 'plite-ai-events';
const SYNC_INTERVAL_MS = 60_000;

const lastSync = new Map<string, number>();

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    try {
      // 不带版本号打开：绝不触发升级（schema 归 ai-events 管）
      const req = indexedDB.open(DB_NAME);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function readTurnsBySession(db: IDBDatabase, sessionId: string): Promise<Record<string, unknown>[]> {
  return new Promise((resolve) => {
    try {
      if (!db.objectStoreNames.contains('turns')) {
        resolve([]);
        return;
      }
      const tx = db.transaction('turns', 'readonly');
      const idx = tx.objectStore('turns').index('bySession');
      const range = IDBKeyRange.bound([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER]);
      const out: Record<string, unknown>[] = [];
      const cursorReq = idx.openCursor(range, 'prev'); // 新→旧
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor || out.length >= 200) {
          resolve(out);
          return;
        }
        out.push(cursor.value as Record<string, unknown>);
        cursor.continue();
      };
      cursorReq.onerror = () => resolve(out);
    } catch {
      resolve([]);
    }
  });
}

/** 同步指定会话的轮次到服务端（60s 节流；失败静默） */
export async function syncTurnsForSession(sessionId: string): Promise<void> {
  if (!sessionId || typeof indexedDB === 'undefined') return;
  const now = Date.now();
  if (now - (lastSync.get(sessionId) ?? 0) < SYNC_INTERVAL_MS) return;
  lastSync.set(sessionId, now);
  try {
    const db = await openDb();
    if (!db) return;
    const turns = await readTurnsBySession(db, sessionId);
    if (turns.length === 0) return;
    await fetch('/api/share/turns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ sessionId, turns }),
    });
  } catch {
    /* 静默：轮次同步是增益不是门槛 */
  }
}
