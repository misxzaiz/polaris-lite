# S3 插槽容器：四槽位布局壳

> 矩阵第 3 格（差异化定位，不得偏移）：**核心只提供布局槽位** —— `sidebar / stream / input / panel` 四槽，对应 Polaris 的「会话侧栏 + 消息流 + 底部输入区 + 面板区」；AI 对话插件填满四槽；插件机制 = **槽位注册制**；前端栈 = **React 原栈（React + Zustand + Vite）**。核心本质是「**槽位容器 + 总线**」。

---

## 1. 方案定位

| 维度 | S3 的回答 |
|---|---|
| 布局骨架由谁提供 | **核心**提供 `SlotLayout` 四槽布局壳与槽位渲染、仲裁、空态；骨架样式与分区比例从 Polaris `components/Layout/` 复制，保证「布局不变」 |
| 对话 UI 由谁提供 | **chat-desk-lite 插件**一次性认领四槽（sidebar/stream/input/panel），其内部状态（会话、消息、输入草稿）全部留在插件内 |
| 插件机制 | **槽位注册制**：插件 manifest 声明 `contributes.slots[]`，前端 `SlotRegistry` 注册/撤销，单实例槽按 `order` 仲裁，panel 槽按序堆叠 |
| 与 Polaris 最大的不同 | 把 Polaris 的多贡献点体系（activityBar / mainSurface / settings / overlay / uiSlots / chatCards…）**收敛为四个布局槽**；`appCoreBridge` 的 21-store 泄漏收敛为最小 `SlotHostApi` |
| 核心不做什么 | 无任何对话/业务组件；无 git/浏览器/终端/文件面板；无代理、MCP 配置、调度器；核心只做「槽位 + 总线 + 插件生命周期 + 主题/i18n/窗口壳」 |

一句话：**核心是插线板（四个槽 + 一条总线），对话和其他一切功能都是插上去的插件。**

---

## 2. 架构图（文字图）

```
┌──────────────────────────── polaris-lite（独立仓库） ────────────────────────────┐
│                                                                                 │
│  packages/core —— 前端核心：槽位容器 + 总线客户端（React 原栈）                    │
│  ┌───────────────────────────────────────────────────────────────────────────┐ │
│  │ SlotLayout（四槽布局壳，分区比例/样式复制自 Polaris Layout）                 │ │
│  │ ┌───────────┬───────────────────────────────┬───────────────────────────┐ │ │
│  │ │ sidebar   │ stream（消息流）               │ panel（面板区，stack）     │ │ │
│  │ │ 槽:single │                               │                           │ │ │
│  │ │           │  chat-desk-lite.stream        │  chat-desk-lite.panel     │ │ │
│  │ │ chat-desk │  气泡/工具卡/自动滚动/compact   │  history-desk-lite        │ │ │
│  │ │ -lite.    │                               │  settings-desk-lite       │ │ │
│  │ │ sidebar   ├───────────────────────────────┤  files-desk-lite …        │ │ │
│  │ │           │ input 槽:single（底部输入区）   │                           │ │ │
│  │ │           │  chat-desk-lite.input         │                           │ │ │
│  │ └───────────┴───────────────────────────────┴───────────────────────────┘ │ │
│  │ SlotRegistry(register/resolve) · SlotOutlet · SlotEmpty · moduleLoader    │ │
│  │ capClient(dispatch/stream/listen) · coreBus · theme · i18n · windowShell  │ │
│  └────────────────────────────────────┬──────────────────────────────────────┘ │
│                                       │ 唯一通道：router_dispatch / SSE 事件     │
│  ┌────────────────────────────────────▼──────────────────────────────────────┐ │
│  │ crates/lite-host —— Rust 极简宿主                                          │ │
│  │ RouterBus(精简)：权限 gate → 审计 → 转发（dispatch / dispatch_stream）      │ │
│  │ caps: cap.ai.chat(调度壳) cap.session cap.history cap.kv cap.config        │ │
│  │       cap.fs cap.http cap.pluginDiscovery cap.pluginServiceManager        │ │
│  │ EngineRegistry(trait) ← 插件经 manifest engines[] 注册引擎实现              │ │
│  │ plugin discovery / manifest(s3.1) / lifecycle · EventBroadcaster · audit  │ │
│  └───────────────────────────────────────────────────────────────────────────┘ │
│                                                                                 │
│  plugins/ —— 全部业务以插件存在                                                  │
│  ├─ chat-desk-lite/（AI 对话：填满四槽，core:true）                               │
│  ├─ history-desk-lite/ settings-desk-lite/ model-desk-lite/                     │
│  ├─ files-desk-lite/（示例业务面板） translate-lite/（示例业务面板）               │
│  └─ engine-simple-ai/（AI 引擎插件，注册进 EngineRegistry）                       │
└─────────────────────────────────────────────────────────────────────────────────┘
```

