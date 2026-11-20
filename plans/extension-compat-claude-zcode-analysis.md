# polaris-lite 扩展模型兼容 Claude Code / ZCode — 方案分析

> 状态：**已由定稿稿取代——见 [plans/extension-compat-claude-zcode-final.md](extension-compat-claude-zcode-final.md)（含验证记录与决策定稿）** · 2026-11-20 · 仓库：polaris-lite
> 范围：MCP / Skills / Hooks / 插件 / Slash Commands / Subagents 六类扩展，如何让 polaris-lite 兼容 Claude Code 与 ZCode 的生态约定。
> 结论先行：**polaris-lite 目前没有任何 MCP / hook / skill / subagent / slash-command 运行时**（工具供给统一走 `cap.tool.*` + describe 协议）。但它的「cap 总线 + describe 工具协议 + 双入口插件」恰是兼容层的好基座：建议以**一个纯插件（compat 桥）+ 三处小改**实现兼容，核心原则是 **把 Claude/ZCode 的文件式扩展翻译成 lite 的 cap 原语**，而不是把 lite 改造成 CLI。

---

## 0. 结论速览（TL;DR）

| 维度 | lite 现状 | Claude Code 约定 | ZCode 约定 | 兼容方案要点 | 期 |
|---|---|---|---|---|---|
| MCP | 无 client；codebuddy adapter 已留 `--mcp-config` 通道（未接线） | `.mcp.json` / `~/.claude.json`；stdio/http/sse；`${VAR}` 展开 | `.zcode/config.json#mcp.servers`、`.agents/mcp.json`；stdio/http/sse | 新增 **mcp-bridge 插件**（server 半边实现 stdio/http client）+ 宿主 server 挂 `/api/mcp/*`；工具以 `mcp__<server>__<tool>` 注册进 agent-loop describe 协议 | **P0** |
| Skills | 无 | `SKILL.md`（frontmatter name/description/when_to_use）+ 渐进披露 | 同构（`.zcode/skills`、`.agents/skills`；desc>1024 丢弃） | **skill-loader 插件**：扫描 `.claude/.zcode/.agents/skills` → 索引进 system prompt + `read_skill` 工具（cap.tool.skill） | **P0** |
| Hooks | 无 | settings.json `#hooks`，30+ 事件，command/http/mcp_tool/prompt/agent | config `#hooks`，**7 事件**，command/process | **hook-bridge 插件**：只做 7 事件交集，command/process 进程执行 + JSON stdin/stdout + 退出码 0/2；默认关 + workspace 来源需确认 | P1 |
| 插件 | 自有 LiteManifest（slots/views + capabilities/provides/requires），无 plugin.json 磁盘发现、无市场 | `.claude-plugin/plugin.json` 顶层键 | `.zcode-plugin/plugin.json`（兼容探测 `.claude-plugin/`） | **compat-adapter 插件**：读 CC/ZC 插件目录 → 翻译 skills/mcpServers/hooks 三类贡献 → 走 mcp-bridge/skill-loader/hook-bridge；不做完整市场 | P1 |
| Slash Commands | 无（仅静态 suggestions） | 已并入 skills；`$ARGUMENTS`/`$N`、``!`cmd` `` | `.zcode/commands`，`$ARGUMENTS`/`$1` | 并入 skill-loader：commands 目录当 skill 读，`$ARGUMENTS` 替换；`!`cmd`` P2 再议 | P1 |
| Subagents | 无（无 persona/无 dispatch） | `.claude/agents/*.md` + 自动委派 | 无并行 subagent | P2：读入为「提示词角色卡」，仅在 agent-loop 里以 system 附加方式用；自动委派不做 | P2 |

**总体架构**：不新增宿主概念，全部走 lite 既有插件双入口模型；宿主核心只动三处——① `agent-loop` 系统提示注入点（append 段），② `cap.meta`/grants 增量，③ codebuddy-engine `startParams` 补传 `mcp_servers`（通道现成）。出站兼容（lite 扩展导出给 CC/ZC 用）不做的理由：lite 插件依赖宿主 cap 总线，离开宿主无意义，硬导出是伪兼容。

---

## 1. 背景与目标

