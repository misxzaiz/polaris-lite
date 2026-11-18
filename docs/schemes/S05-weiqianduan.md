# S5 微前端：Module Federation 插件化

> 矩阵第 5 格：核心 = 布局壳 + Module Federation 运行时；每个面板 / 对话 = 远程微前端模块；插件机制 = 模块联邦 + 生命周期协议（mount/unmount）；前端栈 = React + 模块化加载。
> 依据：`docs/brief.md`（P1~P8 + 硬性约束）与 `docs/baseline.md`（Polaris 事实基线）。

---

## 1. 方案定位与差异化

### 1.1 一句话定位

把 Polaris 的「布局壳 + Blob-URL 动态 import 插件加载器」升级为标准的 **Module Federation 微前端架构**：`polaris-shell`（host）只保留四段式布局骨架、cap 总线客户端、主题/i18n 和联邦运行时；AI 对话（chat-desk）与全部业务面板（files/git/terminal/settings/…）都是**独立构建、独立部署、运行时装配**的 remote 模块，通过统一的 `RemoteLifecycle` 协议挂载/卸载。

### 1.2 与 Polaris 现有 Blob-URL 动态 import 的差异（本方案核心论点）

Polaris 现状（`src/plugin-system/pluginModuleLoader.ts`，155 行）的加载方式是：

```
读插件磁盘 JS（download_file_binary，因 get_file_content 有 1MB 文本限制）
  → 正则改写 import "react" / "react-dom" 为 Blob shim URL
  → new Blob([patchedCode]) → URL.createObjectURL → 动态 import(blobUrl) → revokeObjectURL
```

该机制在实践中暴露的问题（baseline 已记录）：正则改写在 mermaid 反引号模板串密集段错位导致漏改写；大 vendor bundle 触发文本读取上限；模块级单例因重复加载出现双实例（AI 回复重复显示，靠 moduleCache 补救）；插件与宿主靠 `window.__POLARIS_HOST_REACT__` 等 8+ 个全局桥共享实例。

S5 用**构建期联邦**取代这套运行时字符串手术：

| 维度 | Polaris Blob-URL loader | S5 Module Federation |
|---|---|---|
| 模块解析 | 运行时正则改写源码字符串 | 构建期 bundler 解析 import，零源码改写 |
| 共享依赖 | window 全局 shim（逐成员导出，缺失即 undefined） | federation shared 协议：版本协商 + singleton 保证单实例 |
| 构建隔离 | 插件 bundle 与宿主构建无关，但也没有类型契约 | 每个 remote 独立 vite 构建，契约由 `@polaris-lite/federation-contract` 包约束 |
| 部署单元 | 单文件 JS 放插件目录，宿主经 Tauri fs 读取 | remoteEntry.js + 分包 chunk，同源 HTTP/自定义协议服务，浏览器 HTTP 缓存生效 |
| 重复执行防护 | 手写 moduleCache | ES module 语义天然单次执行 |
| 跨模块通信 | appCoreBridge 泄漏 21 个 store + 30 命令白名单 | remote 只拿到 `CapClient` + `EventBus`，**不再泄漏宿主 store** |
| 独立开发 | 插件须依赖宿主运行环境 | 每个 remote 有独立 dev server 与独立入口，可单独调试 |

### 1.3 技术选型

- **联邦实现**：`@originjs/vite-plugin-federation`（Vite 原生生态，与 Polaris 的 Vite 栈零迁移；备选 webpack 5 `ModuleFederationPlugin`，见 §12 风险）。
- **前端栈**：React 18 + Zustand + Vite + TypeScript，与 Polaris 同栈，组件级复用成本最低（约束 5）。
- **后端**：保留精简 Rust 核心（Tauri 可选 / Web 必选），cap 总线（RouterBus）原样继承——微前端只改变 **UI 装配方式**，不改业务数据面。

---

## 2. 架构图（文字图）

