# S6 Web Components：框架无关插件化

> 矩阵第 6 格：核心框架无关（不绑定 React），面板 = 自定义元素（`customElements`）；AI 对话 UI 为 wc 插件；插件机制 = customElements 注册 + 属性/事件契约；前端栈 = 框架无关（核心零框架依赖，插件可用任意栈实现）。
>
> 与 Polaris 现状的**根本差异**：Polaris 的插件面板契约是 `load(panelType) → React.ComponentType`（`plugin-system/panelRegistry.ts`），宿主桥 `appCoreBridge.ts` 直接向插件泄漏 21 个 Zustand store 与 React 运行时（`__POLARIS_HOST_REACT__`），插件与宿主**共享同一份 React 树与状态实例**——这是强耦合。S6 把耦合面收窄为浏览器原生的 `customElements` + attributes/events/DOM：核心不 import 任何 UI 框架，插件可以是 React、Vue、Svelte、Lit 乃至纯 vanilla，只要它最终以自定义元素的形式挂到宿主给定的槽位 DOM 上。

## 0. 一句话定位

宿主核心是一个**零框架依赖的元素容器平台**：它只做四件事——提供四段式对话布局的槽位 DOM、维护 customElements 插件注册表、转发 cap 总线调用、广播宿主事件；一切业务 UI（包括 AI 对话）都是注册进来的自定义元素。

---

## 1. 架构图（文字图）

