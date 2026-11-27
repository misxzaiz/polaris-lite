/**
 * runnerBridge：chat-lite 与服务端 agent-runner 之间的前端桥。
 *
 * 服务端编排（B1，spec：docs/chat-server-orchestration-plan.md）下，页面退化为
 * 「发指令 + 订阅事件 + 渲染」：
 * - start：POST /api/agent/start（服务端起 run；同会话单飞）；
 * - 事件：GET /api/agent/events SSE（Last-Event-Id 续传；事件形状与渲染层一致）；
 * - 审批/交互回填：POST /api/agent/approve|interactive（任意在线设备先到先得）；
 * - 中断：POST /api/agent/interrupt；续写：POST /api/agent/resume；
 * - 刷新恢复：run 进行中刷新页面 → 重新订阅 + Last-Event-Id 之后的增量 + 从
 *   事件日志重放 tool 卡/delta，UI 无缝追平（服务端继续执行不受影响）。
 *
 * 服务端是唯一执行者：支持工具编排的引擎一律走本桥；不支持的引擎与 standalone
 * 独立档（无服务端）走引擎直达 cap.ai.chat。探活仅用于判定服务端是否可达。
 */
import type { StreamEnvelope } from './runnerTypes';
import { SRV } from './serverApi';

interface RunHandle {
  runId: string;
  sessionId: string;
  assistantId: string;
  es: EventSource | null;
  lastSeq: number;
}

/** 当前活跃 run（单会话单飞；跨会话并发由服务端 MAX_CONCURRENT_RUNS 控制） */
const active = new Map<string, RunHandle>();

/** 服务端 runner 可用性缓存（null=未探测） */
let runnerAvailable: boolean | null = null;

/** 事件消费者（chat-lite 的 handleEnvelope；由 bridge 注册） */
type EnvelopeConsumer = (envelope: StreamEnvelope) => void;
let consumer: EnvelopeConsumer | null = null;
/** 全局事件消费者（不随会话切换：ctxStore 的 ai.usage/context.* 水位透视） */
let globalConsumer: EnvelopeConsumer | null = null;

/** 中断回调（run 结束时通知 chat-lite 收敛队列等） */
let onRunEnded: ((sessionId: string) => void) | null = null;

export function setRunnerConsumer(fn: EnvelopeConsumer | null): void {
  consumer = fn;
}
/** 注册全局消费者：ai.usage/context.* 等跨会话事件（ContextMeter 数据源） */
export function setRunnerGlobalConsumer(fn: EnvelopeConsumer | null): void {
  globalConsumer = fn;
}
export function setRunnerEndedHook(fn: ((sessionId: string) => void) | null): void {
  onRunEnded = fn;
}

/** 服务端 runner 探活：GET /api/agent/state（带 cookie；404/401/403 都算不可用） */
export async function probeRunner(): Promise<boolean> {
  if (runnerAvailable !== null) return runnerAvailable;
  try {
    const resp = await fetch(`${SRV.agent}/state?sessionId=__probe__`, { credentials: 'include' });
    // 404=旧服务端无此端点；401=未登录（登录后可用）；403=PLITE_AGENT_RUNNER=0
    runnerAvailable = resp.ok || resp.status === 401;
  } catch {
    runnerAvailable = false;
  }
  return runnerAvailable;
}

/** 探活结果失效（登录态变化/服务端重启后重探） */
export function resetRunnerProbe(): void {
  runnerAvailable = null;
}

/** 本机设备名（「执行中」徽标 hover 展示「xx 发起」用；同一浏览器会话内稳定） */
function deviceName(): string {
  try {
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
    const platform = nav.userAgentData?.platform || nav.platform || '';
    return platform ? `${platform} 浏览器` : '浏览器';
  } catch {
    return '浏览器';
  }
}

/**
 * 发起服务端编排。返回 true=已接入 runner（事件经 SSE 消费）；false=回落旧通道。
 */