```
┌─────────────────────────────── 浏览器 / WebView 窗口 ───────────────────────────────┐
│                                                                                      │
│  ┌──────────────────────────── HOST: polaris-shell ──────────────────────────────┐  │
│  │  main.tsx → App.tsx                                                           │  │
│  │  ┌───────────── Layout（四段式布局壳，布局不变）─────────────┐                 │  │
│  │  │ TopMenuBar │ ActivityBar │ LeftPanel │ CenterStage │ RightPanel │             │  │
│  │  └──────┬─────┴─────┬──────┴────┬─────┴─────┬──────┴────┬──────┘                 │  │
│  │         │ 席位图标   │ 席位面板   │  (可选)    │  mainSurface/overlay 槽位          │  │
│  │         ▼           ▼           ▼           ▼                                   │  │
│  │  ┌──────────────── RemoteSlot（联邦挂载点）────────────────┐                     │  │
│  │  │ remoteRegistry → remoteLoader → lifecycleRunner        │                     │  │
│  │  │  ① import(remoteEntryUrl) ② module.mount(ctx) ③ unmount │                     │  │
│  │  └──────┬──────────────────┬──────────────────┬───────────┘                     │  │
│  │         │                  │                  │                                  │  │
│  └─────────┼──────────────────┼──────────────────┼──────────────────────────────────┘  │
│            │                  │                  │                                      │
│  ┌─────────▼───────┐ ┌────────▼────────┐ ┌───────▼─────────┐   …更多 remote           │
│  │ REMOTE chat-desk│ │ REMOTE files-desk│ │ REMOTE polaris-git│  (settings/terminal/  │
│  │  exposes:       │ │  exposes:        │ │  exposes:         │   history/translate/  │
│  │   ./Panel       │ │   ./Panel        │ │   ./Panel         │   dev-desk)           │
│  │   ./manifest    │ │   ./manifest     │ │   ./manifest      │                       │
│  │  内部保持 Polaris│ │                  │ │                   │                       │
│  │  四段式对话布局： │ │                  │ │                   │                       │
│  │  会话侧栏+消息流  │ │                  │ │                   │                       │
│  │  +输入区+面板区  │ │                  │ │                   │                       │
│  └───────┬─────────┘ └────────┬─────────┘ └───────┬───────────┘                       │
│          │   每个 remote 只依赖 contract 包，不 import 宿主 store                    │
│          ▼                    ▼                   ▼                                   │
│  ┌────────────────────── CapClient（唯一后端通道）──────────────────────┐              │
│  │  cap.dispatch(cap, action, payload) / dispatchStream / listen        │              │
│  └──────────────────────────────┬───────────────────────────────────────┘              │
└─────────────────────────────────┼───────────────────────────────────────────────────────┘
                                  │ invoke('router_dispatch') / HTTP /api/ipc / SSE chat-event
┌─────────────────────────────────▼───────────────────────────────────────────────────────┐
│  Rust 核心（精简自 Polaris src-tauri）                                                    │
│  RouterBus（cap.ai.chat / cap.fs / cap.bash / cap.http / cap.kv / cap.config /           │
│             cap.history / cap.session / cap.pluginDiscovery / cap.ui.* …）               │
│  ├─ 权限 gate + 审计链（policy_permission / audit_sink）                                  │
│  ├─ plugin_service（manifest 发现/校验/启停）+ supervisor（插件服务进程）                  │
│  ├─ ai_chat_core + EngineRegistry（AI 引擎调度接口，cap.ai.chat 提供方）                  │
│  ├─ storage（会话/消息持久化，JSONL/SQLite）                                              │
│  └─ web 静态服务：/ → shell dist；/remotes/<id>/ → 各 remote dist（同源，免 CORS）        │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

**host/remote 关系要点**：

1. host 不知道任何 remote 的业务内容，只知道 `remoteRegistry` 里的 `{id, entryUrl, area, slot}` 清单（来自插件 manifest 的 `federation` 字段）。
2. remote 之间**不互相 import**；跨面板通信（如「把结果发回对话」）走 `cap.ui.chat` / EventBus，与 Polaris 现有 `onSendToChat` 语义对齐。
3. remote 不再从 `window.__POLARIS_APP_CORE__` 取 21 个 store——`mount(ctx)` 注入的 `ctx.cap / ctx.events / ctx.theme / ctx.i18n` 是唯一宿主依赖面。

---

## 3. 核心目录树

```
D:\space\base\Polaris-lite\
├─ package.json                     # pnpm workspace 根
├─ pnpm-workspace.yaml              # packages: apps/*, packages/*
├─ tsconfig.base.json               # 共享编译配置（strict）
├─ docs/
├─ packages/
│  ├─ federation-contract/          # ★ host 与全部 remote 的唯一类型/运行时契约
│  │  ├─ src/
│  │  │  ├─ index.ts                # 导出全部类型
│  │  │  ├─ remote-module.ts        # RemoteModule / RemoteManifest / RemoteLifecycle
│  │  │  ├─ mount-context.ts        # RemoteMountContext / PanelProps
│  │  │  ├─ cap-client.ts           # CapClient / StreamEvent / UnlistenFn
│  │  │  ├─ event-bus.ts            # 轻量发布订阅（typed）
│  │  │  └─ errors.ts               # RemoteLoadError / LifecycleError
│  │  └─ package.json               # 独立版本号，semver 发布
│  └─ ui-kit/                       # 主题 token + 少量公共组件（Button/Modal/Toast 视图）
│     └─ src/styles/tokens.css      # CSS 变量主题（对齐 Polaris 主题体系，禁硬编码色值）
├─ apps/
│  ├─ shell/                        # ★ HOST：布局壳 + 联邦运行时（核心，零业务）
│  │  ├─ vite.config.ts             # federation host 配置（见 §4.1）
│  │  ├─ index.html
│  │  └─ src/
│  │     ├─ main.tsx                # 启动链（见 §8）
│  │     ├─ App.tsx                 # 布局装配（TopMenuBar + 四面板 + 槽位）
│  │     ├─ federation/             # 联邦运行时（核心新增，~600 行）
│  │     │  ├─ remoteRegistry.ts    # 远端清单注册/查询（area/slot 索引）
│  │     │  ├─ remoteLoader.ts      # import(remoteEntry) → RemoteModule
│  │     │  ├─ lifecycleRunner.ts   # bootstrap/mount/update/unmount 状态机
│  │     │  ├─ RemoteSlot.tsx       # React 挂载组件（含 ErrorBoundary/Suspense）
│  │     │  └─ shared-deps.ts       # shared 单例登记（react/zustand/i18n）
│  │     ├─ bus/
│  │     │  ├─ capClient.ts         # CapClient 实现（transport 适配）
│  │     │  └─ eventBus.ts          # chat-event 等宿主事件桥接
│  │     ├─ services/transport/     # 复制自 Polaris（tauri.ts / http.ts / detector.ts / index.ts）
│  │     ├─ layout/                 # 复制自 Polaris 并瘦身
│  │     │  ├─ Layout.tsx  TopMenuBar.tsx  ActivityBar.tsx
│  │     │  ├─ LeftPanel.tsx  LeftPanelTabStrip.tsx
│  │     │  ├─ CenterStage.tsx  RightPanel.tsx
│  │     │  └─ MainSurfaceSlot.tsx  # chat.main 槽位 → RemoteSlot(area=mainSurface)
│  │     ├─ plugin-system/          # 薄层：manifest zod 校验 + 席位排序（~500 行）
│  │     │  ├─ schema.ts            # 复制 Polaris schema.ts，新增 federation 字段
│  │     │  └─ discovery.ts         # cap.pluginDiscovery.list → registry
│  │     ├─ stores/                 # ≤8 个：config/theme/view/overlay/toast/plugin/workspace/sessionMeta
│  │     ├─ theme/  ├─ i18n/
│  │     └─ types/
│  └─ remotes/
│     ├─ chat-desk/                 # ★ AI 对话 remote（mainSurface）
│     │  ├─ vite.config.ts          # federation remote 配置（见 §4.2）
│     │  └─ src/
│     │     ├─ panel.tsx            # default export：对话面板根组件
│     │     ├─ manifest.ts          # RemoteManifest 声明
│     │     ├─ lifecycle.ts         # mount/update/unmount 实现
│     │     └─ features/            # 复制自 Polaris-plugin/plugins/chat-desk/src
│     │        ├─ session/          #   会话侧栏 / MultiSessionGrid
│     │        ├─ messages/         #   消息流渲染
│     │        ├─ input/            #   ChatInput / 附件 / 命令路由
│     │        └─ panels/           #   面板区（工具调用/卡片）
│     ├─ files-desk/  ├─ polaris-git/  ├─ terminal-desk/
│     ├─ settings-desk/ ├─ history-desk/ ├─ translate/
│     └─ dev-desk/                  # 每个 remote 结构同 chat-desk（panel/manifest/lifecycle）
├─ src-tauri/                       # 精简 Rust 核心（见 §10 裁剪表）
│  └─ src/
│     ├─ lib.rs  state.rs  error.rs  logger.rs  config_store.rs  data_root.rs
│     ├─ commands/router.rs         # router_dispatch / router_dispatch_stream / audit_*
│     ├─ services/
│     │  ├─ router/                 # RouterBus + 保留的 capability（见 §10）
│     │  ├─ plugin_service.rs  plugin_capability_assembly.rs  supervisor/
│     │  ├─ ai_chat_core/  ai/      # AI 引擎调度接口 + 精简引擎
│     │  ├─ storage/                # 会话/消息持久化（最小实现）
│     │  └─ web/                    # axum 静态服务 + /api/ipc + event_broadcaster
│     └─ models/
└─ scripts/
   ├─ dev-all.mjs                   # 并行拉起 shell + 各 remote dev server
   └─ check-shared-deps.mjs         # CI：禁止 remote 产物内嵌 react/zustand 等共享包
