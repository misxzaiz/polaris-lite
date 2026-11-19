# AI 对话事件管理插件 · 复审与实施方案

> 状态：方案稿，未实施。
> 本文替代上一版（事件平台 + 5 期路线）。复审后结论有实质变化：**目标是"会话取证"，
> 不是"事件溯源"**；上一版有三处判断需要纠正，其中一处会让实施顺序整个走偏。

---

## 一、复审：五条需要修正的结论

先逐条对照代码，把上一版站不住的判断列出来。这决定了后面的方案形态。

| # | 上一版说法 | 复核结果 | 依据 |
|---|---|---|---|
| 1 | "P0 不动任何运行时代码，只新增插件目录" | **不成立**。chat-lite 全文件没有一次 `emit`，只 `listen`。用户输入（prompt）不在任何事件里 | `plugins/chat-lite/index.ts` manifest 只声明 `events`，无 `api.emit` |
| 2 | "工具输出未落盘，刷新即失真，只能截图" | **低估了**。`tool.result` 事件已带 `command` 全量、`stdout`/`stderr`、`exitCode`、`durationMs`、`truncated`；`tool.card` 带 `argsJson` 全量 | `plugins/agent-loop/index.ts` 工具执行段与中断段 |
| 3 | "B0（断开不 abort）能解决 90% 的后台需求" | **错误**。编排循环在前端：`engineTurn` → `for (call of toolCalls)` → 再 `engineTurn`。断开后没有任何进程推进下一轮，服务端不 abort 也只是把上一个响应读完而已 | `agent-loop` 主循环；`relay-core.mjs` 只是管道 |
| 4 | "多设备同账号可读，跨账号一律 404；事件带 userId" | **多余**。认证是单 owner：`auth-owner.json`，首登即注册且仅一次。"多设备"= 同一账号多个 sid，不存在第二账号 | `server/auth-session.mjs` 头部注释与登录段 |
| 5 | "插件没有合法的持久化通道，必须新建平台级事件服务" | **不完整**。插件确实不能**新增**路由，但可以**直接 fetch 同源 `/api/*`**——real-engine 用 `/api/model-relay`，agent-loop 用 `/api/tool/config`。项目里加服务端能力已有 4 个同构先例 | `relay-core` / `tool-exec` / `fs-api` / `providers-api` 都是 `createXxxMiddleware({dataDir, getSession})` |

另有两条认知需要补上：

- **cap 命名空间是可扩展的**：`cap.tool.fs` 是 file-browser 插件自己提供的（并行线正在用），
  说明"新能力由一个插件提供、其他插件消费"是本项目的既有做法，不是特例。
- **单 owner 意味着冲突模型简单**：多设备并发写同一会话的概率低，用版本号 + last-write-wins
  加一次提示即可，不需要 CRDT / OT。

---

## 二、方案定位修正

上一版把它定位成"事件管理平台"，于是必然要引入 `seq`、SSE、回放、投影、event-sourcing，
最后摊成 5 期、含 2 期宿主改造。这个形态对一个 5k 行、单机单用户的工作台是过重的。

**建议定位：会话取证（session forensics）。**

要回答的问题只有四个，其余都不做：

1. 这一轮模型收到了什么（prompt / tools / 参数）；
2. 它调了什么工具、看到什么输出、谁批准的；
3. 每跳花多久；
4. 出问题时能不能把这一段原样打包给别人。

明确不做：从事件重建应用状态、实时双向协作编辑、多租户、让插件变成第二个聊天客户端。

---

## 三、数据模型：TurnRecord，不是事件流

**一轮 = 一条记录**。一次 3 轮对话是 3 条，不是几百条事件。

```ts
interface TurnRecord {
  v: 1;
  sessionId: string;
  turnId: string;              // = assistant messageId，事件里已有，无需新增字段
  deviceId: string;            // 本机随机 id，用于标注"这段来自哪台设备"
  startedAt: number;
  endedAt: number;

  input?: { text: string; attachmentCount?: number };   // B 档才有

  model: {
    provider?: string;         // B 档
    modelName?: string;        // B 档
    steps: Array<{
      index: number;           // 第几跳（含工具往返后的续答）
      ms: number;
      finishReason: string;
      usage?: { prompt: number; completion: number };   // 供应商支持时才有
      textLen: number;
    }>;
  };

  tools: Array<{
    callId: string;
    name: string;
    args: unknown;             // tool.card.argsJson 全量
    approval?: { decision: 'once' | 'always' | 'trust' | 'deny'; waitedMs: number };
    exitCode?: number;
    ms?: number;
    stdout?: string;           // 8KB 上限（事件本身的截断点）
    stderr?: string;
    truncated?: boolean;
  }>;

  outcome: 'done' | 'aborted' | 'error';
  error?: { message: string };
}
```

