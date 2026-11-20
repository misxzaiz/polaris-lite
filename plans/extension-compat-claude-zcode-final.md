# polaris-lite 扩展模型兼容 Claude Code / ZCode — 最佳方案（定稿）

> 状态：**已被 v2 取代——见 [plans/extension-capability-native-plan.md](extension-capability-native-plan.md)**（目标重定位：先让 polaris-lite 原生拥有 MCP/Skills/Hooks/插件能力体系，CC/ZC 兼容降为接入层）。本稿的 5 项 PoC 验证记录仍有效，被 v2 继承。
> 前序：`plans/extension-compat-claude-zcode-analysis.md`（分析稿）。本稿吸收验证结论、敲定全部决策点，是实施依据。
> 验证记录：方案依赖的 5 项关键机制均已用可运行 PoC 实测通过（见 §5）。

---

## 0. 定稿结论（一句话）

以**四个纯插件**（mcp-bridge / skill-loader / hook-bridge / compat-adapter）+ **agent-loop 三处向后兼容小改**，把 Claude Code 与 ZCode 的 MCP / Skills / Hooks / 插件四类扩展资产翻译进 polaris-lite 的 cap 世界；出站兼容不做。安全三护栏：全局开关默认关、workspace 级来源首启确认、全程审计日志。

---

## 1. 已验证的关键事实（决定方案形态）

| # | 断言 | 验证方式 | 结论 |
|---|---|---|---|
| V1 | CapBus 无动态注册：`bus.register` 同名即抛错（`src/core/bus.ts:101`），插件只能经 `registerCapability` 注册 `provides` 声明过的 cap | 代码核实 | MCP 工具不能「每工具一个 cap」→ 必须走**单聚合 cap + describe 返回数组** |
| V2 | agent-loop `discoverTools` 假设单 descriptor（`r.data?.descriptor`，`index.ts:135-137`）；工具名经 `buildToolDefs` 直接作为 OpenAI function name | 代码核实 + 命名校验 PoC | 扩展点明确：describe 兼容 `{descriptors:[]}` 数组即可；`mcp__server__tool` 命名全部匹配 `[a-zA-Z0-9_-]+` 且 ≤64 字符，MCP `inputSchema` 即 JSON Schema 可直接作 OpenAI `parameters` |
| V3 | MCP stdio JSON-RPC（initialize → tools/list → tools/call，协议 2024-11-05）客户端可用纯 Node spawn+NDJSON 实现 | **真进程 PoC PASS**（INIT_OK/TOOLS/CALL 全通，含中文） | mcp-bridge server 半边零依赖可行，复用 codebuddy-engine 的 spawn/stdio/树杀/审计范式 |
| V4 | SKILL.md 发现+frontmatter 解析（name 回退目录名、同名先到先得、无 frontmatter 容忍、超长 desc 截断） | **fixture PoC PASS**（项目级遮蔽用户级、nofm/longdesc 均正确处理） | skill-loader 逻辑一次写对，两家 SKILL.md 文件零改动可用 |
| V5 | hook 的 JSON stdin/stdout 协议（`hookSpecificOutput.permissionDecision`、`additionalContext`）与退出码 0/2 语义 | **真进程 PoC PASS**（deny/ctx/exit2/bad-json 四场景） | hook-bridge 执行器按「stdout JSON 优先、退出码兜底」实现，两端 hook 脚本不改可用 |
| V6 | 多源 MCP 配置发现/合并/ZCode 遗留字段迁移/`${VAR:-d}` 展开 | **fixture PoC 8/8 PASS**（`.mcp.json`、`.zcode/config.json`、`.agents/mcp.json`、`~/.claude.json` 按项目键、同名让位、http 跳过+warn） | 解析器设计定稿；教训：展开后须 `path.resolve()` 归一分隔符 |
| V7 | 事件门控：插件 `listen/emit` 仅限 `manifest.events` 声明名（`hostRuntime.ts:128-148`）；核心另有不经校验的 `host.subscribe` 但插件拿不到 | 代码核实 | hook-bridge 的插桩需要 agent-loop 派发新事件 + grants events 增项，不是「白拿」 |
| V8 | server 半边装配：`plugins/server-registry.mjs` 加一行即可挂新插件，宿主零改动；env 开关惯例 `PLITE_<CAP>=0` | 代码核实（codebuddy/agent-bash 同款） | 四个 compat 插件的 server 半边按此惯例接入 |
| V9 | codebuddy adapter 的 `mcp_servers` 通道现成（`adapter.cjs:332-347`：engine-v1 `{server_name,command,args}` → 临时 JSON → `--strict-mcp-config --mcp-config`），但 `server.mjs:270-276` startParams 不传 | 代码核实 | CLI 引擎吃 MCP 只需透传一行；browser 引擎（real-engine）走 mcp-bridge+agent-loop |
| V10 | grants.json 是静态授权表（24 插件），新插件必须登记 capabilities/provides/events | 代码核实 | 新增 4 插件 = grants +4 条（走代码评审，符合仓库纪律） |

