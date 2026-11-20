# polaris-lite 扩展能力体系 + Claude Code / ZCode 兼容 — 纯插件方案 v3（定稿）

> 状态：**定稿 v3（已验证，待实施）** · 2026-11-20 · 仓库：polaris-lite
> 演进：v1 兼容适配视角 → v2 能力原生化（需动 core：ToolRegistry/SystemPromptComposer/cap.system/HookBus）→ **本 v3：应「能否纯插件实现」的追问重排——结论是能，且代价可控**。
> v1 的 5 项 PoC（MCP stdio 真进程、SKILL.md、hook JSON 协议+退出码、多源配置合并、`mcp__*` 命名）继续有效。

---

## 0. 结论

**可以纯插件实现**，且不需要牺牲能力完整性。理由（代码事实）：

1. lite 的插件经 `registerCapability` 注册的 cap 与 core 注册的 cap **在总线上完全同权**（`bus.register` 不区分调用方；grants 三重 gate 只约束「插件能申请什么」，不区分提供方身份）——已核实 kv-store/real-engine/pocket-ledger 等全部经 `api.registerCapability.register` 注册（kv-store/index.ts:78、real-engine/index.ts:662-663、pocket-ledger/index.ts:188）。
2. v2 想加进 core 的四个「能力」本质都是**一组 cap + 一个 server 半边服务 + 几个事件**——这恰好就是 lite 插件的标准形态。core 真正缺的不是能力代码，而是「agent-loop 消费工具/提示词的硬编码」；而 agent-loop 本身也是插件（`plugins/agent-loop/index.ts`），**改它不算改 core**。
3. `requires` 拓扑排序已支持插件间依赖（externalPlugins.ts:176-205）——能力插件与 agent-loop 的接驳可以走 cap 依赖声明，无需宿主调度。

**代价（如实声明）**：相比 v2 的 core 内建，纯插件方案有三处妥协——① 能力与宿主生命周期不完全同寿（插件被禁用即能力消失，但这正是 lite 的产品语义，可接受甚至更符合「核心精简、一切皆插件」宪法）；② `cap.system`/`cap.hook` 这类「平台味」名字由插件提供，需要在文档与 cap.meta 元信息里标明提供方；③ agent-loop 的三处改造仍要做，只是发生在插件仓库内（它本来就是插件），风险面与 v2 相同。

---

## 1. 纯插件总体架构（v3）

```
┌─ 接入层（1 个适配插件，可插拔）──────────────────────────────┐
│ zcode-compat：读 CC/ZC 文件 → 固化导入原生配置 → 退出          │
├─ 能力层（3 个能力插件，互相独立、可单独禁用）────────────────┤
│ mcp-bridge   provides: cap.tool.mcp(聚合) + cap.mcp.admin     │
│              server.mjs: MCP client 池 + /api/mcp/* 管理面     │
│ skill-loader provides: cap.tool.skill + cap.skill.appendix    │
│              server.mjs: /api/skills/* 发现服务                │
│ hook-bridge  provides: cap.hook.bridge                        │
│              server.mjs: /api/hooks/* 进程执行器 + 审计        │
├─ 宿主既有插件（改造，仍是插件）──────────────────────────────┤
│ agent-loop：A1 describe 数组兼容 / A2 appendix 注入 /          │
│            A3 tool.before/after 钩子回调                       │
│ codebuddy-engine：startParams 透传 mcp_servers（读同一配置）    │
│ chat-lite：/name 斜杠输入识别（P2）                             │
└──────────────────────────────────────────────────────────────┘
```

与 v2 的映射：v2 的 ToolRegistry → **不新建**，用「cap.tool.mcp 聚合 cap + describe 数组」达成同等效果（工具元数据仍分散在各 cap 的 describe 里，但 agent-loop 消费面统一）；v2 的 SystemPromptComposer → **cap.skill.appendix 单 cap 聚合**（appendix 提供方就是 skill-loader 一个，不需要广播机制）；v2 的 HookBus → **cap.hook.bridge 单 cap 回调**（hook-bridge 聚合全部钩子逻辑，内部插件未来要挂钩子时再升级为多 handler）；v2 的 mcp-service/skills-service → 各自插件的 server 半边。

