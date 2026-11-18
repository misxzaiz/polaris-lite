# S9 Vite 模板：脚手架 + npm 插件包

> 矩阵坐标（第 9 格）：核心 = **一个可复制的脚手架模板仓库（create-polaris-lite）**；业务全部是模板之外的 **npm 插件包**；对话模板插件即装即用；插件机制 = **npm 包 + 脚手架生成（plop/templating）**，安装即 Vite alias / 依赖注入；前端栈 = **React + Vite 模板**。
> 一句话差异：**插件以 npm 包形式分发，走构建期集成（进 Vite 依赖图、静态 import、类型检查、分包树摇），而不是 Polaris 现状的运行时 Blob URL 动态加载。**

---

## 1. 定位与差异化主张

Polaris 现状的插件是"磁盘上的目录 + `plugin.json` + 运行时读 JS 文件改写 import 后以 Blob URL `import()`"（`pluginModuleLoader.ts`，155 行）。这条链路的代价是：插件代码不进构建图、无 TS 类型检查、无 tree-shaking、宿主要维护一套 manifest 校验 + Blob 加载 + 沙箱边界的运行时（`plugin_service.rs` 2,904 行 + 前端 plugin-system）。

S9 把这套运行时机制**整体替换为前端生态最成熟的分发方式：npm 包**。

- **核心（模板仓库）**：只含宿主壳 + cap 总线包 + 插件契约包 + Vite 集成插件 + 脚手架 CLI，零业务。
- **业务（插件包）**：AI 对话、文件面板、设置页、AI 引擎等，全部是独立发版的 npm 包（`@polaris-lite/*`）。`pnpm add` 即安装，Vite 构建期自动发现并集成。
- **脚手架**：`npx create-polaris-lite my-app` 生成可用应用；`pnpm gen:plugin`（plop）生成新插件包骨架。插件开发本身也被模板化。
- **与相邻方案的边界**：S4 的身份是"砍 Tauri、单进程 Web + HTTP/SSE 总线 + 进程内插件注册表"；S9 的身份是**分发与集成机制**（npm 包 + 构建期 Vite 集成 + 脚手架）。S9 默认同样不带 Rust（本地服务为 Node sidecar），但这是轻量手段而非方案身份；总线包抽象了传输层，保留 Tauri IPC 适配位。

## 2. 总体架构（文字图）

### 2.1 模板 / 插件包 / 宿主关系

```
第 0 层  npm registry / 私服 / git 依赖
         @polaris-lite/chat-desk   @polaris-lite/ai-engine   @polaris-lite/files-desk  ...
         （业务插件包：ui-plugin 跑在浏览器，service-plugin 跑在 Node；全部在模板之外独立发版）
                    ▲ pnpm add —— 安装即注册（package.json#polaris 字段被发现）
                    │
第 1 层  用户应用 my-app（由 create-polaris-lite 脚手架生成）
         ┌──────────────────────────────────────────────────────────────────┐
         │  构建期（Vite）                                                    │
         │  vite-plugin-polaris 扫描 node_modules 中含 polaris 字段的包        │
         │   → 生成 virtual:polaris-plugins（manifest 合并 + 静态 import map）│
         │   → 注入 resolve.alias / dedupe / optimizeDeps（依赖注入）          │
         │                                                                  │
         │  运行期（浏览器）                                                  │
         │  宿主壳（Layout/ActivityBar/LeftPanel/RightPanel，零业务）          │
         │   → registry 取 mainSurface claim → PluginPanelHost               │
         │   → import('@polaris-lite/chat-desk')（构建期已知的静态 import）    │
         │   → plugin.activate(ctx) → views/overlays 注册 → 渲染四段式对话    │
         │                                                                  │
         │  运行期（本地 Node sidecar）                                       │
         │  bus-server：cap 权限 gate + 审计 + 内置 caps（kv/fs/config/       │
         │  history/session/http）+ 加载 service-plugin（如 ai-engine）       │
         │   ▲ HTTP POST /api/cap/dispatch · SSE /api/cap/stream ▲           │
         └───┴──────────────────────────────────────────────────────────┴───┘
             └──────────── @polaris-lite/bus（总线客户端，模板内置）──────────┘
                    ▲
第 2 层  模板仓库 polaris-lite（本仓库 = 核心，全部零业务）
         create-polaris-lite CLI · template-host · bus · bus-server ·
         plugin-kit（契约 + FourPaneShell + plop 生成器） · vite-plugin-polaris
```

### 2.2 一次"安装即集成"的构建期时序

```
pnpm add @polaris-lite/chat-desk
   │
   ├─▶ pnpm install → node_modules/@polaris-lite/chat-desk/package.json（顶层 polaris 字段）
   ├─▶ vite.config.ts 中 polaris() 插件在 config 钩子扫描到该包
   │      ├─ 读取 polaris.contributes / permissions / entry → 合并进总 manifest
   │      ├─ 生成 virtual:polaris-plugins：
   │      │     export const manifests = [ ... ];                       // 静态清单
   │      │     export const loaders  = { 'polaris.chat-desk': () => import('@polaris-lite/chat-desk') };
   │      └─ 注入 alias / dedupe / optimizeDeps
   └─▶ pnpm dev → 插件就是普通源码依赖，HMR 直接生效；pnpm build → 按插件分包（rollup manualChunks）
```

关键点：`import('@polaris-lite/chat-desk')` 是**构建期可静态分析的真实模块引用**——TS 能查类型、ESLint 能查规则、Rollup 能分包与 tree-shake，这是与 Blob 运行时加载的本质区别。

## 3. 核心目录树

### 3.1 模板仓库（polaris-lite monorepo，即"核心"）

