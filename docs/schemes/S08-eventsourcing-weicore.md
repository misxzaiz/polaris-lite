# S8 事件溯源微核：日志即真相

> 矩阵第 8 格：**核心 = 事件日志（append-only）+ 投影引擎，UI 全是投影插件；对话 = 会话事件流的投影插件；插件机制 = 投影订阅制；前端栈 = React 原栈。**
>
> 思想来源：Polaris session-v2 的「日志即真相、前端只是缓存」对账（Reconcile）模型，以及主链路里既有的 `chat-event` 事件流。S8 把这两点从「会话域的内部实现」上升为**整个应用的唯一状态来源**：核心只负责把事件不可变地追加进日志并按订阅推送，其余一切（对话 UI、业务面板、会话列表、设置页）都是消费事件流算出来的投影（Projection）。

---

## 1. 方案定位与一句话主张

- **一句话**：核心不存任何「业务状态」，只存「事实」——每个事实是一条不可变事件；插件声明自己关心哪些事件流，核心把事件推给它，插件用纯函数 `apply` 把事件折叠成 UI 状态；UI 永远不直接写状态，只能通过 cap 总线发起命令，命令执行成功后作为新事件回到日志。
- **与 Polaris 的关系**：不是给 Polaris 打补丁，而是在 `polaris-lite` 独立成仓；但**刻意沿用 Polaris 已验证的拓扑**（后端 EventBroadcaster → `chat-event` → 前端 kernel 对账），因此迁移路径短、思想上有出处。
- **解决的问题**：Polaris 现状里 `conversationStore`（11,383 行）+ `appCoreBridge`（向插件泄漏 21 个 store / 30 个命令）+ `storage_exec`（4,964 行）三者互相纠缠。S8 用「一条日志 + 一套投影契约」同时替代这三者：存储即日志、状态即投影、插件间共享即订阅。

### 与矩阵其他格的边界（不偏移声明）

| 维度 | S8 的选择 | 明确不做 |
|---|---|---|
| 核心形态 | 事件日志 + 投影引擎（微核） | 不做全量 Polaris 壳复制（S1/S7），不做槽位容器（S3），不做微前端（S5） |
| AI 对话 UI | 会话事件流的投影插件 | 对话 UI 不是核心内置组件，也不是模板（S9） |
| 插件机制 | 投影订阅制（manifest 声明订阅流） | 不沿用 Polaris plugin-system 原样（S1），不用 module federation / customElements |
| 前端栈 | React 原栈（React 18 + Vite + useSyncExternalStore） | 不换框架、不搞框架无关（S6） |

---

## 2. 架构图（文字图）

```
┌─────────────────────────────────────────────────────────────────────────┐
│  polaris-lite 核心（唯一权威：事件日志）                                     │
│                                                                           │
│  ┌───────────────┐   append(唯一写入路径)   ┌──────────────────────────┐  │
│  │  cap 总线      │ ───────────────────────▶ │  EventLog（append-only） │  │
│  │  权限 gate +   │ ◀─────────────────────── │  JSONL 分段文件/流        │  │
│  │  审计(入日志)  │   read/tail(只读游标)     │  session:*  cap:dispatch │  │
│  └───────▲───────┘                          │  plugin:*   system      │  │
│          │ dispatch(cap,action,args)         └────────────┬─────────────┘  │
│          │                                                │ tail(全局游标)  │
│  ┌───────┴───────┐                          ┌────────────▼─────────────┐  │
│  │ Capability 实现│                          │  ProjectionEngine        │  │
│  │ ai.chat/fs/kv │                          │  匹配订阅 → 推送 →        │  │
│  │ (AI 引擎在这里)│                          │  周期性落 checkpoint      │  │
│  └───────────────┘                          └────────────┬─────────────┘  │
└──────────────────────────────────────────────────────────┼───────────────┘
                                             事件推送 / checkpoint 读写
┌──────────────────────────────────────────────────────────▼───────────────┐
│  前端微核（React 原栈）                                                     │
│                                                                           │
│   ProjectionKernel(前端) ── useProjectionState(id) ──▶ React 渲染树        │
│        │  register(projection)                                             │
│        ▼                                                                   │
│   ┌──────────────────────────── Layout 壳（核心，四区固定）─────────────┐  │
│   │ ActivityBar │ LeftPanel(席位) │ CenterStage │ RightPanel(对话主区) │  │
│   └─────────────┴────────┬────────┴────────────┴──────────┬──────────┘  │
│                          │ views 贡献                      │ mainSurface │
│   ┌──────────────────────▼─────────────┐   ┌──────────────▼───────────┐ │
│   │ files-desk-projection (业务插件)    │   │ chat-projection (对话插件)│ │
│   │  订阅: fs:*  cap:dispatch           │   │  订阅: session:*          │ │
│   │  apply → 文件树/标签页状态           │   │  apply → 会话列表+消息流   │ │
│   └────────────────────────────────────┘   │  ┌─会话侧栏─────────────┐ │ │
│                                             │  ├─消息流(投影渲染)─────┐ │ │
│                                             │  ├─输入区→dispatch──────┐ │ │
│                                             │  └─面板区(工具卡片投影)─┐ │ │
│                                             └──────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────┘

数据流向（单向，唯一）：
  用户交互 → 插件组件调 ctx.dispatch() → cap 总线 gate/审计
    → Capability 执行（如 AI 引擎产流式 token）
    → 执行结果作为事件 append 进 EventLog（含 cap:dispatch 审计事件）
    → ProjectionEngine 按订阅推给各投影 → apply() 折叠 → React 重渲染
  状态永远从日志推出来；UI 从不直接 set 状态。
```