---

## 2. 三个能力插件设计

### 2.1 mcp-bridge

- **manifest**：`provides: ['cap.tool.mcp', 'cap.mcp.admin']`；`requires: []`；`events: ['tool-registered']`；`capabilities: ['cap.meta', 'cap.kv']`（kv 存 per-tool 门控与导入指纹）。
- **server.mjs**：
  - 配置：原生仓库 `<dataDir>/mcp-servers.json`（唯一写目标）+ 只读多源发现（`.mcp.json`/`.zcode/config.json#mcp.servers`/`.agents/mcp.json`/`~/.claude.json` 按 workspace 键/`~/.zcode/cli/config.json`；V6 合并逻辑 8/8 断言已验证：同名先到先得+warn、ZCode 遗留字段迁移、`${VAR:-d}` 展开后 `path.resolve` 归一、http 跳过+warn）。
  - client 池：stdio NDJSON JSON-RPC（V3 真进程已验证：initialize→tools/list→tools/call，协议 2024-11-05），15s 启动超时、崩溃重启一次、进程级复用；http/sse P3（undici 已在依赖）。
  - 管理面：`GET /api/mcp/servers|tools|active`、`POST /api/mcp/servers`（CRUD 原生配置）、`/api/mcp/import`（外部格式固化，写原生仓库）、`/api/mcp/gate`（per-tool 开关→kv）。会话门禁 + `PLITE_MCP=0` 硬关 + `<dataDir>/mcp-audit.log` 全量审计（spawn/call/退出码）。
- **浏览器半边**：`cap.tool.mcp#describe` → 汇总各 server tools 返回 `{descriptors:[{cap:'cap.tool.mcp', name:'mcp__<server>__<tool>', description, parameters:inputSchema, danger:'execute'}]}`；`cap.tool.mcp#exec {name, arguments}` → `POST /api/mcp/call`。`cap.mcp.admin` 供管理面板（并入 plugin-manager 面板或自带 panel 槽）。
- **codebuddy 接通**：codebuddy-engine/server.mjs 的 startParams 增加一段——读同一份 `<dataDir>/mcp-servers.json`（经 `/api/mcp/active` 或直接读文件）构造 `mcp_servers:[{server_name,command,args}]` 透传（adapter.cjs:332-347 通道现成，V9 已核实）。两个引擎都吃到 MCP。

### 2.2 skill-loader

- **manifest**：`provides: ['cap.tool.skill', 'cap.skill.appendix']`；`capabilities: ['cap.meta', 'cap.kv']`。
- **server.mjs**：扫描 `<dataDir>/skills` → `<work>/.polaris-lite/skills` → `.claude|.zcode|.agents/skills`（原生优先，同名先到先得；V4 已验证：frontmatter name 回退目录名、desc>1024 截断+warn、无 frontmatter 容忍）；mtime 缓存；`GET /api/skills/list`。**AGENTS.md/CLAUDE.md 同服务读取**（向上查找、CLAUDE.md 在后拼接、32KB 截断；默认开，kv 开关）。
- **浏览器半边**：
  - `cap.skill.appendix#get {sessionId, cwd}` → 返回 `{text}`：`# Available skills` 索引 + 「需要细节先 read_skill」+ AGENTS.md/CLAUDE.md 正文（agent-loop A2 拼进 system prompt）。
  - `cap.tool.skill#describe` → `read_skill` 工具（parameters `{name, args?}`，danger:'read'）；`#exec` → SKILL.md 全文（16KB 截断），`args` 做 `$ARGUMENTS`/`$1/$2` 替换（commands 目录的 md 包装为 skill，`/` 前缀名进索引——斜杠命令 P2 由 chat-lite 识别 `/name args` 后把 name/args 传给 loop）。

### 2.3 hook-bridge

