# polaris-lite 扩展能力体系（MCP / Skills / Hooks / 插件）原生支持 + Claude Code / ZCode 兼容 — 最佳方案 v2（定稿）

> 状态：**已被 v3（纯插件方案）取代——见 [plans/extension-capability-pure-plugin-plan.md](extension-capability-pure-plugin-plan.md)**。v2 的能力分层思想被 v3 继承，但实现载体从「core 内建」改为「能力插件」；v2 的 ToolRegistry/cap.system/HookBus-as-core 不再实施。
> 本稿取代 `plans/extension-compat-claude-zcode-final.md`（v1 视角是「兼容适配」）。按用户澄清重定位：**目标首先是让 polaris-lite 自己拥有这四类扩展能力（一等公民）**，Claude Code / ZCode 的文件格式兼容只是这些能力之上的**接入层**（adapter），不是目的本身。
> 已验证基础：v1 的 5 项 PoC（MCP stdio 真进程全流程、SKILL.md 发现、hook JSON 协议+退出码、多源配置合并、`mcp__*` 命名）全部 PASS，直接继承。

---

## 0. 目标重述与总架构

**目标**：polaris-lite 成为自带扩展体系的 AI 工作台——
1. **MCP**：宿主能配置、连接、管理 MCP server，其工具成为 AI 可用的工具（两个引擎都吃到）。
2. **Skills**：宿主能发现/管理 SKILL.md 技能，注入上下文并按需加载，AI 有 `read_skill` 工具。
3. **Hooks**：宿主有生命周期钩子系统，能在会话/轮次/工具节点执行外部或内部钩子。
4. **插件**：宿主插件模型本身已存在（双入口插件）——补齐其「外部格式接入」与「工具/引擎贡献点」的短板。
5. **兼容**：以上能力的配置面直接吃 Claude Code / ZCode 的既有文件格式（`.mcp.json`、`SKILL.md`、`settings.json#hooks`、`.claude-plugin/`、`.zcode-plugin/`），用户零迁移成本。

**v1 → v2 的关键修正**：v1 把四个能力全部做成「compat 插件」（外挂视角）；v2 把它们拆成两层——
- **能力层（宿主/核心，一等公民）**：工具注册表、系统提示注入点、生命周期钩子总线、（服务端）统一能力网关——这些是 polaris-lite 自身的产品能力，没有 Claude/ZCode 也应该存在；
- **接入层（适配插件）**：把 Claude/ZCode 文件格式翻译到能力层。接入层可以缺席（能力仍在），能力层不依赖任何外部格式。

```
┌─ 接入层（适配插件，可插拔）─────────────────────────────────────┐
│ zcode-compat 插件：.mcp.json / .zcode / .agents / SKILL.md /     │
│ settings#hooks / .claude-plugin / .zcode-plugin → 调能力层 API   │
├─ 能力层（宿主一等公民）────────────────────────────────────────┤
│ ① 工具注册表 ToolRegistry（浏览器+服务端）                        │
│ ② 系统提示装配器 SystemPromptComposer（appendix 段）              │
│ ③ 生命周期钩子总线 HookBus（7 事件）+ 进程执行器                   │
│ ④ MCP 客户端服务（server 侧，stdio/http）+ /api/mcp/* 管理面      │
│ ⑤ 技能服务（发现/索引/读取）+ /api/skills/* 管理面                 │
│ ⑥ 服务端统一 /api/cap 网关（可选，P2）                            │
├─ 现有宿主基座 ────────────────────────────────────────────────┤
│ CapBus + grants 三重 gate + 双入口插件 + agent-loop + 引擎单注册位 │
└────────────────────────────────────────────────────────────────┘
```

---

## 1. 能力层设计（宿主一等公民）

### 1.1 ① 工具注册表 ToolRegistry（核心新增，替换「if 分支 + describe 约定」）

**现状问题**（二次勘察证实）：agent-loop 的工具消费是**硬编码 if 分支**（`index.ts:596-892`，interactive/render/fs/ledger/browser 各一个特判，其余走通用 exec），工具发现依赖 `cap.tool.*` 的 describe 约定。工具体系没有宿主级抽象——每个工具插件自己实现 describe/exec 协议，agent-loop 逐个特判渲染与参数处理。

