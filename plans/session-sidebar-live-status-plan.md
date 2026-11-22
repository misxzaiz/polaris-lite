# 会话侧栏改进方案：刷新 / 执行中状态 / 实时查看 / 排序修复

> 状态：**已实施完成**（2026-11-20）。范围：chat-lite（侧栏/同步）、chat-store（服务端）、agent-loop（运行态上报）。
> 用户决策已定：① 排序=最新有对话的放最上；② 执行态=服务端运行态（全设备可见）；③ 查看=全真 SSE 推流。
>
> 实施结果（全部落地并验证）：
> - Fix-A：`applyServerSnapshot` 不再 touch，保留服务端权威 `lastActiveAt`（修「最新会话沉底」颠倒 bug；store.ts）；
> - Fix-B：侧栏刷新按钮（`refreshNow()` → `pullNow()` 立即对账；SessionSidebar + RefreshIcon + CSS）；
> - Fix-C：服务端运行态——`POST /api/chat/sessions/:id/loop-state`（start/heartbeat/done，20s 心跳 GC），
>   索引返回 `running` 表；agent-loop 进入编排即上报 + 8s 心跳 + finally done；侧栏「执行中」徽标（stale 置灰）；
> - Fix-D：`POST /api/chat/sessions/:id/live-event` 批量镜像 + `GET /api/chat/sessions/:id/events` SSE 扇出；
>   agent-loop `emitTo` 处镜像流式语义事件（250ms 聚合/64 条上限）；chat-lite `liveOverlay.ts`
>   overlay 渲染（streaming 消息天然不落盘）+ 60s 看门狗 + done 后拉取收敛；
> - 验证：typecheck ✅；全量 275/275 ✅；build:plugins 29 个插件 ✅；5000 真实链路 E2E
>   （登录 → loop start → 索引 running → SSE 订阅 → live-event 扇出帧到达 → done 回收 → 无 cookie 401）全通 ✅。
> - 注意：插件 bundle 必须保持单文件（勿在插件内用动态 import 拆 chunk，会触发构建门禁「找不到 id 字面量」）。

## 一、问题分析（现状结论）

### P1 不能刷新
侧栏没有手动刷新入口；多端同步靠 30s 轮询 + 回前台触发（[sync.ts](../plugins/chat-lite/sync.ts)）。
在别的设备发了消息，本端最长 30s 盲区。

### P2 看不到「正在执行中」（含其他设备发起的）
- agent-loop 的运行态 `running` Map（[agent-loop/index.ts:76](../plugins/agent-loop/index.ts)）**只存在于发起端的浏览器内存**，无事件广播、无服务端对应物；
- 关掉发起端标签页 loop 即死，其他设备既不知道「谁在跑」，也不知道「已经死了」；
- `streaming` 标志只在发起端内存有效，手机上完全无感知。
- 「其他设置执行的插件」：目前能启动 loop 的入口只有 chat-lite 的发送动作；一旦服务端有运行态登记，**任何端、任何入口**发起的 loop 都自然被登记，无需逐插件适配。

### P3 点进去看不到实时情况
- 同一标签页内是内存直渲染，确实实时；
- 跨设备：轮询刻意跳过流式中的会话（sync.ts `isStreaming` 分支），查看端只能看到任务开始前的旧快照，任务跑完才能拉到结果。

### P4 顺序问题（根因是个 bug）
排序唯一权威 `sortSessions` 按 `lastActiveAt` 倒序（[store.ts:131](../plugins/chat-lite/store.ts)），设计本身符合「最新有对话的放最上」。
但 **`applyServerSnapshot`（store.ts:208）在合并服务端快照时调用 `touch()`**，把 `lastActiveAt` 改写成本地 `Date.now()`——
- 每次轮询都会把「刚被拉取的会话」的活跃时间改成本地时钟，多端时钟不一致 → 列表顺序在各设备间漂移；
- 未活跃的老会话被拉一次就「刷新」到最新位置附近，顺序看起来随机跳动。
正确语义：`lastActiveAt` 只应反映**真实对话内容变更**，服务端快照里已持久化了权威 `lastActiveAt`，合并时应保留入参值而不是 touch。

## 二、方案设计

### Fix-A 排序修复（小改，先行）
1. `applyServerSnapshot` 不再 `touch()`，改为保留 `incoming.lastActiveAt ?? incoming.createdAt`（服务端为权威，多端一致）；
2. 审计其余 `touch()` 调用点：本地内容变更（appendMessage/updateMessage/块追加/审批过期/标题/工作区）保留 touch；`setActive` 现状本就不 touch（无需改）；
3. 补测试：模拟「拉取旧快照后列表顺序不变」「本地新消息后跳到最前」。

### Fix-B 侧栏手动刷新（小改）
- 侧栏头部 `chat-sessions-head-right` 加刷新图标按钮 → 调 `pullNow()`（已有导出）；
- 刷新中给按钮转圈/禁用态（`syncStatus==='syncing'` 可复用）。

