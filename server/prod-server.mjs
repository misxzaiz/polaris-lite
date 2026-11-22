/**
 * 生产形态：单端口 node server —— 静态 dist + 内嵌鉴权/供应商/中继路由。
 * 与 dev（vite middleware）共用 server/host.mjs，行为一致。
 *
 * 安全要点：
 * - 静态服务做真实路径校验（原实现 join(dist, decodeURIComponent(url)) 可 `..` 穿越到仓库根）；
 * - 插件产物与入口页禁强缓存（避免旧插件 bundle 继续用旧凭据约定）；
 * - 请求/响应超时，避免慢连接堆积。
 *
 * 形态：导出 createProdServer() 供测试装配；直接 `node server/prod-server.mjs` 时才监听端口。
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHost } from './host.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/** 解析到 dist 内的真实文件路径；越界统一回落到 index.html（SPA fallback） */
export function resolveStatic(rawUrl, dist) {
  const indexPath = join(dist, 'index.html');
  let urlPath;
  try {
    urlPath = decodeURIComponent((rawUrl ?? '/').split('?')[0]);
  } catch {
    return { file: indexPath, fallback: true }; // 畸形 percent-encoding
  }
  const candidate = resolve(dist, `.${urlPath}`); // 绝对化后再校验前缀
  if (candidate !== dist && !candidate.startsWith(dist + sep)) {
    return { file: indexPath, fallback: true }; // 路径穿越尝试
  }
  try {
    const real = realpathSync(candidate);
    if (real !== dist && !real.startsWith(dist + sep)) return { file: indexPath, fallback: true };
    if (!existsSync(real) || statSync(real).isDirectory()) return { file: indexPath, fallback: true };
    return { file: real, fallback: false };
  } catch {
    return { file: indexPath, fallback: true };
  }
}

export function createProdServer({ dist = resolve(process.cwd(), 'dist'), dataDir = process.env.PLITE_DATA_DIR, secureCookies = false, policyOptions } = {}) {
  const { middlewares } = createHost({ dataDir, secureCookies, policyOptions });

  const serveStatic = (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      return res.end('method not allowed');
    }
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ ok: true, uptime: process.uptime() }));
    }
    const { file, fallback } = resolveStatic(req.url, dist);
    const ext = extname(file);
    // 动态清单与外部插件产物禁缓存——真机 E2E 发现：grants/registry/ext-plugins 被按
    // immutable 强缓存一年，手机端永远拉旧版，新旧 manifest/grants 错配致插件加载失败。
    const isDynamicList =
      req.url === '/grants.json' ||
      req.url.startsWith('/plugins/registry.json') ||
      req.url.startsWith('/ext-plugins/');
    const noCache = fallback || ext === '.html' || file.includes(`${sep}plugins${sep}`) || isDynamicList;
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': noCache ? 'no-cache' : 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).on('error', () => res.end()).pipe(res);
  };

  const server = createServer((req, res) => {
    const chain = [...middlewares, serveStatic];
    let i = 0;
    const next = () => {
      const h = chain[i++];
      if (!h) return;
      try {
        h(req, res, next);
      } catch (err) {
        console.error('[polaris-lite] middleware failed:', err);
        if (!res.headersSent) res.writeHead(500);
        res.end('internal error');
      }
    };
    next();
  });

  // 慢连接保护：头 15s、整体 5min（长流式回复仍有余量）
  server.headersTimeout = 15_000;
  server.requestTimeout = 300_000;
  server.keepAliveTimeout = 30_000;
  return server;
}

// 直接运行时才监听（被 import 时不副作用启动）。
// 兼容 PM2 fork 容器：ProcessContainerFork.js 动态 import 本文件且不设 argv[1]，
// 故以 process.env.PM2_HOME 判定「由 PM2 托管」时也视为需要监听（测试 import 不带该 env，不受影响）。
const isMain = (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)))
  || !!process.env.PM2_HOME;
if (isMain) {
  const port = Number(process.env.PORT ?? 9825);
  createProdServer({
    secureCookies: process.env.PLITE_COOKIE_SECURE === '1',
    // 上游策略默认不限制（http/私网均可）；PLITE_UPSTREAM_STRICT=1 恢复旧白名单模式。
    policyOptions: { strict: process.env.PLITE_UPSTREAM_STRICT === '1' },
  })
    .listen(port, () => console.log(`[polaris-lite] prod server on http://127.0.0.1:${port}`));
}