关键点：

1. **EventLog 是唯一权威**：所有跨进程可见的状态变化都必须表现为一条事件；`cap:dispatch` 流记录每次 dispatch 的请求/成功/拒绝，天然就是审计链（满足硬性约束 4「dispatch 也入事件日志」）。
2. **投影是纯函数**：`apply(state, event) → state'`，无副作用、可重放、可测试。
3. **checkpoint 让重放有界**：投影定期把 `{游标, 快照}` 落盘，重启后从 checkpoint 起点续放，不必全量回放日志。
4. **单写者模型**：插件不能直接 append 事件，只能 dispatch；EventLog 的写入方只有 cap 总线一条路径（对应 Polaris「唯一写入路径」治理原则）。

---

## 3. 核心目录树（白名单）

```
polaris-lite/
├── package.json                     # React 18 + Vite + TypeScript（前端原栈）
├── src-tauri/                       # Rust 极简宿主（可 web-only 构建）
│   └── src/
│       ├── main.rs / lib.rs         # 启动装配（目标 < 400 行）
│       ├── eventlog/                # ★ 事件日志（核心中的核心）
│       │   ├── mod.rs               #   EventLog trait + 全局序号分配
│       │   ├── segment.rs           #   JSONL 分段文件（追加写 + fsync 策略）
│       │   ├── index.rs             #   流名→分段偏移 的内存索引（启动扫描一次）
│       │   └── tail.rs              #   tail 订阅器（watch channel 扇出）
│       ├── bus/                     # ★ cap 总线（裁剪版 RouterBus）
│       │   ├── mod.rs               #   dispatch：权限 gate → 审计(写日志) → invoke
│       │   ├── permission.rs        #   静态权限表（manifest permissions → cap 白名单）
│       │   └── capability.rs        #   Capability trait（sync + streaming 两种）
│       ├── caps/                    # 内置 capability（全部薄转发，无业务）
│       │   ├── ai_chat.rs           #   cap.ai.chat：start/continue/interrupt → AI 引擎
│       │   ├── fs.rs                #   cap.fs：读文件/列目录（供投影类插件）
│       │   ├── kv.rs                #   cap.kv：小配置 KV
│       │   └── plugin_admin.rs      #   cap.plugin.admin：安装/启停
│       ├── engine/                  # AI 引擎调度接口（只有接口 + 一个内置引擎）
│       │   ├── mod.rs               #   EngineRegistry：register/list/route
│       │   └── builtin_engine.rs    #   直连一家供应商的流式对话（Claude 兼容协议）
│       ├── plugins/                 # 插件生命周期
│       │   ├── discovery.rs         #   扫描 <dataRoot>/plugins/*/plugin.json
│       │   ├── manifest.rs          #   manifest 校验（含 projections 声明）
│       │   └── loader.rs            #   前端插件 JS 的磁盘定位与版本管理
│       ├── store/                   # checkpoint 落盘 + 全局配置
│       │   ├── checkpoint.rs        #   投影 checkpoint 的原子读写
│       │   └── config.rs            #   configStore（非事件状态：主题/语言等首选项）
│       ├── web/                     # HTTP/SSE 桥（web 模式）或 Tauri IPC（桌面模式）
│       └── util/                    # logger / error / data_root
├── src/                             # 前端微核 + 壳
│   ├── kernel/                      # ★ 前端投影引擎
│   │   ├── eventSource.ts           #   连接后端 tail（SSE / Tauri listen），断线重连+补拉
│   │   ├── projectionHost.ts        #   投影注册表、订阅匹配、批量 apply、checkpoint 触发
│   │   ├── checkpointClient.ts      #   checkpoint 读写（走 cap.kv / 专用端点）
│   │   └── react.ts                 #   useProjectionState（useSyncExternalStore 封装）
│   ├── shell/                       # 布局壳（Polaris 现状四段式的外层）
│   │   ├── App.tsx                  #   Layout：ActivityBar/LeftPanel/CenterStage/RightPanel
│   │   ├── PluginPanelHost.tsx      #   席位 → 加载插件面板组件
│   │   └── MainSurfaceHost.tsx      #   mainSurface 声明仲裁（同 Polaris getMainSurfaceClaim）
│   ├── transport/                   # invoke/listen 封装（Tauri 与 HTTP 双实现）
│   ├── pluginRuntime/               # 插件前端运行时：ctx 注入、模块加载、订阅代理
│   ├── theme/  i18n/                # 主题 token + i18n（自 Polaris 复制裁剪）
│   └── types/                       # PolarisEvent、manifest、cap 契约的 TS 定义
└── plugins/                         # 随仓示例插件（业务全在这里）
    ├── chat-projection/             # ★ AI 对话插件（订阅 session:*）
    ├── history-desk-projection/     # 会话历史抽屉（订阅 session:*，投影只读）
    ├── files-desk-projection/       # 文件面板（订阅 fs 事件 + 自己的命令）
    ├── settings-desk-projection/    # 设置页（订阅 config 变更事件）
    └── notification-projection/     # 通知浮层（订阅 cap:dispatch.denied 等）
```

