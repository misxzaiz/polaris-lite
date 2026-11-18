# P2 方案：覆盖层插件（Overlay Plugin）—— 权限插件自带全屏登录 UI，自己控制拦截与放行

> 对应总纲：`docs/auth-schemes/brief-auth.md`（P2 格位）。
> 核心思想：权限验证插件（`cap.auth` 提供方）在 `setup()` 后主动检查登录态；未登录时把一个**全屏覆盖层**挂到应用最上层，遮住四槽壳；登录成功后移除覆盖层放行。宿主只新增一个**通用覆盖层挂载点**能力（`api.overlay`），不含任何权限业务逻辑。
> 与 P1（壳层拦截）的本质区别：拦截决策权在**插件**手里，不在宿主壳里；宿主对"登录"零感知，只提供一个"高空挂点"。

---

## 1. 架构图（文字图）

### 1.1 静态结构

```
document.body
├─ #root                                ← 宿主应用（z-index 0 域）
│   └─ .polaris-lite-shell（SlotLayout 四槽壳）
│       ├─ .shell-sidebar  → SlotOutlet(slot=sidebar) → chat-lite/SessionSidebar
│       ├─ .shell-main     → SlotOutlet(slot=stream)  → chat-lite/MessageStream
│       │                    SlotOutlet(slot=input)   → chat-lite/ChatInput
│       └─ .shell-panel    → SlotOutlet(slot=panel)   → cap-panel / model-admin
│       （移动端另有 .shell-topbar z=30 / .drawer-mask z=35 / 抽屉 z=40）
│
└─ #polaris-overlay-root                ← 通用覆盖层挂载点（body 直挂，脱离 .slot 层叠域）
    └─ [data-plugin="auth-mock"]        ← 权限插件 acquire() 后 createRoot 渲染的容器
        └─ <LoginOverlay/>              ← 全屏登录 UI（z-index 2147483000，own stacking context）
```

### 1.2 运行时事件顺序（拦截 → 放行）

```
main.tsx bootstrap
  │
  ├─ loadExternalPlugins() ── 动态 import auth-mock/plugin.js
  │     └─ host.registerPlugin(auth-mock)
  │           └─ auth-mock.setup(api)
  │                 ├─ api.registerCapability.register('cap.auth', handler)
  │                 ├─ handle = api.overlay.acquire({ zIndex: 2147483000 })
  │                 │     （宿主创建/复用 #polaris-overlay-root 子节点，body 直挂）
  │                 ├─ createRoot(handle.container).render(<LoginOverlay/>)
  │                 └─ checkSession(): 读本地 token
  │                       ├─ 无 token / 过期 → 保持覆盖层（应用被遮住，但壳已可渲染）
  │                       └─ 有 token → 本地校验通过 → handle.release()
  │                                              ├─ unmount 覆盖层组件
  │                                              └─ 宿主移除容器节点，#root 恢复可见可交互
  │
  └─ createRoot(#root).render(<SlotLayout/>)   ← 此时覆盖层可能已悬于其上
```

### 1.3 登录/登出/刷新时序

```
用户在覆盖层输入凭据
  → LoginOverlay 调用内部 login()
      → api.dispatch({target:'cap.auth', action:'login', payload:{username,password}})
          → auth-mock handler 校验 → 写 localStorage(token+exp)
          → emit('auth-changed', {status})
      → 成功：setState(authed) → handle.release() → 应用放行
      → 失败：覆盖层内提示错误，覆盖层不移除（fail-closed）

登出：任意调用方 dispatch logout → handler 清 token → emit('auth-changed')
      → auth-mock 自身监听/主动 re-acquire → 覆盖层重新挂载

刷新页面：重新走 1.2 的 bootstrap 时序（token 快路径 ≤1 帧；慢路径先挂"验证中"态）
```

---

## 2. `cap.auth` 契约完整定义（TS）

放置位置：`src/core/types.ts` 追加（与现有 `ChatMessage` 等协议类型同级）；权限插件源码经 `@/core/types` 引用（构建期 alias 解析，见 `plugins/shared.plugin-config.ts`）。

