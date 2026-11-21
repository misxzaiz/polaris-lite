/**
 * API 调用轨迹取证（transcript-share 前端版 netTap）。
 *
 * 目标：把「发给模型的每一个请求」的可复现轨迹送进服务端分享转录——
 *   请求侧：模型名 / messages 全文 / tools 定义 / 采样与能力参数；
 *   响应侧：SSE 帧数 / usage（tokens）/ finish_reason / 工具调用分片拼接 / 首尾原始帧；
 *   元信息：耗时、HTTP 状态、失败原因、会话归属（X-Plite-Session header）。
 *
 * 与 ai-events/netTap 的区别：那条线是本机 IndexedDB 全量取证（不落地服务端）；
 * 本线只取 /api/model-relay 一类，按 sessionId 归因后批量上报到本插件 server 半边
 * （POST /api/share/trace），落盘进分享转录——分享页与 AI 工具都能看到。
 *
 * 三条硬约束（沿袭 netTap）：
 * 1. 不改变调用行为：请求/响应/流式读取全部原样透传，重包装剔除编码与长度头；
 * 2. 不阻塞主流程：旁路分支绝不 await 主分支，上报失败静默；
 * 3. 不存密钥：cookie/authorization 脱敏；请求体经 redact（与 server 半边同口径双保险）。
 */
import { syncTurnsForSession } from './turnsBridge';

/** 请求体留存量（messages 全文对复盘最有价值，给足；超长截断标记） */
const REQ_LIMIT = 256 * 1024;
/** SSE 原始帧留存量（首尾帧 + 全部 data 行摘要，见 collectSse） */
const SSE_RAW_LIMIT = 64 * 1024;
/** 内存队列上限（防未登录/离线时无限积压；满即丢最旧） */
const QUEUE_MAX = 64;
/** 批量上报间隔 */
const FLUSH_MS = 4000;

export interface TraceToolCall {
  name: string;
  args: string;
}

export interface TraceRecord {
  id: string;
  sessionId: string;
  at: number;
  durMs: number;
  /** HTTP 状态（0=网络失败） */
  status: number;
  model?: string;
  providerId?: string;
  /** 请求体原文（relay 信封 {providerId, body} 的 body，截断保留） */
  reqBody: string | null;
  reqTruncated: boolean;
  /** SSE 摘要 */
  sse?: {
    frames: number;
    textLen: number;
    finishReason?: string;
    usage?: unknown;
    /** 响应侧模型名（SSE 帧回传；与请求 body.model 可能不同——网关改写时可见） */
    responseModel?: string;
    /** SSE 中间 error 帧（UPSTREAM_DISCONNECTED 等，最多 4 条） */
    errors?: string[];
    /** 无 usage 但有帧 → 引擎侧按字符估算（estimated 标记的推断依据） */
    estimated?: true;
    toolCalls: TraceToolCall[];
    first: string[];
    last: string[];
  };
  /** 诊断相关响应头（x-ratelimit 系 / retry-after / content-type；诊断 429 与限流） */
  resHeaders?: Record<string, string>;
  /** 非流式响应体（截断保留） */
  resBody?: string | null;
  error?: string;
}

/** 编排事件（live-event 镜像捕获；delta/reasoning 噪声已在前端过滤） */
export interface TraceEvent {
  sessionId: string;
  kind: string;
  payload: unknown;
  at: number;
}

const queue: TraceRecord[] = [];
const eventQueue: TraceEvent[] = [];
let installed = false;
let flushing = false;

/** 编排事件噪声过滤：delta/reasoning 高频且内容已在转录消息里 */
const EVENT_SKIP = new Set(['message.delta', 'message.reasoning']);
const EVENT_QUEUE_MAX = 512;