```
polaris-lite/
├─ pnpm-workspace.yaml            # packages/* 与 plugins/* 两个 glob
├─ packages/
│  ├─ create-polaris-lite/        # 脚手架 CLI：npx create-polaris-lite my-app
│  │  ├─ src/index.ts             #   问卷 → 复制 template/ → 写 package.json/polaris.config.ts → install
│  │  └─ template/                #   宿主应用模板（生成 my-app 的蓝本，见 3.2）
│  ├─ bus/                        # @polaris-lite/bus —— cap 总线客户端 + 协议类型（浏览器侧）
│  │  ├─ src/bus.ts               #   CapBus 接口 + 实现（dispatch/dispatchStream/onEvent）
│  │  ├─ src/transport-http.ts    #   HTTP+SSE 传输（默认）
│  │  ├─ src/transport-tauri.ts   #   Tauri IPC 传输（可选桌面 profile）
│  │  └─ src/types.ts             #   BusEvent / CapDescriptor / DispatchOptions
│  ├─ bus-server/                 # @polaris-lite/bus-server —— Node 端总线 + 内置 caps
│  │  ├─ src/server.ts            #   createBusServer：中间件链 policy→audit→handler
│  │  ├─ src/caps/                #   内置 capability：config/kv/fs/http/history/session/ui
│  │  ├─ src/audit.ts             #   审计落盘（SQLite audit 表）
│  │  └─ src/service-plugins.ts   #   loadServicePlugins：await import(pkg) → activate
│  ├─ plugin-kit/                 # @polaris-lite/plugin-kit —— 插件契约 + UI 原语 + 生成器
│  │  ├─ src/types.ts             #   PluginManifest / PluginContext / PluginActivation
│  │  ├─ src/define-plugin.ts     #   definePlugin() 帮助函数（仅类型收窄，无运行时魔法）
│  │  ├─ src/ui/FourPaneShell.tsx #   四段式布局原语（会话/消息流/输入/面板，零业务）
│  │  └─ plop-templates/plugin/   #   plop 插件包生成模板（package.json.hbs 等）
│  └─ vite-plugin-polaris/        # Vite 集成插件：扫描 → 生成虚拟模块 → alias/dedupe 注入
│     └─ src/index.ts
├─ plugins/                       # 官方业务插件包（发到 npm；用户也可自建，见 3.3）
│  ├─ chat-desk/  ai-engine/  history-desk/  settings-desk/  files-desk/
├─ docs/
└─ package.json
```

### 3.2 脚手架生成的用户应用（my-app）

```
my-app/
├─ package.json                   # dependencies 含 bus/plugin-kit + 所选插件包；devDeps 含 vite-plugin-polaris
├─ polaris.config.ts              # 应用级配置：transport、server 端口、权限 allowlist、插件开关
├─ vite.config.ts                 # plugins: [react(), polaris()]
├─ index.html
└─ src/
   ├─ main.tsx                    # 启动：bus 单例 → 载入 virtual:polaris-plugins → activate 全部插件 → render
   ├─ App.tsx                     # Layout 壳：TopMenuBar + ActivityBar + LeftPanel + RightPanel + OverlayHost
   ├─ layout/                     # （模板复制自 Polaris 壳）ActivityBar/LeftPanel/RightPanel/TopMenuBar
   ├─ plugin-host/                # PluginPanelHost / OverlayHost / registry（消费 virtual:polaris-plugins）
   ├─ bus/client.ts               # bus 单例（按 polaris.config 选择 transport）
   ├─ theme/  i18n/               # 模板复制：themeEngine + locales 结构
   └─ stores/                     # 仅通用 store：config/ui/overlay/toast（约 6 个，无业务域）
```

### 3.3 插件包内部结构（以 chat-desk 为例）

```
@polaris-lite/chat-desk/
├─ package.json                   # 顶层 polaris 字段（契约载体，见 4.1）
├─ tsconfig.json
├─ vite.config.ts                 # 库模式构建：ESM 单入口，external = peerDeps
└─ src/
   ├─ index.tsx                   # export default activate + export const panels
   ├─ panels/ChatDeskPanel.tsx    # 主面板：组装 FourPaneShell 四段
   ├─ session/                    # 会话侧栏：SessionList / NewSessionPanel / SessionSwitcher
   ├─ messages/                   # 消息流：MessageStream / Bubble / ToolCallCard / AutoScroll
   ├─ input/                      # 输入区：ChatInput / AttachmentBar / CommandChips
   ├─ panel-area/                 # 面板区：ContextPanel / Attachments / CompactNotice
   ├─ overlays/ChatHistory.tsx    # overlay 贡献：session-history 抽屉
   ├─ store/sessionStore.ts       # 插件自有 Zustand（会话状态权威在插件，不在核心）
   └─ ai-events.ts                # AiEvent 消费/归一（协议类型来自 @polaris-lite/bus）
```

## 4. 核心契约

### 4.1 插件包 package.json 约定

契约载体是 package.json **顶层 `polaris` 字段**（先例：Vite 插件的 `vite` 字段、VS Code 扩展的 `contributes`）。字段命名尽量对齐 Polaris `plugin.json`，降低迁移心智成本。