```

---

## 4. 核心契约

### 4.1 Federation 配置（host）

`apps/shell/vite.config.ts`：

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import federation from '@originjs/vite-plugin-federation'

// dev：各 remote 独立 dev server；prod：同源静态目录 /remotes/<id>/
const remoteEntry = (id: string, devPort: number) =>
  process.env.NODE_ENV === 'development'
    ? `http://localhost:${devPort}/assets/remoteEntry.js`
    : `/remotes/${id}/assets/remoteEntry.js`

export default defineConfig({
  plugins: [
    react(),
    federation({
      name: 'polaris-shell',
      remotes: {
        'chat-desk':     remoteEntry('chat-desk', 5171),
        'files-desk':    remoteEntry('files-desk', 5172),
        'polaris-git':   remoteEntry('polaris-git', 5173),
        'terminal-desk': remoteEntry('terminal-desk', 5174),
        'settings-desk': remoteEntry('settings-desk', 5175),
        'history-desk':  remoteEntry('history-desk', 5176),
        'translate':     remoteEntry('translate', 5177),
        'dev-desk':      remoteEntry('dev-desk', 5178),
      },
      // 共享依赖：host 永远提供实例，remote 一律 external
      shared: {
        react:         { singleton: true, requiredVersion: '~18.3.0' },
        'react-dom':   { singleton: true, requiredVersion: '~18.3.0' },
        zustand:       { singleton: true, requiredVersion: '~5.0.0' },
        i18next:       { singleton: true, requiredVersion: '~23.0.0' },
        'react-i18next': { singleton: true, requiredVersion: '~15.0.0' },
      },
    }),
  ],
  build: { target: 'esnext' },
})
```

> 注意：`@originjs/vite-plugin-federation` 的 dev 模式要求 remote 也在 dev server 上以 ESM 暴露（插件自动处理）；prod 构建 `remoteEntry.js` 落在各 remote 的 `dist/assets/`，由 Rust web 服务按 `/remotes/<id>/` 前缀静态托管，**同源免 CORS**。

### 4.2 Federation 配置（remote，以 chat-desk 为例）

`apps/remotes/chat-desk/vite.config.ts`：

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import federation from '@originjs/vite-plugin-federation'

export default defineConfig({
  plugins: [
    react(),
    federation({
      name: 'chat-desk',
      filename: 'remoteEntry.js',
      exposes: {
        './Panel': './src/panel.tsx',       // 面板组件（含四段式对话布局）
        './lifecycle': './src/lifecycle.ts', // 生命周期协议实现
        './manifest': './src/manifest.ts',   // 席位/槽位/能力声明
      },
      // 与 host 完全一致的共享声明；remote 构建产物不内嵌这些包
      shared: {
        react:         { singleton: true, requiredVersion: '~18.3.0' },
        'react-dom':   { singleton: true, requiredVersion: '~18.3.0' },
        zustand:       { singleton: true, requiredVersion: '~5.0.0' },
        i18next:       { singleton: true, requiredVersion: '~23.0.0' },
        'react-i18next': { singleton: true, requiredVersion: '~15.0.0' },
      },
    }),
  ],
  server: { port: 5171, strictPort: true },
  build: { target: 'esnext' },
})
```

