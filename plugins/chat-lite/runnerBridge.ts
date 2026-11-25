/**
 * runnerBridge：chat-lite 与服务端 agent-runner 之间的前端桥。
 *
 * 服务端编排（B1，spec：docs/chat-server-orchestration-plan.md）下，页面退化为
 * 「发指令 + 订阅事件 + 渲染」：
 * - start：POST /api/agent/start（服务端起 run；同会话单飞）；
 * - 事件：GET /api/agent/events SSE（Last-Event-Id 续传；事件形状与
 *   cap.agent.loop:event 完全一致，chat-lite 渲染层零改动）；
 * - 审批/交互回填：POST /api/agent/approve|interactive（任意在线设备先到先得）；
 * - 中断：POST /api/agent/interrupt；
 * - 刷新恢复：run 进行中刷新页面 → 重新订阅 + Last-Event-Id 之后的增量 + 从
 *   事件日志重放 tool 卡/delta，UI 无缝追平（服务端继续执行不受影响）。
 *
 * 与旧通道（cap.agent.loop）的关系：runnerBridge 可用（服务端探活成功）时优先；
 * 失败自动回落旧通道（standalone 独立档/旧版服务端）。降级开关：localStorage
 * plite.runner=off 强制走旧通道。
 */
import type { StreamEnvelope } from './runnerTypes';

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

/** 中断回调（run 结束时通知 chat-lite 收敛队列等） */
let onRunEnded: ((sessionId: string) => void) | null = null;

export function setRunnerConsumer(fn: EnvelopeConsumer | null): void {
  consumer = fn;
}
export function setRunnerEndedHook(fn: ((sessionId: string) => void) | null): void {
  onRunEnded = fn;
}

function runnerDisabledByUser(): boolean {
  try { return localStorage.getItem('plite.runner') === 'off'; } catch { return false; }
}

/** 服务端 runner 探活：GET /api/agent/state（带 cookie；404/401/501 都算不可用） */
export async function probeRunner(): Promise<boolean> {
  if (runnerDisabledByUser()) return false;
  if (runnerAvailable !== null) return runnerAvailable;
  try {
    const resp = await fetch('/api/agent/state?sessionId=__probe__', { credentials: 'include' });
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

/**
 * 发起服务端编排。返回 true=已接入 runner（事件经 SSE 消费）；false=回落旧通道。
 */
export async function startRunnerRun(payload: {
  sessionId: string;
  messageId: string;
  prompt: string;
  history: { role: string; content: unknown }[];
  system?: string;
  providerId?: string;
  modelId?: string;
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
    resp = await fetch('/api/agent/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(payload),
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
  const url = `/api/agent/events?runId=${encodeURIComponent(handle.runId)}&lastEventId=${handle.lastSeq}`;
  const es = new EventSource(url);
  handle.es = es;
  es.addEventListener('agent', (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as { seq: number; kind: string; payload: Record<string, unknown> };
      handle.lastSeq = Math.max(handle.lastSeq, data.seq ?? 0);
      // 事件形状与 cap.agent.loop:event 一致：chat-lite 渲染层零改动
      consumer?.({ kind: data.kind, payload: data.payload, source: 'agent-runner' } as StreamEnvelope);
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
    const resp = await fetch('/api/agent/approve', {
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
    const resp = await fetch('/api/agent/interactive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ runId: handle.runId, callId, answer }),
    });
    return resp.ok;
  } catch { return false; }
}

/** 中断服务端 run */
export async function interruptRunnerRun(sessionId: string): Promise<boolean> {
  const handle = active.get(sessionId);
  if (!handle) return false;
  try {
    const resp = await fetch('/api/agent/interrupt', {
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
  if (!(await probeRunner())) return;
  for (const sessionId of sessionIds) {
    if (active.has(sessionId)) continue;
    try {
      const resp = await fetch(`/api/agent/state?sessionId=${encodeURIComponent(sessionId)}`, { credentials: 'include' });
      if (!resp.ok) continue;
      const data = (await resp.json().catch(() => null)) as { running?: boolean; runId?: string; assistantId?: string } | null;
      if (!data?.running || !data.runId) continue;
      const handle: RunHandle = {
        runId: data.runId,
        sessionId,
        assistantId: data.assistantId ?? '',
        es: null,
        lastSeq: 0,
      };
      active.set(sessionId, handle);
      subscribe(handle);
    } catch { /* 单会话失败不阻断其他 */ }
  }
}

/** 会话删除/切走时清理订阅（服务端 run 继续跑，不影响执行） */
export function closeRunnerSession(sessionId: string): void {
  const handle = active.get(sessionId);
  if (!handle) return;
  try { handle.es?.close(); } catch { /* 已断 */ }
  active.delete(sessionId);
}
