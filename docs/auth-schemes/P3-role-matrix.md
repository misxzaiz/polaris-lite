# P3 方案：路由/角色矩阵（Role → Slot/Capability Matrix）

> 路线：权限插件维护「角色 → 可访问槽位/能力」矩阵，提供细粒度 `check(permission)`；
> 宿主壳与 SlotOutlet 按矩阵过滤槽位渲染（未授权槽位显示无权限提示或不渲染）；登录 UI 由插件提供。
> 对应 brief：`docs/auth-schemes/brief-auth.md` 差异化矩阵第 3 格。

---

## 1. 方案定位与设计原则

- **单一权威**：角色矩阵的所有权在权限插件（`cap.auth` 提供方），宿主只消费判定结果，不持有任何角色/权限数据。
- **两层防线**：
  - L1 渲染层——`SlotOutlet`/`SlotLayout` 按矩阵过滤槽位与 Tab（体验层，防误见）；
  - L2 总线层——`CapBus` 增加可选 user-guard，在 `dispatch`/`dispatchStream` 内按 `cap:<capId>` 权限裁决（安全层，防绕过 UI 直接打总线）。
- **宿主零插件引用**：宿主只认识 `cap.auth` 这个 cap id 与 `contributes.slots` 贡献，不 import 任何权限插件源码；替换插件零改动。
- **默认拒绝**：无 `cap.auth` 提供方时宿主处于「open 模式」（全放行，兼容现有 demo）；一旦有插件声明 `provides: ['cap.auth']`，未登录/未授权一律拒绝。
- **矩阵可热更**：插件可运行时改矩阵并广播 `auth-changed`，宿主侧缓存失效后重取，无需刷新页面。

---

## 2. 架构图（文字图）

```
                         ┌────────────────────────────────────────────────┐
                         │            plugins/auth-matrix（示例实现）        │
                         │  ┌──────────────┐  ┌─────────────────────────┐  │
                         │  │ LoginPanel   │  │ MatrixAdmin（可选面板）    │  │
                         │  │ (overlay 槽) │  │ 角色/权限维护 UI          │  │
                         │  └──────┬───────┘  └───────────┬─────────────┘  │
                         │         │ setup(api)           │                │
                         │  ┌──────▼──────────────────────▼─────────────┐  │
                         │  │  cap.auth handler（矩阵权威所有者）          │  │
                         │  │  status / login / logout / check / matrix  │  │
                         │  │  角色矩阵: role → allow[]/deny[]            │  │
                         │  │  持久化: localStorage（SSO 版改为远端策略）   │  │
                         │  └──────┬────────────────────────────────────┘  │
                         └─────────┼───────────────────────────────────────┘
                                   │ registerCapability('cap.auth')
                                   ▼
┌────────────────────────── src/core（宿主，零插件引用） ──────────────────────────┐
│                                                                                │
│  main.tsx ──► externalPlugins.loadExternalPlugins ──► hostRuntime.registerPlugin│
│                                                        │ 检测 provides 含       │
│                                                        │ 'cap.auth' → 启用守卫  │
│  ┌───────────────────── CapBus（bus.ts）─────────────────▼──────────────────┐   │
│  │  dispatch(pluginId, declared, req):                                      │   │
│  │    1. assertAllowed（既有声明式 gate，不变）                               │   │
│  │    2. [新] userGuard：check('cap:cap.ai.chat[:action]')                   │   │
│  │       └─ 经 bus 调 cap.auth（target==='cap.auth' 豁免，防递归）            │   │
│  │    3. invoke handler（原逻辑不变）                                        │   │
│  └──────────────────────────────────────────────────────────────────────────┘   │
│                                                                                │
│  ┌── authGate.ts（新，宿主侧只读缓存 + hooks）─────────────────────────────┐    │
│  │  status/matrix 经总线拉取并缓存；监听 'auth-changed' 失效重取             │    │
│  │  useAuthStatus() / useSlotPermission(slot) / evaluate(permission)       │    │
│  └───────┬──────────────────────────────┬─────────────────────────────────┘    │
│          │                              │                                      │
│  ┌───────▼────────┐            ┌────────▼──────────────┐                        │
│  │ SlotLayout.tsx │            │ SlotOutlet.tsx        │                        │
│  │ 未登录 → 渲染    │            │ entries.filter(       │                        │
│  │ overlay 槽登录壳 │            │   slot:<slot>[:pid]   │                        │
│  │ （四槽壳仍在，    │            │ ) → 未授权槽位渲染     │                        │
│  │  内容置灰锁死）   │            │ 「无权限」或隐藏；      │                        │
│  └────────────────┘            │ panel Tab 头同步过滤   │                        │
│                                └───────────────────────┘                        │
└────────────────────────────────────────────────────────────────────────────────┘
          │                       │                      │
          ▼                       ▼                      ▼
   sidebar 槽（会话侧栏）    stream/input 槽（对话）   panel 槽（多面板 Tab）
   授权判定: slot:sidebar   授权判定: slot:stream,    授权判定: slot:panel:<pluginId>
             + cap:cap.ai.chat       slot:input           （Tab 级细粒度）
```

