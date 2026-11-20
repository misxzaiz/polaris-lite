# 让 AI 自己创建 Hook / MCP / Skill / 插件并实时生效 — 分析稿（仅分析，未实施）
>
> ⚠ **已由定稿稿取代：见 [plans/runtime-extensions-and-market-final.md](runtime-extensions-and-market-final.md)**（含 §1-3 修正：外部插件 bundle 改由 /ext-plugins 自服务路由，不可复制进 dist——vite build emptyOutDir 会清掉）

> 状态：**分析稿（仅方案，未实施）** · 2026-11-20 · 仓库：polaris-lite
> 问题：怎么让 AI（会话里的助手）自己创建这四类扩展，并且**实时生效**（不用重启/重新构建）。
> 结论先行：**Skill 和 Hook 现在就能做到**（AI 已有写文件工具，发现链路已带自动重载）；**MCP 差一个"AI 可调的配置工具"**（最小增量）；**插件（UI/代码型）不可行**——这是 lite 的安全边界，需如实告知并给替代方案。

---

## 一、现状盘点：四类扩展的"创建→生效"链路

| 扩展 | 配置/文件落在哪 | 现有发现/生效链路 | AI 能否现在就自建 | 实时性 |
|---|---|---|---|---|
| **Skill** | `<ws>/.claude/skills/<名>/SKILL.md`（或 `.zcode/.agents/.polaris-lite/skills`、`<dataDir>/skills`） | skill-loader 每次会话播种时扫描（mtime 缓存 5s）→ 索引进 system prompt 附录；`read_skill` 按需读全文 | ✅ **能**。AI 已有 `files_write` 工具（cap.tool.files-write，写工作区内文件），`.claude/skills/` 在 workspace 内 | ✅ 近实时：写完 ≤5s 缓存过期即被索引；下一轮对话 AI 就能看到新技能 |
| **Hook** | `<ws>/.claude/settings.json` 的 `hooks` 键（或 `.zcode/config.json`；zcode-compat 导入产物 `<dataDir>/hooks-import.json`） | hook-bridge `loadRules()` 每次事件触发时读，缓存 key 含文件内容长度——文件一变立即重载 | ✅ **能**。AI 用 `files_write` 编辑 `<ws>/.claude/settings.json`（写 hook 脚本文件也在 workspace 内） | ✅ 实时：写完下一个工具调用/下一轮即生效 |
| **MCP** | `<dataDir>/mcp-servers.json`（原生格式，唯一写目标）；mcp-bridge 只吃这个文件 | agent-loop **每轮 start 都 `discoverTools()`**（index.ts:362）→ `cap.tool.mcp#describe` → `GET /api/mcp/tools` → 按需 spawn 新 server → 新工具进 tools 快照（集合指纹变化触发重发） | ⚠️ **差一步**。`mcp-servers.json` 在 dataDir（workspace 外），AI 的 `files_write` 围栏写不到；`/api/mcp/servers` POST 端点存在但 AI 没有调用 HTTP 的工具面 | 配置一写入即生效（下一轮对话工具列表即含新 server） |
| **插件**（UI/代码型） | `plugins/<id>/`（源码）→ 构建期 vite bundle → registry.json | 插件是**构建期产物**：新增/修改插件必须跑 `build:plugins`，且启停要改 registry + 刷新页面 | ❌ **不可行（安全边界，如实说明）**：让 AI 运行时生成并加载任意 JS = 任意代码执行。lite 的插件模型刻意把这一步放在构建期 + 代码评审 | — |

---

## 二、方案

### 2.1 Skill — 现在就能用（零开发）

给 AI 的提示词/系统提示里写明做法即可：

1. AI 调 `files_write`（action=write）写 `<ws>/.claude/skills/<名>/SKILL.md`，frontmatter 至少含 `name`、`description`（description 写清"何时用"，决定触发率）；
2. 写完后 AI 主动告诉用户"已创建技能 X"（≤5s 后索引即可见；也可以让 AI 调 `read_skill` 自验，或到「技能」面板点"重新扫描"立即刷新）；
3. 生效验证：下一轮对话的 system prompt 附录（# Available skills）里出现该技能；用户在技能面板能看到。

注意点：同名先到先得（`.polaris-lite/skills` > `.claude` > `.zcode` > `.agents`）；description >1024 字符会被截断。

### 2.2 Hook — 现在就能用（零开发），但要加一道"安全确认"闸