export async function startRunnerRun(payload: {
  sessionId: string;
  messageId: string;
  prompt: string;
  history: { role: string; content: unknown }[];
  system?: string;
  /** 引擎 id：服务端据此查通用引擎注册表（resolveModel/runTurn），缺省走 default 引擎 */
  engineId?: string;
  providerId?: string;
  modelId?: string;
  /** 自带目录引擎的模型选择（如 CLI 模型）；服务端适配器自行解释 */
  option?: string;
  /** 会话绑定工作区根 id（服务端据此解析 bash cwd / files 默认根 / system prompt） */
  workspaceId?: string;
  /** 关联只读目录 ids（files 可读、bash 不可达） */
  linkedWorkspaceIds?: string[];
  /** 会话级上下文压缩策略 */
  ctxPolicy?: { autoCompact?: boolean; threshold?: number; keepRecent?: number };
  /** 附件（图片 base64 data URL / 文本内容；vision 由服务端能力表裁定） */
  attachments?: { name?: string; mime?: string; content?: string; textContent?: string }[];
}): Promise<boolean> {
  if (!(await probeRunner())) return false;
  const { sessionId, messageId } = payload;
  // 幂等：同会话已有活跃 run，直接订阅它（服务端单飞语义的客户端镜像）
  const existing = active.get(sessionId);
  if (existing && !isClosed(existing)) {
    return true;
  }
  let resp: Response;
  try {
    resp = await fetch(`${SRV.agent}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ ...payload, device: deviceName() }),
    });
  } catch {
    runnerAvailable = false;
    return false;
  }
  if (!resp.ok) {
    // 服务端拒绝（并发满/无供应商/禁用）：回落旧通道，让旧链路给出用户可见错误
    if (resp.status !== 401) runnerAvailable = runnerAvailable ?? true;
    return false;
  }
  const data = (await resp.json().catch(() => null)) as { ok?: boolean; runId?: string } | null;
  if (!data?.ok || !data.runId) return false;
  const handle: RunHandle = { runId: data.runId, sessionId, assistantId: messageId, es: null, lastSeq: 0 };
  active.set(sessionId, handle);
  subscribe(handle);
  return true;
}

function isClosed(h: RunHandle): boolean {
  return h.es === null || h.es.readyState === EventSource.CLOSED;
}

/** 建立 SSE 订阅；断线自动重连（EventSource 原生）+ Last-Event-Id 续传 */
function subscribe(handle: RunHandle): void {
  if (handle.es) { try { handle.es.close(); } catch { /* 已断 */ } }
  const url = `${SRV.agent}/events?runId=${encodeURIComponent(handle.runId)}&lastEventId=${handle.lastSeq}`;
  const es = new EventSource(url);
  handle.es = es;
  es.addEventListener('agent', (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as { seq: number; kind: string; payload: Record<string, unknown> };
      handle.lastSeq = Math.max(handle.lastSeq, data.seq ?? 0);
      const envelope = { kind: data.kind, payload: data.payload, source: 'agent-runner' } as StreamEnvelope;
      // 事件形状与 cap.agent.loop:event 一致：chat-lite 渲染层零改动
      consumer?.(envelope);
      // 跨会话全局消费（ContextMeter 的 ai.usage / context.* 水位透视）
      globalConsumer?.(envelope);
    } catch { /* 非 JSON 忽略 */ }
  });
  es.addEventListener('run-ended', () => {
    es.close();
    handle.es = null;
    active.delete(handle.sessionId);
    onRunEnded?.(handle.sessionId);
  });
  es.onerror = () => {
    // EventSource 自动重连；连接级错误（服务端重启/run 已结束 404）时：
    // run 结束的服务端会先发 run-ended 帧再关流，这里只在流已 CLOSED 时清理。
    if (es.readyState === EventSource.CLOSED) {
      handle.es = null;
      active.delete(handle.sessionId);
      onRunEnded?.(handle.sessionId);
    }
  };
}

/** 审批回填（任意在线设备先到先得；服务端挂起 Promise） */
export async function resolveRunnerApproval(sessionId: string, callId: string, decision: 'once' | 'always' | 'trust' | 'deny'): Promise<boolean> {
  const handle = active.get(sessionId);
  if (!handle) return false;
  try {
    const resp = await fetch(`${SRV.agent}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ runId: handle.runId, callId, decision }),
    });
    return resp.ok;
  } catch { return false; }
}

/** 交互卡作答回填 */
export async function answerRunnerInteractive(sessionId: string, callId: string, answer: Record<string, unknown>): Promise<boolean> {
  const handle = active.get(sessionId);
  if (!handle) return false;
  try {
    const resp = await fetch(`${SRV.agent}/interactive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ runId: handle.runId, callId, answer }),
    });
    return resp.ok;
  } catch { return false; }
}

/** 截断「继续」：服务端接续上一 run 的 shadow（返回 runId 供 SSE 订阅；事件流与原 run 同构） */
export async function resumeRunnerRun(sessionId: string, messageId: string): Promise<string | null> {
  try {
    const resp = await fetch(`${SRV.agent}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ sessionId, messageId }),
    });
    if (!resp.ok) return null;
    const data = (await resp.json().catch(() => null)) as { ok?: boolean; runId?: string } | null;
    if (!data?.ok || !data.runId) return null;
    const handle: RunHandle = { runId: data.runId, sessionId, assistantId: messageId, es: null, lastSeq: 0 };
    active.set(sessionId, handle);
    subscribe(handle);
    return data.runId;
  } catch { return null; }
}