数据流时序（登录 → 矩阵生效）：

```
LoginPanel ──dispatch(cap.auth, login, {username,password})──► 权限插件
   ▲                                                            │ 校验凭据
   │◄──AuthStatus{authenticated:true, roles:['admin']}──────────┘
   │ emit('auth-changed')
   ▼
authGate（宿主缓存失效）──dispatch(cap.auth, matrix)──► 拉取新矩阵
   ▼
SlotOutlet 重渲染：按角色过滤四槽 + panel Tab；CapBus user-guard 同步按新矩阵裁决
```

---

## 3. cap.auth 契约完整定义

### 3.1 共享类型（新增 `src/core/authContract.ts`，宿主与插件共同引用的唯一契约源）

```ts
/** cap.auth 契约 —— P3 角色/权限矩阵路线（唯一权威：提供方插件；宿主只读消费） */

/** 当前登录身份（login/status 的返回体） */
export interface AuthStatus {
  authenticated: boolean;
  userId?: string;
  displayName?: string;
  /** 用户拥有的角色集合；矩阵判定的输入 */
  roles: string[];
  /** token 摘要（仅用于 UI 展示，禁止回传完整凭据） */
  tokenDigest?: string;
  /** 会话过期时间戳（ms）；undefined = 永不过期 */
  expiresAt?: number;
}

/** 登录凭据形态由插件自定义（账号密码 / SSO 票据 / LDAP DN …） */
export interface AuthLoginPayload {
  mode?: 'credentials' | 'redirect' | (string & {});
  [key: string]: unknown;
}

/** 登录结果：内联完成返回 status；SSO 类返回跳转指示 */
export type AuthLoginResult =
  | { mode: 'done'; status: AuthStatus }
  | { mode: 'redirect'; url: string }
  | { mode: 'challenge'; challenge: string }; // 如验证码/MFA，插件自定义

/** check(permission) 的判定结果 */
export interface AuthCheckResult {
  allowed: boolean;
  /** 拒绝原因，如 'role not in matrix' / 'anonymous' / 'denied by role:guest' */
  reason?: string;
}

/** 角色矩阵条目：某角色的授权集 */
export interface RoleMatrixEntry {
  role: string;
  /** 允许的 permission 串，支持通配符（见 3.3） */
  allow: string[];
  /** 显式拒绝，优先级高于所有 allow（含通配符） */
  deny?: string[];
}

/** 角色 → 权限矩阵（矩阵权威数据形态；check 即对该模型求值） */
export interface RoleMatrix {
  /** 未登录时生效的隐式角色，通常不给任何授权 */
  anonymousRole?: string;
  entries: RoleMatrixEntry[];
  /** 矩阵版本号，热更时递增，供缓存比对 */
  revision: number;
}

/** cap.auth 的动作与入参出参（对齐 CapRequest.action 约定） */
export interface CapAuthActions {
  status: (payload?: undefined) => AuthStatus;
  login: (payload: AuthLoginPayload) => AuthLoginResult;
  logout: (payload?: undefined) => { ok: true };
  check: (payload: { permission: string }) => AuthCheckResult;
  /** P3 扩展：返回当前矩阵（宿主 authGate 与管理面板的数据源） */
  matrix: (payload?: undefined) => RoleMatrix;
  /** P3 扩展（管理角色才可调）：写矩阵并广播 auth-changed */
  setMatrix: (payload: { matrix: RoleMatrix }) => { ok: true; revision: number };
}
```