数据流（以一次提问为例）：

```
chat-desk-lite.input（输入框）
  → hostApi.dispatch('cap.ai.chat','start',{sessionId,content,attachments})
  → capClient → invoke('router_dispatch') / POST /api/router/dispatch
  → lite-host RouterBus：权限校验(permissions.caps) → 审计入链 → AiChatCapability
  → EngineRegistry 找到 engine-simple-ai → 引擎执行 → 事件逐条回推
  → EventBroadcaster → 'chat-event'（SSE / tauri event）
  → capClient.stream 迭代 → chat-desk-lite 内部 conversationStore 消费
  → chat-desk-lite.stream 重渲染消息流（跨槽协作在插件内部完成，核心无感）
```

---

## 3. 核心目录树

```
polaris-lite/
├─ package.json                  # pnpm workspace；scripts: dev / build / check
├─ pnpm-workspace.yaml           # packages/*、plugins/*
├─ vite.config.ts
├─ crates/
│  └─ lite-host/                 # Rust 极简宿主（目标 ≤ ~9,000 行）
│     ├─ Cargo.toml              # features: tauri(默认)|web-only
│     └─ src/
│        ├─ main.rs              # 启动：data_root → config → bus → plugins → serve/window
│        ├─ bus/
│        │  ├─ mod.rs            # RouterBus 精简版：register/dispatch/dispatch_stream
│        │  ├─ audit.rs          # 审计链（复制 Polaris audit_sink.rs 裁剪）
│        │  ├─ policy.rs         # 权限裁决（复制 policy_permission.rs 裁剪）
│        │  └─ error.rs
│        ├─ caps/
│        │  ├─ ai_chat.rs        # cap.ai.chat：start/continue/interrupt 调度壳
│        │  ├─ session.rs        # cap.session：会话元数据/列表/分支
│        │  ├─ history.rs        # cap.history
│        │  ├─ kv.rs  config.rs  # cap.kv / cap.config
│        │  ├─ fs.rs  http.rs    # cap.fs / cap.http（白名单受限）
│        │  └─ engine_registry.rs# 引擎 trait + 注册表（插件可注册）
│        ├─ plugins/
│        │  ├─ discovery.rs      # 扫描 <dataRoot>/plugins/*/plugin.json
│        │  ├─ manifest.rs       # s3.1 manifest Rust 权威类型 + 校验
│        │  └─ lifecycle.rs      # 启用/停用/装配 capabilities/engines
│        ├─ events.rs            # EventBroadcaster（SSE + tauri event 双后端）
│        ├─ config.rs  data_root.rs  logger.rs
│        └─ web/                 # web-only 模式：axum 路由 + 静态托管（裁剪自 Polaris web/）
├─ packages/
│  └─ core/                      # 前端核心（目标 ≤ ~6,500 行）
│     └─ src/
│        ├─ main.tsx             # 启动序：transport→theme→discovery→registry→render
│        ├─ app/
│        │  ├─ SlotLayout.tsx    # 四槽布局壳（含分区尺寸/token，锁定 Polaris 布局）
│        │  └─ SlotEmpty.tsx     # 槽空态引导卡（对标 ChatMainSlot）
│        ├─ slots/
│        │  ├─ types.ts          # SlotId / SlotDescriptor / SLOT_ARITY
│        │  ├─ SlotRegistry.ts   # 注册/撤销/仲裁/订阅
│        │  ├─ SlotOutlet.tsx    # 槽渲染出口（useSyncExternalStore + lazy）
│        │  └─ hostApi.ts        # SlotHostApi（插件唯一宿主门面）
│        ├─ bus/
│        │  ├─ capClient.ts      # dispatch/stream/listCaps（tauri|http 双传输）
│        │  ├─ transport.ts      # 复制 Polaris services/transport/ 裁剪
│        │  └─ coreBus.ts        # 跨插件命名空间事件（核心不识语义）
│        ├─ plugins/
│        │  ├─ manifest.ts       # s3.1 manifest TS 镜像类型 + validateManifest
│        │  ├─ discovery.ts      # 拉取插件清单（cap.pluginDiscovery）
│        │  ├─ moduleLoader.ts   # 复制 Polaris pluginModuleLoader（Blob import）
│        │  └─ lifecycle.ts      # 启停状态机、插件样式注入
│        ├─ stores/              # 仅 4 个：config/plugin/theme/toast
│        ├─ theme/  i18n/        # 复制 Polaris themeEngine + i18n 骨架
│        └─ ui/                  # 复制 Polaris components/Common（Modal/Toast/ErrorBoundary/Icons）
└─ plugins/
   ├─ chat-desk-lite/            # AI 对话插件（填满四槽）
   │  ├─ plugin.json             # s3.1 manifest（见 §5）
   │  ├─ dist/                   # 构建产物（moduleLoader 加载入口）
   │  └─ src/
   │     ├─ bootstrap.ts         # 插件激活：建会话 store、订阅 chat-event
   │     ├─ sidebar/  stream/  input/  panel/   # 四槽实现（见 §6）
   │     ├─ state/               # conversationStore 裁剪版（插件私有）
   │     └─ shared/              # 类型/工具
   ├─ engine-simple-ai/          # 引擎插件：engines[] 注册 + 独立进程服务
   ├─ history-desk-lite/ settings-desk-lite/ model-desk-lite/
   ├─ files-desk-lite/ translate-lite/          # 示例业务面板插件
   └─ _template/                 # 新插件脚手架
```