### 1.1 目标
让 polaris-lite（Node 轻量宿主，9825/5000/9826 三档部署）能复用用户在 Claude Code / ZCode 中已有的扩展资产：

1. **MCP**：识别 workspace 与用户目录下的 `.mcp.json`、`~/.claude.json`（按项目路径键）、`.zcode/config.json#mcp.servers`、`.agents/mcp.json`，把其中的 server 工具注入 AI 会话。
2. **Skills**：发现 `.claude/skills/`、`.zcode/skills/`、`.agents/skills/` 的 SKILL.md，注入索引 + 按需全文读取。
3. **Hooks**：执行 Claude/ZCode settings/config 中的 command/process 类 hook（7 事件交集）。
4. **插件**：安装/识别 `.claude-plugin/plugin.json`、`.zcode-plugin/plugin.json` 格式插件，翻译其 skills/mcpServers/hooks 贡献。
5. **Commands/Subagents**：读取并映射（次优先）。

**非目标**：不做lite→CC/ZC 出站导出；不实现完整插件市场；不改 CapBus 权限模型本身；不追求 Claude 30+ hook 事件全覆盖（只做与 ZCode 的 7 事件交集——这是「同时兼容两家」的最大公约数）。

### 1.2 依据
- lite 现状：对 `D:\space\base\polaris-lite` 全仓只读勘察（§7 索引）。
- Claude Code：`code.claude.com/docs/en/{mcp,skills,hooks,plugins,slash-commands,sub-agents,settings}`（2026-11 官方文档）。
- ZCode：本地官方文档 `zcode-guide 0.3.0`、`plugin-creator 0.1.1`、`skill-creator 0.1.0`。

### 1.3 lite 扩展模型基座（事实摘要）

- **插件**：`plugins/<id>/index.ts`（浏览器 ESM，manifest 是代码内对象字面量，`LiteManifest{id,name,version,capabilities?,provides?,events?,requires?,contributes:{slots,views}}`）+ 可选 `server.mjs`（Node connect 中间件，`createServerPart(options)`）。23 个插件硬编码于 `plugins/build-plugins.mjs:66-93`；10 个 server 半边登记于 `plugins/server-registry.mjs:20-31`，由 `server/host.mjs:21-38` 顶层 await 装配。授权由 `public/grants.json`（24 插件 × cap 清单）静态管理，manifest 申请 ⊆ grants 才可装。
- **cap 总线**：`src/core/bus.ts` CapBus（~250 行，自述对齐主仓 RouterBus）：接口级鉴权 → 权限 gate（调用方 capabilities 必含 target，默认拒绝）→ 500 条环形审计 → handler；流式 `registerStreaming` 按 streamKey 定向投递并镜像 `<target>:event` 广播。
- **工具协议**：agent-loop 启动时 `cap.meta/list` 过滤 `cap.tool.*`（另加 `cap.interactive`）→ 逐个 `dispatch({target, action:'describe'})` 取 `{descriptor:{cap,name,description,parameters,danger}}`（`plugins/agent-loop/index.ts:129-140`）→ 组装 OpenAI tools 数组（快照缓存保 prompt 命中）→ 执行统一 `action:'exec'`（fs/ledger/browser/render/interactive 为动作语义分发）。**这就是 lite 的「工具供给唯一通道」**——MCP 工具兼容的落点就是把 `mcp__<server>__<tool>` 包装成 descriptor 注册进这条通道。
- **引擎**：`cap.ai.chat` 单注册位（bus 同名注册即抛错），real-engine / codebuddy-engine / mock-engine 三选一。agent-loop 是工具循环 owner（审批、执行、喂回、压缩）。
- **无**：MCP client、hook、skill、subagent、slash command、system prompt 外部注入点、AGENTS.md/CLAUDE.md 读取。
- **数据目录**：`PLITE_DATA_DIR`（默认 `.polaris-lite`）；workspace 根登记于 `workspace-roots.json`（agent-bash/fs 用它做路径围栏）。

---

## 2. 三方扩展模型对照（lite 视角）

