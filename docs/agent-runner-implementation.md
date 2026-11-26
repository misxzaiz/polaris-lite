# 服务端编排循环（agent-runner）实施记录

> 2026-11-25 实施。spec：docs/chat-server-orchestration-plan.md（B1 服务端编排）。
> 本文记录实际落地的架构、端点契约、验证结果与已知边界。

## 1. 已落地内容

### 1.1 服务端：plugins/agent-runner/server.mjs（新）

AI 编排循环的服务端执行器。前端页面退化为「发指令 + 订阅事件 + 渲染」，
循环/shadow/审批挂起/事件流全部在服务端进程内（异步任务，不 spawn 子进程）。

- **runs 表**（内存）：runId → { sessionId, shadow, phase, seq, subs, approvals,
  interactives, controller, model, execCwd, boundRootId… }；同会话单飞
  （重复 start 返回既有 run）；并发上限 MAX_CONCURRENT_RUNS=3；finish 时双表回收。
- **事件先落盘再扇出**：每个事件 append 到 `<dataDir>/agent-runs/<runId>.events.jsonl`
  （上限 32MB/run），再 SSE 扇出给订阅者。订阅端带 `lastEventId` 从日志续传——
  刷新页面/换设备/服务端重启（日志在磁盘）都能完整重放。
- **模型调用**：直连 provider store（key 不出服务端）+ undici 流式，超时 30min、
  断流 prefill 续写（对齐 real-engine 的重试/续写语义）。
- **工具调用**：loopback HTTP 直连各工具 server 半边（/api/tool/exec、/api/fs/*、
  /api/files-write/exec、/api/preview/render、/api/browser/dispatch、/api/skills/read、
  /api/mcp/*）。鉴权用自签系统 Bearer（owner=注册人，写入宿主 tempTokens Map，
  verifyTempToken 原样校验）；工具侧 denylist/mode/审计裁决全部原样生效。
- **审批服务端挂起**：`tool.approval.required` 事件入流；任意在线设备
  `POST /api/agent/approve` 先到先得；120s 无决策自动拒绝（对齐旧语义）。
- **交互卡**：`interactive.required` 事件 + `POST /api/agent/interactive` 回填。
- **中断**：`POST /api/agent/interrupt` → AbortController 杀上游流 + 挂起审批按
  deny 收敛 + message.done{interrupted}。

### 1.2 端点契约

| 端点 | 方法 | 说明 |
|---|---|---|
| /api/agent/start | POST | {sessionId,messageId,prompt,history,providerId?,modelId?} → {ok,runId,existing} |
| /api/agent/events | GET(SSE) | ?runId=&lastEventId= → event:agent（seq/kind/payload/at）+ ping + run-ended |
| /api/agent/state | GET | ?sessionId= → {running,runId,phase,seq,assistantId}（刷新对账/探活） |
| /api/agent/approve | POST | {runId,callId,decision} 先到先得 |
| /api/agent/interactive | POST | {runId,callId,answer} |
| /api/agent/interrupt | POST | {runId} |

事件 kind 与 cap.agent.loop:event 完全一致（loop.start/message.delta/
message.reasoning/tool.card/tool.result/tool.approval.required|resolved/
interactive.required|resolved/stream.retry/message.continued/message.truncated/
context.snapshot/loop.done/message.done/stream.error）。

### 1.3 前端：plugins/chat-lite/runnerBridge.ts（新）+ index.ts 接线

- `startRunnerRun()`：probeRunner（/api/agent/state 探活，localStorage
  `plite.runner=off` 可强制关闭）→ POST start → 订阅 SSE。失败自动回落旧
  cap.agent.loop 通道（standalone 独立档/旧服务端兼容）。
- `setRunnerConsumer()`：SSE 事件以同一 StreamEnvelope 形状喂给 chat-lite 既有
  handleEnvelope——渲染层（工具卡/审批卡/思考块/截断块）零改动。
- `resolveRunnerApproval` / `interruptRunnerRun`：审批与中断优先走服务端。
- `restoreRunnerRuns()`：页面加载 3s 后对服务端 running 表对账，执行中的会话
  重建订阅（Last-Event-Id 从 0 重放）——**刷新页面后 UI 无缝追平**。
- StreamEnvelope 类型上移 runnerTypes.ts 共用。

### 1.4 登记

- plugins/server-registry.mjs：+agent-runner。
- agent-runner 是纯服务端插件（无前端半边），不进 build-plugins 清单/registry.json。

## 2. 验证结果

- **单测**：npm test 355/355 全绿（含 server-boundary/arch 红线）。
- **工具面**：bash/files/files_write/render/browser/read_skill/mcp loopback 全通。
- **刷新持久性 E2E**（tests/_aichat/run-refresh-persistence.mjs）：
  长任务（分析项目写 analysis-report.md）进行中 `location.reload()`：
  - 刷新前事件 1 条（loop.start），刷新后继续产出 478 条
    （reasoning 338 / tool 54 / delta 82 / loop.done 1）——**任务在服务端继续执行**；
  - 刷新后 134s 收敛（loop.done + 服务端 running=false）；
  - 产物 analysis-report.md 落盘工作区（13.5KB）。
  - 结论：**刷新页面不再杀任务**。

## 3. 已知边界 / 后续（M4 候选）

> 2026-11-26 后端编排化收口后本节多数条目已解决：上下文压缩已迁服务端
> （UsageAccumulator/compactShadow 在 runner + 引擎适配器 complete）；
> 事件重放改原生 Last-Event-Id 头 + 内存 buffer + 行首 seq 前缀轻解析；
> 前端 agent-loop 已整块删除（runnerBridge 唯一编排通道 + 引擎直连兜底，
> 不兼容旧数据）；工具注册化（server/adapter-registry.mjs + 适配器声明式
> descriptor/invoke，含 suggestions/transcript/phone/market_*）；无依赖工具
> 并行执行（freePass 类 Promise.all）；CodeBuddy 接入服务端 runner（agent 型
> 引擎适配器，断联续跑对全部 supportsTools 引擎成立）。

- 上下文压缩（context-compact）尚未迁移到服务端（长会话仍在服务端 shadow 里
  无压缩水位管理）；下一里程碑把 UsageAccumulator/compactShadow 移入 runner。
- 事件重放目前从 seq=0 全量（首屏重放完整任务过程）；可按需加「只重放结构块、
  delta 拼接」的紧凑重放。
- 前端 agent-loop 浏览器插件保留作为回落（standalone 独立档必需）；稳定后可
  评估仅保留直通引擎路径。
- 多设备审批「先到先得」已生效，UI 上未做「他端已决」的撤卡提示（卡片靠
  approval.resolved 事件收敛，行为正确）。
- 会话档双写仍未收敛：chat-lite 仍有防抖 PUT（store sync），服务端 runner
  也直写会话档；权威单一化（删前端 PUT、增量 patch 端点）是下一候选。