**核心白名单（允许出现在 `packages/core`、`crates/lite-host`）**：槽位、总线、插件生命周期、传输、主题、i18n、窗口壳、通用 UI（Modal/Toast/ErrorBoundary）、config/kv/日志/数据根。**业务黑名单（出现即 CI 失败）**：任何 `chat/messages/bubbles/input 业务逻辑、git、browser、terminal、fileExplorer、editor、provider/proxy、mcp、form、nexus、scheduler、computer` 命名的模块；用 eslint `no-restricted-imports` + 一个 Rust 可见性/目录守卫测试双闸把核心锁死在白名单内。

---

## 4. 核心契约（TS 签名级）

### 4.1 槽位定义与 SlotDescriptor

```ts
// packages/core/src/slots/types.ts
export type SlotId = 'sidebar' | 'stream' | 'input' | 'panel';

/** single：同一时刻只渲染 order 最小的启用贡献；stack：按 order 升序全部渲染 */
export type SlotArity = 'single' | 'stack';

export const SLOT_ARITY: Record<SlotId, SlotArity> = {
  sidebar: 'single', // 会话侧栏
  stream:  'single', // 消息流
  input:   'single', // 底部输入区
  panel:   'stack',  // 面板区（多插件并列堆叠）
};

export interface SlotDescriptor {
  id: string;          // 贡献唯一 id，约定 `${pluginId}.${slot}`，如 'chat-desk-lite.stream'
  slot: SlotId;        // 目标槽位
  entry: string;       // 组件模块路径（相对插件根，构建后指向 dist），如 './dist/stream.js'
  order?: number;      // 默认 100；single 槽取最小者，stack 槽升序排列
  titleKey?: string;   // i18n 标题键
  title?: string;      // 兜底标题
  icon?: string;       // lucide 名或相对资源路径
}
```

### 4.2 槽位注册 API（SlotRegistry）

```ts
// packages/core/src/slots/SlotRegistry.ts
export interface SlotRegistry {
  /** 插件启用时由 lifecycle 调用；id 重复抛 SlotConflictError */
  register(descriptor: SlotDescriptor): void;
  /** 插件停用/卸载时整体撤销该插件全部贡献 */
  unregisterByPlugin(pluginId: string): void;
  /** 该槽全部启用贡献，按 order 升序 */
  list(slot: SlotId): readonly SlotDescriptor[];
  /** single 槽仲裁：order 最小者；同 order 以 pluginId 字典序定序，保证确定性 */
  resolve(slot: SlotId): SlotDescriptor | null;
  /** 供 useSyncExternalStore 订阅变更 */
  subscribe(listener: () => void): () => void;
}
export function createSlotRegistry(): SlotRegistry;
```

```tsx
// packages/core/src/slots/SlotOutlet.tsx
export function SlotOutlet(props: { slot: SlotId; className?: string }): JSX.Element;
// 行为：list(slot) → single 槽取 resolve() → moduleLoader.load(pluginId, entry)
//      → React.lazy 渲染 <Comp host={createHostApi(pluginId)} />
//      → 无贡献渲染 <SlotEmpty slot={slot}/>（对标 Polaris ChatMainSlot 空态卡）
```

