# S10 桌面双进程：Rust 壳 + 插件宿主进程

> 矩阵定位（第 10 格，不可偏移）：**S10 桌面双进程**——Rust 极简壳（只做窗口 + IPC 总线 + 插件进程管理），另设 **Node/JS 插件宿主进程**；对话插件跑在插件宿主进程里，通过 IPC 渲染回主窗口；插件机制 = IPC 总线 + 独立插件进程；前端栈 = React 原栈。
>
> 对比 Polaris 现状：Polaris 是「Tauri 单应用 + 插件服务子进程（ServiceSupervisor 拉起）+ Blob 面板同窗口加载（pluginModuleLoader 动态 import）」。S10 把「同窗口 Blob 加载」改为「**插件宿主进程**承载全部插件 UI 与逻辑，主窗口只剩 React 壳 + 渲染代理」，Rust 侧从 10.1 万行收缩为窗口/IPC/进程管理极简壳。

## 0. 方案一句话

**Rust 壳不写业务，Node 宿主不碰窗口，React 窗口不存状态**——三进程各守一层，全部跨层交互收敛到一条 JSON-RPC 风格的 IPC 总线，cap 权限/审计在 Rust 壳的总线出口统一裁决。

---

## 1. 架构图（文字图，三进程关系）

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 进程 1：Rust 极简壳（polaris-shell.exe，Tauri v2，无业务命令）                │
│                                                                             │
│  ┌──────────────┐  ┌───────────────────┐  ┌──────────────────────────────┐  │
│  │ window.rs    │  │ ipc_bus.rs        │  │ proc_mgr.rs                  │  │
│  │ 主窗口创建    │  │ RouterBus 精简版  │  │ 插件宿主进程拉起/健康检查/重启 │  │
│  │ 托盘/关闭钩子 │  │ cap 裁决 + 审计   │  │ 孤儿回收 + 崩溃降级           │  │
│  └──────┬───────┘  └────────┬──────────┘  └──────────────┬───────────────┘  │
│         │                   │                            │                  │
│         │     ┌─────────────┴─────────────┐              │                  │
│         │     │ audit.rs   policy.rs      │              │                  │
│         │     │ 审计链     cap 权限表      │              │                  │
│         │     └───────────────────────────┘              │                  │
└─────────┼───────────────────┼────────────────────────────┼──────────────────┘
          │ Webview IPC       │ Named Pipe / stdio JSON-RPC│ spawn + stdio
          │ (invoke/event)    │                            │
┌─────────▼───────────────────▼────────────────────────────▼──────────────────┐
│ 进程 2：主窗口渲染进程（WebView2，React 18 + Vite + Zustand 原栈）            │
│                                                                             │
│  App 壳（Layout 四段式：ActivityBar + LeftPanel + CenterStage + RightPanel） │
│  window.ipc = 桥接层（invoke → Rust 壳；onEvent ← Rust 壳）                  │
│  PanelHost：把 cap.ui.render / plugin.ui.mount 指令渲染成 React 节点          │
│  会话/消息/面板状态 = 轻量 store（仅缓存，真相在事件流）                       │
└─────────────────────────────────────────────────────────────────────────────┘
                                     ▲
                                     │ 渲染指令流（vdom 描述 / 挂载卸载）
                                     │ 数据流（chat-event / 面板数据）