**能力层设计**：
- 新增宿主模块 `src/core/toolRegistry.ts`（浏览器侧）：
  ```ts
  interface ToolRegistration {
    name: string;                       // 模型可见工具名（如 'bash'、'mcp__github__create_issue'）
    title: string; description: string;
    parameters: unknown;                // JSON Schema
    danger: 'read' | 'write' | 'execute';
    source: { pluginId: string; cap?: string; mcpServer?: string };  // 归属
    render?: 'card' | 'interactive' | 'render' | 'plain';           // 渲染语义（替代 if 分支魔改）
    execute(input: Record<string, unknown>, ctx: ToolExecCtx): Promise<ToolResult>;
  }
  ```
  - agent-loop 改为从注册表取工具（`toolRegistry.list()` / `execute()`），**if 特判分支全部退役**；`cap.tool.*` 的 describe 协议保留为插件注册的**一种来源**（ToolRegistry 提供一个「从 cap 适配」的登记器，存量插件零改动）。
  - 渲染语义进注册表：tool.card 的展示形态由 `render` 字段决定，chat-lite 按语义渲染——这是把「交互卡/预览/普通卡」从 agent-loop 硬编码升级为宿主契约。
  - 审批策略进注册表：`danger` + 可选 `approve: 'always' | 'confirm' | 'never'`，`decideApproval` 读注册表元数据而非按 cap 名猜。
- 服务端对应物：MCP 客户端服务（1.4）就是服务端工具来源之一；`/api/tools/registry`（P2，配合统一网关）可暴露服务端工具清单。

**为什么是一等公民**：工具是 AI 工作台的核心资产；注册表让「工具」脱离具体插件协议存在，MCP、插件、内置工具、未来的 subagent 工具都往同一个注册表里落。这是 v2 与 v1 最大的差别。

### 1.2 ② 系统提示装配器 SystemPromptComposer

**现状问题**：agent-loop system prompt 是纯字符串硬编码（`index.ts:441-462`），无注入点；不读 AGENTS.md/CLAUDE.md。

**能力层设计**：
- 新增 `src/core/systemPrompt.ts`：`composeSystemPrompt(ctx) => sections[]`。固定段（角色/平台/工具用法——把现有硬编码文案迁进来）+ **appendix 段**（有序列表，运行时注册）。
- 注册通道（已按 V7 事件门控事实定稿）：agent-loop 组装前 `dispatch('cap.system.appendix', 'get', { sessionId, cwd })`——由**宿主新内置 cap `cap.system`**（不是插件）提供聚合：遍历已登记的 appendix 提供方（skills 服务、hooks 的 additionalContext、未来角色卡）按序拼接。
- `cap.system` 由 core 注册（`main.tsx` 安装，同 `installMetaCapability` 模式），provides 方是「宿主」本身——CapBus 允许 core 以平台身份注册，不经 grants（grants 是约束插件的）。

### 1.3 ③ 生命周期钩子总线 HookBus

**现状问题**：无任何钩子系统；插件只有 `setup()` 一次性钩子与事件总线旁听。

**能力层设计**：
- 新增 `src/core/hookBus.ts`（浏览器）+ `server/hooks-service.mjs`（Node，进程执行器）：
  ```ts
  type HookEvent = 'session.start' | 'session.end' | 'prompt.submit' | 'turn.end'
                 | 'tool.before' | 'tool.after' | 'tool.error' | 'permission.request';
  interface HookHandler { (input: HookInput): Promise<HookOutput> }  // 内部钩子（cap 回调形态）
  hookBus.register(event, handler, { owner, matcher?, timeoutMs? });
  hookBus.dispatch(event, input): Promise<HookOutcome>  // 汇总各 handler：allow/deny/context/args 改写
  ```
- 触发点落位（agent-loop 三处小改，继承 v1 A1-A3 但目标变为 HookBus）：
  - `tool.before`：exec 前（审批通过后），outcome.deny → 跳过执行并喂回 `[被钩子拦截]`；
  - `tool.after` / `tool.error`：exec 后 fire-and-forget；
  - `prompt.submit`：chat-lite `sendUserMessage` 入口（`index.ts:350`）dispatch，deny → 本轮不发并 toast；
  - `session.start` / `turn.end`：loopHandler 入口/出口；
  - `permission.request`：`decideApproval` 决策点（P2 采信钩子结果）。