```ts
// ===== cap.auth 契约（brief-auth 最低动作集） =====

/** 登录状态快照（action: 'status' 返回） */
export interface AuthStatus {
  authenticated: boolean;
  userId?: string;
  displayName?: string;
  /** 角色列表，供 check() / P3 角色矩阵消费 */
  roles?: string[];
  /** token 摘要（绝不传明文 token 过总线） */
  tokenDigest?: string;
  /** 过期时间戳（ms）；undefined = 会话级 */
  expiresAt?: number;
}

/** 登录凭据（形态由插件自定义；mock 实现 = 用户名密码） */
export interface AuthLoginPayload {
  method?: string; // 'password' | 'oauth' | 'sso' ... 插件自解释
  [credential: string]: unknown;
}

/** 登录结果 = 登录后的完整状态 */
export type AuthLoginResult = AuthStatus;

/** 权限校验结果（action: 'check'） */
export interface AuthCheckPayload {
  permission: string;        // 如 'panel:model-admin' / 'chat:send' / 'role:admin'
}
export interface AuthCheckResult {
  allowed: boolean;
  permission: string;
  reason?: string;           // 不通过时的可展示原因
}

/** cap.auth 动作 → 请求/响应映射（调用方按需在 manifest.capabilities 声明 'cap.auth'） */
export interface CapAuthActionMap {
  status:  { payload: undefined;            result: AuthStatus };
  login:   { payload: AuthLoginPayload;     result: AuthLoginResult };
  logout:  { payload: undefined;            result: { ok: true } };
  check:   { payload: AuthCheckPayload;     result: AuthCheckResult };
}

/** 调用示例（业务插件内）：
 *   const res = await api.dispatch<AuthStatus>({ target: 'cap.auth', action: 'status' });
 *   const ok  = await api.dispatch<AuthCheckResult>({ target: 'cap.auth', action: 'check',
 *                 payload: { permission: 'chat:send' } });
 */

/** 登录态变更事件（权限插件 emit；消费方须在 manifest.events 声明） */
export interface AuthChangedEvent {
  status: AuthStatus;
}
export const AUTH_CHANGED_EVENT = 'auth-changed';
```

**提供方注册**（对齐 `real-engine` 的写法，`plugins/auth-mock/index.ts`）：

```ts
manifest: {
  id: 'auth-mock',
  name: '登录验证（演示）',
  version: '0.1.0',
  capabilities: [],                    // 本插件不调别人
  provides: ['cap.auth'],              // 宿主 assertProvides 校验此声明
  events: [],                          // 只 emit，不 listen
  contributes: { slots: [] },          // 关键：不占四槽，走 overlay
},
setup(api) {
  api.registerCapability.register('cap.auth', authHandler); // status/login/logout/check 分发
  // …覆盖层装配见 §4
}
```

---

## 3. 覆盖层挂载与 z-index / 层叠策略（`.slot` 的 `isolation:isolate` 陷阱）

### 3.1 为什么不能走四槽渲染

`src/styles.css:124-130`：

```css
.slot {
  min-height: 0;
  position: relative;
  z-index: 0;
  isolation: isolate; /* 插件内容限制在槽位 stacking context，z-index 无法逃逸到抽屉之上（验收 A-3） */
}
```

凡经 `SlotOutlet` 渲染进 `.slot` 容器的内容，其内部任意 z-index 都被锁死在该槽位的 stacking context 内（`z-index:0` 的隔离上下文）。而移动端抽屉 `z-index:40`、遮罩 `35`、顶栏 `30` 都在 `.slot` 之外。**若把登录覆盖层作为槽位贡献渲染，它永远盖不住抽屉、甚至盖不住主区**。所以覆盖层必须挂在 `.slot` 层叠域之外——即 `document.body` 直挂节点。

### 3.2 通用挂载点：`#polaris-overlay-root`（宿主唯一改动）

在 `index.html` 的 `<div id="root"></div>` 之后加：

```html
<!-- 通用覆盖层挂载点：任何插件可申请，同一时刻至多一个持有者（见 §6 争用） -->
<div id="polaris-overlay-root"></div>
```

`src/styles.css` 追加：

