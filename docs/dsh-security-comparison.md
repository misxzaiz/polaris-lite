# DSH 安全设计对照 polaris-lite：差距分析与 App 版改造建议

> 调研日期 2026-11-26。DSH Go 开源本体：https://github.com/ccch1mneyyy/dsh-Go
> （AGPL-3.0，32k stars，Dart/Flutter；`sdk/`、`examples/` 为 MIT；品牌与吉祥物素材不在授权内，
> 二次开发需先联系作者 ccch1mneyyy——借鉴设计可以，**抄代码会传染 AGPL**）。
> 桌面版 dsh-TUI（https://github.com/ccch1mneyyy/dsh-TUI，MIT）作为补充参照。
> 配套市场仓库：https://github.com/ccch1mneyyy/dsh-go-market（自动风险检查 + 锁版本目录）。

## 一、DSH Go 的安全模型（开源本体核实，值得借鉴的机制）

### 1a. 手机操控的安全设计（最成熟的部分，docs/guide/zh/04-phone-control.md）

| # | 机制 | DSH Go 做法 |
|---|------|---------|
| D1 | **确认三档 × 硬规则** | 每次都询问（默认）/ 本任务免确认 / 始终免确认；但**硬规则永远拦**——系统设置页、密码验证码、支付框、DSH Go 自身一律交还用户，除非在「解除限制」里逐项显式开启（开启需按住 1.5 秒，任务进行中不能开启） |
| D2 | **应用名单分级** | 每个 App 三档：不碰 / 每一步都确认 / 照常；**支付、银行、券商类默认「不碰」，微信默认「每一步都确认」**；放宽规则需「我知道风险，仍然修改」 |
| D3 | **独立高危通道逐条确认** | Android Shell（Shizuku/ADB 执行系统 sh）：默认关闭、单独授权、**每条命令执行前都弹原生确认卡**（展示完整命令+实际身份 UID），三选一「允许一次/本轮允许/取消」；**屏幕操作的免确认和「始终允许」对它一律不适用**；2048 字节上限、30s/60s 期限、64KiB 输出截断（与我们 agent-bash 的截断策略一致） |
| D4 | **操作状态始终可见** | 任务期间屏幕四周亮光带 + 悬浮条/灵动岛实时显示「正在操作哪个 App、正在做什么、第几步」；「按住暂停 1 秒停止」随时可停 |
| D5 | **停止语义分级** | 停止分 USER / SCREEN_OFF / ENVIRONMENT 三源：熄屏只停手机任务**不取消**普通对话；模型收到的停止消息不假称用户主动停止、不要求结束与手机无关的工作 |
| D6 | **敏感信息防泄漏** | 读屏发给模型前银行卡号、身份证号先打码；操作记录不记屏幕内容、只存到 App 关闭 |
| D7 | **时间盒与闲置熔断** | 任务级授权最长 30 分钟（睡眠计入）；连续 3 分钟无新操作自动结束任务；确认卡 30 秒不选按取消 |

### 1b. 风险提醒体系（docs/design/risk-notices-and-ask-ai.md）

| # | 机制 | 做法 |
|---|------|---------|
| D8 | **三档风险确认** | 高（每次确认、红底按钮写具体动作）= 放开一整类保护或让 AI 动私人数据；中（首次确认+「不再提示」默认勾上）= 风险有边界；低（就地说明）= 结果写在入口旁 |
| D9 | **按钮即动作** | 确认按钮必须写具体动作（「开启完全权限」而非「开启」）；高危用红底、删掉笼统按钮 |
| D10 | **「不确定？问 AI」** | 每个高危确认卡下方有问 AI 出口——新开对话预填问题（**只填不发**，用户决定是否花这笔钱），远程主机场景附说明页文件 |
| D11 | **学到的技能走人工闸** | 从手机任务自动起草的技能草稿必须「收下/改一改/不要」三选一，敏感词检查+敏感值遮盖后才入库；最近三次两次不灵自动停用 |

### 1c. 插件市场安全（dsh-Go-market 仓库 + docs/design/plugin-market.md）

| # | 机制 | 做法 |
|---|------|---------|
| D12 | **CI 自动风险检查** | 挡：无精确版本、非 OSI 许可、>50MB、npm 高危公告、冒充 official；放行但打标：install-scripts(high)/native-code(high)/shell(medium)/filesystem(medium)/obfuscated(medium)/network(low)——启发式，明示「不代表有恶意」 |
| D13 | **装前 integrity 核对** | App 侧核对 npm dist.integrity 与锁定版本一致，不一致或不明确**先停不卸旧版**；诚实文档化了校验边界（「只能核对注册表元数据，不能证明主机 tarball 一致」） |
| D14 | **中高风险安装先确认** | medium 黄标 high 红标，安装前列出风险原因才继续 |
| D15 | **构建脚本独立审批** | 被构建脚本拦下时单独弹「允许构建脚本并重试」，展示软件包清单 |
| D16 | **下架还有防线** | blockedVersions 机制——已装版本被下架时 App 显示警告和卸载入口 |