### 3.2 插件侧声明（manifest 片段）

```ts
// plugins/auth-matrix/index.ts（示例实现）
export const authMatrixPlugin: LitePlugin = {
  manifest: {
    id: 'auth-matrix',
    name: '权限·角色矩阵',
    version: '0.1.0',
    provides: ['cap.auth'],                 // 提供方声明，registerCapability 时宿主校验
    capabilities: ['cap.config'],           // 矩阵持久化复用 config-manager（也可自带存储）
    events: [],                             // 插件向宿主 emit('auth-changed') 无需声明；listen 才需要
    contributes: {
      slots: [
        { slot: 'overlay', component: 'LoginPanel', order: 0 },      // 登录覆盖层
        { slot: 'panel',  component: 'MatrixAdmin', order: 90 },     // 可选：矩阵管理面板
      ],
    },
  },
  setup(api) { /* 注册 cap.auth handler；从 cap.config 恢复矩阵与会话 */ },
};
```

### 3.3 permission 命名规范（check(permission) 的 permission 字符串）

| 形态 | 示例 | 语义 |
|---|---|---|
| `slot:<slotId>` | `slot:sidebar`、`slot:stream`、`slot:input`、`slot:panel`、`slot:overlay` | 该槽位整体可见 |
| `slot:<slotId>:<pluginId>` | `slot:panel:cap-panel` | 槽位内某个插件贡献可见（panel Tab 级细粒度） |
| `cap:<capId>` | `cap:cap.ai.chat`、`cap:cap.config` | 允许经总线调用该 cap 的任意动作 |
| `cap:<capId>:<action>` | `cap:cap.ai.chat:start` | 动作级细分；命中即放行该动作 |
| 业务自定义域 | `chat:send`、`model:admin`、`auth:matrix:write` | 插件自定义命名空间，冒号分段，宿主不解释 |
| 通配符 | `slot:*`、`cap:cap.ai.*`、`*` | 段级通配；`*` 仅作整段匹配，不做跨段匹配 |

匹配算法（在 `src/core/authContract.ts` 内给出参考实现 `evaluatePermission`）：

```ts
/** 判定：先算角色并集 allow，再用 deny 剪枝（deny 优先级最高）；无角色=默认拒绝 */
export function evaluatePermission(matrix: RoleMatrix, roles: string[], permission: string): boolean {
  const match = (pattern: string) =>
    pattern === '*' || pattern.split(':').length === permission.split(':').length
      ? pattern.split(':').every((seg, i) => seg === '*' || seg === permission.split(':')[i])
      : false;
  const denied = matrix.entries
    .filter((e) => roles.includes(e.role))
    .some((e) => (e.deny ?? []).some(match));
  if (denied) return false;
  return matrix.entries
    .filter((e) => roles.includes(e.role))
    .some((e) => e.allow.some(match));
}
```

---

## 4. 宿主侧过滤逻辑改动点（文件级）

> 原则：所有改动都是「通用机制」，宿主源码不出现 `auth-matrix` 等具体插件 id；是否存在权限体系由 `provides` 是否含 `cap.auth` 动态决定。