```jsonc
{
  "name": "@polaris-lite/chat-desk",
  "version": "0.1.0",
  "type": "module",
  "exports": { ".": "./dist/index.js" },
  "types": "./dist/index.d.ts",
  "files": ["dist"],
  "scripts": { "build": "vite build" },

  "polaris": {
    "manifestVersion": "1.0",
    "id": "polaris.chat-desk",
    "displayName": "AI 对话",
    "kind": "ui-plugin",                       // ui-plugin | service-plugin
    "entry": "./dist/index.js",                // ESM 入口：default export activate(ctx)
    "contributes": {
      "views": [
        {
          "id": "chat.main",
          "area": "mainSurface",               // activityBar | mainSurface | leftPanel | settings | notificationOverlay
          "panelType": "chat-desk",            // 对应 src/panels 导出的组件键
          "icon": "message-square",
          "labelKey": "chat.title",
          "labelDefault": "AI 对话",
          "order": 0,
          "slot": "chat.main",
          "slotMode": "shadow"                 // shadow | chain | append（沿用 Polaris 语义）
        }
      ],
      "overlays": [
        { "id": "session-history", "slot": "session-history", "panelType": "chat-history", "mode": "drawer" }
      ]
    },
    "permissions": ["cap.ai.chat", "cap.history", "cap.session", "cap.kv", "cap.fs.read"],
    "external": ["react", "react-dom", "zustand", "@polaris-lite/bus", "@polaris-lite/plugin-kit"],
    "vite": {                                  // 构建期注入（可选）
      "alias": {},                             // 追加 resolve.alias
      "optimizeDeps": []                       // 追加 optimizeDeps.include
    }
  },

  "peerDependencies": {
    "react": "^18.0.0",
    "react-dom": "^18.0.0",
    "zustand": "^4.0.0",
    "@polaris-lite/bus": "^0.1.0",
    "@polaris-lite/plugin-kit": "^0.1.0"
  }
}
```

约束：

- `external` 列出的依赖**必须**进 `peerDependencies`，由宿主提供单例（Vite `resolve.dedupe` 强制去重），插件包构建时外部化——这是"依赖注入"的构建期体现。
- `permissions` 是服务端权限 gate 的唯一依据：bus-server 收到 dispatch 时校验 `调用方 pluginId → package.json#polaris.permissions` 是否覆盖目标 cap，未声明即 deny 并审计。
- `contributes.views[].area/slot` 沿用 Polaris 白名单（`mainSurface` 唯一 claim、overlay 槽白名单含 `session-history`），保证与 Polaris 布局语义一致。

### 4.2 插件入口接口签名（ui-plugin）

```ts
// @polaris-lite/plugin-kit
import type { ComponentType } from 'react';

export interface PluginManifest { /* 与 4.1 polaris 字段同构，构建期已合并，运行时二次校验 */ }

export interface PluginContext {
  readonly pluginId: string;
  readonly bus: CapBus;            // cap 总线客户端（唯一后端通道）
  readonly layout: LayoutAPI;      // 槽位/overlay/toast
  readonly storage: KvStorage;     // 服务端按 pluginId 隔离的 KV
  readonly config: PluginConfig;   // get/set（写走 cap.config，带审计）
  readonly logger: Logger;         // debug/info/warn/error，server 端落盘
  readonly i18n: I18nAPI;
  readonly theme: ThemeAPI;
}

export interface LayoutAPI {
  registerActivityItem(item: { id: string; icon: string; title: string; order?: number }): IDisposable;
  openOverlay(slot: string, params?: Record<string, unknown>): void;
  closeOverlay(slot: string): void;
  toast(input: { kind: 'info' | 'warn' | 'error'; message: string }): void;
}

export interface KvStorage {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  keys(prefix?: string): Promise<string[]>;
}

export interface PluginActivation {
  views?: ViewContribution[];      // 与 package.json#polaris.contributes.views 一致（运行时复核）
  overlays?: OverlayContribution[];
  disposables?: IDisposable[];     // deactivate 时统一清理
}

export interface PolarisUiPlugin {
  readonly manifest: PluginManifest;
  activate(ctx: PluginContext): PluginActivation | Promise<PluginActivation>;
  deactivate?(): void;
  /** panelType → React 组件。PluginPanelHost 按贡献里的 panelType 取用 */
  readonly panels?: Record<string, ComponentType<PanelProps>>;
}

export interface PanelProps {
  ctx: PluginContext;
  params?: Record<string, unknown>;
  onSendToChat?: (text: string) => void;   // 兼容 Polaris PluginPanelHost 语义
  onClose?: () => void;
}

export function definePlugin(p: PolarisUiPlugin): PolarisUiPlugin;  // 仅类型收窄
```

插件入口（chat-desk 的 `src/index.tsx`）：

```ts
import { definePlugin } from '@polaris-lite/plugin-kit';
import { ChatDeskPanel } from './panels/ChatDeskPanel';
import { ChatHistoryPanel } from './overlays/ChatHistory';

export default definePlugin({
  manifest: { id: 'polaris.chat-desk', kind: 'ui-plugin' /* 构建期注入完整 manifest */ },
  activate(ctx) {
    ctx.logger.info('chat-desk activated');
    return {
      views: [{ id: 'chat.main', area: 'mainSurface', panelType: 'chat-desk', slot: 'chat.main', slotMode: 'shadow' }],
      overlays: [{ id: 'session-history', slot: 'session-history', panelType: 'chat-history', mode: 'drawer' }],
    };
  },
  panels: { 'chat-desk': ChatDeskPanel, 'chat-history': ChatHistoryPanel },
});
```

### 4.3 service-plugin 契约（服务端能力插件）

AI 引擎等"业务后端"也是 npm 插件包，在 bus-server 进程内注册 capability——核心模板因此可以做到连 AI 编排都不含。

