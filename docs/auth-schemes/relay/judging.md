# 中继鉴权方案评审（judging）

> 评审对象：`R1-session-cookie.md`、`R2-embedded-relay.md`、`R3-bus-token.md`
> 评分维度与权重：A 安全正确性 40% ｜ B 架构正确性 30% ｜ C 可实现性与兼容 20% ｜ D 简洁性 10%（1–10 分，0.5 步进）

---

## 评委 B（视角：工程落地与长期维护）

### 代码核对记录（评分依据）

对照现状代码逐项核实：

- `plugins/relay-server.mjs`：独立进程 127.0.0.1:9850；`GET /token|/relay/token` 仅凭 `remoteAddress === 127.0.0.1` 放票（隧道场景下外部请求经转发同样表现为回环，判据失效）；`/relay` 校验一次性 `X-Relay-Ticket`；`Access-Control-Allow-Origin: *`；SSE 透传 + 域名白名单 + 5MB 限流。三份方案对缺陷的定位均属实。
- `plugins/real-engine/index.ts`：`RELAY_URL='/relay'`；`relayTicket` 缓存 + 403 重取票据（R1/R2 删除、R3 改造为总线取令牌，均成立）；manifest `capabilities: ['cap.config']`（R3 需追加 `cap.auth`，可行）。
- `plugins/model-admin/Panel.tsx`：`testConnectivity` 同样 `fetch('/relay/token')` 取票并带 `X-Relay-Ticket` 打 `/relay`。**R1 与 R3 的实施文件清单均未包含此文件**——两者删除 `/relay/token` 端点后，连通性测试将 404 报「无法连接中继」，属于实施清单完整性缺陷；R2 第 6 步明确覆盖。
- `plugins/mock-auth/index.tsx`：会话存 sessionStorage（12h）、owner 存 localStorage（`btoa` 混淆，可逆）；登录经总线 `cap.auth/login`；`setAuthGuard` 挂宿主单例。R1/R2 将凭据校验与 owner 存储上收到服务端（安全性提升），R3 保留浏览器侧 owner 并叠加密码派生密钥。
- `vite.config.ts` + `package.json`：config 里 `host: '0.0.0.0'`，但 dev/preview 脚本均以 CLI `--host 127.0.0.1` 覆盖（当前 dev 实际仅回环可达）。R2「收紧 host」的表述部分过时（CLI 已收紧），不影响其架构结论。
- `src/core/bus.ts`：`isPublicCap` 豁免 `cap.auth / cap.auth.interrupt / cap.meta / cap.config`。R3 在 `cap.auth` 下新增 `issue-relay-token` 动作并在 handler 内做登录校验，与总线豁免逻辑兼容；`dispatch` 已 `await handler`，login 改 async 无总线障碍。另注意：`cap.config` 也在豁免清单中（供应商 key 未登录可读）——属既有边界，三案均未处理，见共性备注。

---

### R1 会话 Cookie 绑定

| 维度 | 权重 | 得分 | 加权 |
|---|---|---|---|
| A 安全正确性 | 40% | 8.5 | 3.40 |
| B 架构正确性 | 30% | 7.0 | 2.10 |
| C 可实现性与兼容 | 20% | 7.0 | 1.40 |
| D 简洁性 | 10% | 8.0 | 0.80 |
| **加权总分** | | | **7.70** |

**评语**：用「服务端会话 + 同源 HttpOnly Cookie」回归 Web 标准形态，是对票据缺陷的治本修复。安全设计是三案中最完整的：HttpOnly + SameSite=Strict + 自定义头 + Origin/Host 校验四层 CSRF 防线，并主动移除 `ACAO: *`；owner 凭据迁到服务端文件（salt + sha256 + `timingSafeEqual`，优于现状 `btoa` 混淆）；登录限速、会话固定防护、`X-Forwarded-Proto` 动态决定 Secure、Cookie 写入失败检测等部署细节考虑周到。数据面（SSE 转发、白名单、中断）完全沿用现实现，回归风险最低；引擎侧反而删掉票据逻辑变简单。架构上治本但不够彻底：保留 9825/9850 双进程双端口拓扑，登录端点寄生在中继进程里（中继兼任 auth 服务端），dev/prod 一致性依赖两条 proxy（vite proxy / preview proxy）配置保持 parity，`X-Forwarded-Proto`、changeOrigin 等头转发细节要在两处各自验证。