```
┌────────────────────────────── 浏览器（Tauri WebView / 纯 Web） ──────────────────────────────┐
│                                                                                              │
│  ┌─────────────────────── 宿主核心（零框架，vanilla TS，目标 ≤6k 行） ─────────────────────┐  │
│  │                                                                                        │  │
│  │   <polaris-app>                         ElementRegistry                                │  │
│  │   ├─ <polaris-topbar>                   ─────────────────                              │  │
│  │   ├─ <polaris-shell>                    • manifest → tag name 解析                     │  │
│  │   │   ├─ <polaris-activitybar>          • dynamic import(plugin entry)                 │  │
│  │   │   ├─ <polaris-leftpanel>            • 生命周期编排 (enable/disable/upgrade)        │  │
│  │   │   │   └─ [slot: left.tabs] ← 插件元素挂载点                                        │  │
│  │   │   ├─ <polaris-center>（可选预览位）  CapBridge                                      │  │
│  │   │   └─ <polaris-rightpanel>           ─────────                                      │  │
│  │   │       └─ [slot: main.surface]      invoke(cap, payload) → Transport               │  │
│  │   │           └─ chat-desk wc 插件      subscribe(event) ← EventBus                   │  │
│  │   │               ├─ <chat-session-rail>（会话侧栏）                                   │  │
│  │   │               ├─ <chat-message-stream>（消息流）                                   │  │
│  │   │               ├─ <chat-composer>（底部输入区）                                     │  │
│  │   │               └─ <chat-tool-panel>（面板区/工具卡片）                              │  │
│  │   └─ <polaris-overlay-host> [slot: overlay.*]                                          │  │
│  │                                                                                        │  │
│  │   EventBus（宿主→插件单向广播）         ThemeService / I18n（框架无关）                │  │
│  └────────────────────────────────────────────────────────────────────────────────────────┘  │
│                     │ invoke / stream                            │ CustomEvent                │
│                     ▼                                            ▼                            │
│  ┌────────────────── Transport 层 ──────────────┐        插件元素（各用各的栈渲染 Shadow DOM） │
│  │ TauriTransport | HttpTransport（二选一）      │        <files-desk-panel>  (React 18 内嵌)   │
│  └──────────────────┬───────────────────────────┘        <git-status-panel>  (Vue 3 内嵌)     │
│                     │ JSON-RPC / SSE                                                        │
└─────────────────────┼───────────────────────────────────────────────────────────────────────┘
                      ▼
┌──────────────────── Rust 后端（裁剪自 Polaris） ─────────────────────────────────────────────┐
│  router_dispatch / router_dispatch_stream                                                    │
│      └─ RouterBus（权限 gate + 审计 + 转发）                                                 │
│          ├─ cap.ai.chat（streaming）→ ai_chat_core → EngineRegistry                          │
│          ├─ cap.session / cap.history / cap.storage                                          │
│          ├─ cap.fs / cap.bash / cap.http / cap.kv / cap.config / cap.mcp …                   │
│          └─ cap.pluginDiscovery / cap.pluginServiceManager                                   │
│  EventBroadcaster ── SSE / Tauri event ──▶ 前端 EventBus（chat-event 等）                    │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

数据流与 Polaris 现状同构：**UI 元素 → CapBridge.invoke('cap.*') → RouterBus → capability → 事件回流 EventBus → 元素属性/内部状态更新**。唯一变化是 UI 层从「React 组件树 + Zustand 共享」换成「自定义元素 + 每元素自治状态」。

---

## 2. 核心目录树

```
polaris-lite/
├─ package.json                    # 核心唯一依赖：typescript + vite；零 runtime UI 框架
├─ vite.config.ts
├─ src/
│  ├─ main.ts                      # 启动：theme → transport → registry → <polaris-app>
│  ├─ core/
│  │  ├─ registry/
│  │  │  ├─ element-registry.ts    # 插件→自定义元素注册表（替代 panelRegistry）
│  │  │  ├─ manifest-schema.ts     # plugin.json 校验（精简自 Polaris schema.ts）
│  │  │  └─ loader.ts              # 动态 import 插件入口模块
│  │  ├─ bus/
│  │  │  ├─ cap-bridge.ts          # invoke/stream 封装 + 权限上下文注入
│  │  │  ├─ event-bus.ts           # 宿主事件广播（chat-event 等）
│  │  │  └─ permission.ts          # 前端侧 capability 白名单
│  │  ├─ transport/
│  │  │  ├─ tauri-transport.ts     # window.__TAURI__.invoke / listen
│  │  │  ├─ http-transport.ts      # fetch /api + EventSource（Web-only 形态）
│  │  │  └─ index.ts               # 按环境选择
│  │  ├─ shell/
│  │  │  ├─ polaris-app.ts         # 顶层布局元素
│  │  │  ├─ polaris-shell.ts       # activitybar + left + center + right
│  │  │  ├─ polaris-slot.ts        # 通用槽位元素（声明式挂载点）
│  │  │  └─ polaris-overlay-host.ts
│  │  ├─ theme/theme-service.ts    # CSS 变量注入（复用 Polaris token 体系）
│  │  ├─ i18n/i18n.ts              # 极简 t() （框架无关，~100 行）
│  │  └─ lifecycle/plugin-lifecycle.ts  # install/enable/disable/upgrade 编排
│  ├─ types/
│  │  ├─ manifest.ts               # PluginManifest（wc 精简版）
│  │  ├─ element-contract.ts       # PolarisElement 接口 / CapBridge 注入类型
│  │  └─ cap.ts                    # cap id 与 payload 类型（与后端同步）
│  └─ styles/
│     ├─ tokens.css                # 主题变量（复制 Polaris .polaris-theme 子集）
│     └─ shell.css                 # 布局骨架样式
├─ src-tauri/                      # Rust 侧：复制 Polaris 后按白名单裁剪（见 §8）
│  └─ src/
│     ├─ commands/router.rs        # router_dispatch / _stream / list_caps
│     ├─ services/router/          # RouterBus + 精选 capability
│     ├─ services/ai_chat_core/    # 对话业务核（保留，经 cap.ai.chat 暴露）
│     ├─ services/ai/              # EngineRegistry + 引擎
│     ├─ services/plugin_service.rs# 插件发现/安装/manifest 校验
│     └─ services/data_root.rs / logger.rs / config_store.rs
└─ plugins/                        # wc 插件仓
   ├─ chat-desk-wc/                # AI 对话插件（四元素组合）
   ├─ files-desk-wc/
   ├─ git-desk-wc/
   └─ settings-desk-wc/