- **manifest**：`provides: ['cap.hook.bridge']`；`events: ['user.prompt', 'cap.agent.loop:event']`；`capabilities: ['cap.meta', 'cap.kv']`。
- **server.mjs**：钩子配置归一（CC `settings(.local).json#hooks` + ZC `config.json#hooks` 尊重 `enabled:true` + 插件 hooks.json）→ `{event, matcher?, handlers:[command|process]}`；进程执行器 `POST /api/hooks/run`：stdin=输入 JSON `{session_id, cwd, hook_event_name, tool_name?, tool_input?}`，stdout 严格 JSON（失败当非阻断纯文本），退出码 0 放行/2 阻断/其他非阻断，timeoutMs 优先/timeout 秒换算默认 60s（V5 真进程四场景已验证）。matcher=大小写敏感正则+工具名映射（bash→Bash、read_file→Read、write_file/edit_file/apply_patch→Edit、glob→Glob、dispatch_agent→Agent/Task、mcp__* 原名），非法正则永不匹配+warn。CC 独有事件忽略+一次性汇总 warn。审计 `<dataDir>/hooks-audit.log`。
- **浏览器半边** `cap.hook.bridge` 动作（agent-loop A3 调用）：
  - `preToolUse {sessionId, toolName, toolInput}` → 同步执行匹配的 tool.before 钩子 → `{decision:'allow'|'deny', reason?, updatedInput?, additionalContext?}`；
  - `postToolUse {…, success}` → fire-and-forget 执行 tool.after/tool.error 钩子，additionalContext 存 kv 供下轮 appendix；
  - `onPrompt {sessionId, prompt}` → chat-lite 发送前调（或 hook-bridge 监听 `user.prompt` 事件后需要阻断时经 `cap.ai.chat.interrupt` 收敛）→ deny 则本轮不发；
  - `onSessionStart/onTurnEnd` → loopHandler 入口/出口调用（SessionStart/Stop 事件）。
- 信任模型：用户级来源自动启用；workspace 级来源首启确认（kv 内容指纹，变更重确认）；`PLITE_HOOKS=0` 硬关。

---

## 3. agent-loop 三处改造（插件内，向后兼容）

| # | 位置 | 改法 | 兼容性 |
|---|---|---|---|
| A1 | discoverTools（index.ts:129-140） | `const list = r.data?.descriptor ? [r.data.descriptor] : (r.data?.descriptors ?? [])`，逐项入 tools Map | 旧插件单 descriptor 零变化 |
| A2 | system prompt 播种（:441-462）后 | `try { const r = await hostApi.dispatch({target:'cap.skill.appendix', action:'get', payload:{sessionId, cwd}}); if (r.data?.text) shadow[0].content += '\n\n' + r.data.text; } catch {}` | cap 不存在/失败零影响 |
| A3 | 审批通过后 exec 前（:676 附近）+ exec 回填后 | `const hv = await hostApi.dispatch({target:'cap.hook.bridge', action:'preToolUse', payload:{…}}).catch(()=>null); if (hv?.data?.decision==='deny') { 发 tool.result(denied) + 喂回[被钩子拦截] + continue; }`；exec 后 fire-and-forget `postToolUse` | hook-bridge 未装时 `.catch(()=>null)` 放行 |

不做的（如实）：v2 的 ToolRegistry（if 特判退役）与 `cap.system` 平台 cap **不再是本方案内容**——if 分支保留（它们是存量工具的渲染/参数特例，功能正确；统一抽象等真有第 4、5 个同类特例再立项）。agent-loop 的 `requires` 不新增（A2/A3 都是 optional dispatch，不依赖能力插件存在）。

---

## 4. zcode-compat 接入插件（第 4 个插件）

- **manifest**：`provides: []`；`capabilities: ['cap.meta', 'cap.mcp.admin', 'cap.kv']`；无常驻逻辑。
- **server.mjs**：`POST /api/compat/scan`（扫 workspace/home 的 CC/ZC 扩展文件，返回可导入清单+warn 报告）、`POST /api/compat/import`（执行导入：MCP→调 mcp-bridge 原生配置写入或直接写 `<dataDir>/mcp-servers.json`；skills/commands→提示用户放原生目录或直接复制到 `<dataDir>/skills/`；hooks→写 hook-bridge 的归一配置；`.claude-plugin/.zcode-plugin`→按其 mcpServers/skills/commands/hooks 三类贡献拆解导入）。
- 准入校验：路径逃逸/绝对路径命令/坏 JSON 拒绝；manifest 宽松解析（未知键忽略+warn）。只承诺声明型插件；UI/服务型给「部分兼容」报告。
- 信任：导入动作本身即用户确认（点「导入」按钮）；`PLITE_COMPAT=0` 可关。

