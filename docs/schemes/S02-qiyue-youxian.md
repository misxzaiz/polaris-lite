# S2 契约优先：极薄核心 + 最小贡献契约

> 矩阵认领：第 2 格「S2 契约优先」——核心形态 = **重写极薄核心，只留总线 + 插件生命周期**；AI 对话 UI = **按 Polaris 布局重写为插件**；插件机制 = **新设计的最小 contribute 契约**（比 Polaris 现有 manifest 更瘦）；前端栈 = **React 原栈**。
>
> 一句话定位：不复制 Polaris 的核心代码，而是把 Polaris 十年沉淀出的 cap 总线与插件化经验**压缩成一份小到可以背下来的契约**，核心重写到只负责「转发、授权、审计、装插件、开窗口」，其余一切（包括 AI 对话界面本身）都是插件。

---

## 1. 设计原则（契约优先的三条铁律）

1. **契约先于实现**。先冻结三份契约文件（`contracts/manifest.schema.json`、`contracts/cap-protocol.md`、`contracts/events.md`），核心与插件分别按契约实现，允许并行开发、允许换实现。
2. **核心只做五件事**：cap 转发、权限裁决、审计入链、插件发现/启停、窗口与静态资源。凡能用一句话说清「这是某业务」的代码，一律不进核心。
3. **UI = 插件**。对话四段式布局（会话侧栏 + 消息流 + 底部输入区 + 面板区）由 `chat-desk` 插件整体实现；核心只提供挂载点（`main` 席位）与席位注册表，不实现任何一段。

与相邻方案的边界（防止偏移）：
- 与 **S1** 的区别：S1 复制 Polaris 壳与 plugin-system 原样；S2 的核心与插件契约都是**重写的新设计**，Polaris 只提供「结构参照 + 部分叶子工具复制」。
- 与 **S3** 的区别：S3 由核心提供 sidebar/stream/input/panel 四个布局槽位；S2 的四段式布局**整体归 chat-desk 插件所有**，核心只有 `main` 一个全幅挂载点。
- 与 **S7** 的区别：S7 在 Polaris 上渐进剥离；S2 在 `polaris-lite` 独立仓库从零搭建，不改 Polaris 任何文件。

---

## 2. 架构图（文字图）

```
┌────────────────────────────── polaris-lite（独立仓库）──────────────────────────────┐
│                                                                                     │
│  ┌─────────────── WebView：React 前端（app/，重写）───────────────┐                  │
│  │  AppShell（核心唯一布局壳）                                     │                  │
│  │  ┌──────────┐ ┌──────────────────────────────────────────────┐ │                  │
│  │  │ActivityBa│ │  main 席位（全幅，唯一）                       │ │                  │
│  │  │（核心渲染 │ │  ┌──────────────────────────────────────────┐ │ │                  │
│  │  │ 席位图标）│ │  │ chat-desk 插件（按 Polaris 四段式重写）   │ │ │                  │
│  │  │          │ │  │ ┌────────┬───────────────┬─────────────┐ │ │ │                  │
│  │  │ ·chat    │ │  │ │会话侧栏│   消息流       │  面板区      │ │ │ │                  │
│  │  │ ·files   │ │  │ │session/│   messages/    │  panels/ ←──┼─┼─┼── 挂载 files/     │
│  │  │ ·history │ │  │ │        │               │ （tab 化）   │ │ │ │   history/…插件  │
│  │  │ ·settings│ │  │ └────────┴──────┬────────┴─────────────┘ │ │ │                  │
│  │  │          │ │  │        底部输入区 input/                  │ │ │                  │
│  │  └──────────┘ │  └──────────────────────────────────────────┘ │ │                  │
│  │               └──────────────────────────────────────────────┘ │                  │
│  │  OverlayHost（settings 等覆盖层）   BusClient（invoke/stream）  │                  │
│  └──────────────────────────────┬──────────────────────────────────┘                  │
│                    invoke('bus_invoke') / listen('chat-event')                       │
│                                 ▼                                                    │
│  ┌─────────────── Rust 极薄核心（core/，重写，≤5.5k 行）──────────┐                   │
│  │  Tauri 壳（9 个命令）                                          │                   │
│  │  ┌─────────────────────────────────────────────────────────┐  │                   │
│  │  │ CapBus：dispatch / dispatch_stream                       │  │                   │
│  │  │   ├─ PolicyEngine（manifest.caps 允许表，默认拒绝）       │  │                   │
│  │  │   ├─ AuditLog（JSONL 追加，每调用一条）                   │  │                   │
│  │  │   └─ 路由表：内置 caps + 插件 serves 的动态 caps          │  │                   │
│  │  ├─ 内置能力：cap.storage / cap.fs / cap.http / cap.kv /    │  │                   │
│  │  │             cap.config / cap.window                     │  │                   │
│  │  ├─ PluginRegistry：发现 / 解析 / enable / disable          │  │                   │
│  │  └─ ServiceProxy：把 serves 型 cap 转发到插件 sidecar        │  │                   │
│  └──────────────────────────────┬───────────────────────────────┘                   │
│                                 │ HTTP(127.0.0.1:port)                              │
│                                 ▼                                                    │
│  ┌─────────────── 插件 sidecar 进程（可选）──────────────────────┐                    │
│  │  ai-engine 插件：serves ["cap.ai.chat"]                        │                    │
│  │  POST /invoke → JSON；POST /stream → SSE(StreamEvent)          │                    │
│  │  内部：OpenAI 兼容 / Claude API 调用、SSE 解析、中断取消        │                    │
│  └────────────────────────────────────────────────────────────────┘                   │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

一次对话的数据链路：

```
chat-desk InputArea
  → bus.invoke('cap.ai.chat', {action:'start', sessionId, messages})
  → core CapBus.dispatch：PolicyEngine 校验 chat-desk 的 caps 含 cap.ai.chat → 审计入链
  → 路由表命中：cap.ai.chat 由 ai-engine serves → ServiceProxy 转发
  → ai-engine 调用模型 API，SSE 逐块返回 StreamEvent
  → core dispatch_stream 反向广播 topic='chat-event'
  → chat-desk MessageStream 订阅渲染（delta 拼接 / tool 卡片 / done 落库）
  → 落库走 cap.storage（session.append_messages），会话侧栏经 cap.storage.session.list 刷新