- **外部进程钩子**（Claude/ZCode 的 command/process 形态）由 Node 侧执行器承载：`server/hooks-service.mjs` 提供 `POST /api/hooks/run`（stdin JSON → stdout JSON → 退出码 0/2 语义，V5 已验证），浏览器 HookBus 的外部钩子 handler 经 fetch 调它。事件名映射与 matcher 语义见 §3.3。

**为什么是一等公民**：钩子是宿主生命周期契约，内部插件（如 ai-events、审计、未来自动化）与外部格式（CC/ZC hooks）都挂同一总线。

### 1.4 ④ MCP 客户端服务（宿主级，server 侧）

**现状问题**：无 MCP；codebuddy adapter 有未接线通道；工具面与 MCP 割裂。

**能力层设计**：
- 新增 `server/mcp-service.mjs`（宿主服务，非插件 server 半边——挂 `createHost` 装配链，与 providers/relay 同级）：
  - **配置仓库**：`<dataDir>/mcp-servers.json`（lite 原生格式，唯一写目标）+ 多源只读发现合并（`.mcp.json`/`.zcode`/`.agents`/`~/.claude.json`，V6 已验证；合并结果可一键「固化导入」进原生配置）；
  - **连接管理**：stdio/http client 池（V3 已验证 JSON-RPC NDJSON 全流程），进程级复用（非每轮重启）、健康检查、15s 启动超时、崩溃重启一次；
  - **工具面**：`tools/list` 汇总 → 以 `mcp__<server>__<tool>` 名注册进 **ToolRegistry**（1.1，render:'card'，danger 按服务端 annotations/启发式）；
  - **管理面 API**：`GET /api/mcp/servers|tools`、`POST /api/mcp/servers`（增删改原生配置）、`POST /api/mcp/import`（外部格式固化）、`POST /api/mcp/gate`（per-tool 开关，存 sqlite kv）；
  - **审计**：`<dataDir>/mcp-audit.log`（spawn/call/退出全记录）。
- 浏览器侧：宿主以平台身份把 MCP 工具注入 ToolRegistry（经 `cap.meta`/工具列表查询可见来源与门控状态）；管理面板做进 plugin-manager 或新 `mcp-desk` 面板插件。
- **引擎接入双通道**：
  - real-engine（browser）：agent-loop 经 ToolRegistry 执行（与其它工具同路径，享受审批/审计）；
  - codebuddy-engine（CLI）：startParams 透传 `mcp_servers`（adapter.cjs:332 通道现成）——**宿主 mcp-service 启动时把已启用 server 列表写给 codebuddy 插件 server 半边**（经新 `/api/mcp/active` 只读端点），或 codebuddy 直接读同一份 `<dataDir>/mcp-servers.json`（推荐，单一数据源）。

### 1.5 ⑤ 技能服务（宿主级）

- 新增 `server/skills-service.mjs`：扫描目录序列 `<dataDir>/skills`（原生）→ workspace `.polaris-lite/skills`（原生）→ `.claude|.zcode|.agents/skills`（兼容来源，V4 已验证解析）；mtime 缓存；管理面 `GET /api/skills/list`、`POST /api/skills/reload`。
- 注入：skills-service 把索引 + 使用说明经 **SystemPromptComposer appendix** 注册（`cap.system`）；`read_skill` 工具注册进 **ToolRegistry**（原生工具，name='read_skill'，danger:'read'）。
- AGENTS.md / CLAUDE.md：同一服务读取注入（默认开，kv 开关可关）——这是 lite 自身缺失的基础能力，与兼容无关。

### 1.6 ⑥ 服务端统一 /api/cap 网关（P2，可选）

现状服务端是纯 HTTP 中间件、无 cap 概念（勘察 §2）。长期应把「服务端能力」也纳入 cap 语义（统一鉴权/审计/权限），`docs/server-gateway-contract.md` 已有设计稿。本方案 P2 仅预留：新服务（mcp/skills/hooks）的 API 按「未来可平移进网关」的风格写（统一前缀、会话门禁、审计），不在本期实装网关。

