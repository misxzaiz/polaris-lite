# MCP 链路优化升级方案（2026-11-24）

依据：22 轮真实 AI 对话 E2E（`tests/_mcp-e2e.mjs`，报告 `tests/_aichat/mcp-e2e-2026-11-24T06-14-20.json`）+ 代码审查。

## 现状（集成盘点）

| 环节 | 文件 | 状态 |
| --- | --- | --- |
| 服务端 client 池（stdio NDJSON JSON-RPC 2.0） | `plugins/mcp-bridge/server.mjs` | ✅ 真子进程验证可用 |
| 配置仓库 `<dataDir>/mcp-servers.json` | 同上 | ✅ CRUD/审计/门控齐全 |
| 聚合工具 describe/exec | `plugins/mcp-bridge/index.ts` | ✅ agent-loop A1 兼容 |
| AI 自建通道 mcp_server_add/remove/list | 同上 | ⚠️ **P0：参数被剥，见下** |
| agent-loop 发现/执行 | `plugins/agent-loop/index.ts` | ✅ 聚合数组兼容 |
| 外部配置发现导入 | `plugins/zcode-compat/server.mjs` | ✅ 5 源合并（stdio only） |
| CodeBuddy CLI 透传 | `plugins/codebuddy-engine/server.mjs` | ✅ 读原生配置 |
| 管理面板 | `plugins/mcp-bridge/Panel.tsx` | ✅ 状态/门控/增删 |
| E2E | `tests/_mcp-e2e.mjs`（新增） | ✅ 22 轮可复跑 |

E2E 结果：22/22 轮收敛；工具调用全部走通（add/now/echo × 多轮、双工具编排、中文/长句/符号/负数/浮点/大数）。**但暴露 3 个真实缺陷**：

## P0：mcp_server_add/remove 参数被 agent-loop safeArgs 剥掉

- 现象：AI 明明传了 `name=e2e-demo, args=[...]`，服务端收到的 name=undefined → 自动补名 `mcp-mwuaoggu`、args=[]，产生的"僵尸 server"无法启动（15s 超时刷屏审计日志），E2E 的 R1/R13/R18 连锁失败。
- 根因：`plugins/agent-loop/index.ts:1152` —— 载荷分派只对 `cap.tool.files-write` / `cap.tool.skill` / `cap.tool.mcp` 做参数透传，`cap.tool.mcp-ops` 落进兜底分支 `safeArgs()`，而 safeArgs 只保留 `command/timeoutMs` 两个字段，`name/args/env` 全被剥掉。
- 修复：给 `cap.tool.mcp-ops` 增加 `hookArgsOf` 透传分支（与 skill 同一透传器；describe 的 parameters 已约束形状，服务端仍有名字合法性/路径校验兜底）。
- 顺带：`mcp_server_add` 的成功回执要把**最终生效的 server 名与参数**回显给模型（自动补名时模型才知道真实名字）——服务端 POST 已返回 `{ok:true}`，扩展为 `{ok:true, name:<生效名>}`，插件回执带出。

## P1：MCP 工具表刷新依赖「下一轮」，同轮内不可见 + tools/list 永久缓存

- 现象链：`mcp_server_add` 成功 → 广播 tool-registered → agent-loop 重扫 describe。但 describe 拉 `/api/mcp/tools` 时，若该 server 的 client 已在池中且缓存过 `tools`（或启动慢），新工具不一定出现；E2E 中模型多次看到「未注册」。
- 改造：
  1. server 半边：`upsert`/`remove`/`gate` 时使对应 client 的 tools 缓存失效（upsert 直接 kill 旧 client 重建；gate 后 tools 端点即时反映）。
  2. `/api/mcp/tools` 增加 `?refresh=1`（强制重拉 tools/list）；describe 时对 30s 内已缓存的聚合结果直接用，add/remove 后的 describe 走 refresh。
  3. agent-loop：`tool-registered` 已即时重扫（保持）；补一条——discoverTools 失败/空结果时不清空旧表（避免把好工具误删，已有对账式替换，保留）。

## P2：僵尸 server 残骸与失败可观测性

- E2E 留下 2 个 `args:[]` 的死配置（`mcp-mwuaoggu/mcp-mwuaqq9k`），每次面板刷新/工具聚合都要吃 15s 启动超时。P0 修复后模型不会再造出这种残骸，但「启动失败的 server 长期躺在配置里拖慢每次聚合」是普遍问题。
- 改造：
  1. `/api/mcp/tools` 聚合时对启动失败的 server 记录失败次数，连续 3 次失败自动 `enabled=false`（审计记 `auto-disable`），面板可见、可手动重开。
  2. 面板 server 行显示 `toolError`（已有）+ 最近一次审计错误摘要，用户不用翻日志。

## P3：体验细节（低风险顺手改）

1. `mcp_server_add` 工具 description 补一句「args 必须包含 server 脚本的绝对路径，且文件必须已存在」——E2E 里模型第一次把 args 传成 `[]`，description 越明确重试越少。
2. `mcp_server_list` 回执带上每个 server 的工具名列表（现在只有 command/args），模型自省时不用再猜工具前缀。
3. Panel 表单 args 输入从「每行一个」升级为兼容 JSON 数组粘贴（`["a","b"]` 或每行一个都收）。

## 不做（本轮明确排除）

- http/sse 传输（zcode-compat 已跳过+warn，按原计划 P3 再接）。
- MCP resources/prompts 能力（当前只有 tools，聚合形态已覆盖主场景）。
- per-server 超时可配置化入口（配置里已有 timeoutMs 字段，面板暂不暴露）。

## 验证计划

1. 单测：`tests/mcp-bridge.test.mjs` 扩展——upsert 后 tools 缓存失效、连续失败自动禁用、add 回执带生效名。
2. E2E：`node tests/_mcp-e2e.mjs --rounds 22` 复跑，R1/R13/R18 应转绿，总轮次 ≥22。
3. 回归：`npm run typecheck && npm test && npm run build:plugins`。