**业务黑名单**（核心目录中不得出现，违反即架构违规）：会话/消息的业务规则、消息渲染组件、工具卡 UI、git/浏览器/终端/翻译等领域逻辑、供应商路由策略、存储的表结构设计（存储=日志本身，不再有 session_db/turn_persist/dialog_index）。

---

## 4. 核心契约（TS 签名级）

### 4.1 事件 schema

```ts
/** 全局事件信封：日志里每条记录的形状 */
export interface PolarisEvent<TType extends string = string, TPayload = unknown> {
  /** 流内单调递增序号，从 1 开始；由 EventLog.append 分配，调用方不可指定 */
  readonly seq: number;
  /** 事件流 ID，见 StreamId */
  readonly stream: StreamId;
  /** 事件类型，约定 `<域>.<对象>.<过去式动词>`，如 'chat.message.appended' */
  readonly type: TType;
  readonly payload: TPayload;
  /** Unix 毫秒，EventLog.append 落笔时统一打点 */
  readonly ts: number;
  /** 谁引发的：核心 / 某插件 / 某 AI 引擎 */
  readonly actor: EventActor;
  /** 因果引用：指向触发本事件的上一条事件（通常是 cap.dispatch.requested），用于链路追踪 */
  readonly cause?: EventRef;
  /** 事件 schema 版本，用于演进（见 §11.1） */
  readonly schemaVersion: number;
}

export type StreamId =
  | `session:${string}`      // 每个会话一条流，如 session:20261118-abc
  | 'sessions'               // 会话名录流（创建/重命名/归档等目录级事实）
  | 'cap:dispatch'           // 全部 dispatch 审计事件（硬性约束：dispatch 入日志）
  | `plugin:${string}`       // 插件生命周期流
  | 'system';                // 启动/迁移/回收等系统事实

export type EventActor =
  | { readonly kind: 'core' }
  | { readonly kind: 'plugin'; readonly id: string }
  | { readonly kind: 'engine'; readonly id: string };

export interface EventRef {
  readonly stream: StreamId;
  readonly seq: number;
}
```

### 4.2 事件类型定义（首版枚举，新增走 review）

```ts
// ---- sessions 流：会话名录 ----
export type SessionCatalogEvent =
  | { type: 'session.created';    payload: { sessionId: string; title: string } }
  | { type: 'session.renamed';    payload: { sessionId: string; title: string } }
  | { type: 'session.archived';   payload: { sessionId: string } }
  | { type: 'session.pinned';     payload: { sessionId: string; pinned: boolean } };

// ---- session:{id} 流：单个会话内的事实 ----
export type ChatEvent =
  | { type: 'chat.message.appended'; payload: { messageId: string; role: 'user' | 'assistant' | 'system'; text: string; attachments: AttachmentRef[] } }
  | { type: 'chat.generation.started';   payload: { messageId: string; engine: string; model?: string } }
  | { type: 'chat.generation.delta';     payload: { messageId: string; index: number; delta: string } }   // 流式增量
  | { type: 'chat.toolcall.requested';   payload: { messageId: string; toolCallId: string; tool: string; argsJson: string } }
  | { type: 'chat.toolcall.finished';    payload: { toolCallId: string; ok: boolean; resultPreview: string } }
  | { type: 'chat.generation.finished';  payload: { messageId: string; stopReason: 'end' | 'interrupted' | 'error'; usage?: TokenUsage } }
  | { type: 'chat.compacted';            payload: { summary: string; evictedUpToMessageId: string } };

// ---- cap:dispatch 流：总线审计（每笔 dispatch 一条 requested + 一条终态） ----
export type CapDispatchEvent =
  | { type: 'cap.dispatch.requested'; payload: { dispatchId: string; cap: string; action: string; argsSummary: string; pluginId?: string } }
  | { type: 'cap.dispatch.ok';        payload: { dispatchId: string; durationMs: number; producedStreams: StreamId[] } }
  | { type: 'cap.dispatch.denied';    payload: { dispatchId: string; reason: 'no-permission' | 'unknown-cap' | 'disabled' } }
  | { type: 'cap.dispatch.failed';    payload: { dispatchId: string; error: string } };

// ---- plugin:{id} 流与 system 流 ----
export type PluginLifecycleEvent =
  | { type: 'plugin.installed';  payload: { pluginId: string; version: string } }
  | { type: 'plugin.enabled';    payload: { pluginId: string } }
  | { type: 'plugin.disabled';   payload: { pluginId: string } }
  | { type: 'system.started';    payload: { coreVersion: string; logSchemaVersion: number } };

export type PolarisEventUnion =
  | SessionCatalogEvent | ChatEvent | CapDispatchEvent | PluginLifecycleEvent;
```

### 4.3 EventLog（后端权威，前端只读镜像）

