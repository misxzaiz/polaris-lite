/**
 * 会话服务端同步层（chat-lite 私有；spec：docs/chat-multi-device-sync-plan.md v0.2）。
 *
 * 职责（单写者仍是 store.ts 的动作方法；本模块只做「状态 → 服务端/缓存」的搬运）：
 * - pullIndex / pullSession：服务端拉索引与会话全文（/api/chat/sessions*）；
 * - pushSession：整会话 PUT（带 baseVersion；409 返回服务端版本由 store 决策）；
 * - deleteSessionRemote：软删除墓碑；
 * - cache 镜像（IndexedDB）：秒开 + activeId 恢复 + 离线兜底——**在线模式写通**
 *   （pull 合并后 / push 成功后 / 删除后同步镜像；spec v0.1 的 offline-only 写入是断层，
 *   导致每次刷新都是冷启动）；
 * - 变更感知：**索引 SSE 推送为主（index-changed 事件即时 pull 对账）+ 30s 轮询兜底**
 *   （spec v0.2：轮询-only 的多端可感知性实测不足；SSE 只推索引变更 ids，不做打字级推送）；
 * - 冷启动有界并发拉全文（CONCURRENCY=6）：串行逐个 await 在数百会话时填列表分钟级。
 *
 * 设计约束：
 * - 不用 cap 总线：会话存取是 chat-lite 私有数据面（同源 fetch，与 ChatInput 调
 *   /api/tool/config 同模式），不构成跨插件能力；
 * - 流式中的会话不 push（等 settle 后的防抖窗口统一落），轮询/推送对它也跳过覆盖；
 * - 服务端不可达：静默降级为 IndexedDB + 内存（offline 标记由 store 消费）。
 */

import type { StoreMessage, ChatSessionShape } from './store';
import { SRV } from './serverApi';

/** 与服务端对齐的会话记录（不含 pending 等本机交互态） */
export interface SessionSnapshot {
  session: ChatSessionShape & { messages: StoreMessage[] };
  version: number;
  updatedAt: number;
}

export interface SessionIndexEntry {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  msgCount: number;
  lastMsgPreview: string;
  version: number;
}

/** 会话 loop 运行态（服务端 chat-store 维护；发起端暴毙由 20s 心跳超时 GC） */
export interface LoopRunState {
  startedAt: number;
  device: string;
  phase: string;
  lastBeat: number;
}

export interface PullIndexResult {
  sessions: SessionIndexEntry[];
  tombstones: { id: string; deletedAt: number; version: number }[];
  /** 正在执行编排 loop 的会话表（无执行时为空对象；字段缺省兼容旧服务端） */
  running?: Record<string, LoopRunState>;
}

export type SyncStatus = 'idle' | 'syncing' | 'offline' | 'conflict';

/** 冲突信息（409 时回填；由 store 弹提示） */
export interface ConflictInfo {
  sessionId: string;
  serverVersion: number;
  serverUpdatedAt: number;
}

const BASE = `${SRV.chat}/sessions`;
const POLL_MS = 30_000;

// ---------------------------------------------------------------- HTTP

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; status: number; code?: string; data?: T }> {
  try {
    const resp = await fetch(url, { credentials: 'include', ...init });
    const text = await resp.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
    if (!resp.ok) {
      const err = (body ?? {}) as { code?: string };
      return { ok: false, status: resp.status, code: err.code, data: body as T };
    }
    return { ok: true, data: body as T };
  } catch {
    return { ok: false, status: 0 }; // 网络不可达
  }
}

export function pullIndex(since?: number): Promise<{ ok: true; data: PullIndexResult } | { ok: false; status: number }> {
  const q = since ? `?since=${since}` : '';
  return jsonFetch<PullIndexResult>(`${BASE}${q}`);
}

export function pullSession(id: string): Promise<{ ok: true; data: SessionSnapshot } | { ok: false; status: number; code?: string }> {
  return jsonFetch<SessionSnapshot>(`${BASE}/${encodeURIComponent(id)}`);
}

