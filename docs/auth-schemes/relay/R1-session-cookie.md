# R1 — 会话 Cookie 绑定（中继鉴权方案）

> 对应总纲：`docs/auth-schemes/brief-relay-auth.md` 路线 R1。
> 核心思路：登录成功时由 auth 侧经「页面同源接口」种一个 **HttpOnly + SameSite=Strict** 的会话 Cookie；中继校验该 Cookie。页面与中继同源（经 vite proxy / 反向代理），浏览器自动携带 Cookie，前端与引擎**无需再传任何票据**。登出时清除 Cookie（客户端 + 服务端会话双清）。

---

## 0. 现状问题（为什么必须换掉票据方案）

当前实现（`plugins/relay-server.mjs`）：

- `/relay/token` 签发一次性 60s 票据，`/relay` 校验 `X-Relay-Ticket` 头；
- **但 `/token` 本身无任何鉴权**——任何能访问到代理的人（含内网穿透公网入口）都能 `GET /relay/token` 拿票再打 `/relay`，等于没防（brief 中用户指出的错误设计）；
- 引擎侧（`plugins/real-engine/index.ts` 的 `ensureRelayTicket/relayFetch`）还要维护票据缓存与 403 重试逻辑，复杂度白付。

R1 用「登录会话 Cookie」替代票据：**未登录 = 没有 Cookie = 中继 401**；登录态由服务端会话存储权威判定，前端/引擎零票据逻辑。

---

## 1. 架构图（文字图）

```
┌──────────────────────────── 浏览器（同源 localhost:9825 / 公网反代域名）────────────────────────────┐
│                                                                                                  │
│  ┌──────────────┐   cap.auth:login    ┌──────────────┐   fetch POST /auth/login                  │
│  │  登录 UI      │ ──────────────────▶ │  mock-auth    │ ────────────────────────────────┐      │
│  │ (auth 插槽)   │ ◀─ auth-changed ─── │  插件         │ ◀── Set-Cookie: pl_relay_sid=… ─┘      │
│  └──────────────┘   (壳层放行)        └──────────────┘      (HttpOnly, SameSite=Strict)           │
│                                                    │                                             │
│                                                    │ 写镜像                                       │
│                                                    ▼                                             │
│                                          sessionStorage['mock-auth.session.v1']                  │
│                                          （仅 UI 展示/壳层守卫用，非权威）                          │
│                                                                                                  │
│  ┌──────────────┐   cap.ai.chat        ┌──────────────┐   fetch POST /relay                       │
│  │  chat-lite   │ ──────────────────▶ │  real-engine  │ ────────────────────────────────┐      │
│  │  (对话插件)   │ ◀── stream.* ────── │  插件         │     自动携带 Cookie（同源默认带）  │      │
│  └──────────────┘                     └──────────────┘ ◀── SSE 流 ──────────────────────────┘      │
└────────────────────────────────────────────────┬─────────────────────────────────────────────────┘
                                                 │  vite proxy（dev）/ nginx 反代（prod）
                                                 │  同源转发：/auth/*、/relay → 127.0.0.1:9850
                                                 ▼
┌────────────────────────── 中继进程 relay-server.mjs（仅监听 127.0.0.1:9850）──────────────────────┐
│                                                                                                  │
│  POST /auth/login   → 校验凭据（首次=注册 owner）→ 建服务端会话 → Set-Cookie: pl_relay_sid         │
│  GET  /auth/status  → 读 Cookie → 会话有效? 200 {user,expiresAt} : 401                            │
│  POST /auth/logout  → 删服务端会话 + Set-Cookie 过期 → 204                                        │
│                                                                                                  │
│  POST /relay        → checkRelayAuth(req)：                                                      │
│                        ① 解析 Cookie 取 sid                                                       │
│                        ② 查会话表（存在 + 未过期）→ 无/过期 ⇒ 401                                   │
│                        ③ CSRF 加固：X-Polaris-Relay 头 + Origin 同源校验 ⇒ 不符 ⇒ 403              │
│                        ④ 通过后按白名单转发到供应商（SSE 透传，原逻辑不变）                            │
│                                                                                                  │
│  会话表 sessions: Map<sid, {user, roles, issuedAt, expiresAt}>  ← 权威登录态，服务端持有             │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘

外部攻击面：
  - curl http://公网穿透地址/relay            → 无 Cookie ⇒ 401 ✅
  - curl http://公网穿透地址/auth/login 爆破   → 服务端限速 + 凭据校验（仅注册人可登录）✅
  - 直连 127.0.0.1:9850                       → 进程只绑 loopback，外部不可达 ✅
  - 其他网站发起的跨站请求（CSRF）              → SameSite=Strict 不带 Cookie + 自定义头缺失 ⇒ 403 ✅
```