| 维度 | Claude Code | ZCode | 对 lite 的启示 |
|---|---|---|---|
| MCP 配置 | `.mcp.json`(项目)/`~/.claude.json`(local按项目路径+user)；字段 stdio{command,args,env} / http{url,headers,timeout}；`${VAR}`/`${VAR:-d}` 展开 | `.zcode/config.json` 每级目录的 `mcp.servers`；兜底 `.agents/mcp.json` 顶层 `mcpServers`；字段 stdio{command,args,cwd,env,enabled,timeoutMs}/http{url,headers}；遗留字段自动迁移（remote→http 等） | 解析器按「字段并集 + 宽松读入」实现一次，两个来源都能吃；ZCode 严格丢弃未知键、Claude 宽松——lite 取宽松+warn |
| 工具命名 | `mcp__<server>__<tool>`；插件 server `mcp__plugin_<p>_<s>__<t>` | `mcp__<server>__<tool>` | 直接沿用；对 agent-loop 的 OpenAI function name 合法（`[a-zA-Z0-9_-]`，双下划线没问题） |
| Skills | `SKILL.md`，frontmatter 约 20 键（name/description/when_to_use/allowed-tools/disable-model-invocation/…），渐进披露 | `SKILL.md`，仅 name/description/when_to_use/license/metadata；**desc>1024 丢弃、无 frontmatter 也可加载**（name 回退目录名） | lite 只需 name/description/when_to_use 三键 + 目录扫描；两家的 SKILL.md 文件本身无需改动即可用 |
| Hooks | 30+ 事件；handler: command/http/mcp_tool/prompt/agent；stdin/stdout JSON；退出码 0/2/其他；matcher 正则 | **7 事件**（SessionStart/UserPromptSubmit/PreToolUse/PermissionRequest/PostToolUse/PostToolUseFailure/Stop）；handler: command/process；同样 JSON+退出码；配置需 `enabled:true` | 取 7 事件交集；只实现 command/process 两类 handler（覆盖绝大多数真实 hook）；http/mcp_tool/prompt/agent 忽略+warn |
| 插件清单 | `.claude-plugin/plugin.json`，顶层键 skills/commands/agents/hooks/mcpServers/…；marketplace.json | `.zcode-plugin/plugin.json`（兼容探测 `.claude-plugin/`、`.codex-plugin/`）；userConfig | 只翻译 skills/mcpServers/hooks（其余忽略+warn）；CC/ZC 插件大部分是「MCP server + skills」纯声明型，恰好能映射到 lite 的 server 半边 + skill 目录 |
| Commands | 并入 skills；`$ARGUMENTS`/`$N`/`$name`；``!`cmd` `` 预执行 | `.zcode/commands/*.md`；`$ARGUMENTS`/`$1`；``!`cmd` `` 改写为工具调用（不预执行） | commands→skill 映射；`$ARGUMENTS` 替换在输入侧做；`!`cmd`` 学 ZCode 的保守语义（转成 bash 工具调用）或 P2 再做 |
| Subagents | `.claude/agents/*.md`（name/description/tools/model/permissionMode…），自动委派、@提及 | 无 | P2：仅作为「角色提示词卡」注入；无并行执行器，不做自动委派 |
| 指令文件 | CLAUDE.md 层级；AGENTS.md 兜底 | AGENTS.md 为主 | lite 目前两个都不读——兼容方案应**顺带补上 AGENTS.md/CLAUDE.md 读取**（成本极低，收益大，两家通吃） |

**优先级冲突**：Claude 是 local>project>user，ZCode 是 user>workspace。lite 自定并文档化：**lite 原生 > 项目级 > 用户级，同名先到先得**（与调研稿对主仓的建议一致，两端方案保持同一语义）。

---

## 3. 差距清单（lite 视角）

- **G1 MCP**：无任何 MCP client；codebuddy adapter 的 `mcp_servers` 参数通道存在但 lite server 不传（`server.mjs:270-276` 只传 session_id/message/work_dir/model/permission_mode）；real-engine 完全没有 MCP 概念。
- **G2 Skills/指令文件**：无 SKILL.md 发现；系统提示词硬编码在 `agent-loop/index.ts:440-461`，无 append 注入点；不读 AGENTS.md/CLAUDE.md。
- **G3 Hooks**：无事件钩子系统；LiteManifest 无 hooks 贡献点；无进程执行设施（server 半边有 spawn 能力可复用——codebuddy-engine 已示范 spawn+stdio+树杀）。
- **G4 插件入站**：无磁盘 plugin.json 发现（manifest 在代码里，构建期括号配对解析）；无 adapters 机制；无市场。
- **G5 Commands/Subagents**：无；codebuddy adapter 上报的 slash_commands 被丢弃（`server.mjs:109` 返回 null）。
- **已有可复用资产**：CapBus gate/审计、describe 工具协议、grants 授权表、workspace-roots 围栏、codebuddy-engine 的 CLI spawn/stdio/树杀/审计日志范式、plugin-admin 的 registry.json 双写启停机制、`cap.kv`（sqlite）。