---

## 2. 定稿架构

```
Claude/ZCode 文件世界                     polaris-lite cap 世界
┌──────────────────────────┐            ┌────────────────────────────────────┐
│ .mcp.json / .zcode/config │            │ cap.tool.mcp（单聚合 cap）           │
│ .agents/mcp.json / ~/.claude.json │────▶│  describe → {descriptors:[...]}     │
│            │ mcp-bridge server: 多源发现+stdio/http client    │
│ .claude|.zcode|.agents/skills + commands │─▶ cap.tool.skill（read_skill）  │
│            │ skill-loader: 扫描+索引+AGENTS.md/CLAUDE.md      │
│ settings/config #hooks    │──────────▶│ 7 事件进程执行（command/process）     │
│            │ hook-bridge server: JSON 协议+退出码+审计        │
│ .claude-plugin/ .zcode-plugin/ │──────▶│ 翻译成上三者（声明型插件）            │
│            │ compat-adapter: manifest 翻译+路径围栏            │
└──────────────────────────┘            └────────────────────────────────────┘
agent-loop 三处小改（均向后兼容）：
  A1 discoverTools 兼容 {descriptors:[...]} 数组
  A2 system prompt 组装前收集 appendix 事件（system.appendix 请求/收集）
  A3 exec 前/后派发 tool.before / tool.after 内部事件（hook-bridge 可阻断）
```

### 2.1 决策点定稿（原 5 个待拍板 → 全部敲定）

| 决策点 | 定稿 | 理由（含验证依据） |
|---|---|---|
| D1 MCP 接入形态 | **单聚合 cap `cap.tool.mcp`，describe 返回 `{descriptors:[...]}` 数组，exec 按 name 路由**（原方案 A） | V1：bus 禁止动态注册，方案 B（每工具一 cap）在 grants/审计/meta 上都不可持续；V2 证明 agent-loop 只需一处兼容数组。插件仍以 `mcp-bridge` 身份 provides 该 cap，权限/审计归一 |
| D2 workspace 级 mcp/hooks 信任模型 | **三态：用户级来源自动启用；workspace 级来源首次出现 → 设置页确认（kv 记录指纹）；全部可被 `PLITE_MCP=0`/`PLITE_HOOKS=0`/`PLITE_SKILLS=0` 一键关** | 与仓库既有纪律一致（grants 走代码评审、env kill-switch 惯例 V8）；「文件即代码」风险的运行时对冲 |
| D3 appendix 注入通道 | **宿主事件总线请求/收集模式**：agent-loop 组装 system prompt 前 `emit('system.appendix.query')`，各插件 listen 后经 `host` 收集？——**否**，插件拿不到 host.subscribe（V7）。定稿：**agent-loop 派发 `system.appendix` 事件（payload 带 sessionId + 回执 callback id），贡献方插件把内容经 `cap.kv` 写入约定键，agent-loop 读取合并** | V7 是硬约束；kv 方案零新增总线机制、可审计、跨插件无耦合。简化定稿：**agent-loop 直接 dispatch `cap.skill.appendix`（skill-loader provides）**——单一贡献方时不需广播机制，YAGNI |
| D4 compat-adapter 形态 | **独立插件**（不并入三个桥） | 翻译逻辑集中一处，上游漂移（CC/ZC 格式演进）只改它；三个桥保持「纯执行者」 |
| D5 AGENTS.md/CLAUDE.md 注入 | **默认开**（skill-loader 一并实现），kv 开关可关 | 只读、32KB 截断、低风险高收益；两家通吃 |
| D6（新增）hook 事件范围 | **7 事件交集**：SessionStart / UserPromptSubmit / PreToolUse / PermissionRequest / PostToolUse / PostToolUseFailure / Stop；Claude 独有事件忽略+一次性汇总 warn | 两家最大公约数；ZCode 只有这 7 个，兼容目标即「同一份 hook 配置两边都能跑」 |
| D7（新增）MCP 传输范围 | P0 stdio；P1 http/sse（undici 已在依赖内，`server/relay-core.mjs` 先例） | V6 已验证 http 解析跳过+warn 的降级路径 |