```ts
export interface NewEvent {
  readonly stream: StreamId;
  readonly type: string;
  readonly payload: unknown;
  readonly actor: EventActor;
  readonly cause?: EventRef;
}

export interface EventLog {
  /** 唯一写入入口。仅 cap 总线可调用；分配 seq、打 ts、落盘、通知 tail 订阅者 */
  append(events: readonly NewEvent[]): Promise<readonly PolarisEvent[]>;
  /** 回放一段：从 fromSeq（含）到当前末尾；用于启动补齐 */
  read(stream: StreamId, opts?: { fromSeq?: number; limit?: number }): AsyncIterable<PolarisEvent>;
  /** 当前各流末端游标，用于对账 */
  headCursors(): Promise<Record<StreamId, number>>;
  /** 持续订阅：从 fromGlobalSeq 起推送新事件（SSE / Tauri event 的后端源头） */
  tail(fromGlobalSeq?: number): AsyncIterable<PolarisEvent>;
}

// Rust 侧对应 trait（签名对齐）：
// trait EventLog: Send + Sync {
//   fn append(&self, events: Vec<NewEvent>) -> Result<Vec<PolarisEvent>>;
//   fn read(&self, stream: &StreamId, from_seq: u64, limit: usize) -> BoxStream<Result<PolarisEvent>>;
//   fn tail(&self, from_global_seq: u64) -> BroadcastStream<PolarisEvent>;
// }
```

### 4.4 投影与订阅接口（插件机制本体）

```ts
/** 投影声明：写在 plugin.json 的 contributes.projections，或代码内注册 */
export interface ProjectionDeclaration {
  /** 全局唯一，如 'chat.sessionView' */
  readonly id: string;
  /** 订阅哪些流；支持通配 'session:*'。核心按前缀匹配推送 */
  readonly streams: readonly (StreamId | `${string}:*`)[];
  /** 起点策略：checkpoint(默认)=从上次游标续放；now=只看新事件；beginning=全量回放 */
  readonly from?: 'checkpoint' | 'now' | 'beginning';
  /** 每消费多少事件落一次 checkpoint；0=不落（小投影可全量重放） */
  readonly snapshotEvery?: number;
  /** 投影自身状态结构版本：变更后旧 checkpoint 作废、全量重放 */
  readonly stateVersion: number;
}

/** 投影实现：纯函数折叠器 */
export interface Projection<S = unknown> {
  readonly declaration: ProjectionDeclaration;
  initialState(): S;
  /** 唯一的状态变更入口；必须纯函数（同输入同输出，不改外部） */
  apply(state: S, event: PolarisEvent): S;
  /** 可选：把大状态压缩为小快照（如消息流只留最近 N 条 + 计数） */
  snapshot?(state: S): unknown;
  /** 与 snapshot 配对的恢复 */
  restore?(snapshot: unknown): S;
}

/** 前端投影宿主（ProjectionKernel 对插件暴露的面） */
export interface ProjectionHost {
  register<S>(projection: Projection<S>): Disposable;
  getState<S>(projectionId: string): S | undefined;
  /** 订阅某投影状态变化（供 useSyncExternalStore 用） */
  subscribeState(projectionId: string, onChange: () => void): () => void;
}

/** React 绑定：组件里唯一允许读投影状态的方式 */
export function useProjectionState<S>(projectionId: string): S;
```

### 4.5 checkpoint 机制

```ts
export interface ProjectionCheckpoint {
  readonly projectionId: string;
  /** 投影状态结构版本（来自 declaration.stateVersion）；不匹配即作废 */
  readonly stateVersion: number;
  /** 每条订阅流消费到的 seq：{ "session:20261118-abc": 412, "sessions": 37 } */
  readonly cursors: Readonly<Record<string, number>>;
  /** 状态快照（可 JSON 序列化；大投影应实现 snapshot/restore 压缩） */
  readonly snapshot: unknown;
  readonly updatedAt: number;
}

export interface CheckpointStore {           // 后端实现：store/checkpoint.rs；前端经专用端点访问
  load(projectionId: string): Promise<ProjectionCheckpoint | null>;
  save(checkpoint: ProjectionCheckpoint): Promise<void>;  // 原子写：tmp 文件 + rename
  clear(projectionId: string): Promise<void>;
}
```

**恢复算法**（projectionHost 启动时对每个已注册投影执行）：

1. `cp = await checkpoints.load(id)`；若 `cp && cp.stateVersion === declaration.stateVersion` 则 `state = restore?.(cp.snapshot) ?? cp.snapshot`，否则 `state = initialState()` 且各流游标清零。
2. 对每个订阅流：`head = await log.headCursors()`；若 `cursor < head` 则 `for await (const e of log.read(stream, { fromSeq: cursor + 1 })) state = apply(state, e)`。
3. 追上后进入 tail 模式：新事件到达 → `state = apply(state, e)` → 批量通知 React → 计数达 `snapshotEvery` 则异步 `checkpoints.save({...})`（落盘失败仅告警，游标以内存为准，不阻塞事件流）。

### 4.6 cap 总线契约（保留并收窄）