```css
#polaris-overlay-root { position: static; }        /* 本身不参与布局 */
#polaris-overlay-root > [data-overlay] {
  position: fixed;
  inset: 0;                                        /* 全屏 */
  display: flex; align-items: center; justify-content: center;
  background: var(--bg);                           /* 不透明，彻底遮住四槽壳 */
  isolation: isolate;                              /* 自建独立层叠域：内部 z-index 自理，不与宿主互相污染 */
}
```

### 3.3 z-index 层级表

| 层 | 元素 | z-index | 说明 |
|---|---|---|---|
| 槽内内容 | `.slot` 及其后代 | 0（isolate） | 验收 A-3：禁止逃逸 |
| 移动端顶栏 | `.shell-topbar` | 30 | |
| 抽屉遮罩 | `.drawer-mask` | 35 | |
| 移动端抽屉 | `.shell-sidebar/.shell-panel.open` | 40 | |
| **权限覆盖层** | `#polaris-overlay-root > [data-overlay]` | **2147483000** | body 直挂 + 独立 stacking context，稳压全部宿主层；留 647 个余量给插件内部层级（logo/spinner 分层） |

覆盖层同时宿主侧配合做**交互封锁**（不只视觉遮挡）：`acquire()` 时给 `#root` 置 `inert` + `aria-hidden="true"`，`release()` 时移除——防 Tab 聚焦穿透、防读屏读到被遮内容、防底层按钮被程序化点击。

> 已知边界：原生 Top-layer 元素（`<dialog>.showModal()`、popover）位于所有 z-index 之上，覆盖层盖不住它们。当前宿主无原生 dialog，可接受；若未来引入，需约定 Top-layer 元素在 `authenticated === false` 时不弹出。

---

## 4. 插件如何在不修改宿主业务的情况下渲染全屏 UI

宿主改动仅 §3.2 的一个空 div + 少量 CSS + `SlotHostApi` 增加一个通用 `overlay` 命名空间（无任何 auth 字样）。渲染本体完全由插件完成：

### 4.1 宿主通用 overlay API（`src/core/types.ts` + `src/core/hostRuntime.ts`）

```ts
/** 覆盖层句柄：持有期间覆盖层可见，release 后宿主移除容器 */
export interface OverlayHandle {
  /** 已挂到 #polaris-overlay-root 下的空容器；插件对其 createRoot 渲染 */
  readonly container: HTMLElement;
  /** 释放覆盖层：unmount 由插件负责，容器移除由宿主负责；幂等 */
  release(): void;
}

export interface SlotHostApi {
  // …既有成员不变…
  /** 申请全屏覆盖层（先到先得，同一时刻仅一个持有者；被占时返回 null） */
  overlay: {
    acquire(opts?: { zIndex?: number; label?: string }): OverlayHandle | null;
    readonly activeOwner: string | null; // 诊断用：当前持有插件 id
  };
}
```

`hostRuntime.ts` 实现要点（约 40 行）：懒创建/复用 `#polaris-overlay-root`；`acquire` 时若已有 owner 返回 `null`；容器 `data-overlay` + `data-plugin=manifest.id`、`zIndex` 写入内联样式；`#root.inert = true`；`release` 置回 `inert=false`、清空容器、清 owner。**宿主不知道也不关心挂上来的东西是不是登录页。**

### 4.2 插件侧自渲染（`plugins/auth-mock/index.ts` + `LoginOverlay.tsx`）

```ts
import { createRoot, type Root } from 'react-dom/client'; // import map 已外部化，插件 bundle 裸 import

let overlayHandle: OverlayHandle | null = null;
let overlayRoot: Root | null = null;

function mountOverlay(api: SlotHostApi): void {
  if (overlayHandle) return;                       // 幂等（防 HMR/重复 setup）
  const handle = api.overlay.acquire({ zIndex: 2147483000, label: '登录' });
  if (!handle) return;                             // 已有别的插件持有 → 见 §6
  overlayHandle = handle;
  overlayRoot = createRoot(handle.container);      // 对宿主提供的容器建 React 根
  overlayRoot.render(<LoginOverlay
    onLogin={async (u, p) => {
      const res = await api.dispatch<AuthLoginResult>({ target: 'cap.auth', action: 'login',
        payload: { method: 'password', username: u, password: p } });
      if (res.ok && res.data?.authenticated) { unmountOverlay(); return true; }
      return false;                                 // 失败：覆盖层保留，UI 内展示错误
    }}
  />);
}

function unmountOverlay(): void {
  overlayRoot?.unmount(); overlayRoot = null;       // 1) 先卸组件树
  overlayHandle?.release(); overlayHandle = null;   // 2) 宿主移除容器、恢复 #root 可交互
}
```