```ts
// @polaris-lite/plugin-kit（server 侧）
export interface ServicePluginContext {
  readonly server: BusServer;               // registerCapability
  readonly logger: Logger;
  readonly config: ConfigStore;             // 读 polaris.config / 用户设置
  readonly db: KvDb;                        // 插件隔离 KV（SQLite）
}

export interface PolarisServicePlugin {
  readonly manifest: PluginManifest;        // kind: 'service-plugin'
  activate(ctx: ServicePluginContext): void | Promise<void>;
  deactivate?(): void;
}
```

```ts
// @polaris-lite/ai-engine/src/index.ts（示例）
import type { Capability } from '@polaris-lite/bus-server';

const aiChat: Capability = {
  id: 'cap.ai.chat',
  summary: '流式 AI 对话（供应商直连）',
  streamActions: ['start', 'continue'],
  actions: {
    start: (payload, ctx) => runChatTurn(payload, ctx),        // AsyncIterable<BusEvent>
    continue: (payload, ctx) => runChatTurn(payload, ctx),
    interrupt: async (payload, ctx) => abortTurn(payload.sessionId),
  },
};

export default {
  manifest: { id: 'polaris.ai-engine', kind: 'service-plugin' },
  activate(ctx) { ctx.server.registerCapability(aiChat); },
};
```

### 4.4 总线包 API（模板内置：@polaris-lite/bus 与 bus-server）

```ts
// ---------- 浏览器侧：@polaris-lite/bus ----------
export interface CapBus {
  dispatch<TRes = unknown>(cap: string, action: string, payload?: unknown, opts?: DispatchOptions): Promise<TRes>;
  dispatchStream(cap: string, action: string, payload?: unknown, opts?: DispatchOptions): AsyncIterable<BusEvent>;
  listCaps(): Promise<CapDescriptor[]>;
  onEvent(filter: { type?: string; pluginId?: string }, handler: (e: BusEvent) => void): IDisposable;
}

export interface DispatchOptions {
  timeoutMs?: number;          // 默认 30_000（流式不适用；绝不以超时掩盖同步问题）
  signal?: AbortSignal;        // 中断传播：ui → bus → server → ai-engine
  idempotencyKey?: string;     // start/continue 防重提交
}

export interface BusEvent {
  type: string;                // 'ai.delta' | 'ai.tool' | 'ai.done' | 'ai.error' | 'ui.toast' | ...
  pluginId?: string;
  payload: unknown;
  ts: number;
}

// ---------- Node 侧：@polaris-lite/bus-server ----------
export interface Capability {
  id: string;                          // 'cap.ai.chat'
  summary?: string;
  actions: Record<string, ActionHandler | StreamActionHandler>;
  streamActions?: string[];
}
export type ActionHandler = (payload: unknown, ctx: CapCallContext) => Promise<unknown>;
export type StreamActionHandler = (payload: unknown, ctx: CapCallContext) => AsyncIterable<BusEvent>;

export interface CapCallContext {
  pluginId: string;                    // 调用方（权限主体）
  cap: string; action: string;
  signal: AbortSignal;
  audit: AuditSink;                    // handler 内可追加结构化审计字段
}

export interface BusServerOptions {
  port?: number;                       // 默认 9829（对齐 Polaris 后端端口习惯）
  policy?: PermissionPolicy;           // 默认：插件 manifest.permissions allowlist，未声明即 deny
  audit?: AuditSink;                   // 默认 SQLite audit 表（追加写 + 哈希链）
}
export interface BusServer {
  registerCapability(cap: Capability): void;          // 同 id 重复注册直接抛错（对齐 Polaris register_handle）
  loadServicePlugins(pkgs: string[]): Promise<void>;  // await import(pkg) → default.activate(serverCtx)
  start(): Promise<void>; stop(): Promise<void>;
}
export function createBusServer(opts?: BusServerOptions): BusServer;
```

dispatch 中间件链（对齐 Polaris RouterBus 思想，简化但**不退化为组件直调后端**）：

```
bus.dispatch(cap, action, payload)
  → [client] 附加 pluginId + requestId → transport（HTTP/SSE）
  → [server] 1. policy：目标 cap 是否在调用方 permissions 内 → deny 则广播 error 事件并审计
             2. audit：写入 {requestId, pluginId, cap, action, ts, decision}
             3. handler / streamHandler 执行；流式事件逐条经 SSE 下行
             4. 终态 audit(ok|error)；error 终态广播（dispatch 正常 ok 终态不广播，仅审计——沿用 Polaris 降吞吐经验）
```

### 4.5 Vite 集成契约（vite-plugin-polaris）

```ts
// packages/vite-plugin-polaris/src/index.ts
import type { Plugin } from 'vite';

export interface PolarisViteOptions {
  scanDirs?: string[];                       // 额外扫描目录（monorepo 内指向 plugins/，便于本地联调）
  plugins?: Array<string | false>;           // 显式排序/禁用：['@polaris-lite/chat-desk', false]
}

export function polaris(options?: PolarisViteOptions): Plugin;
```

职责（全部发生在构建期）：

1. **发现**：扫描 `node_modules`（含 `.pnpm` 解析结果）与 `scanDirs`，凡 package.json 顶层含 `polaris` 字段即视为插件；按 `plugins` 选项排序/过滤。
2. **生成虚拟模块** `virtual:polaris-plugins`（见 2.2）：`manifests`（合并后的 PluginManifest[]，附来源包名/版本）+ `loaders`（`pluginId → () => import('包名')` 静态 import map）。`import()` 目标是字面量包名，Rollup 可分析 → 每插件一个 chunk。
3. **依赖注入**：向 `config.resolve` 注入
   - `alias`：合并各插件 `polaris.vite.alias`；
   - `dedupe: ['react', 'react-dom', 'zustand', '@polaris-lite/bus', '@polaris-lite/plugin-kit']`（单实例保证）；
   - `optimizeDeps.include`：合并各插件声明。
