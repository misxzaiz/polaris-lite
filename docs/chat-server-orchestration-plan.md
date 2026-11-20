# AI 对话长期方案：服务端编排 + 多端实时（spec v0.1，2026-11-20）

> 目标：根治两个已确认的问题——①流式中的会话刷新即丢（在途消息 + 执行状态随页面死亡）；②多设备看不到执行中的实时情况。长期方向是**执行模型上服务端**（B1），页面退化为「发指令 + 订阅事件 + 渲染」。
> 前置分析：刷新丢消息的根因链与多端不可实时的根因链已核实（见 §1）；chat-store 服务端会话存储已落地（`docs/chat-multi-device-sync-plan.md`）。
> 原则：延续本仓「核心零业务、一切皆插件」；编排上服务端也走**插件 server 半边**（新增 agent-runner），不走 `server/` 宿主目录（`tests/server-boundary.test.mjs` 红线不破）。

---

## 1. 问题与根因（复核结论）

| # | 现象 | 根因链（代码位置实测） |
|---|---|---|
| ① | 流式中刷新页面，会话/在途消息丢失 | 1) `sync.ts pushDirty` 对流式会话 `continue`（刻意不推半截态）；2) `settle()`（chat-lite/index.ts:467）后经 800ms 防抖才 PUT——窗口内刷新丢最后一轮；3) **shadow transcript 与编排循环只在浏览器内存**（agent-loop/index.ts:75 `shadows` Map、:76 `running` Map），页面销毁=执行者死亡；4) IndexedDB/服务端都只有上个防抖窗口的旧版本 |
| ② | 其他设备看不到执行中的实时情况 | 1) 同步是 30s 轮询 + 进会话拉取（spec 明确不做推送）；2) `pull()` 对流式会话也跳过（`isStreaming → continue`）；3) 「执行中」状态（工具跑到哪、审批挂起）只存在于发起设备的浏览器闭包，服务端无任何表示 |

**共同根源**：执行模型在浏览器端。chat-store 只存「已收敛的会话快照」；谁发起谁执行，页面即生命周期。

## 2. 已有地基（本方案直接复用，不重复建设）

- **chat-store**：服务端会话权威 + 版本化整写 + 409 + 墓碑 + 索引轮询（已上线）。
- **SSE 先例两处**：`phone-agent`（`/api/phone/events` SSE 信令枢纽 + 指令下发/结果回传，含设备注册/心跳/超时）与 `codebuddy-engine`（`/api/codebuddy/stream` 服务端 spawn 子进程、SSE 推帧、树杀中断）——**「服务端长任务 + SSE 推事件 + 中断树杀」的模式在本仓已验证两次**。
- **工具执行已在服务端**：`cap.tool.bash`→`/api/tool/exec`（裁决/白名单/审计在 server.mjs）、`cap.tool.fs`→`/api/fs/*`、render/browser/files 同构。工具面天然可被服务端编排器调用。
- **模型调用已在服务端**：`/api/model-relay`（key 只在服务端）；agent-loop 的压缩摘要已走它（非流式）。
- **审批裁决一半在服务端**：tool-exec 的 mode（confirm/allowlist/yolo）裁决在 `agent-bash/server.mjs`；「confirm 需人点」目前由前端 agent-loop 挂起等待。

## 3. 长期架构（目标态）

```
设备 A（发起）        服务端（agent-runner 插件 server 半边）              设备 B（旁观）
┌──────────┐  ①start指令  ┌────────────────────────────┐                ┌──────────┐
│ chat-lite │ ───────────▶ │ POST /api/agent/start       │                │ chat-lite │
│ (发指令+  │              │  · 任务表: runId→{sessionId, │                │ (订阅+   │
│  渲染)    │  ②SSE事件流  │    shadow, phase, cursor}   │  ②SSE事件流     │  渲染)   │
│           │ ◀═══════════ │  · 循环: 调模型(relay)→工具   │ ══════════════▶│          │
│  审批点击 │  ③审批回传    │    (服务端直调各 tool server  │                │  审批点击 │
│ POST /api/agent/approve │    半边)→事件入缓冲          │                │ POST .../approve │
└──────────┘              │  · 事件持久化(会话档)        │                └──────────┘
                          └────────────────────────────┘
```

要点：

