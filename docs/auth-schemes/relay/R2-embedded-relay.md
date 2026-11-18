# R2 宿主内嵌中继（Embedded Relay）方案

> 路线代号：R2。核心主张：**取消独立 9850 中继进程与 9850 端口暴露**，把中继逻辑收编为宿主 HTTP 服务的内置路由 `/api/model-relay`（dev = vite plugin middleware，prod = node server 路由）。天然同源；鉴权复用「登录会话」——宿主内置 auth 路由维护服务端会话（HttpOnly cookie + 服务端会话表），auth 插件（mock-auth）经宿主 API 完成登录并镜像状态；中继路由只放行已登录会话。彻底消除第二个端口与第二套鉴权（一次性票据）。

## 0. 现状与问题回顾

- 现状链路：浏览器 → vite proxy（`vite.config.ts` 的 `/relay`、`/relay/token`）→ `127.0.0.1:9850` 独立进程 `plugins/relay-server.mjs`。
- 已知缺陷（brief-relay-auth 指出）：`/relay/token` 签发票据自身无权限校验，**任何人可取票**；9850 需要随 vite proxy 同机存在，内网穿透/生产部署要额外暴露或代理第二个端口；两套鉴权（登录态 vs 票据）互不相干。
- 消费方（需同步改造）：
  - `plugins/real-engine/index.ts`：`ensureRelayTicket()` + `relayFetch()`（带 `X-Relay-Ticket`，403 重取票据）。
  - `plugins/model-admin/Panel.tsx`：`testConnectivity()` 先 `fetch('/relay/token')` 再带票据 POST `/relay`。
- 鉴权现状：`plugins/mock-auth/index.tsx` 提供 `cap.auth`（status/login/logout/check），会话存 **sessionStorage**（12h），owner 存 **localStorage**；并通过 `window.__POLARIS_LITE_HOST__.setAuthGuard` 给总线挂接口级守卫。**全部在浏览器侧，服务端（vite/node）看不到任何登录态** —— 这是 R2 必须解决的核心问题。

## 1. 架构图（文字图）

```
【dev：vite dev server（唯一进程，唯一端口 9825，pnpm dev 绑定 127.0.0.1）】

  浏览器（同源 http://127.0.0.1:9825）
    │  ①页面/静态资源            ②登录 POST /api/auth/login     ③对话 POST /api/model-relay
    ▼                              ▼                                ▼
  ┌────────────────────── vite server ──────────────────────┐
  │  react() + 内嵌插件 polaris-lite-embedded-host          │
  │  configureServer(server):                               │
  │    server.middlewares.use(authMiddleware)   ← /api/auth/*（login/logout/status）
  │    server.middlewares.use(relayMiddleware)  ← /api/model-relay
  │        │ getSession(req)：读 plite.sid cookie → 会话表 → 未登录 401
  │        ▼                                                │
  │  服务端会话表 Map<sid,{user,roles,expiresAt}> + owner 存储 │
  └─────────────────────────────────────────────────────────┘
                                     │ fetch 转发（白名单 https 域名）
                                     ▼
                       供应商 API（api.openai.com / api.deepseek.com / …）


【prod：node server（唯一进程，唯一端口 9825，可置于反向代理/内网穿透之后）】

  浏览器 ──► 反向代理（可选，透传 X-Forwarded-Proto）
               ▼
  ┌──────────── server/prod-server.mjs（node:http）──────────┐
  │  ①静态资源：serve dist/（SPA fallback 到 index.html）     │
  │  ②auth 路由：authMiddleware（/api/auth/*，种/验 cookie）  │
  │  ③中继路由：relayMiddleware（/api/model-relay，校验会话）  │
  └─────────────────────────────────────────────────────────┘
                                     │ fetch 转发
                                     ▼
                               供应商 API


【登录态从哪来（单一权威）】
  服务端会话表（auth-session.mjs 内 Map<sid, session>）
    ▲ 写入：POST /api/auth/login（凭据校验通过 → 发 HttpOnly cookie plite.sid）
    ▼ 读取：relayMiddleware.getSession(req)（只认 cookie，不认任何票据/请求头令牌）
  mock-auth 插件：cap.auth 的 login/logout 改为委托 /api/auth/*，并把结果镜像到
  sessionStorage（仅供既有壳层门禁 useAuthGate 与 UI 展示）；中继只认 cookie。
```