function genId(at: number): string {
  return `${at.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function cap(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** 诊断相关响应头（脱敏思路：只挑白名单键，cookie/authorization 天然不入） */
function pickResHeaders(headers: Headers): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  const wanted = ['content-type', 'retry-after'];
  for (const [k, v] of headers.entries()) {
    const lk = k.toLowerCase();
    if (wanted.includes(lk) || lk.startsWith('x-ratelimit-')) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/* ---------------- SSE 边读边析（与 ai-events/netTap 同构，独立实现避免跨插件依赖） ---------------- */

async function collectSse(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let frames = 0;
  let textLen = 0;
  let raw = '';
  let truncated = false;
  let finishReason = '';
  let usage: unknown;
  let responseModel: string | undefined;
  const errors: string[] = [];
  const first: string[] = [];
  const ring: string[] = [];
  const tools = new Map<number, { name: string; args: string }>();

  const takeLine = (line: string): void => {
    const t = line.trim();
    if (!t.startsWith('data:')) return;
    const data = t.slice(5).trim();
    if (!data || data === '[DONE]') return;
    frames += 1;
    if (raw.length < SSE_RAW_LIMIT) raw += `${data}\n`;
    else truncated = true;
    const short = cap(data, 320);
    if (first.length < 6) first.push(short);
    ring.push(short);
    if (ring.length > 4) ring.shift();
    try {
      const j = JSON.parse(data) as {
        model?: unknown;
        error?: unknown;
        choices?: { finish_reason?: string; delta?: { content?: string; tool_calls?: { index?: number; function?: { name?: string; arguments?: string } }[] } }[];
        usage?: unknown;
      };
      if (typeof j.model === 'string' && j.model) responseModel = j.model;
      if (j.error !== undefined && errors.length < 4) errors.push(cap(JSON.stringify(j.error), 320));
      const choice = j.choices?.[0];
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      const delta = choice?.delta;
      if (typeof delta?.content === 'string') textLen += delta.content.length;
      for (const tc of delta?.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        const cur = tools.get(idx) ?? { name: '', args: '' };
        if (tc.function?.name) cur.name = tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        tools.set(idx, cur);
      }
      if (j.usage) usage = j.usage;
    } catch {
      /* 厂商自定义帧：保留原文即可 */
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) takeLine(line);
    }
    if (buf) takeLine(buf);
  } catch {
    /* 中断：已收集部分仍有效 */
  }

  return {
    sse: {
      frames,
      textLen,
      ...(finishReason ? { finishReason } : {}),
      ...(usage !== undefined ? { usage } : {}),
      ...(responseModel ? { responseModel } : {}),
      ...(errors.length ? { errors } : {}),
      ...(usage === undefined && frames > 0 ? { estimated: true as const } : {}),
      toolCalls: [...tools.values()].map((t) => ({ name: t.name, args: cap(t.args, 2000) })),
      first,
      last: ring,
    },
    truncated,
  };
}

/** 限量读文本（超限取消旁路分支） */
async function readLimited(stream: ReadableStream<Uint8Array> | null, limit: number): Promise<{ text: string | null; truncated: boolean }> {
  if (!stream) return { text: null, truncated: false };
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = '';
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (out.length < limit) out += dec.decode(value, { stream: true });
      if (out.length > limit) {
        truncated = true;
        try { await reader.cancel(); } catch { /* ignore */ }
        break;
      }
    }
  } catch {
    truncated = true;
  }
  return { text: out.slice(0, limit), truncated };
}

function rewrapStream(res: Response, body: ReadableStream<Uint8Array>): Response {
  const headers = new Headers(res.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  try {
    return new Response(body, { status: res.status, statusText: res.statusText, headers });
  } catch {
    return new Response(body);
  }
}

/* ---------------- 上报 ---------------- */

function enqueue(rec: TraceRecord): void {
  queue.push(rec);
  if (queue.length > QUEUE_MAX) queue.splice(0, queue.length - QUEUE_MAX);
  void flush();
}

function enqueueEvent(ev: TraceEvent): void {
  if (EVENT_SKIP.has(ev.kind)) return;
  eventQueue.push(ev);
  if (eventQueue.length > EVENT_QUEUE_MAX) eventQueue.splice(0, eventQueue.length - EVENT_QUEUE_MAX);
}

async function flush(): Promise<void> {
  if (flushing || (queue.length === 0 && eventQueue.length === 0)) return;
  flushing = true;
  const batch = queue.splice(0, queue.length);
  const eventsBySession = new Map<string, TraceEvent[]>();
  for (const ev of eventQueue.splice(0, eventQueue.length)) {
    const list = eventsBySession.get(ev.sessionId) ?? [];
    list.push(ev);
    eventsBySession.set(ev.sessionId, list);
  }
  try {
    let dead = false;
    if (batch.length > 0) {
      const res = await fetch('/api/share/trace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ traces: batch }),
      });
      if (!res.ok && (res.status === 401 || res.status === 403 || res.status === 404)) dead = true;
    }
    for (const [sid, list] of eventsBySession) {
      // 上限对齐 chat-store LIVE_EVENT_BATCH_MAX×4（分批语义由服务端护栏兜底）
      for (let i = 0; i < list.length; i += 256) {
        const res = await fetch('/api/share/events', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ sessionId: sid, events: list.slice(i, i + 256) }),
        });
        if (!res.ok && (res.status === 401 || res.status === 403 || res.status === 404)) dead = true;
      }
    }
    if (dead) {
      // 未登录/插件禁用：停止取证上报（面板会话本身也要求登录，语义一致）
      installed = false;
      queue.length = 0;
      eventQueue.length = 0;
    }
  } catch {
    /* 网络闪断：本批丢弃（不回灌，防重复）；后续请求会再触发 flush */
  } finally {
    flushing = false;
    if (queue.length > 0 || eventQueue.length > 0) setTimeout(() => void flush(), FLUSH_MS);
  }
}

/** 拦截器：/api/model-relay（模型请求轨迹）+ /api/chat/sessions/:id/live-event（编排事件）；其余原样放行 */
export function installTraceTap(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const native = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    tap(native, input, init)) as typeof window.fetch;
  setInterval(() => void flush(), FLUSH_MS);
}

async function tap(native: typeof window.fetch, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let req: Request;
  try {
    req = input instanceof Request && !init ? input : new Request(input as RequestInfo, init);
  } catch {
    return native(input as RequestInfo, init);
  }
  let url: URL;
  try {
    url = new URL(req.url, location.href);
  } catch {
    return native(req);
  }
  // 编排事件镜像捕获（agent-loop → chat-store 的批量 POST；服务端只扇出不落盘）
  const mLive = url.pathname.match(/^\/api\/chat\/sessions\/([A-Za-z0-9_-]{1,64})\/live-event$/);
  if (mLive && req.method === 'POST') return tapLiveEvent(native, req, mLive[1]);
  if (url.pathname !== '/api/model-relay' || req.method !== 'POST') return native(req);

  const at = Date.now();
  const id = genId(at);
  // 关联键：real-engine 发请求时带 X-Plite-Session；兜底空串（服务端按 unknown 丢弃）
  const sessionId = req.headers.get('x-plite-session') ?? '';

  let reqText: string | null = null;
  let reqTruncated = false;
  let clone: Request | null = null;
  try { clone = req.clone(); } catch { clone = null; }
  if (clone) {
    try {
      const t = await clone.text();
      reqText = t.length > REQ_LIMIT ? t.slice(0, REQ_LIMIT) : t;
      reqTruncated = t.length > REQ_LIMIT;
    } catch { /* 读失败：轨迹缺请求体，不阻断 */ }
  }

  // 请求体解析出 model / providerId（展示元信息）
  let model: string | undefined;
  let providerId: string | undefined;
  let upstreamBody: unknown;
  if (reqText) {
    try {
      const j = JSON.parse(reqText) as { providerId?: unknown; body?: unknown };
      if (typeof j.providerId === 'string') providerId = j.providerId;
      if (j.body && typeof j.body === 'object') {
        upstreamBody = j.body;
        const m = (j.body as { model?: unknown }).model;
        if (typeof m === 'string') model = m;
      }
    } catch { /* 非 JSON：跳过元信息 */ }
  }

  const t0 = performance.now();
  let res: Response;
  try {
    res = await native(req);
  } catch (e) {
    enqueue({
      id, sessionId, at,
      durMs: Math.round(performance.now() - t0),
      status: 0,
      ...(providerId ? { providerId } : {}),
      ...(model ? { model } : {}),
      reqBody: upstreamBody !== undefined ? JSON.stringify(upstreamBody) : reqText,
      reqTruncated,
      error: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }

  const durMs = Math.round(performance.now() - t0);
  const ct = res.headers.get('content-type') ?? '';
  const isStream = ct.includes('text/event-stream') && !!res.body;
  const resHeaders = pickResHeaders(res.headers);

  const base = {
    id, sessionId, at, durMs,
    status: res.status,
    ...(providerId ? { providerId } : {}),
    ...(model ? { model } : {}),
    ...(resHeaders ? { resHeaders } : {}),
    reqBody: upstreamBody !== undefined ? JSON.stringify(upstreamBody) : reqText,
    reqTruncated,
  };

  if (isStream && res.body) {
    const [main, side] = res.body.tee();
    void (async () => {
      try {
        const agg = await collectSse(side);
        enqueue({ ...base, sse: agg.sse });
      } catch {
        enqueue({ ...base, error: 'trace: sse collect failed' });
      }
    })();
    return rewrapStream(res, main);
  }

  // 非流式：clone 副本旁路读
  let copy: Response | null = null;
  try { copy = res.clone(); } catch { copy = null; }
  void (async () => {
    if (copy) {
      const b = await readLimited(copy.body, 48 * 1024);
      enqueue({ ...base, resBody: b.text });
    } else {
      enqueue(base);
    }
  })();
  return res;
}

/** 编排事件镜像捕获：读 live-event 批量 POST 的 body（clone 旁路），过滤 delta 噪声后入队上报。
 *  服务端（chat-store）只扇出不落盘——这条旁路是编排时间线（tool.calls 完整入参/stream.retry/
 *  审批决策/context 压缩摘要）进分享转录的唯一通道。绝不改变原请求行为。 */
async function tapLiveEvent(native: typeof window.fetch, req: Request, sessionId: string): Promise<Response> {
  // 该会话有活动：顺带把 ai-events 的逐跳轮次同步到服务端（60s 节流，失败静默）
  void syncTurnsForSession(sessionId);
  let clone: Request | null = null;
  try { clone = req.clone(); } catch { clone = null; }
  if (clone) {
    void (async () => {
      try {
        const text = await clone!.text();
        const j = JSON.parse(text) as { events?: { kind?: unknown; payload?: unknown }[] };
        const list = Array.isArray(j.events) ? j.events : [];
        const at = Date.now();
        for (const e of list) {
          if (!e || typeof e.kind !== 'string') continue;
          enqueueEvent({ sessionId, kind: e.kind, payload: e.payload ?? {}, at });
        }
        if (list.length > 0) void flush();
      } catch { /* 非 JSON/读失败：跳过，不阻断 */ }
    })();
  }
  return native(req);
}
