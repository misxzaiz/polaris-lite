/**
 * HTTP 取证：拦截同源 `/api/*` 的 fetch，留住「发了什么、回了什么」。
 *
 * 为什么在这一层做：应用的所有网络调用（模型中继、工具执行、文件、登录）都走
 * `window.fetch`，而模型请求经过 `/api/model-relay` 时请求体就是上游请求体
 * （`{providerId, body}`，body 原样转发）。因此拦截 fetch 就能拿到真实的
 * messages / tools / 参数与上游返回的原始 SSE 帧，**不需要改引擎**。
 *
 * 三条硬约束：
 * 1. 不改变调用行为——请求、响应、流式读取全部原样透传；重包装 SSE 时剔除
 *    content-encoding / content-length（body 已被浏览器解码，留着会让下游出错）。
 * 2. 不阻塞主流程——请求体并行读、流式响应 tee 出旁路分支，绝不 await 主分支。
 * 3. 不存密钥——cookie / authorization 一律脱敏；curl 里用占位符。
 */
import { begin, finish, patch } from './netStore';
import type { HttpKind, HttpRecord, SseSummary } from './netStore';

/** 请求体留存量（附件/大 payload 只留开头） */
const REQ_LIMIT = 64 * 1024;
/** 响应体留存量 */
const RES_LIMIT = 48 * 1024;
/** SSE 原始帧留存量 */
const SSE_RAW_LIMIT = 32 * 1024;

const SECRET_HEADERS = new Set(['cookie', 'authorization', 'x-api-key', 'proxy-authorization', 'set-cookie']);
const SKIP_CURL_HEADERS = new Set([
  'content-length',
  'host',
  'connection',
  'accept-encoding',
  'cookie',
  'authorization',
  'set-cookie',
  'origin',
  'referer',
]);

let nativeFetch: typeof window.fetch | null = null;
let installed = false;

/* ---------------- 供应商上游地址（生成上游 curl 用） ---------------- */

const baseUrls = new Map<string, string>();
let listing: Promise<void> | null = null;

/** 用原生 fetch 取，避免被自己的拦截器记录成一条应用请求 */
function ensureBaseUrls(): Promise<void> {
  if (listing) return listing;
  listing = (async () => {
    try {
      const res = await nativeFetch!('/api/providers/list', { credentials: 'include' });
      if (!res.ok) return;
      const j = (await res.json()) as { configs?: { id?: string; baseURL?: string }[] };
      for (const c of j.configs ?? []) {
        if (typeof c.id === 'string' && typeof c.baseURL === 'string') baseUrls.set(c.id, c.baseURL);
      }
    } catch {
      /* 未登录 / 网络异常：curl 里用占位地址 */
    }
  })();
  return listing;
}

/* ---------------- 工具函数 ---------------- */

function genId(at: number): string {
  return `${at.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function classify(req: Request): HttpKind | null {
  let url: URL;
  try {
    url = new URL(req.url, location.href);
  } catch {
    return null;
  }
  if (url.origin !== location.origin) return null;
  const p = url.pathname;
  if (!p.startsWith('/api/')) return null;
  if (p === '/api/model-relay') return 'model';
  if (p.startsWith('/api/tool')) return 'tool';
  if (p.startsWith('/api/fs')) return 'fs';
  if (p.startsWith('/api/auth')) return 'auth';
  return 'app';
}

function sanitize(entries: [string, string][]): [string, string][] {
  return entries.map(([k, v]) => [k, SECRET_HEADERS.has(k.toLowerCase()) ? '‹已脱敏›' : v]);
}

function cap(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** 单引号字符串里的转义（POSIX shell） */
function esc(s: string): string {
  return s.replace(/'/g, `'\\''`);
}