| 文件 | 改动 | 说明 |
|---|---|---|
| `src/core/types.ts` | `SlotId` 扩为 `'sidebar' \| 'stream' \| 'input' \| 'panel' \| 'overlay'`；`SLOT_IDS` 同步补 `'overlay'` | overlay 是第 5 个逻辑槽，专用于全屏登录/门禁覆盖层；SlotOutlet 对任意 SlotId 通用，无需改 |
| `src/core/bus.ts` | 新增 `type UserGuard = (pluginId: string, req: CapRequest) => Promise<{allowed: boolean; reason?: string}>` 与 `setUserGuard(guard: UserGuard \| null)`；在 `dispatch` 与 `dispatchStream` 的 `assertAllowed` 之后、invoke 之前调用 guard（`req.target === 'cap.auth'` 豁免，防递归；`cap.meta` 描述类只读调用建议一并豁免） | L2 总线级用户权限裁决；guard 未设置时行为与现状完全一致（零侵入） |
| `src/core/hostRuntime.ts` | `registerPlugin` 内：当 `manifest.provides?.includes('cap.auth')` 时，组装 UserGuard（内部把 `check('cap:'+req.target[:action])` 转成一次 `bus.dispatch('__host__', ['cap.auth'], {target:'cap.auth', action:'check', payload:{permission}})`）并 `bus.setUserGuard(guard)`；重复注册/卸载时对称清理。另新增 `subscribeHostEvent(event, fn)` 公共方法（复用现有 `listeners` Map），供核心模块订阅插件 `emit` 的事件 | 宿主对「谁提供 cap.auth」不作假设，任何满足契约的插件加载即自动接线 |
| `src/core/authGate.ts` | **新增**。宿主侧只读缓存 + React hooks：`useAuthStatus()`、`useSlotPermission(slot)`（返回 `(pluginId) => boolean`）、`refreshAuth()`、`isAuthMode()`。内部经 `host.bus.dispatch`（内部调用方 `__host__`，不走 SlotHostApi）拉 `status`/`matrix`，用 `evaluatePermission` 本地求值；订阅 `auth-changed`（经 `host.subscribeHostEvent`）与 `visibilitychange` 触发失效重取；无 cap.auth 提供方时恒返回放行 | 宿主对矩阵只有只读缓存，权威永远在插件 |
| `src/core/SlotOutlet.tsx` | 渲染前过滤：`const allow = useSlotPermission(slot); const entries = host.slots.list(slot).filter(e => allow(e.pluginId));`。被过滤掉且同槽还有其他授权条目时直接不渲染；若整槽无授权条目且原本有注册条目，渲染占位 `<div className="slot slot-deny">无权限访问</div>`（占位开关由 authGate 策略位控制：`hide` 或 `hint`）。panel 多 Tab 场景先过滤 entries 再生成 Tab 头，并对 `activeIdx` 做越界收敛（当前 Tab 被收回权限时自动落到第一个可用 Tab） | 未授权槽位「不渲染或显示无权限提示」两种策略都支持 |
| `src/core/SlotLayout.tsx` | 引入 `const auth = useAuthStatus()`；`auth` 处于未登录且 authMode 时，在四槽壳外层追加 `<div className="shell-auth-overlay"><SlotOutlet slot="overlay"/></div>`，并通过既有 CSS 类给 `.shell-main/.shell-sidebar/.shell-panel` 加置灰锁定（`pointer-events:none; filter:blur(2px)`）。四槽壳本身仍渲染（满足 brief 硬性约束 2「四槽壳仍可渲染」） | 登录壳与四槽壳解耦：没有权限插件时该分支不生效，布局零变化 |
| `src/main.tsx` | 无需改动（authGate 在首次 `useAuthStatus` 调用时惰性初始化；如需预热可在 `loadExternalPlugins` 之后调用一次 `refreshAuth()`） | 启动链路保持不变 |
| `src/styles.css` | 新增 `.shell-auth-overlay`、`.slot-deny`、`.auth-locked` 等样式（用主题变量，不硬编码色值） | 覆盖层与无权限占位样式 |

关键点自查：SlotOutlet 的过滤数据来自 `authGate`（其数据经总线取自权限插件），不是从任何插件模块 import——满足「宿主零插件引用」；`slotRegistry.ts`、`externalPlugins.ts`、`sessionStore.ts`、`metaCapability.ts` 均无需改动。

---

## 5. 登录 UI 呈现方式