---

## 4. 集成方案

### 4.0 总体架构：一个 compat 插件族 + 三处宿主小改

```
Claude/ZCode 文件世界                    polaris-lite cap 世界
┌────────────────────────┐   读取/翻译   ┌──────────────────────────────┐
│ .mcp.json / .zcode/...  │──mcp-bridge──▶ mcp__<server>__<tool> descriptor │
│ .claude|.zcode|.agents/ │─skill-loader─▶ #Available skills + read_skill   │
│   skills/commands       │              │   (system prompt append 段)     │
│ settings#hooks /        │─hook-bridge──▶ 7 事件进程执行(0/2 退出码)        │
│ config#hooks            │              │                                │
│ .claude-plugin/         │compat-adapter�▶ 翻译成上三者 + server.mjs 中间件  │
│ .zcode-plugin/          │              │                                │
└────────────────────────┘              └──────────────────────────────┘
宿主小改：① agent-loop 系统提示 append 注入点
        ② grants.json 增加新插件条目
        ③ codebuddy-engine startParams 透传 mcp_servers（通道已有）
```

设计约束：
- **插件优先**（对齐 lite 自身宪法）：四个能力全部落成插件（mcp-bridge / skill-loader / hook-bridge / compat-adapter），宿主核心零协议变更或仅最小增量；每个插件 capabilities/provides 走 grants 授权。
- **只读采纳**：外部配置文件只读，不回写用户的 `.claude`/`.zcode`；lite 侧状态（启停、门控）存 `cap.kv`。
- **安全红线**：workspace 内的 `.mcp.json`/hooks/插件 manifest 是「文件即代码」——mcp server 启动与 hook 进程执行必须：全局开关默认关（env 或 kv 配置）；workspace 级来源首次启用需用户在 plugin-manager/设置页确认；执行写审计日志（沿用 codebuddy-engine 的 `*-audit.log` 范式）；stdio server 与 hook 进程的 cwd/可执行路径过 workspace-roots 同款围栏校验，拒绝 `../` 逃逸与绝对路径裸命令。

### 4.1 MCP 兼容（P0，价值最高）

**新插件 `mcp-bridge`**：
- `index.ts`（浏览器半边）：`provides: ['cap.tool.mcp']` 不需要——直接按 describe 协议为每个工具注册一个**动态 cap**不可行（CapBus 无动态注册）。改为：agent-loop 的工具发现已固定走 `cap.meta/list` 过滤 `cap.tool.*`，因此 **mcp-bridge 注册一个 `cap.tool.mcp` 能力，describe 返回「聚合 descriptor 列表」不合适（协议是单工具单 describe）**。
  - **方案 A（推荐）**：扩展 discoverTools 约定——`describe` 允许返回 `{descriptors:[...]}` 数组（多工具聚合）；mcp-bridge 的 `cap.tool.mcp#describe` 返回全部 MCP 工具的 descriptor（name=`mcp__<server>__<tool>`），`exec` 按 name 路由到对应 server 调用。改动点仅 `agent-loop/discoverTools` 兼容数组形态（向后兼容：单 descriptor 视作长度 1 数组）。
  - 方案 B（不推荐）：每个 MCP 工具注册一个独立 cap（`cap.tool.mcp.<n>`）——grants 表与 cap.meta list 会膨胀，且动态性差。