function toCurl(
  method: string,
  url: string,
  headers: [string, string][],
  body: string | null,
  /** 同源 /api 全部靠 cookie 鉴权，而浏览器不把 cookie 暴露给 Request.headers，必须占位补上 */
  withCookie: boolean,
): string {
  const lines = [method === 'GET' ? `curl '${url}'` : `curl -X ${method} '${url}'`];
  for (const [k, v] of headers) {
    const lk = k.toLowerCase();
    if (SKIP_CURL_HEADERS.has(lk)) continue;
    lines.push(`  -H '${k}: ${esc(v)}'`);
  }
  if (withCookie) lines.push("  -H 'Cookie: plite.sid=<粘贴你的会话 cookie>'");
  if (body) lines.push(`  --data-raw '${esc(body)}'`);
  return lines.join(' \\\n');
}

function buildUpstream(baseURL: string | undefined, body: unknown): { url: string; curl: string } {
  const base = (baseURL ?? 'https://<你的中转地址>/v1').replace(/\/+$/, '');
  const url = `${base}/chat/completions`;
  const payload = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  const curl = [
    `curl '${url}'`,
    "  -H 'Content-Type: application/json'",
    "  -H 'Authorization: Bearer $API_KEY'",
    `  --data-raw '${esc(payload)}'`,
  ].join(' \\\n');
  return { url, curl };
}

interface ReadResult {
  text: string | null;
  bytes: number;
  truncated: boolean;
}

/** 限量读取（超过上限即取消，避免把大附件/大文件整块拉进内存） */
async function readLimited(src: Request | Response, limit: number): Promise<ReadResult> {
  if (!src.body) {
    try {
      const t = await src.text();
      return { text: t, bytes: t.length, truncated: false };
    } catch {
      return { text: null, bytes: 0, truncated: false };
    }
  }
  const reader = src.body.getReader();
  const dec = new TextDecoder();
  let out = '';
  let bytes = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (out.length < limit) out += dec.decode(value, { stream: true });
      if (bytes > limit) {
        truncated = true;
        // 取消副本分支：原请求已发出，原响应由调用方读取，两者互不影响
        try {
          await reader.cancel();
        } catch {
          /* 忽略 */
        }
        break;
      }
    }
    out += dec.decode();
  } catch {
    truncated = truncated || out.length >= limit;
  }
  return { text: out.slice(0, limit), bytes, truncated };
}

interface SseResult {
  summary: SseSummary;
  raw: string;
  bytes: number;
  truncated: boolean;
}

/** 边读边解析：统计帧数、finish_reason、usage、文本长度与工具调用（参数分片拼接） */
async function collectSse(stream: ReadableStream<Uint8Array>): Promise<SseResult> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let frames = 0;
  let textLen = 0;
  let bytes = 0;
  let raw = '';
  let truncated = false;
  let finishReason = '';
  let usage: unknown;
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
        choices?: { finish_reason?: string; delta?: { content?: string; tool_calls?: { index?: number; function?: { name?: string; arguments?: string } }[] } }[];
        usage?: unknown;
      };
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
      /* 非 JSON 帧（厂商自定义）保留原文即可 */
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) takeLine(line);
    }
    if (buf) takeLine(buf);
  } catch {
    /* 中断：已收集的仍然有效 */
  }

  return {
    summary: {
      frames,
      textLen,
      ...(finishReason ? { finishReason } : {}),
      ...(usage !== undefined ? { usage } : {}),
      toolCalls: [...tools.values()].map((t) => ({ name: t.name, args: cap(t.args, 500) })),
      first,
      last: ring,
    },
    raw,
    bytes,
    truncated,
  };
}

/** 重包装流式响应：body 已被浏览器解码，必须剔除编码与长度头 */
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

/* ---------------- 拦截器 ---------------- */

export function installNetTap(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const native = window.fetch.bind(window);
  nativeFetch = native;
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => tap(native, input, init)) as typeof window.fetch;
}