4. **类型**：生成 `virtual:polaris-plugins.d.ts`，让宿主对 `loaders/manifests` 有完整类型。
5. **dev 监听**（可选开关）：watch node_modules 中插件包的 dist 变化，变更时使虚拟模块失效 → HMR 重载，缓解"装个插件要重启"的动态性损失（见 11.1）。

## 5. AI 对话插件挂载

### 5.1 布局骨架归属（对应 P2 硬约束）

| 层 | 归属 | 内容 |
|---|---|---|
| 外层壳 | **模板（核心）** | TopMenuBar + ActivityBar + LeftPanel（席位）+ RightPanel（对话主区框架）+ OverlayHost；复制自 Polaris `components/Common` + `components/Layout` |
| 对话四段式 | **chat-desk 插件包** | 会话侧栏 / 消息流 / 底部输入区 / 面板区 |
| 布局一致性契约 | **@polaris-lite/plugin-kit 的 `FourPaneShell`** | 四段式网格原语，零业务逻辑；chat-desk **必须**用它组装，槽位名与 Polaris 布局一一对应 |

```tsx
// @polaris-lite/plugin-kit/ui/FourPaneShell.tsx —— 布局原语（不是业务：不含任何对话逻辑）
export interface FourPaneShellProps {
  sessions?: ReactNode;            // 槽1：会话侧栏（左，默认宽 260）
  stream: ReactNode;               // 槽2：消息流（中，1fr，纵向自动滚动容器）
  input: ReactNode;                // 槽3：底部输入区
  panel?: ReactNode;               // 槽4：面板区（右或下）
  panelPosition?: 'right' | 'bottom';
  sessionsWidth?: number;
  className?: string;
}
export function FourPaneShell(props: FourPaneShellProps): JSX.Element;
```

`FourPaneShell` 用 CSS Grid 固定"左列 + 中列 + 右列（可选）/ 底行（可选）"结构并暴露全部槽位；布局风格走模板主题 token（不允许插件硬编码颜色字号）。**核心零业务**不破：该组件只有布局，没有一条对话语义；对话语义（会话管理、消息渲染、发送、工具卡片）全部在 chat-desk 包内。

### 5.2 挂载链路

```
pnpm add @polaris-lite/chat-desk
  → vite-plugin-polaris 发现 polaris 字段 → manifests + loaders 就绪
  → main.tsx 启动：按 manifests 顺序 import(entry) → activate(ctx)
  → registry 记录 views/overlays；mainSurface claim = chat.main（唯一，重复声明启动时报错）
  → App.tsx：RightPanel 内 <PluginPanelHost claim={claim} />
  → PluginPanelHost：loaders['polaris.chat-desk']() → panels['chat-desk'] → <ChatDeskPanel ctx=... />
  → ChatDeskPanel 内部：<FourPaneShell sessions={<SessionList/>} stream={<MessageStream/>}
                                          input={<ChatInput/>} panel={<ContextPanel/>} />
```

宿主侧 `PluginPanelHost`（模板内，约 60 行）只做：按 claim 取 loader → `React.lazy` 包裹 → ErrorBoundary + Suspense → 注入 `ctx` 与 `onSendToChat/onClose`。它**不知道**任何对话业务。

### 5.3 消息发送事件流（含中断与持久化）

```
用户在 ChatInput 发送
  → chat-desk sessionStore 乐观追加 user 消息（插件自有 Zustand，会话状态权威在插件）
  → bus.dispatchStream('cap.ai.chat', 'start', { sessionId, messages, model }, { signal, idempotencyKey })
      → bus-server：policy（chat-desk 是否声明 cap.ai.chat）→ audit → ai-engine capability
      → ai-engine 调供应商 SSE API，规范化为 BusEvent 流（ai.delta / ai.tool / ai.done / ai.error）
  ← SSE 逐条下行 → bus client → chat-desk uiDispatch（增量渲染消息流）
  → 结束时 chat-desk 经 bus.dispatch('cap.history','append',…) 落库（server 端 SQLite）
用户点停止
  → AbortController.abort() → signal 经 bus 传到 ai-engine → 取消供应商请求 → 广播 ai.error(interrupted)
```

会话历史抽屉：chat-desk 的 overlay 贡献 `session-history` 挂在模板 `OverlayHost` 的 `session-history` 槽（白名单沿用 Polaris）。

## 6. 插件清单（首批 npm 包）

| 包名 | kind | 贡献 | 说明 |
|---|---|---|---|
| `@polaris-lite/chat-desk` | ui-plugin | mainSurface `chat.main` + overlay `session-history` | AI 对话四段式 UI；会话状态、消息渲染、输入、面板区 |
| `@polaris-lite/ai-engine` | service-plugin | 注册 `cap.ai.chat` | 供应商直连（Anthropic / OpenAI 兼容 SSE），事件规范化为 Polaris AiEvent 子集 |
| `@polaris-lite/history-desk` | ui-plugin | leftPanel 席位 | 会话历史检索/回放（走 cap.history） |
| `@polaris-lite/settings-desk` | ui-plugin | settings 区 | 设置页：供应商 Key、模型、主题、插件开关 |
| `@polaris-lite/files-desk` | ui-plugin | leftPanel 席位 | 文件浏览（走 cap.fs，白名单根目录）——作为"业务面板插件化"样板 |
| `@polaris-lite/model-desk` | ui-plugin | leftPanel 席位 | 模型/供应商管理面板 |