---

## 2. 插件能力补强（第四类扩展的原生部分）

lite 插件模型本身已是一等公民（双入口 + grants 三重 gate + 拓扑装配）。对照 Claude/ZCode 插件，缺的是两块：

1. **工具/引擎贡献点的标准化**：由 1.1 ToolRegistry 解决（插件注册工具 = 向注册表登记，不再各自发明 describe 协议；存量 cap.tool.* 经适配器继续可用）。
2. **外部格式插件的接入**：见 §3.4（zcode-compat 插件翻译 `.claude-plugin/`、`.zcode-plugin/`）。

不做：运行时安装任意外部 JS 插件（lite 插件是构建期 bundle，这是安全边界而非缺陷）；市场机制（registry.json 双写启停已够用）。

---

## 3. 接入层：Claude Code / ZCode 兼容（一个适配插件）

v1 的四个 compat 插件收敛为**一个 `zcode-compat` 插件**（接入层不该有四个入口；能力都在宿主层，适配只是「读外部文件 → 调宿主 API」）：

### 3.1 MCP 接入
- 读取源与合并序（v1 §3.2 已验证）：项目 `.mcp.json` → 项目 `.zcode/config.json#mcp.servers` → 项目 `.agents/mcp.json` → 用户 `~/.claude.json`（按 workspace projects 键）→ 用户 `~/.zcode/cli/config.json`；ZCode 遗留字段迁移；`${VAR}`/`${VAR:-d}` 展开（含 `${CLAUDE_PROJECT_DIR}`/`${ZCODE_PROJECT_DIR}`/`${CLAUDE_PLUGIN_ROOT}`/`${ZCODE_PLUGIN_ROOT}` 识别）；展开后 `path.resolve` 归一（PoC 教训）。
- 动作：扫描结果呈现给用户（设置页/面板）→ 用户确认后**固化写入** `<dataDir>/mcp-servers.json`（原生格式）；此后 mcp-service 直接吃原生配置。适配插件不常驻运行，只在导入/刷新时工作。

### 3.2 Skills / Commands 接入
- 扫 `.claude|.zcode|.agents/skills` 与 `commands` → 翻译进 skills-service 的扫描清单（只读引用，不复制文件；同名时原生目录优先）；frontmatter 解析规则按 V4（desc>1024 截断+warn，无 frontmatter 容忍）。
- commands 的 `$ARGUMENTS`/`$1/$2` 替换在 read_skill 执行时做；`!`cmd`` P2（学 ZCode 改写为 bash 工具调用的保守语义）。

### 3.3 Hooks 接入
- 读 `~/.claude/settings.json`、`<work>/.claude/settings(.local).json`、`<work>/.zcode/config.json`（尊重 `enabled:true` 前置）、插件 `hooks/hooks.json` → 归一为 HookBus 注册：
  - 事件映射：SessionStart→session.start；UserPromptSubmit→prompt.submit；PreToolUse→tool.before；PostToolUse(Failure)→tool.after/tool.error；PermissionRequest→permission.request；Stop→turn.end。（7 事件交集，D6 维持；CC 独有事件忽略+一次性 warn。）
  - handler 形态：command/process → 经 `POST /api/hooks/run` 进程执行（V5 协议：stdin JSON、stdout `hookSpecificOutput.permissionDecision/additionalContext/updatedInput`、退出码 0/2）；matcher=大小写敏感正则 + 工具名映射（bash→Bash、read_file→Read、write_file/edit_file/apply_patch→Edit、glob→Glob、dispatch_agent→Agent/Task、mcp__* 原名）；timeoutMs 优先/timeout 秒换算，默认 60s。
- 信任模型（D2 维持）：用户级来源自动启用；workspace 级来源首启确认（kv 存内容指纹，变更重确认）；`PLITE_HOOKS=0`/`PLITE_MCP=0`/`PLITE_SKILLS=0` 硬关。