**最大缺陷**：实施清单漏掉 `plugins/model-admin/Panel.tsx`——删除 `/relay/token` 后「测试连通」功能直接损坏（取票 404 → 永远报「无法连接中继」），按清单执行会带病上线；同时文件清单引用了仓库中不存在的 `build-plugins.mjs`，说明对现状的核对有漂移。

---

### R2 宿主内嵌中继

| 维度 | 权重 | 得分 | 加权 |
|---|---|---|---|
| A 安全正确性 | 40% | 8.0 | 3.20 |
| B 架构正确性 | 30% | 8.5 | 2.55 |
| C 可实现性与兼容 | 20% | 7.5 | 1.50 |
| D 简洁性 | 10% | 7.5 | 0.75 |
| **加权总分** | | | **8.00** |

**评语**：三案中唯一把「生产形态」当成一等公民来解的方案：取消 9850 与独立中继进程，auth + relay 收敛为宿主 HTTP 服务的内置路由，同一份 connect 风格 middleware 同时插进 dev（vite）与 prod（node server），从机制上消除 dev/prod 行为漂移，部署拓扑收敛为单端口，内网穿透只需暴露 9825——长期维护面最小。鉴权模型与 R1 同源（服务端会话表 + HttpOnly cookie），`getSession(req)` 注入让中继对「会话由谁签发」零感知，SSO 替换路径（`mintSession` 复用 + `registerVerifier` 扩展点）设计干净。消费方覆盖最全：engine、Panel.tsx、mock-auth、文档与 grep 清零都列了。代价是实施面最大：新建 3 个服务端文件、替换 `vite preview` 为手写 prod server、重写 SSE 转发（虽补了背压与 abort 传播，但重写即有回归风险）。安全上有几处草稿级瑕疵：owner 哈希未加盐、字符串比较非 timing-safe、登录无限速、`serveStatic` 的 `decodeURIComponent + join(dist, urlPath)` 存在路径穿越（`..%2f` 可逃出 dist）——模型正确但代码必须按 R1 的标准补齐（加盐 + timingSafeEqual + 限速 + 路径 normalize/白名单校验或改用 vetted 静态中间件）。SameSite=Lax 较 Strict 略宽，但在「仅同源 POST + JSON + 无 CORS 放行」下差异可忽略。

**最大缺陷**：用一套新手写的 prod server + middleware 替换了经过验证的 vite/preview 工具链，等于引入新的代码面与新的漏洞类别（草稿中的路径穿越、无盐哈希即为实证）——「架构收敛」的收益要兑现，前提是这些实现细节按标准 Web 实践补硬，否则等于用新自研面换掉旧补丁面。

---

### R3 总线签发短期令牌

| 维度 | 权重 | 得分 | 加权 |
|---|---|---|---|
| A 安全正确性 | 40% | 7.0 | 2.80 |
| B 架构正确性 | 30% | 6.5 | 1.95 |
| C 可实现性与兼容 | 20% | 6.0 | 1.20 |
| D 简洁性 | 10% | 5.0 | 0.50 |
| **加权总分** | | | **6.45 ≈ 6.5** |

**评语**：把信任锚从「网络位置（127.0.0.1 判据）」换成「登录会话派生的密码学凭证」，方向正确，令牌本体设计合格（HMAC + `timingSafeEqual` + alg/scope/exp 校验 + jti 撤销 + ±60s leeway），可重放 300s 而非一次性的取舍对流式长连接是务实的。但作为「生产可用」的架构级方案，它引入的信任锚比它修掉的更暴露：`POST /relay/enroll` 是一个无鉴权的信任库写入口，在 brief 明确要求的内网穿透形态下，攻击者可抢注自己的 relayKey，之后任意铸造令牌，而真实 owner 的 enroll 返回 409 且「fire-and-forget 仅告警」——中继访问权与应用 owner 身份悄然脱钩，失败模式是静默的。密钥材料 面 最大化：中继侧 `relay-state.json` 存的是**明文 hex 密钥**（泄露即可永久铸令牌，弱于 R1/R2 存的加盐密码哈希），浏览器侧 relayKey 进 sessionStorage（XSS 可读）。工程复杂度三案最高：浏览器 WebCrypto 与 node:crypto 双端密码学实现需永久保持一致，外加 enroll/revoke/HMAC 断言/jti GC/会话 jti 登记等自研协议件；对单用户本机工具而言，这套 mini-JWT 体系明显超配。多标签页「一处登出另一处仍有效」与 sessionStorage 语义一致，算如实交代。流式/中断链路不动，兼容性设计本身没问题。