### 4.3 模块暴露接口（`packages/federation-contract/src/remote-module.ts`）

```ts
/** 每个 remote 的 remoteEntry 必须同时暴露 './manifest' 与 './lifecycle'；'./Panel' 为可选 UI 导出 */
export interface RemoteModule {
  manifest: RemoteManifest
  lifecycle: RemoteLifecycle
  Panel?: RemotePanelComponent
}

/** 席位/槽位声明 —— 对齐 Polaris plugin.json contributes.views 字段语义 */
export interface RemoteManifest {
  id: string                       // 'chat-desk'
  name: string
  version: string
  area: 'mainSurface' | 'activityBar' | 'settings' | 'notificationOverlay'
  panelType: string                // 'chat.main' / 'files.panel' / ...
  slot?: string                    // 'chat.main'（shadow 接管主区）
  slotMode?: 'append' | 'shadow' | 'chain'
  icon?: string
  order?: number
  requiredCaps?: string[]          // 声明所需 cap，host 侧做展示级校验（真正裁决在 Rust gate）
  contractVersion: string          // federation-contract 包版本，host 做兼容检查
}

/** 面板组件 props —— 与 Polaris PluginPanelComponent 对齐，保证 chat-desk 源码迁移成本最低 */
export interface PanelProps {
  pluginId: string
  onSendToChat?: (message: string) => void | Promise<void>
  onClose?: () => void
}
export type RemotePanelComponent = React.ComponentType<PanelProps>
```

### 4.4 生命周期协议签名（`remote-module.ts` + `mount-context.ts`）

```ts
export type RemoteUnmount = () => Promise<void> | void

export interface RemoteMountContext {
  /** host 分配的挂载容器（RemoteSlot 内部 div，随槽位卸载而移除） */
  container: HTMLElement
  props: PanelProps
  /** 唯一后端通道：cap 总线客户端（见 §4.5） */
  cap: CapClient
  /** 宿主级事件总线（chat-event / plugin-events / 主题变更） */
  events: EventBus
  theme: ThemeApi        // { getTokens(): ThemeTokens; onChange(cb): UnlistenFn }
  i18n: I18nApi          // { t(key, vars?): string; onChange(cb): UnlistenFn }
  signal: AbortSignal    // 槽位被宿主卸载时 abort，remote 应尽快停止异步工作
}

export interface RemoteLifecycle {
  /** remoteEntry 首次加载后调用一次（模块级初始化，可省略） */
  bootstrap?(ctx: RemoteMountContext): Promise<void>
  /** 挂载：把 UI 渲染进 ctx.container；返回清理函数（或依赖 unmount） */
  mount(ctx: RemoteMountContext): Promise<RemoteUnmount | void>
  /** 更新 props（面板复用同一实例时；未实现则 host 卸载重挂） */
  update?(props: PanelProps): Promise<void>
  /** 卸载：清理 DOM/订阅/定时器；host 保证与 mount 一一配对 */
  unmount?(): Promise<void>
}
```

`lifecycleRunner.ts`（host 侧状态机，约 120 行）负责：`idle → loading → bootstrapped → mounted → unmounting → idle`；`AbortSignal` 触发即调用 unmount；同一 remoteEntry 的 `bootstrap` 全局只执行一次（对齐 Polaris moduleCache 防双实例的诉求，但由 ES module 语义天然保证）。

### 4.5 CapClient 契约（`cap-client.ts`，cap 总线思想保留）