`setup()` 内的启动检查（fail-closed）：

```ts
setup(api) {
  api.registerCapability.register('cap.auth', createAuthHandler(api));
  mountOverlay(api);                               // 同步先挂：主线程渲染壳之前已就位
  void api.dispatch<AuthStatus>({ target: 'cap.auth', action: 'status' })
    .then((res) => {
      if (res.ok && res.data?.authenticated) unmountOverlay();  // token 快路径
      // 慢路径（要联网验 token）在覆盖层内自旋"验证中"，失败保持 fail-closed
    });
}
```

> 备选（零宿主改动形态）：插件完全自己 `document.body.appendChild(自建 div)` + `createRoot`，效果等价；但多插件争用、inert 管理、层叠约定就要靠插件自觉。推荐采用宿主 `api.overlay` 通用能力（对宿主仍是零权限知识），争用与交互封锁由核心统一裁决。

---

## 5. 替换场景：mock-auth ↔ 企业 SSO

复用本仓已有的替换机制（同 `mock-engine` ↔ `real-engine`）：**同一契约，两个插件包，registry.json 的 `enabled` 二选一**，宿主与业务插件零改动。

| | `plugins/auth-mock/` | `plugins/auth-sso/`（形态示例） |
|---|---|---|
| provides | `['cap.auth']` | `['cap.auth']` |
| login 实现 | 任意非空用户名/密码通过；token=`btoa(user)+exp` 存 `localStorage`，5min 过期演示踢登 | OAuth2/OIDC：`login` 动作打开 IdP 授权页（popup/redirect），回调里换 token；或反向代理会话 cookie |
| status 实现 | 读 localStorage 本地校验 exp | 读会话 cookie / 调 IdP `/.well-known/openid-configuration` + userinfo |
| check 实现 | roles 默认 `['user']`；`role:admin` 仅 `admin` 账号 | 解析 ID token 的 `roles`/`groups` claim |
| 覆盖层 UI | 用户名+密码表单 | "使用企业账号登录"按钮 → 跳转 IdP；回调等待页 |
| token 存储 | localStorage（演示） | httpOnly cookie（经后端/中继）优先；避免 JS 可读 token |

切换步骤：`public/plugins/registry.json` 中把 `auth-mock.enabled=false`、`auth-sso.enabled=true`（build-plugins.mjs 生成后可手工改，或直接在构建脚本列表调整）。业务插件（chat-lite 等）只认 `cap.auth` 契约与 `auth-changed` 事件，无感替换。

---

## 6. 边界与风险