### 4.3 插件宿主门面（SlotHostApi）——插件能拿到的全部能力

```ts
// packages/core/src/slots/hostApi.ts
export interface SlotHostApi {
  /** 同步命令：一律经总线，禁止插件直连后端 */
  dispatch<TRes = unknown>(capId: string, action: string, payload?: unknown): Promise<TRes>;
  /** 流式命令：返回异步迭代器（内部封装 dispatch_stream + chat-event 订阅） */
  stream<TEvt = unknown>(capId: string, action: string, payload?: unknown): AsyncIterable<TEvt>;
  /** 订阅宿主事件通道（如 'chat-event'），返回退订函数 */
  listen(event: string, handler: (payload: unknown) => void): () => void;
  /** 跨插件广播，事件名强制命名空间 `${pluginId}:*`，核心不解释语义 */
  emit(event: string, payload?: unknown): void;
  config: { get<T>(key: string, dft?: T): Promise<T>; set(key: string, value: unknown): Promise<void> };
  kv:   { get<T>(key: string): Promise<T | null>; set(key: string, v: unknown): Promise<void>; delete(key: string): Promise<void> };
  i18n: { t(key: string, params?: Record<string, unknown>): string; readonly locale: string };
  theme:{ readonly mode: 'light' | 'dark'; token(name: string): string };
}
```

设计要点：**取代 Polaris `appCoreBridge` 的 21-store + 30 命令白名单泄漏**。插件拿不到宿主 store，跨插件协作只有两条路：cap 总线调用、`coreBus` 命名空间事件。核心因此保持零业务（它不知道「会话」是什么，只知道槽和事件）。

### 4.4 插件 manifest 槽位字段（s3.1）

```jsonc
// plugins/chat-desk-lite/plugin.json
{
  "id": "chat-desk-lite",
  "name": "AI 对话",
  "version": "0.1.0",
  "manifestVersion": "s3.1",
  "core": true,
  "enabledByDefault": true,
  "contributes": {
    "slots": [
      { "id": "chat-desk-lite.sidebar", "slot": "sidebar", "entry": "./dist/sidebar.js", "order": 10, "title": "会话" },
      { "id": "chat-desk-lite.stream",  "slot": "stream",  "entry": "./dist/stream.js",  "order": 10 },
      { "id": "chat-desk-lite.input",   "slot": "input",   "entry": "./dist/input.js",   "order": 10 },
      { "id": "chat-desk-lite.panel",   "slot": "panel",   "entry": "./dist/panel.js",   "order": 10 }
    ],
    "capabilities": [
      { "id": "cap.chat.tools", "summary": "对话内工具卡片查询", "handler": { "type": "plugin-rpc" } }
    ]
  },
  "engines": [ { "id": "simple-ai", "service": "engine-simple-ai" } ],
  "permissions": {
    "caps": ["cap.ai.chat", "cap.session", "cap.history", "cap.kv", "cap.config"],
    "chatEvents": "full"
  }
}
```

```ts
// packages/core/src/plugins/manifest.ts （Rust 侧 crates/lite-host/src/plugins/manifest.rs 镜像同构）
export interface SlotContribution { id: string; slot: SlotId; entry: string; order?: number; titleKey?: string; title?: string; icon?: string; }
export interface CapabilityContribution { id: string; summary: string; handler: { type: 'plugin-rpc' | 'forward'; target?: string }; replaces?: string; }
export interface EngineContribution { id: string; service: string; }
export interface PluginManifest {
  id: string; name: string; version: string;
  manifestVersion: 's3.1';
  core?: boolean; enabledByDefault?: boolean;
  contributes?: { slots?: SlotContribution[]; capabilities?: CapabilityContribution[] };
  engines?: EngineContribution[];
  permissions?: { caps?: string[]; chatEvents?: 'none' | 'lifecycle' | 'full' };
}
export function validateManifest(raw: unknown): { ok: true; manifest: PluginManifest } | { ok: false; errors: string[] };
```

约束：`slot` 必须落在 `SLOT_ARITY` 四值内；`id` 必须 `${pluginId}.` 前缀；`single` 槽冲突时 registry 拒绝后到者并 `console.warn`（开发期）/ 事件上报（运行期）。Rust 侧 `validate_manifest_fields` 对应校验，双侧类型以共享 JSON schema 单测对齐（沿用 Polaris「Rust 权威 + TS 镜像」纪律）。