内置 capability（bus-server 模板自带，非插件）：`cap.config`、`cap.kv`、`cap.fs`、`cap.http`（带审计出站代理）、`cap.history`、`cap.session`、`cap.ui`（server→client 下行 toast/导航/overlay 指令）。`cap.ai.chat` 由 ai-engine 插件注册，模板内只有契约定义与"未安装插件"的占位报错——**核心连 AI 编排都不含**。

## 7. 启动流程

### 7.1 脚手架流程（create-polaris-lite）

```
npx create-polaris-lite my-app
  ├─ 问卷：应用名 / 预装插件（默认 chat-desk + ai-engine，即"对话即装即用"）
  │        / transport（http 默认 | tauri 可选）/ 包管理器（pnpm 默认）
  ├─ 复制 packages/create-polaris-lite/template → my-app（含 tsconfig/eslint/.gitignore/layout/theme/i18n）
  ├─ 按选择写 my-app/package.json dependencies 与 polaris.config.ts：
  │     export default definePolarisConfig({
  │       transport: 'http',
  │       server: { port: 9829 },
  │       plugins: ['@polaris-lite/chat-desk', '@polaris-lite/ai-engine'],  // 顺序/开关
  │       permissions: { allowExtra: [] },                                  // 额外 cap allowlist
  │     });
  ├─ pnpm install && git init && 首次提交
  └─ 输出提示：pnpm dev（vite + bus-server 并起）；pnpm gen:plugin my-panel 创建新插件包
```

`pnpm gen:plugin` 由 plugin-kit 的 plopfile 驱动：

```js
// packages/plugin-kit/plopfile.js（节选）
module.exports = (plop) => {
  plop.setGenerator('plugin', {
    prompts: [
      { type: 'input', name: 'name', message: '插件包名（kebab-case，如 my-panel）' },
      { type: 'list', name: 'kind', choices: ['ui-plugin', 'service-plugin'] },
      { type: 'list', name: 'area', choices: ['mainSurface', 'leftPanel', 'activityBar', 'settings'] },
    ],
    actions: [
      { type: 'addMany', destination: 'plugins/{{name}}/',
        templateFiles: 'plop-templates/plugin/**/*.hbs', base: 'plop-templates/plugin/' },
    ],
  });
};
```

生成物含：`package.json`（polaris 字段骨架，area/slot 已填）、`vite.config.ts`（库构建 + external peerDeps）、`src/index.tsx`（definePlugin 骨架 + panels 注册）、`src/Panel.tsx`（接到所选 area 的占位面板）——新插件 `pnpm add` 进应用即出现在对应席位。

### 7.2 应用运行时启动时序

```
[Node 侧] bus-server.start()
  1. 载入 polaris.config → 起HTTP/SSE 监听 9829
  2. 注册内置 caps：config/kv/fs/http/history/session/ui
  3. loadServicePlugins(config.plugins 中 kind=service-plugin 的包)  // 如 @polaris-lite/ai-engine
  4. 打开 SQLite（kv / audit / history 三类表）

[浏览器侧] src/main.tsx
  1. 创建 bus 单例（transport = http(9829)，来自 polaris.config）
  2. import 'virtual:polaris-plugins' → { manifests, loaders }
  3. theme bootstrap（同步注入 CSS 变量防 FOUC）+ i18n init
  4. 按 manifests 顺序：const mod = await loaders[id](); await mod.default.activate(ctx)
     —— ctx 由宿主构造（bus/layout/storage/logger/config/i18n/theme）
  5. 贡献汇入 registry（views/overlays）；校验 mainSurface 唯一 claim
  6. createRoot(#root).render(<App/>)：Layout 壳按 registry 渲染席位；
     RightPanel 渲染 mainSurface claim → PluginPanelHost（懒加载 chat-desk）
```

失败语义：任一插件 activate 抛错 → 该插件标记 disabled + toast + 审计，**不阻断**其他插件与壳渲染；bus-server 不可达 → ConnectingOverlay 门（沿用 Polaris 体验）。

## 8. 与 Polaris 的复用/差异清单

### 8.1 直接复制（改 import 路径与包名）

| 源（Polaris） | 去向（S9） | 备注 |
|---|---|---|
| `src/components/Common/Layout.tsx` + `Layout/ActivityBar/LeftPanel/RightPanel` | `template/src/layout/` | 外层壳，约 1,800 行；席位数据源改为 S9 registry |
| `components/Common/`（Modal/Toast/ErrorBoundary/RightSlideOver/PermissionPromptHost/Icons） | `template/src/components/` | 通用组件原样复制 |
| `src/services/themeEngine.ts` / `themeMerger.ts` + 主题 token 体系 | `template/src/theme/` | 保留 FOUC 防护 |
| `src/i18n/` + `src/locales/` 结构 | `template/src/i18n/` | 保留 key 结构，翻译按需精简 |
| worktree `.claude/worktrees/browser-desk-extraction/src/components/Chat/` 的 `session/`、`messages/`、`input/`、`chatBubbles/` 选件 | `plugins/chat-desk/src/` | 四段式 UI 主体；删除 Polaris 专有依赖后入包 |
| `src/types/aiEvent.ts`（事件协议） | `packages/bus/src/types.ts` | AiEvent 子集，保持字段名不漂移 |
| `plugin.json` contributes 字段语义（area/slot/slotMode 白名单） | `package.json#polaris.contributes` | 契约对齐，迁移心智成本最低 |

### 8.2 重写（保留职责，换实现）