- `server.mjs`（Node 半边）：
  - **发现**：读 `.polaris-lite/mcp-import.json`（用户显式导入产物，见下）+ 可选直读 workspace 的 `.mcp.json`/`.zcode/config.json`/`.agents/mcp.json` 与用户级 `~/.claude.json`（按当前 workspace 路径过滤 `projects` 键）、`~/.zcode/cli/config.json`。合并优先级：lite 原生 > 项目 > 用户，同名整条覆盖。
  - **解析**：字段并集 schema（command/args/env/cwd/url/headers/timeoutMs/enabled/type），type 推断（有 command→stdio、有 url→http）；`${VAR}`/`${VAR:-default}` 展开（变量集：进程 env + `POLARIS_LITE_WORKSPACE` 等）；ZCode 遗留字段迁移表照抄（remote→http、environment→env、enable→enabled、http_headers→headers）。
  - **client**：stdio 用 `child_process.spawn` + JSON-RPC 2.0（initialize/tools/list/tools/call，协议版本 2024-11-05，对齐主仓实现与 codebuddy adapter 的帧风格）；http/sse 用 undici（依赖已备）。启动并发 + 每 server 15s 超时（对齐主仓 McpClientPool 参数）；进程退出自动重启一次并记录。
  - **API**：`GET /api/mcp/servers`（列表+健康+来源）、`POST /api/mcp/import`（把外部配置固化导入为 `.polaris-lite/mcp-import.json`，显式动作而非自动写）、`POST /api/mcp/tools/gate`（per-tool 开关，存 cap.kv，默认放行）。
- **接进 agent-loop**：工具执行时 `cap.tool.mcp#exec {name, arguments}` → server 半边路由 → 结果文本喂回 `role:'tool'`（复用现有 capText 截断）。
- **接进 codebuddy-engine**（CLI 引擎原生吃 MCP）：`server.mjs` 构造 startParams 时补 `mcp_servers: [{server_name, command, args}]`（**adapter.cjs:332-347 通道现成，一行透传**）——CodeBuddy 引擎下 MCP 工具走 CLI 自身，browser 引擎（real-engine）下走 mcp-bridge + agent-loop。两引擎都能用 MCP，是本方案的直接用户价值。
- **安全**：`PLITE_MCP=0` 一键禁用；默认只自动加载「用户级」来源，workspace 级来源出现时在设置页提示确认（存 kv 标记）；启动的 stdio 进程记入审计日志（server 名、命令行、pid、退出码）。

**验收**：测试 workspace 放 `.mcp.json`（含 `${VAR}` 展开）+ `.zcode/config.json`（嵌套 mcp.servers）+ `.agents/mcp.json`，real-engine 会话中 AI 能列出并调用其中工具；codebuddy 引擎会话 `--mcp-config` 临时文件含同名 server；同名冲突按优先级；坏 JSON 源跳过不致命；`npm run typecheck && npm test` 全绿。

### 4.2 Skills 兼容（P0，成本最低）

**新插件 `skill-loader`**（主要工作在 server 半边 + 一个工具 cap）：
- **发现**：扫描序列 `<work>/.polaris-lite/skills`（lite 原生，可留空）→ `<work>/.claude/skills` → `<work>/.zcode/skills` → `<work>/.agents/skills` → `<PLITE_DATA_DIR>/skills`；同名先到先得。解析 SKILL.md frontmatter：name（缺省=目录名）、description、when_to_use；description>1024 截断+warn（不学 ZCode 丢弃）。
- **注入**：这是唯一需要动 agent-loop 的地方——在 `index.ts:440-461` 系统提示后追加一段可注入的「appendix」。实现为 agent-loop 在组装 system prompt 前派发一个内部事件（如经宿主事件总线 `emit('system-prompt-appendix')` 收集各插件贡献）或更简单：skill-loader 直接经 `cap.kv` 写入，agent-loop 读取——**推荐事件收集**（通用，未来 hooks/commands 复用同一通道）。
- **读取工具**：注册 `cap.tool.skill`，describe → `{name:'read_skill', parameters:{name}}`，exec → 返回 SKILL.md 全文（16KB 截断，对齐主仓）。系统提示附录里写明「先读 # Available skills，需要细节时调 read_skill」。
- **AGENTS.md / CLAUDE.md**（顺带，强烈建议）：同一插件在 workspace 根向上查找 `AGENTS.md`、`CLAUDE.md`（存在哪个读哪个，都存在则拼接，CLAUDE.md 在后），32KB 截断，注入 system prompt appendix。零风险高收益。
- **Commands**：扫描 `<work>/.claude/commands/*.md`、`<work>/.zcode/commands/*.md`（子目录 `:` 连接命名），每个文件包装为一个「伪 skill」进索引；`read_skill` 时做 `$ARGUMENTS`/`$1/$2` 替换（参数来自用户 `/name args` 输入，chat-lite 输入侧识别 `/` 前缀传入）。``!`cmd` `` P2 再议（ZCode 的保守语义=转 bash 工具调用，可后做）。