**最大缺陷**：TOFU enroll 端点 + 密码派生密钥构成的新暴露面——在目标部署形态（公网隧道）下，「未登录 curl 被拒」修好了，却又开了一个「未登录可预置信任锚」的口子，且失败静默；同时全套自研令牌协议是三案中维护成本最高的，与问题规模不匹配。

---

### 排名与冠军推荐（评委 B）

| 排名 | 方案 | 加权总分 | 一句话结论 |
|---|---|---|---|
| 1 | **R2 宿主内嵌中继** | **8.00** | 单端口 + 单份 middleware 的架构收敛最彻底，dev/prod 一致性与长期维护面最优；实现瑕疵可修 |
| 2 | R1 会话 Cookie 绑定 | 7.70 | 安全设计最完整、数据面零重写、落地最稳；但双端口拓扑与「auth 寄生在中继进程」的形态不够彻底，且实施清单漏改 Panel.tsx |
| 3 | R3 总线签发短期令牌 | 6.50 | 修好签发口却引入更暴露的 TOFU 信任锚与最高复杂度的自研密码学协议，性价比最低 |

**冠军推荐：R2**，但附放行条件（作为实施验收项，不是可选建议）：

1. owner 哈希改加盐 + `timingSafeEqual`，`/api/auth/login` 加限速（对齐 R1 §3.3）；
2. 修复 `prod-server.mjs` 静态服务的路径穿越（normalize 后前缀校验，或直接用 `serve-static`/`sirv` 等成熟中间件）；
3. Cookie 属性对齐 R1 的部署处理（`X-Forwarded-Proto` 动态 Secure + `RELAY_COOKIE_SECURE`/`PLITE_COOKIE_SECURE` env 兜底 + 登录后 `/api/auth/status` 复查）；
4. 验收必须覆盖 dev 与 prod（`pnpm build && pnpm start`）两形态的同一 curl 矩阵，以及隧道入口的未登录 401。

**备选**：若团队判断「新增手写 prod server」的维护成本不可接受，R1 是更保守的可行冠军（改动面最小、数据面不动），但必须先补上 `Panel.tsx` 的 `/relay/token` 移除改造再实施。R3 不建议按现稿实施；若坚持令牌路线，至少要把 enroll 改为「登录会话建立后经总线触发的受控注册」并给 relayKey 落盘加访问约束，否则等于把旧缺陷换了个位置。

### 共性备注（不单独计分，实施时一并处理）

- `bus.ts` 的 `isPublicCap` 豁免了 `cap.config`：未登录可在总线层读/写含 API key 的供应商配置。本次三案都只管中继入口，此边界属既有缺口，建议作为后续独立事项登记。
- 三案均依赖「会话/状态表在内存、重启即重登」，对单用户本机工具可接受，但应在文档中明示。
- 采纳任一方案后，需按 AGENTS.md 的纪律做全库 grep 清理（`/relay/token`、`X-Relay-Ticket`、9850 引用清零）并同步更新 README/docs。

---

## 评委 A（视角：安全正确性与生产可用）

### 代码核对记录（评分依据）

- `plugins/relay-server.mjs`：确认 `GET /token|/relay/token` 仅凭 `remoteAddress === 127.0.0.1` 放票；内网穿透/反代把外部请求转为本机回环后该判据失效，外部 curl 可取票打穿中继。三案对缺陷的定位均属实。
- `plugins/model-admin/Panel.tsx`：`testConnectivity` 同样 `fetch('/relay/token')` 取票后带 `X-Relay-Ticket` 打 `/relay`——这是 R1/R3 文件清单的共同遗漏（端点删除后「测试连通」必坏），R2 已覆盖。
- `src/core/bus.ts`：确认 `isPublicCap` 豁免 `cap.auth/cap.config` 等目标；R3 把 `issue-relay-token` 的登录校验放在 handler 内而非总线层，**与总线豁免逻辑兼容且必要**（该判断成立）。
- `package.json`：`dev/preview` 脚本已用 CLI `--host 127.0.0.1` 覆盖 config 的 `0.0.0.0`；R2「收紧 host」的表述与现状略有出入，不影响其架构结论。

