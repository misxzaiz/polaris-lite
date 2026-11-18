# S1 微核直译：复制 Polaris 壳的轻量直译版

> 矩阵第 1 格：**核心形态 = 复制 Polaris 壳后删业务；AI 对话 UI = 复用 Polaris Chat 组件作为首个内置插件；插件机制 = 沿用 Polaris plugin-system 原样；前端栈 = React + Zustand 原栈。**
>
> 一句话主张：不重新设计任何架构——把 Polaris 的壳（cap 总线 + plugin-system + 布局壳 + AI 调度链）原样复制到 `D:\space\base\polaris-lite`，用"删除清单"把业务域砍掉，再把 worktree 里保留的完整 Chat 组件树（104 文件 / 26,904 行）打包成第一个内置插件 `lite-chat`。它是十案中迁移成本最低、与 Polaris 行为最一致的一案，代价是核心保留体量在十案中偏大。

---

## 1. 架构图（文字图）

```
┌─────────────────────────────── polaris-lite 独立仓库（Tauri + React + Rust）───────────────────────────────┐
│                                                                                                             │
│  ┌──────────────────────────── 前端壳（src/，React + Zustand 原栈，~13k 行目标）────────────────────────┐  │
│  │  main.tsx（宿主桥：__POLARIS_APP_CORE__ / __POLARIS_HOST_INVOKE__ 白名单 / chat-event 过滤 listen）   │  │
│  │  App.tsx：useAppInit(配置→插件发现→registry.replaceInstalled→样式→服务自启) → Layout 壳                │  │
│  │                                                                                                       │  │
│  │  Layout（四段式骨架，与 Polaris 现状逐一对位）：                                                        │  │
│  │   TopMenuBar ─ ActivityBar(席位=pluginRegistry.listViewContributions('activityBar'))                   │  │
│  │             ┬ LeftPanel + TabStrip（files/terminal/... 席位全部 = PluginSlotPlaceholder 空态）         │  │
│  │             ├ CenterStage（tab 壳，lite 默认无内置 tab 内容）                                          │  │
│  │             └ RightPanel ← getMainSurfaceClaim() 命中 → PluginPanelHost(panelType)  ←★对话主区        │  │
│  │                └ 未命中 → ChatMainSlot 空态引导卡                                                       │  │
│  │  plugin-system（原样复制）：registry / panelRegistry / schema / pluginModuleLoader(Blob import)         │  │
│  │                            / uiContributions / chatCardRegistry / styles / appCoreBridge(收窄)          │  │
│  │  stores（8 个通用 store）：config / workspace / view / overlay / toast / plugin / theme / capCatalog   │  │
│  │  services：transport(tauri+http) / eventBus / aiEventBus(chat-event 管道) / themeEngine / i18n         │  │
│  │            / pluginDiscoveryService（业务 store 与工具组件全部删除 → 归插件）                            │  │
│  └───────────────┬───────────────────────────────────────────────────────────────────────────────────────┘  │
│                  │ invoke('router_dispatch' | 'router_dispatch_stream')          ↑ listen('chat-event')      │
│  ┌───────────────▼──────────── 后端壳（src-tauri/，~42k 行目标）─────────────────────────────────────────┐  │
│  │  commands/router.rs：router_dispatch / router_dispatch_stream / router_list_caps / audit_tail|verify   │  │
│  │  RouterBus（services/router/mod.rs 原样）：Envelope → Permission gate(PolicyPermission) → 审计          │  │
│  │      → Capability.invoke / StreamingCapability.invoke_stream → EventAdapter → EventBroadcaster(WS)     │  │
│  │  保留 ~26 个 cap：cap.ai.chat / cap.session / cap.history / cap.storage / cap.config / cap.kv           │  │
│  │      / cap.fs / cap.http / cap.bash / cap.mcp / cap.hook / cap.context / cap.data_root / cap.registry   │  │
│  │      / cap.ui.{render,chat,input,theme} / cap.terminal / cap.plugin* / cap.meta|help|usage / cap.dyn.*  │  │
│  │  AI 调度核（P4"AI 引擎调度接口"，保留）：ai_chat_capability(cap.ai.chat, streaming) → ai_chat_core      │  │
│  │      → EngineRegistry（trait + ClaudeEngine 内置；SimpleAI 引擎经插件 engines[] 注册）                   │  │
│  │  会话存储：storage_exec（session_db / turn_persist）+ storage_capability                                 │  │
│  │  插件生命周期：plugin_service(发现/安装/校验) + supervisor(服务进程) + plugin_capability_assembly         │  │
│  │  web/（server / auth / event_broadcaster / api/ipc.rs —— 保留 Web 部署形态）                             │  │
│  │  删除：git/browser/files/terminal 命令域、computer_control、nexus、ask_listener、form、app_update 等     │  │
│  └───────────────────────────────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                                             │
│  ┌────────────────────────────── 插件层（Polaris-plugin 范式，目录 + plugin.json）──────────────────────┐  │
│  │  lite-chat（★首个内置插件，core:true）：复制 worktree 的 Chat 组件树 + conversationStore + session-v2   │  │
│  │      + ai-runtime；area=mainSurface slot=chat.main slotMode=shadow；permissions.chatEvents=full        │  │
│  │  lite-settings（settings 席位）/ lite-history（session-history overlay）/ lite-model（供应商管理台）    │  │
│  │  engine-simpleai（SimpleAI 引擎侧车进程，engines[] + services[] 贡献，PiRpc 经 PluginEngineRunner）     │  │
│  │  sample-hello（开发者样例：activityBar 席位 + 自定义 cap，验证插件通路）                                 │  │
│  └───────────────────────────────────────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

事件顺序（对话一问一答）：`lite-chat 输入区 submit → chatDispatch('start', {message}) → router_dispatch(cap.ai.chat) → 权限 gate → ai_chat_core → EngineRegistry → 引擎 → ChatCallbacks → EventBroadcaster 'chat-event' → 前端 aiEventBus 分级过滤 → conversationStore.eventHandler → 消息流渲染`。与 Polaris 现状链路完全同构，仅"UI 提供方"从内置组件换成了插件面板。

---

## 2. 核心目录树

```
polaris-lite/
├─ package.json / vite.config.ts / tsconfig.json     # 原栈：React18 + Zustand + Vite + tailwind
├─ src/                                              # 前端壳（目标 ≤13,000 行）
│  ├─ main.tsx                                       # 复制 Polaris main.tsx，收窄宿主桥
│  ├─ App.tsx                                        # 复制后删业务席位分支，保留 mainSurface/settings/overlay 消费点
│  ├─ plugin-system/                                 # ★原样复制（registry/panelRegistry/schema/pluginModuleLoader/
│  │                                                 #  types/uiContributions/chatCardRegistry/uiTemplateRegistry/
│  │                                                 #  styles/iconResolver/appCoreBridge/sessionHostApi）
│  ├─ components/
│  │  ├─ Common/                                     # Layout/Modal/Toast/ErrorBoundary/RightSlideOver/PermissionPromptHost
│  │  ├─ Layout/                                     # ActivityBar/LeftPanel/CenterStage/RightPanel/ChatMainSlot（壳）
│  │  └─ Plugins/PluginPanelHost.tsx                 # 面板宿主（原样）
│  ├─ stores/                                        # 仅 8 个通用 store（业务 store 全删）
│  ├─ services/
│  │  ├─ transport/                                  # tauri/http/auth/detector（原样）
│  │  ├─ eventBus.ts / aiEventBus.ts / themeEngine.ts / pluginDiscoveryService.ts / i18n/
│  ├─ hooks/                                         # useAppInit / useAppEvents / useWindowManager / usePluginServiceSync
│  ├─ types/                                         # session.ts、plugin、config、event（aiEvent.ts 移入 lite-chat 插件）
│  └─ i18n/ locales/
├─ src-tauri/                                        # 后端壳（目标 ≤42,000 行）
│  ├─ src/contracts/                                 # mod.rs 原样（Envelope/Reply/Capability/Router/Permission…）
│  ├─ src/services/router/                           # mod.rs + 保留的 capability 文件（~26 个）
│  ├─ src/services/ai_chat_core/                     # 对话编排核（start/continue/interrupt/ask/plan/attachments）
│  ├─ src/services/ai_chat_capability.rs             # cap.ai.chat（streaming）
│  ├─ src/ai/                                        # registry.rs + traits + engine/claude.rs（默认引擎）
│  ├─ src/services/storage_exec/                     # 会话/消息存储（session_db/turn_persist/dialog_index）
│  ├─ src/services/plugin_service.rs + supervisor/ + plugin_capability_assembly.rs
│  ├─ src/services/{config_store,data_root,logger,error}.rs + state.rs + lib.rs
│  ├─ src/web/                                       # server/auth/event_broadcaster/api/ipc.rs（Web 形态保留）
│  └─ src/commands/                                  # 仅 router.rs + 插件域 + 少量基础命令（~18 个）
├─ plugins/                                          # 内置插件源（构建期随包分发）
│  ├─ lite-chat/                                     # plugin.json + dist/panel.js + assets/
│  ├─ lite-settings/  ├─ lite-history/  ├─ lite-model/
│  ├─ engine-simpleai/                               # SimpleAI 引擎侧车（Rust bin + PiRpc）
│  └─ sample-hello/
└─ docs/                                             # brief / baseline / schemes / judging / verdict
```

---

## 3. 核心契约（签名级）

S1 的契约**全部照抄 Polaris 现行定义**，不改一个字节——这是"直译"的含义：契约即兼容性。

### 3.1 Rust 总线契约（`src-tauri/src/contracts/mod.rs`，原样复制）

```rust
pub struct CapabilityId(pub String);
pub struct MsgId(pub String);
pub struct TraceId(pub String);