/** 中断服务端 run */
export async function interruptRunnerRun(sessionId: string): Promise<boolean> {
  const handle = active.get(sessionId);
  if (!handle) return false;
  try {
    const resp = await fetch(`${SRV.agent}/interrupt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ runId: handle.runId }),
    });
    return resp.ok;
  } catch { return false; }
}

/**
 * 刷新恢复：页面加载时对每个会话询问服务端 run 状态；执行中的会话重新订阅
 * （Last-Event-Id 从 0 起——事件日志重放让 UI 重建全部工具卡/正文）。
 * 由 chat-lite setup 在 bootstrap 后调用；只恢复「本端此前发起」的会话没有
 * 记录依据（run 归属在服务端），这里按服务端 running 表全量恢复。
 */
export async function restoreRunnerRuns(sessionIds: string[]): Promise<void> {
  const handler = restoreHandler;
  if (!handler) return;
  if (!(await probeRunner())) return;
  const missing: string[] = [];
  for (const sessionId of sessionIds) {
    if (active.has(sessionId)) continue;
    const att = await findRunningRun(sessionId);
    if (!att) continue;
    // 渲染器挂载失败（会话/消息还没拉到本地）→ 稍后补一次，避免「刷新太快就永远不追平」
    if (!handler(att)) missing.push(sessionId);
  }
  if (missing.length === 0) return;
  setTimeout(() => {
    for (const sessionId of missing) {
      if (active.has(sessionId)) continue;
      void findRunningRun(sessionId).then((att) => {
        if (att) handler(att);
      }).catch(() => undefined);
    }
  }, 2000);
}

/** 会话删除/切走时清理订阅（服务端 run 继续跑，不影响执行） */
export function closeRunnerSession(sessionId: string): void {
  const handle = active.get(sessionId);
  if (!handle) return;
  try { handle.es?.close(); } catch { /* 已断 */ }
  active.delete(sessionId);
}

// ---------------------------------------------------------------- 重开/切回：挂载执行中的 run

/** 挂载参数：从哪起放（lastSeq = 已落进 chat-store 的事件游标） */
export interface RunnerAttach {
  runId: string;
  sessionId: string;
  assistantId: string;
  lastSeq: number;
}

/** 恢复处理器（chat-lite 注入：建/复位 assistant 消息 + 挂 LiveTurn 渲染器） */
type RestoreHandler = (att: RunnerAttach) => boolean;
let restoreHandler: RestoreHandler | null = null;
export function setRunnerRestoreHandler(fn: RestoreHandler | null): void {
  restoreHandler = fn;
}

/**
 * 查询会话是否有执行中的 run（**不订阅**，便于调用方先挂渲染器再订阅）。
 *
 * lastSeq 取服务端 `/state` 的 syncedSeq —— 即 runner 已写进 chat-store 的事件游标。
 * 从 syncedSeq 起放而不是从 0 起：重开时本地已经通过会话快照拿到那部分块，
 * 从 0 重放会把正文块重复追加一遍（工具卡按 callId 幂等，正文不会）。
 */
export async function findRunningRun(sessionId: string): Promise<RunnerAttach | null> {
  if (!(await probeRunner())) return null;
  const existing = active.get(sessionId);
  if (existing && !isClosed(existing)) {
    return { runId: existing.runId, sessionId, assistantId: existing.assistantId, lastSeq: existing.lastSeq };
  }
  try {
    const resp = await fetch(`${SRV.agent}/state?sessionId=${encodeURIComponent(sessionId)}`, { credentials: 'include' });
    if (!resp.ok) return null;
    const data = (await resp.json().catch(() => null)) as
      | { running?: boolean; runId?: string; assistantId?: string; syncedSeq?: number }
      | null;
    if (!data?.running || !data.runId || !data.assistantId) return null;
    return {
      runId: data.runId,
      sessionId,
      assistantId: data.assistantId,
      lastSeq: Number(data.syncedSeq) || 0,
    };
  } catch { return null; }
}

/** 建立订阅（幂等；调用前渲染器必须已就位——重放会立刻投递） */
export function subscribeRunner(att: RunnerAttach): void {
  const existing = active.get(att.sessionId);
  if (existing && !isClosed(existing)) return;
  const handle: RunHandle = {
    runId: att.runId,
    sessionId: att.sessionId,
    assistantId: att.assistantId,
    es: null,
    lastSeq: att.lastSeq,
  };
  active.set(att.sessionId, handle);
  subscribe(handle);
}