三点设计理由：

- `turnId = messageId`：事件里已经带了，不需要给 agent-loop 加字段，落盘用的主键天然存在。
- `steps[]` 而不是 `turns[]`：工具往返会多次请求模型，但用户感知是"一轮"。这层嵌套能直接回答
  "这一轮模型往返了几次"。
- `tools[].args` 存结构而不是命令字符串：`bash` 是 `{command,timeoutMs}`，将来加 `files` 工具
  不需要改 schema。

---

## 四、能力分档（本文档的核心决策表）

同一个插件，四档能力，成本与收益差异极大。**建议按 A → B → C 推进，D 不做**。

| 档 | 能力 | 改动面 | 能回答什么 | 风险 |
|---|---|---|---|---|
| **A** | 工具链路取证 | **0 行现有代码**；新增 `plugins/ai-events/` + 2 处登记 | 调了什么、参数、输出、退出码、耗时、几轮、谁批准 | 无（只读旁听） |
| **B** | 补齐模型侧 | 3 个文件各 +5 行 emit | 收到什么 prompt、下发哪些 tools、往返几次、token | 低（只增加上报） |
| **C** | 多设备共享 | 1 个服务端中间件（~180 行）+ chat-lite 数据源（~120 行） | 手机能看到桌面的会话与取证记录 | 中（动了会话存储的权威源） |
| **D** | 后台运行 | 编排后移，400-600 行，重写执行模型 | 关浏览器任务继续 | 高（不是本插件职责） |

A 档就能覆盖你说的"工具调用全细节"——这块上一版估低了，因为 `tool.result` 里本来就有输出。
B 档补的是"为什么模型这么答"。C 档才是"多设备"。D 档是另一个课题。

---

## 五、A 档实施设计（P1，建议立即开工）

### 5.1 事件 → TurnRecord 映射

| 事件 | 用途 | 落到哪 |
|---|---|---|
| `tool.card` `{sessionId, messageId, callId, name, command, argsJson}` | 工具调用起点 | `tools[]` 新建项 |
| `tool.approval.required` `{callId, name, command}` | 开始等待审批 | 记 `approvalStartedAt`（内存） |
| `tool.approval.resolved` `{callId, decision}` | 审批结论 | `tools[].approval` |
| `tool.result` `{callId, status, command, stdout, stderr, exitCode, durationMs, truncated}` | 执行结果 | 合并进同 `callId` 项 |
| `message.delta` `{delta}` | 回答正文 | **只在内存累加长度，不落盘** |
| `message.done` `{finishReason, interrupted}` | 一轮结束 | 触发落库，`outcome` |
| `loop.done` `{turns}` | 编排收尾 | `model.steps.length` 兜底 |
| `stream.error` `{message}` | 失败 | `outcome='error'` + `error` |

**`message.delta` 绝不能落 IndexedDB**。一次 2000 字回答约 3000~6000 条 delta，逐条写库会拖垮
主线程。内存里只累加 `textLen`，`message.done` 时一次性写这条 TurnRecord。

### 5.2 旁听实现要点

```
setup(api):
  for (const ev of ['cap.agent.loop:event', 'cap.ai.chat:event']):
    api.listen(ev, ({source, payload}) => ingest(source, payload))

ingest 的状态机：
  内存 Map<turnKey, TurnRecord>       // turnKey = sessionId::messageId
  - 收到未知 turnKey 的 tool.card/message.delta → 新建（startedAt = now）
  - 收到 message.done → finalize：写 IndexedDB，删内存项
  - 兜底：每 60s 扫一遍超过 10 分钟未 finalize 的项，标记 outcome='aborted' 后落库
```

兜底扫描是必要的：用户刷新页面时不会有 `message.done`，不兜底就会留下一条孤儿记录。

**双订阅去重**：agent-loop 会转发 real-engine 的事件，两个通道可能都能收到 `message.done`。
以 `turnKey` 为主键 upsert，天然幂等。

### 5.3 存储

IndexedDB（不是 localStorage）：`localStorage` 全库 1.5MB 已被 chat-lite 占满，
且写入是同步阻塞的。

```
db: plite-ai-events  (version 1)
  store: turns    keyPath 'turnId'   index: 'bySession' [sessionId, startedAt]
  store: meta     keyPath 'k'        // deviceId、schemaVersion、保留策略
```