关键点：**Cookie 只能由服务端 Set-Cookie 种下**（HttpOnly 的本义），所以「种 Cookie 的接口」必须落在唯一的服务端进程——中继进程（经反代对页面同源）。auth 插件负责**发起**登录并触发种 Cookie，中继负责**权威校验**。

---

## 2. Cookie 规范

| 属性 | 值 | 说明 |
|---|---|---|
| 名称 | `pl_relay_sid` | 不用 `__Host-` 前缀（该前缀强制 Secure，内网 http 环境用不了） |
| 值 | 32 字节随机数的 hex（64 字符） | `crypto.randomBytes(32).toString('hex')`，服务端生成，**绝不接受客户端提供的 sid**（防会话固定） |
| Path | `/` | 全站可带 |
| Domain | 不设置 | host-only cookie，避免向子域扩散 |
| HttpOnly | ✅ | JS 不可读，防 XSS 窃取会话 |
| SameSite | `Strict` | 跨站请求一律不带 Cookie，CSRF 第一道防线 |
| Secure | **条件设置** | 仅当检测到 https（`X-Forwarded-Proto === 'https'` 或显式 env `RELAY_COOKIE_SECURE=1`）时加；内网穿透纯 http 环境下不加，否则浏览器静默丢弃 Cookie（详见 §6.3） |
| Max-Age | `43200`（12h） | 与现 mock-auth 会话 12h 对齐；不设 `Expires`（纯 Max-Age 滚动语义简单） |

### 2.1 与 sessionStorage 会话的关系与同步

两者定位不同，**Cookie 是权威，sessionStorage 只是 UI 镜像**：

- `pl_relay_sid`（Cookie）：服务端可验证的登录凭证，中继鉴权的唯一依据。跨标签页共享、刷新保持、（随 Max-Age）关浏览器后 12h 内仍有效。
- `sessionStorage['mock-auth.session.v1']`：仅存 `{ user, tokenDigest, issuedAt }`（不再存明文 token），供壳层路由守卫（`setAuthGuard`）与欢迎页展示。**它的存在不再代表可访问中继**。

同步点（四个）：

1. **登录成功**：`/auth/login` 响应种 Cookie + 返回 user；mock-auth 写 sessionStorage 镜像 + `notifyChanged()`。
2. **登出**：`/auth/logout` 删服务端会话 + 使 Cookie 过期；mock-auth 清镜像 + `notifyChanged()`。双清，不留残态。
3. **应用启动/刷新**：mock-auth `setup()` 里 `GET /auth/status` 对账——Cookie 有效而镜像缺失（如换标签页）⇒ 补写镜像；镜像存在而 Cookie 失效（如中继重启清了会话表）⇒ 清镜像并广播 `auth-changed`，壳层回到登录页。**以服务端结果为准修正本地**。
4. **对话中过期**：real-engine 收到中继 401 ⇒ 经 `api.emit('auth-expired')` 广播；mock-auth 监听该事件，清镜像 + `notifyChanged()`，UI 弹「登录已过期，请重新登录」。

---

## 3. 中继校验逻辑（代码级）

以下改动全部落在 `plugins/relay-server.mjs`（删除票据逻辑，新增 auth 模块）。