### 4.5 Rust 总线签名（保留 cap 总线思想）

```rust
// crates/lite-host/src/bus/mod.rs
#[async_trait]
pub trait Capability: Send + Sync {
    fn id(&self) -> &str;                                   // 如 "cap.ai.chat"
    async fn handle(&self, ctx: &RequestContext, action: &str, payload: serde_json::Value) -> CapResult;
}
#[async_trait]
pub trait StreamingCapability: Capability {
    async fn handle_stream(&self, ctx: &RequestContext, action: &str, payload: serde_json::Value,
                           tx: mpsc::Sender<StreamEvent>) -> CapResult;
}
pub struct RouterBus { /* handles + audit + policy */ }
impl RouterBus {
    pub fn register(&self, cap: std::sync::Arc<dyn Capability>) -> Result<(), BusError>; // 同 id 拒绝
    pub fn register_streaming(&self, cap: std::sync::Arc<dyn StreamingCapability>);
    pub async fn dispatch(&self, ctx: RequestContext, cap: &str, action: &str, payload: serde_json::Value)
        -> Result<serde_json::Value, BusError>;             // 权限 gate → 审计 → 转发
}
```

---

## 5. AI 对话插件如何填四槽

chat-desk-lite 一次注册四个贡献（见 §5 manifest），四个槽的组件共享插件内部 Zustand store（裁剪自 Polaris `stores/conversationStore/` 11,383 行 → 约 6,000 行），因此跨槽协作（输入→发送→流更新→面板刷新）是插件内部状态流，核心零感知。种子代码来自 Polaris worktree `.claude/worktrees/browser-desk-extraction/src/components/Chat/`（104 文件 26,904 行）按槽拆入。

| 槽 | 插件内路径 | 职责 | 种子来源（Polaris） | 依赖 cap |
|---|---|---|---|---|
| sidebar | `plugins/chat-desk-lite/src/sidebar/SessionSidebar.tsx` | 会话列表、新建/重命名/删除、搜索、当前会话选中 | `components/Chat/session/` | cap.session、cap.kv |
| stream | `plugins/chat-desk-lite/src/stream/MessageStream.tsx` | 消息流渲染、用户/助手/系统气泡、工具调用卡、自动滚动、compact 提示 | `components/Chat/messages/`、`chatBubbles/`、`tool-calls/`、`chatBlocks/` | cap.ai.chat(stream)、cap.history |
| input | `plugins/chat-desk-lite/src/input/ChatInputSlot.tsx` | 文本输入、附件、斜杠命令、发送/停止按钮、草稿 | `components/Chat/input/` | cap.ai.chat、cap.config |
| panel | `plugins/chat-desk-lite/src/panel/ChatPanel.tsx` | 会话详情、模型/Profile 选择、工具开关、会话配置 | `session-config/`、RightPanel 现役逻辑 | cap.config、cap.session |

运行链路：
1. 插件激活（lifecycle）→ `bootstrap.ts` 创建插件内 `conversationStore`，`hostApi.listen('chat-event', …)` 建立事件消费（沿 Polaris 三级过滤语义简化为 full/lifecycle/none）。
2. `SlotOutlet(slot='sidebar')` resolve 到 `chat-desk-lite.sidebar` → moduleLoader 懒加载 `dist/sidebar.js` → 渲染会话列表。
3. 用户在 input 槽发送：`hostApi.dispatch('cap.ai.chat','start',{sessionId,content,attachments})`；`AiChatCapability` 经 `EngineRegistry` 调 `engine-simple-ai` 插件执行。
4. 引擎事件经 `EventBroadcaster` → `chat-event` → 插件 store 更新 → stream 槽重渲染；停止 = `dispatch('cap.ai.chat','interrupt',{sessionId})`（幂等，按 sessionId 归属，不误杀）。
5. 面板区同时可堆叠 `history-desk-lite` 等其他插件的 panel 贡献（stack 槽按 order 排列）。

布局不变性保障：`SlotLayout` 的分区宽度、间距、断点常量直接取自 Polaris `components/Layout/` 的现役样式与主题 token；`SlotEmpty` 空态复刻 `ChatMainSlot` 引导卡；并用 vitest 快照锁定四槽 DOM 结构。

---

## 6. 插件清单

