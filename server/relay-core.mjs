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
      // Anthropic 直连需要显式声明版本
      ...(upstreamUrl.includes('api.anthropic.com') ? { 'anthropic-version': '2023-06-01' } : {}),
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
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!res.write(Buffer.from(value))) {
            await new Promise((r) => res.once('drain', r)); // 背压
          }
        }
      } catch { /* 客户端中断或上游中断 */ }
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