pub struct Envelope {          // 统一信封：所有来源标准化成此结构
    pub id: MsgId,
    pub source: Source,        // 传输层注入，调用方不可自填
    pub target: CapabilityId,
    pub payload: serde_json::Value,
    pub trace: TraceId,
}

pub struct Reply {
    pub msg_id: MsgId,
    pub result: Result<serde_json::Value, String>,
    pub trace: TraceId,
    pub error_detail: Option<ReplyErrorDetail>,   // {code, kind, stderrSnip}
}

pub trait Capability: Send + Sync {
    fn id(&self) -> CapabilityId;
    fn invoke(&self, params: Value, ctx: &dyn Context) -> Result<Value, String>;
    fn dependencies(&self) -> Vec<CapabilityId>;
    fn describe(&self) -> Value { Value::Null }   // standard_describe 形状：{id,name,summary,actions}
    fn drain(&self) -> Result<(), String> { Ok(()) }
}

pub trait StreamingCapability: Capability {       // 流式能力平行表
    fn invoke_stream(&self, params: Value, ctx: &dyn Context)
        -> Result<tokio::sync::mpsc::Receiver<Event>, String>;
}

pub trait Router: Send + Sync {                   // RouterBus 的实现契约
    fn dispatch(&self, env: Envelope) -> Result<Reply, String>;
    fn subscribe(&self, filter: Filter) -> tokio::sync::mpsc::Receiver<Event>;
    fn register_handle(&self, cap: Box<dyn Capability>) -> Result<CapabilityHandle, String>;
}