保留策略：单会话 500 条 turn 或 30 天，先删最旧。写时顺手清理，不建定时器。

### 5.4 视图

`ai-events.timeline`，挂在 `panel` 锚点，`order: 7`（2/3/6 已被模型/Bash/文件占用）。

```
┌ 会话（上/左）          ┬ 轮次时间线（主）              ┬ 详情（下/右）
│ 全部 · 按最近          │ ▸ 第 3 轮  14:22  ⏱ 8.4s    │ 选中：tool.result
│  会话标题 · 5 轮 · 2 错 │   ├ 工具 bash  exit 0  1.2s │  ├ 原名 / callId
│  会话标题 · 3 轮       │   │  └ 审批 once（1.8s）     │  ├ 参数（JSON，可折叠）
│ 筛选：错误 / 慢 / 有工具│   └ 收尾 stop  2 步         │  ├ 输出（8KB，注意截断标记）
└───────────────────────┴──────────────────────────────┴──────────────────┘
```

关键交互（每条对应一个验证场景）：

| 交互 | 回答什么 |
|---|---|
| 按轮折叠，默认展开最后一轮 | "这次答错是在哪一跳" |
| 工具行显示 `exit / 耗时 / 审批决定` | "为什么这条命令被执行了" |
| 详情里参数与输出并排 | "模型是不是把参数写错了" |
| 顶部筛选"只看错误" | 快速定位 |
| 「导出本轮」/「导出会话」 | 复现包：JSON，含参数与输出，不含 prompt（A 档本来也没有） |

不做：编辑、重跑、跨用户分享。

### 5.5 落地步骤（4 步，都可回滚）

1. `plugins/ai-events/`：`index.ts`（manifest + setup）+ `TimelinePanel.tsx` + `ai-events.css`
   + `vite.config.ts`（照抄 `plugins/agent-bash/vite.config.ts`）。
2. `plugins/build-plugins.mjs` 的 `plugins` 数组追加
   `{ id: 'ai-events', config: 'ai-events/vite.config.ts', dist: 'ai-events/dist', order: 12 }`
   —— 这个清单是硬编码的，不登记就不会构建。
3. `public/grants.json` 加：
   ```json
   "ai-events": { "capabilities": [], "provides": [], "events": ["cap.agent.loop:event", "cap.ai.chat:event"] }
   ```
   —— `listen` 是 fail-closed 的，漏登记会在运行期直接抛 `not granted event`。
4. `npm run build:plugins`；registry 由构建生成，不需要手写。

manifest 里 `requires: ['agent-loop']` 不是必须的（只是旁听），但建议加上，让装配顺序稳定在
编排器之后，避免启动瞬间漏掉第一批事件。

### 5.6 A 档已知缺口（必须写进 UI，不能假装没有）

| 缺口 | 影响 | 对策 |
|---|---|---|
| 没有用户输入原文 | 时间线只能显示"第 N 轮"，不能显示"用户问了什么" | 显示 `turnId` 尾号；用户可在导出包里手写一句 |
| 没有 provider / model | 不知道这段回答用的哪个模型 | 同会话内通常固定；跨模型对比要等 B 档 |
| 没有 token | 无法算成本 | B 档 |
| 输出 > 8KB 被截断 | 长日志看不到尾部 | 详情里明确标 `truncated`，并在文案里写"完整输出见 Bash 面板" |
| 只有本机 | 换设备就没了 | C 档 |

---

## 六、B 档：补齐模型侧（3 个文件，各 5 行）

只增加上报，不改任何分支逻辑。

| 文件 | 改动 | 为什么必须在这改 |
|---|---|---|
| `plugins/chat-lite/index.ts` | 发送时 `api.emit('chat-lite:turn', { sessionId, messageId, prompt, attachmentCount })`；manifest/grants 加该事件名 | chat-lite 是全项目唯一持有用户输入的地方，且它现在一次 emit 都没有 |
| `plugins/agent-loop/index.ts` | 每跳请求前 `emitTo(emit, 'model.request', {...})`：provider/model（从 `cap.model.admin` 读）、tools 名列表、`messages.length`、序列化字节数、systemPrompt 的 hash | 编排器才知道这一跳实际发了什么；`cap.ai.chat` 的 payload 在插件内部，外部旁听不到 |
| `plugins/real-engine/index.ts` | `message.done` 增加 `ms`（本跳耗时）与 `usage`（若上游给） | 引擎是唯一读到上游 SSE 的地方 |