### 3.1 会话存储与 Cookie 工具

```js
// ===== 会话与 Cookie（替代原票据模块）=====
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;          // 12h，与 mock-auth 会话对齐
const COOKIE_NAME = 'pl_relay_sid';
const sessions = new Map();                           // sid -> { user, roles, issuedAt, expiresAt }
// 会话表在内存（中继重启 = 全员重登，本机工具形态可接受；生产可落盘 plugins/auth-sessions.json）

// owner 账号从 localStorage 迁到中继侧文件（前端读不到的存储才能做服务端校验）
const ownerFile = resolve(here, 'auth-owner.json');   // { username, passwordHash, salt, registeredAt }

function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function buildSetCookie(sid, { secure }) {
  const attrs = [
    `${COOKIE_NAME}=${sid}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${SESSION_TTL_MS / 1000}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

const CLEAR_COOKIE = `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;

function isHttps(req) {
  // frp/nginx 等 TLS 终结代理会带 X-Forwarded-Proto；也可用 env 强制开启
  if (process.env.RELAY_COOKIE_SECURE === '1') return true;
  return String(req.headers['x-forwarded-proto'] ?? '') === 'https';
}

function createSession(user, roles) {
  const sid = randomBytes(32).toString('hex');        // 每次登录全新 sid（防会话固定）
  sessions.set(sid, { user, roles, issuedAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS });
  return sid;
}
```

### 3.2 鉴权 + CSRF 加固（/relay 的门）

```js
/** 中继鉴权：返回会话 或 { status, body } 错误 */
function checkRelayAuth(req) {
  const sid = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!sid) return { status: 401, body: { error: 'login required' } };

  const sess = sessions.get(sid);
  if (!sess || sess.expiresAt < Date.now()) {
    sessions.delete(sid);
    return { status: 401, body: { error: 'session expired' } };
  }

  // —— CSRF 三重加固（POST 才查）——
  // ① 自定义头：HTML 表单/图片等「简单请求」带不了，纯 CSS/JS 跨站也无法伪造自定义头
  if (req.headers['x-polaris-relay'] !== '1')
    return { status: 403, body: { error: 'missing relay marker' } };
  // ② Origin 同源校验：经反代时 Origin 的 host == Host 头的 host 才放行
  //   （同源 fetch 的 OPTIONS 预检同源场景根本不触发；跨站 fetch 会被浏览器 CORS 拦 + 此处双保险）
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host)
        return { status: 403, body: { error: 'cross-origin denied' } };
    } catch { return { status: 403, body: { error: 'bad origin' } }; }
  }
  return sess; // 通过
}
```

### 3.3 路由装配（替换原 token/relay 分支）

```js
const server = createServer((req, res) => {
  // 注意：不再设置 Access-Control-Allow-Origin: *（同源架构下不需要 CORS 豁免；
  // 跨站请求本来就该被拒，留着 * 反而削弱 Origin 校验）。

  // ---- 认证接口（同源经反代可达；页面直接 fetch，无需票据）----
  if (req.url === '/auth/login' && req.method === 'POST') return handleLogin(req, res);
  if (req.url === '/auth/logout' && req.method === 'POST') return handleLogout(req, res);
  if (req.url === '/auth/status' && req.method === 'GET') return handleStatus(req, res);

  // ---- 中继转发 ----
  if (req.url === '/relay' && req.method === 'POST') {
    const auth = checkRelayAuth(req);
    if (auth.status) { res.writeHead(auth.status); res.end(JSON.stringify(auth.body)); return; }
    return handleProxy(req, res, auth); // auth = 已验证会话；转发逻辑沿用现实现（SSE 透传不变）
  }

  res.writeHead(404); res.end('not found');
});
```

`handleLogin` 要点（凭据校验替代 mock-auth 里的 localStorage 逻辑）：