### 1d. 权限预设与 Auto review（dsh-TUI 线，DSH Go App 亦内置）

| # | 机制 | 做法 |
|---|------|---------|
| D17 | **权限预设注册表** | read-only / workspace-write / danger-full-access / auto 四档会话级切换，统一 UI |
| D18 | **Auto review** | 每次工具调用执行前模型审查：low 放行 / medium 转人工 / high 永拒 / 模糊 fail-closed；仅会话生效、禁止记为新会话默认、选入需二阶段确认 |

## 二、polaris-lite 现状（按面盘点）

### 已经做对的（对齐或超出 DSH Go 的部分）

- **agent-bash 工具面防护完整**：denylist 硬拦（yolo 也不可豁免）+ 命令替换检测 + cwd 白名单 + realpath 防符号链接逃逸 + 杀树 + 64KB 截断（与 DSH Go Android Shell D3 同款参数）+ 全量审计（`plugins/agent-bash/server.mjs:42-64, 404-431`）
- **审批卡机制成熟**：服务端挂起审批（120s 超时自动 deny）+ 多设备先到先得 + once/always/deny 决策 + bash 服务端二次校验 approved（双层防御）（`plugins/agent-runner/server.mjs:512-535, 752-777`）——比 DSH Go 确认卡 30s 更宽裕，多设备审批是 DSH Go 没有的
- **认证扎实**：scrypt + timingSafeEqual、会话表只存 sha256(sid)、登录限速锁 IP、临时 Bearer 仅 loopback（`server/auth-session.mjs`）
- **插件数据面**：HTTP 源强制 sha256（DSH Go 装前 integrity 核对 D13 同思路）、禁覆盖已注册 id、写盘原子化
- **phone-agent 的 consent 模型**：设备显式 consent 才登记、撤销即除名——DSH Go 的「安装信任确认」思路的手机版；结果 64KB 截断同款
- **审计日志三处**：tool-exec/files-write/phone 三本 JSONL 审计（DSH Go「最近操作不记屏幕内容」同纪律）

### 差距（DSH Go 有、我们没有的）——对照 D 编号

| # | 差距 | DSH Go 对应 | 位置 |
|---|------|------|------|
| G1 | **无风险分级确认体系**——审批卡/确认弹窗没有高/中/低三档设计，「不再提示」语义靠 always 沉淀但无首次确认 vs 每次确认的区分 | D8/D9 | 全局 UI |
| G2 | **无硬规则清单**——没有「无论什么模式都拦」的操作类别（我们只有 denylist 命令级，没有语义级硬规则如「支付/密码/系统设置」） | D1 硬规则、D2 应用名单 | decideApproval |
| G3 | **商城安装无风险确认步骤**——install 即按 manifest 自声明写 grants.json，用户看不到「该插件申请了哪些 cap」的确认弹窗，更无风险标记 | D12/D14/D15 | `plugins/plugin-market/server.mjs:108-124, 235` |
| G4 | **grants 运行时自签**——grantExtPlugin 直接改写版本控制内的 grants.json，且无按 ID 回收的防重放键控、无下架警告 | D16 | 同上 |
| G5 | **高危操作无「问 AI」出 educating 出口、无 1.5 秒按住等防误触设计** | D10/D8 | 审批卡 UI |
| G6 | **AI 操作状态不可见**——phone-agent 的操作没有 DSH Go 悬浮条/光带那种「正在被操作」的常驻可感知状态 | D4 | phone-agent |
| G7 | **停止语义不分源**——用户停止/熄屏/环境断连在我们这里都走同一条中断路径 | D5 | agent-runner |
| G8 | **敏感信息打码缺失**——发模型前的银行卡号/身份证号打码 | D6 | 无 |
| G9 | **安全文档缺位**——没有 DSH 那种「本防线不防什么」的诚实声明文档 | SECURITY.md + FAQ | 全局 |

### 独有的真实风险（DSH Go 同样面对但处理得更谨慎的）

| # | 风险 | DSH Go 对照 | 位置 |
|---|------|------|------|
| R1 | **生产实际监听 0.0.0.0**——`listen(port)` 不传 host，日志却印 `127.0.0.1`，有误导 | DSH Go 本机网页版「只接受 App 自己的访问」 | `server/prod-server.mjs:120-134` |
| R2 | **上游默认放开 SSRF**——云元数据/内网地址全放行 | — | `server/upstream-policy.mjs:63-70` |
| R3 | **App 明文局域网传输**——WebView 加载 `http://局域网IP:9825` + `allowMixedContent: true`，cookie 明文过网；DSH Go 分享链接端到端加密、SSH 首次信任指纹 | 分享链接 E2E 加密 | `android/.../MainActivity.java`, `capacitor.config.json` |
| R4 | **approved 可被直连伪造**——会话内直接 POST `/api/tool/exec` 带 `approved:true` 绕审批卡；DSH Go 的 Android Shell 每条命令原生卡确认、屏幕免确认对它不适用 | D3 独立通道独立确认 | `plugins/agent-bash/server.mjs:422-431` |
| R5 | **引擎内部已跑完的工具调用跳过审批**——CodeBuddy CLI bypassPermissions 路径（已知豁口，面板有明示） | — | `plugins/agent-runner/server.mjs:726-738` |

