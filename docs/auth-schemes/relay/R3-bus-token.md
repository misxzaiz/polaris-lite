# R3：总线签发短期令牌（架构级修正版）

> 路线：brief-relay-auth #R3 ｜ 状态：设计定稿（待评审） ｜ 日期：2026-11-18
> 相关代码：`plugins/relay-server.mjs`、`plugins/mock-auth/index.tsx`、`plugins/real-engine/index.ts`、`src/core/bus.ts`、`src/core/hostRuntime.ts`、`vite.config.ts`

## 0. 要修复的缺陷（现状）

- `relay-server.mjs` 的 `GET /token`（即 `/relay/token`）是**无鉴权签票端点**：仅靠 `remoteAddress === 127.0.0.1` 判断。生产形态（内网穿透/反向代理）下，隧道把外部请求转发为本机回环，**外部 curl 经隧道同样表现为 127.0.0.1**，可直接取票打穿中继。
- `real-engine/index.ts::ensureRelayTicket()` 用裸 `fetch('/relay/token')` 取票，与登录态完全无关——未登录也能取到票（只要能触达中继）。
- 票据 60s 一次性，但**签发口是敞开的**，一次性只是限制重放，没有解决「谁都能拿票」。

R3 的正面修复：**票据签发不再走无鉴权 GET**。登录成功后，由 cap.auth 提供方（auth 插件）经总线动作 `cap.auth/issue-relay-token` 签发**短时效、绑定登录会话、可撤销**的中继访问令牌；引擎持令牌调中继；中继用 HMAC 验签。未登录拿不到令牌；登出后旧令牌即时进撤销列表。

## 1. 架构图（文字图）

```
┌────────────────────────── 浏览器（同源页面 9825）──────────────────────────┐
│                                                                          │
│  登录表单 ──login──▶ cap.auth(login) ──▶ mock-auth 插件（cap.auth 提供方） │
│                                            │                             │
│                       ① 首次注册时：派生 relayKey=PBKDF2(password)        │
│                          POST /relay/enroll {key}（一次性 TOFU 注册）      │
│                       ② 登录成功：session 存入 sessionStorage             │
│                                                                          │
│  chat-lite ──cap.ai.chat──▶ real-engine 插件                              │
│                                │                                         │
│                                │ ③ 每次调用前：                          │
│                                │   dispatch(cap.auth/issue-relay-token)  │
│                                │   ←—— 总线内返回短时效令牌（不过网络）   │
│                                ▼                                         │
│                     fetch POST /relay  （vite proxy / 反代 同源转发）      │
│                     Header: X-Relay-Token: <HS256 令牌>                   │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │ 127.0.0.1:9850
                                   ▼
                        ┌── relay-server.mjs（独立中继进程）──┐
                        │ ④ 验签：HMAC-SHA256(relayKey)       │
                        │   校验 exp(±60s) / scope / jti 撤销  │
                        │ ⑤ 通过 → 白名单转发上游（SSE 透传）  │
                        │ ⑥ 失败 → 401/403                    │
                        │ 撤销列表：jti → exp（登出时写入）    │
                        └─────────────────────────────────────┘

登出：chat-lite ──cap.auth(logout)──▶ mock-auth：清 session +
      POST /relay/revoke {jtis, assertion=HMAC(relayKey,...)} ──▶ 中继拉黑 jti（即时失效）
```

关键点：

1. **签发权威是 auth 插件（cap.auth 提供方）**，总线是唯一受控通道：只有声明了 `cap.auth` 能力、且当前存在登录会话的调用，才能拿到令牌；每次签发都进总线审计链（`bus.ts` 只豁免 `cap.meta` 的 describe/list）。
2. **签名密钥（relayKey）不出 auth 插件作用域**；令牌本身是短时效凭证，泄露面被 TTL 与撤销兜底。
3. 令牌经**总线内传递**给引擎（进程内 dispatch），不经过任何网络明文通道；只在打到 `/relay` 时出现在请求头。

## 2. 令牌规范

### 2.1 格式（紧凑三段式，类 JWT，base64url）

```
header.payload.signature
header   = {"alg":"HS256","typ":"polaris-relay-token","v":1}
payload  = {
  "sub":   "<用户名>",
  "sid":   "<登录会话 id = sha256(sessionToken) 前 16 hex>",   // 绑定登录会话（可审计/可追踪）
  "jti":   "<uuid>",                                          // 令牌唯一 id，撤销粒度
  "iat":   1731900000,                                        // 签发时刻（秒）
  "exp":   1731900300,                                        // 过期时刻（秒），TTL=300s
  "scope": "relay"                                            // 仅限中继使用
}
signature = HMAC-SHA256( base64url(header) + "." + base64url(payload), relayKey )
```

