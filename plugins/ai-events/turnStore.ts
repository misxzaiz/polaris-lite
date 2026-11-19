/**
 * 轮次记录（TurnRecord）：把一次「用户输入 → 模型多跳 → 工具往返」压成一条可取证的结构。
 *
 * 为什么不是事件流：一轮对话的事件是几十到几百条（delta 占绝大多数），而验证真正需要的
 * 是「这一轮第几跳调了什么工具、参数什么、输出什么、多久、谁批准」。一轮一条，
 * 查询、导出、对比都直白，也不需要 seq / 回放 / 投影这一整套。
 *
 * 数据来源（全部为现有事件，零改动旁听）：
 *   message.delta / message.done / tool.calls / tool.card
 *   / tool.approval.required / tool.approval.resolved / tool.result
 *   / loop.done / stream.error
 *
 * 落盘：IndexedDB（不是 localStorage——1.5MB 全库额度已被 chat-lite 占满，且同步写阻塞）。
 * delta 只在内存里累加长度，message.done 时一次落库；逐 token 写库会拖垮主线程。
 *
 * 双通道去重：agent-loop 会把引擎事件转发一份（messageId = assistantId），
 * 而引擎原始事件的 messageId 是 `${assistantId}::t${turn}`。含 `::t` 的一律跳过，
 * 否则同一段 delta 会被累加两次。
 */

const DB_NAME = 'plite-ai-events';
/** 2：新增 requests 存储（HTTP 请求取证，见 netStore.ts） */
const DB_VERSION = 2;
const DEVICE_KEY = 'plite-ai-events.device';
/** 单库保留上限（条）。一次对话 1-5 条，2000 条约等于数百次对话 */
const MAX_TURNS = 2000;
const PRUNE_BATCH = 400;
/** 超过这个时长仍未收到 message.done 的轮次视为孤儿（刷新页面/断网），兜底落库 */
const ORPHAN_MS = 10 * 60 * 1000;

export interface ToolCallRecord {
  callId: string;
  name: string;
  command?: string;
  args?: unknown;
  status?: string;
  decision?: string;
  approvalWaitedMs?: number;
  exitCode?: number;
  ms?: number;
  stdout?: string;
  stderr?: string;
  truncated?: boolean;
}

export interface StepRecord {
  index: number;
  /** 该跳「生成」耗时（首个增量到跳结束）。无文本跳为 0，不冒充请求耗时 */
  ms: number;
  finishReason: string;
  textLen: number;
}

export interface TurnRecord {
  v: 1;
  turnId: string;
  sessionId: string;
  deviceId: string;
  startedAt: number;
  endedAt: number;
  steps: StepRecord[];
  tools: ToolCallRecord[];
  outcome: 'done' | 'aborted' | 'error';
  error?: string;
  textLen: number;
  /** agent-loop 自报的轮数，用于交叉校验 steps 是否缺跳 */
  loopTurns?: number;
}

interface Draft {
  key: string;
  turnId: string;
  sessionId: string;
  startedAt: number;
  lastAt: number;
  tools: ToolCallRecord[];
  steps: StepRecord[];
  stepStart: Map<number, number>;
  approvalStart: Map<string, number>;
  curStep: number;
  textLen: number;
  error?: string;
  loopTurns?: number;
}

const drafts = new Map<string, Draft>();
const subscribers = new Set<() => void>();

/** 内存中的轮次快照（面板首屏直接可用，不必等 IndexedDB 回读） */
const recent: TurnRecord[] = [];

function notify(): void {
  for (const fn of subscribers) fn();
}

export function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