pub trait Permission: Send + Sync {               // PolicyPermission 实现
    fn check(&self, req: &PermissionRequest) -> Result<PermissionVerdict, String>;
}
pub enum PermissionVerdict { Allow, Deny, Prompt }
```

### 3.2 Tauri 命令入口（`src-tauri/src/commands/router.rs`，原样复制）

```rust
pub struct RouterDispatchRequest { pub target: String, pub payload: serde_json::Value }
pub struct RouterDispatchResponse { pub msg_id: String, pub ok: bool,
    pub result: Option<serde_json::Value>, pub error: Option<String>,
    pub trace: String, pub error_detail: Option<ReplyErrorDetail> }

#[tauri::command]
pub async fn router_dispatch(webview: tauri::Webview, state: tauri::State<'_, AppState>,
    req: RouterDispatchRequest) -> Result<RouterDispatchResponse>;
#[tauri::command]
pub async fn router_dispatch_stream(/* 同参 */) -> Result<RouterDispatchStreamResponse>;
#[tauri::command] pub async fn router_list_caps(...)  -> Result<Vec<CapabilityInfo>>;
#[tauri::command] pub async fn audit_tail / audit_verify / respond_permission_request(...);
```

### 3.3 cap.ai.chat 动作表（`services/router/ai_chat_capability.rs`，原样保留）

`STREAM_ACTIONS = ["start", "continue"]`；同步动作：`interrupt / send_input / approve_plan / reject_plan / answer_question / respond_plugin_card / register_pending_question / register_pending_plan / get_pending_plans / clear_processed_plans`。入参示例：`{action:"start", message:string, sessionId?, profileId?, attachments?}`；流式事件经 `EventBroadcaster` 以 `chat-event` 广播（payload = `AIEvent`，Rust 权威定义 `models/ai_event.rs`，前端类型随 lite-chat 插件携带）。

### 3.4 前端插件契约（`src/plugin-system/types.ts` + `registry.ts` + `panelRegistry.ts`，原样复制）

```ts
export type PluginViewArea = 'activityBar' | 'mainSurface' | 'settings' | 'notificationOverlay'
export type PluginViewSlotMode = 'append' | 'shadow' | 'chain'