### 2.2 密钥（relayKey）

- 派生：`relayKey = PBKDF2-SHA256(password, salt="polaris-lite/relay/v1", iterations=150000, 32B)`，在 **mock-auth 插件内**用 WebCrypto（`crypto.subtle.deriveBits`）派生，**不落 localStorage、不打日志**，随登录会话存 sessionStorage（与会话同生命周期）。
- 注册（enrollment）：首次登录（mock-auth 写入 owner 的同一时机）`POST /relay/enroll {username, key: hex(relayKey)}`。中继把 key 存本地 `plugins/relay-state.json`（仅本机可读）。**TOFU 语义**：与 mock-auth「首个登录者成为注册人」一致——首次注册者绑定密钥；已注册后，同 key 幂等返回 200，不同 key 返回 409。
- 为什么用密码派生而不是随机密钥下发：随机密钥需要「安全下发到浏览器」的通道（页面本身无鉴权，下发即泄露）；密码派生让密钥从不跨网络明文传输，且**多标签页天然同 key**（同密码），enrollment 幂等不会互相冲突。

### 2.3 有效期与重放策略

| 项 | 取值 | 理由 |
|---|---|---|
| TTL | 300s | 覆盖一次长 SSE 对话；过期由引擎在到期前 30s 主动换新 |
| 重放 | **TTL 内可重放**（非一次性） | 流式连接建立后可持续数分钟；一次性票据在并发/重试下会产生竞态（现状 `relayTicket` 缓存 + 403 重取的竞态即此）。可重放窗口由短 TTL + 撤销 + scope 限定兜底 |
| 时钟偏移 | 中继验签允许 ±60s leeway | 浏览器 `Date.now()` 与中继时钟同机偏差极小；60s 容忍 NTP 微调 |
| 绑定 | `sid`（登录会话）而非 IP | 隧道/反代下所有请求同源同 IP，IP 绑定无意义且有假阳性；真正约束是「令牌只在会话存活期间可被签发 + 登出即撤销 + 短 TTL」 |
| 撤销 | jti → 撤销列表（中继内存 Map + 过期 GC） | 登出时由 auth 插件批量上报本会话签发的全部 jti；中继重启撤销列表清空，但 TTL 仍在，暴露窗口有限（可后续持久化到 relay-state.json） |

## 3. cap.auth 新增动作：`issue-relay-token`（契约与权限）

### 3.1 契约

```ts
// 调用方（如 real-engine）：
const res = await api.dispatch<{ token: string; expiresAt: number }>({
  target: 'cap.auth',
  action: 'issue-relay-token',
  payload: {},           // 无需参数；会话由插件内部从 sessionStorage 读取
});
// res.ok === true  → res.data.token 为中继令牌，res.data.expiresAt 为过期毫秒时间戳
// res.ok === false → 未登录（AUTH_REQUIRED）或签名密钥未就绪（RELAY_KEY_MISSING）
```

### 3.2 权限模型（两层，缺一不可）

1. **总线层（`bus.ts::assertAllowed`）**：调用方插件必须在 `manifest.capabilities` 声明 `cap.auth`，否则直接拒绝。`real-engine` 需把 `capabilities: ['cap.config']` 改为 `['cap.config', 'cap.auth']`。
2. **动作层（mock-auth handler 内）**：`cap.auth` 在 `bus.ts::isPublicCap()` 中被豁免总线级 authGuard——这是**有意设计**（login/logout/status 本身必须在未登录时可调）。因此 `issue-relay-token` 的登录校验必须落在 handler 内：

```ts
case 'issue-relay-token': {
  const s = readSession();
  if (!s) {
    return { ok: false, error: { code: 'AUTH_REQUIRED', message: '未登录，无法签发中继令牌' } };
  }
  if (!relayKey) {
    return { ok: false, error: { code: 'RELAY_KEY_MISSING', message: '中继密钥未就绪' } };
  }
  const jti = crypto.randomUUID();
  issuedJtis.push(jti);                       // 记录本会话签发过的 jti，登出时批量撤销
  const token = await mintRelayToken(s.user.name, sidOf(s), jti);
  return { ok: true, token: token.token, expiresAt: token.expiresAt };
}
```

> 说明：`issue-relay-token` 返回的令牌只授予「访问中继」这一种能力（`scope:"relay"`），即使被其他插件拿到也不放大权限；总线审计会记录每次签发的 pluginId，可追溯。