### R1 会话 Cookie 绑定

| 维度 | 权重 | 得分 | 加权 |
|---|---|---|---|
| A 安全正确性 | 40% | 9.0 | 3.60 |
| B 架构正确性 | 30% | 8.5 | 2.55 |
| C 可实现性与兼容 | 20% | 8.0 | 1.60 |
| D 简洁性 | 10% | 8.5 | 0.85 |
| **加权总分** | | | **8.60** |

**评语**：安全正确性三案中最完整。未登录/外部 curl 无 Cookie ⇒ 401，经穿透入口同样被拒，不再依赖网络位置判断；CSRF 有 SameSite=Strict、自定义头 `X-Polaris-Relay`、Origin/Host 校验三重防线并显式移除 `ACAO:*`；凭据侧加盐 sha256 + `timingSafeEqual` + 登录限速，优于现状 `btoa` 混淆；sid 服务端生成防会话固定，登出删服务端会话使撤销真实生效。`X-Forwarded-Proto` 动态 Secure + env 强制开关 + `/auth/status` 复查，正面化解了「http 内网穿透下 Secure Cookie 被静默丢弃导致登录成功却永远 401」这一生产高频事故。架构上回归「服务端会话 + 同源 Cookie」的 Web 标准形态，会话权威收敛在唯一可信服务端进程，SSO 经 `/auth/session` 交换接口接入而校验层零改动；dev（vite proxy）/prod（nginx 反代）均成立。流式/中断/多轮链路零改动，引擎删票据逻辑反而变简。扣分：把 `/auth/*` 放进中继进程，使「模型中继」事实上兼任认证服务器（角色扩张应显式声明）；保留双进程双端口拓扑；文件清单引用了仓库中不存在的 `build-plugins.mjs`。

**最大缺陷**：实施清单遗漏 `plugins/model-admin/Panel.tsx::testConnectivity`——删除 `/relay/token` 后测试连通功能直接损坏，按清单执行会带病上线；实施时必须补入该文件并同步验证。

### R2 宿主内嵌中继

| 维度 | 权重 | 得分 | 加权 |
|---|---|---|---|
| A 安全正确性 | 40% | 8.5 | 3.40 |
| B 架构正确性 | 30% | 9.0 | 2.70 |
| C 可实现性与兼容 | 20% | 8.0 | 1.60 |
| D 简洁性 | 10% | 8.0 | 0.80 |
| **加权总分** | | | **8.50** |

**评语**：架构正确性三案中最高——不给漏洞打补丁，而是消灭第二个端口与第二套鉴权，登录态与中继门禁共享同一服务端会话权威，鉴权收敛为 `getSession(req)` 单一注入点；dev/prod 共用同一份 connect 风格 middleware，形态一致性从机制上保证；攻击面物理收窄（9850 消失）；SSO 接入（`mintSession`/`registerVerifier`）设计最完整；消费方覆盖最全（含 Panel.tsx），还顺手补了 SSE 背压与 abort 上游传播。安全上模型正确但有草稿级缺口：owner 哈希无盐、比较非 timing-safe、登录无限速、无 Origin 校验（CSRF 防线主要押在 SameSite=Lax 单点）、Secure Cookie 仅靠 `PLITE_COOKIE_SECURE=1` 人工配置（无 `X-Forwarded-Proto` 自动识别，生产误配风险高于 R1）；示例 prod-server 的 `decodeURIComponent + join(dist, urlPath)` 存在路径穿越隐患（`..%2f` 可逃出 dist）。扣分：新增自维护生产服务器（静态服务/SPA fallback/MIME/路径安全都要自己扛），dev 从可内网穿透调试改为仅回环。

**最大缺陷**：安全实现细节与 R1 有可见差距（无盐哈希、无限速、无 Origin 校验、Secure 靠人工 env），且示例 prod server 存在路径穿越隐患——「架构最优雅」不等于「实现即安全」，采纳时必须补齐这四处并按 R1 标准对齐。

### R3 总线签发短期令牌