```

---

## 3. 核心目录树

```
D:\space\base\polaris-lite\
├─ contracts\                          # 契约单源（先写、后实现）
│  ├─ manifest.schema.json             # 插件 manifest JSON Schema（权威）
│  ├─ cap-protocol.md                  # 每个 cap 的 action/payload/返回/事件定义
│  ├─ events.md                        # 事件主题与负载定义
│  └─ layout-contract.md               # 四段式布局契约（chat 插件必须遵守）
├─ core\                               # Rust 极薄核心（重写，目标 ≤5.5k 行）
│  ├─ Cargo.toml                       # 依赖：tauri, tokio, serde, serde_json, reqwest, uuid, tracing
│  └─ src\
│     ├─ main.rs                       # tauri Builder + 9 个命令注册（≤150 行）
│     ├─ state.rs                      # AppState { bus, plugins, config, data_root }
│     ├─ bus\
│     │  ├─ mod.rs                     # CapBus 结构与 dispatch/dispatch_stream（≤400 行）
│     │  ├─ context.rs                 # RequestContext / StreamEvent / CapError
│     │  ├─ policy.rs                  # PolicyEngine：plugin_id → 允许的 cap 集合
│     │  └─ audit.rs                   # AuditLog：<dataRoot>/audit/audit.jsonl
│     ├─ caps\                         # 内置能力（全部薄实现，每个 ≤400 行）
│     │  ├─ mod.rs                     # register_builtin_caps(&bus, &state)
│     │  ├─ storage.rs                 # cap.storage：会话/消息 JSONL 持久化
│     │  ├─ fs.rs                      # cap.fs：限定根目录内的读写
│     │  ├─ http.rs                    # cap.http：reqwest 转发（流式透传）
│     │  ├─ kv.rs                      # cap.kv：键值存储
│     │  ├─ config.rs                  # cap.config：应用配置读写
│     │  └─ window.rs                  # cap.window：标题/主题/关闭询问
│     ├─ plugin\
│     │  ├─ manifest.rs                # 最小 manifest 反序列化 + L1 校验
│     │  ├─ discovery.rs               # 扫描 <dataRoot>/plugins/*/plugin.json
│     │  ├─ registry.rs                # 已装插件表 + 席位汇总 + main 席位唯一性
│     │  ├─ lifecycle.rs               # enable/disable/install/uninstall
│     │  └─ service_proxy.rs           # serves 型 cap → sidecar HTTP/SSE 代理
│     ├─ shell\
│     │  ├─ window.rs                  # 主窗口创建
│     │  └─ assets.rs                  # 前端资源协议（dev 走 vite 代理，prod 走自定义协议）
│     └─ commands.rs                   # bus_invoke / bus_invoke_stream / bus_list_caps /
│                                      # plugin_list / plugin_set_enabled / plugin_install /
│                                      # plugin_uninstall / audit_tail / app_info
├─ app\                                # React 前端核心壳（重写，目标 ≤4k 行）
│  ├─ package.json                     # react / react-dom / zustand / vite / typescript
│  └─ src\
│     ├─ main.tsx                      # 初始化顺序见第 7 节
│     ├─ core\
│     │  ├─ bus.ts                     # BusClient：invoke/stream/on（封装 tauri invoke）
│     │  ├─ pluginLoader.ts            # 动态 import 插件 ESM 入口
│     │  ├─ slotRegistry.ts            # views → {main, panels, overlays, activitybar}
│     │  ├─ store.ts                   # zustand：configStore/pluginStore/uiStore
│     │  ├─ theme.ts                   # 主题 token 注入（复用 Polaris CSS 变量表）
│     │  └─ i18n.ts                    # i18n 最小实现（复用 Polaris locales 结构）
│     ├─ shell\
│     │  ├─ AppShell.tsx               # ActivityBar + MainOutlet + OverlayHost
│     │  ├─ ActivityBar.tsx            # 渲染 area='activitybar' 席位
│     │  ├─ MainOutlet.tsx             # main 席位容器：加载并 mount chat 插件
│     │  └─ OverlayHost.tsx            # 渲染 area='overlay' 插件
│     └─ types\                        # contracts 的 TS 镜像（manifest.ts / cap.ts / events.ts）
├─ plugins\                            # 全部业务以插件形态存在
│  ├─ chat-desk\                       # AI 对话插件（四段式，重写）
│  ├─ ai-engine\                       # cap.ai.chat 的实现方（sidecar）
│  ├─ files-desk\  history-desk\  settings-desk\  model-desk\  translate\  todo-desk\
│ └─（每个插件：plugin.json + src/ + 可选 server/）
└─ docs\                               # brief / baseline / schemes / judging / verdict
```

---

## 4. 核心契约（新设计的最小贡献契约）

### 4.1 最小 manifest

Polaris 现有 `PluginManifestContributes`（`src-tauri/src/models/plugin.rs:154-215`）有 **17 类贡献点**（views/overlays/panel/services/mcpServers/engines/chatCards/toolProviders/capabilities/skills/styles/hooks/configSchema/executors/adapters/uiTemplates/uiSlots）+ 约 18 个顶层字段。S2 契约砍到 **4 类贡献点 + 2 个可选入口**：

```jsonc
// plugins/chat-desk/plugin.json
{
  "id": "chat-desk",
  "version": "1.0.0",
  "main": "./dist/index.js",                 // 可选：前端面板入口（ESM，export default { mount }）
  "service": { "command": "", "port": 0 },   // 可选：后端 sidecar（本插件不需要）
  "views": [
    { "id": "chat", "area": "main", "title": "对话", "icon": "message-square", "order": 0 }
  ],
  "caps":   ["cap.ai.chat", "cap.storage", "cap.config", "cap.kv", "cap.fs"],
  "serves": [],                              // 本插件向总线提供的能力
  "events": ["chat-event", "plugin-event"]   // 允许订阅的事件主题
}
```

```jsonc
// plugins/ai-engine/plugin.json —— 能力实现方，无 UI
{
  "id": "ai-engine",
  "version": "1.0.0",
  "service": { "command": "node ./server/server.mjs", "port": 39201, "health": "/health" },
  "views": [],
  "caps":   ["cap.http", "cap.config", "cap.kv"],
  "serves": ["cap.ai.chat"],
  "events": []
}
```

TS 权威类型（`app/src/types/manifest.ts`，与 `contracts/manifest.schema.json` 同步）：

```ts
export interface PluginManifest {
  id: string;                 // ^[a-z][a-z0-9-]*$，全仓库唯一
  version: string;            // semver
  main?: string;              // 前端入口，相对插件目录
  service?: ServiceDecl;      // 后端 sidecar
  views: ViewContribution[];
  caps: string[];             // 申请调用的 cap（权限允许表，默认拒绝未声明项）
  serves: string[];           // 本插件实现并注册进总线的 cap
  events: string[];           // 允许订阅的事件主题
  settings?: SettingField[];  // 插件设置项（key/type/default）
}
export interface ServiceDecl { command: string; port: number; health?: string; }
export type ViewArea = 'main' | 'panel' | 'overlay' | 'activitybar';
export interface ViewContribution {
  id: string; area: ViewArea; title: string;
  icon?: string;              // lucide 图标名（白名单校验，复用 Polaris 规则）
  order?: number;
}
export interface SettingField { key: string; type: 'string' | 'number' | 'boolean'; default?: unknown; }
```

Rust 镜像（`core/src/plugin/manifest.rs`）：

```rust
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginManifest {
    pub id: String,
    pub version: String,
    #[serde(default)] pub main: Option<String>,
    #[serde(default)] pub service: Option<ServiceDecl>,
    #[serde(default)] pub views: Vec<ViewContribution>,
    #[serde(default)] pub caps: Vec<String>,
    #[serde(default)] pub serves: Vec<String>,
    #[serde(default)] pub events: Vec<String>,
    #[serde(default)] pub settings: Vec<SettingField>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ViewArea { Main, Panel, Overlay, Activitybar }

#[derive(Debug, Deserialize)]
pub struct ViewContribution {
    pub id: String,
    pub area: ViewArea,
    pub title: String,
    #[serde(default)] pub icon: Option<String>,
    #[serde(default)] pub order: i32,
}
```

**manifest 瘦身对照**：

| 维度 | Polaris 现状 | S2 lite |
|---|---|---|
| 贡献点种类 | 17 类 | 4 类（views / caps / serves / events）+ settings |
| 顶层字段 | ~18 个（含 origin/compat/source/dev/installPath…） | 8 个 |
| 能力声明 | capabilities[]（handler JSON、replaces、replaceMode） | serves: string[]（固定 plugin-rpc 语义） |
| 子进程声明 | services[]（restart/maxRestarts/healthCheckTimeout…） | service 单对象（command/port/health） |
| 引擎/MCP/技能/样式/钩子等 | engines/mcpServers/skills/styles/hooks/… | 全部砍除（引擎即 ai-engine 插件的 sidecar；MCP 不在 lite 范围） |
| 校验 | Rust deny_unknown_fields + 前端 zod 镜像 | JSON Schema 单源 + 双端 derive/类型镜像 |

### 4.2 cap 总线契约（Rust）

`core/src/bus/context.rs`：

```rust
#[derive(Debug, Clone)]
pub struct RequestContext {
    pub request_id: uuid::Uuid,
    pub plugin_id: String,   // 调用方（core 内置调用方为 "core"）
    pub cap: String,         // 目标能力 id，如 "cap.ai.chat"
    pub action: String,      // 动作名，如 "start"
}

#[derive(Debug, Serialize, Clone)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum StreamEvent {
    Delta  { session_id: String, delta: String },
    Tool   { session_id: String, call: serde_json::Value },
    Status { session_id: String, status: String },
    Done   { session_id: String },
    Error  { session_id: String, message: String },
}