```js
function handleLogin(req, res) {
  readJsonBody(req, (body) => {
    const username = String(body.username ?? '').trim();
    const password = String(body.password ?? '');
    const owner = readOwnerFile();                    // { username, passwordHash, salt } | null

    if (!owner) {
      // 首次登录 = 注册（与现 mock-auth 语义一致，但记录移到服务端文件）
      const salt = randomBytes(16).toString('hex');
      writeOwnerFile({ username, salt, passwordHash: hashPassword(password, salt), registeredAt: Date.now() });
    } else {
      const ok = username === owner.username
        && timingSafeEqual(Buffer.from(hashPassword(password, owner.salt)), Buffer.from(owner.passwordHash));
      if (!ok) { res.writeHead(401); res.end(JSON.stringify({ error: { code: 'AUTH_INVALID_CREDENTIALS', message: '用户名或密码错误' } })); return; }
    }

    const roles = ['owner', 'user'];
    const sid = createSession({ id: `u-${username}`, name: username }, roles);
    res.setHeader('Set-Cookie', buildSetCookie(sid, { secure: isHttps(req) }));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ status: 'authenticated', user: { id: `u-${username}`, name: username, roles }, expiresAt: Date.now() + SESSION_TTL_MS }));
  });
}

function handleLogout(req, res) {
  const sid = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (sid) sessions.delete(sid);                      // 服务端会话删除（Cookie 值即刻失效）
  res.setHeader('Set-Cookie', CLEAR_COOKIE);
  res.writeHead(204); res.end();
}

function handleStatus(req, res) {
  const sid = parseCookies(req.headers.cookie)[COOKIE_NAME];
  const sess = sid && sessions.get(sid);
  if (!sess || sess.expiresAt < Date.now()) { res.writeHead(401); res.end(JSON.stringify({ status: 'unauthenticated' })); return; }
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ status: 'authenticated', user: sess.user, expiresAt: sess.expiresAt }));
}
```

### 3.4 引擎侧简化（`plugins/real-engine/index.ts`）

删除 `relayTicket` / `ensureRelayTicket` 与 403 重取票据逻辑，`relayFetch` 变成：

```ts
async function relayFetch(body: unknown, apiKey: string, signal?: AbortSignal): Promise<Response> {
  return fetch(RELAY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'X-Polaris-Relay': '1',          // CSRF 加固标记（自定义头，表单伪造不了）
      // 不再有任何 X-Relay-Ticket；Cookie 由浏览器同源自动携带
    },
    credentials: 'same-origin',        // 显式声明（fetch 默认值，写明意图）
    body: JSON.stringify(body),
    signal,
  });
}
```

401 处理（会话过期）：`streamHandler` 里在 `!resp.ok` 分支前加——

```ts
if (resp.status === 401) {
  api.emit('auth-expired', { reason: 'relay-session-expired' }); // mock-auth 监听并清会话、弹登录
  emit({ kind: 'stream.error', payload: { sessionId, messageId, message: '登录已过期，请重新登录后再对话。' } });
  return;
}
```

（`api.emit` 需在 `streamHandler` 可见，可将 handler 改为 `setup(api)` 内定义或把 `api` 存模块级引用，与现有 `refreshProvider` 注入方式一致。）

---

## 4. 登录 / 登出 / 过期三态处理

### 4.1 登录

1. 用户在 auth 插槽提交表单；mock-auth 的 `submit()` 改为直接 `fetch('/auth/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({username,password}) })`（同源，自动可收 Set-Cookie）。也可保留「经 cap.auth 总线」的门面：`cap.auth` handler 内部转调该 fetch，总线契约不变（chat-lite 等调用方无感）。
2. 中继校验通过 ⇒ `Set-Cookie: pl_relay_sid=…; HttpOnly; SameSite=Strict; …` + 返回 `{user, expiresAt}`。
3. mock-auth 写 sessionStorage 镜像 `{ user, tokenDigest: 'cookie', issuedAt }`，`notifyChanged()` → 壳层放行。
4. 登录响应若 200 但浏览器没存下 Cookie（少见，多因误配 Secure），`/auth/status` 复查 401 ⇒ 在 UI 提示「Cookie 写入失败，请检查部署是否为 HTTPS 或关闭 RELAY_COOKIE_SECURE」（见 §6.3）。