1. **贡献方式**：权限插件经既有 `contributes.slots` 机制向新增的 `overlay` 槽贡献 `LoginPanel` 组件——复用 SlotOutlet 的运行时组件注册表（`externalPlugins.registerPluginComponent`），宿主无需新增任何加载通道。
2. **呈现时机**：`SlotLayout` 根据 `useAuthStatus()` 判定；未登录时渲染全屏覆盖层（居中卡片），四槽内容置灰锁死但保留在 DOM 中（视觉上明确「壳在、门未开」）。
3. **LoginPanel 交互**（插件内实现）：
   - 读取 `cap.meta` 能力清单无关；仅依赖 `cap.auth`；
   - 表单提交 → `dispatch({target:'cap.auth', action:'login', payload:{mode:'credentials', username, password}})`；
   - 返回 `{mode:'done'}` → 触发 `refreshAuth()`，覆盖层随 `authenticated=true` 消失；
   - 返回 `{mode:'redirect'}` → `window.location.href = url`（SSO 跳转），回调页由插件路由处理后再 `refreshAuth()`；
   - 失败路径：展示 `error.message`，连续失败计数锁定（插件内策略），不向宿主抛未捕获异常。
4. **登出**：由插件可选地在 overlay/panel 里提供入口，调 `logout` 后同样经 `auth-changed` 驱动宿主重新过滤——此时所有槽位回到未授权态，覆盖层重新出现。

---

## 6. 替换场景：mock-auth ↔ 企业 SSO

两个插件实现同一 `cap.auth` 契约，宿主与业务插件零改动，仅切换 `public/plugins/registry.json` 的 `enabled`：

| | `plugins/auth-matrix/`（演示/mock） | `plugins/auth-sso/`（企业 SSO，替换件） |
|---|---|---|
| login | 任意非空账号可登录；`{username}` 里带的角色提示（如 `admin/guest`）直接映射角色 | OIDC/OAuth2 授权码流程：首次 login 返回 `{mode:'redirect', url}`，回调后以 code 换 token，解析 ID Token claims 中的角色/组映射为本地角色 |
| 矩阵来源 | 插件内置默认矩阵 + MatrixAdmin 面板本地编辑，经 `cap.config` 持久化到 localStorage | 远端策略服务（如内部权限平台）拉取矩阵，`setMatrix` 由策略同步任务调用；本地只缓存 |
| token | 内存 + sessionStorage 摘要（演示用） | 内存持有 access token，静默续期；`tokenDigest` 仅回传摘要 |
| status/logout | 本地会话即权威 | 以 token 有效性与 IdP 会话为准，logout 走 end_session |
| 切换方式 | registry.json 中 `enabled: true` | 同文件改为 `true`，同时 mock 条目置 `false` |

可替换性的契约保障：宿主仅依赖 3.1 的类型与 `provides:['cap.auth']` 声明；矩阵数据形态 `RoleMatrix` 由插件自定义内容（角色名、allow/deny 集合可完全不同），宿主 `evaluatePermission` 只认模型不认业务。

---

## 7. 边界与风险

1. **矩阵维护成本**：角色 × 槽位/能力组合随插件数量线性增长。缓解：通配符（`slot:*`、`cap:cap.ai.*`）压条目数；MatrixAdmin 面板可视化维护；`revision` + `auth-changed` 热更避免重启。矩阵膨胀到数百条时应转向远端策略引擎（SSO 版形态）。
2. **默认拒绝策略**：auth 模式下未匹配即拒绝。风险是「新插件上线即不可见」——新插件贡献的槽位需要矩阵显式授权。缓解：mock 矩阵给 `member` 角色 `slot:*` 兜底；文档要求新增插件时同步评估矩阵条目；`slot:overlay` 由宿主在未登录时强制放行（否则登录页本身不可见，形成死锁）。
3. **缓存与实时性**：宿主 authGate 缓存矩阵，权限回收后到下一次 `auth-changed`/轮询之间存在时间窗（L1 渲染层可能短暂多显示一个 Tab）。缓解：回收权限时插件必须广播 `auth-changed`（契约约定）；L2 总线 guard 每次调用实时判定（可加短 TTL 缓存，如 5s），保证敏感 cap 调用不被陈旧渲染态放行。
4. **递归与自锁**：guard 若对 `cap.auth` 自身也裁决会无限递归——已在 bus.ts 中对 `req.target === 'cap.auth'` 豁免；宿主内部调用使用合成调用方 `__host__`，不经过 SlotHostApi。
5. **前端校验非安全边界**：lite 版是进程内总线，浏览器端矩阵判定可被有心人绕过（与 Polaris 主仓「RouterBus 在宿主进程」不同）。本方案的 L2 guard 提升的是一致性与防误用；真正安全必须由 SSO 版把 check/matrix 放到可信服务端执行。文档与实现都须如实标注该边界。
6. **会话过期**：`expiresAt` 到期后 status 变未登录；authGate 在定时器/焦点事件里重查，避免「界面还在、调用全拒」的割裂体验。
7. **对既有 demo 的兼容**：不加载任何 cap.auth 插件时，guard 为 null、authGate 恒放行，现有 chat-lite/cap-panel 等行为零变化。