┌────────────────────────────────────┴────────────────────────────────────────┐
│ 进程 3：插件宿主进程（polaris-host.exe，Node 20 + worker_threads 池）         │
│                                                                             │
│  host_main.ts                                                               │
│   ├─ busClient.ts      连接 Rust 壳 IPC（同一 JSON-RPC 协议）                 │
│   ├─ pluginLoader.ts   扫描 plugins/*/plugin.json，按 manifest 装载          │
│   ├─ pluginSandbox.ts  每插件一个 Worker 线程（可选 isolation:进程级二档）     │
│   ├─ capProxy.ts       插件拿到的 cap 句柄 → 经 busClient 转发到 Rust 壳裁决  │
│   └─ uiComposer.ts     汇总各插件 contributes.views → 生成渲染指令下发主窗口   │
│                                                                             │
│  内置/首批插件（全部跑在本进程内）：                                          │
│   chat-desk-lite（对话 UI + 会话状态权威）                                   │
│   settings-desk-lite / history-desk-lite / …（业务面板）                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

**三进程职责边界（一句话版）**

| 进程 | 职责 | 明确不做 |
|---|---|---|
| Rust 壳 | 窗口、IPC 总线转发、cap 权限/审计、插件宿主进程生命周期 | 任何业务逻辑、任何 AI 逻辑、任何存储模型 |
| 插件宿主进程 | 插件发现/装载/沙箱、cap 代理转发、UI 渲染指令合成、对话业务全量 | 直接触碰窗口 API、直接监听键盘鼠标 |
| 主窗口渲染进程 | React 布局壳、渲染指令执行、本地 UI 态缓存、输入采集 | 业务决策、状态权威、cap 裁决 |

**与 Polaris 现状的结构差异（要点）**

1. Polaris：插件面板 JS 通过 `pluginModuleLoader` 读磁盘 → Blob URL → **同窗口动态 import**，插件与宿主同进程同源、直接共享 `window.__POLARIS_APP_CORE__`（21 个 store + 30 service）。S10：插件代码**只在宿主进程执行**，主窗口收到的只是「渲染指令」，插件拿不到 React 实例与 store，`appCoreBridge` 整个删除。
2. Polaris：`ServiceSupervisor` 只管理 manifest `services[]` 声明的**辅助子进程**（HTTP 服务、MCP server 等），对话业务核（ai_chat_core 3.0k 行、storage_exec 5.0k 行、simple_ai 引擎 1 万行）仍在 Rust 主进程。S10：业务核整体移入 Node 宿主进程，Rust 壳里**没有 ai_chat_core、没有 storage_exec、没有引擎**。
3. Polaris：cap 总线在 Rust（router/mod.rs 1.8k 行，34 capability）。S10：保留总线思想但实现极简化——Rust 壳只做「权限裁决 + 审计 + 转发」三件事，目标 ≤800 行；具体 capability 的执行体在宿主进程（`cap.ai.chat`、`cap.history` 等）或由壳转发到系统能力（`cap.fs`、`cap.http`）。

---

## 2. 核心目录树

```
polaris-lite/
├── Cargo.toml                      # workspace，仅 2 个 crate + 1 个 bin
├── package.json                    # 前端 + 宿主共享脚本（pnpm workspaces）
├── pnpm-workspace.yaml
├── crates/
│   └── polaris-shell/              # Rust 极简壳（目标 ≤8,000 行，含测试）
│       ├── src/
│       │   ├── main.rs             # 入口：解析 data root → 启动窗口 → 拉起宿主进程
│       │   ├── window.rs           # Tauri 窗口创建、关闭确认、托盘（≤300 行）
│       │   ├── ipc_bus.rs          # JSON-RPC over Named Pipe：路由表 + 转发
│       │   ├── router.rs           # cap 裁决器：permission gate + audit 钩子（≤800 行）
│       │   ├── policy.rs           # cap 权限表（cap id → 允许的调用方集合）
│       │   ├── audit.rs            # 追加式审计日志（JSONL，落 data root）
│       │   ├── proc_mgr.rs         # 插件宿主进程：spawn/health/restart/kill
│       │   ├── host_protocol.rs    # 壳↔宿主 消息类型（serde 定义，唯一权威）
│       │   ├── webview_bridge.rs   # Tauri invoke/event ↔ ipc_bus 适配
│       │   ├── data_root.rs        # 数据根解析（复制 Polaris data_root.rs 精简版）
│       │   └── config.rs           # 最小配置读写（窗口尺寸/语言/主题）
│       └── tests/                  # 协议编解码、policy 裁决、proc_mgr 重启
├── packages/
│   ├── host/                       # Node 插件宿主进程（polaris-host.exe 入口）
│   │   ├── src/
│   │   │   ├── main.ts             # 宿主入口：连接 IPC → 扫描插件 → 装载
│   │   │   ├── bus/
│   │   │   │   ├── client.ts       # Named Pipe 客户端（复用同一 JSON-RPC 帧）
│   │   │   │   └── capProxy.ts     # 插件侧 cap 句柄（转发到壳裁决）
│   │   │   ├── loader/
│   │   │   │   ├── discover.ts     # 扫描 <dataRoot>/plugins/*/plugin.json
│   │   │   │   ├── manifest.ts     # manifest 解析 + L1 校验（精简 schema）
│   │   │   │   └── lifecycle.ts    # init/start/stop/destroy 状态机
│   │   │   ├── runtime/
│   │   │   │   ├── worker.ts       # 每插件 Worker 线程入口
│   │   │   │   └── sandbox.ts      # Worker 内提供的最小插件 API 面
│   │   │   └── ui/
│   │   │       └── composer.ts     # contributes → 渲染指令（见 §4）
│   │   └── package.json
│   ├── web/                        # 主窗口 React 应用（Vite，原栈）
│   │   ├── src/
│   │   │   ├── main.tsx            # render(<App/>) + ipc 连接 + 主题引导
│   │   │   ├── App.tsx             # Layout 四段式壳（复制 Polaris Layout 骨架）
│   │   │   ├── ipc/
│   │   │   │   ├── bridge.ts       # window.ipc：invoke/onEvent 封装
│   │   │   │   └── types.ts        # 与 host_protocol.rs 对齐的 TS 类型
│   │   │   ├── layout/             # ActivityBar/LeftPanel/CenterStage/RightPanel
│   │   │   ├── panel/
│   │   │   │   ├── PanelHost.tsx   # 渲染指令 → React 节点（§4.3）
│   │   │   │   └── primitives.tsx  # 受限 UI 原语集（View/Text/List/Field…）
│   │   │   ├── stores/             # 仅 4~6 个轻 store：sessionView/config/theme/toast
│   │   │   └── i18n/
│   │   └── package.json
│   └── plugin-sdk/                 # 插件作者依赖的 SDK（类型 + 运行时桩）
│       ├── src/
│       │   ├── definePlugin.ts     # definePlugin(manifest, factory)
│       │   ├── cap.ts              # ctx.cap('cap.fs.read', payload) 类型
│       │   ├── ui.ts               # h()/jsx 渲染指令构造器
│       │   └── types.ts            # PluginContext / LifecycleHooks
│       └── package.json
├── plugins/                        # 首批插件（独立包，皆依赖 plugin-sdk）
│   ├── chat-desk-lite/             # 对话插件（含四段式对话 UI 的指令合成器）
│   ├── settings-desk-lite/
│   ├── history-desk-lite/
│   └── model-desk-lite/            # 模型/供应商管理面板
├── docs/
│   ├── brief.md / baseline.md
│   └── schemes/S10-dual-process.md # 本文件
└── scripts/
    ├── dev.sh / dev.ps1            # 一键起壳 + 宿主 + web 热更
    └── build.mjs                   # 产物：shell.exe + host.exe + web 静态资源
