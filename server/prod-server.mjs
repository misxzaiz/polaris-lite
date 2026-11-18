/**
 * 生产形态：单端口 node server——静态 dist + 内嵌 auth/中继路由。
 * 与 dev（vite middleware）共用同一份 auth-session/relay-core，行为一致。
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { createAuthMiddleware } from './auth-session.mjs';
import { createRelayMiddleware } from './relay-core.mjs';

const PORT = Number(process.env.PORT ?? 9825);
const dist = resolve(process.cwd(), 'dist');
const auth = createAuthMiddleware({ secureCookies: process.env.PLITE_COOKIE_SECURE === '1' });
const relay = createRelayMiddleware({ getSession: auth.getSession });

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.mjs': 'text/javascript',
};

function serveStatic(req, res) {
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
  let file = join(dist, urlPath === '/' ? 'index.html' : urlPath);
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html'); // SPA fallback
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}

createServer((req, res) => {
  const chain = [auth.middleware, relay.middleware, serveStatic];
  let i = 0;
  const next = () => { const h = chain[i++]; if (h) h(req, res, next); };
  next();
}).listen(PORT, () => console.log(`[polaris-lite] prod server on http://127.0.0.1:${PORT}`));