要点：**同一份 middleware 代码同时插进 dev（vite connect 栈）与 prod（node:http）**，两形态行为一致；9850 进程、`/relay/token` 票据、vite proxy 的 `/relay` 转发全部删除。

## 2. 与现有 mock-auth 登录态的衔接

**谁判断「已登录」：服务端会话表（cookie 侧），不是 sessionStorage。**

- 新增宿主内置 auth 路由（`server/auth-session.mjs`）维护：
  - 会话表：`Map<sid, { user, roles, expiresAt }>`，sid 为 24 字节随机 hex；
  - cookie：`plite.sid`，`HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`（12h，与 mock-auth 原 12h 对齐；HTTPS 部署时追加 `Secure`）；
  - owner 账户存储：**上收到服务端**（首登=注册语义不变），以 JSON 文件持久化（`.polaris-lite/auth-owner.json`，写 sha256 哈希，不存明文/混淆值）。原 localStorage 中的 owner 记录废弃。
- `mock-auth` 插件改造（保持 `cap.auth` 契约不变，chat-lite 与壳层门禁零感知）：
  - `login`：先 `fetch('/api/auth/login', {method:'POST', body:{username,password}})` —— 凭据校验、注册人判定、会话签发全部在宿主路由完成；成功后再把 `{user, issuedAt}` 镜像写入 sessionStorage（维持 `useAuthGate`/欢迎语/登出按钮现状）；
  - `logout`：调 `POST /api/auth/logout`（服务端删会话 + 清 cookie），再清 sessionStorage；
  - `status`：仍读 sessionStorage（壳层门禁用途），但**以服务端为准的语义约束**：cookie 会话已失效时应视为未登录。实现上让 `real-engine` 收到 401 时 `emit stream.error('登录已过期，请重新登录')`，用户重新登录即同时修复两侧；也可以在 `status` case 里并联 `GET /api/auth/status` 做 AND 判定（推荐，见 §7 实施步骤）。
- 为什么必须由服务端持有会话：R2 的安全边界在宿主 HTTP 服务（内网穿透/反代后唯一暴露面）。sessionStorage 里的登录态对服务端不可见也不可验，若中继只看「前端说已登录」，等于没鉴权。cookie + 服务端会话表是唯一能让「同源请求自动携带凭据、服务端可独立裁决」的机制，且 HttpOnly 阻止 JS 读取、SameSite=Lax 阻止跨站携带。
- 总线守卫（`setAuthGuard`）不受影响：它仍由 mock-auth 经 `__POLARIS_LITE_HOST__.setAuthGuard` 注册，判断依据从「sessionStorage 有会话」升级为「sessionStorage 有会话（缓存）且服务端会话有效」。

## 3. 中继路由实现（代码级）

### 3.1 共享核心：`server/relay-core.mjs`（新建）

从 `plugins/relay-server.mjs` 抽取转发逻辑，删除票据机制，加入会话门禁。写成普通 `(req,res,next)` connect 风格，dev/prod 通用：

```js
// server/relay-core.mjs —— 模型 API 中继核心（dev vite middleware 与 prod node server 共用）
export const DEFAULT_HOSTS = [
  'api.openai.com', 'api.deepseek.com', 'api.moonshot.cn',
  'api.anthropic.com', 'dashscope.aliyuncs.com', 'open.bigmodel.cn',
];
const BODY_LIMIT = 5e6;

export function createRelayMiddleware(options = {}) {
  const allowed = new Set([...DEFAULT_HOSTS, ...(options.extraHosts ?? [])]);
  const getSession = options.getSession; // 由宿主 auth 层注入：(req) => session | null

  return function relay(req, res, next) {
    if (req.url !== '/api/model-relay') return next?.();
    if (req.method !== 'POST') { res.writeHead(405); return res.end('method not allowed'); }

    // ① 登录态门禁：只认宿主会话 cookie；未登录/过期一律 401（外部 curl 无 cookie = 401）
    const session = getSession(req);
    if (!session) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'unauthorized', code: 'SESSION_REQUIRED' }));
    }

    // ② 读请求体（聊天载荷有限，整读；超限断开）
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > BODY_LIMIT) req.destroy(); });
    req.on('end', () => {
      let target, parsed;
      try {
        parsed = JSON.parse(body);
        target = new URL(parsed.url);
        if (target.protocol !== 'https:') throw new Error('only https upstream allowed');
        if (!allowed.has(target.hostname)) {
          throw new Error(`host not allowed: ${target.hostname}（如需支持，加入 plugins/relay-hosts.json）`);
        }
      } catch (e) {
        res.writeHead(400); return res.end(JSON.stringify({ error: String(e.message ?? e) }));
      }

      // ③ 转发上游：key 仍由请求头透传（本机工具形态）；redirect:'manual' 防 SSRF 跳转
      const headers = { 'Content-Type': 'application/json' };
      if (req.headers.authorization) headers.Authorization = req.headers.authorization;
      if (req.headers['anthropic-version']) headers['anthropic-version'] = req.headers['anthropic-version'];
      if (req.headers['anthropic-dangerous-direct-browser-access']) {
        headers['anthropic-dangerous-direct-browser-access'] = req.headers['anthropic-dangerous-direct-browser-access'];
      }

      fetch(target, { method: 'POST', headers, body: JSON.stringify(parsed.body ?? {}), redirect: 'manual' })
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
```