| 维度 | 权重 | 得分 | 加权 |
|---|---|---|---|
| A 安全正确性 | 40% | 7.0 | 2.80 |
| B 架构正确性 | 30% | 7.0 | 2.10 |
| C 可实现性与兼容 | 20% | 8.0 | 1.60 |
| D 简洁性 | 10% | 6.5 | 0.65 |
| **加权总分** | | | **7.15** |

**评语**：正面修复了「无鉴权签票口」：`/relay/token` 删除，签发收敛到 `cap.auth/issue-relay-token`（bus.ts 现状确认 `cap.auth` 被总线豁免，handler 内做登录校验的判断正确且必要）；验签实现有 `timingSafeEqual`、±60s leeway、scope 限定、jti 撤销，工艺合格；可重放 300s 的取舍对流式长连接务实。但信任锚存在结构性弱点：① `POST /relay/enroll` 是无鉴权 TOFU 端点——穿透暴露后若 owner 未及时注册，攻击者可抢先登记自己的 relayKey，之后长期合法铸令牌；② 登录态仍是客户端 sessionStorage 自声明，服务端不验证会话真实存活，知道密码者可离线 PBKDF2 派生 relayKey 自铸令牌，鉴权实质退化为「知道密码」，并未建立服务端会话权威；③ relayKey 进 sessionStorage（XSS 可读）与 relay-state.json 落盘，撤销依赖客户端自愿上报。TTL+撤销+scope 是合格的损失控制，但根上不如 R1/R2 的服务端会话。总线内签发、审计入链、capability 最小授权是亮点，与 cap 总线理念契合度最高。D 维度：密钥派生 + TOFU 注册 + 令牌铸造 + jti 台账 + 撤销列表 + HMAC 断言，自研协议件最多，对单用户工具明显超配。同样遗漏 Panel.tsx 改造。

**最大缺陷**：`/relay/enroll` 无鉴权 TOFU 端点在目标部署形态（公网隧道）下留下「未登录预置信任锚」的绕过窗口，且失败静默（owner enroll 409 仅告警）——修好了签发口，却把「人人可取票」换成了「先到先得持证」。

### 排名与冠军推荐（评委 A）

| 排名 | 方案 | A(40%) | B(30%) | C(20%) | D(10%) | 加权总分 |
|---|---|---|---|---|---|---|
| 1 | **R1 会话 Cookie 绑定** | 9.0 | 8.5 | 8.0 | 8.5 | **8.60** |
| 2 | R2 宿主内嵌中继 | 8.5 | 9.0 | 8.0 | 8.0 | **8.50** |
| 3 | R3 总线签发短期令牌 | 7.0 | 7.0 | 8.0 | 6.5 | **7.15** |

**冠军推荐：R1（会话 Cookie 绑定）**。理由：

1. **安全正确性最完整**：唯一同时做到加盐哈希 + timingSafeEqual + 登录限速 + SameSite=Strict + 自定义头 + Origin 校验 + 移除 `ACAO:*` 的方案；R2 在这几点均有缺口，R3 存在 TOFU 绕过窗口与「密码即鉴权」的结构性弱化。
2. **生产形态已被正面处理**：`X-Forwarded-Proto` 动态 Secure + env 开关 + `/auth/status` 复查，覆盖内网穿透 http/https 两种现实部署；Cookie 同源自动携带使「外部 curl 被拒、登录后正常」两个验收天然同时满足。
3. **落地风险最低**：保留现有进程拓扑与 SSE 链路，引擎删代码而非加代码；不引入新运行时基础设施（R2 的 prod server、R3 的密钥/撤销体系）。

对 R2 的态度：R2 架构分最高、终态最干净，是正确的演进方向；若愿意承担自维护生产服务器的成本并补齐四处安全细节，R2 与 R1 仅差 0.10，属可接受替代。R3 不建议作为终态，其「总线签发 + 审计」思想可在 R1/R2 落地后作为增强吸收。

**冠军 = R1。实施前提**：补上 `model-admin/Panel.tsx::testConnectivity` 的同步改造（去掉 `/relay/token` 取票，改为带 Cookie + `X-Polaris-Relay` 头直打 `/relay`），并按 R1 §7.2 验证清单完成「未登录 curl 401 / 登录后对话正常」端到端验证。