| Polaris 现状 | S9 重写 | 理由 |
|---|---|---|
| `plugin-system/pluginModuleLoader.ts`（Blob URL 动态 import，155 行） | `vite-plugin-polaris`（构建期 import map） | 核心差异点：构建期集成取代运行时 Blob |
| `plugin-system/registry.ts` + `panelRegistry.ts` + `pluginDiscoveryService.ts` | `plugin-host/registry`（消费虚拟模块，约 200 行） | 发现从"磁盘扫描 + IPC"变为"构建期清单" |
| Rust `RouterBus`（router/mod.rs 1,786 行）+ `commands/router.rs` | `@polaris-lite/bus` + `bus-server`（TS，约 4,600 行） | cap 总线思想保留：权限 gate + 审计 + 转发 + 流式 |
| `appCoreBridge.ts`（向插件泄漏 21 store + 30 命令） | `PluginContext` 窄接口（bus/layout/storage/logger/config） | 收窄宿主桥，插件只能经总线触达后端 |
| `ai_chat_core`(3,042) + `simple_ai`(10k+) + `claude.rs`(1,772) | `@polaris-lite/ai-engine`（约 2,500 行 TS） | 供应商 HTTP 直连 + 事件规范化；工具/MCP 留作后续 service-plugin |
| `storage_exec`(4,964) | bus-server 内置 SQLite（better-sqlite3，约 400 行） | cap.history/cap.session/cap.kv 共用 |
| `plugin_service.rs`(2,904) + supervisor(2,169) | npm 生态（安装/版本/健康由 pnpm 与进程管理承担） | 不重复造安装器 |

### 8.3 放弃（不进入 S9）

- Tauri/Rust 全部（默认 profile）：`src-tauri/` 101,032 行、36 个 `#[tauri::command]`、DLL/feature 门控体系（可选 tauri profile 另议）。
- 运行时插件安装/市场/沙箱：`install_*_plugin`、marketplace、Blob 沙箱边界——由 npm registry + 构建期集成替代。
- 业务域残留：`fileExplorerStore`(804)、`fileEditorStore`(587)、`tabStore`(500)、`toolConfig`(974)、`toolSummary`(852)、CenterStage 编辑器/SCM、Preview/UiFrame。
- 领域服务：`proxy/`(5,039)、`computer_control/`、`nexus_pipeline/`、`form/`、`ask_listener/`、MCP 体系（首期）。
- 复杂会话设施：`compact-handoff`、dynamic-island、chat 搜索（chat-desk 精简时裁去，接口留位）。

## 9. 裁剪量化表

| 维度 | Polaris 现状 | S9 | 削减 |
|---|---|---|---|
| 核心前端 | `src/` 49,794 行 / 279 文件 | 模板宿主 ≈4,500 行（壳/registry/theme/i18n/通用 store） | ≈ -91% |
| 核心后端 | `src-tauri/` 101,032 行 Rust / 250 文件 | bus-server ≈3,000 行 TS（Node sidecar，无 Rust 工具链） | ≈ -97% |
| 插件机制 | plugin_service 2,904 + 前端 plugin-system ≈2,600 行（含 Blob 加载） | vite-plugin ≈350 + plugin-kit ≈900 行 | ≈ -90%，且构建期化 |
| cap 面 | 34 capability / ~30 cap id | 7 个内置 cap + 服务插件按需注册 | 大幅收窄 |
| AI 对话 UI | chat-desk 插件 23,763 行 | `@polaris-lite/chat-desk` ≈7,000 行 | ≈ -70%（保留四段式） |
| AI 引擎 | simple_ai 10k+ 行 Rust + claude.rs 1,772 | `@polaris-lite/ai-engine` ≈2,500 行 TS | 供应商直连 |
| 会话存储 | storage_exec 4,964 行 Rust | bus-server SQLite 封装 ≈400 行 | ≈ -92% |
| 启动链路 | cargo 编译 + Rust init + Vite | `pnpm dev`（Vite + tsx 起 Node，秒级，无 cargo） | 工具链简化 |
| **核心合计** | **≈150,826 行** | **≈9,250 行**（宿主 4.5k + bus 1.6k + server 3k + kit 0.9k + vite 插件 0.35k） | **≈ -94%** |
| 全量（含官方插件） | ≈150k + chat-desk 23.7k | ≈23,000 行 | ≈ -85% |

> 口径说明：S9 行数为迁移后预估（复制组件按裁剪后计）；Polaris 侧为 baseline.md 实测。裁剪真实性依赖第 10 节迁移步骤逐项验收，不允许"复制即算完成"。

## 10. 迁移步骤（Polaris → polaris-lite，全程不改 Polaris 主仓）