### 3.2 dev 接线：`vite.config.ts`（修改）

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { createAuthMiddleware } from './server/auth-session.mjs';
import { createRelayMiddleware } from './server/relay-core.mjs';

// 宿主内嵌 auth + 中继：与生产 node server 共用同一份 middleware
const embeddedHost = {
  name: 'polaris-lite-embedded-host',
  configureServer(server) {
    const auth = createAuthMiddleware();               // /api/auth/*
    server.middlewares.use(auth.middleware);
    server.middlewares.use(createRelayMiddleware({ getSession: auth.getSession })); // /api/model-relay
  },
};

export default defineConfig({
  plugins: [react(), embeddedHost],
  resolve: { alias: { '@': resolve(__dirname, 'src') } },
  server: {
    port: 9825,
    strictPort: true,
    host: '127.0.0.1', // dev 仅本机；对外统一走生产 server/反代（原 0.0.0.0 收紧）
    // 删除原 /relay、/relay/token proxy —— 不再有 9850
  },
  build: { target: 'es2020' },
});
```

`configureServer` 中直接 `server.middlewares.use(...)`（不放在返回函数里）= 挂在 vite 内部中间件**之前**，`/api/auth/*`、`/api/model-relay` 优先于 SPA fallback 命中。

### 3.3 prod 接线：`server/prod-server.mjs`（新建）

```js
// server/prod-server.mjs —— 生产形态：静态 dist + 内嵌 auth/中继路由，单端口
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, extname, join } from 'node:path';
import { createAuthMiddleware } from './auth-session.mjs';
import { createRelayMiddleware } from './relay-core.mjs';
import { readFileSync } from 'node:fs';

const PORT = Number(process.env.PORT ?? 9825);
const dist = resolve(process.cwd(), 'dist');
const auth = createAuthMiddleware({ secureCookies: process.env.PLITE_COOKIE_SECURE === '1' });
const relay = createRelayMiddleware({ getSession: auth.getSession });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
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
```

`package.json` 增加脚本：`"start": "node server/prod-server.mjs"`（配合现有 `build`：`pnpm build && pnpm start`）。

### 3.4 宿主 auth 路由：`server/auth-session.mjs`（新建）

```js
// server/auth-session.mjs —— 宿主登录会话（中继鉴权唯一权威）
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const COOKIE = 'plite.sid';
const TTL_MS = 12 * 60 * 60 * 1000; // 12h，对齐 mock-auth 原会话时长
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export function createAuthMiddleware(options = {}) {
  const sessions = new Map(); // sid -> { user, roles, expiresAt }（单实例内存态）
  const ownerFile = resolve(options.ownerFile ?? '.polaris-lite/auth-owner.json');
  const readOwner = () => (existsSync(ownerFile) ? JSON.parse(readFileSync(ownerFile, 'utf8')) : null);
  const writeOwner = (o) => { mkdirSync(dirname(ownerFile), { recursive: true }); writeFileSync(ownerFile, JSON.stringify(o)); };
  const parseCookies = (req) => Object.fromEntries((req.headers.cookie ?? '').split(';').filter(Boolean).map((p) => {
    const i = p.indexOf('='); return [p.slice(0, i).trim(), decodeURIComponent(p.slice(i + 1).trim())];
  }));
  const getSession = (req) => {
    const sid = parseCookies(req)[COOKIE];
    const s = sid && sessions.get(sid);
    if (!s) return null;
    if (s.expiresAt < Date.now()) { sessions.delete(sid); return null; }
    return s;
  };
  const setSessionCookie = (res, sid) => {
    const secure = options.secureCookies ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL_MS / 1000}${secure}`);
  };

  return {
    getSession, // 供 relayMiddleware 注入
    async middleware(req, res, next) {
      if (!req.url.startsWith('/api/auth/')) return next?.();
      const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
      const readBody = () => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });

      if (req.url === '/api/auth/login' && req.method === 'POST') {
        const { username, password } = JSON.parse((await readBody()) || '{}');
        const u = String(username ?? '').trim(), p = String(password ?? '');
        if (!u || p.length < 4) return json(400, { ok: false, error: { code: 'AUTH_INVALID_CREDENTIALS', message: '用户名/密码不合法' } });
        const owner = readOwner();
        if (!owner) {
          writeOwner({ username: u, passwordHash: sha256(p), registeredAt: Date.now() }); // 首登=注册（服务端权威，仅一次）
        } else if (owner.username !== u || owner.passwordHash !== sha256(p)) {
          return json(401, { ok: false, error: { code: 'AUTH_INVALID_CREDENTIALS', message: '用户名或密码错误（本应用仅支持注册人账号登录）' } });
        }
        const sid = randomBytes(24).toString('hex');
        sessions.set(sid, { user: { id: `u-${u}`, name: u }, roles: owner && owner.username === u ? ['owner', 'user'] : ['user'], expiresAt: Date.now() + TTL_MS });
        setSessionCookie(res, sid);
        return json(200, { ok: true, status: 'authenticated', user: { id: `u-${u}`, name: u } });
      }
      if (req.url === '/api/auth/logout' && req.method === 'POST') {
        const sid = parseCookies(req)[COOKIE];
        if (sid) sessions.delete(sid);
        res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
        return json(200, { ok: true });
      }
      if (req.url === '/api/auth/status' && req.method === 'GET') {
        const s = getSession(req);
        return json(200, s ? { status: 'authenticated', user: s.user, expiresAt: s.expiresAt }
                           : { status: 'unauthenticated', user: null, hasOwner: !!readOwner() });
      }
      return next?.();
    },
  };
}
```

> 兼容说明：会话签发后 `fetch` 同源默认携带 cookie（`credentials` 默认 `same-origin`），`real-engine`、`model-admin` 的请求**无需**显式 `credentials: 'include'`，也不用任何票据头。

## 4. 登录 / 登出 / 过期处理

| 环节 | 行为 |
|---|---|
| 登录 | mock-auth `cap.auth login` → `POST /api/auth/login`。首登=服务端注册 owner（落 `.polaris-lite/auth-owner.json`，sha256）；成功 → 服务端会话表写入 + `Set-Cookie plite.sid`（HttpOnly/SameSite=Lax/12h）。前端镜像 sessionStorage 供壳层门禁。**中继从此只认 cookie。** |
| 登出 | mock-auth `logout` → `POST /api/auth/logout`：服务端删除 sid、下发 `Max-Age=0` 过期 cookie；前端清 sessionStorage。登出后立即 `curl /api/model-relay`（带旧 cookie）= 401。 |
| 过期 | 会话表条目带 `expiresAt`（12h）；`getSession` 惰性过期（读时校验并删除）。中继对过期会话返回 `401 {code:'SESSION_EXPIRED'}`。`real-engine` 捕获 401 后 `emit stream.error('登录已过期，请重新登录')`，壳层经 `auth-changed` 回到登录页；重新登录即重新签发。 |
| 漂移处理 | sessionStorage（UI 门禁）与服务端会话（中继门禁）可能短暂不一致（如 cookie 已过期但 sessionStorage 未清）。约定：**服务端为准**。`cap.auth status` 增加服务端校验（`GET /api/auth/status`），两者都通过才返回 `authenticated`；不一致时以未登录处理并触发重新登录，重新登录会同时修复两侧。 |
| 重放/扩散 | 原票据机制删除。cookie 为长会话凭据，由 HttpOnly + SameSite=Lax + 仅同源路由接收保护；不再存在「可转发的短期票据」。若后续需要更强保证（多设备踢下线、sid 轮换），在 `auth-session.mjs` 内演进，不影响中继路由契约。 |

## 5. 替换性（SSO 插件接入）

中继中间件对鉴权的全部依赖收敛为一个注入函数：`getSession(req) → session|null`。它不知道、也不关心会话由谁签发。替换 mock-auth 为 SSO 插件时：

1. **契约不变**：新插件（如 `sso-auth`）实现同样的 `cap.auth` 能力（status/login/logout/check）与 `auth` 槽位登录组件，`registry.json` 里把 `mock-auth` 置 `enabled:false`、`sso-auth` 置 `true`。壳层门禁 `useAuthGate`、总线 `setAuthGuard`、real-engine 全部零改动。
2. **会话签发仍走宿主**：SSO 流程的最后一步必须是「在宿主路由里建立 plite.sid 会话」，例如：
   - `GET /api/auth/sso/start` → 302 跳转 IdP（client_id/issuer 由 env 配置）；
   - `GET /api/auth/sso/callback?code=...` → 服务端用 code 换 token 并校验 → 调用与密码登录**同一个**内部 `mintSession(user)` 函数种 cookie；
   - `auth-session.mjs` 暴露 `registerVerifier(fn)` 扩展点：`createAuthMiddleware({ verifiers: { sso: async (code) => ({ id, name, roles }) } })`，callback 路由验证通过后复用会话表写入逻辑。
3. **中继零改动**：`/api/model-relay` 继续只做 `getSession → 401/放行`。SSO 会话与密码会话在会话表里同构（`{user, roles, expiresAt}`），可按需在 session 上加 `provider:'sso'` 字段做细粒度策略，但中继默认不区分。
4. **退出**：SSO 插件 logout 调 `POST /api/auth/logout`（+ 可选 IdP end-session 重定向），服务端会话删除逻辑复用。

即：**鉴权提供方可整体替换，会话模型（cookie + 服务端表）与中继门禁是稳定契约。**

## 6. 风险

| # | 风险 | 说明与对策 |
|---|---|---|
| 1 | **dev/prod 差异** | dev=vite connect middleware，prod=node:http 手工链。同一份 middleware 代码消除行为差异；但 cookie `Secure` 标志、`X-Forwarded-Proto` 信任需在 prod 显式配置（`PLITE_COOKIE_SECURE=1`；反代透传 proto 头才置 Secure）。dev 绑定 127.0.0.1，prod 绑定后由反代控制暴露面。验收需覆盖两形态。 |
| 2 | **流式转发（SSE）** | 响应用 `reader.read()` → `res.write` 逐块透传，须保持 `Cache-Control: no-cache` + `X-Accel-Buffering: no` 防反代缓冲；背压用 `res.write()===false → once('drain')`。当前实现客户端中断只静默结束、未向上游传播 abort —— 改进：为每次转发建 `AbortController`，监听 `res.on('close')` 时 `abort()`，避免上游持续空跑（对话中断场景）。 |
| 3 | **白名单维护 / SSRF** | 白名单 = `DEFAULT_HOSTS` + `plugins/relay-hosts.json`（现有机制保留）。风险：自定义域名需重启生效（可加 fs.watch 热载，非必须）；`redirect:'manual'` 防止白名单域 302 跳转到任意域；仅 https、仅 POST、5MB 体限制继续保留。 |
| 4 | **会话表内存态** | 重启即失效（用户需重新登录）、多实例部署需共享存储。lite 单机形态可接受；在文档标注，后续可把 `sessions` 换成 SQLite/Redis 适配，接口不变。 |
| 5 | **双登录态漂移** | sessionStorage（UI 门禁）与服务端 cookie 会话并存，存在短暂不一致窗口。对策见 §4：服务端为准 + status 双查 + 401 触发重登。中期可让 `useAuthGate` 直读 `/api/auth/status`，进一步收敛。 |
| 6 | **旧 owner 数据迁移** | 原 localStorage 明文混淆 owner 与新服务端 sha256 文件不通用。升级后服务端 owner 文件为空 → 首个登录者重新注册（单用户工具可接受）；文档提示即可。 |
| 7 | **CSRF** | 中继与 auth 路由均为同源 POST + JSON body + SameSite=Lax cookie，且已删除 `Access-Control-Allow-Origin: *`（不再需要 CORS 头）。风险低；如需加固可在 auth 路由校验 `Origin` 头同源。 |
| 8 | **API key 仍经浏览器** | key 由前端（config-manager/model-admin）持有并经 `Authorization` 头过中继。R2 解决「谁能用中继」，不改变「key 在浏览器」的本机工具形态。后续演进（服务端托管 key、按会话代填）可在 relay-core 内做，契约不变。 |

## 7. 实施步骤（文件级）与验证清单

### 实施步骤（按序）

1. **新建 `server/auth-session.mjs`**：§3.4 的会话表 + `/api/auth/login|logout|status` 路由 + `getSession` 暴露。
2. **新建 `server/relay-core.mjs`**：§3.1 的 `createRelayMiddleware`（白名单、https 校验、会话 401 门禁、SSE 透传、`redirect:'manual'`、背压、abort 传播）。
3. **修改 `vite.config.ts`**：删除 `/relay`、`/relay/token` proxy；加入 `embeddedHost` 内嵌插件（§3.2）；`server.host` 收紧为 `127.0.0.1`。
4. **新建 `server/prod-server.mjs`** + `package.json` 增加 `"start": "node server/prod-server.mjs"`（§3.3）。
5. **修改 `plugins/real-engine/index.ts`**：`RELAY_URL = '/api/model-relay'`；删除 `relayTicket`、`ensureRelayTicket()` 与 403 重取逻辑；`relayFetch` 变为单次 fetch（§4 语义），对 401 映射为「登录已过期，请重新登录」的 `stream.error`。
6. **修改 `plugins/model-admin/Panel.tsx`**：`testConnectivity` 删除 `/relay/token` 取票，直接 `fetch('/api/model-relay', ...)`。
7. **修改 `plugins/mock-auth/index.tsx`**：`login`/`logout` 委托 `/api/auth/*`（§2、§4）；`status` 增加服务端 `GET /api/auth/status` 双查（服务端为准）；移除 owner 的 localStorage 读写（owner 上收服务端）。
8. **删除 `plugins/relay-server.mjs`**（9850 进程退役）；确认 `plugins/relay-hosts.json` 保留（白名单自定义域仍由它承载，relay-core 读取）。
9. **文档同步**：README/`docs/` 中涉及 9850、`/relay/token`、票据的描述更新为「单端口 9825 + `/api/model-relay` 会话门禁」。

### 验证清单

**dev（pnpm dev，仅 9825）**
- [ ] `netstat`/端口检查：本机只有 9825 监听，9850 不再存在；`curl http://127.0.0.1:9850/relay` 连接拒绝。
- [ ] 未登录直打：`curl -i -X POST http://127.0.0.1:9825/api/model-relay -d '{"url":"https://api.openai.com/v1/chat/completions","body":{}}'` → **401** `SESSION_REQUIRED`。
- [ ] 登录换会话：`curl -c ck -X POST http://127.0.0.1:9825/api/auth/login -H 'Content-Type: application/json' -d '{"username":"u","password":"pass1234"}'` → 200 + `Set-Cookie plite.sid`（HttpOnly）；错误密码 → 401。
- [ ] 登录后转发：带 `-b ck` POST 合法供应商 URL → 200 且 SSE 分块到达（`data: {...}` 逐条）；非白名单域 → 400 `host not allowed`；http:// 目标 → 400。
- [ ] 登出失效：先 `/api/auth/logout`（带 cookie），再打中继 → 401。
- [ ] 过期：手工把会话表 `expiresAt` 调小（或等 TTL）→ 401 `SESSION_EXPIRED`。
- [ ] UI 端到端：浏览器登录 → chat-lite 发起对话 → 流式输出正常；点「停止」中断正常；多轮历史正常；模型供应商面板「测试连通」成功。
- [ ] `pnpm typecheck`（tsc --noEmit）与 `pnpm lint` 通过。

**prod（pnpm build && pnpm start，单端口 9825）**
- [ ] 同一套 curl 矩阵全部复现（401/200/400/401）。
- [ ] `PLITE_COOKIE_SECURE=1` + 反代 HTTPS：cookie 带 `Secure`，页面/对话/中继全部正常。
- [ ] 内网穿透（公网域名 → 9825）：外部 curl 无 cookie 打 `/api/model-relay` → 401；浏览器登录后对话正常（同源 cookie 自动携带）。
- [ ] 重启 server：会话失效 → 前端回到登录页，重新登录后恢复（符合「内存会话表」预期）。

**回归**
- [ ] mock-engine（不走中继）路径不受影响；无 auth 插件时总线 fail-open 行为不回退。
- [ ] 确认仓库中不再有 `/relay/token`、`X-Relay-Ticket`、9850 的存活引用（grep 清零）。