### 4.2 登出

1. 用户点登出；mock-auth 调 `fetch('/auth/logout', { method:'POST', headers:{'X-Polaris-Relay':'1'} })`。
2. 中继删服务端会话 + 下发 `Max-Age=0` 的过期 Cookie。
3. mock-auth 清 sessionStorage 镜像 + `notifyChanged()` → 壳层回到登录页。
4. **其他标签页**下一轮请求即 401 → 各自触发 `auth-expired` → 同步回到登录页（Cookie 是共享的，比 sessionStorage 方案登出更彻底）。

### 4.3 过期

- **被动过期**（12h 到期或中继重启丢会话）：下一次 `/relay` 调用返回 401 → real-engine `api.emit('auth-expired')` + `stream.error('登录已过期…')`；mock-auth 清镜像、壳层弹登录。对话不写半截脏数据（错误路径已有 `message.done/interrupted` 语义保护）。
- **刷新续期（可选增强）**：`checkRelayAuth` 通过后若 `expiresAt - now < TTL/2`，顺手 `sess.expiresAt = now + TTL` 并 `Set-Cookie` 续签（滑动过期）。一期可不做，保持绝对 12h，行为可预期。
- **启动对账**：见 §2.1 同步点 3——刷新页面后 `GET /auth/status` 决定镜像去留，避免「Cookie 还活着、UI 却让登录」或「sessionStorage 残留、中继已不认」两个方向的漂移。

---

## 5. 替换性：换成 SSO 插件时 Cookie 由谁种

**原则：谁完成「用户身份认证」，谁负责触发种 Cookie；但 Cookie 的签发与校验永远收敛在中继（服务端）。**

- HttpOnly Cookie 只能由服务端响应种下；本架构信任边界内唯一的服务端就是中继进程（9850，经反代同源）。因此无论 auth 插件怎么换，`Set-Cookie` 都出自中继的 `/auth/*` 接口，会话表也归中继所有——**插件可替换，会话权威不随插件迁移**。
- mock-auth（现状）：插件做「用户名+密码」表单，认证本身在中继 `/auth/login`（凭据文件也在中继侧），成功即种 Cookie。
- 未来 SSO 插件（如 OIDC）：插件负责跳转 IdP、拿回 code/token；随后调中继的 **`POST /auth/session`（交换接口）**，payload 携带 IdP 令牌；中继校验令牌（JWKS 验签或 introspection）通过后，用**同一个** `createSession()` 种**同一种** Cookie。中继的 `checkRelayAuth`、Cookie 规范、会话表**零改动**——换的只是「向 `/auth/*` 证明身份的方式」。
- 对总线的契约：`cap.auth` 提供方必须保证「登录完成后，浏览器持有中继认可的 `pl_relay_sid` Cookie」。这是任何 auth 插件（mock 或 SSO）的落地义务；real-engine 与中继对此无感知。

---

## 6. 风险与对策

### 6.1 CSRF

- Cookie 自动携带是 CSRF 的根源，三重缓解：
  1. `SameSite=Strict`：跨站请求浏览器根本不带 Cookie（现代浏览器全支持）；
  2. 自定义头 `X-Polaris-Relay: 1`：HTML 表单/img 标签等「简单请求」无法携带自定义头；
  3. `Origin` 与 `Host` 一致性校验：跨站 fetch 即使带了也 403。
- 残余风险：极老浏览器不支持 SameSite ⇒ 靠 ②③ 兜底；三者共存，单一失效不致命。
- 同时**移除 `Access-Control-Allow-Origin: *`**：同源架构下不需要 CORS 放行，保留 `*` 会削弱防线。

### 6.2 多标签页