export interface PluginViewContribution {
  id: string; pluginId: PluginId; area: PluginViewArea
  panelType: string; icon: PluginIconValue; labelKey: string; labelDefault?: string
  order: number; slot?: string; slotMode?: PluginViewSlotMode
}
export interface PluginOverlayContribution { id: string; slot: string; panelType: string; mode?: 'shadow' }
export interface PluginPanelContribution { entry: string; supportsFullscreen?: boolean }
export interface PluginCapabilityContribution { id: string; summary: string;
  handler: { type: 'forward' | 'plugin-rpc'; /* … */ }; replaces?: string; replaceMode?: ReplaceMode }
export interface PluginEngineContribution { /* engines[]：id/adapter/serviceRef… */ }

export interface PolarisPluginManifest {
  id: PluginId; name: string; version: string; description?: string
  builtin: boolean; enabledByDefault: boolean; core?: boolean
  contributes: { views?; overlays?; panel?; services?; mcpServers?; engines?;
                 capabilities?; hooks?; styles?; chatCards?; configSchema?; uiSlots? }
  permissions: PluginPermissionDeclaration   // 含 chatEvents: 'full'|'lifecycle'|'none'
  origin?; source?; dev?; installPath?
}

export type PluginPanelComponent = ComponentType<{
  pluginId: string
  onSendToChat?: (message: string) => void | Promise<void>
  onClose?: () => void
}>
export type PluginPanelLoader = () => Promise<{ default: PluginPanelComponent }>

// registry.ts（单例 pluginRegistry）
replaceInstalled(manifests: PolarisPluginManifest[]): Promise<void>
listViewContributions(area: PluginViewArea): PluginViewContribution[]
getMainSurfaceClaim(): (PluginViewContribution & { pluginId: string }) | undefined
getOverlayClaim(slotId: string): (PluginOverlayContribution & { pluginId: string }) | undefined