```ts
export interface DispatchRequest {
  readonly cap: string;            // 'cap.ai.chat' | 'cap.fs' | 'cap.kv' | ...
  readonly action: string;         // 如 'start' | 'read' | 'set'
  readonly args?: unknown;
  readonly stream?: StreamId;      // 流式 cap（如 ai.chat 的 token 流）的目标流
}

export interface DispatchResult {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: { code: 'no-permission' | 'unknown-cap' | 'handler-error'; message: string };
}

export interface Bus {
  /** 每次调用都会：权限裁决 → 先写 cap.dispatch.requested → 执行 → 写终态事件 */
  dispatch(req: DispatchRequest, actor: EventActor): Promise<DispatchResult>;
  register(capability: Capability): void;
}

export interface Capability {
  readonly id: string;                          // 'cap.ai.chat'
  readonly actions: readonly string[];
  handle(req: DispatchRequest, ctx: CapabilityContext): Promise<unknown>;
  stream?(req: DispatchRequest, ctx: CapabilityContext): AsyncIterable<unknown>; // 可选流式
}
```

插件侧统一入口（注入给每个插件面板的 `ctx`）：

```ts
export interface PluginContext {
  readonly pluginId: string;
  /** 发起命令：唯一影响世界的方式。成功与否都会以事件形式可见 */
  dispatch(cap: string, action: string, args?: unknown): Promise<DispatchResult>;
  /** 注册本插件的投影（也可仅靠 manifest 声明 + 约定导出） */
  registerProjection<S>(projection: Projection<S>): void;
  /** 读取日志（只读），用于投影未覆盖的一次性查询 */
  readStream(stream: StreamId, fromSeq?: number): AsyncIterable<PolarisEvent>;
}
```

manifest 新增贡献点（裁剪自 Polaris `contributes`，仅保留 S8 需要的键）：

```jsonc
// plugins/chat-projection/plugin.json（节选）
{
  "id": "chat-projection",
  "version": "0.1.0",
  "contributes": {
    "views": [
      { "id": "chat.main", "area": "mainSurface", "panelType": "ChatProjectionPanel", "order": 0 }
    ],
    "projections": [
      { "id": "chat.sessionCatalog", "streams": ["sessions"], "stateVersion": 1, "snapshotEvery": 200 },
      { "id": "chat.sessionView",    "streams": ["session:*"], "stateVersion": 1, "snapshotEvery": 500 }
    ],
    "capabilities": [
      { "id": "cap.ai.chat", "summary": "发起/继续/中断 AI 会话", "handler": "builtin" }
    ]
  },
  "permissions": { "chatEvents": "full", "caps": ["cap.ai.chat", "cap.kv"] }
}
```

---

## 5. AI 对话投影插件挂载（chat-projection）

**职责**：把 `session:*` 事件流折叠成 Polaris 现状四段式对话 UI。它不是「消息列表组件」，而是一个订阅机器：

```
session:{id} 事件流 ──▶ chat.sessionView 投影 ──▶ useProjectionState('chat.sessionView')
sessions 目录流    ──▶ chat.sessionCatalog 投影 ──▶ 侧栏会话列表
```

**四段式映射**（布局与 Polaris 现状逐段对齐，满足 P2/约束 1）：

| Polaris 现状段落 | chat-projection 内的实现 | 状态来源 | 写入方式 |
|---|---|---|---|
| 会话侧栏 | SessionSidebar：渲染 sessionCatalog 投影；点击切换 activeSessionId | `chat.sessionCatalog` 投影 + 本地 UI 态 | 新建会话 → `dispatch('cap.ai.chat','createSession')` → `session.created` 事件 |
| 消息流 | MessageStream：把 sessionView 投影里的 messages 渲染成气泡；delta 事件驱动流式打字 | `chat.sessionView` 投影 | 只读；无直接写 |
| 输入区 | ChatInput：文本框 + 附件 + 停止按钮；发送即 dispatch | 本地表单态（不入日志） | `dispatch('cap.ai.chat','start',{sessionId,text})` |
| 面板区 | ToolCallPanels：订阅 `chat.toolcall.*` 事件渲染工具卡片 | 同一 sessionView 投影的 toolCalls 切片 | 只读 |

**投影器核心代码形态**（插件内，示意但可直接照抄开工）：

```ts
// plugins/chat-projection/src/projections/sessionView.ts
export const sessionView: Projection<SessionViewState> = {
  declaration: { id: 'chat.sessionView', streams: ['session:*'], stateVersion: 1, snapshotEvery: 500 },
  initialState: () => ({ sessions: {}, activeId: null }),
  apply(state, ev) {
    if (!ev.stream.startsWith('session:')) return state;
    const sessionId = ev.stream.slice('session:'.length);
    const s = state.sessions[sessionId] ?? { messages: [], toolCalls: {}, status: 'idle' };
    switch (ev.type) {
      case 'chat.message.appended':
        return withSession(state, sessionId, { ...s, messages: [...s.messages, toMessage(ev.payload)] });
      case 'chat.generation.delta': {
        const { messageId, delta } = ev.payload;
        return withSession(state, sessionId, appendDelta(s, messageId, delta));
      }
      case 'chat.generation.finished':
        return withSession(state, sessionId, markFinished(s, ev.payload));
      case 'chat.toolcall.requested':
      case 'chat.toolcall.finished':
        return withSession(state, sessionId, upsertToolCall(s, ev.payload));
      default:
        return state; // 未知事件必须原样返回 state，不得抛错（向前兼容）
      }
  },
  snapshot: (s) => ({ ...s, /* 可只保留每会话最近 100 条 + 摘要计数 */ }),
};
```