AI 自建 hook 的正确姿势是编辑 `<ws>/.claude/settings.json`：

```json
{ "hooks": { "PreToolUse": [ { "matcher": "Bash",
    "hooks": [ { "type": "command", "command": "node .claude/hooks/no-rm.cjs", "timeout": 10 } ] } ] } }
```

脚本文件本身也用 `files_write` 写进 workspace（如 `.claude/hooks/*.cjs`）。生效链路已验证：hook-bridge 的缓存 key 含 settings 文件内容指纹，写完即重载；执行时 stdin 收 JSON、退出码 2 = 阻断、stdout JSON 可返回 `permissionDecision`/`additionalContext`。

**必须补的安全闸（建议实施）**：hook 是"AI 给自己立规矩/改规矩"的通道——AI 可以写一个把自己所有工具都放行的 hook，绕过审批体系。建议在 hook-bridge 的 `loadRules()` 对 **workspace 级新增规则**做"变更需确认"（复用 mcp-bridge 的内容指纹 + kv 确认记录思路），未确认前新规则只记审计不执行。这是本方案里唯一建议动代码的点（hook-bridge server 半边，纯插件内）。

### 2.3 MCP — 差一个工具面（最小增量，建议实施）

AI 写不到 dataDir，因此给它一个**受审批保护的自建入口**，二选一：

- **方案 A（推荐，纯插件内）**：mcp-bridge 新增一个**工具形态**的 `mcp_server_add`（走 describe/exec 协议进 agent-loop，AI 调它 = 一次普通工具调用，天然享受审批/审计）：
  - `describe` → `{name:'mcp_server_add', description:'登记一个 MCP server（name/command/args）。会立即生效并进入下轮工具列表，属危险操作', danger:'execute'}`
  - `exec` → 内部复用 `/api/mcp/servers` POST 的同一套校验（name 合法性、command 字符串、绝对路径存在性）后写 `<dataDir>/mcp-servers.json`。
  - 生效：写完 → 下一轮 `discoverTools()` 自动拉到新 server 的工具（无需重启）。
  - 同理可加 `mcp_server_remove` / `mcp_server_list`（list 也可直接用现有面板）。
- **方案 B**：把 zcode-compat 的 import 扩展成"也扫 workspace `.mcp.json`"，让 AI 直接写 `<ws>/.mcp.json`，再由用户在面板点"导入"。更保守（AI 不直接改 dataDir），但"实时性"依赖用户手动点一次。

推荐 A（AI 全自动）+ 保留 B 的手动导入入口；两者不冲突。

### 2.4 插件 — 不可行，如实说明 + 替代路径

- **为什么不可行**：lite 插件 = 构建期 vite bundle + registry 登记 + 宿主动态 import。若给 AI"运行时装任意 JS"的能力，等于把 git clone 一个恶意仓库的风险升级成"AI 随时给自己装代码"，越过 grants/审计体系的意义。AGENTS.md 的"插件优先/核心最小"也不鼓励把运行时做成插件工厂。
- **替代路径**（按需求选）：
  1. AI 要"新功能面板"→ 用 **render 工具**（自包含 HTML 面板，已在对话卡片/预览面板运行）或 **interactive 卡**做轻量 UI——这已经能覆盖大部分"给我做个小工具"的诉求，且即时生效；
  2. 真要落成常驻插件 → AI 产出插件源码（index.ts + manifest），**由用户**跑 `build:plugins` + 刷新生效（人工过闸）；
  3. 已有插件的能力开关 → plugin-manager 面板启停（用户操作）。

---

## 三、建议实施顺序（供拍板）

| 步骤 | 内容 | 改动面 |
|---|---|---|
| 1 | 系统提示/技能面板里写清"AI 自建 Skill 的操作法"（纯文案） | agent-loop 系统提示附录 或 一份说明技能 |
| 2 | hook-bridge 加 workspace 级 hook 变更确认闸（指纹+kv，未确认不执行只审计） | hook-bridge/server.mjs |
| 3 | mcp-bridge 加 `mcp_server_add/remove` 工具（走审批+审计，写原生配置即实时生效） | mcp-bridge/index.ts |
| 4 | 面板文案同步（技能面板教自建、MCP 面板注明 AI 也可自建） | 两个 Panel.tsx |

P0/P1 的四类链路本身不用动——它们已经为"实时生效"做好了准备（每轮重发现 + 内容指纹重载）。
