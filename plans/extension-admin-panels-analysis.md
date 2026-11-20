# polaris-lite 扩展能力管理面板 + 使用问题修复 — 分析稿（仅分析，未实施）

> 状态：**分析稿（仅方案，未实施）** · 2026-11-20 · 仓库：polaris-lite
> 背景：能力插件（skill-loader / hook-bridge / mcp-bridge / zcode-compat）已落地，但用户反馈「1. 使用存在问题；2. 缺少 skill、mcp、hook 管理面板」。本稿先盘点使用问题，再给纯插件形态的管理面板方案。

---

## 一、「使用存在问题」盘点（按严重度排序）

### P0-残1 skill-loader 仍会加载失败（用户修复不完整）
- 用户 commit `98e6c96` 只改了 **grants.json**（skill-loader.events 补了 `tool-registered`，v7→v8），但 **manifest 源码 `plugins/skill-loader/index.ts:82` 仍是 `events: []`**。
- 宿主权限 = `manifest.events ∩ grants.events`（resolvePolicy 交集语义）→ 交集仍为空 → `emit('tool-registered')` 在 `hostRuntime.ts:144` 依旧被拒 → **skill-loader 依然装配失败**。已验证当前 bundle（20:12 构建）里仍是 `events: []`。
- 修法（二选一，推荐 A）：
  - **A**：`plugins/skill-loader/index.ts` manifest `events: []` → `['tool-registered']`（与 grants 对齐）；
  - **B**：删掉 `index.ts:88` 的 `api.emit('tool-registered', …)`——read_skill 的工具发现主路径是 agent-loop 的 `cap.meta/list → describe`，这个 emit 只是"迟到兜底"，对 skill-loader 并非必要。
  - 注意选 A 后必须重新 `npm run build:plugins`（bundle 里 manifest 是构建期快照）。

### P0-残2 hooks 导入断链（导入了但不生效）
- zcode-compat 的 import 会把 CC/ZC hooks 归一写入 `<dataDir>/hooks-import.json`，**但 hook-bridge 的 `loadRules()` sources 列表里没有这个文件**——导入的 hooks 永远不生效（形态兼容，只差接一行 sources）。
- 修法：`plugins/hook-bridge/server.mjs` 的 `sources` 数组追加 `['import:hooks-import.json', join(dataDir,'hooks-import.json'), 'workspace']` 一项（其结构已是 `{events:{...}}` 同构形态）。

### P1-残3 agent-loop 事件重复声明（小瑕疵）
- `plugins/agent-loop/index.ts` setup 里 `onSessionStart` 分支出现两次（`req.action === 'onSessionStart'` 重复判断，第二次为 dead code）——无功能影响，但应清理。
- 另 chat-lite `/name` 改写：落库的 user 消息与 `user.prompt` 事件是**原文**，只有发给引擎的 prompt 被改写——这是设计选择（保留用户原话），但面板/取证视角要知道这个差异。

### P1-残4 能力不可发现（「使用存在问题」的主因）
- 四个能力插件**都没有任何面板入口**（contributes.slots 全空），用户只能靠猜端点/看文档使用：
  - MCP servers 无法查看/增删/门控（`/api/mcp/*` 只能裸调）；
  - 已导入的 skills 无法查看（更无法重扫）；
  - hooks 规则无法查看、无法确认生效状态与 warns；
  - zcode-compat 的 scan/import 无 UI，用户不知道"我的 CC/ZC 资产能不能导进来、导进来什么"。
- 这正是本次要补的三个管理面板（见下）。

---

## 二、管理面板方案（纯插件，3 个面板 + 0 处 core 改动）

### 2.0 宿主事实（已勘察确认，面板方案的地基）
- panel 槽：`slots:[{slot:'panel', component:'XxxPanel', order:21+, title:'≤4字'}]`；多面板 tab 条宿主已自带溢出收纳（＋n 菜单+搜索+置顶），再挂 3 个无压力；order 15-19 空闲、20 已占，新面板取 21/22/23。
- 面板写法范本：**plugin-manager/Panel.tsx**（列表+启停开关+两页签）、**model-admin/Panel.tsx**（表单+列表+两段式删除确认）——都是宿主 React 函数组件 + useState + fetch（同源 cookie），无状态库。
- 样式：`import './panel.css'` 打进 dist/style.css，宿主按 registry.style 注入；CSS 门禁要求插件前缀类名（如 `mc-`/`pm-`），只消费宿主令牌变量，禁 `:root/position:fixed` 等。
- 权限纪律：新 cap 或新事件必须 manifest 申请 ⊆ grants 授权（build-plugins 强校验）。