**挂载方式**：`mainSurface` 席位仲裁与 Polaris 相同——核心壳 `MainSurfaceHost` 取 `views` 中 `area === 'mainSurface'` 的第一个启用贡献；chat-projection 的 `ChatProjectionPanel` 命中后在 RightPanel 渲染。插件 JS 由核心 `pluginRuntime` 以 Blob URL 动态 import（沿用 Polaris pluginModuleLoader 思路），加载后获得 `PluginContext`，注册投影与 React 组件。

**AI 引擎侧**：`cap.ai.chat` 的 Capability 实现位于核心 `caps/ai_chat.rs`，内部只做「参数校验 → 调 EngineRegistry → 把引擎回调翻译成 ChatEvent 追加进 `session:{id}` 流」。引擎（如 builtin_engine.rs 直连 Claude 兼容协议）通过 `ChatCallbacks` 产 delta；**引擎不认识 UI，也不认识 store，只产事件**。interrupt 走 `dispatch('cap.ai.chat','interrupt')`，capability 置中断位，引擎下一拍产出 `chat.generation.finished{stopReason:'interrupted'}`——保持 Polaris 已知的中断幂等教训（中断必须由 capability 归一裁决，插件不得直接杀流）。

---

## 6. 插件清单（首版随仓插件）

| 插件 | 订阅流 | 提供的 views | 说明 |
|---|---|---|---|
| **chat-projection** | `session:*`, `sessions` | mainSurface：对话四段式 | 对话域全部业务：会话列表、消息渲染、输入、工具卡、多会话网格 |
| history-desk-projection | `session:*`（只读） | overlay：`session-history` | 会话历史抽屉；只读投影 + 回放游标跳转 |
| files-desk-projection | `cap:dispatch`(fs 相关) | LeftPanel 席位：文件树 | 通过 `cap.fs` 命令 + dispatch 事件对账本地文件树 |
| settings-desk-projection | `plugin:*`, `system` | settings 席位 | 插件启停、主题/语言设置（写 config 走 cap.kv） |
| notification-projection | `cap:dispatch` | notificationOverlay | 把 denied/failed 事件渲染为 Toast |
| model-desk-projection | `cap:dispatch`(ai 相关) | LeftPanel 席位：模型/用量 | 用量统计来自 cap.dispatch 事件的聚合投影（示例性） |

**不进首版**（与 Polaris 现状对齐，属后续插件仓扩展）：git、浏览器、终端、翻译、IM 桥、needs 等领域插件。

---

## 7. 启动流程

```
1. 后端启动：解析数据根（沿用 POLARIS_DATA_ROOT > anchor > 默认 的既有约定）
2. 打开 EventLog：扫描分段文件建索引；写 system.started 事件（含 logSchemaVersion）
3. 装配 cap 总线：注册内置 capability（ai.chat/fs/kv/plugin.admin）；装载插件 manifests
   → 按 permissions 生成静态权限表；manifest 里声明的 capabilities 由核心代注册
4. 暴露 tail 端点（Tauri event 或 HTTP SSE），等待前端连接
5. 前端 main.tsx：
   a. theme bootstrap（同步注入 CSS 变量防 FOUC，同 Polaris）
   b. 建立 transport（Tauri invoke/listen 或 HTTP+SSE），连 tail(fromGlobalSeq=启动水位)
   c. 创建 ProjectionKernel：注册核心内置投影（shell 状态、plugin 目录投影）
   d. discover plugins → 按 manifest 加载插件 JS → 各插件 ctx.registerProjection(...)
   e. 对每个投影执行 §4.5 恢复算法（load checkpoint → 补放 → 追 tail）
   f. React 渲染 Layout 壳 → MainSurfaceHost/PluginPanelHost 挂载各插件面板
6. 就绪：用户在输入区打字 → dispatch(cap.ai.chat,'start') → 事件回流 → 消息流滚动
```

对账（Reconcile）兜底：前端 kernel 每分钟用 `headCursors()` 对一次账，发现某投影游标落后（断线漏事件）即从断点补放；连续 3 次对不齐则作废该投影 checkpoint 全量重放。日志是真相，前端只是缓存——缓存坏了就重算，不猜。

---

## 8. 与 Polaris 的复用 / 差异清单

### 直接复制（改包名/裁剪后可用）

| 来源（Polaris） | 取什么 | 改动 |
|---|---|---|
| `.claude/worktrees/browser-desk-extraction/src/session-v2/core/*`（v2-session-event-log、in-memory-log、reconcile，~1,022 行） | 事件流命名、对账思路、游标模型 | 重命名 + 移除 Polaris 特有依赖，作为 kernel 参考实现 |
| `src/types/aiEvent.ts`（1,303 行） | 事件类型命名与字段风格 | 裁剪到 §4.2 的 ~15 个事件；schemaVersion 字段对齐 |
| `src/services/dialogStorage`（JSONL 追加写） | JSONL 落盘与原子写手法 | 移除对话特有 schema，泛化为任意流 |
| `src-tauri/src/services/router/mod.rs`（1,786 行） | dispatch 流程骨架（gate→audit→invoke）、streaming 通道 | 裁掉 override 链/dynamic cap/描述自省，目标 <500 行 |
| `src-tauri/src/web/event_broadcaster.rs` | tail 广播模型 | 改为按流过滤的 SSE |
| `src/plugin-system/schema.ts` + `registry.ts` | manifest 校验、views 声明、mainSurface 仲裁 | 删 uiSlots/chatCards/editor 等贡献点，新增 `projections` 键 |
| `src/services/themeEngine.ts`/`themeMerger.ts`、`src/i18n/` | 主题 token 与 i18n 机制 | 原样复制裁剪 |
| chat-desk 的消息气泡/输入框渲染组件（选摘） | 气泡、markdown 渲染、自动滚动 | 改为从投影状态读数据（去掉对 conversationStore 的依赖） |