## 4. 中继验签实现（relay-server.mjs，node:crypto）

删除现有 `issueTicket/consumeTicket/GET /token`，替换为：

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

const LEEWAY = 60;               // 秒，时钟偏移容忍
const state = loadState();       // { key: '<hex relayKey>', username, enrolledAt } ← plugins/relay-state.json
const revoked = new Map();       // jti -> exp（秒）；定期 GC

function verifyRelayToken(token) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return { ok: false, reason: 'format' };
  const [h64, p64, s64] = parts;
  let header, payload;
  try {
    header  = JSON.parse(Buffer.from(h64, 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(p64, 'base64url').toString('utf8'));
  } catch { return { ok: false, reason: 'format' }; }

  if (header.alg !== 'HS256' || header.typ !== 'polaris-relay-token') return { ok: false, reason: 'alg' };

  const expected = createHmac('sha256', Buffer.from(state.key, 'hex'))
    .update(`${h64}.${p64}`).digest();
  const given = Buffer.from(s64, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'signature' };        // timingSafeEqual 防时序侧信道
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || now > payload.exp + LEEWAY) return { ok: false, reason: 'expired' };
  if (payload.scope !== 'relay') return { ok: false, reason: 'scope' };
  if (payload.jti && revoked.has(payload.jti)) return { ok: false, reason: 'revoked' };
  return { ok: true, payload };
}
```

请求处理改动（`createServer` 回调内）：

```js
// GET /relay/token、GET /token —— 整体删除（缺陷本体）
if (req.method === 'POST' && req.url === '/relay/enroll') {
  // body: { username, key }；未注册 → 存 state 落盘；同 key → 200 幂等；异 key → 409
}
if (req.method === 'POST' && req.url === '/relay/revoke') {
  // body: { jtis: string[], assertion: hex(HMAC(relayKey, 'revoke:'+jtis.join(','))) }
  // 验 assertion（timingSafeEqual）→ 逐个 revoked.set(jti, exp)；拒绝未验签请求（防恶意撤销 DoS）
}
if (req.method === 'POST' && req.url !== '/relay') { 404 }
const v = verifyRelayToken(req.headers['x-relay-token']);
if (!v.ok) { res.writeHead(401); res.end(JSON.stringify({ error: `relay token ${v.reason}` })); return; }
// ……后续白名单校验 + 上游转发（含 SSE 透传）逻辑不变
```

配套：`Access-Control-Allow-Headers` 中 `X-Relay-Ticket` 改为 `X-Relay-Token`；上游转发、域名白名单（`DEFAULT_HOSTS` + `relay-hosts.json`）、5MB 体限制、SSE 透传全部保持不变。

## 5. 登录 / 登出 / 过期处理

### 5.1 登录成功（mock-auth `case 'login'`）

1. 校验凭据（现有逻辑不变，含「首登即注册」owner 模型）。
2. 派生 `relayKey`（若本会话尚未持有）：`deriveBits(PBKDF2(password, 'polaris-lite/relay/v1', 150000))` → 32 字节，存入 `StoredSession`（sessionStorage，随 12h 会话存续）。
3. **首次注册分支**（`!owner`）：`POST /relay/enroll` 登记 relayKey（fire-and-forget，失败仅告警不阻断登录；中继未启动时下次登录自愈重试）。
4. 写会话、`notifyChanged()`、返回 status（现有流程）。
   - 实现注意：`createAuthHandler` 的 `login` 分支改为 async（`bus.dispatch` 已 `await reg.handler(req)`，类型 `CapabilityHandler` 允许 Promise，无需改总线）。

### 5.2 登出（mock-auth `case 'logout'` + UI 登出按钮）

1. 取本会话记录的 `issuedJtis`（模块级数组，签发时追加）。
2. `POST /relay/revoke { jtis, assertion = HMAC(relayKey, 'revoke:'+jtis.join(',')) }`——fire-and-forget；**即使撤销失败（断网/中继重启），TTL=300s 仍封顶泄露窗口**。
3. 清 sessionStorage、清 `relayKey`/`issuedJtis`、`notifyChanged()`。
4. 效果：旧令牌即时失效（撤销列表命中 → `401 revoked`）；未登录后任何插件再调 `issue-relay-token` 得 `AUTH_REQUIRED`，**无法再获得新令牌**。

### 5.3 过期

- **令牌过期**：real-engine 缓存 `{ token, expiresAt }`，每次 `relayFetch` 前若 `expiresAt - now < 30_000` 则重新 `dispatch(issue-relay-token)`；中继返回 401 时作废缓存、重签一次再试（对齐现有 403 重试结构，仅一次，防循环）。
- **会话过期（12h）**：`issue-relay-token` 返回 `AUTH_REQUIRED` → engine 向 chat-lite 发 `stream.error{ message: '登录已过期，请重新登录' }`；壳层 authGate 也会因 `auth-changed`/status 检查拦截后续受保护 cap。

## 6. 替换性：SSO 插件如何接手

`cap.auth` 是可替换提供方（Polaris「核心可替换、一切皆插件」的 lite 映射）。第三方 `sso-auth` 插件要接管中继鉴权，只需满足同一契约：

1. **manifest**：`provides: ['cap.auth']`，`capabilities: ['cap.auth']`（与 mock-auth 相同）。
2. **登录**：完成自身 SSO/OAuth 流程后，向宿主 `setAuthGuard` 注册登录态判断（现有 `window.__POLARIS_LITE_HOST__.setAuthGuard` 通道，bus 每次受保护 dispatch 前回调）。
3. **密钥/信任锚（二选一）**：
   - 简单路径：沿用 `/relay/enroll` TOFU——SSO 插件在首次登录成功后生成随机 relayKey 注册（与现有 owner-TOFU 信任级别一致）；
   - 正式路径：令牌改由 SSO 服务端签发（RS256/Ed25519），中继按 `header.kid` 查公钥验签（`verifyRelayToken` 的 HMAC 分支替换为按 alg 白名单分发即可，令牌三段式格式不变）。
4. **签发/撤销**：实现 `issue-relay-token`（同返回结构 `{ token, expiresAt }`）与 logout 时的 `/relay/revoke` 上报。引擎侧零改动——它只认 `cap.auth/issue-relay-token` 契约，不关心提供方是谁。

## 7. 风险与对策

| 风险 | 场景 | 对策 |
|---|---|---|
| 令牌泄露窗口 | XSS / 恶意浏览器扩展 / 代理日志记录请求头 | TTL=300s 硬上限；登出即撤销；不打令牌日志（中继仅记 reason，不记 token 全文）；令牌走请求头而非 Cookie，无跨站自动携带面 |
| 时钟偏移 | 浏览器与中继时钟不一致导致合法令牌被拒/过期令牌被收 | ±60s leeway；中继与页面同机部署（127.0.0.1），偏差本就趋近 0 |
| 多标签页 | sessionStorage 按标签页隔离 → 多个并发会话、多个 jti | 同密码 → 同 relayKey，enrollment 幂等不冲突；撤销按 jti 粒度，A 标签页登出不误杀 B（与 sessionStorage 会话语义一致）。若要「一处登出全局失效」，后续将会话上移 localStorage + 会话版本号，或中继侧建会话注册表（记为增强项，不阻塞本方案） |
| enrollment TOFU | 隧道暴露后，攻击者抢在 owner 之前 `POST /relay/enroll` | 与 mock-auth「首登即 owner」同一信任模型；enroll 仅在 owner 注册流程内触发；relay-state.json 仅本机可写，被篡改=本机已失守（超出威胁模型）；恢复方式：删除 relay-state.json 重启中继即重置 |
| relayKey 静态存储 | relay-state.json（中继侧）与 sessionStorage（浏览器侧）存放密钥材料 | 与现状 owner 密码混淆存储（localStorage）同级风险，本机工具形态可接受；生产化应迁移到服务端会话（R1/R2 方向），本方案不掩盖该边界 |
| 令牌重放 | TTL 内截获令牌重放 | 可重放是有意取舍（流式长连接需要）；窗口 300s、scope 限定 relay、上游域名白名单限制用途；撤销列表支持紧急拉黑 |
| 恶意撤销 DoS | 攻击者乱调 /relay/revoke 拉黑合法 jti | revoke 必须携带 `HMAC(relayKey, ...)` 断言，验签不过直接 401 |
| 密钥派生迭代成本 | PBKDF2 150k 次在低端设备登录时卡顿 | 仅登录/注册时派生一次并随会话缓存；SSO 替换场景可完全绕开 |

## 8. 实施步骤（文件级）

1. **`plugins/relay-server.mjs`**（核心改造）
   - 删除：`issueTicket`、`consumeTicket`、`TICKET_TTL_MS`、`GET /token|/relay/token` 分支、`X-Relay-Ticket` 头。
   - 新增：`relay-state.json` 读写（enroll 落盘）、`POST /relay/enroll`、`POST /relay/revoke`（HMAC 断言校验）、`verifyRelayToken`（第 4 节代码）、`/relay` 校验改为 `X-Relay-Token` 验签、撤销 Map GC（`setInterval` 清理过期 jti）。
   - 不变：端口 9850、监听 127.0.0.1、CORS 头（仅换 header 名）、域名白名单、SSE 透传、5MB 限制。
2. **`plugins/mock-auth/index.tsx`**
   - 新增：`deriveRelayKey(password)`（WebCrypto PBKDF2）、`enrollRelayKey()`、`mintRelayToken()`（HS256，WebCrypto `crypto.subtle.sign`，b64url 编码）、`issuedJtis` 记录、`revokeIssued()`。
   - 修改：`StoredSession` 增加 `relayKey`；`case 'login'` 改 async（派生 + 注册 + 写会话）；新增 `case 'issue-relay-token'`（第 3.2 节代码）；`case 'logout'` 先撤销后清会话。
   - 不变：owner 模型、sessionStorage 会话、`auth-changed` 广播、`setAuthGuard` 注册、manifest（已 declares/provides cap.auth）。
3. **`plugins/real-engine/index.ts`**
   - manifest：`capabilities: ['cap.config', 'cap.auth']`。
   - `ensureRelayTicket()` → `ensureRelayToken()`：改为 `api.dispatch({ target:'cap.auth', action:'issue-relay-token' })`；缓存 `{token, expiresAt}`，到期前 30s 换新。
   - `relayFetch()`：头 `X-Relay-Ticket` → `X-Relay-Token`；401 时作废缓存重签一次再试；签发失败发 `stream.error{ '登录已过期，请重新登录' }`。
   - 不变：cap.ai.chat / interrupt 契约、running map 精确中断、中断补发 `message.done`。
4. **`vite.config.ts`**：删除 `/relay/token` 代理条目（端点已不存在），保留 `/relay`；更新注释。
5. **`src/core/types.ts`**（可选）：导出 `RelayTokenResult { token: string; expiresAt: number }` 供两插件复用。
6. **文档**：本文档；`judging.md` 评分后更新。

## 9. 验证清单

环境：本机起 vite（9825）+ 中继（9850），浏览器访问 9825。

- [ ] **未登录直接 curl 中继**：`curl -i http://127.0.0.1:9850/relay/token` → 404（端点已删除）；`curl -i -X POST http://127.0.0.1:9850/relay -d '{}'` → 401（缺令牌）。
- [ ] **经隧道/公网地址重复上一条** → 同样 401/404（不再依赖 127.0.0.1 判断）。
- [ ] **未登录页面内发消息**：总线 authGuard 拦截 cap.ai.chat；即使绕过也拿不到令牌（`issue-relay-token` → AUTH_REQUIRED）。
- [ ] **登录后对话**：登录成功 → 发消息 → SSE 流式正常、多轮正常、中断正常（`message.done{interrupted:true}`）——确认不破坏现有能力。
- [ ] **令牌在请求头**：DevTools Network 中 `/relay` 请求带 `X-Relay-Token`，三段式结构，payload 含 sid/jti/exp/scope。
- [ ] **篡改令牌**：手工改 payload 任一字节后重放 → 401 signature。
- [ ] **过期**：手动把缓存 token exp 改到过去 → 401 expired → 引擎自动重签恢复。
- [ ] **登出即时失效**：对话中登出 → 旧令牌再打 /relay → 401 revoked；重新登录 → 新令牌可用。
- [ ] **enrollment 幂等**：删除 sessionStorage 后同账号重复登录 → enroll 返回 200（同 key），对话不受影响；换错误 key → 409。
- [ ] **多标签页**：开两个标签页分别登录、各自对话正常；一个登出，另一个仍可用（按 jti 撤销）。
- [ ] **审计**：`cap.meta` 审计链中可见 `issue-relay-token` 调用记录（pluginId=real-engine）。
- [ ] **类型检查**：`pnpm typecheck`（或 polaris-lite 等价 tsc --noEmit）通过。

## 10. 与 R1/R2 的一句话关系

R3 保留独立中继进程与「令牌」模型，把信任锚从「网络位置（127.0.0.1）」改为「登录会话派生的密码学凭证」，是对签发口缺陷的正面修复；R1/R2 则通过同源 Cookie/宿主内嵌把鉴权上移到服务端会话——三者可组合（如 R3 冠军后，生产化阶段再吸收 R2 的同源内嵌以消除 relayKey 静态存储边界）。