#[derive(Debug, thiserror::Error)]
pub enum CapError {
    #[error("cap not found: {0}")]        NotFound(String),
    #[error("permission denied: plugin={plugin} cap={cap}")] Denied { plugin: String, cap: String },
    #[error("bad payload: {0}")]          BadPayload(String),
    #[error("upstream error: {0}")]       Upstream(String),
}
pub type CapResult<T> = Result<T, CapError>;
```

`core/src/bus/mod.rs`：

```rust
#[async_trait::async_trait]
pub trait Capability: Send + Sync {
    fn id(&self) -> &str;
    /// 同步式调用：返回单个 JSON 结果
    async fn invoke(&self, ctx: &RequestContext, payload: serde_json::Value) -> CapResult<serde_json::Value>;
    /// 流式调用：事件经 tx 回流；默认不支持
    fn stream(&self, _ctx: &RequestContext, _payload: serde_json::Value,
              _tx: tokio::sync::mpsc::Sender<StreamEvent>) -> CapResult<()> {
        Err(CapError::NotFound("stream unsupported".into()))
    }
}

pub struct CapBus {
    handles: tokio::sync::RwLock<std::collections::HashMap<String, std::sync::Arc<dyn Capability>>>,
    policy:  PolicyEngine,
    audit:   AuditLog,
}