```ts
export interface StreamEvent { event: string; payload: unknown; sessionId?: string }

export interface CapClient {
  /** 统一权限/审计/转发通道：等价 Polaris invoke('router_dispatch', {target, payload}) */
  dispatch<T = unknown>(cap: string, action: string, payload?: Record<string, unknown>): Promise<T>
  /** 流式 cap（如 cap.ai.chat start/continue）：返回取消函数（对应 interrupt） */
  dispatchStream(
    cap: string, action: string,
    payload: Record<string, unknown> | undefined,
    onEvent: (e: StreamEvent) => void,
  ): Promise<() => void>
  /** 宿主事件订阅（chat-event 等），remote 内部不得直接 listen 通道 */
  listen(event: string, handler: (payload: unknown) => void): () => void
  /** 白名单遗留命令（对齐 Polaris __POLARIS_HOST_INVOKE__ 30 命令清单，逐步清零） */
  invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T>
}
```

实现：shell 的 `bus/capClient.ts` 基于 `services/transport`（Tauri invoke / HTTP `/api/ipc` 自动探测），`dispatch` 固定走 `router_dispatch`，`dispatchStream` 走 `router_dispatch_stream` + `chat-event` 订阅——与 Polaris chatService.ts:25-33 的主链路完全同构，Rust 侧零改动。

---

## 5. AI 对话插件挂载

### 5.1 chat-desk 的声明与实现

```ts
// apps/remotes/chat-desk/src/manifest.ts
import type { RemoteManifest } from '@polaris-lite/federation-contract'
export const manifest: RemoteManifest = {
  id: 'chat-desk',
  name: 'AI 对话',
  version: '1.0.0',
  area: 'mainSurface',
  panelType: 'chat.main',
  slot: 'chat.main',
  slotMode: 'shadow',          // 与 Polaris chat-desk plugin.json 完全一致的接管语义
  icon: 'Bot',
  order: 0,
  requiredCaps: ['cap.ai.chat', 'cap.history', 'cap.session', 'cap.kv'],
  contractVersion: '1.0.0',
}
```

```ts
// apps/remotes/chat-desk/src/lifecycle.ts
import { createRoot, type Root } from 'react-dom/client'
import { ChatPanel } from './panel'           // 四段式对话布局根组件
import type { RemoteMountContext, RemoteUnmount } from '@polaris-lite/federation-contract'

let root: Root | null = null
let disposers: Array<() => void> = []

export async function mount(ctx: RemoteMountContext): Promise<RemoteUnmount> {
  root = createRoot(ctx.container)
  await new Promise<void>((resolve) => {
    root!.render(<ChatPanel cap={ctx.cap} events={ctx.events} theme={ctx.theme}
                            i18n={ctx.i18n} props={ctx.props} onReady={resolve} />)
  })
  return async () => { /* 局部清理：流式订阅等 */ disposers.forEach((d) => d()) }
}

export async function unmount(): Promise<void> {
  disposers.forEach((d) => d()); disposers = []
  root?.unmount(); root = null
}
```

### 5.2 host 侧槽位渲染（`layout/MainSurfaceSlot.tsx`）

```tsx
export function MainSurfaceSlot() {
  const claim = useRemoteRegistry((s) => s.getMainSurfaceClaim())  // 等价 Polaris getMainSurfaceClaim()
  if (!claim) return <ChatEmptyGuide />                            // 空态引导卡（对齐 ChatMainSlot）
  return (
    <RemoteSlot
      remoteId={claim.remoteId}
      exportName="./Panel"
      props={{ pluginId: claim.remoteId, onSendToChat: sendToChat, onClose: closePanel }}
    />
  )
}
```

### 5.3 布局不变性的保证

- **四段式骨架不动**：RightPanel（对话主区）→ chat-desk remote 的 `ChatPanel` 内部保持「会话侧栏 + 消息流 + 底部输入区 + 面板区」结构，源码直接复制自 `Polaris-plugin/plugins/chat-desk/src/`（Session/ messages/ input/），交互方式零重设计（约束 1、P2）。
- **契约保证一致性**：`RemoteSlot` 提供的容器即 Polaris `PluginPanelHost` 的等价物（含 PanelErrorBoundary、LoadingFallback、重试），注入 `onSendToChat/onClose` 与 Polaris `PluginPanelComponent` props 同名同义，保证插件 UI 与原布局无缝贴合。
- **事件链路不变**：输入 → `cap.dispatchStream('cap.ai.chat','start',…)` → Rust RouterBus → 引擎 → `chat-event` → `ctx.events` → chat-desk sessionStore 消费，与 baseline §3 的链路逐环对应。

---

## 6. 插件清单（首批 remote）

| remote id | area / slot | 内容 | 来源 | 必需 cap |
|---|---|---|---|---|
| `chat-desk` | mainSurface / chat.main（shadow） | AI 对话四段式 UI | Polaris-plugin chat-desk 复制改造 | cap.ai.chat, cap.history, cap.session |
| `files-desk` | activityBar / files.panel | 文件浏览器 + 编辑器入口 | Polaris-plugin files-desk | cap.fs, cap.bash |
| `polaris-git` | activityBar / git.panel | Git 状态/分支/diff | Polaris-plugin polaris-git | cap.bash, cap.fs |
| `terminal-desk` | activityBar / terminal.panel | 终端面板（PTY） | Polaris-plugin terminal-desk | cap.terminal |
| `settings-desk` | settings 覆盖层 | 设置页 | Polaris-plugin settings-desk | cap.config, cap.kv |
| `history-desk` | overlay / session-history | 会话历史抽屉 | Polaris-plugin history-desk | cap.history, cap.session |
| `translate` | activityBar / translate.panel | 翻译面板 | Polaris-plugin translate | cap.http |
| `dev-desk` | activityBar / developer.panel | 开发者工具面板 | Polaris-plugin dev-desk | cap.self.inspect, cap.meta |