```

**规模预算（写码前承诺）**：Rust 壳 ≤8,000 行；宿主进程 ≤6,000 行；web 壳 ≤4,000 行；plugin-sdk ≤1,500 行；插件（chat-desk-lite 为最大）≤6,000 行。核心（壳+宿主+web 壳+sdk）合计 ≤19,500 行，约为 Polaris 主仓（15.1 万行）的 **13%**。

---

## 3. 核心契约

### 3.1 IPC 协议（三进程统一一帧格式）

**传输**：Rust 壳 ↔ 宿主进程 = Windows Named Pipe `\\.\pipe\polaris-lite-{instanceId}`（壳为 server）；主窗口 ↔ 壳 = Tauri `invoke`/`emit`（webview_bridge 转成同一帧）。宿主 ↔ 插件 Worker = `postMessage` 结构化克隆（同协议帧的子集）。

**帧结构**（JSON-RPC 2.0 子集 + 事件扩展；`host_protocol.rs` 与 `web/ipc/types.ts` 双边镜像）：

```rust
// crates/polaris-shell/src/host_protocol.rs（权威定义）
#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Frame {
    /// 请求-响应：id 单调递增，resp 必须携带同 id
    Request {
        id: u64,
        method: String,        // 见 §3.2 方法表
        params: serde_json::Value,
        /// 发起方身份，壳侧强制覆写，插件/宿主伪造无效
        #[serde(default)]
        origin: Origin,        // Origin::Shell | Host | Plugin(String) | Webview
        /// 期望完成时间上限（毫秒），0 = 用 method 默认值
        #[serde(default)]
        timeout_ms: u32,
    },
    Response {
        id: u64,
        ok: bool,
        result: Option<serde_json::Value>,
        error: Option<RpcError>,   // { code: i32, message: String, data?: Value }
    },
    /// 单向事件：无 id，不等待响应
    Event {
        topic: String,         // 见 §3.4 主题表
        payload: serde_json::Value,
        origin: Origin,
    },
}

pub const PROTOCOL_VERSION: u32 = 1;
```

```ts
// packages/web/src/ipc/types.ts（前端镜像，字段一一对应）
export type Origin = 'shell' | 'host' | 'plugin' | 'webview';
export interface RpcError { code: number; message: string; data?: unknown }
export type Frame =
  | { kind: 'request'; id: number; method: string; params: unknown; origin?: Origin; timeoutMs?: number }
  | { kind: 'response'; id: number; ok: boolean; result?: unknown; error?: RpcError }
  | { kind: 'event'; topic: string; payload: unknown; origin: Origin };