```

**关键取舍**：核心 `src/core/shell/` 全部是原生 custom element（`HTMLElement` 子类），无 JSX、无框架 runtime；`package.json` 的 `dependencies` 为空对象（仅 devDependencies：`typescript`、`vite`、`@custom-elements-manifest/analyzer` 可选）。

---

## 3. 核心契约

### 3.1 custom element 名称规范

| 规则 | 约定 | 示例 |
|---|---|---|
| 前缀 | 核心壳元素一律 `polaris-` | `<polaris-shell>` |
| 插件元素 | `<插件id 的 kebab-case>-panel` | `<chat-desk-panel>`、`<files-desk-panel>` |
| 插件内部子元素 | `<插件id>-<子名>`，不注册到全局 registry 之外使用 | `<chat-desk-session-rail>` |
| 禁止 | 无前缀裸名、复数、大写 | `<panel>`、`<ChatPanel>` |
| 冲突 | `customElements.get(tag)` 已存在时拒绝二次 define，registry 记录 `tag → pluginId` 归属，卸载插件仅 disconnect 实例、不删除定义（浏览器限制），并在 manifest 校验期拦截 tag 冲突 | — |

manifest 中声明方式（`contributes.elements`，替代 Polaris 的 `contributes.views[].panelType`）：

```jsonc
// plugins/chat-desk-wc/plugin.json（节选）
{
  "id": "chat-desk",
  "version": "1.0.0",
  "manifestVersion": "2.0-wc",
  "contributes": {
    "elements": [
      {
        "tag": "chat-desk-panel",
        "entry": "./dist/element.js",        // ESM，副作用：customElements.define
        "slot": "main.surface",
        "order": 0,
        "icon": "./assets/icon.svg",
        "labelKey": "plugin.chat-desk.title"
      },
      {
        "tag": "chat-desk-overlay-history",
        "entry": "./dist/element.js",
        "slot": "overlay.session-history"
      }
    ],
    "capabilities": [
      { "id": "cap.chat.desk", "summary": "会话配置读写", "handler": "plugin-rpc" }
    ],
    "permissions": { "chatEvents": "full", "appConfigRead": true }
  }
}
```

### 3.2 属性 / 事件 / 生命周期签名

所有插件面板元素实现统一接口（`src/types/element-contract.ts`）：

```ts
/** 宿主注入到每个插件元素的运行时能力包 */
export interface PolarisContext {
  readonly pluginId: string;
  /** 调用 cap 总线（等价 Polaris 的 __POLARIS_HOST_INVOKE__，但只走 cap） */
  invoke<T = unknown>(cap: string, payload: unknown): Promise<T>;
  /** 打开流式调用（cap.ai.chat start/continue 等），返回异步事件迭代器 */
  stream(cap: string, payload: unknown): AsyncIterable<HostEvent>;
  /** 订阅宿主广播事件，返回取消订阅函数 */
  subscribe(type: string, fn: (e: HostEvent) => void): () => void;
  /** 主题 token 读取（CSS 变量名），保证插件外观随主题 */
  theme(): Readonly<Record<string, string>>;
  /** 框架无关 i18n */
  t(key: string, params?: Record<string, string | number>): string;
}

export interface HostEvent {
  type: string;            // 'chat-event' | 'config-changed' | 'theme-changed' | ...
  payload: unknown;
  reason?: string;         // 对齐 Polaris「广播事件尽量带 reason」的纪律
}

/** 所有可挂载面板元素的基类契约 */
export interface PolarisPanelElement extends HTMLElement {
  /** 宿主在 connectedCallback 前注入；元素不得自行构造 CapBridge */
  polaris: PolarisContext;
  /** 槽位元信息（manifest contributes.elements[i]） */
  readonly slotMeta: { slot: string; order: number };
  /** 可选：面板打开/关闭时宿主调用（比 connected/disconnected 更明确业务语义） */
  onActivate?(): void | Promise<void>;
  onDeactivate?(): void | Promise<void>;
}