async function tap(native: typeof window.fetch, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let req: Request;
  try {
    req = input instanceof Request && !init ? input : new Request(input as RequestInfo, init);
  } catch {
    // 构造失败（body 已消费等）：绝不因为取证影响调用
    return native(input as RequestInfo, init);
  }

  const kind = classify(req);
  if (!kind) return native(req);

  const at = Date.now();
  const id = genId(at);
  const url = new URL(req.url, location.href);
  const path = `${url.pathname}${url.search}`;
  const reqHeaders = sanitize([...req.headers.entries()]);

  let clone: Request | null = null;
  try {
    clone = req.clone();
  } catch {
    clone = null;
  }
  const bodyPromise = clone ? readLimited(clone, REQ_LIMIT) : Promise.resolve({ text: null, bytes: 0, truncated: false });

  // 先占位：请求一发出，面板里就能看到「进行中」
  begin({
    v: 1,
    id,
    at,
    durMs: 0,
    kind,
    method: req.method,
    path,
    reqHeaders,
    reqBody: null,
    reqBytes: 0,
    status: 0,
    resHeaders: [],
    resBody: null,
    resBytes: 0,
    stream: false,
    truncated: false,
    curl: '',
    live: true,
  });

  const t0 = performance.now();
  let res: Response;
  try {
    res = await native(req);
  } catch (e) {
    const rb = await bodyPromise;
    await finish({
      v: 1,
      id,
      at,
      durMs: Math.round(performance.now() - t0),
      kind,
      method: req.method,
      path,
      reqHeaders,
      reqBody: rb.text,
      reqBytes: rb.bytes,
      status: 0,
      resHeaders: [],
      resBody: null,
      resBytes: 0,
      stream: false,
      truncated: rb.truncated,
      error: e instanceof Error ? e.message : String(e),
      curl: toCurl(req.method, url.href, reqHeaders, rb.text, true),
    });
    throw e;
  }

  const ct = res.headers.get('content-type') ?? '';
  const isStream = ct.includes('text/event-stream') && !!res.body;
  const resHeaders = sanitize([...res.headers.entries()]);
  const rb = await bodyPromise;
  const curl = toCurl(req.method, url.href, reqHeaders, rb.text, true);

  patch(id, {
    status: res.status,
    resHeaders,
    reqBody: rb.text,
    reqBytes: rb.bytes,
    truncated: rb.truncated,
    stream: isStream,
    curl,
  });

  // 模型请求：请求体就是 `{providerId, body}`，body 即上游 payload
  let providerId: string | undefined;
  let upstream: { url: string; curl: string } | undefined;
  if (kind === 'model' && rb.text) {
    try {
      const j = JSON.parse(rb.text) as { providerId?: unknown; body?: unknown };
      if (typeof j.providerId === 'string') {
        providerId = j.providerId;
        await ensureBaseUrls();
        upstream = buildUpstream(baseUrls.get(providerId), j.body);
      }
    } catch {
      /* 非 JSON（理论上不会发生）：跳过上游推导 */
    }
  }

  const base: Omit<HttpRecord, 'resBody' | 'resBytes' | 'truncated' | 'sse'> = {
    v: 1,
    id,
    at,
    durMs: 0,
    kind,
    method: req.method,
    path,
    reqHeaders,
    reqBody: rb.text,
    reqBytes: rb.bytes,
    status: res.status,
    resHeaders,
    stream: isStream,
    curl,
    ...(providerId ? { providerId } : {}),
    ...(upstream ? { upstream } : {}),
  };

  if (isStream && res.body) {
    const [main, side] = res.body.tee();
    void (async () => {
      const agg = await collectSse(side);
      await finish({
        ...base,
        durMs: Math.round(performance.now() - t0),
        resBody: agg.raw,
        resBytes: agg.bytes,
        truncated: rb.truncated || agg.truncated,
        sse: agg.summary,
      });
    })();
    // 主分支立即交还调用方，不等待旁路
    return rewrapStream(res, main);
  }

  // 非流式：clone 出副本后台读，绝不 await
  const copy = (() => {
    try {
      return res.clone();
    } catch {
      return null;
    }
  })();
  void (async () => {
    const body = copy ? await readLimited(copy, RES_LIMIT) : { text: null, bytes: 0, truncated: false };
    await finish({
      ...base,
      durMs: Math.round(performance.now() - t0),
      resBody: body.text,
      resBytes: body.bytes,
      truncated: rb.truncated || body.truncated,
    });
  })();
  return res;
}