### 2.1 面板一：MCP 管理台（建议挂 mcp-bridge 插件内，order 21，title「MCP」）
- **数据面**：直接复用现有端点——`GET /api/mcp/servers`（含每 server 的 tools/status/source）、`POST /api/mcp/servers|servers/remove|gate`。前端经已注册的 `cap.mcp.admin` 走（现有 list/gate 两个 action 不够，需补 `add/remove` 两个 action 的透传，或面板直接 fetch——**推荐补 action**，保持"面板只走 cap 总线"的一致性，也享受审计）。
- **UI 功能**：
  1. server 列表：名称、command、状态徽标（connected/error/disabled）、来源（native/project:.mcp.json/…）、工具数；
  2. 工具明细（展开行）：`mcp__server__tool` 全名 + description + 门控开关（`cap.mcp.admin#gate`）；
  3. 增删改表单：name/command/args（每行一个）/env（可选）/enabled，编辑走 `POST /api/mcp/servers`，删除走 `/servers/remove`（两段式确认，学 model-admin）；
  4. 错误展示：server `toolError` 直接显示（启动失败原因一目了然）。
- **安全呈现**：面板上明示"新增 server = 允许 AI 调用外部进程"，删除/禁用即收回。

### 2.2 面板二：技能库（挂 skill-loader 插件内，order 22，title「技能」）
- **数据面**：`GET /api/skills/list`（现有，含 name/description/whenToUse/source）、`POST /api/skills/reload`（现有）。**缺口**：缺"查看单个技能全文"的 UI 通道——可直接 fetch `/api/skills/read?name=`（现有端点）。
- **UI 功能**：
  1. 技能列表：名称、来源徽标（native/workspace/claude/zcode/agents/compat-*）、描述、when_to_use；
  2. 详情抽屉/展开：显示 SKILL.md 全文（`/api/skills/read`，pre-wrap 渲染即可，不必上 markdown 渲染器）；
  3. 「重新扫描」按钮（`POST /api/skills/reload`）+ 上次扫描结果为空的空态提示（教用户把 SKILL.md 放进 `.polaris-lite/skills` 或 `.claude/skills`）；
  4. 使用说明块：`/name args` 斜杠用法一行示例（联动 chat-lite 已实现的斜杠识别）。
- 不做：技能的新建/编辑（文件即真相，引导用户放目录，避免面板里做文件写入面）。

### 2.3 面板三：钩子台（挂 hook-bridge 插件内，order 23，title「钩子」）
- **数据面**：现有 `GET /api/hooks/list` 返回 `{rules:[{event,matcher,scope,source,type,command,timeoutMs}],warns}`——**已够只读展示**；先做只读版。
- **UI 功能**：
  1. 规则列表：事件、matcher、来源（user/workspace + 文件）、handler 类型（command/process）、命令摘要、超时；
  2. warns 区：不支持事件/解析失败等一次性警告展示（用户能看懂"为什么我的 PreCompact 没生效"）；
  3. 信任状态区：workspace 级来源是否已确认（kv 指纹）——P1 面板先展示，确认交互 P2 再做；
  4. 空态：教用户在 `.claude/settings.json` 或 `.zcode/config.json` 里写 hooks，或经 zcode-compat 导入。
- **可选增强（P2）**：`/api/compat/scan|import` 的导入入口做成这个面板里的「从 Claude/ZCode 导入」按钮（scan 结果预览 + import 执行 + warns 展示）——把 zcode-compat 的能力也暴露出来，一石二鸟。

### 2.4 实施清单（未来开工用，本期不做）
| 项 | 文件 | 改动 |
|---|---|---|
| 修 skill-loader | `plugins/skill-loader/index.ts` | events 补 `tool-registered`（或删 emit）→ 重新 build:plugins |
| 修 hooks 断链 | `plugins/hook-bridge/server.mjs` | sources 追加 hooks-import.json |
| 清理重复分支 | `plugins/agent-loop/index.ts` | onSessionStart 判重 |
| MCP 面板 | `plugins/mcp-bridge/index.ts`（slots+admin action 扩展）+ `Panel.tsx` + `panel.css` | order 21 |
| 技能面板 | `plugins/skill-loader/index.ts`（slots）+ `Panel.tsx` + `panel.css` | order 22 |
| 钩子面板 | `plugins/hook-bridge/index.ts`（slots）+ `Panel.tsx` + `panel.css` | order 23 |
| grants | 无需改（面板用本插件自注册的 admin cap，已登记；若面板直接 fetch 则连 cap 都不用加） | — |
| 门禁 | typecheck / check:plugins / npm test / build:plugins | 全绿为准 |

> 面板组件放同一插件内（不新建独立插件）的理由：能力与管理面同源同生命周期，禁用 mcp-bridge 时面板自然消失，符合"插件=能力+其管理面"的内聚；也避免 grants/registry 再膨胀 3 个条目。