> 插件元数据仍用 Polaris `plugin.json` 格式（Rust plugin_service 校验不变），仅新增可选字段 `federation: { name, entry, exposes }`；无该字段的旧式插件退化为 Blob-URL loader 兜底加载（兼容路径保留一个迭代周期后删除）。

---

## 7. 启动流程

```
[Rust 核心] 启动：data_root → config_store → RouterBus 注册 34→约 20 个 capability
            → plugin_service 发现（plugin.json + federation 字段）→ web 服务监听
                /            → shell dist（index.html + assets）
                /remotes/*   → 各 remote dist（remoteEntry.js + chunks）
                /api/ipc     → router_dispatch HTTP 桥（Web 模式）
                /api/events  → SSE chat-event（Web 模式）；Tauri 模式走 invoke + listen

[shell main.tsx] 严格顺序：
 1. transport 探测（tauri / http）
 2. capClient 实例化（dispatch → router_dispatch；listen → chat-event 过滤器）
 3. bootstrapTheme()（同步注入 CSS 变量防 FOUC，复制 Polaris）
 4. configStore.loadConfig() + themeStore.syncFromRemote()
 5. discovery：cap.dispatch('cap.pluginDiscovery','list') → pluginRegistry.replaceInstalled
 6. remoteRegistry.registerAll(带 federation 字段的插件)
 7. ReactDOM.createRoot(#root).render(<App/>)
       App 内：Layout 渲染四段式骨架 → 各槽位 <RemoteSlot> 按需触发：
         a. remoteLoader.load(id)   // import(remoteEntryUrl)，浏览器 HTTP 缓存
         b. lifecycle.bootstrap?.(ctx)   // 全局一次
         c. lifecycle.mount(ctx)         // 槽位挂载，ctx.signal 绑定卸载
         d. props 变化 → lifecycle.update?.(props)；槽位卸载 → unmount()
 8. useAppEvents 订阅 plugin-events / 主题广播；PWA SW 注册（PROD）

[独立开发某 remote]：pnpm --filter chat-desk dev → 5171 端口独立调试
            （可配 mock capClient：内存版 RouterBus，见 packages/federation-contract/dev-tools）
```

与 Polaris main.tsx 的差异：**删除 `installAppCoreBridge()` 全局桥**（21 store + 30 service 不再暴露）、删除 Blob-URL loader 的 shim 生成、删除 `ensureDevDiscoveryReady()` 的磁盘探测（dev 发现走 pnpm workspace 端口约定）；新增 remoteRegistry/lifecycleRunner 两个模块（约 600 行）。

---

## 8. 与 Polaris 的复用 / 差异清单

### 8.1 直接复制（fork 进本仓，改动最小）

| 来源（Polaris） | 去向（polaris-lite） | 说明 |
|---|---|---|
| `src/services/transport/*` | `apps/shell/src/services/transport/` | tauri/http/detector 原样复制 |
| `src/services/themeEngine.ts`、`themeService.ts`、`themeMerger.ts` | `apps/shell/src/theme/` | 主题引擎不动 |
| `src/i18n/` + `src/locales/`（仅通用键） | `apps/shell/src/i18n/` | 业务文案键随插件走 |
| `src/components/Common/`（Layout/Modal/Toast/ErrorBoundary/RightSlideOver/PermissionPromptHost/Icons） | `apps/shell/src/layout/` + `packages/ui-kit` | 壳组件 |
| `src/components/Layout/{ActivityBar,LeftPanel,RightPanel,CenterStage,TopMenuBar}` | `apps/shell/src/layout/` | 槽位内部渲染改为 RemoteSlot |
| `src/plugin-system/schema.ts`（zod 契约） | `apps/shell/src/plugin-system/schema.ts` | 增补 `federation` 字段 |
| `src/stores/{configStore,themeStore,viewStore,overlayStore,toastStore,pluginStore,workspaceStore}` | `apps/shell/src/stores/` | 删除其中业务域引用 |
| `src-tauri/src/services/router/mod.rs` + `commands/router.rs` + `policy_permission.rs` + `audit_sink.rs` | `src-tauri/` 同路径 | cap 总线原样继承 |
| `src-tauri/src/services/plugin_service.rs`、`plugin_capability_assembly.rs`、`supervisor/` | 同路径 | 插件生命周期/服务进程管理 |
| `src-tauri/src/services/ai_chat_core/`、`ai/`（精简后）、`models/ai_event.rs` | 同路径 | AI 引擎调度接口（P4 允许保留在核心） |
| `src-tauri/src/{config_store,data_root,logger,error,state}.rs`、`web/` | 同路径 | 基础设施 |
| `Polaris-plugin/plugins/chat-desk/src/**` | `apps/remotes/chat-desk/src/` | 对话 UI 主体，改桥接层 |

### 8.2 重写