| 插件 | 类型 | 认领槽位 | 说明 | 权限（caps） |
|---|---|---|---|---|
| chat-desk-lite | 对话主插件（core:true） | sidebar + stream + input + panel | AI 对话全功能 | cap.ai.chat、cap.session、cap.history、cap.kv、cap.config |
| engine-simple-ai | 引擎插件 | —（无 UI） | manifest `engines[]` 注册引擎实现，独立进程服务 | cap.ai.chat（引擎内部）、cap.fs、cap.http |
| history-desk-lite | 面板插件 | panel | 会话历史检索、恢复、分支浏览 | cap.history、cap.session |
| settings-desk-lite | 面板插件 | panel | 插件启停、主题、语言、数据根展示 | cap.config、cap.pluginDiscovery、cap.pluginServiceManager |
| model-desk-lite | 面板插件 | panel | 模型供应商/Profile 管理 | cap.config、cap.kv |
| files-desk-lite | 业务面板（示例） | panel | 轻量文件浏览（验证 panel 槽可承载任意业务） | cap.fs |
| translate-lite | 业务面板（示例） | panel | 翻译小工具（验证第三方接入成本） | cap.http |
| _template | 脚手架 | — | 新插件模板 + 文档 | — |

规则：panel 是唯一 stack 槽，新增业务面板一律走 panel；sidebar/stream/input 被 chat-desk-lite 占据后其他插件不得抢占（single 槽仲裁拒绝并告警）。

---

## 7. 启动流程

**宿主（crates/lite-host）**：
1. 解析数据根（复制 Polaris `data_root.rs`：env `POLARIS_DATA_ROOT` > anchor > 默认）。
2. 加载 `config_store`；初始化 logger/audit 链。
3. `RouterBus` 注册内置 caps：`cap.ai.chat`（调度壳 + EngineRegistry）、`cap.session`、`cap.history`、`cap.kv`、`cap.config`、`cap.fs`、`cap.http`、`cap.pluginDiscovery`、`cap.pluginServiceManager`。
4. `plugins::discovery` 扫描 `<dataRoot>/plugins/*/plugin.json` → `manifest::validate`（s3.1）→ `lifecycle` 装配插件 `capabilities[]` 为动态 handler、`engines[]` 注册进 EngineRegistry。
5. `EventBroadcaster` 就绪（tauri feature → tauri event；web-only → SSE `/api/events`）。
6. 起服务（tauri 窗口或 axum），前端可拉取插件清单与 cap 目录。

**前端（packages/core/src/main.tsx）**：
1. `createTransport()`（复制 Polaris `services/transport/`：tauri invoke / http 探测二选一）。
2. `bootstrapTheme()`（复制 themeEngine，render 前注入 CSS 变量防 FOUC）。
3. `pluginStore.load(discovery)` → 遍历启用插件的 `contributes.slots` → `SlotRegistry.register(...)`。
4. `createCapClient(transport)`；`createHostApi(pluginId)` 工厂就绪（moduleLoader 复制自 Polaris `pluginModuleLoader.ts`：读插件 dist JS → import 重写 → Blob URL 动态 import）。
5. `render(<SlotLayout/>)`：内部四个 `<SlotOutlet slot=…/>`；chat-desk-lite 的四组件懒加载，其 `bootstrap.ts` 建立会话 store 并订阅 `chat-event`。
6. 首帧后按需加载 panel stack 的其余面板插件（files/history/settings），失败降级为 SlotEmpty + Toast，不阻塞对话主链路。

最小启动集 = transport + theme + discovery/registry + SlotLayout，其余全部懒加载。

---

## 8. 与 Polaris 的复用/差异清单

### 8.1 直接复制（路径基本不动）
- 前端：`src/services/transport/`、`src/services/eventBus.ts`、`src/services/themeEngine.ts`/`themeService.ts`/`themeMerger.ts`、`src/i18n/` 骨架、`src/plugin-system/pluginModuleLoader.ts`、`panelRegistry.ts`（改造为 SlotOutlet 的加载器）、`iconResolver.tsx`、`styles.ts`、`src/components/Common/`（Modal/Toast/ErrorBoundary/Icons/ResizeHandle）、`src/stores/configStore.ts`/`pluginStore.ts`/`themeStore.ts`/`toastStore.ts`。
- Rust：`services/router/mod.rs`（裁剪 override 链与 demo caps）、`audit_sink.rs`、`policy_permission.rs`、`permission_prompt.rs`、`commands/router.rs`、`web/`（event_broadcaster/rate_limit/auth/静态托管）、`data_root.rs`、`config_store.rs`、`logger.rs`、`error.rs`。
- 插件种子：worktree `.claude/worktrees/browser-desk-extraction/src/components/Chat/**`、`src/stores/conversationStore/**`、`src/session-v2/**`、`src/ai-runtime/**` → 复制入 `plugins/chat-desk-lite/` 后裁剪。