- Cookie 天然跨标签共享：任一标签登录，全部标签可用（优于 sessionStorage 方案——旧方案 B 标签登录态与中继票据各自为政）。
- 登出/过期传播：Cookie 失效后各标签下一次请求各自收到 401 → 各自 `auth-expired` → 各自回登录页。无需 BroadcastChannel。
- 启动对账（`/auth/status`）保证「先开的标签页」在中继会话被清后刷新也能正确回登录页。

### 6.3 内网穿透 http 环境下 Secure 的处理

- 矛盾：`Secure` 要求 https，但 frp/花生壳等内网穿透常以纯 http 暴露；加了 Secure 浏览器会**静默丢弃** Cookie，表现为「登录成功却永远 401」，极难排查。
- 处理：**按部署形态动态决定**——
  - 中继读 `X-Forwarded-Proto`（nginx/frp 的 https 终结会注入）：`https` ⇒ Set-Cookie 带 `Secure`；
  - 纯 http ⇒ 不带 `Secure`（HttpOnly + SameSite=Strict 仍然生效；http 内网风险可控，且这是该形态下唯一可行解）;
  - 提供环境变量 `RELAY_COOKIE_SECURE=1` 强制开启（运维明确知道自己在 https 后面时用）。
- 检测兜底：登录成功后 mock-auth 复查 `/auth/status`，若 401 则提示「Cookie 未写入：若经 HTTPS 反代请确认转发了 X-Forwarded-Proto，或设置 RELAY_COOKIE_SECURE=1」。

### 6.4 其他

- **会话固定**：sid 服务端生成、每次登录重新生成、绝不接受客户端传入 → 无固定攻击面。
- **会话表在内存**：中继重启 = 全员重登。本机工具可接受；要平滑可把 sessions 落盘 `plugins/auth-sessions.json`（一期不做，注明）。
- **XSS 偷 Cookie**：HttpOnly 挡住读取；但 XSS 仍可发起带 Cookie 的请求——属应用层 XSS 防线（依赖审计），不在本方案扩大范围。
- **爆破登录**：`/auth/login` 加简单限速（同 IP 60s 内失败 >5 次拒 429），防内网穿透入口被爆破。
- **与壳层守卫的一致性**：`setAuthGuard` 仍读 sessionStorage 镜像做 UI 级拦截；真正权威是中继。镜像只可能「多拦」（显示未登录但 Cookie 还在）——启动对账会自动修正，不会「多放」。

---

## 7. 实施步骤（文件级）与验证清单

### 7.1 实施步骤

| # | 文件 | 改动 |
|---|---|---|
| 1 | `plugins/relay-server.mjs` | ① 删除票据模块（`TICKET_TTL_MS/tickets/issueTicket/consumeTicket`、`/token`、`/relay/token` 分支、`X-Relay-Ticket` 校验、`Access-Control-Allow-Origin: *`）；② 新增 §3.1 会话/Cookie 工具、`auth-owner.json` 读写（含 `hashPassword(salt+password)` sha256 + `timingSafeEqual`）、登录限速；③ 新增 `/auth/login`、`/auth/logout`、`/auth/status` 路由；④ `/relay` 前置 `checkRelayAuth`，转发逻辑（SSE 透传、域名白名单、5MB 限流）保持不变；⑤ 请求体读取抽 `readJsonBody` 复用 |
| 2 | `plugins/mock-auth/index.tsx` | ① `login` handler/`submit` 改调 `POST /auth/login`（fetch，同源），成功后写 sessionStorage 镜像（只存 user/digest/issuedAt，不再存明文 token）+ `notifyChanged()`；② `logout` 改调 `POST /auth/logout` 后清镜像；③ `setup()` 增加 `GET /auth/status` 启动对账（§2.1 同步点 3）；④ 监听 `auth-expired` 事件清镜像 + `notifyChanged()`；⑤ `setAuthGuard` 逻辑保持（读镜像）；⑥ cap.auth 契约（status/login/logout/check 动作）对外不变 |
| 3 | `plugins/real-engine/index.ts` | ① 删除 `relayTicket/ensureRelayTicket` 与 403 重试；② `relayFetch` 改为 §3.4 版本（加 `X-Polaris-Relay: 1`，去掉票据头）；③ 401 分支 `api.emit('auth-expired')` + 友好错误；④ 中断/流式解析逻辑不动 |
| 4 | `vite.config.ts` | proxy 增加 `'/auth': { target: 'http://127.0.0.1:9850', changeOrigin: false }`；`/relay/token` 代理条目删除，`/relay` 保留 |
| 5 | `plugins/relay-hosts.json`、`build-plugins.mjs` | 无需改动（确认 build 不打包 relay-server.mjs，它仍以独立 node 进程运行） |
| 6 | 文档 | 在本文件追加「实施结果」一节记录实际改动与验证输出 |