## 三、改造建议（按杠杆排序）

### P0 —— 补上 App 化后真正变危险的洞（不借鉴 DSH 也要做）

1. **修 R4 approved 伪造**：审批流由服务端记账——askApproval 挂起时生成一次性 approvalToken，approve 端点核销后才允许带 approved:true；或工具端点只认 runner 的系统 Bearer + 服务端审批台账，不再接受裸 payload 布尔。（DSH Go D3 的教训：高危通道的确认必须是独立、不可被其它授权连带放行的。）
2. **R1 监听地址显式化**：`listen(port, process.env.PLITE_HOST ?? '0.0.0.0')`，日志印真实绑定；App 场景需要局域网，但至少让「全网卡」成为显式选择而非默认巧合。有公网暴露需求时引导走反代+https。
3. **R2 上游分级而非全开/全关**：默认拦云元数据段（169.254.169.254 等）与 loopback 代理头，私网放行由 `PLITE_UPSTREAM_ALLOW_LAN=1` 显式开启。
4. **R3 App 传输层**：短期在 App 内置信任自签证书或至少收掉 allowMixedContent；中期电脑侧起 https（自签+App 钉证书）。DSH Go 的参照：本机网页版只接受 App 自己访问、分享链接端到端加密、SSH 首次信任指纹。

### P1 —— 引入 DSH Go 的核心机制（对 App 场景价值最大）

5. **风险分级确认体系（借鉴 D8/D9/G1）**：把审批卡与各种确认弹窗统一到高/中/低三档——高档（放开整类保护、访问私人数据）每次确认+红底按钮写具体动作；中档首次确认+「不再提示」；低档就地说明。现有 always 沉淀语义可平移到「本会话都允许=中档」。
6. **语义级硬规则（借鉴 D1/D2/G2）**：在 decideApproval 之前加一层不可豁免的硬规则清单——无论何种模式，支付/密码/系统设置类操作交还用户（对应我们的场景：写 providers/auth-owner.json 已在 denylist，可扩展到 grants.json 写入、auth 端点调用等语义类别）。
7. **商城安装风险确认 + grants 键控（借鉴 D12-D16/G3-G4）**：
   - install 前弹「该插件申请 cap.tool.bash / cap.kv …」确认卡（复用 interactive-cards confirm 卡）；
   - grants 条目加 `{grantVersion, firstGrantAt}`，卸载回收时记 revokedIds 防同 id 重装静默继承；
   - 可选：装前对插件源码做启发式风险标记（grep child_process/network/fs 写路径→ medium/high 标签，DSH Go dsh-go-market 的 check.mjs 就是这么做的）。
8. **审批卡「问 AI」出口（借鉴 D10/G5）**：审批卡下方加「为什么问这个？」——新会话预填问题不自动发送；这个我们基建齐全（starter-suggestions 同款预填机制），成本低。
9. **phone-agent 状态可见性（借鉴 D4/D7/G6）**：AI 操作手机期间 App 内常驻一条状态（正在做什么、第几步、随时停止）——我们的形态是页面内横幅而非悬浮条，但「操作中可感知、可停止」的原则照搬。空闲熔断（3 分钟无操作自动结束）也值得加。

### P2 —— 工程面收尾

10. **R5 豁口显性化**：引擎声明 `bypassApproval: true` 时在会话头挂持久横幅；中期评估 CodeBuddy 侧能否关 bypassPermissions 走我们的审批。
11. **敏感信息打码（借鉴 D6/G8）**：发模型前的屏幕文本/文件内容过一遍银行卡号/身份证号正则打码——phone-agent 读屏路径优先。
12. **安全语义文档（借鉴 D9/G9）**：一页 docs/security-model.md，逐条写「每道闸防什么、不防什么」（含「grants 不是安全边界」「approved 的信任前提」「上游默认放开的边界」），并对齐 SECURITY.md 式的漏洞报告边界声明。
13. **safe 模式（借鉴 dsh-TUI D6）**：`PLITE_SAFE=1` 全插件禁用只读诊断起服务，配文件系统快照回归断言「safe 真的只读」。

## 四、不建议照搬的

- **DSH Go 的代码**——AGPL-3.0 传染，抄了整个 polaris-lite 都得开源；只借鉴设计思想（设计文档本身也是 AGPL 仓库的一部分，实现要自己写）。
- **dsh-go-market 的自动上架流水线**——那是多用户生态的产物；polaris-lite 单用户自用，商城装前确认卡+风险标记足够，CI 检查仓库是过度工程。
- **DSH 的 profile/registry/sha256 钉发布管线**——单仓单发布流已保证一致性。
- **Auto review 作为默认**——DSH Go 也只做成中档可选；额外一次模型请求的成本在手机流量场景更敏感。
- **宠物/悬浮条等重 UI**——形态不同（我们是 WebView+宿主页，不是原生 Flutter），可感知性用横幅实现即可。