### 8.2 重写
- `src/App.tsx` + `components/Layout/`（ActivityBar/LeftPanel/CenterStage/RightPanel/ChatMainSlot）→ 重写为 `packages/core/src/app/SlotLayout.tsx` 四槽壳（CenterStage/tab 体系不进 lite）。
- `src/plugin-system/registry.ts`（543 行多贡献点）→ 重写为 `slots/SlotRegistry.ts`（约 200 行，仅四槽）。
- `src/plugin-system/appCoreBridge.ts`（21-store 泄漏）→ 重写为 `slots/hostApi.ts` 最小门面。
- manifest：`models/plugin.rs` 的 20+ 贡献点 → 精简为 `slots + capabilities + engines` 的 s3.1，Rust/TS 双侧重写。
- `services/plugin_service.rs`（2,904 行）→ 拆成 discovery/manifest/lifecycle 三小模块重写（首版去掉 marketplace/dev_link）。
- `storage_exec/`（4,964 行）→ 重写为 JSONL/kv 简存（约 800 行）挂 cap.session/cap.history。

### 8.3 放弃
- `commands/` 旧命令路径 31 文件（一律走总线）；`web/api/ipc.rs` 1,924 行大 IPC（换精简 SSE 桥）。
- `services/proxy/`（5,039）、`mcp_config_service.rs`（1,874）、`nexus_pipeline/`、`form/`、`computer_control/`、`ask_listener/`、`scheduler` 残留、`editor*`/SCM、`chatCardRegistry`/`uiTemplateRegistry`/`uiContributions` 多贡献点、`RightSlideOver` overlay 体系、`fileExplorerStore`/`tabStore` 等域 stores。
- MCP 首版不进 lite（引擎插件如需可后续以 `services[]` 形式回归）。

### 8.4 关键差异（相对 Polaris 现状）
1. 布局契约：从「多 area 贡献点 + CenterStage tab」改为「四槽固定 arity」，UI 表达力换边界清晰。
2. 插件—宿主接口：从 21-store 共享改为 `SlotHostApi` 最小门面，插件间禁止直接 import。
3. 插件机制：从多贡献点注册制收敛为**槽位注册制**，manifest 面积缩小约 80%。
4. AI 引擎：调度接口留核心（brief P4 允许），引擎实现走 `engines[]` 插件化。
5. 技术栈不变（React+Zustand+Vite / Rust），迁移以复制+裁剪为主，学习成本接近零。

---

## 9. 裁剪量化表

| 域 | Polaris 现状（行） | S3 核心（行，目标） | S3 插件侧（行，约） | 处置 |
|---|---|---|---|---|
| 前端总量 | 49,794 / 279 文件 | **≤ 6,500** | ~35,000 | 核心约 -87% |
| Rust 总量 | 101,032 / 250 文件 | **≤ 9,000** | ~8,000（引擎插件等） | 核心约 -91% |
| RouterBus | 1,786 + 34 caps | ~700 + 9 caps | — | 复制裁剪 |
| ai_chat_core + ai_chat_capability | 3,042 + 950 | ~1,500（调度壳） | 引擎实现 ~8,000 | 裁剪 + 插件化 |
| storage_exec | 4,964 | ~800 | — | 重写简存 |
| plugin_service | 2,904 | ~1,500 | — | 重写拆分 |
| Chat UI 树 | 26,904（worktree） | **0** | ~18,000（裁剪后） | 全量入插件 |
| conversationStore + session-v2 + ai-runtime | ~13,000（worktree） | **0** | ~7,500（裁剪后） | 全量入插件 |
| proxy / mcp / nexus / form / computer / ask_listener | ~14,000 | **0** | — | 放弃 |
| 主题/i18n/窗口壳/通用 UI | ~3,500 | ~2,800 | — | 复制 |

核心合计目标：**前端 ≤6.5k + Rust ≤9k ≈ 15.5k 行**，约为 Polaris 现状（150.8k 行）的 **10%**；首帧仅加载 transport/theme/registry/SlotLayout，对话功能由 chat-desk-lite 懒加载承接。

---

## 10. 迁移步骤