| 对象 | 重写内容 |
|---|---|
| `pluginModuleLoader.ts`（Blob-URL） | 整体废弃，替换为 `federation/remoteLoader.ts`（import remoteEntry） |
| `panelRegistry.ts` + `registry.ts` 面板装载部分 | 替换为 `remoteRegistry.ts` + `lifecycleRunner.ts` + `RemoteSlot.tsx` |
| `appCoreBridge.ts` | **删除不重写**：以 `CapClient`/`EventBus` 注入（mount ctx）取代 window 全局桥；store 不再跨边界共享 |
| `main.tsx` 启动链 | 按 §7 重排（去掉桥安装，加 remoteRegistry） |
| chat-desk 的 host 适配层 | `bootstrap.ts`/store 订阅改为从 `ctx.cap/ctx.events` 取数（业务组件不动） |
| `vite.config.ts` | 增加 federation 插件与 remotes 映射；dev 端口约定 5171-5178 |

### 8.3 放弃（不迁移）

- `commands/` 下业务命令与对应 store：`file_explorer.rs`(1227)、`terminal.rs`、`file_watcher.rs`、`file_clipboard.rs`、`agent_corpus.rs`、`nexus.rs`、`claude_settings.rs`、`dialog_storage.rs` 等
- `services/{proxy,computer_control,ask_listener,nexus_pipeline,form,mcp_tool_gates,context_core}/`
- `ai/engine/simple_ai/tools/{computer,skill,agent,…}` 中非对话必需的工具面（工具改由 remote 经 cap.bash/cap.fs 提供）
- `src/stores/{fileExplorerStore,fileEditorStore,tabStore,editorSettingsStore,editorContextStore,schedulerStoreUtils}`、`src/utils/{toolConfig,toolSummary,toolInputExtractor,mermaid-config,messageCompactor}`
- `src/components/{Preview,UiFrame}`、`JsonTreeView`、`editorExtensionRegistry`/`editorScmProvider`（SCM 编辑器集成）
- Blob-URL loader、`window.__POLARIS_HOST_REACT__` 等 8 个全局 shim、`builtinPlugins.ts` 残留声明

---

## 9. 裁剪量化表

| 指标 | Polaris 现状 | polaris-lite（S5） | 削减 |
|---|---|---|---|
| 前端核心（shell）TS/TSX | 49,794 行 / 279 文件（含全部业务） | **≈ 9,500 行 / ≈ 90 文件**（layout 2.5k + federation 0.6k + bus/transport 1.5k + stores 2k + theme/i18n 1.5k + plugin-system 0.5k + App/main 0.4k + ui-kit 1k） | **-81%** |
| 前端 Zustand store | 27 个非测试 store 模块 | 8 个（config/theme/view/overlay/toast/plugin/workspace/sessionMeta） | -70% |
| 对话 UI 归属 | chat-desk 插件 23,763 行（Blob 加载） | chat-desk **remote** 独立包（不在核心统计内，规模不变） | 核心含业务量 → 0 |
| Rust 核心 | 101,032 行 / 250 文件 | **≈ 32,000 行 / ≈ 95 文件**（router+审计+权限 3.5k、capabilities 精简 8k、plugin_service+supervisor 5k、ai_chat_core+引擎 6k、storage 4k、web 3.5k、基础设施 1.5k） | **-68%** |
| RouterBus capability | 34 个 / ~30 cap id | **20 个**（保留 ai.chat/history/session/fs/bash/http/kv/config/terminal/ui.*/pluginDiscovery/meta/help/usage；删 app.autolaunch/app.update/self.mutate/dyn.*/echo 类） | -41% |
| Tauri command 注册 | 36 个 | 8 个（router_dispatch/stream、list_caps、audit_tail/verify、respond_permission、plugin_config get/set） | -78% |
| 启动 JS（shell 首屏） | 单 bundle 全量 | 仅布局壳 + 联邦运行时；remote 按槽位懒加载（chat-desk 首槽，其余点击加载） | 首屏体积预计 -50% 以上 |
| 插件加载方式 | 磁盘读文件 + 正则改写 + Blob import | 构建 ESM remoteEntry + 原生 import | 消除改写失败类缺陷 |

---

## 10. 迁移步骤

1. **脚手架（0.5 天）**：建 `Polaris-lite` 仓，pnpm workspace + `packages/federation-contract`（先只有类型）+ `apps/shell`（Vite 模板）。
2. **复制壳（1 天）**：按 §8.1 复制 transport/theme/i18n/Common/layout/stores；跑通「空布局 + 假 RemoteSlot（渲染占位 div）」。
3. **接通 cap 总线（1 天）**：复制 Rust router/audit/policy/web；shell `capClient` 走 `router_dispatch`；验证 `cap.config` 读写与 `cap.pluginDiscovery` 列表。
4. **联邦运行时（1.5 天）**：实现 remoteRegistry/remoteLoader/lifecycleRunner/RemoteSlot + shared-deps；用一个 demo remote（`hello`，exposes ./Panel）打通 dev 与 prod 两种 remoteEntry 加载。
5. **chat-desk 迁移（2~3 天，关键路径）**：复制 chat-desk 源码 → 剥离 `window.__POLARIS_APP_CORE__` 依赖 → 改为 ctx 注入 → 保留四段式布局 → 联调 `cap.ai.chat` 流式链路与 interrupt。
6. **其余面板批量迁移（2~3 天）**：files → git → terminal → settings → history → translate → dev-desk，逐个复制改造；每个 remote 独立 vite 配置。
7. **Rust 裁剪（1 天）**：删 §8.3 后端域；capability 清单收敛到 20 个；`cargo check` + web-only 门控检查。
8. **CI 与护栏（0.5 天）**：`scripts/check-shared-deps.mjs`（remote 产物不得内嵌 react/zustand）、contract 包 semver 兼容测试、`pnpm typecheck`、远端清单快照测试。
9. **清理（0.5 天）**：删除 Blob-URL loader 与全局桥残留；文档与 README。