### 3.4 插件接入
- 扫 `.claude/plugins/`、`.zcode/plugins/` 下的 `.claude-plugin/plugin.json` / `.zcode-plugin/plugin.json` → 翻译：`mcpServers`(stdio)→§3.1 固化导入（名前缀 `plugin-<id>-`）；`skills`/`commands`→§3.2；`hooks`→§3.3；其余字段忽略+warn。
- 准入校验：路径逃逸/绝对路径命令/坏 JSON 拒绝；manifest 宽松解析（未知键忽略+warn）。
- 如实边界：只承诺声明型插件（skills+mcpServers+hooks）；UI/服务型 CC/ZC 插件给「部分兼容」报告。

### 3.5 Subagents（P2，可选）
读 `.claude/agents/*.md` 作角色卡：appendix 注入 + ToolRegistry 工具白名单裁剪；无自动委派（两家交集为空）。

---

## 4. 实施切分（重排）

| 期 | 内容 | 性质 | 验收 |
|---|---|---|---|
| **P0 能力基座** | ToolRegistry（含 agent-loop if 分支退役+存量 cap.tool 适配器）+ SystemPromptComposer（cap.system appendix）+ HookBus（8 事件 + cap 回调 handler）+ skills-service（原生目录 + read_skill 工具 + AGENTS.md/CLAUDE.md） | **宿主原生能力**，无外部格式依赖 | 夹具 workspace：原生 skill 被索引并可 read_skill；appendix 注入；钩子 deny 拦工具/additionalContext 生效；agent-loop 无 if 特判后存量工具（bash/fs/interactive/render/ledger/browser）E2E 全通；typecheck+npm test 全绿（新增 core 单测按 tests/core.test.mjs 惯例） |
| **P1 MCP 能力** | mcp-service（原生配置+client 池+管理面+审计）+ MCP 工具入 ToolRegistry + codebuddy 读同一配置透传 | **宿主原生能力** | 真 MCP server（PoC fake server 或社区 server）在两引擎会话可用；管理面 CRUD；门控/审计断言 |
| **P2 兼容接入** | zcode-compat 插件（§3.1-3.4 全部外部格式）+ 确认页 + warn 报告 | **接入层** | CC/ZC 夹具文件（.mcp.json/.zcode/SKILL.md/hooks/.claude-plugin）导入后能力层全部生效；同名优先级/坏 JSON/http 跳过按 PoC 断言；恶意 manifest 被拒 |
| **P3 增强（可选）** | http/sse MCP、OAuth、permission.request 采信、Stop 继续语义、subagent 角色卡、`!`cmd``、/api/cap 网关 | 增强 | 按子项立 spec |

依赖关系：P0 的 ToolRegistry/HookBus 是 P1/P2 的地基；P2 依赖 P0+P1 的宿主 API。每期一个主题批次提交；`npm run typecheck && npm test` + `check:plugins` 全绿门槛不变。

## 5. 风险（v2 视角增量）

1. **agent-loop 改造面变大**（if 分支退役是行为等价重构）：必须逐工具迁移+逐工具 E2E，禁止一次性重写；存量 describe 协议经适配器保留，防止破坏未迁移插件。
2. **core 注册 cap 的先例**：`cap.system` 由平台身份注册不经 grants——需要在 `policy.ts`/`arch.test.mjs` 明确「core 能力白名单」（cap.system/cap.meta/cap.auth 同级），防止未来滥用成后门。
3. 其余继承 v1：安全三护栏、双引擎 MCP 行为差（real-engine 走审批链、codebuddy 走 CLI 自有模型——文档明示）、上游漂移（只承诺交集+宽松解析）、性能（mtime 缓存/懒启动）。

## 6. 验证依据（继承 + 新增代码事实）

- 5 项 PoC 全 PASS（见 v1 final 稿 §5；脚本在 `%USERPROFILE%/mcp-*.cjs|skills-poc.mjs|hooks-poc.mjs|mcpdiscover-poc2.mjs`）。
- 二次勘察新证实：agent-loop 工具消费是 5 处 if 特判（index.ts:612/649/700/786/818）+ 通用 exec（:865）；system prompt 硬编码（:441-462）；服务端无 cap 概念（纯 HTTP 中间件，host.mjs:38）；core 注册 cap 有 `installMetaCapability` 先例（metaCapability.ts:18，main.tsx:39 安装）；新插件登记三点一链（build-plugins 清单 + grants.json + server-registry + 构建校验）；测试惯例 = node:test 直接 import `src/core/*.ts`（tests/core.test.mjs）。