### 2.2 插件清单与 grants 增量

| 插件 | provides | capabilities | events | server 半边 |
|---|---|---|---|---|
| `mcp-bridge` | `cap.tool.mcp` | `cap.meta` | `tool-registered` | `/api/mcp/servers`、`/api/mcp/import`、`/api/mcp/gate`；MCP client 进程管理 |
| `skill-loader` | `cap.tool.skill`、`cap.skill.appendix` | `cap.meta` | — | `/api/skills/list`；目录扫描 + AGENTS.md 读取 |
| `hook-bridge` | — | `cap.meta` | `tool.before`、`tool.after`、`user.prompt`、`cap.agent.loop:event` | `/api/hooks/list`、`/api/hooks/confirm`；hook 进程执行 + 审计 |
| `compat-adapter` | — | `cap.meta` | — | `/api/compat/scan`、`/api/compat/import`；manifest 翻译 |

agent-loop 自身 grants：events 增 `tool.before`/`tool.after`（派发用）。

---

## 3. 实施细节（定稿级）

### 3.1 agent-loop 三处小改（全部向后兼容）

- **A1 discoverTools**（`index.ts:129-140`）：
  ```ts
  const d = r.data?.descriptor;
  const list = d ? [d] : (r.data?.descriptors ?? []);
  for (const item of list) if (item?.name) tools.set(item.name, item);
  ```
  单 descriptor 插件零变化；`toolDefsSnapshot` 指纹机制不变。
- **A2 appendix**：system prompt 硬编码段（`index.ts:440-461`）之后追加 `await appendixOf(sessionId)`；实现为 `try { const r = await hostApi.dispatch({target:'cap.skill.appendix', action:'get', payload:{sessionId, cwd}}); if (r.data?.text) shadow[0].content += '\n\n' + r.data.text; } catch {}`——cap 不存在/失败时零影响。
- **A3 tool.before/after**：在 `decideApproval` 通过后、exec 前：
  ```ts
  const hookVerdict = await hostApi.dispatch({ target: 'cap.hook.bridge', action: 'preToolUse', payload: { sessionId, toolName: call.name, toolInput: safeArgs(call.arguments) } }).catch(() => null);
  if (hookVerdict?.data?.decision === 'deny') { /* 发 tool.result(status:'denied') + 喂回 [被 hook 拦截] + continue */ }
  ```
  exec 成功/失败后 fire-and-forget `postToolUse`。**用 cap 而非事件**（V7：事件要双向 grants 且无回执；cap dispatch 有响应且走审计）。
- 三处均为「无 compat 插件时零行为变化」的增量；配套单测进 `tests/`。

### 3.2 mcp-bridge（P0 核心）

- **发现**（已验证逻辑，V6）：合并序 `项目 .mcp.json → 项目 .zcode/config.json(mcp.servers) → 项目 .agents/mcp.json → 用户 ~/.claude.json(按当前 workspace projects 键) → 用户 ~/.zcode/cli/config.json`；lite 原生（`cap.kv` 里的手工登记）最高。同名先到先得+warn；ZCode 遗留字段迁移；`type` 推断；非 stdio P0 跳过+warn；`${VAR}`/`${VAR:-d}` 展开（变量：进程 env + `WORKSPACE`），展开后 `path.resolve` 归一。
- **client**（已验证，V3）：每 server spawn + NDJSON JSON-RPC；`initialize`（15s 超时）→ `tools/list` 缓存 → `tools/call`；进程退出重启一次并审计；并发启动去重。
- **cap.tool.mcp handler**（浏览器半边）：`describe` → `GET /api/mcp/servers` 汇总各 server tools → `{descriptors:[{cap:'cap.tool.mcp', name:'mcp__<server>__<tool>', description, parameters: inputSchema, danger:'execute'}]}`；`exec {name, arguments}` → `POST /api/mcp/call`。
- **门控**：per-tool 开关存 `cap.kv`（`mcp.gate.<server>.<tool>`），describe/exec 双侧过滤；默认放行（对齐 ZCode），设置页可关。
- **codebuddy 透传**（V9）：`codebuddy-engine/server.mjs` startParams 增加 `mcp_servers: activeServers.map(s => ({server_name: s.name, command: s.command, args: s.args}))`——一行聚合，CodeBuddy 会话即得 MCP 工具。
- 安全：`PLITE_MCP=0` 硬关（对齐 `PLITE_CODEBUDDY` 惯例 V8）；workspace 来源首启确认（kv 存「文件 mtime+内容 hash」指纹，变了重新确认）；每次 spawn/调用写 `<dataDir>/mcp-audit.log`。

