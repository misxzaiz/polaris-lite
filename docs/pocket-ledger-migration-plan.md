# 日常记账迁移方案（pocket-ledger → polaris-lite，v1）

> 目标：把 Polaris-plugin 仓的 `pocket-ledger`（日常记账 v0.3.0）迁到 polaris-lite，**纯插件实现**——宿主 `src/` 零改动。
> 原件位置：`D:/space/base/Polaris-plugin/plugins/pocket-ledger`（core 435 行 + MCP 644 行 + 面板 ~1200 行 TSX）。
> 迁移可行性结论：**可行**。原件即「零进程无状态」样板：数据全在 kv、计算全在 `shared/ledger-core.js`（零依赖、面板与 AI 共用单一权威）。lite 侧缺的两样（cap.kv、MCP server）都有等价替代，见下。

## 1. 原插件盘点（保留什么、换什么）

| 原件组成 | 迁移处置 |
|---|---|
| `shared/ledger-core.js`（435 行纯计算：键空间/归一化/幂等追加/统计/预算/CSV/时段档位） | **原样 vendor**（CJS→保留，lite 插件 vite 可打包 CJS），只把 emoji ⚠️ 换成文字（lite 禁 emoji 字符） |
| `src/model.ts` 的 cap.kv IO（kvGet/kvSet/kvKeys） | **换成 cap.config**（lite 的 config-manager：namespace/key/value，localStorage 持久化） |
| `src/Panel.tsx` + 四 Tab（记账/明细/统计/设置） | **改写**：面板挂 lite 的 `panel` 槽（slots 契约），组件结构/交互保留 |
| `mcp/server.js`（stdio MCP，经 Polaris IPC 自发现） | **改为 lite 的 cap 工具**：`cap.tool.ledger`，走 agent-loop 的 describe 协议（与 agent-bash/file-browser 同构）——lite 无 MCP 体系，AI 能力经 tool cap 进 agent-loop |
| 附件（小票图片，ledger.att.*） | **v1 先不迁**（lite 无对应 UI 消费；键空间与 core 函数保留，后续可加） |
| ActivityBar/panelType/icon/labelKey | **换成 lite 的 SlotDescriptor**（panel 槽 + title「记账」） |
| 双端并发幂等、预算提醒、时段档位、CSV/JSON 导出 | **全部保留**（core 原样） |

## 2. 存储映射（cap.kv → cap.config）

原键空间 `ledger.day.<YYYY-MM-DD>` / `ledger.settings` → cap.config 单 namespace `pocket-ledger`：
- `key = 'day.<YYYY-MM-DD>'` → value = Bill[]（原 ledger.day.* 一一对应）
- `key = 'settings'` → value = LedgerSettings

kvKeys(list) 换成 config 的 `list` 动作（返回 namespaces/keys）——月度加载只依赖前缀枚举，等价。写入协议不变：读日键 → appendBills 按 id 去重 → 写回（幂等）。

## 3. AI 工具（MCP → cap.tool.ledger）

`cap.tool.ledger` 提供 describe + 六个动作（add/query/stats/delete/update/categories），参数与原 MCP 工具一一对应；agent-loop 自动发现（cap.meta/list → describe），AI 在对话里说「午饭 35」即可入账。`danger: 'write'`——confirm 模式下走既有审批卡。

## 4. 面板

四 Tab 保留：记账（QuickTab）/ 明细（ListTab）/ 统计（StatsTab）/ 设置（SettingsTab），顶部 Tab 切换；样式走 lite 主题 token（`--*`），插件级 CSS，不碰宿主命名空间。

## 5. 验收

- A1 core 单测：归一化/幂等追加/删除/统计/预算/CSV/时段档位（vendor 原测试移植）
- A2 工具 cap：describe 返回 6 工具描述；add→query→update→delete 全链路经总线
- A3 面板：记账/明细/统计/设置四 Tab 可用；AI 入账后面板即时可见（config-changed 事件）
- A4 `npm test` / `typecheck` / `check:plugins` / `build:plugins` 全绿
- A5 宿主 src/ diff 为零（纯插件）
