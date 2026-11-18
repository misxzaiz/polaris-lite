# S4 Web-Only 单进程：无 Tauri 轻量版

> 对应差异化矩阵第 4 格：**砍掉 Tauri，改为 Node/Bun Web 服务器 + 浏览器访问；AI 对话 UI 为插件 + HTTP/SSE 实现 cap 总线；插件机制 = 进程内插件注册表；前端栈 = React 原栈。**
> 可行性依据：Polaris 主仓已存在完整 Web 形态——`src-tauri/src/web/`（server/router/auth/event_broadcaster/rate_limit）与 `src-tauri/src/web/api/ipc.rs`（HTTP 桥，1,065 行）把 `router_dispatch` 完整暴露为 HTTP 接口。S4 只是把「Rust 进程 + Tauri IPC」替换为「Node/Bun 进程 + 纯 HTTP/SSE」，并将全部业务下沉到进程内插件。

---

## 0. 一句话定位

把 Polaris 的「Rust 宿主 + Tauri WebView」整体替换为「单进程 Node/Bun HTTP 服务器 + 任意浏览器」，核心只剩 cap 总线（HTTP/SSE 形态）、插件生命周期、会话存储契约与 React 布局壳；AI 对话 UI、AI 引擎、业务面板全部是同进程加载的插件模块。

---

## 1. 架构图（文字图）