### 3.3 skill-loader（P0）

- 发现序列：`<work>/.polaris-lite/skills` → `<work>/.claude/skills` → `<work>/.zcode/skills` → `<work>/.agents/skills` → `<dataDir>/skills`（插件贡献目录，compat-adapter 写入）；同名先到先得（已验证 V4）。mtime 缓存避免每轮重扫。
- frontmatter：取 `name/description/when_to_use`；desc>1024 截断+warn；无 frontmatter 用目录名（已验证 V4）。
- appendix 内容：`# Available skills` 索引 + 使用说明（「需要细节先 read_skill」）+ AGENTS.md/CLAUDE.md 正文（向上查找、CLAUDE.md 在后拼接、32KB 截断）。
- `cap.tool.skill`：`describe` → `read_skill` 工具（parameters `{name, args?}`）；`exec` → 返回 SKILL.md 全文（16KB 截断）；`args` 做 `$ARGUMENTS`/`$1/$2` 替换（commands 目录的 md 同样包装成 skill，`/` 前缀名进索引）。

### 3.4 hook-bridge（P1）

- 事件接线（D6）：`SessionStart`=loop 首轮开始；`UserPromptSubmit`=chat-lite 已广播的 `user.prompt` 事件（hook-bridge listen，block 时经 `cap.ai.chat.interrupt` 收敛本轮）；`PreToolUse`/`PostToolUse(Failure)`=A3 的 cap 回调（按 exec 结果区分 success/failure）；`PermissionRequest` P1 只读不采信（P2 再放开）；`Stop`=loop `loop.done` 时点。
- 执行器（已验证 V5）：`command`（shell 串，默认 Git Bash on win32）/`process`（argv）；stdin=输入 JSON（`{session_id, cwd, hook_event_name, tool_name?, tool_input?}`）；stdout 严格 JSON 解析（失败当非阻断纯文本）；退出码 0 放行 / 2 阻断 / 其他=非阻断错误；`timeoutMs` 优先、`timeout`（秒）换算，默认 60s；`additionalContext` 并入下轮 appendix；matcher=大小写敏感正则（工具名映射：bash→Bash、read_file→Read、write_file/edit_file/apply_patch→Edit、glob→Glob、dispatch_agent→Agent/Task、`mcp__*` 原名），非法正则永不匹配+warn。
- 配置读取：`~/.claude/settings.json`、`<work>/.claude/settings(.local).json` 的 `hooks` 键 + `<work>/.zcode/config.json` 顶层 `hooks`（尊重其 `enabled:true` 前置）+ compat-adapter 转交的插件 hooks。
- 安全：`PLITE_HOOKS=0` 硬关；用户级自动启用、workspace 级首启确认（同 D2 指纹法）；每次执行写 `<dataDir>/hooks-audit.log`。

### 3.5 compat-adapter（P1）

- 扫描 `<work>/.claude/plugins/`、`<work>/.zcode/plugins/`、`<dataDir>/compat-plugins/`；识别 `.claude-plugin/plugin.json` / `.zcode-plugin/plugin.json`（ZCode 自身兼容探测 `.claude-plugin/`，照做）。
- 翻译：`mcpServers`(stdio)→mcp-bridge import（server 名前缀 `plugin-<id>-`，`${CLAUDE_PLUGIN_ROOT}`/`${ZCODE_PLUGIN_ROOT}`→插件目录、`${CLAUDE_PROJECT_DIR}`→workspace）；`skills`/`commands` 目录→复制到 `<dataDir>/skills/plugin-<id>-<name>/`；`hooks`→hook-bridge 登记；其余字段（agents/lspServers/outputStyles/userConfig/channels）忽略+warn 清单。
- 准入校验：路径逃逸（`..`、绝对路径 command）、超长字段、坏 JSON → 拒绝导入并报告；manifest 未知键忽略+warn（宽松，不学 ZCode 丢弃）。
- 如实边界：只承诺「声明型插件」（skills+mcpServers+hooks）；含 UI/服务进程的 CC/ZC 插件给「部分兼容」报告——lite 插件是构建期 bundle，运行时加载外部 JS 本身就是安全红线，不破例。