**usage 的现实约束（这点必须提前说清）**：当前请求体没有
`stream_options: { include_usage: true }`，多数 OpenAI 兼容中转因此不会在流里返回 `usage`。
三条路：

1. 加该字段 —— 部分中转不支持会直接 400，属于**会打断对话**的改动，不建议默认开；
2. 按 `usage` 是否出现做条件解析 —— 零风险，但大多数时候没有；
3. 估算（字符数 ÷ 3.5，中日文另算）—— 只能看量级。

建议：**2 + 3 结合**，真实 `usage` 有就用，没有就标"估算"。把 1 做成供应商配置里的开关，
而不是全局默认。

---

## 七、C 档：多设备（要诚实标注成本结构）

### 7.1 端点（约 180 行，与 `tool-exec.mjs` 同构）

```
GET    /api/ai-sessions                 → [{id, title, updatedAt, msgCount, turnCount}]
GET    /api/ai-sessions/:id             → { session, version }
PUT    /api/ai-sessions/:id             → body { session, turns, baseVersion }；版本不符 409
DELETE /api/ai-sessions/:id
```

存储：`<dataDir>/ai-sessions/<sanitizedId>.json`，单文件 `{version, updatedAt, session, turns}`。
单会话体量在几十 KB 量级，整体读写足够；原子写用 `tmp + rename`（照 `tool-exec` 的 `writeConfig`）。

会话 id 必须过白名单正则（`^[A-Za-z0-9_-]{1,64}$`），否则就是路径穿越——
chat-lite 的 sessionId 由前端生成，不能信任。

### 7.2 冲突

单 owner、多设备、同一会话并发编辑的真实概率很低，不需要 OT/CRDT：

- 每次 PUT 带 `baseVersion`，服务端不匹配即 409，返回服务端当前 `version` 与 `updatedAt`；
- 前端提示"另一台设备有更新"，给「以服务端为准」/「覆盖服务端」两个选择；
- 不做自动合并——消息数组的合并语义（同一 turn 两端各改一半）没有正确答案。

### 7.3 真正的成本在 chat-lite，不在端点

端点只是存储。手机上要**看到对话正文**，chat-lite 的消息必须来自服务端。这需要：

- `store.ts` 增加远端数据源：启动时 `GET /api/ai-sessions` 拉索引，打开会话时拉详情；
- 写入改为双向：本地先写（保持离线可用），debounce 后 PUT；
- 冲突与离线降级：PUT 失败不阻塞对话，只标记"未同步"，恢复后重试；
- 迁移：首次上线时把 localStorage 里的会话批量 PUT 一次，带 `migratedAt` 标记防重。

约 120 行，且动了会话的权威源——**这应该单独立项，不要和插件塞在一期**。

### 7.4 为什么不先做 SSE

"订阅"的两种语义要分开：

- **打开就能看到最新**（95% 的场景）→ 轮询足够：进入会话拉一次，之后 30s 或切回标签页时拉一次；
- **两边同时看同一场对话的实时增量**（spectator）→ 才需要 SSE。

SSE 的成本不只是端点（~60 行，可照 `relay-core` 的写法），还有连接生命周期、断线重连、
`Last-Event-ID` 续传、每设备连接数上限。在"单机单用户"的场景下，这些复杂度换不来对应收益。

建议：C 档先只做轮询。真出现"要看实时"的需求，再加 SSE，且只推 `turn.finalized` 这种
低频事件，不推 delta。

---

## 八、后台运行：真实结论（这节是纠正上一版的重点）

### 8.1 B0 是伪解

断开不 abort，服务端把响应读完——然后呢？没有下一步了。因为：

```
前端 agent-loop:
  engineTurn() ──→ 收到 tool_calls
    for (call of toolCalls) { 审批 → 执行 → 写 shadow }
  engineTurn() ──→ 下一跳
```

`engineTurn` 的下一跳由前端代码发起。前端没了，循环就停在"工具执行完之后"。服务端既不知道
还有下一轮，也没有 shadow transcript 的完整状态（它只在浏览器内存里）。

**所以 B0 只对"无工具的直通模式"有效**——那种模式下 `cap.ai.chat` 一次请求就结束，
服务端读完写进日志，用户回来能看到完整回答。一旦用上工具，B0 无效。

### 8.2 真解只有 B1

要么把编排搬进服务端（`server/agent-runner.mjs`），要么不做。B1 的工作量：