```
┌───────────────────── 浏览器（Chrome/Firefox/Safari，任意设备）─────────────────────┐
│                                                                                    │
│  React 布局壳（核心，Polaris 四段式骨架的精简版）                                      │
│  ┌──────────┬──────────────────────────────────────────────┐                       │
│  │ActivityBar│  LeftPanel(席位) │  RightPanel = 对话主区        │  CenterStage(可选)   │
│  │(插件贡献) │  (插件贡献席位)    │  ┌────────┬───────────┐     │                     │
│  └──────────┴──────────────────│  │会话侧栏 │ 消息流      │     │                     │
│                                │  │        ├───────────┤     │                     │
│                                │  │        │ 面板区     │     │                     │
│                                │  │        ├───────────┤     │                     │
│                                │  │        │ 输入区     │     │                     │
│                                │  └────────┴───────────┘     │                     │
│                                │  ↑ 由 chat-lite 插件面板填充  │                     │
│                                └─────────────────────────────┘                     │
│                                                                                    │
│  plugin-system(前端)：registry + moduleLoader（dynamic import("/plugins/:id/…")）    │
│  transport：capTransport.dispatch() = fetch POST /api/cap/dispatch                  │
│            eventTransport = new EventSource("/api/events?channels=chat-event,…")   │
└───────────────▲──────────────────────────────────▲─────────────────────────────────┘
                │ HTTP POST /api/cap/dispatch      │ SSE：chat-event / audit / plugin-event
                │ （请求/响应，含权限与审计）          │ （流式增量与广播）
┌───────────────┴──────────────────────────────────┴─────────────────────────────────┐
│                     Node/Bun 单进程宿主  polaris-lite-server  (默认 :9840)            │
│                                                                                     │
│  ① http 层：路由 + Bearer token 鉴权 + 限流 + 静态托管（web/dist 与 /plugins/* 资源）    │
│  ② bus 层：RouterBus(TS) —— 权限 gate → 审计链(哈希链接) → capability 调用 / 流式推送    │
│  ③ 核心 caps（零业务）：cap.ai.chat cap.session cap.history cap.kv cap.config         │
│      cap.fs(限定数据根) cap.registry cap.help cap.events                              │
│  ④ engineRegistry：AiEngine 实例表（引擎全部由插件贡献，核心只存接口与路由）               │
│  ⑤ pluginRegistry（进程内）：scan(plugins/) → import(main) → activate(ctx)            │
│  ⑥ store：sessionStore(JSONL 追加日志) / configStore / auditLog                        │
│                                                                                     │
│  ┌─── 插件模块（与宿主同进程、同事件循环；不是独立进程）──────────────────────────┐      │
│  │ chat-lite(server)   lite-engine-anthropic   lite-engine-openai             │      │
│  │ settings-lite       history-lite           hello-demo(示例/演示贡献点)       │      │
│  └──────────────────────────────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

进程关系说明：**只有一个服务器进程 + N 个浏览器会话**。插件不是独立进程，而是服务器启动时通过 `import()` 装入同一进程的 ES 模块（服务端半边），其 UI 半边是构建出的静态 JS 包，由浏览器按 manifest 声明懒加载。相比 Polaris 的「Tauri 进程 + 插件子进程（ServiceSupervisor 拉起）+ MCP stdio 子进程」三层模型，S4 收敛为两层。

---

## 2. 核心目录树

```
polaris-lite/
├─ package.json                  # workspaces: ["server","web","plugins/*"]
├─ tsconfig.base.json
├─ server/                       # Node/Bun 单进程宿主（核心，零业务）
│  ├─ src/
│  │  ├─ index.ts                # 入口：装配 bus → caps → plugins → http.listen
│  │  ├─ http/
│  │  │  ├─ app.ts               # Hono 实例与路由装配
│  │  │  ├─ routes/
│  │  │  │  ├─ capRoutes.ts      # POST /api/cap/dispatch、POST /api/cap/stream
│  │  │  │  ├─ eventRoutes.ts    # GET /api/events（SSE hub）
│  │  │  │  ├─ metaRoutes.ts     # GET /api/health、/api/caps、/api/plugins
│  │  │  │  └─ pluginAssetRoutes.ts  # GET /plugins/:id/*（面板 JS/图标）
│  │  │  ├─ auth.ts              # 本机 Bearer token（首次启动生成到 dataRoot/token）
│  │  │  └─ rateLimit.ts         # 简化版限流（对齐 Polaris web/rate_limit 思想）
│  │  ├─ bus/
│  │  │  ├─ routerBus.ts         # cap 总线：register/dispatch/dispatchStream
│  │  │  ├─ audit.ts             # 哈希链接审计链（内存窗口 + JSONL 落盘）
│  │  │  ├─ permission.ts        # 声明式权限 gate（caller → cap/action 白名单）
│  │  │  └─ sseHub.ts            # SSE 连接表 + channel 订阅 + seq 续传
│  │  ├─ caps/                   # 核心通用 capability（每个 ≤300 行）
│  │  │  ├─ aiChatCap.ts         # cap.ai.chat（路由到 engineRegistry，含流式）
│  │  │  ├─ sessionCap.ts        # cap.session（会话/消息 CRUD）
│  │  │  ├─ historyCap.ts        # cap.history（历史检索）
│  │  │  ├─ kvCap.ts  configCap.ts  fsCap.ts  registryCap.ts  helpCap.ts
│  │  ├─ engine/
│  │  │  ├─ types.ts             # AiEngine / ChatRunHandle / ChatEventSink 接口
│  │  │  └─ engineRegistry.ts    # 引擎注册/查询/默认引擎选择
│  │  ├─ plugins/
│  │  │  ├─ manifest.ts          # plugin.json 读取 + zod 校验（Polaris schema 精简版）
│  │  │  ├─ registry.ts          # 进程内插件注册表（启用/停用/重载）
│  │  │  └─ loader.ts            # 目录扫描 + dynamic import(main)
│  │  ├─ store/
│  │  │  ├─ sessionStore.ts      # 会话/消息 JSONL 追加 + 内存索引
│  │  │  ├─ configStore.ts       # 全局配置（供应商 key、主题、语言）
│  │  │  └─ auditLog.ts
│  │  └─ util/ logger.ts  errors.ts  ids.ts
│  └─ package.json
├─ web/                          # React 前端（Vite 构建产物由 server 托管）
│  ├─ src/
│  │  ├─ main.tsx                # 装配 transport → registry → render
│  │  ├─ App.tsx                 # Layout 壳 + mainSurface claim 解析
│  │  ├─ layout/                 # ActivityBar/LeftPanel/RightPanel/CenterStage（精简壳）
│  │  ├─ plugin-system/          # registry.ts / panelRegistry.ts / moduleLoader.ts / schema.ts
│  │  ├─ transport/
│  │  │  ├─ capTransport.ts      # dispatch()：fetch 封装 + 错误归一
│  │  │  └─ eventTransport.ts    # EventSource 封装 + Last-Event-ID 续传
│  │  ├─ stores/                 # configStore/themeStore/pluginStore/viewStore/toastStore
│  │  ├─ theme/  i18n/  locales/
│  │  └─ components/Common/      # Modal/Toast/ErrorBoundary/Icons
│  └─ package.json
├─ plugins/                      # 业务插件（可独立分发目录）
│  ├─ chat-lite/                 # ★ AI 对话插件（四段式布局载体）
│  │  ├─ plugin.json
│  │  ├─ server/index.ts         # 注册对话辅助 cap、消息落库钩子
│  │  └─ web/                    # React 面板（构建为 panel.js，四段式 UI）
│  ├─ lite-engine-anthropic/     # AI 引擎插件（fetch Anthropic Messages API，SSE）
│  ├─ lite-engine-openai/        # AI 引擎插件（OpenAI 兼容 chat.completions 流式）
│  ├─ settings-lite/             # settings 席位（供应商 key/主题/语言/插件开关）
│  ├─ history-lite/              # session-history overlay（会话历史抽屉）
│  └─ hello-demo/                # 示例插件：演示 activityBar/overlay/自定义 cap 贡献
└─ docs/
```

核心白名单：`server/src/{http,bus,caps,engine,plugins,store,util}` + `web/src/{main,App,layout,plugin-system,transport,stores,theme,i18n,components/Common}`。业务黑名单：任何 git/文件浏览/终端/浏览器控制/翻译/IM/调度等领域模块不得进入以上目录，只能以 `plugins/*` 存在。

---

## 3. 核心契约

### 3.1 cap 总线（TS 版 RouterBus）

```ts
// server/src/bus/routerBus.ts
export interface CapRequest {
  capId: string;            // 'cap.ai.chat'
  action: string;           // 'start' | 'continue' | 'interrupt' | ...
  payload: unknown;         // 与 Polaris AiEvent 协议对齐的 camelCase 载荷
  meta?: { requestId?: string; reason?: string };
}
export interface Caller {
  source: 'web' | 'plugin'; // 浏览器发起 = web；插件间调用 = plugin
  pluginId?: string;        // 插件调用方 id（权限按 manifest.permissions 裁决）
  token?: string;           // web 调用方的 Bearer token
}
export type CapResponse<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: { code: 'CAP_NOT_FOUND' | 'ACTION_NOT_FOUND' |
                           'PERMISSION_DENIED' | 'VALIDATION_FAILED' | 'INTERNAL';
                          message: string; detail?: unknown } };

export interface CapContext {
  caller: Caller;
  signal: AbortSignal;              // 浏览器断开/中断时触发
  emit: (ev: StreamEvent) => void;  // 流式动作专用（映射到 SSE）
}
export interface StreamEvent { seq: number; channel: string; kind: string;
                              sessionId?: string; payload: unknown; ts: number }

export interface Capability {
  id: string;                       // 'cap.ai.chat'
  summary: string;
  actions: readonly string[];       // ['start','continue','interrupt','sendInput','ask']
  streamActions?: readonly string[];// ['start','continue']
  ownerPluginId?: string;           // 由插件注册时自动填充
  handle(req: CapRequest, ctx: CapContext): Promise<unknown>;
}

export class RouterBus {
  register(cap: Capability): void;                       // 重复 id 抛 BusError
  unregister(capId: string, ownerPluginId?: string): void;
  async dispatch<T>(req: CapRequest, caller: Caller): Promise<CapResponse<T>>;
  async dispatchStream(req: CapRequest, caller: Caller, sink: SseSink): Promise<void>;
  listCapabilities(): CapDescriptor[];                   // 供 GET /api/caps
}
```

权限 gate（`permission.ts`）保持 Polaris 语义的简化版：每个 cap 声明 `requiredPermission`，浏览器调用按 token 放行（本机单用户），插件调用按其 manifest `permissions` 白名单裁决；deny 结果写审计链并广播 `bus-audit` 事件（对齐 Polaris「deny/error 保留广播」的降级策略）。

### 3.2 HTTP API

| 方法与路径 | 说明 | 请求体 / 响应 |
|---|---|---|
| `GET /api/health` | 探活 | `{ ok:true, version:"0.1.0", plugins:string[] }` |
| `GET /api/caps` | 能力目录 | `CapDescriptor[]`：`{ id, summary, actions, streamActions, ownerPluginId }` |
| `POST /api/cap/dispatch` | 统一 cap 调用入口 | body `{ capId, action, payload }` → `CapResponse` |
| `POST /api/cap/stream` | 流式 cap 调用（SSE 应答） | body 同上 → `text/event-stream` |
| `GET /api/events?channels=chat-event,bus-audit` | 事件订阅（SSE hub） | SSE 流，支持 `Last-Event-ID` 续传 |
| `GET /api/plugins` | 插件清单 | `InstalledPluginView[]`（manifest + enabled 状态） |
| `POST /api/plugins/:id/enable` / `disable` | 插件启停 | `{ enabled:boolean }` |
| `GET /plugins/:pluginId/*` | 插件前端资源 | `panel.js` / 图标 / css |
| `GET /*` | 前端静态资源 | `web/dist` + `index.html` fallback |

约定：**除静态资源外不再单设业务 REST 路由**——会话、消息、历史、配置全部经 `POST /api/cap/dispatch` 走对应 cap（如 `cap.session` 的 `list/create/appendMessages`），保证「一切经总线」不被绕过。

### 3.3 SSE 事件契约

```
event: chat-event
data: { "channel":"chat-event", "seq":1042, "ts":1731900000000,
        "sessionId":"s_01J...", "kind":"ai.delta|ai.tool_call|ai.tool_result|ai.done|ai.error|session.updated",
        "payload": { ... }, "reason":"stream|lifecycle" }

event: bus-audit
data: { "seq":87, "capId":"cap.ai.chat", "action":"start", "ok":true,
        "caller":"web", "durationMs":12, "ts":1731900000000 }

event: plugin-event
data: { "pluginId":"chat-lite", "event":"enabled|disabled|reloaded", "ts":... }

event: ping
data: { "t":1731900000000 }
```

`chat-event` 的 `kind` 枚举与 Polaris `src/types/aiEvent.ts` 的子集对齐（delta/tool_call/tool_result/done/error/session.updated），使 chat 面板的渲染层代码可以低成本移植。每条事件带单调 `seq`；断线重连携带 `Last-Event-ID`，服务器从 `sseHub` 的环形缓冲补发。

### 3.4 插件注册接口（进程内注册表）

```ts
// server/src/plugins/registry.ts
export interface PluginContext {
  bus: RouterBus;
  log: Logger;                          // 前缀 [plugin:<id>]
  config: PluginConfigStore;            // 按 manifest.configSchema 读写
  events: { publish(channel: string, kind: string, payload: unknown, sessionId?: string): void };
  engineRegistry: EngineRegistry;       // 引擎贡献入口
  dataDir: string;                      // dataRoot/plugins/<id>/（私有数据）
}

export interface LitePluginModule {
  activate(ctx: PluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

export interface AiEngine {
  id: string;                           // 'anthropic.messages' | 'openai.completions'
  displayName: string;
  supportsStream: true;
  start(req: ChatStartRequest, sink: ChatEventSink): Promise<ChatRunHandle>;
  continue?(handle: ChatRunHandle, req: ChatContinueRequest): Promise<void>;
  interrupt(handle: ChatRunHandle): Promise<void>;   // 幂等：重复 interrupt 不误杀
}
export interface ChatEventSink {
  delta(text: string): void;
  toolCall(call: ToolCallEvent): void;
  toolResult(res: ToolResultEvent): void;
  done(summary: RunSummary): void;
  error(err: { code: string; message: string }): void;
}
```

`plugin.json`（Polaris manifest 的精简子集，保留同一字段命名以便识别）：

```jsonc
{
  "id": "chat-lite",
  "version": "0.1.0",
  "main": "server/index.js",            // 进程内模块入口（loader 用 import() 装载）
  "panel": { "entry": "web/panel.js", "supportsFullscreen": false },
  "contributes": {
    "views": [ { "id": "chat.main", "area": "mainSurface", "panelType": "chat-lite.main",
                 "slot": "chat.main", "slotMode": "shadow", "order": 0,
                 "icon": "message-square", "labelKey": "chat.title" } ],
    "engines": [ { "id": "chat-lite.glue" } ],
    "capabilities": [ { "id": "cap.chat.attachments", "summary": "附件预处理" } ],
    "overlays": [ { "id": "chat.history-drawer", "slot": "session-history", "panelType": "chat-lite.history" } ]
  },
  "permissions": { "chatEvents": "full", "fs": "pluginDir", "appConfigRead": true }
}
```

加载流程：`registry.scan(pluginsDir)` 读全部 `plugin.json` → 按 `enabledByDefault`/用户配置过滤 → `loader.load(manifest)` 执行 `import(pathToFileURL(main))` → 校验 default export 满足 `LitePluginModule` → `activate(ctx)`。插件通过 `ctx.bus.register` 贡献 capability、通过 `ctx.engineRegistry.register` 贡献 AI 引擎；停用时逆序 `deactivate` 并 `unregister` 其全部 cap/引擎。

---

## 4. AI 对话插件挂载（布局不变的保证）

四段式布局（会话侧栏 + 消息流 + 输入区 + 面板区）的**骨架归属**与**填充归属**分离：

- **核心提供壳与槽位**：`web/src/App.tsx` 渲染 Polaris 同构的 `Layout`（ActivityBar / LeftPanel / RightPanel / CenterStage 精简版）。`RightPanel` 即「对话主区」，核心逻辑 = `pluginRegistry.getMainSurfaceClaim()`：命中且插件启用 → 懒加载插件面板；未命中 → 渲染 `EmptyMainSlot` 引导卡（对应 Polaris 的 `ChatMainSlot`）。
- **chat-lite 插件填充**：面板内部实现四段式（复刻 Polaris worktree 中 `src/components/Chat/` 的结构：`session/` 会话侧栏、`messages/` 消息流、`input/` 输入区、`chatBlocks/`+`tool-calls/` 面板区），构建为 `web/panel.js`，由浏览器 `import("/plugins/chat-lite/web/panel.js")` 挂载。
- **交互契约**（保证与 Polaris 布局一致的不是约定俗成，而是接口）：
  1. 面板 props 固定为 `PanelProps { panelType; ctx: PanelHostApi; onSendToChat?; onClose? }`，与 Polaris `PluginPanelHost` 一致；
  2. 会话数据经 `cap.session`（list/get/messages/create/rename/delete），消息渲染消费 `chat-event` SSE；
  3. 发送/继续/中断经 `cap.ai.chat` 的 `start/continue/interrupt`，action 表与 Polaris `AiChatCapability` 对齐，保证协议不漂移；
  4. 主题/i18n 注入：面板从 `window.__LITE_HOST__` 获取宿主注入的 `theme`、`t()`、`dispatch`（对应 Polaris `appCoreBridge` 的收窄版，只暴露 5 个能力而非 21 个 store）。

```ts
// web/src/plugin-system/types.ts —— 宿主桥（appCoreBridge 的收窄版）
export interface LiteHostBridge {
  dispatch: <T>(req: { capId: string; action: string; payload?: unknown }) => Promise<CapResponse<T>>;
  subscribe: (channels: string[], handler: (ev: StreamEvent) => void) => () => void;
  theme: ThemeApi;        // getToken/setToken
  t: (key: string, vars?: Record<string, unknown>) => string;
  toast: ToastApi;
}
window.__LITE_HOST__ = hostBridge;   // 插件面板与宿主共享同一 transport 实例
```

---

## 5. 插件清单（首版 6 个）

| 插件 id | 类型 | 贡献 | 说明 |
|---|---|---|---|
| `chat-lite` | 对话面板 + 服务模块 | `mainSurface` 席位（slot `chat.main`）、`session-history` overlay、`cap.chat.attachments` | 四段式 AI 对话 UI；消息落库钩子；附件预处理 |
| `lite-engine-anthropic` | AI 引擎 | `AiEngine`（`anthropic.messages`，SSE 流式） | fetch Anthropic Messages API，工具调用映射 |
| `lite-engine-openai` | AI 引擎 | `AiEngine`（`openai.completions`，流式） | OpenAI 兼容端点，可指向任意兼容供应商 |
| `settings-lite` | 面板 | `settings` 席位 | 供应商 key、默认引擎、主题、语言、插件开关 |
| `history-lite` | 面板 | overlay `session-history` | 会话历史检索抽屉（消费 `cap.history`） |
| `hello-demo` | 示例 | `activityBar` 图标 + 自定义 cap `cap.demo.hello` | 插件开发样例与冒烟验证 |

Polaris 的其余业务（files-desk、polaris-git、browser-desk、terminal-desk、translate、dev-desk、im-bridge、model-desk、notification-desk、workspace-manager、needs 等）**不随 lite 迁移**；需要时按同一 manifest 契约另建插件，核心不用改。

---

## 6. 启动流程

**构建/开发**

```
pnpm i
pnpm dev      # 单进程：tsx watch server/src/index.ts，内嵌 vite middlewareMode（单端口 :9840，HMR 走同一端口）
pnpm build    # vite build web → web/dist；esbuild 打包各插件 server/main 与 web/panel.js
pnpm start    # node server/dist/index.js —— 单进程托管 API + SSE + 静态资源 + 插件资源
```

**服务器启动序列**（`server/src/index.ts`）：

1. 解析数据根（`POLARIS_LITE_DATA_ROOT` env > `./data`），生成/读取本机 token；
2. 打开 `configStore`、`sessionStore`（JSONL）、`auditLog`；
3. 构造 `RouterBus` + `sseHub`，注册核心 caps（ai.chat / session / history / kv / config / fs / registry / help）；
4. `pluginRegistry.scan()` → 装载并 `activate` 全部启用插件（贡献引擎与 cap）；
5. `http/app.ts` 装配路由与中间件（auth → rateLimit → routes → 静态托管），`listen(:9840)`；
6. 广播 `plugin-event: enabled`，打印能力目录摘要。

**浏览器启动序列**（对齐 Polaris `main.tsx` 的最小集）：

1. `main.tsx`：注入 `window.__LITE_HOST__`（transport + theme + i18n + toast）；`bootstrapTheme()` 同步注入 CSS 变量防 FOUC；
2. `fetch /api/plugins` + `/api/caps` → `pluginRegistry.replaceInstalled()`；
3. `render(<App/>)`：`useAppInit` 读取配置与主题 → `App.tsx` 解析 `getMainSurfaceClaim()`；
4. 命中 `chat-lite` → 懒加载其 `panel.js` 渲染四段式对话区；同时 `new EventSource('/api/events?channels=chat-event,bus-audit,plugin-event')` 建立事件流；
5. 未命中 claim → 渲染 `EmptyMainSlot`（提示安装对话插件）。

---

## 7. 与 Polaris 的复用/差异清单

**直接复制（复制后小改）**

| 来源（Polaris） | 去向（lite） | 改动 |
|---|---|---|
| `src/components/Common/Layout.tsx` + `ActivityBar/LeftPanel/RightPanel/CenterStage` | `web/src/layout/` | 删 Tauri 窗口依赖，席位渲染保留 |
| `src/plugin-system/{registry,panelRegistry,moduleLoader,schema}.ts` | `web/src/plugin-system/` | moduleLoader 从「磁盘 JS → Blob import」改为「`/plugins/:id/*` → import」；schema 删未用贡献点 |
| `src/services/themeEngine.ts` / `themeMerger.ts` / `i18n` / `locales` | `web/src/theme` `web/src/i18n` | 原样复制，transport 换 fetch |
| `src/types/aiEvent.ts` 的 chat-event 子集 | `web/src/protocol/aiEvent.ts` | 仅保留 delta/tool_call/tool_result/done/error/session.updated |
| `src/components/Chat/`（worktree `browser-desk-extraction` 中的 104 文件版本） | `plugins/chat-lite/web/` | 删 Tauri invoke，改走 `__LITE_HOST__.dispatch`；砍 search/dynamic-island/compact-handoff 等次要子树 |
| `src-tauri/src/web/rate_limit.rs` 思想 | `server/src/http/rateLimit.ts` | 令牌桶简化实现 |

**重写（契约对齐、实现全新）**

| Polaris 现状 | lite 重写 | 说明 |
|---|---|---|
| `services/router/mod.rs`（1,786 行 Rust） | `server/src/bus/routerBus.ts`（约 400 行 TS） | 保留 register/dispatch/dispatchStream/权限/审计语义，删 override 链等高级特性 |
| `web/api/ipc.rs` HTTP 桥（1,065 行） | `server/src/http/routes/capRoutes.ts`（约 150 行） | 2 条路由替代 IPC 全集 |
| 34 个 Rust capability | 9 个核心 TS cap | ai.chat/session/history/kv/config/fs/registry/help/events |
| `services/plugin_service.rs`（2,904 行）+ `supervisor/`（2,169 行） | `server/src/plugins/{registry,loader,manifest}.ts`（约 600 行） | 无子进程、无健康检查重启循环；进程内 import + 启停 |
| `services/storage_exec/`（4,964 行） | `server/src/store/sessionStore.ts`（约 300 行） | JSONL 追加日志 + 内存索引，替代 SQLite 分层 |
| `ai/engine/claude.rs`(1,772) + `simple_ai/`（10k+ 行） | `plugins/lite-engine-anthropic` / `lite-engine-openai`（合计约 1,200 行） | 直接 fetch 供应商流式 API；不内置 bash/fs/computer 工具执行器 |
| `services/proxy/`（5,039 行） | 无 | 供应商直连；密钥存 configStore |
| `appCoreBridge`（21 store + 30 命令白名单） | `__LITE_HOST__`（5 能力） | 收窄宿主桥，插件只经总线 |

**放弃（lite 不做）**

- Tauri/Rust 全部：`src-tauri/`（10.1 万行）、Cargo、MSI 打包、`tauri.conf.json`；
- 桌面专属能力：托盘、开机自启（cap.app.autolaunch）、应用自更新（cap.app.update）、深链、多窗口管理、原生菜单；
- 领域业务：`computer_control/`、`nexus_pipeline/`、`form/`、`ask_listener/`、`mcp_config_service`（MCP 改为可选插件）、`scheduler`、`file_explorer/file_watcher/file_clipboard` 命令、终端 PTY（cap.terminal）；
- 前端重业务残留：`fileExplorerStore`、`fileEditorStore`、`tabStore`、`editorExtensionRegistry`、`toolConfig/toolSummary` 大部分、PWA Service Worker；
- CenterStage 编辑器/SCM 全域（lite 的 CenterStage 仅保留占位，可被插件认领）。

---

## 8. 裁剪量化表

| 指标 | Polaris 现状 | S4 lite 目标 | 裁剪幅度 |
|---|---|---|---|
| Rust 代码 | 250 文件 / 101,032 行 | **0**（无 Rust，无需 Cargo） | -100% |
| 核心后端（服务器） | 同上 Rust + web 桥 | 约 **2,500 行 TS**（server/src 全部） | 按「核心保留 6-8k 行」的杠杆结论进一步压缩 |
| 前端核心 | 279 文件 / 49,794 行 | 约 **8,000 行**（壳 + plugin-system + transport + stores + theme/i18n） | ≈ -84% |
| Tauri commands | 36 个 | 0（8 条 HTTP 路由） | -100% |
| capability 数 | 34 个 impl / ~30 cap id | 9 个核心 cap + 插件动态 cap | ≈ -74% |
| AI 引擎 | claude.rs + simple_ai 10k+ 行 | 2 个引擎插件约 1,200 行 | ≈ -89% |
| 会话存储 | storage_exec 4,964 行（SQLite 分层） | sessionStore 约 300 行（JSONL） | ≈ -94% |
| 插件机制 | plugin_service+supervisor 5,073 行 + 子进程 | 进程内 registry 约 600 行 | ≈ -88% |
| 构建链 | pnpm + vite + cargo（Rust 编译分钟级） | pnpm + vite + esbuild（秒级） | 无 Rust 编译 |
| 分发形态 | MSI 安装包 | `npm i -g polaris-lite` 或单 Docker 镜像 / 单二进制（bun build --compile） | — |
| 冷启动 | Tauri 进程 + WebView 初始化 | node 直启 + 浏览器打开 `http://localhost:9840` | 预计 < 2s |
| 依赖面 | @tauri-apps/* + 大量 Rust crates | hono、zod、@tanstack/react（可选）、react/zustand/vite | 显著收窄 |

> 量化口径：Polaris 侧数字取自 `docs/baseline.md` 第 6 节实测；lite 侧为核心白名单目录的估算目标，验收时以 `cloc` 实测复核。

---

## 9. 迁移步骤（从 Polaris 到 lite）

1. **脚手架**：建 `polaris-lite` 仓（workspaces：server/web/plugins），配置 vite + tsx + vitest；复制 theme/i18n/Common 组件并接通 `bootstrapTheme`。
2. **总线先行**：实现 `routerBus.ts + audit.ts + permission.ts + sseHub.ts` 与 `POST /api/cap/dispatch`、`GET /api/events`；先移植 `cap.echo`/`cap.stream.echo` 作冒烟测试（对齐 Polaris 测试 capability 惯例）。
3. **核心 caps**：实现 kv → config → session（JSONL）→ history → registry/help；用 vitest 覆盖权限 deny 与审计入链。
4. **插件机制**：manifest zod schema（Polaris schema.ts 子集）→ loader（import main）→ registry（启停/重载）；写 `hello-demo` 验证 activityBar 贡献 + 自定义 cap。
5. **引擎插件**：写 `lite-engine-openai`（流式 SSE 解析 → ChatEventSink → sseHub 广播 chat-event），再写 `lite-engine-anthropic`；中断语义用 AbortController，interrupt 幂等。
6. **对话插件**：从 Polaris worktree 复制 `components/Chat/` 四段式子树入 `plugins/chat-lite/web`，替换数据层为 `__LITE_HOST__`；消息流消费 chat-event；会话侧栏走 cap.session。
7. **settings/history 插件**：供应商配置、主题语言、插件开关；历史抽屉接 cap.history。
8. **验收**：跑通「打开浏览器 → 建会话 → 流式对话 → 中断 → 历史」。实测 `cloc` 核心行数、冷启动时长，回填第 8 节表格；输出 README。

---

## 10. 风险与对策

| # | 风险 | 影响 | 对策 |
|---|---|---|---|
| 1 | **丢掉桌面能力**：无原生窗口管理、托盘、开机自启、自动更新、深链、多窗口；本地文件能力仅限服务器进程可及范围 | 对纯对话场景影响小；但「桌面应用感」与系统级集成消失 | ① 明确写入非目标；② 因 transport 是纯 HTTP/SSE，后续可用极薄 Tauri/Electron 壳包同一 web 产物获得桌面形态，核心零改动；③ fs cap 限定数据根 + 插件目录，不给任意路径 |
| 2 | **单进程故障域**：一个插件 activate 抛错或死循环可拖垮全部能力 | 可用性 | loader 对每个插件 activate 加超时与 try/catch，失败插件标记 `failed` 并广播 plugin-event，不阻断其余插件；核心 caps 先于插件注册 |
| 3 | **插件代码同特权**：进程内 import 无沙箱，服务端插件可访问任意 Node API；浏览器面板同源全权 | 安全 | 服务端只装载本地 `plugins/` 白名单目录（对齐 Polaris「安装目录扫描」而非任意远程装载）；manifest `permissions` 在总线层做真实裁决；后续可换 worker_threads 隔离（接口不变） |
| 4 | **SSE 工程问题**：反代缓冲、断线丢事件、连接数占用 | 对话卡顿/丢帧 | 响应头 `Cache-Control: no-cache`、`X-Accel-Buffering: no`；15s `ping` 心跳；事件带单调 seq，客户端用 `Last-Event-ID` 续传；同一浏览器多面板共享一条 EventSource（sseHub 引用计数） |
| 5 | **流式中断语义**：浏览器关闭页面/点停止后引擎仍继续生成，或误杀无关运行（Polaris 已知教训） | 计费浪费/串话 | `dispatchStream` 将 `ctx.signal`（req.close）与 `interrupt` 动作都接到 `ChatRunHandle.abort`；interrupt 按 `runId` 精确取消，幂等可重入；引擎插件层对「abort 后到达的 delta」静默丢弃 |
| 6 | **协议无 schema 校验**（Polaris 已知缺口在 TS 侧同样存在） | 前后端漂移 | 全部 cap payload 用 zod schema 双端共享（`packages/protocol`），CI 校验 chat-event kind 枚举与 Polaris 子集一致 |
| 7 | **鉴权薄弱**：本机 HTTP 服务可能被同机其他进程/CSRF 调用 | 数据泄露 | 默认仅绑定 `127.0.0.1`；首启生成 token 存 `dataRoot/token`（0600），浏览器经首次访问的引导页注入；`POST` 全部要求 Bearer；限流兜底 |
| 8 | **迁移工作量集中在 chat 面板**：worktree Chat 树 2.7 万行，直接搬会带入隐藏依赖 | 工期 | 只搬四段式必需子树（session/messages/input/chatBlocks），其余（search、dynamic-island、compact-handoff）不迁；数据层统一经 `__LITE_HOST__`，禁止面板直连 fetch |
| 9 | **多用户/远程部署误用**：本方案按单用户本机工具设计 | 误用于团队场景 | 文档明示定位；如需多人，另立「加鉴权与多租户」的演进方案，不混入 lite 主线 |

---

## 11. 与矩阵其他格式的边界自查

- 与 S1/S2/S3/S7/S8/S9 的区别：S4 的核心差异在**宿主形态**——无 Tauri、无 Rust、单 Node 进程、浏览器访问；cap 总线具体化为 HTTP `dispatch` + SSE 流。插件机制虽同为注册表，但 S4 强调**服务端半边与 UI 半边分离的进程内插件**（main + panel.entry 双入口）。
- 与 S10（桌面双进程）互为镜像：S10 保留桌面壳、把逻辑推给 Node 宿主进程；S4 连桌面壳也不要。两者共享「JS 宿主 + cap 总线」思路，但 S4 的部署单元是 URL 而非安装包。