### 3.6 Subagents（P2，可选）

读 `.claude/agents/*.md` 作「角色卡」：指定角色名时其 description+正文经 appendix 注入，`tools` 白名单在 buildToolDefs 裁剪；无自动委派、无并行执行（两家交集为空，价值低）。

---

## 4. 分期与验收

| 期 | 交付 | 验收门槛 |
|---|---|---|
| **P0** | mcp-bridge + skill-loader + agent-loop A1/A2 + codebuddy 透传 + grants +4 + 开关/审计 | ① 夹具 workspace（`.mcp.json`+`.zcode`+`.agents`+skills+AGENTS.md）下 real-engine 会话能列并调用 MCP 工具、read_skill 可用、appendix 含 AGENTS.md；② codebuddy 会话 `--mcp-config` 临时文件含预期 server；③ 同名冲突/坏 JSON/http 跳过按 V6 断言；④ `npm run typecheck && npm test` 全绿，新增单测覆盖解析器/发现/appendix |
| **P1** | hook-bridge + compat-adapter + agent-loop A3 + 确认页 | ① V5 四场景 E2E（deny 拦工具/additionalContext 入下轮/UserPromptSubmit block/exit2 阻断）；② 真实 CC/ZC 声明型插件导入冒烟（MCP 工具+skill 可用、warn 报告正确）；③ 恶意 manifest（路径逃逸）被拒；④ 审计日志断言 |
| **P2** | http/sse MCP、PermissionRequest 采信、Stop 继续语义、subagent 角色卡、`!`cmd``、OAuth | 按子项单独立 spec |

实施纪律：每插件一个主题提交；动 agent-loop 的三处小改各自独立 commit + 单测；`check:plugins`/`typecheck`/`npm test` 全绿才算完成；grants 变更与插件同提。

---

## 5. 验证记录（本稿依据）

| PoC | 位置 | 结果 |
|---|---|---|
| MCP stdio JSON-RPC 全流程（initialize/tools/list/tools/call，含中文参数，真子进程） | `%USERPROFILE%/mcp-fake-server.cjs` + `mcp-client-poc.cjs` | **PASS**（INIT_OK fake 2024-11-05 / TOOLS echo / CALL ECHO:你好 hello） |
| SKILL.md 发现+frontmatter（同名遮蔽/无 frontmatter/超长 desc） | `%USERPROFILE%/skills-poc.mjs` | **PASS**（COUNT 3，deploy 取项目级且记录遮蔽） |
| hook JSON 协议+退出码（deny/additionalContext/exit2/坏 JSON） | `%USERPROFILE%/hooks-poc.mjs` | **PASS**（四场景语义全部符合预期） |
| MCP 多源发现/合并/迁移/展开（8 断言） | `%USERPROFILE%/mcpdiscover-poc2.mjs` | **PASS 8/8**（教训：展开后须 path.resolve 归一） |
| `mcp__*` 命名 OpenAI 兼容性 | 内联校验 | **PASS**（字符集/长度/schema 直通） |
| 代码断言（V1/V2/V7/V8/V9/V10） | 只读核实 `bus.ts`/`hostRuntime.ts`/`agent-loop`/`server-registry.mjs`/`adapter.cjs`/`grants.json` | 全部证实，无臆造接口 |

## 6. 残余风险

1. **安全**仍是首位：三护栏（默认关/首启确认/审计）+ 路径围栏缺一不可；公网穿透部署建议三开关全关（对齐 agent-bash 的部署建议惯例）。
2. **双引擎 MCP 行为差**：real-engine 经 agent-loop（有审批/门控/审计），codebuddy 走 CLI 自带工具链（自有权限模型）——文档必须明示，避免「同配置不同行为」困惑。
3. **上游漂移**：CC hooks 30+ 事件、ZC schema 演进——只承诺 7 事件交集+已知字段，解析宽松+warn，兼容表集中在各插件单文件。
4. **性能**：发现目录变多——mtime 缓存+惰性 read_skill+MCP server 懒启动（首次 describe 才 spawn）。