| 部分 | 内容 | 量级 |
|---|---|---|
| 编排器 | `agent-loop` 的循环 / 审批 / shadow 搬到服务端 | ~200 行 |
| 运行态 | 任务表、并发上限、取消、超时、异常收敛 | ~120 行 |
| 事件出口 | 运行中事件按 session 缓冲，前端重连补发 | ~100 行 |
| 前端改造 | agent-loop 退化为"发指令 + 订阅"；审批 UI 改走服务端长轮询 | ~100 行 |

这已经不是"事件管理插件"的范畴，而是**执行模型改造**，且会连带影响审批语义（谁来点批准？
页面关了谁来批准？超时策略？）。建议单独立项。

### 8.3 当下能做的止血（20 行，可放 A 档之后）

- `beforeunload` 时若有在途流，给一次确认提示（浏览器原生弹窗）；
- `visibilitychange → hidden` 不主动 abort（当前也不会，除非页面卸载）；
- 移动端恢复时，若发现最后一条 assistant 消息 `streaming` 但无新事件，标记"已中断，可重试"。

这三条能消掉大部分"切后台回来发现断了、但不知道为什么"的困惑，成本几乎为零。

---

## 九、实施顺序与验收

| 期 | 内容 | 改动面 | 验收标准 |
|---|---|---|---|
| **P1** | A 档：插件骨架 + 旁听 + IndexedDB + 时间线 + 导出 | 新增 1 个插件目录 + 2 处登记 | 跑一轮"读文件 → 出错 → 修正"的 bash 对话，时间线还原 2 次工具调用、退出码、耗时、审批决定；刷新后记录仍在；导出 JSON 可读 |
| **P1.5** | B 档：3 处 emit | 3 个文件 × ~5 行 | 时间线显示 prompt 摘要、provider/model、每跳耗时；usage 有则显示、无则标"估算" |
| **P2** | 多设备：端点 + chat-lite 数据源 | 1 个中间件 + chat-lite ~120 行 | 桌面发起、手机打开看到同一会话与轮次记录；两端同时改同一会话时 409 有提示且不丢数据 |
| **P3** | 止血版后台 | ~20 行 | 有在途任务时关页面有提示；移动端恢复能识别"已中断" |
| **P4** | 真后台（可选，单独立项） | 400-600 行 | 关浏览器后任务继续，重开能看到完整结果 |

P1 的价值密度最高：零现有代码改动、零风险，且能立刻回答"工具到底干了什么"。
建议先做完 P1 再决定 P1.5/P2 的取舍。

---

## 十、与并行工作的交叠（实施前必读）

工作区当前有未提交改动：`plugins/agent-loop/index.ts`（system prompt 增加工作区提示与 files 工具）、
`plugins/chat-lite/index.ts`、`server/fs-api.mjs`，另有 `docs/chat-workspace-mgmt-analysis.md`
在规划会话绑定工作区（W1 也要改 agent-loop 的 system prompt 段与 chat-lite 的会话模型）。

因此：

- **P1 只新增 `plugins/ai-events/`，不碰这两个文件**，可以和 W1 并行开工，不会冲突；
- **P1.5 必须等 W1 落地**：两处改动都在 `agent-loop` 的 system prompt 附近与 `chat-lite` 的
  发送路径上，同一段代码两个人在改，rebase 成本高于收益；
- **P2 与 W1 有直接交叠**：W1 给会话加 `workspaceId`，P2 改会话的权威源。建议 W1 先落地，
  P2 在它之上做数据源替换，否则会话 schema 会改两遍。

---

## 十一、明确不做

| 项 | 理由 |
|---|---|
| 事件溯源 / 从事件重建会话 | 会让 chat-lite 的 store 重写投影逻辑；收益是"理论上可重建"，本项目不需要 |
| 逐 token 落盘 | 数量级膨胀，回放也没有验证价值 |
| 事件级编辑 | 日志可变就失去取证价值 |
| 重放执行 | 工具会真的产生副作用 |
| 跨用户共享 / 团队 | 单 owner 认证，没有信任模型（与"布局预设市场"被否的理由相同） |
| 通用事件管道 | 没有第二个消费者时就是过度抽象；等有第二个插件要写事件再抽 |

---

## 十二、待决策

1. **P1 是否开工**：0 行现有代码改动，一周内能看到时间线。我的建议是直接做。
2. **B 档的 usage 取舍**：接受"多数时候没有真实 token、显示估算"，还是打开
   `stream_options` 开关（有中断风险）？建议前者。
3. **C 档的会话权威源**：接受"localStorage 主、服务端为辅（同步副本）"，还是彻底反转
   （服务端主、本地为缓存）？前者改动小、离线可用，后者多设备一致性更干净。
   建议先做前者，出现"两台设备同时改"的实际问题再反转。
