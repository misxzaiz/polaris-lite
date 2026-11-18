/**
 * 模型 API 中继核心（dev vite middleware 与 prod node server 共用）。
 *
 * - 路由：POST /api/model-relay（单端口 9825，同源）；
 * - 鉴权：只认宿主登录会话 cookie（getSession 由 auth-session 注入）；
 *   未登录/过期一律 401 SESSION_REQUIRED——外部 curl 无 cookie 无法使用；
 * - 上游：仅 https + 白名单域名（DEFAULT_HOSTS + plugins/relay-hosts.json）；
 *   redirect:'manual' 防 SSRF 跳转；5MB 体限制；
 * - SSE 透传：逐块 write + 背压 + X-Accel-Buffering:no；客户端断开时 abort 上游。
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const DEFAULT_HOSTS = [
  'api.openai.com', 'api.deepseek.com', 'api.moonshot.cn',
  'api.anthropic.com', 'dashscope.aliyuncs.com', 'open.bigmodel.cn',
];

/** 读取自定义白名单（plugins/relay-hosts.json，面板新增供应商时追加） */
export function loadExtraHosts() {
  try {
    const file = resolve(process.cwd(), 'plugins/relay-hosts.json');
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  } catch { /* ignore */ }
  return [];
}

const BODY_LIMIT = 5e6;

export function createRelayMiddleware(options = {}) {
  const allowed = new Set([...DEFAULT_HOSTS, ...(options.extraHosts ?? loadExtraHosts())]);
  const getSession = options.getSession; // (req) => session | null，由 auth 层注入

  return function relay(req, res, next) {
    if (req.url !== '/api/model-relay') return next?.();
    if (req.method !== 'POST') {
      res.writeHead(405);
      return res.end('method not allowed');
    }

    // ① 登录态门禁：只认宿主会话 cookie；未登录/过期一律 401（外部 curl 无 cookie = 401）
    const session = getSession(req);
    if (!session) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'unauthorized', code: 'SESSION_REQUIRED' }));
    }

    // ② 读请求体
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > BODY_LIMIT) req.destroy(); });
    req.on('end', () => {
      let target;
      let parsed;
      try {
        parsed = JSON.parse(body);
        target = new URL(parsed.url);
        if (target.protocol !== 'https:') throw new Error('only https upstream allowed');
        if (!allowed.has(target.hostname)) {
          throw new Error(`host not allowed: ${target.hostname}（如需支持，加入 plugins/relay-hosts.json）`);
        }
      } catch (e) {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: String(e.message ?? e) }));
      }

      // ③ 转发上游：key 由请求头透传（本机工具形态）；redirect:'manual' 防 SSRF 跳转
      const headers = { 'Content-Type': 'application/json' };
      if (req.headers.authorization) headers.Authorization = req.headers.authorization;
      if (req.headers['anthropic-version']) headers['anthropic-version'] = req.headers['anthropic-version'];
      if (req.headers['anthropic-dangerous-direct-browser-access']) {
        headers['anthropic-dangerous-direct-browser-access'] = req.headers['anthropic-dangerous-direct-browser-access'];
      }

      const abort = new AbortController();
      res.on('close', () => abort.abort()); // 客户端断开时中止上游（对话中断场景）

      fetch(target, {
        method: 'POST',
        headers,
        body: JSON.stringify(parsed.body ?? {}),
        redirect: 'manual',
        signal: abort.signal,
      })
        .then((up) => {
          res.writeHead(up.status, {
            'Content-Type': up.headers.get('content-type') ?? 'application/json',
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no', // 反代下禁缓冲，保证 SSE 及时下发
          });
          if (!up.body) return res.end();
          const reader = up.body.getReader();
          (async () => {
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (!res.write(Buffer.from(value))) {
                  await new Promise((r) => res.once('drain', r)); // 背压
                }
              }
            } catch { /* 客户端中断（如 real-engine abort）或上游中断 */ }
            res.end();
          })();
        })
        .catch((e) => {
          if (!res.headersSent) res.writeHead(502);
          res.end(JSON.stringify({ error: String(e) }));
        });
    });
  };
}