1. **Phase 0 建仓**：建 `D:\space\base\Polaris-lite` pnpm monorepo（packages/* + plugins/* 双 glob）；落地 eslint 规则 `no-restricted-imports` 禁止 template/plugins 引用 Polaris 专有模块。
2. **Phase 1 壳**：从 Polaris 复制 Common/Layout 壳组件、theme、i18n 进 `template/`；跑通 `pnpm dev` 空壳（席位全空态）。验收：tsc 零错 + 壳可渲染。
3. **Phase 2 总线**：实现 `@polaris-lite/bus`（HTTP+SSE transport）、`bus-server`（policy→audit→handler 中间件链 + 内置 caps + SQLite）；写 vitest 契约测试（dispatch 权限 deny、流式中断、幂等键）。验收：curl 层面可 dispatch cap.kv 且审计落库。
4. **Phase 3 插件机制**：实现 `vite-plugin-polaris`（扫描/虚拟模块/dedupe/alias）+ `plugin-kit`（types/definePlugin/FourPaneShell/plop 模板）+ `create-polaris-lite` CLI。验收：手工装一个测试插件包，虚拟模块生成正确、HMR 生效。
5. **Phase 4 对话插件**：从 worktree Chat 树裁剪出 chat-desk 包（session/messages/input/chatBubbles → FourPaneShell 组装）；会话状态用插件自有 Zustand；事件走 `bus.dispatchStream('cap.ai.chat')`。验收：不接引擎时输入可回显系统消息、历史走 cap.history。
6. **Phase 5 引擎与面板**：ai-engine service-plugin（Anthropic/OpenAI 兼容 SSE + AbortSignal 中断 + AiEvent 归一）；history/settings/files/model-desk。验收：真 Key 端到端流式对话 + 停止 + 历史回放。
7. **Phase 6 脚手架端到端**：`npx create-polaris-lite demo`（本地 file: 依赖）→ `pnpm dev` → 对话即用；补 README 与插件作者指南。验收 = brief 全部硬性约束逐条勾稽（见 §12）。

## 11. 风险与对策

### 11.1 运行时动态性损失（本方案首要、须明示的取舍）

**损失点**：Polaris 现状支持运行时从磁盘/市场装入插件（Blob 加载、不停机、不动构建）；S9 的插件进构建图，**新增或升级插件 = `pnpm add` + 重新构建/重启 dev**；不存在"应用跑着就换插件"。同时插件与宿主共享依赖版本图，宿主升级可能要求插件重发版。

**对策**：
1. 把"动态性"前移到包管理器层：市场 = npm registry（或私服/git/file 依赖）；提供 `polaris add @polaris-lite/xxx` CLI 一条命令完成 add + polaris.config 登记 + dev 重启，把"安装即用"的体验落差压到一条命令。
2. dev 体验补偿：vite-plugin 监听插件包 dist 变化自动失效虚拟模块（HMR 级重载）；monorepo 内 `scanDirs` 直连源码，插件开发零发包。
3. 逃生舱（默认关闭、非主路径）：对确需运行时下发的非核心面板，预留 `bus.dispatch('cap.http','fetch',…)` 拉取 + `loadRemote(url)` 动态 import 的能力位，走审计与 CSP 白名单；首期不实现，仅留接口注释，避免重新引入 Blob 沙箱问题。
4. 明确接受取舍并写进决策记录：lite 的目标是轻、稳、可维护；构建期集成分换来类型安全、tree-shaking、按插件分包与更小的运行时。若评委认为运行时热装是硬需求，S9 的该取舍即是其边界。

### 11.2 其他风险

| 风险 | 影响 | 对策 |
|---|---|---|
| 双 React / 多实例（插件与宿主各带一份 react/zustand） | hooks 报错、状态分裂 | vite-plugin 强制 `resolve.dedupe`；插件构建 external peerDeps；eslint 禁止插件 import `react-dom`/`createRoot`；bus 单例由模块作用域保证 |
| 复制组件暗藏 Polaris 耦合（内部 import 已删域的 store/service） | 编译失败/隐性业务回流 | 复制时逐文件过 tsc；eslint no-restricted-imports 守护；宁可重写小文件也不整目录搬 |
| 模板腐化（生成应用与模板漂移） | 升级困难 | 契约包（bus/plugin-kit/vite-plugin）严格 semver；CLI 提供 `polaris upgrade` 以 git merge 方式回套模板；模板改动走 changeset |
| Node sidecar 权限强度弱于 Rust 进程隔离 | 恶意插件可越权 | cap gate + 审计全部在 server 中间件；插件无直连 DB/FS 的 API 面（只有 bus）；文档明示威胁模型 = 单人本地工具；可选 tauri profile 承接更强隔离需求 |
| AI 能力缩水（对比 simple_ai 的工具/MCP/compact） | 功能缺口 | cap.ai.chat 事件协议保持 Polaris AiEvent 子集，后续以 service-plugin 增量补工具/MCP；首期只承诺流式对话+历史+中断 |
| 内网无 npm 私服 | 安装受阻 | 支持 `file:` / `git+ssh` 依赖形态；vite-plugin 扫描不区分来源；提供 verdaccio 部署脚本 |
| pnpm `.pnpm` 目录扫描漏包 | 插件未被集成 | 扫描走 `require.resolve`/包管理器 API 而非裸 readdir；`polaris` 字段缺失时给出诊断日志 |

## 12. 硬性约束自查表

| 约束（brief §3） | 落点 |
|---|---|
| 1. 对话布局 = Polaris 现状四段式 | §5.1：外层壳由模板复制，四段式由 chat-desk 经 `FourPaneShell`（会话/消息流/输入/面板）保证 |
| 2. 核心零业务 | §3.1/§6：模板仅壳+总线+契约+脚手架；连 cap.ai.chat 编排都在 ai-engine 插件包内 |
| 3. AI 对话 UI 与业务面板均为插件、统一契约挂载 | §4.1/§4.2/§5.2：package.json#polaris + definePlugin + PluginPanelHost，chat-desk 与 files-desk 同一契约 |
| 4. 保留 cap 总线思想（模板内置总线包） | §4.4：@polaris-lite/bus + bus-server，policy→audit→handler 链，流式与审计保留，不退化为直调 |
| 5. 前端栈说明与迁移成本 | React + Vite + Zustand 原栈（与 Polaris 同栈，迁移成本最低）；差异在插件机制而非框架，见 §8/§10 |
| 6. 规定章节齐全 | §2–§11 依次对应架构图/目录树/契约/挂载/清单/启动/复用差异/量化/迁移/风险 |
| 7. 复制/重写/放弃清单 | §8.1 / §8.2 / §8.3 |
| P8 与 Polaris 独立 | 全部落 `D:\space\base\Polaris-lite`，仅复制源码，不依赖对 Polaris 的任何改动 |