```

**分帧**：管道上每帧 = `4 字节小端长度 + UTF-8 JSON`；单帧上限 8 MiB（超限用 `blob.put`/`blob.get` 分块通道，见 §3.3 大载荷）。

**错误码约定**：`-32601` 未知 method；`-32602` 参数非法；`40301` cap 未授权；`40401` 目标插件未运行；`40801` 超时；`50001` 宿主内部错误；`50301` 宿主进程不可用。

### 3.2 IPC 方法表（method 全集，壳侧路由表即白名单）

| method | 发起方 → 接收方 | 说明 |
|---|---|---|
| `sys.hello` | 宿主/窗口 → 壳 | 握手，返回 `{protocolVersion, instanceId, dataRoot, caps: CapDesc[]}` |
| `sys.ping` | 任意 → 任意 | 健康探测 |
| `cap.dispatch` | 窗口/宿主/插件 → 壳 | cap 调用统一入口，params=`{cap, action, payload}`，壳裁决后转发 |
| `cap.dispatchStream` | 窗口/宿主 → 壳 | 流式 cap（如 `cap.ai.chat` start/continue），后续数据以 `stream.*` 事件回推 |
| `plugin.register` | 宿主 → 壳 | 宿主报告已装载插件与贡献点，壳更新权限表 |
| `plugin.ui.mount` | 宿主 → 壳 → 窗口 | 下发渲染指令，让窗口在指定槽位挂载 UI（§4.3） |
| `plugin.ui.event` | 窗口 → 壳 → 宿主 | 窗口侧 UI 交互事件回传（输入框文本、按钮点击、滚动触底等） |
| `plugin.state.set/get` | 宿主 → 壳 | 宿主把会话/面板状态权威写入壳的 KV（持久化），窗口可订阅 |
| `blob.put` / `blob.get` | 宿主 ↔ 壳 ↔ 窗口 | 大载荷（附件、图片、长文）分块传输，管道里只传 `{blobId, seq, total, bytes}` |
| `proc.status` | 宿主 → 壳 | 宿主上报自身与各 Worker 健康状态 |
| `lifecycle.shutdown` | 壳 → 宿主 | 优雅停机：停止接单 → flush 状态 → 退出；超时强杀 |

### 3.3 大载荷通道

附件、截图、长 markdown 不进控制帧。约定：`cap.dispatch`/`Event` 的 payload 里可放 `{"$blob":"<blobId>"}` 引用；接收方用 `blob.get {blobId, offset, length}` 分块拉取（每块 256 KiB）。blob 临时目录在 data root 下 `tmp/blobs/`，TTL 10 分钟由壳清理。这保证对话流式 delta（小、高频）与附件（大、低频）互不阻塞。

### 3.4 事件主题表（topic 全集）

| topic | 方向 | 说明 |
|---|---|---|
| `chat.delta` | 宿主 → 窗口 | AI 流式增量：`{sessionId, seq, delta, done}` |
| `chat.status` | 宿主 → 窗口 | 会话状态机：`{sessionId, state: running\|waiting_input\|done\|error}` |
| `chat.tool` | 宿主 → 窗口 | 工具调用卡片：`{sessionId, callId, name, phase, payload}` |
| `session.changed` | 宿主 → 窗口 | 会话列表/元数据变更（含 reason，避免整表刷新） |
| `panel.updated` | 宿主 → 窗口 | 面板数据/渲染指令增量更新 |
| `ui.theme` | 壳 → 窗口 | 主题 token 变更广播 |
| `plugin.crashed` | 壳 → 窗口/宿主 | 某 Worker/宿主崩溃及降级策略生效 |
| `audit.appended` | 壳 → 宿主 | 审计追加通知（可选订阅） |

### 3.5 cap 转发签名

**壳侧裁决器**（Rust，精简自 router/mod.rs，只留 gate+audit+forward）：

```rust
// crates/polaris-shell/src/router.rs
pub struct CapRouter { policy: PolicyTable, audit: AuditLog, forward: HostForward }

impl CapRouter {
    /// 唯一入口：所有 cap.dispatch 都走这里
    pub async fn dispatch(&self, req: CapRequest, origin: Origin) -> Result<CapResponse, RpcError> {
        // 1) 权限：policy.allows(origin, &req.cap, &req.action)？否则 deny + 审计
        // 2) 审计：audit.record(origin, &req)（kv 只读类 ok 可按 should_audit 豁免）
        // 3) 转发：全部转发到宿主进程（壳内无业务执行体）
        self.policy.check(&origin, &req.cap, &req.action)?;
        self.audit.record(&origin, &req).await?;
        self.forward.to_host(req).await
    }
}

#[derive(Serialize, Deserialize)]
pub struct CapRequest { pub cap: String, pub action: String, pub payload: serde_json::Value }
#[derive(Serialize, Deserialize)]
pub struct CapResponse { pub ok: bool, pub data: serde_json::Value }
```

**插件侧 cap 句柄**（宿主进程内，插件 Worker 拿到的就是这套类型）：

```ts
// packages/plugin-sdk/src/cap.ts —— 插件唯一能拿到的能力入口
export interface CapClient {
  /** 单发：对应壳侧 cap.dispatch */
  call<T = unknown>(cap: string, action: string, payload?: unknown): Promise<T>;
  /** 流式订阅：对应 cap.dispatchStream，返回可取消句柄 */
  stream<T = unknown>(
    cap: string, action: string, payload?: unknown,
    onData: (chunk: T) => void,
  ): { cancel(): void };
}

// 宿主进程注入给每个插件的上下文
export interface PluginContext {
  manifest: PluginManifestLite;
  cap: CapClient;                       // 所有跨进程能力都经此转发，无直连后端
  log: { debug(m: string): void; warn(m: string): void; error(m: string): void };
  onDispose(fn: () => void): void;      // 插件停机清理
}
```

**权限表**（壳侧 `policy.rs`，来源 = 插件 manifest 的 `permissions` + `capabilities` 声明，宿主 `plugin.register` 时写入）：

```rust
// 一条规则：谁（origin）可调哪个 cap 的哪些 action
pub struct PolicyRule { pub origin: Origin, pub cap: String, pub actions: Vec<String> }
// 例：chat-desk-lite 装载后写入：
//   Plugin("chat-desk-lite") × cap.ai.chat × [start, continue, interrupt]
//   Plugin("chat-desk-lite") × cap.history × [list, read]
//   Webview               × cap.ai.chat × [start, continue, interrupt, send_input]
// 内置策略：Remote origin 一律 deny；插件未声明的 cap 一律 deny；壳自身只放行 sys.*
```

### 3.6 插件进程生命周期接口

**manifest 精简版**（`PluginManifestLite`，仅保留 S10 用得到的字段，其余 Polaris manifest 字段明确放弃，见 §7）：

```ts
// packages/plugin-sdk/src/types.ts
export interface PluginManifestLite {
  id: string;                    // 如 "chat-desk-lite"
  name: string;
  version: string;
  main: string;                  // 宿主进程内执行的入口，如 "./dist/index.js"
  isolation: 'worker' | 'process'; // 二档隔离：Worker 线程（默认）/ 独立子进程
  contributes: {
    views?: ViewContribution[];  // 槽位声明（§4.1）
    caps?: string[];             // 声明要调用的 cap id（写入壳权限表）
  };
  permissions?: { chatEvents?: 'full' | 'lifecycle' | 'none' };
}
export interface ViewContribution {
  id: string;                    // 如 "chat.main"
  slot: 'activityBar' | 'leftPanel' | 'centerStage' | 'rightPanel' | 'settings';
  order?: number;
  icon?: string;
  label?: string;
}
```

**宿主侧生命周期状态机**（`loader/lifecycle.ts`）：

```ts
export type PluginState = 'discovered' | 'loading' | 'starting' | 'running' | 'stopping' | 'crashed' | 'stopped';