**验收**：夹具 workspace 放三来源 skills + 同名覆盖样例 + 一个带 `$ARGUMENTS` 的 command；断言 system prompt appendix 含索引且同名取优先者、read_skill 返回正确文件、AGENTS.md 被注入；单测覆盖 frontmatter 容错（无 frontmatter/超长 desc/坏 YAML 行）。

### 4.3 Hooks 兼容（P1）

**新插件 `hook-bridge`**（server 半边进程执行）：
- **事件**：只做 7 事件交集，映射到 lite 侧触发点：
  | 外部事件 | lite 触发点 | 触发方式 |
  |---|---|---|
  | SessionStart | agent-loop loopHandler 入口 | 事件总线 `agent.loop:start`（需 agent-loop emit，小改）或 hook-bridge 监听既有 `cap.agent.loop:event` 流 |
  | UserPromptSubmit | chat-lite 发送入口 | 监听 `user.prompt` 事件（已存在）；返回 `decision:block` 时经 `cap.ai.chat.interrupt`/事件终止本轮 |
  | PreToolUse | agent-loop 审批通过后、exec 前 | hook-bridge 无法直接插桩——**需 agent-loop 在 exec 前派发 `tool.before` 事件并 await 结果**（小改，~10 行）；返回 deny 则跳过 exec 并以 tool.result 报「被 hook 拦截」 |
  | PostToolUse / PostToolUseFailure | exec 完成后 | 同上派发 `tool.after`（fire-and-forget，不阻塞） |
  | PermissionRequest | agent-loop decideApproval | 可选：hook 返回 allow/deny 时直接采信（P1 先不做，记 P2） |
  | Stop | 回合结束 | 派发 `turn:end`；「请求继续」语义 P2 |
  事件 data 形状对齐 Claude 输入契约公共子集：`{session_id, cwd, hook_event_name, tool_name?, tool_input?}`。
- **配置读取**：`~/.claude/settings.json`、`<work>/.claude/settings.json|settings.local.json` 的 `hooks` 键；`~/.zcode/cli/config.json`、`<work>/.zcode/config.json` 的顶层 `hooks`（尊重其 `enabled:true` 前置）；插件 `hooks/hooks.json`（经 compat-adapter）。归一为 `{event, matcher?, handlers:[{type:command|process, command, args?, shell?, timeout?|timeoutMs?, statusMessage?}]}`。
- **执行**：command=shell 串（Git Bash/PowerShell 按 `shell` 字段），process=argv 不经 shell；stdin 写 JSON；stdout 按 JSON 解析（失败当纯文本忽略）；退出码 0 放行 / 2 阻止（PreToolUse 拒工具、UserPromptSubmit 拒本轮）/ 其他=非阻塞错误；`additionalContext` 追加进 system appendix 通道；`permissionDecision` 采信；timeout 默认 60s（`timeoutMs` 优先，ZCode 的 `timeout` 秒字段换算）。matcher=大小写敏感正则，匹配工具名（Polaris 内置名映射到 Claude 名：bash→Bash、read_file→Read、write_file/edit_file/apply_patch→Edit、glob→Glob、dispatch_agent→Agent；MCP 工具名已兼容），非法正则=永不匹配+warn。
- **安全**：`PLITE_HOOKS=0` 默认禁用（或 kv 开关默认 off）；用户级来源信任、workspace 级来源首启确认；每次执行写 `hooks-audit.log`（事件/matcher/来源/退出码/耗时/输出前 512B）；Claude 独有事件（PreCompact/SubagentStop/Notification 等 20+）解析时忽略并一次性汇总提示「N 个 hook 因事件不支持未启用」。

**验收**：夹具 hook 四场景（PreToolUse deny 写操作→工具被拒且 AI 收到拦截原因；PostToolUse additionalContext→下轮 system 含该文本；UserPromptSubmit block→本轮不发；Stop→回合终止）；超时与坏 JSON 用例；审计断言。