---

## 5. 登记、测试与分期

**新插件登记清单**（构建校验强制，勘察 §8）：每个插件 = `plugins/<id>/index.ts`（manifest 字面量，id===目录名）+ `vite.config.ts` + 可选 `server.mjs`；四处登记：`build-plugins.mjs` plugins 数组、`public/grants.json`（capabilities/provides/events，申请⊆授权）、`server-registry.mjs`（有 server 半边时）、构建产物 registry.json。

| 期 | 交付 | 验收 |
|---|---|---|
| **P0** | skill-loader + hook-bridge + agent-loop A1/A2/A3 + grants/build 清单 | 夹具 workspace：原生 skill 索引+read_skill+AGENTS.md 注入；钩子 deny 拦工具/additionalContext 入下轮/prompt block/exit2 阻断；未装能力插件时 agent-loop 行为与现状完全一致（回归）；typecheck+npm test+check:plugins 全绿 |
| **P1** | mcp-bridge + codebuddy 透传 + 管理面板 | 真 MCP server 两引擎可用（PoC fake server 起步）；管理面 CRUD/门控/审计断言 |
| **P2** | zcode-compat + chat-lite `/name` 斜杠识别 + 确认页 | CC/ZC 夹具文件导入后能力全部生效；同名优先级/坏 JSON/http 跳过按 PoC 断言；恶意 manifest 被拒 |
| **P3**（可选） | http/sse MCP、subagent 角色卡、`!`cmd``、permission.request 采信、Stop 继续语义、OAuth | 按子项立 spec |

**测试惯例**（勘察 §7）：纯逻辑进 `tests/*.test.mjs` 直接 import `src/core/*.ts` 或插件 ts（node:test 类型剥离）；server 半边直调 `createServerPart`（plugin-manager.test.mjs 先例）；集成走 `createProdServer`（server.test.mjs 先例）。新增：`mcp-config.test.mjs`（合并/展开/迁移）、`skill-discover.test.mjs`、`hook-protocol.test.mjs`（V5 四场景固化为单测）、`agent-loop-compat.test.mjs`（A1 数组/A2 appendix/A3 阻断）。

## 6. 风险与边界（如实）

1. **能力非永续**：禁用 mcp-bridge/hook-bridge 即能力消失——这是 lite「一切皆插件」语义的正确体现，但文档要写清「这些能力由插件提供，可独立启停」。
2. **安全三护栏不变**：默认关（PLITE_MCP/HOOKS/SKILLS/COMPAT=0）、workspace 级来源首启确认（kv 指纹）、全程审计日志；公网穿透部署建议全关（对齐 agent-bash 部署建议）。
3. **双引擎 MCP 行为差**：real-engine 走审批链，codebuddy 走 CLI 自有权限模型——文档明示。
4. **agent-loop 是全局单点**：A1/A2/A3 均为「无能力插件时零行为变化」的增量，逐项配单测；禁止顺手重构。
5. **上游漂移**：只承诺 7 事件交集+已知字段；解析宽松+warn；兼容表集中在 zcode-compat 单文件。

## 7. 验证依据

继承 v1/v2 全部 PoC 与代码核实（5 项 PoC PASS + V1-V10 代码断言）；本 v3 新增核实：插件注册 cap 与 core 同权（kv-store:78、real-engine:662、pocket-ledger:188 均经 registerCapability）；`requires` 拓扑排序支持插件依赖（externalPlugins.ts:176-205）；agent-loop 无 server 半边、`requires:['cap.ai.chat','cap.tool.bash']`（index.ts:1046）——改它属于插件域改造。