impl CapBus {
    pub fn register(&self, cap: std::sync::Arc<dyn Capability>) -> CapResult<()>; // 同 id 重复注册拒绝
    pub async fn unregister(&self, cap_id: &str);
    pub async fn dispatch(&self, ctx: RequestContext, payload: serde_json::Value)
        -> CapResult<serde_json::Value>;                       // 校验→审计→invoke→审计
    pub async fn dispatch_stream(&self, ctx: RequestContext, payload: serde_json::Value,
        tx: tokio::sync::mpsc::Sender<StreamEvent>) -> CapResult<()>;
    pub async fn list_caps(&self) -> Vec<CapDescriptor>;       // id / streaming / owner
}
```

`core/src/bus/policy.rs`（权限 = manifest.caps 允许表，默认拒绝）：

```rust
pub struct PolicyEngine {
    grants: tokio::sync::RwLock<std::collections::HashMap<String, std::collections::BTreeSet<String>>>,
}
impl PolicyEngine {
    pub fn load_from_manifests(&self, manifests: &[PluginManifest]);
    pub async fn check(&self, plugin_id: &str, cap: &str) -> CapResult<()>; // 不在表内 → Denied
}
```

审计（`core/src/bus/audit.rs`）：每次 dispatch 追加一行 JSONL 到 `<dataRoot>/audit/audit.jsonl`：

```json
{"ts":"2026-11-18T09:40:00Z","request_id":"…","plugin":"chat-desk","cap":"cap.ai.chat","action":"start","ok":true,"latency_ms":12}
```

**插件 serves 的路由**（`core/src/plugin/service_proxy.rs`）：`serves` 非空的插件在 enable 时由核心生成 `ServiceProxy` 注册进总线，转发协议固定为：

```
POST http://127.0.0.1:{port}/invoke   body: {"cap":"…","action":"…","payload":{…},"ctx":{"request_id":"…","plugin":"…"}}
                                       → 200 {"ok":true,"data":{…}} | 4xx {"ok":false,"error":"…"}