### 4.4 插件入站兼容（P1）

**新插件 `compat-adapter`**：
- **发现**：扫描 `<work>/.claude/plugins/`、`<work>/.zcode/plugins/`、`<appConfig>/plugins/`（若存在）下含 `.claude-plugin/plugin.json` 或 `.zcode-plugin/plugin.json` 的目录；也支持单插件目录直接注册。
- **翻译**（外部顶层键 → lite 原语）：
  | 外部字段 | lite 落点 |
  |---|---|
  | `mcpServers`（stdio） | 调 mcp-bridge 的 import API，server 名加前缀 `plugin-<name>-`；http/sse 忽略+warn |
  | `skills` 目录 | 复制进 `<PLITE_DATA_DIR>/skills/plugin-<name>-<skill>/`（对齐主仓 plugin_skills 命名空间做法），由 skill-loader 统一发现 |
  | `commands` | 同上按 skill 处理 |
  | `hooks` / `hooks/hooks.json` | 调 hook-bridge 登记（标注来源插件与信任级） |
  | `agents`/`lspServers`/`outputStyles`/`userConfig` 等 | 忽略 + warn 清单 |
- **限制与如实声明**：CC/ZC 插件的「面板/UI/命令执行体」在 lite 无对应物（lite 插件是构建期 bundle，无法运行时加载任意外部 JS——这正是安全边界）。因此 compat-adapter 只承诺「声明型插件」（skills+mcpServers+hooks）可用；含 UI/复杂服务的插件会得到「部分兼容」报告。这不削弱方案价值：CC/ZC 生态里最大量的正是 MCP server + skills 型插件。
- **信任边界**：manifest 解析宽松（未知键忽略+warn，不学 ZCode 丢弃整插件）；路径校验拒绝 `../` 与绝对路径逃逸；`${CLAUDE_PLUGIN_ROOT}`/`${ZCODE_PLUGIN_ROOT}` 展开为插件目录、`${CLAUDE_PROJECT_DIR}` 展开为 workspace。

**验收**：取一个真实 CC 社区插件（skills+mcpServers 型）与一个 ZCode 插件导入；断言其 MCP 工具与 skills 在 lite 会话可用、名字带前缀、不兼容字段出现在 warn 报告；恶意 manifest（路径逃逸）被拒。

### 4.5 Subagents（P2，可选）

- 读 `<work>/.claude/agents/*.md`、`~/.claude/agents/*.md`：frontmatter name/description/tools/model 存档；以「角色卡」形式注入——用户指定角色名时，把该 agent 的 description+正文作为 system appendix 附加（复用 4.2 通道）；`tools` 白名单映射到 agent-loop 的工具过滤（buildToolDefs 时按名单裁剪）。不做自动委派、不做并行执行（lite 无 subagent 运行时，ZCode 也没有，两家交集为空，兼容价值低）。

### 4.6 出站兼容：不做（记录理由）

lite 插件（浏览器 ESM + 宿主 cap 依赖）与 server 半边（connect 中间件）离开 lite 宿主均不可运行；把 LiteManifest 反向导出成 `.claude-plugin/plugin.json` 只能表达 skills/mcpServers 的空壳，属于伪兼容。若未来要「lite 技能分享给 CC 用户」，正确形态是把 skill-loader 管理的 SKILL.md 目录本身就是跨工具标准格式（`.agents/skills/`），天然出站——无需代码。

---

## 5. 分期路线图

| 期 | 内容 | 改动面 | 风险 | 验收 |
|---|---|---|---|---|
| **P0** | mcp-bridge 插件（多源发现+stdio/http client+describe 聚合+import/gate API）+ codebuddy startParams 透传 + skill-loader 插件（skills/commands/AGENTS.md/CLAUDE.md + read_skill + system appendix 通道）+ agent-loop discoverTools 数组兼容与 appendix 注入两个小改 | 新增 2 插件；agent-loop ~30 行；grants +2 条 | 低（全部可开关、只读外部文件、失败降级为无此能力） | 夹具 workspace E2E + typecheck + npm test 全绿 |
| **P1** | hook-bridge（7 事件+command/process+JSON 协议+matcher+审计+信任门槛）+ compat-adapter（CC/ZC 插件入站翻译）+ agent-loop tool.before/after 派发小改 | 新增 2 插件；agent-loop ~20 行 | 中（进程执行旁路；默认关+首启确认+审计三重护栏） | hook 四场景 E2E + 真实 CC/ZC 插件导入冒烟 |
| **P2** | http/sse MCP 补全打磨、PermissionRequest hook 采信、Stop 继续语义、subagent 角色卡、`` !`cmd` `` 动态注入、OAuth | 分散 | 中 | 按子项单独立 spec |