export declare function definePolarisPanel(
  tag: string,
  ctor: CustomElementConstructor & { observedAttributes?: string[] }
): void;
```

属性契约（attributes / properties 双通道）：

```ts
class ChatDeskPanel extends HTMLElement implements PolarisPanelElement {
  static get observedAttributes() {
    return ['session-id', 'compact', 'disabled'];   // 声明式：宿主/其他元素可用 HTML 属性驱动
  }
  attributeChangedCallback(name: string, oldV: string | null, newV: string | null) {
    if (name === 'session-id' && oldV !== newV) this.#reload(newV);       // 切会话
    if (name === 'compact')       this.#layout = newV === 'true' ? 'compact' : 'full';
  }
  /** 命令式通道：宿主直接 set property（复杂对象走 property，不走 attribute） */
  set context(ctx: PolarisContext) { this.#ctx = ctx; }
  get polaris() { return this.#ctx; }
  #ctx!: PolarisContext;
}
```

事件契约（插件 → 宿主方向）：

```ts
// 1. 请求型事件：冒泡 + composed，宿主 shell 监听并走 cap 或路由
this.dispatchEvent(new CustomEvent('polaris:navigate', {
  bubbles: true, composed: true,
  detail: { slot: 'main.surface', panel: 'settings-desk-panel', params: { tab: 'plugins' } },
}));

// 2. 通知型事件：toast / badge
this.dispatchEvent(new CustomEvent('polaris:toast', {
  bubbles: true, composed: true,
  detail: { level: 'warn', messageKey: 'chat-desk.send-failed' },
}));

// 3. 会话历史抽屉等 overlay 请求
this.dispatchEvent(new CustomEvent('polaris:overlay', {
  bubbles: true, composed: true,
  detail: { slot: 'overlay.session-history', action: 'open' | 'close' },
}));
```

元素生命周期（宿主编排顺序）：

```
registry.load(pluginId)
  → loader.import(entry)                      # 动态 import，模块顶层 customElements.define
  → document.createElement(tag)
  → el.context = buildContext(pluginId)       # 注入 PolarisContext（invoke/stream/subscribe/t）
  → slotHost.append(el)                       # 挂入 <polaris-slot name="main.surface">
  → el.connectedCallback() → el.onActivate?()
  …运行期：attribute/property 更新、cap 调用、事件订阅…
  → el.onDeactivate?() → el.disconnectedCallback()
  → registry.unload(pluginId)                 # 移除 DOM；class 定义保留（浏览器限制），registry 标记 disabled
```

### 3.3 cap 桥接接口

前端 `CapBridge`（`src/core/bus/cap-bridge.ts`）——插件元素**唯一**的后端通道，替代 Polaris 中插件直连 30 个 `__POLARIS_HOST_INVOKE__` 白名单命令的做法：

```ts
export interface CapBridge {
  invoke<T = unknown>(cap: string, payload: unknown, opts?: { signal?: AbortSignal }): Promise<T>;
  stream(cap: string, payload: unknown): AsyncIterable<HostEvent>;
  listCaps(): Promise<CapDescriptor[]>;                       // 对应 router_list_caps
  onEvent(type: string, fn: (e: HostEvent) => void): () => void;
}

class TauriCapBridge implements CapBridge {
  async invoke<T>(cap: string, payload: unknown): Promise<T> {
    // 与 Polaris chatService.ts 完全同构：单入口 router_dispatch
    return window.__TAURI__.core.invoke('router_dispatch', {
      target: cap, payload,
    });
  }
  async *stream(cap: string, payload: unknown): AsyncIterable<HostEvent> {
    const un = await window.__TAURI__.event.listen<HostEvent>('chat-event', (e) => queue.push(e.payload));
    yield* queue;      // 简化示意：实际用 AsyncQueue
    un();
  }
}
```

Rust 侧入口保持 Polaris 原样三件套：`router_dispatch` / `router_dispatch_stream` / `router_list_caps`（`commands/router.rs`），RouterBus 权限 gate 与审计不简化。**差异**：插件声明的 `capabilities[]` handler 只保留 `plugin-rpc`（插件进程内 RPC），裁掉 `forward` 类与 `cap.dyn.*` 动态注册——lite 阶段插件不向总线注册新 cap，减少一半动态装配复杂度。

---

## 4. AI 对话插件挂载

### 4.1 布局不变：四段式 = 四个嵌套自定义元素

Polaris 现状对话区是「会话侧栏 + 消息流 + 底部输入区 + 面板区」四段式（见 baseline §1）。S6 中该布局**由 chat-desk 插件内部用 wc 元素组合实现**，宿主只给一个 `main.surface` 槽位：

```html
<!-- 宿主 <polaris-rightpanel> 内部（核心提供，仅一个槽位） -->
<polaris-rightpanel>
  <polaris-slot name="main.surface"></polaris-slot>
</polaris-rightpanel>

<!-- 挂载后（插件提供） -->
<chat-desk-panel session-id="sess_01">
  #shadow-root
    <div class="chat-grid">            <!-- grid: 260px 1fr / 1fr 320px，复刻 Polaris 布局 -->
      <chat-desk-session-rail></chat-desk-session-rail>   <!-- 左：会话侧栏 -->
      <div class="chat-main">
        <chat-desk-message-stream session-id="sess_01"></chat-desk-message-stream>
        <chat-desk-composer session-id="sess_01"></chat-desk-composer>  <!-- 底部输入区 -->
      </div>
      <chat-desk-tool-panel session-id="sess_01"></chat-desk-tool-panel> <!-- 右：面板区 -->
    </div>
</chat-desk-panel>
```

四个子元素由同一插件模块定义（一次 `import` 全部 define），内部各自用 Lit 或原生模板渲染 Shadow DOM；会话状态保留 Polaris 的「日志即真相」思路——元素订阅 `chat-event` 事件流在本地重建视图，不与宿主共享 store。

### 4.2 会话数据链路（与 Polaris 现状逐点对齐）

```
<chat-desk-composer> 用户发送
  → this.polaris.invoke('cap.ai.chat', { action:'start', sessionId, text, attachments })
  → RouterBus → AiChatCapability → ai_chat_core.start_chat → EngineRegistry
  ← EventBroadcaster 'chat-event'（流式 delta / tool_call / done / error）
  ← CapBridge.stream → <chat-desk-message-stream> 增量渲染
中断：invoke('cap.ai.chat', { action:'interrupt', sessionId })，幂等语义与 Polaris 一致
会话列表：invoke('cap.session', { action:'list' }) / cap.history
```

### 4.3 挂载判定逻辑

宿主 shell 按 Polaris `App.tsx:364-383` 的语义重写为框架无关版本：

```ts
// core/shell/polaris-rightpanel.ts（节选）
async mountMainSurface() {
  const claim = this.registry.mainSurfaceClaim();        // 第一个 slot==='main.surface' 且 enabled 的插件
  if (!claim) { this.renderEmptyGuide(); return; }       // 对应 ChatMainSlot 空态卡
  const el = await this.registry.mount(claim.pluginId);  // 动态 import + createElement + 注入 context
  this.slotHost.replaceChildren(el);
}
```

---

## 5. 插件清单

| 插件 | 提供元素 | 槽位 | 实现栈 | 对应 Polaris 现状 |
|---|---|---|---|---|
| chat-desk-wc | `<chat-desk-panel>` + 4 个子元素 | main.surface | Lit（或 vanilla） | chat-desk（23.7k 行 React）→ 目标重写 ≤6k 行 |
| files-desk-wc | `<files-desk-panel>` | left.tabs | React 18（经 wc 包装） | files-desk |
| git-desk-wc | `<git-status-panel>` | left.tabs | Vue 3（经 wc 包装） | polaris-git |
| terminal-desk-wc | `<terminal-panel>` | left.tabs | vanilla | terminal-desk |
| settings-desk-wc | `<settings-panel>` | settings 覆盖层 | vanilla | settings-desk |
| history-desk-wc | `<history-overlay>` | overlay.session-history | vanilla | history-desk |
| translate-wc | `<translate-panel>` | left.tabs | vanilla | translate |

**混栈是本方案的验收点**：files-desk 用 React、git-desk 用 Vue，二者同时挂载在宿主上互不感知——因为耦合面只有 attributes/events/DOM。每个插件自带框架 runtime（ESM import），宿主 bundle 中一个框架都没有。

---

## 6. 启动流程

```
1. main.ts: 注入主题 CSS 变量（bootstrapTheme，同步防 FOUC，复用 Polaris themeEngine 逻辑）
2. new TauriCapBridge()（或 HttpCapBridge，按 window.__TAURI__ 探测）      # 对应 transport/detector
3. await bridge.invoke('cap.config', { action:'load' })                   # loadConfig
4. await bridge.invoke('cap.pluginDiscovery', { action:'list_installed' })
   → manifest 校验（manifest-schema.ts）→ ElementRegistry.replaceInstalled()
5. 启用插件按 manifest 顺序 loader.import(entry)                          # 顶层 customElements.define
6. document.body.append(<polaris-app>) → polaris-shell connectedCallback
   → ActivityBar 渲染已启用插件 icon（contributes.elements 有 left.tabs 槽位者）
   → mountMainSurface()：chat-desk-wc 优先（core:true）
7. EventBridge：监听后端 'chat-event'/'plugin-event' → EventBus 分发到订阅元素
8. 事件/主题变化 → shell 只做 attribute 透传（如 <chat-desk-panel compact="true">），不持有业务状态
```

最小启动集 = transport + theme + config + ElementRegistry + shell，代码目标 ≤6k 行 TS（Polaris main.tsx 250 行 + App.tsx 522 行 + plugin-system 约 1.5k 行 + 布局组件约 1.6k 行 → wc 化后合计压缩）。

---

## 7. 与 Polaris 复用 / 差异清单

### 7.1 直接复制（不改或微改）

| 来源（Polaris） | 内容 | 处理 |
|---|---|---|
| `src-tauri/src/services/router/mod.rs` + `commands/router.rs` | RouterBus、dispatch、权限 gate、审计 | 原样复制 |
| `src-tauri/src/services/ai_chat_core/` | 对话业务核 | 原样复制 |
| `src-tauri/src/services/ai/`（registry + engines） | 引擎调度 | 原样复制（可选砍 simple_ai 部分 tools） |
| `services/data_root.rs`、`logger.rs`、`config_store.rs`、`error.rs` | 基础设施 | 原样复制 |
| `services/plugin_service.rs` | 插件发现/安装/manifest 校验 | 复制后删 UI 无关的 `chatCards/uiTemplates/executors/adapters` 字段校验 |
| `web/`（server/event_broadcaster/ipc.rs 精简） | Web 形态支撑 | 复制后裁剪 |
| 前端 `services/transport/`、`themeEngine` 核心、i18n 机制 | 基础设施 | 复制后去 React 化（themeEngine 的 React hook 部分重写） |
| `src/types/aiEvent.ts`、`session.ts` | 协议类型 | 原样复制（cap 契约不变） |

### 7.2 重写

| 内容 | 原因 |
|---|---|
| `plugin-system/panelRegistry.ts` + `pluginModuleLoader.ts` → `core/registry/element-registry.ts` + `loader.ts` | 契约从「返回 React 组件」改为「define 自定义元素」 |
| `appCoreBridge.ts`（21 store + 30 命令泄漏）→ `PolarisContext`（invoke/stream/subscribe/t） | 收窄耦合面，这是本方案的核心治理动作 |
| `components/Layout/*`（ActivityBar/LeftPanel/RightPanel/CenterStage）→ `core/shell/*` wc 元素 | 去 React 化，壳层保留四段式 DOM 结构 |
| `main.tsx`/`App.tsx` 启动编排 → `main.ts` | 无 React root |
| chat-desk → chat-desk-wc | UI 层用 wc 重写；数据链路（cap.ai.chat + chat-event）契约不变 |

### 7.3 放弃

- `src/components/Chat/`（主仓已删，不恢复；worktree 里的 26.9k 行不迁移）；
- Zustand 全家桶（21 store 共享模式整体废弃；插件内部可用任意状态方案）；
- `chatCardRegistry`、`uiTemplateRegistry`、`editorExtensionRegistry`、`editorScmProvider`（业务注册点）；
- `__POLARIS_HOST_REACT__ / REACT_DOM / USE_TRANSLATION__` 宿主桥（React 泄漏通道）；
- cap.dyn.*、plugin capabilities 的 forward handler、`cap.ui.render` DSL（lite 阶段不需要）。

---

## 8. 裁剪量化表

| 指标 | Polaris 现状 | S6 目标 | 裁剪方式 |
|---|---|---|---|
| 前端总行数（非测试） | 49,794 | **≤9,000**（核心 ≤6k + 壳样式/i18n ~3k） | React 树、stores、业务注册点全弃；chat-desk 23.7k 外置为 wc 插件 |
| 核心 runtime 依赖 | react/react-dom/zustand/i18next/... | **0** | wc 原生能力替代 |
| Rust 总行数 | 101,032 | **≤55,000** | 保留 router+ai 链路+plugin_service+web；砍 computer_control/nexus/form/ask_listener/proxy 大部分/storage_exec 简化 |
| RouterBus capability | 34 个 impl / ~30 cap id | **12~14 个**：ai.chat、session、history、storage、fs、bash、http、kv、config、mcp、pluginDiscovery、pluginServiceManager、meta、help | 其余随域出仓 |
| Tauri commands | 36 | **≤6**（router 三件套 + plugin 三件套） | 一律走 cap |
| 插件宿主桥面积 | 21 store + 30 命令 + React 运行时 | **PolarisContext 5 个方法** | 契约收窄 |
| 启动关键路径 | React render + 21 store 初始化 + 插件 bootstrap | theme → transport → registry → shell append | 纯 DOM，无可比性但更短 |

---

## 9. 迁移步骤

1. **D0 建仓**：`polaris-lite` 独立仓；复制 §7.1 清单中 Rust 文件；`cargo check` 过关。
2. **D1 核心壳**：实现 `polaris-app/shell/slot` 三元素 + CapBridge（Tauri/Http 双 transport）+ theme/i18n；空插件占位渲染。
3. **D2 契约固化**：`manifest 2.0-wc` schema、`PolarisContext`/`definePolarisPanel` 类型、事件命名表，写入 `docs/` 并冻结 v1。
4. **D3 首个 vanilla 插件**：settings-desk-wc 挂 settings 覆盖层，验证 discover→define→mount→invoke→event 全链路。
5. **D4 对话插件**：chat-desk-wc 四元素接通 cap.ai.chat / cap.session / chat-event，做到发消息、流式渲染、中断、切会话四项可用。
6. **D5 混栈验证**：files-desk-wc（React wrapper）与 git-desk-wc（Vue wrapper）同挂 left.tabs，验证互操作与主题一致。
7. **D6 裁剪收尾**：删复制代码中 lite 不用的 capability 与命令，跑 web-only 门禁，量化表实测回填。

---

## 10. 风险与对策

| 风险 | 说明 | 对策 |
|---|---|---|
| **React 与 wc 互操作成本（最大风险）** | React 对 customElements 的 props/事件支持不完整：属性只认 string，复杂对象需 ref+property 双通道；合成事件不冒泡进 shadow DOM 需手动 retarget | ① 统一经 `@lit/react` 或手写 30 行 `wrapReact(Element)` wrapper（files-desk 内部自用，不进核心）；② 复杂参数一律走 property setter（契约已定义 `context` property 通道），HTML attribute 只承载 string；③ 事件用 `composed:true` + 宿主 shell 统一监听转发，插件内部事件不跨边界 |
| Shadow DOM 样式隔离与主题断裂 | 插件拿不到宿主全局 CSS；主题变量需手动穿透 | 主题 token 走 CSS 自定义属性（可穿透 shadow boundary），`PolarisContext.theme()` 返回当前 token 快照；`theme-changed` 事件通知插件重读 |
| wc 生态基建弱于 React | 表单、虚拟列表、拖拽等需自建或引 Web Component 库 | chat 消息流用 `virtua`-类 vanilla 方案或 Lit + 现成 wc 组件（Vaadin/shoelace 子集）；输入区逻辑复杂部分插件内部仍可用 React 渲染后包成元素 |
| 会话状态从共享 store 改为元素自治 | 多元素（rail/stream/composer）需一致视图，可能出现短暂不一致 | 仍守「日志即真相」：三元素都订阅同一 chat-event 流各自投影，事件顺序即真相；元素间用属性/事件同步会话 id |
| 旧 chat-desk 23.7k 行重写工作量 | 直接重写成本高 | 迁移期允许「React in wc」：用 `createRoot` 把现有 React 子树包进 `<chat-desk-panel>`，先把边界立住，再逐元素替换（与 S7 渐进策略在插件内部合流） |
| customElements 定义不可卸载 | disable 插件后定义仍在，可能被恶意重复 define | registry 校验 tag 归属，卸载仅移除 DOM + 标记 disabled；重复 define 在 import 层 try/catch 并审计 |
| SSR/测试工具链不熟悉 | vitest 默认环境需 DOM/shadow 支持 | vitest + `@open-wc/testing`；核心元素测试用原生 DOM 断言 |

---

## 11. 结论

S6 用浏览器原生的 customElements 把「插件 = UI」这件事做到协议级：核心连 React 都不认识，耦合面收敛为一个 `PolarisContext`（5 个方法）+ 一组命名元素契约。相比 Polaris 现状（插件与宿主共享 React 树、21 个 store、30 个命令白名单），S6 的核心是真正意义上「零业务、零框架」的元素容器平台；代价是 chat-desk 的 UI 层需要一次 wc 化重写，以及 React 插件需要 wrapper 适配——这两点通过「React in wc」渐进包装把成本控制在插件侧，不动核心。