export function pushSession(
  id: string,
  session: ChatSessionShape & { messages: StoreMessage[] },
  baseVersion: number,
  force = false,
): Promise<{ ok: true; data: { version: number; updatedAt: number } } | { ok: false; status: number; code?: string; currentVersion?: number }> {
  return jsonFetch<{ version: number; updatedAt: number }>(`${BASE}/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session, baseVersion, force }),
  });
}

export function deleteSessionRemote(id: string): Promise<{ ok: boolean; status: number }> {
  return jsonFetch(`${BASE}/${encodeURIComponent(id)}`, { method: 'DELETE' }).then((r) =>
    r.ok ? { ok: true, status: 200 } : { ok: false, status: r.status },
  );
}

// ---------------------------------------------------------------- IndexedDB 镜像

const DB_NAME = 'chat-lite-sync';
const DB_VERSION = 1;
const STORE = 'sessions';

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') { resolve(null); return; }
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch { resolve(null); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

/** 全量镜像写（启动/合并后调用；量级 ≤ 数百会话，一次事务）。
 *  objectStore keyPath 是 'id'，而快照形状顶层只有 session/version/updatedAt——
 *  写入时补上 id（=session.id），否则 put 抛 DataError 且被静默吞掉
 *  （v0.1 的镜像从未写成功过：这是「每次刷新都冷启动」的真正根因）。 */
export async function cachePutAll(entries: (SessionSnapshot & { active?: boolean })[]): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    const st = tx.objectStore(STORE);
    for (const e of entries) st.put({ ...e, id: e.session.id });
    tx.oncomplete = () => resolve();
    tx.onerror = () => { console.warn('[chat-lite] mirror write failed:', tx.error); resolve(); };
    tx.onabort = () => resolve();
  });
  db.close();
}

export async function cacheGetAll(): Promise<(SessionSnapshot & { active?: boolean })[]> {
  const db = await openDb();
  if (!db) return [];
  const out = await new Promise<(SessionSnapshot & { active?: boolean })[]>((resolve) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve((req.result ?? []) as (SessionSnapshot & { active?: boolean })[]);
    req.onerror = () => resolve([]);
  });
  db.close();
  return out;
}

/** 镜像单条删除（软删除同步；镜像里也不留墓碑——下次冷启动不再见到已删会话） */
export async function cacheDelete(id: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
  db.close();
}

// ---------------------------------------------------------------- 同步编排

export interface SyncCallbacks {
  /** 拉到服务端会话全文后由 store 合并进状态（服务端为权威） */
  applyServerSnapshot: (snap: SessionSnapshot) => void;
  /** 服务端墓碑：从本地移除该会话 */
  applyTombstone: (id: string) => void;
  /** 同步状态变化（驱动侧栏小状态点） */
  setStatus: (s: SyncStatus) => void;
  /** 服务端 loop 运行态表（侧栏「执行中」徽标数据源；随索引轮询刷新） */
  onRunning: (running: Record<string, LoopRunState>) => void;
  /** 冲突上报（409；store 弹「另一台设备已更新」） */
  onConflict: (info: ConflictInfo) => void;
  /** 冷启动引导进度（侧栏 x/y 与「正在同步」空态消费；结束传 null） */
  onBootProgress?: (progress: { done: number; total: number } | null) => void;
  /** 取当前状态（读取会话/版本/流式标记/activeId） */
  getState: () => {
    sessions: (ChatSessionShape & { messages: StoreMessage[] })[];
    versions: Record<string, number>;
    dirty: Set<string>;
    activeId: string | null;
  };
  /** 取指定会话的流式标记（流式中不 push / 不被轮询覆盖） */
  isStreaming: (id: string) => boolean;
  /** 强制覆盖决策（用户点「覆盖服务端」后调用；返回是否执行） */
  forceOverride?: (sessionId: string) => void;
}

export interface SyncHandle {
  start: () => void;
  stop: () => void;
  /** 把 dirty 会话推到服务端（防抖到期 / pagehide 由 store 调用） */
  pushDirty: () => Promise<void>;
  /** 立即拉一次索引（visibilitychange / 发送后调用） */
  pullNow: () => Promise<void>;
  /**
   * 独立档开关（docs/mobile-app-plan.md §10.4，standalone-mode 插件经 cap.mode 驱动）：
   * on=true：暂停服务端 pull/push（离线态下 30s 轮询只产出失败请求），dirty 会话
   * 只写 IndexedDB 本地镜像——手机独立使用时会话不丢；off（回到连接档）：立即对账，
   * 独立期间积攒的 dirty 由常规 pushDirty 补偿上传（R4 恢复后补偿语义）。
   */
  setOfflineMode: (on: boolean) => void;
}

export function createSync(cb: SyncCallbacks): SyncHandle {
  let timer: ReturnType<typeof setInterval> | null = null;
  let pulling = false;
  let started = false;
  let offlineMode = false;
  /** pull 在途期间又收到 index-changed：收尾后补一轮（防「变更落在索引快照之后」被 pulling 丢弃） */
  let pullAgain = false;
  /** 索引 SSE（断线由浏览器自动重连；offline 档主动关闭） */
  let indexEs: EventSource | null = null;

  /** 有界并发执行（冷启动并行拉全文；CONCURRENCY 控制对服务端的瞬时压力） */
  const CONCURRENCY = 6;
  async function mapLimited<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]);
      }
    });
    await Promise.all(workers);
    return out;
  }

  /** 把「服务端索引 + 本地状态」对齐：新会话拉全文、版本变高拉全文、墓碑删除 */
  const pull = async (): Promise<void> => {
    if (pulling || offlineMode) return;
    pulling = true;
    cb.setStatus('syncing');
    try {
      const res = await pullIndex();
      if (!res.ok) {
        cb.setStatus(res.status === 0 ? 'offline' : 'idle');
        return;
      }
      const { sessions, tombstones, running } = res.data;
      const st = cb.getState();

      if (running) cb.onRunning(running);
      for (const tb of tombstones) cb.applyTombstone(tb.id);

      const stale = st.versions;
      const toFetch = sessions.filter((entry) => {
        const localVersion = stale[entry.id] ?? 0;
        const local = st.sessions.find((s) => s.id === entry.id);
        // 本地有且版本更新（未推送的脏会话）→ 不被服务端旧态覆盖
        if (local && localVersion > entry.version) return false;
        // 本地有且版本一致 → 无需拉
        if (local && localVersion === entry.version) return false;
        // 正在流式中的会话：等 settle 后的 push 收敛，本轮跳过
        return !cb.isStreaming(entry.id);
      });
      const booting = toFetch.length > 3;
      if (booting) cb.onBootProgress?.({ done: 0, total: toFetch.length });
      let done = 0;
      const snaps = await mapLimited(toFetch, async (entry) => {
        const snap = await pullSession(entry.id);
        done += 1;
        if (booting) cb.onBootProgress?.({ done, total: toFetch.length });
        return snap;
      });
      if (booting) cb.onBootProgress?.(null);
      const mirrored: (SessionSnapshot & { active?: boolean })[] = [];
      for (let i = 0; i < snaps.length; i++) {
        const snap = snaps[i];
        if (!snap.ok) continue;
        cb.applyServerSnapshot(snap.data);
        mirrored.push(snap.data);
      }
      // 镜像写通（spec v0.2）：在线模式的 pull 结果也落 IndexedDB——刷新秒开 + 会话不重拉
      if (mirrored.length > 0) {
        void cachePutAll(mirrored).catch(() => undefined);
      }
      cb.setStatus('idle');
    } finally {
      pulling = false;
      // pull 期间又有变更到达（事件被 pulling 丢弃）：补一轮，保证推送不漏
      if (pullAgain) {
        pullAgain = false;
        setTimeout(() => { void pull(); }, 50);
      }
    }
  };

  /** 把脏会话推到服务端（防抖窗口到期 / pagehide 时调用）；offlineMode 下只写本地镜像 */
  const pushDirty = async (): Promise<void> => {
    const st = cb.getState();
    const dirtyIds = [...st.dirty];
    if (dirtyIds.length === 0) return;
    // 独立档：服务端不可达——dirty 会话写本地 IndexedDB 镜像（保持 dirty，
    // 回到连接档后由下一轮 pushDirty 补偿上传）
    if (offlineMode) {
      const st2 = cb.getState();
      const entries = dirtyIds
        .map((id) => {
          const session = st2.sessions.find((s) => s.id === id);
          return session ? { session, version: st2.versions[id] ?? 0, updatedAt: Date.now() } : null;
        })
        .filter((e): e is SessionSnapshot => !!e);
      if (entries.length > 0) await cachePutAll(entries);
      cb.setStatus('offline');
      return;
    }
    cb.setStatus('syncing');
    let anyFail = false;
    const mirrored: (SessionSnapshot & { active?: boolean })[] = [];
    for (const id of dirtyIds) {
      const session = st.sessions.find((s) => s.id === id);
      if (!session) { st.dirty.delete(id); continue; }
      if (cb.isStreaming(id)) continue; // 流式中不推（settle 后的下一轮防抖会推）
      const baseVersion = st.versions[id] ?? 0;
      const res = await pushSession(id, session, baseVersion);
      if (res.ok) {
        st.dirty.delete(id);
        st.versions[id] = res.data.version;
        // 镜像写通（spec v0.2）：推成功即落本地镜像（version 与服务端一致）
        mirrored.push({ session, version: res.data.version, updatedAt: res.data.updatedAt });
      } else if (res.status === 409) {
        // 服务端有更新：默认以服务端为准（拉取覆盖）；本地确有更多消息时交由 UI 决策
        st.dirty.delete(id);
        cb.onConflict({ sessionId: id, serverVersion: res.currentVersion ?? 0, serverUpdatedAt: Date.now() });
        const snap = await pullSession(id);
        if (snap.ok && !cb.isStreaming(id)) {
          cb.applyServerSnapshot(snap.data);
          mirrored.push(snap.data);
        }
      } else {
        anyFail = true; // 网络失败：保留 dirty，下一轮重试
      }
    }
    if (mirrored.length > 0) {
      void cachePutAll(mirrored).catch(() => undefined);
    }
    cb.setStatus(anyFail ? 'offline' : 'idle');
  };

  /** 索引 SSE 事件 → 对账（版本比对幂等；事件只当「有变更」的信号用） */
  const onIndexEvent = (): void => {
    if (pulling) { pullAgain = true; return; }
    void pull();
  };

  function openIndexEs(): void {
    if (indexEs || offlineMode || typeof window === 'undefined' || typeof EventSource === 'undefined') return;
    try {
      indexEs = new EventSource(`${BASE}/index-events`);
      // 服务端把 ids 放进 data，但客户端统一走全索引对账（索引轻量、版本比对天然幂等）
      indexEs.addEventListener('index-changed', onIndexEvent);
      indexEs.onopen = () => { void pull(); }; // 重连成功补对账断线期间漏掉的变更
      indexEs.onerror = () => { /* 浏览器自动重连；离线兜底由 30s 轮询承担 */ };
    } catch { /* EventSource 不可用：轮询兜底 */ }
  }

  function closeIndexEs(): void {
    if (!indexEs) return;
    try { indexEs.close(); } catch { /* 已断 */ }
    indexEs = null;
  }

  const handle: SyncHandle = {
    start: () => {
      if (started || typeof window === 'undefined') return;
      started = true;
      timer = setInterval(() => { void pull(); }, POLL_MS);
      document.addEventListener('visibilitychange', onVis);
      window.addEventListener('pagehide', onHide);
      openIndexEs(); // v0.2：推送为主、轮询兜底
      void pull();
    },
    stop: () => {
      if (timer) { clearInterval(timer); timer = null; }
      closeIndexEs();
      if (typeof window !== 'undefined') {
        document.removeEventListener('visibilitychange', onVis);
        window.removeEventListener('pagehide', onHide);
      }
      started = false;
    },
    pullNow: async () => { await pull(); },
    pushDirty: async () => { await pushDirty(); },
    setOfflineMode: (on) => {
      if (offlineMode === on) return;
      offlineMode = on;
      cb.setStatus(on ? 'offline' : 'syncing');
      if (on) closeIndexEs(); // 独立档：宿主不可达，SSE 连接只会产出失败请求
      else openIndexEs();
      if (!on) {
        // 回到连接档：立即对账 + 补偿上传独立期间积攒的 dirty（相遇升级语义）
        void pull();
        void pushDirty();
      }
    },
  };

  const onVis = (): void => {
    if (document.visibilityState === 'visible') void pull();
    else void pushDirty(); // 切后台前把脏会话推上去
  };
  const onHide = (): void => { void pushDirty(); };

  return handle;
}