依赖顺序：1 → 4 → 2/3（后端接口先立，代理其次，两个插件并行改）。

### 7.2 验证清单（端到端）

- [ ] **未登录直打中继被拒**：`curl -i http://127.0.0.1:9850/relay -X POST -H 'Content-Type: application/json' -d '{"url":"https://api.deepseek.com/chat/completions","body":{}}'` → `401 {"error":"login required"}`；
- [ ] **经公网穿透入口同样被拒**：`curl -i https://<穿透域名>/relay …` → 401（无 Cookie）；
- [ ] **伪造 Cookie 无效**：带 `Cookie: pl_relay_sid=deadbeef` 打 `/relay` → 401；
- [ ] **无标记头被拒（CSRF ①）**：带有效 Cookie 但无 `X-Polaris-Relay` → 403；
- [ ] **跨源 Origin 被拒（CSRF ③）**：`Origin: http://evil.example` → 403；
- [ ] **登录种 Cookie**：页面登录后，DevTools 里 `pl_relay_sid` 存在且 `HttpOnly`（JS `document.cookie` 读不到）、`SameSite=Strict`；
- [ ] **登录后对话正常**：发起对话，SSE 流式输出、多轮上下文、点停止能中断（`message.done{interrupted:true}`）——与改造前行为一致；
- [ ] **登出双清**：登出后 `pl_relay_sid` 消失、`sessionStorage` 镜像清空、再打 `/relay` → 401；服务端会话表中该 sid 已删（用旧 sid 重放也 401）；
- [ ] **过期路径**：手工把会话 `expiresAt` 调小（或重启中继）→ 下次对话收到「登录已过期」提示并回到登录页；
- [ ] **启动对账**：登录后新开标签页（sessionStorage 为空、Cookie 共享）→ 刷新后自动进入已登录态；反向：清服务端会话后刷新 → 回登录页；
- [ ] **http 内网穿透可用**：frp http 域名下登录成功且对话正常（Cookie 无 Secure 正确写入）；若有 https 反代，确认 Cookie 带 Secure 且 `X-Forwarded-Proto` 已转发；
- [ ] **回归**：`pnpm build`（或现有构建脚本）通过；`/auth/status` 未登录返回 401 而不是 500；中继进程仅监听 `127.0.0.1:9850`。

---

## 8. 方案小结

| 维度 | 评价 |
|---|---|
| A 安全正确性 | 未登录/外部 curl 无 Cookie ⇒ 401；票据「人人可取」的缺陷根除；HttpOnly+SameSite+自定义头+Origin 四层防护；凭据哈希+服务端校验 |
| B 架构正确性 | 治本：登录态回归「服务端会话 + 同源 Cookie」这一 Web 标准形态；不依赖「9850 不对外穿透」的部署巧合（穿透入口同样被 Cookie 挡住）；会话权威收敛在中继，SSO 可插拔 |
| C 可实现性与兼容 | 改动集中在 4 个文件；流式/中断/多轮链路完全不动；引擎代码反而变简（删票据逻辑） |
| D 简洁性 | 复用唯一服务端进程，不新增进程/端口；机制是标准 Cookie 会话，无自定义票据协议 |