function deviceId(): string {
  try {
    const saved = localStorage.getItem(DEVICE_KEY);
    if (saved) return saved;
    const made = `dev-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(DEVICE_KEY, made);
    return made;
  } catch {
    return 'dev-unknown';
  }
}

/* ---------------- IndexedDB ---------------- */

let dbPromise: Promise<IDBDatabase | null> | null = null;

export function openDb(): Promise<IDBDatabase | null> {
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
      if (!db.objectStoreNames.contains('turns')) {
        const store = db.createObjectStore('turns', { keyPath: 'turnId' });
        store.createIndex('byStarted', 'startedAt');
        store.createIndex('bySession', ['sessionId', 'startedAt']);
      }
      // HTTP 取证与轮次分开存：两者生命周期与体积差异很大（一条请求可能带几十 KB 原文）
      if (!db.objectStoreNames.contains('requests')) {
        const store = db.createObjectStore('requests', { keyPath: 'id' });
        store.createIndex('byAt', 'at');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

export function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

async function putTurn(rec: TurnRecord): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction('turns', 'readwrite');
    tx.objectStore('turns').put(rec);
    await txDone(tx);
  } catch {
    /* 隐私模式 / 配额不足：静默降级为仅内存 */
  }
}

async function countTurns(db: IDBDatabase): Promise<number> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction('turns', 'readonly');
      const req = tx.objectStore('turns').count();
      req.onsuccess = () => resolve(Number(req.result) || 0);
      req.onerror = () => resolve(0);
    } catch {
      resolve(0);
    }
  });
}

/** 超限时删最旧的一批（按 byStarted 正序游标） */
async function prune(db: IDBDatabase): Promise<void> {
  const total = await countTurns(db);
  if (total <= MAX_TURNS) return;
  const need = Math.min(PRUNE_BATCH, total - MAX_TURNS + PRUNE_BATCH);
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction('turns', 'readwrite');
      const store = tx.objectStore('turns');
      const req = store.index('byStarted').openCursor(null, 'next');
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

/** 读最近 N 条（byStarted 倒序） */
export async function loadRecent(limit = 300): Promise<TurnRecord[]> {
  const db = await openDb();
  if (!db) return recent.slice(0, limit);
  return new Promise((resolve) => {
    const out: TurnRecord[] = [];
    try {
      const tx = db.transaction('turns', 'readonly');
      const req = tx.objectStore('turns').index('byStarted').openCursor(null, 'prev');
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor || out.length >= limit) {
          resolve(out);
          return;
        }
        out.push(cursor.value as TurnRecord);
        cursor.continue();
      };
      req.onerror = () => resolve(out);
    } catch {
      resolve(out);
    }
  });
}

export async function clearAll(): Promise<void> {
  drafts.clear();
  recent.length = 0;
  notify();
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction('turns', 'readwrite');
    tx.objectStore('turns').clear();
    await txDone(tx);
  } catch {
    /* 忽略 */
  }
}

/* ---------------- 聚合状态机 ---------------- */

function ensureStep(d: Draft, index: number): StepRecord {
  let step = d.steps.find((s) => s.index === index);
  if (!step) {
    step = { index, ms: 0, finishReason: '', textLen: 0 };
    d.steps.push(step);
    if (!d.stepStart.has(index)) d.stepStart.set(index, Date.now());
  }
  return step;
}

function closeStep(d: Draft, index: number, finishReason: string): void {
  const step = d.steps.find((s) => s.index === index);
  if (!step) return;
  if (!step.finishReason) step.finishReason = finishReason;
  const started = d.stepStart.get(index);
  if (started && step.ms === 0) step.ms = Math.max(0, Date.now() - started);
}

function findTool(d: Draft, callId: string): ToolCallRecord | undefined {
  return d.tools.find((t) => t.callId === callId);
}

function parseArgs(raw: unknown): unknown {
  if (typeof raw !== 'string' || !raw) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function pickStr(source: Record<string, unknown>, key: string): string | undefined {
  const v = source[key];
  return typeof v === 'string' ? v : undefined;
}

function pickNum(source: Record<string, unknown>, key: string): number | undefined {
  const v = source[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function ensureDraft(sessionId: string, turnId: string): Draft {
  const key = `${sessionId}::${turnId}`;
  const found = drafts.get(key);
  if (found) {
    found.lastAt = Date.now();
    return found;
  }
  const now = Date.now();
  const made: Draft = {
    key,
    turnId,
    sessionId,
    startedAt: now,
    lastAt: now,
    tools: [],
    steps: [],
    stepStart: new Map(),
    approvalStart: new Map(),
    curStep: 0,
    textLen: 0,
  };
  drafts.set(key, made);
  return made;
}

function toRecord(d: Draft, outcome: TurnRecord['outcome'], error?: string): TurnRecord {
  return {
    v: 1,
    turnId: d.turnId,
    sessionId: d.sessionId,
    deviceId: deviceId(),
    startedAt: d.startedAt,
    endedAt: Date.now(),
    steps: d.steps.slice().sort((a, b) => a.index - b.index),
    tools: d.tools,
    outcome,
    textLen: d.textLen,
    ...(error ? { error } : {}),
    ...(d.loopTurns !== undefined ? { loopTurns: d.loopTurns } : {}),
  };
}

async function finalize(d: Draft, outcome: TurnRecord['outcome'], error?: string): Promise<void> {
  closeStep(d, d.curStep, outcome === 'done' ? 'stop' : outcome === 'aborted' ? 'aborted' : 'error');
  drafts.delete(d.key);
  const rec = toRecord(d, outcome, error);
  recent.unshift(rec);
  if (recent.length > MAX_TURNS) recent.length = MAX_TURNS;
  // 先落库再通知：面板收到通知会回读 IndexedDB，顺序颠倒会读到「还没有这条」的旧快照
  await putTurn(rec);
  notify();
  const db = await openDb();
  if (db) await prune(db);
}

/**
 * 事件入口（交给 `api.listen`）。信封形如 `{ source, kind, payload }`。
 * 无 source 的一律不认（核心内部广播不是流式事件）。
 */
export function ingest(raw: unknown): void {
  const env = raw as { source?: unknown; kind?: unknown; payload?: unknown } | null;
  if (!env || typeof env.source !== 'string' || typeof env.kind !== 'string') return;

  const payload = (env.payload ?? {}) as Record<string, unknown>;
  const sessionId = pickStr(payload, 'sessionId');
  const messageId = pickStr(payload, 'messageId');
  if (!sessionId || !messageId) return;
  // 引擎原始事件（loop 内部跳）：agent-loop 已转发一份不带 ::t 的副本，跳过避免重复累加
  if (messageId.includes('::t')) return;

  const kind = env.kind;
  const callId = pickStr(payload, 'callId');

  switch (kind) {
    case 'message.delta': {
      const delta = pickStr(payload, 'delta');
      if (!delta) return;
      const d = ensureDraft(sessionId, messageId);
      const step = ensureStep(d, d.curStep);
      d.textLen += delta.length;
      step.textLen += delta.length;
      return;
    }
    case 'tool.calls': {
      const d = ensureDraft(sessionId, messageId);
      const turn = pickNum(payload, 'turn') ?? d.curStep;
      ensureStep(d, turn);
      closeStep(d, turn, 'tool_calls');
      d.curStep = turn + 1;
      return;
    }
    case 'tool.card': {
      if (!callId) return;
      const d = ensureDraft(sessionId, messageId);
      if (findTool(d, callId)) return;
      d.tools.push({
        callId,
        name: pickStr(payload, 'name') ?? 'tool',
        ...(pickStr(payload, 'command') ? { command: pickStr(payload, 'command') } : {}),
        ...(parseArgs(payload.argsJson) !== undefined ? { args: parseArgs(payload.argsJson) } : {}),
      });
      return;
    }
    case 'tool.approval.required': {
      if (!callId) return;
      const d = ensureDraft(sessionId, messageId);
      d.approvalStart.set(callId, Date.now());
      return;
    }
    case 'tool.approval.resolved': {
      if (!callId) return;
      const d = ensureDraft(sessionId, messageId);
      const tool = findTool(d, callId);
      if (!tool) return;
      const started = d.approvalStart.get(callId);
      tool.decision = pickStr(payload, 'decision') ?? 'unknown';
      if (started) tool.approvalWaitedMs = Math.max(0, Date.now() - started);
      d.approvalStart.delete(callId);
      return;
    }
    case 'tool.result': {
      if (!callId) return;
      const d = ensureDraft(sessionId, messageId);
      const tool = findTool(d, callId);
      if (!tool) return;
      const status = pickStr(payload, 'status');
      if (status) tool.status = status;
      const exitCode = pickNum(payload, 'exitCode');
      if (exitCode !== undefined) tool.exitCode = exitCode;
      const ms = pickNum(payload, 'durationMs');
      if (ms !== undefined) tool.ms = ms;
      const stdout = pickStr(payload, 'stdout');
      if (stdout !== undefined) tool.stdout = stdout;
      const stderr = pickStr(payload, 'stderr');
      if (stderr !== undefined) tool.stderr = stderr;
      if (payload.truncated === true) tool.truncated = true;
      // 执行完成即下一跳开始：即使模型只发 tool_calls 没有文本，也能记到正确的跳号
      return;
    }
    case 'loop.done': {
      const d = ensureDraft(sessionId, messageId);
      d.loopTurns = pickNum(payload, 'turns');
      return;
    }
    case 'message.done': {
      const d = drafts.get(`${sessionId}::${messageId}`);
      if (!d) return;
      void finalize(d, payload.interrupted === true ? 'aborted' : 'done');
      return;
    }
    case 'stream.error': {
      const d = drafts.get(`${sessionId}::${messageId}`);
      const message = pickStr(payload, 'message') ?? '未知错误';
      if (!d) {
        // 请求在建立草稿前就失败：仍留一条记录，否则"什么都没发生"比错误更难查
        const orphan = ensureDraft(sessionId, messageId);
        void finalize(orphan, 'error', message);
        return;
      }
      void finalize(d, 'error', message);
      return;
    }
    default:
      return;
  }
}

/** 孤儿兜底：刷新/断网不会有 message.done，不兜底就永远停在内存里 */
export function startWatchdog(): void {
  setInterval(() => {
    const now = Date.now();
    for (const d of [...drafts.values()]) {
      if (now - d.lastAt < ORPHAN_MS) continue;
      void finalize(d, 'aborted', '未收到结束事件（页面关闭或连接中断）');
    }
  }, 60_000);
}

/* ---------------- 导出 ---------------- */

export function buildExport(turns: TurnRecord[], scope: string): string {
  return JSON.stringify(
    {
      kind: 'plite-ai-turn-export',
      v: 1,
      exportedAt: new Date().toISOString(),
      device: deviceId(),
      scope,
      count: turns.length,
      turns,
    },
    null,
    2,
  );
}