每期开工前在 `plans/` 补实施 spec（对齐仓库既有 spec 风格），本文件为总纲。

---

## 6. 风险与开放决策点

**风险**
1. **安全（最高）**：`.mcp.json`/hooks/外部插件 manifest 都是仓库内文件——克隆恶意仓库即被诱导执行命令。三重护栏：全局开关默认关；workspace 级来源首启人工确认（kv 记录）；全部执行落审计日志 + 路径围栏。
2. **agent-loop 是共享单点**：discoverTools/系统提示/tool.before 三处小改都在 agent-loop，改坏影响所有会话。缓解：三处均为增量兼容（数组形态、appendix 为空则零变化、事件无人监听则零开销），配套单测。
3. **双引擎行为差异**：real-engine 走 mcp-bridge（agent-loop 执行），codebuddy 走 CLI 自身 MCP——同一 workspace 两引擎工具集可能有细微差异（如 gate 开关只作用于前者）。文档如实说明。
4. **上游漂移**：CC hooks 30+ 事件持续增加。只承诺 7 事件交集 + 已知字段，解析宽松 + warn，兼容表集中在各插件单文件。
5. **性能**：skills/MCP 发现增加启动 IO；沿用 mtime 缓存 + 惰性 read_skill；MCP server 懒启动（首次 describe 才 spawn）。

**开放决策点（需拍板）**
1. MCP 工具接入形态：方案 A（单 `cap.tool.mcp` + describe 返回数组，需改 agent-loop 发现协议）vs 方案 B（每工具一个 cap，grants 膨胀）？——推荐 A。
2. workspace 级 mcp/hooks 的信任模型：首启确认 vs 设置页白名单？——建议首启确认（与 lite「grants 走代码评审」的保守风格一致，但外部文件无法进代码评审，需运行时确认页）。
3. skill appendix 注入通道：宿主事件总线收集 vs cap.kv 中转？——建议事件收集（通用、可被 hooks/commands/subagents 复用）。
4. compat-adapter 单插件 vs 拆进 mcp-bridge/skill-loader/hook-bridge 各自内嵌？——建议独立（翻译逻辑集中，便于按上游漂移维护）。
5. AGENTS.md/CLAUDE.md 自动注入是否默认开？——建议默认开（只读、低风险），提供 kv 开关。

---

## 7. 参考文件索引

**lite 代码**：`src/core/bus.ts`（CapBus）、`src/core/types.ts:100-118`（LiteManifest）、`src/core/externalPlugins.ts`（加载/授权）、`src/core/metaCapability.ts`、`plugins/build-plugins.mjs`（构建/校验/registry）、`plugins/server-registry.mjs` + `server/host.mjs`（server 半边装配）、`plugins/agent-loop/index.ts`（工具循环：discoverTools:129 / 系统提示:440 / 审批:171 / exec 分发）、`plugins/codebuddy-engine/server.mjs:270-279`（startParams）与 `adapter.cjs:332-347`（mcp_servers→--mcp-config 通道）、`plugins/plugin-manager/server.mjs`（registry 启停双写）、`plugins/agent-bash/server.mjs:59-60`（workspace-roots 围栏）、`server/provider-store.mjs`（providers.json）、`docs/plugin-contract.md`、`docs/server-gateway-contract.md`（未实施的统一网关设计，compat 插件的 API 风格应向其靠拢）、`docs/ai-engine-contract.md`（未实施的 engine registry 草案）。

**外部**：Claude Code 官方文档（mcp/skills/hooks/plugins/slash-commands/sub-agents/settings，2026-11）；ZCode 本地文档（zcode-guide 0.3.0、plugin-creator 0.1.1、skill-creator 0.1.0）。