### 重写

- **EventLog 后端**（segment/index/tail）：Polaris 没有通用事件日志（只有对话域 event log 与 audit 链），需新写，但可借力 dialogStorage 与 audit_sink 的落盘代码。
- **ProjectionKernel / projectionHost / checkpointClient**（前端，估 ~1,200 行）：新写；session-v2 kernel 是参考不是依赖。
- **checkpoint 存储**（Rust，~300 行）：新写，原子 tmp+rename。
- **cap 总线裁剪版**：以 router/mod.rs 为底重写瘦身。

### 放弃（不迁移）

- `appCoreBridge` 的 21 个 store / 30 命令白名单共享——插件只拿 `PluginContext`（dispatch + 投影注册 + 只读日志），不再共享宿主 Zustand 实例。
- `stores/conversationStore`（11,383 行）、`storage_exec`（4,964 行：session_db/turn_persist/dialog_index）——被「事件日志 + 投影 checkpoint」整体替代。
- `commands/` 旧命令路径（36 个 `#[tauri::command]` 大部分退役）——只留 dispatch 一个 IPC 入口（+SSE tail）。
- ai_chat_core(3,042 行) 的 plan_mode/attachments/profile_options 复杂编排、proxy(5,039 行)、ask_listener、nexus_pipeline、form、computer_control——首版不做或远期以插件实现。
- `chatCardRegistry`/`uiTemplateRegistry`/`editorExtensionRegistry`/`uiSlots` 等扩展点——投影订阅制下暂无必要。

---

## 9. 裁剪量化表

| 指标 | Polaris 现状（baseline §6） | S8 目标 | 削减 |
|---|---|---|---|
| Rust 代码 | 250 文件 / 101,032 行 | eventlog+bus+caps+engine+plugins+store+web ≈ 4,500–6,000 行 | **≈ 94%** |
| 前端代码（核心仓，不含插件） | 279 文件 / 49,794 行 | kernel+shell+transport+pluginRuntime+theme/i18n+types ≈ 3,000–4,000 行 | **≈ 92%** |
| AI 对话 UI | 主 Chat 树 26,904 行 或 chat-desk 23,763 行 | chat-projection 插件 ≈ 6,000–8,000 行（复用气泡/输入渲染） | ≈ 70% |
| 会话存储 | storage_exec 4,964 行 + conversationStore 11,383 行 | EventLog(JSONL) ~800 行 + checkpoint ~300 行 + 前端 kernel 投影 | **≈ 92%** |
| Zustand store | 27 个非测试 store 模块 | 0 个业务 store（仅 shell 少量 UI 态；领域状态全在投影） | ≈ 95% |
| IPC/命令面 | 36 个 command + 30 命令白名单 + 34 个 capability | 1 个 dispatch 入口 + 1 个 tail 订阅 + ~6 个内置 cap | ≈ 90% |
| appCoreBridge 泄漏面 | 21 store + ~30 service | PluginContext（3 个方法） | ≈ 95% |
| 首屏启动链路 | loadConfig→discovery→autoStartAll→…多步 | log 打开 + checkpoint 恢复 + 插件注册（无服务自启、无迁移） | 明显缩短 |

合计：核心仓（Rust+TS）从 ~15.1 万行压到 **~1 万行以内**；加上 chat 插件全量交付物 ~1.6–1.8 万行，仍为 Polaris 全家桶（主仓 + chat-desk ≈ 17.5 万行）的约 **1/10**。裁剪声明：以上为设计目标值，验收时以 `cloc` 实测为准。

---

## 10. 迁移步骤（从 Polaris 到 polaris-lite）

1. **奠基（第 1 周）**：建 `polaris-lite` 仓；落 `eventlog/`（append/read/tail + JSONL 分段）与单测（本机以 `cargo check` 为门，不用 `cargo test --lib`——沿用 Polaris 已知环境限制，测试用前端 vitest + 集成脚本）。
2. **总线（第 1–2 周）**：裁剪 RouterBus → `bus/`（权限表 + 审计入日志 + invoke/stream）；实现 `cap.kv`、`cap.fs` 两个最简 cap 验证全链路。
3. **前端 kernel（第 2–3 周）**：`eventSource`（SSE/tauri listen 双实现）+ `projectionHost`（注册/匹配/批量 apply）+ `useProjectionState`；用 `sessions` 流做一个「会话名录」演示投影。
4. **checkpoint（第 3 周）**：checkpoint.rs 原子读写 + kernel 恢复算法 + 对账兜底；做「杀进程重启，投影无损恢复」的验收场景。
5. **对话插件（第 3–5 周）**：`cap.ai.chat` + builtin_engine（Claude 兼容流式）→ chat-projection 四段式 UI（气泡/输入复用 chat-desk 渲染件改造）；interrupt 链路按 §5 语义实现并专项测试晚到 stop。
6. **外围插件（第 5–6 周）**：settings/history/notification/files 四个投影插件；主题/i18n 收尾；`pnpm tauri:dev:web`、`pnpm typecheck`、web-only 门控（`cargo check --no-default-features`）全绿。
7. **量化与评审（第 6 周）**：cloc 实测填 §9 表；补 `plans/` 简短 spec 存档；准备评委答辩材料。