export interface PluginLifecycle {
  load(manifest: PluginManifestLite): Promise<void>;   // 校验 + 创建隔离体
  start(id: string): Promise<void>;                    // 调用插件 default export 的 activate(ctx)
  stop(id: string, reason: 'shutdown' | 'disable' | 'crash'): Promise<void>;
  restart(id: string): Promise<void>;                  // crash 后退避重启（≤3 次/分钟）
}

// 插件作者实现的契约（plugin-sdk definePlugin）
export interface PluginModule {
  activate(ctx: PluginContext): void | Promise<void>;  // 在此注册 UI 与订阅事件
  deactivate?(): void | Promise<void>;
}
export function definePlugin(m: PluginManifestLite, mod: PluginModule) { return { manifest: m, ...mod }; }
```

**壳侧进程管理**（`proc_mgr.rs`）：宿主进程由壳 spawn（`node host/main.js` 或打包后的 `polaris-host.exe`），壳持有关停顺序：`lifecycle.shutdown` → 等 3s → kill；宿主退出/失联 → 壳按退避重启（1s/2s/4s，1 分钟内 ≤3 次），期间窗口收到 `plugin.crashed` 并渲染降级空态。Worker 崩溃由宿主自治重启，不上扰壳。

---

## 4. AI 对话插件挂载

### 4.1 布局契约（Polaris 现状四段式，不重新发明）

窗口壳保留 Polaris 的 `Layout` 四段骨架（复制 `src/components/Common/Layout.tsx` + `ActivityBar/LeftPanel/CenterStage/RightPanel` 空壳化版），每段是**渲染槽位**。对话四段全部由 chat-desk-lite 经 `plugin.ui.mount` 注入：

```
RightPanel（对话主区，对应 Polaris 现状 mainSurface）
 ├─ slot=activityBar：会话图标/入口（对应 ActivityBar 席位）
 ├─ slot=leftPanel  ：会话侧栏（会话列表、新建会话、历史抽屉入口）
 ├─ slot=rightPanel ：消息流 + 底部输入区（消息气泡、工具卡片、输入框、附件预览）
 └─ slot=settings   ：模型/参数设置席位
```

### 4.2 渲染指令协议（宿主 → 窗口，`plugin.ui.mount`）

插件**不发 React 组件**（跨进程传组件不可行），而是发**声明式渲染指令**。窗口侧 `PanelHost` 维护「槽位 → 指令树」映射并渲染为 React 节点。指令集刻意收窄（对应 baseline 总结的最小核心：布局 + 事件 + 主题，不含业务组件）：

```ts
// packages/web/src/panel/primitives.tsx 支持的节点类型（受控白名单）
export type UINode =
  | { type: 'view'; style?: UIStyle; children?: UINode[] }
  | { type: 'text'; value: string; style?: UIStyle }
  | { type: 'list'; items: UINode[]; style?: UIStyle }
  | { type: 'button'; label: string; onAction: string; style?: UIStyle }   // onAction=事件名
  | { type: 'input'; placeholder?: string; value: string; onInput: string; multiline?: boolean }
  | { type: 'markdown'; source: string }                                   // 消息体渲染
  | { type: 'icon'; name: string; size?: number }
  | { type: 'spinner' };
export interface UIMount {
  viewId: string;          // 对应 ViewContribution.id
  slot: string;
  tree: UINode;            // 增量更新时只发 diff（见下）
}
```

**交互回流**：窗口把 UI 事件（点击/输入）打成 `plugin.ui.event {viewId, onAction, value}` 回宿主；宿主把会话状态变化重新合成指令树（或 diff）下推。流式对话时，chat-desk-lite 只对变化的消息节点下发 diff，避免每 token 全量重渲。

**为何不用 Blob/直接 import**：Polaris 的 pluginModuleLoader 把插件 JS 注入主窗口同源执行，导致插件可拿 `window.__POLARIS_APP_CORE__` 全部 21 个 store——这是宿主与业务耦合的最大黏合点。S10 用渲染指令协议从物理上切断该耦合：插件永远拿不到 React/DOM，主窗口永远不知道业务字段。

### 4.3 chat-desk-lite 的挂载与数据流

```
chat-desk-lite（宿主进程内，Worker 隔离）
 activate(ctx):
   ctx.cap.call('cap.history','list')          → 拉会话列表（经壳裁决，可缓存到 plugin.state）
   ctx.cap.stream('cap.ai.chat','start',…)     → 订阅流式输出
   每 250ms 聚合 chat.delta → 合成/patch 消息树
   host.uiComposer.mount({viewId:'chat.main', slot:'rightPanel', tree})