// panelRegistry.ts（单例 pluginPanelRegistry）
register(panelType: string, pluginId: string, loader: PluginPanelLoader): void
load(panelType: string): Promise<PluginPanelComponent>   // Blob URL 动态 import，同窗口同源
```

### 3.5 引擎注册契约（`src/ai/registry.rs`，原样保留）

```rust
impl EngineRegistry {
    pub fn register(&mut self, engine: Box<dyn AIEngine>);
    pub fn set_default(&mut self, id: EngineId) -> Result<()>;
    /// 插件经 engines[] 贡献 + register_plugin_engine 命令动态注册
    pub fn register_plugin_engine(&mut self, config: PluginEngineConfig) -> Result<()>;
    pub fn unregister_plugin_engine(&mut self, engine_id: &str) -> Result<()>;
}
```

---

## 4. AI 对话插件如何挂载（lite-chat）

**来源**：直接复制 `.claude/worktrees/browser-desk-extraction/src/components/Chat/`（104 文件 / 26,904 行，含 `session/`会话侧栏、`messages/`消息流、`input/`输入区、`chatBubbles/`、`tool-calls/`、`dynamic-island/` 面板区——四段式布局原封不动），连同其运行依赖 `stores/conversationStore/`（33 文件 / 11,383 行）、`session-v2/`（~1,557 行）、`ai-runtime/`（16 文件）、`utils/toolConfig.ts / toolSummary.ts / toolInputExtractor.ts / messageCompactor.ts`、`types/aiEvent.ts / types/chat.ts` 一并打包进插件目录。**UI 代码零改写**，只把"从 `@/…` 导入宿主模块"改为"从宿主桥 `window.__POLARIS_APP_CORE__` 解构 + 插件内相对导入"。

**plugin.json**（`plugins/lite-chat/plugin.json`）：

```json
{
  "id": "polaris.lite-chat",
  "name": "Lite Chat",
  "version": "0.1.0",
  "builtin": true,
  "enabledByDefault": true,
  "core": true,
  "manifestVersion": "1.0",
  "contributes": {
    "views": [{
      "id": "lite-chat.main", "area": "mainSurface", "panelType": "lite-chat/main",
      "icon": "Bot", "labelKey": "chat.title", "order": 0,
      "slot": "chat.main", "slotMode": "shadow"
    }],
    "panel": { "entry": "./dist/panel.js", "supportsFullscreen": false },
    "chatCards": [],
    "hooks": [{ "id": "ai.session.start", "capId": "cap.lite-chat.session-hook" }],
    "capabilities": [{ "id": "cap.lite-chat.session-hook", "summary": "会话启动钩子回调",
                       "handler": { "type": "plugin-rpc" } }]
  },
  "permissions": { "appConfigRead": true, "chatEvents": "full" }
}
```

**挂载链路**（全部走既有机制，无新代码路径）：

1. 宿主 `useAppInit` → `discoverInstalledPlugins()` 发现 `plugins/lite-chat` → `pluginRegistry.replaceInstalled([...])`；
2. `App.tsx` 中 `pluginRegistry.getMainSurfaceClaim()` 命中 `area:'mainSurface'`、`panelType:'lite-chat/main'`，且 `isPluginUiEnabled(pluginStates, 'polaris.lite-chat')` 为真 → 渲染 `<PluginPanelHost panelType="lite-chat/main">`（懒加载）；
3. `PluginPanelHost` → `pluginPanelRegistry.load('lite-chat/main')` → `pluginModuleLoader` 读插件 `dist/panel.js` → Blob URL 动态 `import()` → 挂载聊天根组件（复用宿主 React 实例：`__POLARIS_HOST_REACT__`）；
4. 插件 bootstrap：初始化自带 conversationStore/session-v2，经 `__POLARIS_HOST_LISTEN__`（chat-event 三级过滤）订阅事件，经 `__POLARIS_HOST_INVOKE__('router_dispatch', …)` 调 `cap.ai.chat`；会话持久化走 `cap.session/cap.history/cap.storage`；配置选择器元数据走白名单内 `get_engine_metadata_list / cli_get_agents / simple_ai_list_agents` 等只读命令；
5. 插件禁用/卸载 → `getMainSurfaceClaim()` 落空 → `ChatMainSlot` 空态引导卡（与 Polaris 现状行为一致，天然回滚）。

**与 Polaris 的差异**：Polaris 的真实对话 UI 在外部 chat-desk 插件（23,763 行，多会话网格等增强）；S1 的 lite-chat 是把**主分支删除前的内置 Chat 树**插件化，功能面 = Polaris 灰度前的原生对话体验，更小但不支持 chat-desk 的多会话网格等增值特性。

---

## 5. 插件清单

| 插件 id | 形态 | 贡献点 | 状态 |
|---|---|---|---|
| `polaris.lite-chat` | 内置 core 插件 | `mainSurface` 席位（四段式对话 UI）+ 1 个 hook 回调 cap | 必装，随包分发 |
| `polaris.lite-settings` | 内置插件 | `settings` 席位（覆盖层设置页，读 `cap.config`） | 必装 |
| `polaris.lite-history` | 内置插件 | `overlays[]` 接管 `session-history` 抽屉（`cap.history`） | 选装 |
| `polaris.lite-model` | 内置插件 | `activityBar` 席位：供应商/Profile 管理台（`cap.config` + 用量命令） | 选装 |
| `polaris.engine-simpleai` | 引擎侧车插件 | `engines[]` + `services[]`（stdio 子进程，PiRpc 经 `PluginEngineRunner` 注册进 EngineRegistry） | 选装（不装则仅 ClaudeEngine 可用） |
| `polaris.sample-hello` | 样例 | `activityBar` 席位 + 自定义 `cap.hello`（DynamicHandler），作为开发者模板 | 选装 |

业务扩展（git、浏览器、终端桌面等）一律按此范式放 `Polaris-plugin` 生态仓，核心不预置。

---

## 6. 启动流程

**Rust 侧**（`src-tauri/src/lib.rs` 精简版 `run()`）：

1. `Logger::init` → `ConfigStore::new` → `data_root()` 解析（沿用 `POLARIS_DATA_ROOT`/锚点链约定）；
2. 构造 `RouterBus::new(EventAdapter, PolicyPermission, Some(storage), Some(FileAuditSink))`，装配 `PermissionPromptRegistry`；
3. 注册保留的 ~26 个内置 capability（含 `AiChatCapability` 走 `register_streaming`）；
4. `EngineRegistry::new()` + `register(ClaudeEngine)` + `set_default`（SimpleAI 由插件运行期 `register_plugin_engine` 注入）；
5. `plugin_service::discover_installed_plugins` → `sync_plugin_capabilities`（插件 cap 注册为 DynamicHandler）→ `ServiceSupervisor` 自启 `autoStart` 服务；
6. `tauri::Builder`（feature `tauri-app`）注册 ~18 个命令；Web 形态由 `polaris-web` bin 走 `web/` HTTP 桥（`api/ipc.rs`）。

**前端侧**（`src/main.tsx`）：

1. `installAppCoreBridge()`——挂 `__POLARIS_APP_CORE__`（收窄为 8 个 store + 通用 service）；
2. 挂宿主桥：`__POLARIS_HOST_REACT__/REACT_DOM/USE_TRANSLATION__`、`__POLARIS_HOST_INVOKE__`（白名单缩减到 ~20 个：router_dispatch(_stream)、plugin_*、message_read、health_check、engine/agent 元数据只读组、附件三命令、用量组）、`__POLARIS_HOST_LISTEN__`（chat-event 分级过滤）、`__POLARIS_SEND_TO_CHAT__`、`__POLARIS_SESSION_API__`；
3. `bootstrapTheme()`（render 前注入 CSS 变量防 FOUC）；
4. `createRoot(#root).render(<RootApp/>)` → `useAppInit`：`loadConfig → pluginStore.loadPluginStates → workspaceStore.syncFromServer → themeStore.syncFromRemote → discoverInstalledPlugins → pluginRegistry.replaceInstalled → applyPluginStyles → pluginServiceManager.autoStartAll`；
5. `App.tsx` 渲染四段式 Layout；`getMainSurfaceClaim()` 命中 lite-chat → 加载对话插件面板。

---

## 7. 与 Polaris 的复用 / 差异清单（复制 / 重写 / 放弃）

| 处置 | 对象（Polaris 路径 → lite 路径） | 说明 |
|---|---|---|
| **原样复制** | `src-tauri/src/contracts/mod.rs`、`services/router/mod.rs`、`commands/router.rs` | 总线契约零改动 |
| **原样复制** | `src/plugin-system/`（registry/panelRegistry/schema/pluginModuleLoader/types/uiContributions/chatCardRegistry/styles/iconResolver/appCoreBridge/sessionHostApi） | 插件机制原样 |
| **原样复制** | `services/plugin_service.rs`、`supervisor/`、`plugin_capability_assembly.rs`、`plugin_events.rs`、`plugin_state_service.rs` | 插件生命周期原样 |
| **原样复制** | `web/`（server/auth/event_broadcaster/api/ipc.rs）、`config_store/data_root/logger/error` | 平台基础设施 |
| **原样复制** | `services/ai_chat_core/`、`ai_chat_capability.rs`、`ai/registry.rs + traits + engine/claude.rs`、`storage_exec/`、`models/ai_event.rs` | AI 调度接口与默认引擎、会话存储（P4 核心职责） |
| **复制后裁改** | `App.tsx`(522→~380)、`main.tsx`(251)、Layout 壳组件、`lib.rs`(1,241→~700)、`state.rs`(1,036→~700) | 删业务席位/命令注册/引擎外的域初始化 |
| **复制后裁改** | 保留的 ~26 个 capability 文件 | 删各文件内业务动作分支（如 config 里的域配置段） |
| **移动→插件** | worktree `src/components/Chat/**` + `stores/conversationStore/**` + `session-v2/**` + `ai-runtime/**` + `utils/tool*` + `types/aiEvent.ts/chat.ts` | 打包为 `polaris.lite-chat`，UI 代码不改，仅改模块解析方式 |
| **移动→插件** | `ai/engine/simple_ai/`（~10,153 行）+ `simple_ai_protocol/` | 打包为 `engine-simpleai` 侧车，经 engines[] 注册 |
| **移动→插件** | settings-desk / history-desk / model-desk 的面板代码 | 以 lite-* 名义收录（从 `Polaris-plugin/plugins/` 复制适配） |
| **重写（少量）** | `plugins/lite-chat/plugin.json`、`vite.config.ts` 插件构建段、`package.json`、`tauri.conf.json` | 新写但极薄 |
| **放弃（删除）** | `commands/file_explorer.rs(1,227)/terminal/file_watcher/file_clipboard/agent_corpus/nexus/claude_settings/dialog_storage`；`services/computer_control(934)/ask_listener(1,898)/nexus_pipeline(1,108)/form(1,586)`；浏览器/翻译/IM 域残留 | 业务域不出现在核心 |
| **放弃（删除）** | `stores/fileExplorerStore(804)/fileEditorStore(587)/tabStore(500)/editorSettingsStore/editorContextStore/schedulerStoreUtils`；`components/Preview、UiFrame、JsonTreeView(632)`；`plugin-system/editor*`（SCM 集成）；`utils/mermaid-config(417)` | 前端业务残留 |
| **放弃（删除）** | `cap.app.update`、`cap.app.autolaunch`、`cap.self.mutate`、demo/echo/faulty 测试能力；PWA/SW 注册段 | lite 不需要的平台面 |
| **放弃** | chat-desk 的多会话网格/QuickSwitchPanel 等增强（23.7k 行不收编） | 保持 lite-chat 精简；需要时按插件生态另行收录 |

**迁移成本说明**：S1 的成本结构是"删除劳务 + 打包接线"，不是"重新设计"。估算：删除与壳裁剪约 3~5 人日；Chat 树插件化（模块解析改桥、Blob 构建脚本、宿主桥收窄回归）约 5~8 人日；SimpleAI 引擎侧车化（PiRpc 包装 + engines[] 接线）约 3~5 人日；settings/history/model 插件收录与联调约 3~5 人日；合计 **2~4 人周**即可得到可构建运行的 lite 版——十案中最低。前端栈零切换（React+Zustand+Vite 原样），无学习成本。

---

## 8. 裁剪量化表（对照 baseline 第 6 节）

| 指标 | Polaris 基线 | S1 核心目标 | 削减 | 外置去向 |
|---|---|---|---|---|
| `src/` TS+TSX 行数 | 49,794（279 文件） | **≤ 13,000（约 110 文件）** | -74% | lite-chat ~40,000 行；lite-settings/history/model ~6,000 行 |
| `src-tauri/src/` Rust 行数 | 101,032（250 文件） | **≤ 42,000（约 150 文件）** | -58% | engine-simpleai ~11,000 行（侧车进程） |
| **核心合计** | **150,826** | **≤ 55,000** | **-64%** | — |
| Zustand store 模块 | 27 个非测试 | 8 个 | -70% | conversationStore 等 3+ 个随 lite-chat |
| Tauri commands | 36 | ~18 | -50% | 业务命令随域删除 |
| RouterBus capability | 34 impl / ~30 id | ~26 impl / ~24 id | -24% | demo/echo、app.update、self.mutate 等删除 |
| 最大后端文件 | plugin_service.rs 2,904 | 同为 plugin_service.rs 2,904（保留） | 0 | 直译策略不拆大文件 |
| 对话 UI 归属 | 内置（已删）→ chat-desk 插件 23,763 行 | 核心零对话 UI；lite-chat 内置插件 ~40,000 行 | 布局不变 | Chat 树 26,904 + conversationStore 11,383 + session-v2 1,557 |

> 诚实备注：受"直译"定位约束，核心保留体量在十案中偏大（尤其 `ai_chat_core` 3,042 + `proxy` 5,039 + `storage_exec` 4,964 + plugin_service 2,904）。本方案不虚报"6-8k 微核"——那是重写派（S2）的空间；S1 用约 55k 核心换取最低迁移风险与完全的行为一致性。

---

## 9. 迁移步骤

1. **建仓**：`D:\space\base\Polaris-lite` 独立 git 仓；从 Polaris 复制根配置（`package.json`、`vite.config.ts`、`tsconfig`、`tailwind`、`tauri.conf.json` 精简版），改标识为 polaris-lite（独立 appId/ productName/数据根 `PolarisLite`，与 Polaris 数据隔离）。
2. **复制后端壳**：整目录复制 `src-tauri/src/{contracts,services/router,services/ai_chat_core,ai,services/storage_exec,web}` 与 `plugin_service/supervisor/config_store/data_root/logger/error/state/lib`；按第 7 节放弃清单删除业务文件；`cargo check` + web-only 门禁（`cargo check --no-default-features --bin polaris-web --bin polaris-mcp`）通过。
3. **复制前端壳**：复制 `src/{main.tsx,App.tsx,plugin-system,components/Common,components/Layout,components/Plugins,services,hooks,i18n}`；删除业务 store/类型/工具；`pnpm exec tsc --noEmit` 通过。
4. **构建 lite-chat 插件**：从 worktree 复制 Chat 树与 conversationStore/session-v2/ai-runtime 到 `plugins/lite-chat/src`；写 `plugin.json`；配置 vite lib 构建（external: react/react-dom/zustand/宿主桥）产出 `dist/panel.js`；把 `@/…` 宿主导入改写为桥接导入（机械替换 + 少量 shim）。
5. **引擎侧车**：把 `simple_ai` + `simple_ai_protocol` 迁入 `plugins/engine-simpleai`，包一层 PiRpc 服务进程；manifest 声明 `engines[] + services[]`；验证 `register_plugin_engine` 注册后 `cap.ai.chat start` 可路由到插件引擎。
6. **收录其余插件**：lite-settings / lite-history / lite-model / sample-hello 落 `plugins/`，各自过一遍发现→启用→席位渲染链路。
7. **联调冒烟**：`pnpm tauri:dev:web` 起双端；冒烟清单 = 新建会话→流式回复→中断→历史抽屉→设置页改项→插件禁用后 ChatMainSlot 空态→sample-hello 席位与 cap.hello 调用。
8. **收尾**：跑 `pnpm lint`、`pnpm test:run`（复用 Polaris 可迁移的 plugin-system 测试）、统计核心行数回填第 8 节表格；写 README 与插件开发模板说明。

---

## 10. 风险与对策

| # | 风险 | 等级 | 对策 |
|---|---|---|---|
| 1 | Chat 树对宿主内部模块的依赖比预期深（`@/stores/*`、`@/utils/tool*` 交叉引用），插件化改写量膨胀 | 高 | 迁移前先跑依赖扫描圈定导入闭包；appCoreBridge 保留这些模块的桥接出口；shim 层单独建 `plugins/lite-chat/src/host-bridge.ts` 集中收口，禁止散落直引 |
| 2 | 宿主 invoke 白名单收窄过度，chat-desk 时代依赖的命令（30 个）在 lite-chat 里缺失 | 高 | 白名单裁剪以 lite-chat 实际调用清单为准（步骤 4 先静态扫描再定稿）；保留 `router_dispatch` 兜底通道，能走 cap 的业务逐步改走 cap 而非加白名单 |
| 3 | pluginModuleLoader 是同窗口同源 Blob import，无沙箱——lite-chat 拥有宿主全部桥能力，"插件化"安全边界弱 | 中 | S1 定位即"首个内置可信插件"（`core:true`，不可卸载）；在文档明示该边界，把沙箱化留给后续方案演进，不在本方案范围内伪装解决 |
| 4 | SimpleAI 侧车化后 PiRpc 通道不稳定（引擎协议复杂、工具调用多） | 中 | 侧车保留 `POLARIS_LITE_ENGINES=core` 逃生开关（编译 feature 控制引擎留在核心 bin）；先以 ClaudeEngine 为默认引擎验证主链路，SimpleAI 侧车作为第二梯队 |
| 5 | 复制的 worktree 代码与 Polaris 主分支漂移，后续无法同步上游修复 | 中 | lite 仓记录复制源 commit（HEAD `ff386fad` + worktree 分支名）于 `docs/PROVENANCE.md`；契约层（contracts/plugin-system）不做本地修改，保持可 diff 回流 |
| 6 | Rust feature 门控遗漏导致 web-only 构建失败 | 中 | 沿用 Polaris 门控纪律：每删/改一个命令同步跑 `cargo check --no-default-features --bin polaris-web --bin polaris-mcp`；CI 保留 rust-gate |
| 7 | 双 TS 配置（宿主 tsconfig 与插件构建）类型漂移，`types/aiEvent.ts` 双份 | 低 | aiEvent/session 协议类型单源放 `plugins/lite-chat/src/protocol/`，宿主经桥只收 `unknown`/最小结构；宿主不重复声明协议类型 |
| 8 | "复制即老化"：lite 壳与 Polaris 壳未来各自演化，cap 契约失同步 | 低 | 接受此代价并写入 README（P8 要求独立）；契约变更以 contracts/mod.rs diff 为准做人工对齐，必要时抽 `@polaris/contracts` 共享包作为后续演进项 |