1. **覆盖层移除时机**：只在 `status/login` 返回 `authenticated===true` 后移除；登录失败、网络异常、token 校验超时一律保持覆盖层（fail-closed）。绝不在 `login` 发出后乐观移除。
2. **刷新后重挂载**：`main.tsx` 的 `bootstrap()` 是**先 await 插件加载、后渲染壳**，因此 `setup()` 里同步 `mountOverlay()` 能保证覆盖层先于首帧存在，不存在"闪现已登录内容"窗口。token 快路径一帧内放行；需联网校验时覆盖层显示"验证中"，超时（建议 10s）fail-closed 停留并给出重试按钮。`registerPlugin` 已对同 id 幂等，StrictMode 下 `setup` 也只跑一次，`mountOverlay` 内部再有 `overlayHandle` 判重兜底。
3. **多插件争用 overlay**：`acquire()` 先到先得、被占返回 `null`；争用方（如第二个 auth 插件、未来的引导页/公告插件）应轮询等待或放弃。判定规则约定：`cap.auth` 提供方在 registry 中应至多启用一个（与 mock/real-engine 同规），由注册表评审保证；宿主可在 `console.warn` 提示被拒的申请方（便于诊断）。
4. **权限插件崩溃/加载失败**：插件 import 失败时 `loadExternalPlugins` 记入 `failed` 且不阻断壳渲染 → 应用**无覆盖层直接放行**（fail-open）。这是本方案最大的安全边界：覆盖层方案的"拦截强度"= 插件可用性。缓解：registry 启用项在发布前人工核对；对安全敏感部署应配合后端鉴权（前端覆盖层只是体验层，不是安全边界）。
5. **绕过风险**：覆盖层只挡 UI。业务 cap（如 `cap.ai.chat`）若不自行校验，被遮住的壳仍可能被其他插件经总线调用。可选加固：chat-lite 在 `sendUserMessage` 前先 `check('chat:send')`（需在其 `manifest.capabilities` 加 `'cap.auth'`），后端/中继对写操作做真实鉴权。
6. **会话过期**：mock 实现按 `exp` 本地判定；真实实现监听 401 / IdP token 刷新。过期后重新 `mountOverlay()` 并提示重新登录。`visibilitychange` 时可做惰性复检。
7. **Top-layer 元素**（原生 `<dialog>`/popover）在覆盖层之上：当前宿主无此元素；约定未登录期间不得弹出（§3.3）。
8. **HMR/重复加载**：`unmountOverlay` 幂等；`acquire` 单持有者；`#polaris-overlay-root` 固定 id 复用，不重复建节点。

---

## 7. 实施步骤清单（文件级）

**A. 宿主通用能力（约 60 行，无权限语义）**
1. `index.html`：`#root` 后加 `<div id="polaris-overlay-root"></div>`。
2. `src/styles.css`：追加 `#polaris-overlay-root` 与 `> [data-overlay]` 基础样式（§3.2）。
3. `src/core/types.ts`：新增 `OverlayHandle`、`SlotHostApi.overlay`、`cap.auth` 契约类型（§2、§4.1）。
4. `src/core/hostRuntime.ts`：`createApi()` 内实现 `overlay.acquire/release`（单持有者、`#root` inert 管理、`data-plugin` 标注）。

**B. auth-mock 插件（新目录 `plugins/auth-mock/`）**
5. `plugins/auth-mock/index.ts`：`authMockPlugin`（manifest `provides:['cap.auth']`、`contributes.slots:[]`）+ `createAuthHandler`（status/login/logout/check，localStorage 会话，emit `auth-changed`）+ setup 内 `mountOverlay`/启动检查（§4.2）。
6. `plugins/auth-mock/LoginOverlay.tsx`：全屏登录表单（用户名/密码/错误提示/验证中态），props：`onLogin(u,p): Promise<boolean>`。
7. `plugins/auth-mock/vite.config.ts`：`createPluginConfig('auth-mock', './index.ts', 'dist')`。

**C. 注册与构建**
8. `plugins/build-plugins.mjs`：plugins 数组加 `{ id:'auth-mock', config:'auth-mock/vite.config.ts', dist:'auth-mock/dist' }`。
9. `public/plugins/registry.json`：追加 `auth-mock` 条目（该文件由构建生成，手工同步一次以便 dev 直接生效）。

**D.（可选加固）业务侧示范消费**
10. `plugins/chat-lite/index.ts`：`sendUserMessage` 前置 `api.dispatch({target:'cap.auth', action:'check', payload:{permission:'chat:send'}})`，manifest `capabilities` 追加 `'cap.auth'`；失败 toast 并不出流。

**E. 验证（本机命令）**
11. `pnpm exec tsc --noEmit`（仓库根 `D:\space\base\polaris-lite`）。
12. `node plugins/build-plugins.mjs` → 确认 `public/plugins/auth-mock/plugin.js` 与 registry 更新。
13. 冒烟：`pnpm dev` → 首屏应见全屏登录页（四槽壳被遮）→ 任意账号密码登录 → 覆盖层消失、对话可用 → 刷新页面直接放行 → `localStorage` 清 token 后刷新 → 覆盖层复现；移动端视口（≤768px）下开抽屉确认覆盖层仍盖住抽屉。
14.（可选）`plugins/auth-sso/` 骨架：同契约空实现 + registry `enabled:false`，证明可替换性。