窗口侧：
 ipc.on('event', topic==='plugin.ui.mount') → PanelHost.patch(viewId, tree)
 PanelHost 按 slot 投影到 RightPanel；用户输入 → plugin.ui.event → 宿主
 宿主 ctx.cap.call('cap.ai.chat','send_input',{sessionId,text}) → 壳审计 → 回宿主执行
```

**与 Polaris 现状链路对照**：Polaris 是 `chat-desk 面板 → tauri invoke router_dispatch → Rust ai_chat_core → 引擎 → EventBroadcaster → 前端 listen`。S10 把「Rust 业务核 + 引擎」整体搬进宿主进程（Node 侧实现 provider 路由/流式解析/工具调用编排），壳只剩转发。**AI 能力面不缩水**：`cap.ai.chat` 的动作表（start/continue/interrupt/send_input/ask）与 `chat-event` 事件语义原样保留，前窗 UI 交互不变。

---

## 5. 插件清单（首批，全部满足核心零业务）

| 插件 | isolation | contributes | caps | 说明 |
|---|---|---|---|---|
| `chat-desk-lite` | worker | rightPanel 主对话 + leftPanel 会话侧栏 + activityBar 入口 | cap.ai.chat, cap.history, cap.kv, cap.fs(附件) | AI 对话 UI + 会话状态权威 + 消息渲染 |
| `settings-desk-lite` | worker | settings 席位 | cap.config, cap.kv | 主题/语言/模型参数设置面板 |
| `history-desk-lite` | worker | leftPanel 历史抽屉（session-history 槽） | cap.history, cap.kv | 会话历史检索与回放 |
| `model-desk-lite` | worker | settings 席位（模型分页） | cap.config, cap.http | 供应商/模型/密钥管理 |

可选扩展位（不在首批，验证机制可扩展即可）：`translate-lite`、`terminal-desk-lite`（走 cap.terminal）。**核心目录内不出现任何上述业务的实现代码**；壳的权限表里只有 cap id 与 action 字符串，不含业务语义。

---

## 6. 启动流程

```
t0  用户双击 polaris-shell.exe（或 pnpm tauri:dev:web 开发态）
t1  壳 main.rs：解析 data root（复制 Polaris data_root.rs 的 env>anchor>默认 链，精简到 ~150 行）
t2  壳创建主窗口（加载 web/dist 静态资源；开发态由 Vite 热更）
t3  壳 proc_mgr.spawn(宿主进程)，以 Named Pipe 等待 sys.hello（超时 10s → 报错重试）
t4  宿主 main.ts：busClient 连接 → sys.hello 握手 → discover 扫描 <dataRoot>/plugins
t5  宿主逐个 load/start 插件（Worker 隔离），把 {pluginId, views[], caps[]} 经 plugin.register 报给壳
t6  壳更新 policy 表 + audit；壳把「已就绪插件」事件推窗口
t7  宿主 uiComposer 对每个 running 插件下发 plugin.ui.mount；窗口 PanelHost 渲染四段式
t8  chat-desk-lite activate：cap.history.list 拉会话 → 渲染会话侧栏 → 恢复最近会话消息流
t9  就绪。用户在输入区输入 → plugin.ui.event → 宿主 → cap.ai.chat.start（壳审计）→ 流式回推 chat.delta
```

**开发态**：`pnpm dev` 并行起 Vite（web 热更）与宿主 tsx watch；Rust 壳 `cargo run`。**发布**：`scripts/build.mjs` 产出 `shell.exe + host.exe + web 静态资源 + plugins/*/dist`，host 以 sidecar 形式随壳分发。

**停机**：窗口关闭 → 壳发 `lifecycle.shutdown` → 宿主 stop 全部插件（flush 状态到 plugin.state.set）→ 退出 → 壳关审计与窗口。

---

## 7. 与 Polaris 复用 / 差异清单

### 7.1 直接复制（改包名/路径即可）

| 来源（Polaris） | 去向（lite） | 说明 |
|---|---|---|
| `src/components/Common/Layout.tsx` + ActivityBar/LeftPanel/CenterStage/RightPanel 壳 | `packages/web/src/layout/` | 四段式骨架原样保留（空壳化后 ~700 行） |
| `src/components/Common/`（Modal/Toast/ErrorBoundary/Icons） | `packages/web/src/components/` | 通用 UI 复用 |
| `src/services/themeEngine.ts`/`themeService.ts`/`themeMerger.ts` | `packages/web/src/theme/` | 主题 token 体系沿用 |
| `src/i18n/` + `src/locales/` | `packages/web/src/i18n/` | i18n 单例沿用 |
| `src-tauri/src/services/data_root.rs` | `crates/polaris-shell/src/data_root.rs` | 精简为最小解析链 |
| `src/plugin-system/schema.ts` 的 views/permissions 字段定义 | `packages/plugin-sdk/src/types.ts` | 精简为 PluginManifestLite |
| `src/types/aiEvent.ts`（事件类型） | `packages/web/src/ipc/types.ts` + 宿主侧镜像 | chat-event 语义不变 |
| chat-desk 的会话侧栏/消息流/输入区 UI 结构 | `plugins/chat-desk-lite/src/ui/` | 改写为渲染指令合成器（复用布局与样式 token，不复制组件实现） |

### 7.2 重写（保留思想，换实现）

| Polaris 现状 | S10 重写为 | 理由 |
|---|---|---|
| `services/router/mod.rs`（1,786 行） | `crates/polaris-shell/src/router.rs`（≤800 行） | 只留 gate+audit+forward，砍 override 链/dynamic cap/流式注册表等 |
| `plugin_service.rs`（2,904 行） | `packages/host/src/loader/`（发现/装载）+ `proc_mgr.rs`（进程管理） | Polaris 管的是「服务子进程 + Blob 面板」；S10 管的是「插件 Worker + 渲染指令」 |
| `ai_chat_core/`（3,042 行）+ `ai/engine/simple_ai/` | `plugins/chat-desk-lite/src/ai/`（Node 侧编排） | 业务核随对话插件入宿主进程；Node 生态做 SSE/工具调用解析更顺手 |
| `web/event_broadcaster.rs` + `main.tsx HOST_LISTEN` | `ipc_bus.rs` Event 转发 + `bus/client.ts` | 统一为一套 topic 表 |
| `appCoreBridge.ts`（21 store + 30 service 共享） | **删除**，以 cap + 渲染指令替代 | 切断宿主-业务最大黏合点（本方案核心动机之一） |
| `pluginModuleLoader.ts`（Blob 同窗加载） | **删除**，以插件宿主进程替代 | 安全与稳定性：插件崩溃不拖垮窗口 |

### 7.3 放弃（lite 不做）

浏览器域（browser-desk 已出仓的残留类型）、`cap.git`、`services/proxy/`（5.0k 行供应商代理，lite 直连 provider API）、`storage_exec/`（4.9k 行）改由插件用 `plugin.state`/`cap.fs` 自持 JSONL、`nexus_pipeline/`、`computer_control/`、`ask_listener/`、`form/`、LSP、SCM 编辑器扩展、`editorExtensionRegistry`、PWA、多窗口 WindowManager、`cap.self.mutate`、`cap.app.update`、`cap.app.autolaunch`、动态 `cap.dyn.*`。

---

## 8. 裁剪量化表

| 维度 | Polaris 现状（baseline） | S10 目标 | 裁剪率 |
|---|---|---|---|
| Rust 代码 | 250 文件 / 101,032 行 | 壳 ≤8,000 行（约 25 文件） | **≈92%** |
| 前端 TS（核心侧） | 279 文件 / 49,794 行 | web 壳 ≤4,000 行 + host ≤6,000 行 + sdk ≤1,500 行 | 核心 ≈11,500 行，**≈77%**（业务随插件外置） |
| cap 总线 | 34 capability / 1,786 行路由 | 8 个 cap id / ≤800 行裁决器 | cap 数 **≈76%**、路由代码 **≈55%** |
| Tauri 命令 | 36 个 #[tauri::command] | 2 个（invoke 桥 + event 桥） | **≈94%** |
| 插件宿主桥 | 21 store + 30 命令白名单 + Blob 加载 | cap 句柄 + 渲染指令（无 store 共享） | 桥面积 **≈90%** 收窄 |
| 会话存储 | storage_exec 4,964 行（SQLite/OPFS 迁移） | 宿主内 JSONL + plugin.state 持久化 | **≈95%**（放弃 SQLite/OPFS 双轨） |
| AI 引擎 | simple_ai 10k+ 行（Rust，含 bash/fs/computer 工具） | chat-desk-lite 内 Node 编排 ≤2,500 行 | 首版工具面仅 bash/fs，其余后补 |
| 供应商接入 | proxy 5,039 行 + provider_router | 直连 provider API（fetch），≤600 行 | **≈88%** |
| 启动链路 | main.tsx 6 步 + App.tsx 7 个初始化 hook | 壳 t1-t3 + 宿主 t4-t8（无 PWA/性能热 Switch/OPFS 迁移） | 启动步骤 **≈50%** |
| 冷启动目标 | Tauri 全量（未量化） | 壳 <300ms、宿主就绪 <800ms、首屏可交互 <1.5s | 可测（scripts/dev.sh 打点） |

> 诚实边界：Node 宿主进程会带来 ~40-80MB 常驻内存与进程启动开销，这是「双进程轻量」用内存换解耦的代价，在 §11 风险中披露。

---

## 9. 迁移步骤（从 Polaris 到 S10，六步，每步可验证）

1. **骨架周**：建仓 `polaris-lite`；壳实现 window + ipc_bus + sys.hello；web 壳渲染复制来的 Layout 空壳；打通「窗口 ↔ 壳」invoke/event。验收：窗口显示四段空壳，`cap.dispatch` 能从窗口打到壳并回显。
2. **宿主周**：host 连接管道、discover/loader/lifecycle 落地；写一个 `hello-plugin` 走完 load→start→mount→event 回流。验收：hello 插件的按钮点击能在窗口 Toast 显示。
3. **渲染指令周**：primitives + PanelHost + diff 更新；主题 token 接入。验收：settings-desk-lite 用指令树渲染出可用设置面板。
4. **对话周（核心）**：chat-desk-lite 实现 cap.ai.chat 编排（先接 1 家 provider 的 SSE）、会话侧栏、消息流、输入区、chat.delta 聚合；壳侧 policy/audit 上线。验收：真实流式对话 + 权限表拒绝未声明 cap。
5. **补全面板周**：history-desk-lite、model-desk-lite；plugin.state 持久化；崩溃重启演练（kill -9 宿主/Worker）。
6. **发布周**：build.mjs 产物打包、冷启动打点达标、审计日志校验、文档（插件开发指南 + SDK README）。

---

## 10. 验收清单（对照 brief 硬性约束逐条自检）

- [ ] 对话四段式（会话侧栏/消息流/输入区/面板区）由 chat-desk-lite 挂载，交互与 Polaris 现状一致。
- [ ] 核心三包（shell/host/web 壳）目录内无 git/浏览器/翻译/终端等业务实现。
- [ ] AI 对话与业务面板均为插件，经 `plugin.ui.mount` 统一挂载。
- [ ] 保留 cap 总线：所有跨进程调用经壳裁决审计，插件无直连后端通道。
- [ ] 前端 React+Zustand+Vite 原栈，与 Polaris 迁移成本主要在「store 共享 → IPC 化」。
- [ ] 独立目录、独立构建，不改 Polaris 主仓任何文件。

---

## 11. 风险与对策

| # | 风险 | 等级 | 对策 |
|---|---|---|---|
| 1 | **IPC 延迟**：流式对话每 token 一跳（宿主→壳→窗口），叠加渲染指令 diff，可能比 Polaris 同窗直渲慢 | 高 | ① chat.delta 在宿主侧 250ms 微批聚合再下发；② diff 只发变化节点；③ 壳转发用零拷贝 framing（长度前缀 + 原样字节转发，不重复反序列化）；④ Named Pipe 本机吞吐实测 >100MB/s，单帧 <10KB 的 delta 延迟 <1ms，瓶颈在聚合策略而非管道；⑤ 预算打点（t9 全链路 P95 <50ms）写入 CI |
| 2 | **进程管理复杂度**：宿主崩溃、Worker 泄漏、孤儿进程、优雅停机竞态 | 高 | ① 壳 proc_mgr 统一管宿主进程树（Windows Job Object 关联，父死子亡）；② 宿主内 Worker 退避重启 + `plugin.crashed` 通知窗口降级；③ 停机三段式（shutdown→3s→kill）；④ 落地前先写 chaos 测试：随机 kill 宿主/Worker，验证状态可从 plugin.state 恢复 |
| 3 | 渲染指令表达力不足，复杂面板（如图表、表格树）写起来笨拙 | 中 | primitives 预留 `html` 白名单节点（仅宿主生成、窗口侧 sanitize 渲染）作为二档；首批插件只用受控原语，验证表达力边界后再扩 |
| 4 | Node 宿主内存/启动开销与「轻量」目标冲突 | 中 | 宿主按需加载插件（`enabledByDefault` 门控）；打包用 esbuild 单文件 + Node SEA 或 Bun compile；量化指标进 §8 表并实测 |
| 5 | 跨平台：Named Pipe 仅 Windows，macOS/Linux 需 Unix Domain Socket | 中 | bus/client 与 ipc_bus 抽象 transport trait/接口，Windows→Named Pipe、Unix→UDS，协议帧不变 |
| 6 | AI 引擎在 Node 侧重写的工作量被低估（Polaris simple_ai 1 万行） | 中 | 首版只做「单 provider 流式对话 + interrupt + 附件上传」最小闭环；工具调用/compact/多 provider failover 列为后续迭代，不冒进 |
| 7 | 双协议镜像（Rust host_protocol.rs ↔ TS types.ts）漂移 | 低 | 以 Rust 为唯一权威，build 时用 specta/ts-rs 导出 TS 类型；CI 校验生成文件无 diff |
| 8 | 与 Polaris 的能力差距被误读为「功能缺失的 bug」 | 低 | README 与本方案 §7.3 放弃清单明示边界；插件 manifest 标注 `compat.polarisFull=false` |

---

## 12. 本方案差异化小结（评委速览）

- **唯一性**：十案中唯一把「插件」从「同窗口 JS 模块」升级为「**独立进程/Worker 内的指令生产者**」的方案；核心卖点是把 Polaris 最大耦合点（appCoreBridge 21 store 共享 + Blob 同窗加载）物理切除。
- **代价**：多一个 Node 进程（内存/启动/IPC 延迟），渲染指令协议需要维护。
- **适合**：在意插件崩溃隔离、宿主与业务强解耦、愿意用一层声明式 UI 协议换取长期演进自由的取向。