### Fix-C 服务端 loop 运行态（核心新增）
服务端新增**内存态**运行登记（放 chat-store/server.mjs——会话数据面同源，chat-lite 已直连该组 API；agent-loop 上报同样走同源 fetch，模式与 real-engine 中继一致）：

- `POST /api/chat/sessions/:id/loop-state`
  body `{ event: 'start'|'heartbeat'|'done', device?, phase? }`
  - `start`：登记 `{ startedAt, device, phase, lastBeat }`；
  - `heartbeat`：续期；
  - `done`：移除。
- `GET /api/chat/sessions`（既有索引）响应中追加 `running: { [sessionId]: { startedAt, device, phase, lastBeat } }`。
- GC：`lastBeat` 超过 20s 视为死 loop，索引里不再返回（发起端崩了/标签页关了，其他端最多 20s 后看到状态消失，无需显式 done）。

**agent-loop 前端上报**（发起端）：
- loop 进入主循环即 POST `start`；执行期间每 5s `heartbeat`（复用现有事件泵，不新增定时器则挂在 turn 循环上）；`loop.done`/interrupt/异常 finally 里 POST `done`；
- 上报 fire-and-forget（`.catch(() => undefined)`），standalone 离线档静默失败——离线时本来也只有本机在看；
- `device` 取 UA 简化名（复用 phone-agent 的判别逻辑：手机/浏览器）。

**侧栏展示**：索引里的 `running` 映射到会话行，显示脉冲圆点 + 「执行中」徽标（title 显示发起设备与已执行时长）；正在执行的会话行自然按 `lastActiveAt` 沉底也不用担心——发起端每次消息/块变更都会 touch，本身就在最上。

### Fix-D 全真 SSE 推流（跨设备实时查看）
**事件镜像（发起端 → 服务端）**：
- agent-loop 在 `emitTo` 处挂转发器：把 `message.delta / message.reasoning / tool.card / tool.result / message.done / loop.done / stream.error` 事件按会话缓冲 ~300ms 批量 `POST /api/chat/sessions/:id/live-event`（批处理避免逐 token 打爆服务端）；
- 只镜像，不改变本地事件流；直通模式（无工具）不镜像（该模式无 loop 语义，保持现状）。

**服务端扇出**：
- `GET /api/chat/sessions/:id/events`：SSE 订阅端点（cookie 门禁）；按 session 维护订阅者集合，收到 live-event POST 后原样扇出；15s ping 保活，无订阅者时零成本。

**查看端渲染（overlay 设计——关键复用）**：
- 点进一个「执行中」的远端会话时：先 `pullSession` 拉最新落盘全文，再订阅 SSE；
- 首个 live 事件到达时在本地创建一条 `streaming: true` 的临时 assistant 消息（overlay），按块渲染 delta/工具卡；
- **复用现有同步守卫**：overlay 消息带 `streaming: true` → `pushDirty` 天然跳过该会话不推送、轮询 `pull` 天然跳过不覆盖（sync.ts 既有 `isStreaming` 分支），overlay 不会被误同步；
- 收到 `loop.done` / `stream.error`：丢弃 overlay → `pullNow()` 拉最终落盘版（发起端 settle 后照常推送）；
- 看门狗：SSE 静默超过 60s（服务端 running 里该会话也消失）→ 丢弃 overlay、拉一次全文兜底，防止「发起端暴毙后查看端永远挂着半截消息」；
- overlay 不写 `versions`/`dirty`，纯粹内存渲染。

### 实施顺序（每步可独立验证）
1. **Fix-A 排序修复**（~半天）：store.ts 两处改动 + 测试；
2. **Fix-B 刷新按钮**（~半天）：SessionSidebar + 图标；
3. **Fix-C 运行态登记**（~1 天）：chat-store/server.mjs 端点 + agent-loop 上报 + 侧栏徽标 + 测试；
4. **Fix-D SSE 推流**（~2 天）：镜像转发 + SSE 端点 + overlay 渲染 + 看门狗 + 测试（两标签页模拟双设备：A 发起、B 实时看）。

### 验证口径
- `npm run typecheck && npm test && npm run build:plugins`；
- 开发环境 5000 双开（普通窗口 + 隐身窗口当「第二设备」）：
  - A 端跑长任务 → B 端侧栏 10s 内出现「执行中」徽标 → 点进实时看到 delta 与工具卡 → 任务完成后 overlay 收敛为最终全文；
  - A 端中途关标签页 → B 端 ~20s 后徽标消失、overlay 兜底收敛；
  - B 端不动的情况下，A 端只「查看」旧会话不改变列表顺序；
  - 手动刷新按钮立即对齐最新列表。

### 边界与不做的事
- 不改 `sortSessions` 的口径（最新对话在上已是需求），只修污染源；
- 不给直通模式（无工具注册时的裸引擎流）做镜像——该模式本身是降级路径；
- 运行态不落盘（重启后全部清零是合理语义：宿主重启 = 所有 loop 已死）；
- standalone 独立档：上报与订阅都静默失败，本地体验不变。