每步合并前执行：前端 `tsc --noEmit` + `pnpm lint`；后端 `cargo check`；改协议时同步 Rust/TS 两端类型（无运行时 schema 校验是已知缺口，靠类型双写纪律兜底）。

---

## 11. 风险与对策

### 11.1 事件版本演进 / 重放成本（本方案特有风险，重点披露）

- **风险**：日志是不可变事实。事件 payload 结构改了以后，旧事件还是旧形状；投影全量重放会遇到「读不懂的旧事件」。日志越长，全量重放越慢；checkpoint 依赖的 stateVersion 一变，缓存全废。
- **对策（写进契约，不靠自觉）**：
  1. **三段版本号**：`logSchemaVersion`（日志信封结构，尽量永不变）、事件 `schemaVersion`（每类事件独立演进）、投影 `stateVersion`（投影内部状态结构）。三者任一升级都不许改字段含义，只许「新增可选字段 / 新事件类型」。
  2. **Upcaster 链**：kernel 在 apply 前过 `upcasters: Record<eventType, Record<fromVersion, (e)=>NewPayload>>`，把旧版本事件现场升到最新版；投影代码永远只面对最新版。
  3. **未知事件容忍**：`apply` 对不认识的 `type` 必须原样返回 state（§5 示例已体现），保证老插件遇到新事件不崩。
  4. **重放有界**：`snapshotEvery` 让 95% 场景只重放「checkpoint 之后」的增量；对超大流（如长会话），投影实现 `snapshot/restore` 压缩（只留窗口内消息 + 计数），把全量重放成本从 O(日志) 降为 O(窗口)。验收指标：1 万事件增量重放 < 200ms（中端开发机）。
  5. **checkpoint 作废要廉价**：stateVersion 不匹配 → 丢弃 checkpoint 全量重放，是一次性成本；配合上一条的有界重放，最坏情况可控。文档化「改 stateVersion = 接受一次全量重放」的决策成本。

### 11.2 其他风险

| 风险 | 对策 |
|---|---|
| **日志无限增长** | 分段文件按大小滚动（如 8MB/段）；当所有活跃投影的 cursor 都越过某段且存在归档快照时，允许把老段移入 `archive/`（日志仍 append-only，只是冷存储）；`system.compacted` 事件记录归档水位 |
| **流式 delta 高频事件打爆渲染** | delta 事件在 kernel 侧按 16ms 窗口批量 apply + 批量通知（React 18 自动批处理）；`chat.generation.delta` 带 `index` 支持丢序补齐；投影可声明对 delta 类事件的「采样订阅」（后续增强） |
| **多写者竞态** | 单写者：只有 cap 总线能 append；同一会话同时只允许一个进行中的 generation（capability 层拒绝并发 start，返回明确错误事件） |
| **断线/漏事件** | tail 携带全局 seq；kernel 对账补拉（§7）；SSE 自动重连 + `Last-Event-ID` |
| **审计与隐私** | cap:dispatch 事件只记 `argsSummary`（截断/脱敏摘要），不落完整参数；事件日志文件权限随数据根目录 |
| **中断误杀**（Polaris 已知教训） | interrupt 是 cap.ai.chat 的能力内动作，由 capability 设置中断位并在下一拍产出 `finished{stopReason:'interrupted'}`；插件无权直接终止引擎；幂等：重复 interrupt 只产一次终态事件 |
| **投影调试困难**（事件驱动通病） | dev 模式提供「时间旅行」开发工具：任意投影可指定 `from:'beginning'` 重放并逐步单步 apply；cap:dispatch 流即现成链路追踪 |
| **工程量低估** | §10 步骤 1–4 是新增基础设施（约 2,500 行新代码），是本项目最大不确定点；若紧张，可先做「checkpoint 退化为全量重放」的最小版，再补 checkpoint |

### 11.3 硬性约束自查

| 约束 | 满足方式 |
|---|---|
| 1 布局 = Polaris 四段式 | chat-projection 内部逐段对齐（§5 表）；外壳四区同 Polaris Layout |
| 2 核心零业务 | §3 业务黑名单；核心只有日志/总线/生命周期/壳 |
| 3 AI 对话 UI 与业务面板均插件 | chat-projection 与 §6 清单全部走 manifest views + projections |
| 4 cap 总线保留，dispatch 入日志 | §4.6：每次 dispatch 写 requested+终态事件到 `cap:dispatch` |
| 5 前端栈说明 | React 18 原栈，与 Polaris 同栈，迁移成本最低档 |
| 6 规定章节齐全 | 本文 §2–§11 |
| 7 与 Polaris 关系明确 | §8 复制/重写/放弃三清单；独立仓、不改 Polaris 主仓 |