总计约 10~13 人日。每步都有可运行验证点（对应 brief「具体实现」要求）。

---

## 11. 风险与对策

### 11.1 共享依赖版本冲突（本方案最大风险，专项对策）

- **场景**：remote A 用 react 18.3、remote B 用 react 19；或两个 remote 各自打进一份 zustand → `create` 来自两个模块实例 → store 状态割裂、React hooks 报 "Invalid hook call"。
- **对策**：
  1. **单一版本源**：pnpm workspace `catalog:`（或根 package.json resolutions）统一 react/zustand/i18next 版本；所有 remote 的 package.json 引用 catalog，禁止各自锁版本。
  2. **federation singleton**：shared 全部 `singleton: true`；remote 侧 `requiredVersion: false` + 构建期 external，运行时一律消费 host 或先加载者提供的实例。
  3. **CI 硬门禁**：`scripts/check-shared-deps.mjs` 扫描各 remote `dist/assets/*.js`，发现 react-dom/zustand 代码特征即 fail（防依赖声明漂移）。
  4. **实例唯一性冒烟**：CI 里渲染两个 remote，断言 `ReactCurrentOwner`/store 引用一致（对齐 Polaris 曾发生的双实例教训）。
  5. **非共享库允许重复**（如各 remote 自带的图表库），但须在 contract 文档登记；版本冲突导致的样式污染用 CSS 变量 + `ui-kit` 统一 token 解决。

### 11.2 其他风险

| 风险 | 等级 | 对策 |
|---|---|---|
| `@originjs/vite-plugin-federation` dev 模式 HMR 受限（remote 更新常需整页刷新） | 中 | 接受 dev 阶段约束（remote 独立 dev server 已可单调试）；若不可接受，remote 侧换 webpack 5 MF（构建产物同协议，host 无感） |
| Tauri/WebView 下跨端口加载 remoteEntry 的 CORS/协议问题 | 中 | prod 统一同源（Rust 静态服务 `/remotes/*`）；dev 走 localhost 多端口并给 dev server 加 CORS 头；Tauri `assetProtocol` 仅作兜底 |
| remote 与 host 的 contract 版本漂移（字段改名导致运行时崩） | 中 | `RemoteManifest.contractVersion` 握手：host 拒绝加载不兼容 minor 以上差异；contract 包发 semver + 变更日志；CI 跑 contract 兼容测试 |
| 远端加载失败/超时导致槽位空白 | 中 | RemoteSlot 内置超时（3s）+ ErrorBoundary + 重试按钮（复用 Polaris PluginPanelHost 的降级 UI 语义）；remoteEntry 预加载清单（首槽之外可配置 prefetch） |
| chat-desk 迁移时对旧全局桥依赖深（21 store） | 高 | 分两步：先在 remote 内建 `compat-bridge` 把 ctx 适配成旧 store 接口（业务组件零改动），再逐文件改为直连 ctx.cap；以「AI 回复不重复、流式不断流」为验收 |
| Rust 裁剪误删被引用模块（feature 门控陷阱） | 中 | 保留 Polaris 的 `cargo check --no-default-features --bin polaris-web` 门控；删除按域成组进行，每删一组跑一次 check |
| 多 dev server 编排复杂（8 个端口） | 低 | `scripts/dev-all.mjs` 用 pnpm `--filter --parallel` + 端口表；提供 `--only chat-desk` 模式只拉 shell + 单 remote |
| 微前端运行时调试体验差（错误堆栈跨 bundle） | 低 | remote 构建保留 sourcemap（dev 必开）；ErrorBoundary 上报带 remoteId；lifecycleRunner 记录 mount/unmount 生命周期日志 |

---

## 12. 与其他方案的边界自查（矩阵第 5 格符合性）

- 核心形态 = **布局壳 + module federation 运行时**（§3/§4）：是。
- 每个面板/对话是**远程微前端模块**（§5/§6，独立构建独立端口）：是。
- 插件机制 = **模块联邦 + 生命周期协议 mount/unmount**（§4.4）：是。
- 前端栈 = **React + 模块化（联邦）加载**：是。
- 与 Polaris 的差异锚点 = 用构建期联邦替换 Blob-URL 运行时字符串改写（§1.2）：是。

硬性约束自查：布局四段式不变（§5.3）；核心零业务（§8.3/§9，业务全部在 remote 或 Rust capability，前端核心无任何面板实现）；AI 对话 UI 与业务面板均为插件（§5/§6）；cap 总线保留且为 remote 唯一后端通道（§4.5）；可独立构建（pnpm workspace + 自带精简 Rust，不修改 Polaris 主仓任何文件）。