---

## 8. 实施步骤清单（文件级）

| 步骤 | 文件 | 动作 |
|---|---|---|
| 1 | `src/core/types.ts` | `SlotId` 增加 `'overlay'`，更新 `SLOT_IDS` |
| 2 | `src/core/authContract.ts` | 新建：3.1 全部类型 + `evaluatePermission` 参考实现（含通配符匹配） |
| 3 | `src/core/bus.ts` | 新增 `UserGuard` 类型、`setUserGuard`，在 `dispatch`/`dispatchStream` 接入（cap.auth 豁免） |
| 4 | `src/core/hostRuntime.ts` | `registerPlugin` 检测 `provides` 含 `cap.auth` 时装配 UserGuard；新增 `subscribeHostEvent` |
| 5 | `src/core/authGate.ts` | 新建：status/matrix 缓存、`useAuthStatus`、`useSlotPermission`、`refreshAuth`、`auth-changed` 订阅、open 模式旁路 |
| 6 | `src/core/SlotOutlet.tsx` | entries 按 `useSlotPermission(slot)` 过滤；`slot-deny` 占位；panel Tab 过滤与 activeIdx 收敛 |
| 7 | `src/core/SlotLayout.tsx` | 未登录渲染 `<SlotOutlet slot="overlay"/>` 覆盖层并锁定四槽内容 |
| 8 | `src/styles.css` | `.shell-auth-overlay`、`.slot-deny`、锁定态样式（主题变量） |
| 9 | `plugins/auth-matrix/index.ts` | 新建插件：manifest（provides `cap.auth`、contributes overlay+panel 槽）、setup 注册 handler、默认矩阵、cap.config 持久化 |
| 10 | `plugins/auth-matrix/LoginPanel.tsx` | 登录表单（credentials 模式）+ redirect 模式占位 |
| 11 | `plugins/auth-matrix/MatrixAdmin.tsx` | 可选：角色/allow/deny 编辑面板（仅 `auth:matrix:write` 授权角色可见可调 `setMatrix`） |
| 12 | `plugins/auth-matrix/vite.config.ts` | 仿 `plugins/chat-lite/vite.config.ts`（react 外部化，lib 模式出 plugin.js） |
| 13 | `plugins/build-plugins.mjs` | `plugins` 数组增加 `{ id: 'auth-matrix', config: 'auth-matrix/vite.config.ts', dist: 'auth-matrix/dist' }` |
| 14 | `public/plugins/registry.json` | 增加 `auth-matrix` 条目（enabled: true）；演示 SSO 切换时与 mock 互斥启用 |
| 15 | 验证 | `pnpm typecheck`（polaris-lite 根目录）+ 手工冒烟（见 §9）；不加载 auth-matrix 时回归现有四槽 demo |

---

## 9. 冒烟验证清单

1. 未加载权限插件：四槽 demo 与现状完全一致（回归确认）。
2. 加载 auth-matrix、未登录：四槽壳渲染但置灰，出现全屏 LoginPanel；总线层直接 dispatch `cap.ai.chat` 被 guard 拒绝。
3. 任意账号登录成功：覆盖层消失，按 `member` 角色矩阵显示 sidebar/stream/input 与授权 panel Tab；`slot:panel:model-admin` 未授权时该 Tab 不出现（或显示无权限占位，按策略位）。
4. 切换 `admin` 角色登录：MatrixAdmin 面板可见，修改矩阵并保存后 `auth-changed` 生效，另一浏览器标签页在下次 focus 时槽位可见性同步变化。
5. 登出：回到未登录态，覆盖层重现，所有业务槽位回到未授权。
6. registry.json 切换 mock↔SSO 条目（SSO 插件就位后）：宿主与业务插件代码零改动，登录流程切换生效。