POST http://127.0.0.1:{port}/stream   同 body → text/event-stream，data 行为 StreamEvent JSON
GET  http://127.0.0.1:{port}/health   → 200 "ok"
```

### 4.3 内置 cap 清单与契约（`contracts/cap-protocol.md` 摘要）

| cap | 流式 | action | 说明 |
|---|---|---|---|
| `cap.ai.chat` | 是 | `start` / `continue` / `interrupt` | 由 ai-engine serves；core 只转发 |
| `cap.storage` | 否 | `session.list` / `session.get` / `session.create` / `session.delete` / `session.append_messages` / `messages.list` | 会话与消息持久化（JSONL） |
| `cap.fs` | 否 | `read` / `write` / `list` / `mkdir` / `remove` | 限定 `<dataRoot>/user-files` 与附件目录 |
| `cap.http` | 否 | `fetch` | reqwest 转发，域白名单 |
| `cap.kv` | 否 | `get` / `set` / `remove` / `keys` | 插件命名空间隔离（key 前缀 `plugin_id:`） |
| `cap.config` | 否 | `get` / `set` / `watch` | 应用配置；插件仅可写自己的 settings 命名空间 |
| `cap.window` | 否 | `set_title` / `set_theme` / `confirm_close` | 窗口壳控制 |

`cap.ai.chat` 的调用契约（TS 侧，`contracts/cap-protocol.md`）：

```ts
type ChatInvoke =
  | { action: 'start';    sessionId: string; messages: ChatMessage[]; model?: string; tools?: string[] }
  | { action: 'continue'; sessionId: string; userInput: string }
  | { action: 'interrupt'; sessionId: string };
// 返回：{ ok: true, data: { sessionId } }；流式事件经 topic='chat-event' 回流 StreamEvent
// 中断语义：interrupt 按 sessionId 精确取消；晚到 delta 携带已取消 sessionId 时由订阅方丢弃（吸取 Polaris 中断链路教训）
```

### 4.4 前端插件契约（`app/src/types/panel.ts`）

```ts
export interface PanelContext {
    manifest: PluginManifest;
    container: HTMLElement;                 // 核心分配的挂载容器
    bus: BusClient;                         // 能力调用唯一通道
    registry: SlotRegistry;                 // 只读席位表 + 面板加载器
    ui: UiApi;                              // 主题 / i18n / 面板区激活态
}
export interface PluginPanel {
    mount(ctx: PanelContext): void | (() => void);   // 返回卸载函数
}
export interface BusClient {
    invoke<T = unknown>(cap: string, payload: unknown, opts?: { timeoutMs?: number }): Promise<T>;
    stream(cap: string, payload: unknown, onEvent: (e: StreamEvent) => void): () => void; // 返回退订
    on(topic: string, handler: (e: StreamEvent) => void): () => void;
}
export interface UiApi {
    openPanel(viewId: string): void;        // 请求把某 panel 席位显示到 chat 面板区
    activePanelId(): string | null;
    t(key: string, params?: Record<string, unknown>): string;
    theme(): 'light' | 'dark';
}
```

面板加载（`app/src/core/pluginLoader.ts`）：

```ts
export async function loadPanel(manifest: PluginManifest): Promise<PluginPanel> {
    const url = resolvePluginAsset(manifest.id, manifest.main!);
    // dev：http://localhost:5174/plugins/<id>/dist/index.js（vite 静态服务）
    // prod：tauri://localhost/plugins/<id>/dist/index.js（自定义协议，仅白名单目录）
    const mod = await import(/* @vite-ignore */ url);
    if (typeof mod.default?.mount !== 'function') throw new Error(`bad panel entry: ${manifest.id}`);
    return mod.default as PluginPanel;
}
```

---

## 5. AI 对话插件挂载（chat-desk）

**布局归属**：四段式布局整体由 chat-desk 实现，核心只给一个全幅 `main` 容器。布局一致性由 `contracts/layout-contract.md` 约定（分区顺序、`data-slot` 标记、最小/最大宽度、主题 token），并以 Polaris worktree 的 Chat 树（`.claude/worktrees/browser-desk-extraction/src/components/Chat/`）为结构参照。

```
plugins/chat-desk/
├─ plugin.json
└─ src/
   ├─ index.ts             # export default { mount(ctx) { render <ChatLayout/>; return unmount } }
   ├─ ChatLayout.tsx       # 四段式骨架（flex 布局，锁定 data-slot）
   ├─ session/             # 段1 会话侧栏：SessionList / NewSessionButton / SessionMeta
   ├─ messages/            # 段2 消息流：MessageStream / Bubble / ToolCallCard / 自动滚动
   ├─ input/               # 段3 底部输入区：ChatInput / AttachmentBar / SendButton / StopButton
   ├─ panels/              # 段4 面板区：PanelDock（tab 化渲染 area='panel' 的插件面板）
   ├─ store.ts             # zustand：sessions / messages / streaming 状态（conversationStore 瘦身版）
   └─ api.ts               # bus 封装：startChat / continueChat / interrupt / loadSessions
