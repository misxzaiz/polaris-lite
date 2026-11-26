/**
 * 模型 API 中继（密钥注入点，服务端唯一出口）。
 *
 * 契约（2026-11 密钥下沉后）：
 *   POST /api/model-relay
 *   { providerId, path?='/chat/completions', method?='POST', body? }
 * 浏览器**不再**持有 API Key，也不再传 url/Authorization：
 * 服务端按 providerId 取 baseURL + key，自行拼接并转发。
 *
 * 约束：
 * - 只认宿主登录会话 cookie（未登录 401）；
 * - 上游地址过 SSRF 策略（https + 白名单 + 非私有地址）；
 * - redirect:'manual' 防跳转绕过；请求体上限 5MB；
 * - SSE 逐块透传 + 背压 + X-Accel-Buffering:no；客户端断开即 abort 上游。
 */
import { readJson, sendJson, BODY_LIMIT_LARGE } from './http-util.mjs';
import { Agent, fetch as undiciFetch } from 'undici';

/**
 * 上游 fetch 的专用 dispatcher：拉长 undici 默认超时。
 * 默认 headersTimeout/bodyTimeout 均为 300s——推理模型（nex-n2.6 effort=high 实测）
 * 长思考期间上游不发任何字节，超过 5 分钟中继就会 UND_ERR_HEADERS_TIMEOUT 断流，
 * 表现为「webgl 一类复杂问题 AI 说到一半就中断」。这里放宽到 30 分钟：
 * 连接建立/响应头/两批数据之间的静默都远超人类可感知的思考上限；客户端断开
 * 仍由 AbortController 即时传播，不等 timeout。
 */
const UPSTREAM_TIMEOUT_MS = 30 * 60 * 1000;
const upstreamAgent = new Agent({
  headersTimeout: UPSTREAM_TIMEOUT_MS,
  bodyTimeout: UPSTREAM_TIMEOUT_MS,
});

export function createRelayMiddleware({ store, policy, getSession }) {
  return async function relay(req, res, next) {
    const [pathname] = (req.url ?? '').split('?');
    if (pathname !== '/api/model-relay') return next?.();
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });

    // ① 登录态门禁（同一个 cookie 会话同时守页面与模型调用）
    const session = getSession?.(req);
    if (!session) return sendJson(res, 401, { error: 'unauthorized', code: 'SESSION_REQUIRED' });

    let parsed;
    try {
      parsed = await readJson(req, BODY_LIMIT_LARGE);
    } catch (e) {
      return sendJson(res, e.status ?? 400, { error: e.message, code: e.code ?? 'BAD_REQUEST' });
    }

    // ② 解析供应商（key 只在服务端内存里出现，不写日志）
    const provider = parsed.providerId ? store.get(String(parsed.providerId)) : null;
    if (!provider) return sendJson(res, 400, { error: 'unknown provider', code: 'PROVIDER_NOT_FOUND' });
    if (!provider.apiKey) return sendJson(res, 400, { error: 'provider has no api key', code: 'PROVIDER_NO_KEY' });

    const method = parsed.method === 'GET' ? 'GET' : 'POST';
    const path = typeof parsed.path === 'string' && parsed.path.startsWith('/') ? parsed.path : '/chat/completions';
    const upstreamUrl = `${provider.baseURL}${path}`;
    try {
      policy.assertAllowedUrl(upstreamUrl);
    } catch (e) {
      return sendJson(res, 400, { error: e.message, code: 'UPSTREAM_NOT_ALLOWED' });
    }

    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey}`,
      // 供应商自定义请求头（如 anthropic-version、网关租户头）：由配置声明，
      // 中继只做透传——核心不认识任何具体厂商。
      ...(provider.headers && typeof provider.headers === 'object' ? provider.headers : {}),
    };

    const abort = new AbortController();
    res.on('close', () => abort.abort()); // 客户端断开（中断对话）即中止上游

    try {
      // undici.fetch + 自有 Agent（node 内置 fetch 与 undici 8.x Agent 协议不兼容，
      // 实测 UND_ERR_INVALID_ARG；undici 自带 fetch 与其 Agent 配套正常）
      const up = await undiciFetch(upstreamUrl, {
        method,
        headers,
        body: method === 'GET' ? undefined : JSON.stringify(parsed.body ?? {}),
        redirect: 'manual',
        signal: abort.signal,
        dispatcher: upstreamAgent, // 拉长思考期超时（默认 300s 会掐断长思考，见顶部说明）
      });

      res.writeHead(up.status, {
        'Content-Type': up.headers.get('content-type') ?? 'application/json',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no', // 反代下禁缓冲，保证 SSE 及时下发
      });
      if (!up.body) return res.end();

      const reader = up.body.getReader();
      // 上游传输层中断（区别于客户端断开与正常结束）。此前这里 catch{} 静默吞掉再正常
      // res.end()——前端把断尾当正常结束，表现为「回复说到一半无声停止、零报错」，
      // 服务端日志也无从查证（2026-11-20「对话突然中断」修复的第一环）。
      let upstreamBroke = null;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!res.write(Buffer.from(value))) {
            // 背压：与 close 竞速——客户端中途断开时 drain 永不触发，纯等 drain 会把
            // 本协程永久挂死（连接对象泄漏；此前每次中断都漏一个）。
            await new Promise((r) => { res.once('drain', r); res.once('close', r); });
          }
        }
      } catch (e) {
        if (!abort.signal.aborted) upstreamBroke = e; // 客户端断开走 close→abort，不算上游错
      }
      if (upstreamBroke) {
        // ① 服务端留痕：pm2-error.log 可查上游断流的真实原因（SocketError/timeout 等）
        console.error('[relay] 上游中断:', String(upstreamBroke?.message ?? upstreamBroke));
        // ② 向 SSE 流内追加结构化错误帧，引擎据此向用户报错并自动续写（real-engine 解析
        //   top-level error.code='UPSTREAM_DISCONNECTED'）。仅对 event-stream 追加，
        //   不破坏非流式 JSON 响应的协议。
        if ((up.headers.get('content-type') ?? '').includes('text/event-stream')) {
          try {
            res.write(`data: ${JSON.stringify({
              error: {
                code: 'UPSTREAM_DISCONNECTED',
                message: `上游连接中断：${String(upstreamBroke?.message ?? upstreamBroke)}`,
              },
            })}\n\n`);
          } catch { /* 客户端已离开 */ }
        }
      }
      res.end();
    } catch (e) {
      if (abort.signal.aborted) return; // 客户端主动断开：无需回包
      if (!res.headersSent) {
        sendJson(res, 502, { error: String(e?.message ?? e), code: 'UPSTREAM_FAILED' });
      } else {
        res.end();
      }
    }
  };
}