1. **编排器服务端化**：agent-loop 的循环/审批/shadow 逻辑迁为 `plugins/agent-runner/server.mjs`（Node 侧），直接调 `/api/model-relay` 同款 undici 流式请求（key 注入点已在服务端）与服务端工具端点（`/api/tool/exec` 等）。
2. **事件总线**：`GET /api/agent/events?sessionId=` SSE 长连接；所有 `message.delta/reasoning/tool.card/result/approval.required/done` 事件**先落持久化缓冲**（内存 ring + 会话档落盘），订阅者带 `Last-Event-Id` 续传。A、B 设备订阅同一流 → 天然实时一致。
3. **审批改服务端挂起**：`approval.required` 事件入流；任一设备 `POST /api/agent/approve {runId, callId, decision}` 回填（服务端 Promise 挂起，120s 超时拒绝沿用现语义）。页面刷新/换设备后审批卡仍在（从事件缓冲重放）。
4. **会话数据**：执行中每轮收敛（assistant 正文、工具卡结果）即写 chat-store（服务端内部直写，不走 HTTP）；流式 delta 事件同时入缓冲——B 端「实时」看事件流，重连后看会话档。
5. **断线/刷新语义**：发起设备刷新页面，任务**继续跑**（服务端持 shadow 与循环）；重连后按 Last-Event-Id 补发，UI 追平。中断 `POST /api/agent/interrupt {runId}`（树杀语义沿用 codebuddy-engine 先例）。
6. **前端退化**：chat-lite 的 sendUserMessage 改发 `start` 指令；cap.agent.loop:event 消费逻辑改为消费 SSE 事件（事件形状不变，降低改造面）；agent-loop 浏览器插件退役或仅保留兼容垫片。

## 4. 实施路线（四个可独立交付的里程碑）

| 期 | 内容 | 解决 | 量级 | 验收 |
|---|---|---|---|---|
| **M1 止血**（可立即做） | settle 立即 flush（去 800ms 窗口）；流式会话在 chat-store 落 `running` 标记（索引可见「执行中」）；beforeunload 提示 | ①的「正常结束流不丢」+ ②的「至少看到执行中状态」 | ~40 行 | 刷新后最后一轮完整；B 端侧栏有执行中标记 |
| **M2 增量上云** | 流式期间防抖推 delta（1~2s 节流，版本递增）；B 端渲染半截消息（复用 streaming 块） | ②的「看到正文在长」（30s→秒级延迟的正文） | ~120 行 | 双设备：A 流式中，B 页面文字持续增长 |
| **M3 事件通道** | `/api/agent/events` SSE + Last-Event-Id 续传 + 变更即推（复用 phone-agent 模式） | ②的实时化（秒级） | ~150 行 | B 端 delta 到达延迟 <1s |
| **M4 服务端编排（B1）** | agent-runner 插件：任务表/循环/shadow/审批挂起/事件缓冲/中断树杀；前端改指令+订阅 | ①根治（刷新/关页任务继续）+ ②彻底（事件即执行事件） | ~500 行 + 审批 UX 决策 | 发起端关浏览器，任务继续并在 B 端可见全过程；刷新后 UI 无缝追平 |

## 5. 关键决策点（需用户拍板后再动 M4）

1. **审批归属**：编排上服务端后，「谁点批准」= 任意在线设备均可（先到先得，事件流广播 + 已决即撤卡）。是否接受？
2. **无人值守审批**：所有设备都离线时，挂起审批 120s 超时拒绝（沿用现语义）还是等待？建议沿用超时拒绝。
3. **agent-loop 浏览器插件去留**：建议 M4 稳定后删除（保留一个版本期的兼容开关）。
4. **多任务并发**：单 owner 场景建议同会话串行（现状语义）、跨会话可并行；服务端并发上限先设 3。

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 服务端长任务内存/句柄泄漏 | 任务表带 TTL 与完成即回收；对齐 codebuddy-engine 的树杀+审计先例 |
| SSE 反代缓冲 | 沿用 relay-core 的 `X-Accel-Buffering: no` + 背压写法（已验证） |
| 半截消息被 B 端误当完整 | 事件带 `phase` 字段；chat-lite 渲染已有 streaming 块机制，重连对账以会话档为准 |
| 与手机「独立档」互斥 | standalone-mode 的 setOfflineMode 已挂在 sync 层；M3/M4 的事件订阅同样受该开关控制（离线档不建 SSE） |
| 并行会话改动冲突 | 本 spec 只新增 agent-runner 插件 + chat-lite 事件源切换；store/sync 既有机制不动 |

## 7. 与既有文档的关系

- `docs/chat-multi-device-sync-plan.md`（已落地）：会话数据面，本方案在其上叠加「执行面」。
- `docs/ai-events-plugin-plan.md` §8：最早论证 B1；本 spec 是其正式立项版。
- `docs/mobile-app-plan.md`：手机三档形态；M3/M4 让「连接档」手机获得与桌面完全一致的实时视图，独立档语义不变。