```

```tsx
// plugins/chat-desk/src/ChatLayout.tsx（骨架）
export function ChatLayout({ ctx }: { ctx: PanelContext }) {
  return (
    <div className="chat-root" data-layout="polaris-four-section">
      <aside   data-slot="session-sidebar" className="w-60 shrink-0 border-r"> <SessionSidebar/> </aside>
      <section data-slot="message-stream"  className="flex-1 min-w-0">      <MessageStream/> </section>
      <aside   data-slot="panel-area"      className="w-80 shrink-0 border-l"><PanelDock ctx={ctx}/> </aside>
      <footer  data-slot="input-area"      className="h-28 shrink-0 border-t"> <InputArea/>    </footer>
    </div>
  );
}
```

**挂载时序**：
1. 核心 `MainOutlet` 读取 slotRegistry，取 `area==='main'` 的唯一席位（chat-desk）；
2. `loadPanel(manifest)` 动态 import ESM 入口；
3. `panel.mount(ctx)` 渲染 ChatLayout；chat-desk 初始化：`cap.storage.session.list()` 恢复会话列表 → `bus.on('chat-event', …)` 订阅流 → 渲染。
4. 面板区 `PanelDock` 从 `ctx.registry.list('panel')` 取席位（files/history/model/translate/todo…），按 `ctx.ui.activePanelId()` 渲染对应插件面板（懒加载）。
5. ActivityBar 图标 = `area==='activitybar'` 席位；点击即 `ctx.ui.openPanel(viewId)`，消息流不变，仅面板区切 tab——保持 Polaris「对话常驻 + 面板随点随切」的交互。

**核心保证 main 席位唯一**：`core/src/plugin/registry.rs` 在 enable 时校验 `area==Main` 的启用插件至多一个，冲突则拒绝并审计记录。

---

## 6. 插件清单

| 插件 id | 席位（area） | caps（申请） | serves | 形态 | 来源/复用策略 |
|---|---|---|---|---|---|
| `chat-desk` | main + activitybar | cap.ai.chat, cap.storage, cap.config, cap.kv, cap.fs | — | 前端 | 按 Polaris Chat 四段式**重写**（参照 worktree Chat 树结构） |
| `ai-engine` | — | cap.http, cap.config, cap.kv | cap.ai.chat | sidecar | **新写**：OpenAI 兼容/Claude API 适配 + SSE→StreamEvent |
| `files-desk` | panel + activitybar | cap.fs, cap.kv | — | 前端 | 参照 Polaris files-desk **裁剪重写**（目录树 + 文本预览，无编辑器） |
| `history-desk` | panel + activitybar | cap.storage | — | 前端 | 参照 history-desk 重写（会话检索/回放） |
| `settings-desk` | overlay | cap.config, cap.window | — | 前端 | 重写（应用设置 + 各插件 settings 渲染） |
| `model-desk` | panel | cap.config, cap.http | — | 前端 | 供应商/模型配置（写 cap.config，ai-engine 读同一配置） |
| `translate` | panel | cap.http | — | 前端 | 复用 Polaris translate 插件思路，HTTP 走 cap.http |
| `todo-desk` | panel | cap.kv | — | 前端 | 极简任务清单，演示 kv 契约 |
| `welcome` | overlay | — | — | 前端 | 首启引导卡（替代 Polaris ChatMainSlot 空态） |

共 9 个插件：2 个承担关键链路（chat-desk、ai-engine），7 个演示契约覆盖面（panel/overlay/activitybar、caps、serves、settings）。

---

## 7. 启动流程

**后端（core，`main.rs`）**：
1. `logger` 初始化（tracing，文件 + stderr）；
2. 解析数据根 `<dataRoot>`（默认 `<appConfigDir>/polaris-lite`，支持 `POLARIS_LITE_DATA_ROOT` 覆盖）；
3. 构造 `CapBus`（含 PolicyEngine、AuditLog）；
4. `caps::register_builtin_caps(&bus, &state)` 注册 6 个内置能力；
5. `plugin::discovery::scan(<dataRoot>/plugins)` → 解析并校验每个 `plugin.json` → `registry.replace_installed`；
6. 对每个 enabled 插件：`policy.load_from_manifests` 授予 caps；`serves` 非空且带 `service` 的，拉起 sidecar（`/health` 探测，失败则插件标记 degraded 且不注册 serves）；
7. Tauri Builder 注册 9 个命令：`bus_invoke`、`bus_invoke_stream`、`bus_list_caps`、`plugin_list`、`plugin_set_enabled`、`plugin_install`、`plugin_uninstall`、`audit_tail`、`app_info`；开主窗口、挂前端资源协议。

**前端（app，`main.tsx`）**：
1. `initBus()`：封装 `invoke('bus_invoke' | 'bus_invoke_stream')` 与 `listen('chat-event' | 'plugin-event')`；
2. `configStore.load()`（cap.config.get）→ `theme.bootstrap()`（同步注入 CSS 变量防 FOUC）；
3. `pluginStore.load()`（plugin_list）→ `slotRegistry.rebuild(views)`；
4. `render(<AppShell/>)`：ActivityBar + MainOutlet + OverlayHost；
5. `MainOutlet` 挂载 main 席位（chat-desk）→ chat-desk 内部完成会话恢复与 chat-event 订阅；
6. 之后一切用户操作均为「插件 → bus.invoke → cap」往返，核心不再参与业务判断。

最小启动集仅 5 个模块：bus、configStore、theme、slotRegistry、AppShell——对比 Polaris main.tsx 的 8 组宿主桥注入 + useAppInit 的 10 步链（见 baseline 第 8 节）显著收窄。

---

## 8. 与 Polaris 的复用 / 差异清单

**直接复制（少量、无业务耦合的叶子资产）**：
- 主题 CSS 变量表（`.polaris-theme` token 结构）与 `themeEngine` 的注入时序思路；
- `src/i18n/` 的组织方式与现有 locale 键结构（按 lite 范围裁剪）；
- `ErrorBoundary` / `Toast` / `Modal` 等 Common 组件的精简版；
- lucide 图标白名单校验规则（参照 `plugin_service::is_supported_plugin_icon` 的枚举）。

**重写（结构参照 Polaris，代码新写）**：
- cap 总线：语义参照 `services/router/mod.rs`（dispatch/stream/审计/权限），实现从 1,786 行压到约 400 行；
- 插件生命周期：参照 `plugin_service.rs` 的发现/校验/启停流程，砍掉安装市场、dev_link、supervisor 重启树（2,904 行 → 约 1,100 行）；
- manifest 契约：参照 `models/plugin.rs` + `src/plugin-system/schema.ts`，17 类贡献点 → 4 类；
- app 壳：参照 `App.tsx` + `components/Common/Layout.tsx` 的区域划分，去掉 CenterStage/LeftPanelTabStrip 等多席位复杂度；
- chat-desk：参照 Polaris Chat 四段式（session/messages/input/panels）重写，业务上仅保留纯对话必需链路。

**放弃（不进入 lite）**：
- `services/supervisor/`（2,169 行进程托管树）、`mcp_config_service.rs`（1,874 行）、MCP 全链路；
- `ai/engine/claude.rs`、`ai/engine/simple_ai/`（10k+ 行内置引擎）——由 ai-engine 插件 sidecar 替代；
- `services/proxy/`（5,039 行）、`storage_exec/`（4,964 行，改用 JSONL 薄存储）、`computer_control/`、`nexus_pipeline/`、`form/`、`ask_listener/`；
- 前端 `CenterStage`/编辑器/SCM/终端等席位与相关 stores（fileExplorerStore 804 行、fileEditorStore 587 行、tabStore 500 行等）；
- PWA、多窗口（isCompact）、性能热切换等外围机制。

**前端栈迁移成本**：同为 React + Zustand + Vite + TypeScript，无框架迁移；成本集中在①插件从 Blob-URL import 重写改为直接 ESM import；②appCoreBridge 的 21 个 store 共享被废除，插件只拿 `PanelContext`（bus/registry/ui），需要逐插件改接；③conversationStore 11,383 行瘦身为 chat-desk 内 store（约 1.5k 行）。

---

## 9. 裁剪量化表

| 模块 | Polaris 现状（行） | S2 lite 目标（行） | 处置 |
|---|---|---|---|
| 后端总计 | 101,032（250 文件） | **≈5,200** | 重写 |
| ├ router 总线 | 1,786 + 39 capability 文件 | ≈1,100（bus + 6 内置 cap） | 重写 |
| ├ plugin_service | 2,904 | ≈1,100 | 重写 |
| ├ ai_chat_core + 引擎 | ≈13,000+ | 0（core 内）→ ai-engine sidecar ≈2,200 | 外移 |
| ├ storage_exec / proxy | ≈10,000 | ≈650（JSONL 薄存储 + http 转发） | 重写/外移 |
| ├ 其余 commands/services | ≈70,000 | ≈350（9 个命令 + 壳） | 放弃 |
| 前端核心（app/） | 49,794（279 文件） | **≈3,800** | 重写 |
| ├ 壳与席位系统 | ≈6,000 | ≈1,700 | 重写 |
| ├ stores/services | ≈20,000 | ≈900 | 重写 |
| ├ types/utils | ≈10,000 | ≈700 | 重写 |
| chat-desk 插件 | 23,763（Polaris-plugin 仓） | ≈11,000 | 重写 |
| 其余插件（8 个） | — | ≈9,000 | 新写/裁剪 |
| **合计** | **≈174,600** | **≈29,000（-83%）** | |

- 核心侧（core + app）≈ **9,000 行**，占 Polaris 主仓（150,826 行）的 **6%**，满足「核心零业务 + 显著更小」。
- 依赖面：保留 `react / react-dom / zustand / vite / typescript / tauri / tokio / serde / reqwest / uuid / tracing`；砍除 monaco、xterm、mermaid、echarts、tanstack 等重依赖（随对应域出仓）。
- 启动链路：后端 7 步、前端 5 步；Tauri 命令 36 → 9；cap 数量 ~30 → 7 内置 + 插件 serves。

---

## 10. 迁移步骤

| 阶段 | 交付物 | 验证门槛 |
|---|---|---|
| P0 契约冻结 | `contracts/` 三份契约 + manifest.schema.json + layout-contract | 契约评审通过；schema 可校验 9 个示例 plugin.json |
| P1 核心骨架 | core 可编译运行：窗口 + bus_invoke/bus_invoke_stream + audit JSONL | `cargo check` 通过；curl 级自测 echo cap |
| P2 内置能力 | cap.storage/fs/http/kv/config/window 六能力 | 每能力一个 Rust 单测（jsonl 读写、fs 越界拒绝、policy 默认拒绝） |
| P3 插件生命周期 | discovery/registry/lifecycle + 9 命令 | 安装/启用/禁用/卸载 todo-desk 走通；main 席位唯一性校验生效 |
| P4 app 壳 | bus.ts / pluginLoader / slotRegistry / AppShell | `pnpm exec tsc --noEmit` 通过；空 chat 占位渲染 |
| P5 ai-engine | sidecar：cap.ai.chat start/continue/interrupt + SSE | 用假模型 echo 服务联调，流式事件、中断幂等用例通过 |
| P6 chat-desk | 四段式布局 + 会话/消息/输入/面板区 | 与 Polaris 现状截图对照布局一致；一轮真实对话（含中断）走通 |
| P7 业务插件 | files/history/settings/model/translate/todo/welcome | 每插件可独立启停；禁用后主界面降级不崩溃 |
| P8 收尾 | 审计查询、错误边界、打包脚本 | 独立构建产物可运行；不依赖 Polaris 仓任何文件 |

依赖关系：P1→P2→P3 串行；P4 依赖 P1；P5 依赖 P2；P6 依赖 P3+P4+P5；P7 依赖 P6。全程不改 `D:\space\base\Polaris` 任何文件。

---

## 11. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| TS/Rust 双写契约漂移（Polaris 已知无运行时 schema 校验） | 插件与核心对不上 | JSON Schema 单源；CI 跑「9 个示例 plugin.json 过 schema + Rust 反序列化 + TS 类型生成」三方一致性测试 |
| ai-engine sidecar 的流式/中断复杂度（Polaris 有晚到 stop、中断误杀前科） | 对话体验损坏 | request_id 贯穿全链；interrupt 按 sessionId 精确取消并广播 `Status{cancelled}`；订阅侧对已取消会话的晚到 delta 直接丢弃；先以假模型服务建立中断回归用例 |
| 四段式布局保真不足 | 违反 P2 硬约束 | layout-contract 固定 `data-slot` 与区域顺序；P6 阶段与 Polaris Chat 截图逐区对照；布局改动需改契约 |
| 插件 ESM 动态加载的安全与路径问题（prod 无 vite 服务） | 插件装不上或越权 | 仅允许 `<dataRoot>/plugins` 白名单目录；prod 走 Tauri 自定义协议映射该目录；加载前过 manifest 校验 |
| sidecar 简化后缺健康自愈 | ai-engine 挂死对话不可用 | `/health` 周期探测；失败标记 degraded 并在 UI 提示重启；审计记录每次拉起/失败；不做复杂重启树（保持核心薄） |
| 单 main 席位竞争（多个插件想当主界面） | 布局被抢占 | registry 启用时强制校验 main 唯一，冲突拒绝并审计；契约中写明 main 席位归属规则 |
| localStorage/JSONL 并发写损坏 | 会话丢失 | 单写者原则：会话写只经 cap.storage（core 串行化）；追加写采用「整文件重写 + 临时文件原子替换」 |

---

## 12. 硬性约束对照（自检）

| brief 约束 | 本方案落点 |
|---|---|
| 1. 布局 = Polaris 四段式 | chat-desk ChatLayout 锁定 session-sidebar / message-stream / input-area / panel-area 四区，契约文件 `layout-contract.md` 固化 |
| 2. 核心零业务 | core 目录仅 bus/caps(通用)/plugin/shell；目录白名单见第 3 节，AI 引擎、会话 UI、文件面板全在外 |
| 3. AI 对话 UI 与业务面板均为插件 | chat-desk（main 席位）与 7 个 panel/overlay 插件，统一走 manifest.views + PluginPanel.mount 契约 |
| 4. 保留 cap 总线思想 | CapBus.dispatch/dispatch_stream：权限（默认拒绝）→ 审计（JSONL）→ 转发；组件不直连后端 |
| 5. 前端栈与迁移成本 | React+Zustand+Vite 原栈；成本见第 8 节三条 |
| 6. 规定章节 | 架构图§2 / 目录树§3 / 契约§4 / 挂载§5 / 插件清单§6 / 启动§7 / 复用差异§8 / 量化§9 / 迁移§10 / 风险§11 |
| 7. 复制/重写/放弃清单 | §8 三清单逐项可查 |
| P8 独立于 Polaris | 独立仓库、独立构建；仅复制叶子资产与结构参照，无 Polaris 文件改动、无运行时依赖 |