| 阶段 | 内容 | 验收 |
|---|---|---|
| M0 仓库骨架 | 建 `polaris-lite` 独立仓：pnpm workspace + `crates/lite-host` + `packages/core`；复制 data_root/logger/error/config | `pnpm dev` 与 `cargo check` 均绿；echo cap 打通 |
| M1 总线最小集 | 复制裁剪 RouterBus/audit/policy + router_dispatch 入口 + 9 caps 骨架 | cap.kv 读写经总线往返；审计链可见 |
| M2 槽位容器 | SlotRegistry/SlotOutlet/SlotLayout/SlotEmpty + moduleLoader 改造 + _template 插件 | demo 插件填 sidebar 槽可见；single 槽冲突被拒 |
| M3 对话插件 | 复制 worktree Chat 树入 chat-desk-lite，接 cap.ai.chat 与 chat-event，裁掉宿主 store 依赖；engine-simple-ai 注册 | 四槽全亮；一次提问完整流式回显；interrupt 幂等 |
| M4 周边插件 | settings/history/model/files/translate 面板插件 | panel stack 多插件并存；启停任一插件不塌槽 |
| M5 门禁固化 | eslint no-restricted-imports 白名单、Rust 目录守卫测试、manifest 双端 schema 单测、SlotLayout 快照 | 核心出现业务关键词即 CI 红 |
| M6 打包发布 | tauri build + web-only 构建；数据根与 Polaris 隔离（独立 anchor/数据目录） | 独立安装包可运行；与 Polaris 主仓零代码依赖 |

依赖顺序：M0→M1→M2→M3 串行（总线与槽位是对话插件的前置），M4 可与 M3 后半并行，M5/M6 收尾。

---

## 11. 风险与对策

| # | 风险 | 影响 | 对策 |
|---|---|---|---|
| 1 | 四槽表达力不足：复杂交互需要跨槽/跨区协作 | 插件被迫 hack | 跨槽协作限定为「插件内部状态」或「coreBus 命名空间事件 + cap 调用」两条正路；新增槽需改核心并评审（升级路径明确：SLOT_ARITY 可扩展） |
| 2 | single 槽被多插件抢占 | 布局错乱 | resolve 仲裁 + 注册期拒绝 + 运行期告警事件；文档明确 sidebar/stream/input 由 chat-desk-lite 优先 |
| 3 | chat 树复制后残留宿主耦合（conversationStore 依赖 appCoreBridge 的 stores/service） | 迁移工作量超估 | 复制时统一以 SlotHostApi 注入替换宿主桥调用；预估触碰 15–20 个文件，在 M3 排 3–5 天专项；裁不掉的依赖记入「放弃/缓办」清单 |
| 4 | cap.ai.chat 调度壳过薄导致功能回退（工具调用、compact、附件） | 对话体验降级 | 首版明确功能边界（单引擎 + 基础工具 + compact 提示）；引擎复杂逻辑全部进 engine-simple-ai 插件，核心只做转发；保留 Polaris 事件契约字段不删减 |
| 5 | manifest 双端漂移 | 插件装载失败 | s3.1 JSON schema 单一文件，Rust/TS 两侧生成或镜像单测比对；deny_unknown_fields 保持 Polaris 纪律 |
| 6 | 槽位壳与 Polaris 布局走样 | 违反 P2「布局不变」 | 分区尺寸/断点/token 直接复制 Polaris Layout 现役值；SlotLayout DOM 快照测试锁定；空态复刻 ChatMainSlot |
| 7 | moduleLoader 同窗口执行插件代码的安全面 | 恶意插件风险 | 沿用 Polaris 现状（本地可信插件 + 同源加载），但收口到 SlotHostApi 最小门面，权限按 `permissions.caps` 在总线侧裁决，插件拿不到未授权 cap |

---

## 12. 结论

S3 用最小的核心换最大的边界清晰度：核心退化为「四槽布局壳 + 一条 cap 总线 + 插件装卸器」，约 1.5 万行即可承载 Polaris 的对话形态；对话与全部业务以槽位注册制插件存在，布局不变性由核心 SlotLayout 锁定，核心零业务由白名单门禁锁定。它是以「架构边界」为先的方案——裁剪幅度与 Polaris 现状已有插件化成果（chat-desk、cap.ai.chat、plugin-system）高度对齐，迁移主要是「复制 + 收口」，工程风险集中在 chat 树去宿主耦合一处，且已给出对策与工作量预估。
