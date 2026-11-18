# P1 方案：壳层拦截（Shell Gate）

> 路线：宿主壳（SlotLayout）读取 `cap.auth` 的 status，未登录时不渲染业务槽位，改为渲染由权限插件贡献的登录视图；纯 headless 契约，宿主源码零插件引用。
> 对应总纲：`docs/auth-schemes/brief-auth.md`；基线事实：`docs/baseline.md`。
> 现状代码：`src/core/{hostRuntime.ts, bus.ts, SlotLayout.tsx, SlotOutlet.tsx, externalPlugins.ts, types.ts}`；插件形态参照 `plugins/config-manager/index.ts`、`plugins/model-admin/index.ts`。

---

## 1. 架构图（文字图）

```
┌────────────────────────────────────────────────────────────────────┐
│  宿主壳层（src/core，不含任何插件 import）                            │
│                                                                    │
│  main.tsx bootstrap                                                │
│    └─ await loadExternalPlugins('/plugins/registry.json')  ────────┼──┐
│    └─ render <SlotLayout/>                                 │       │  │
│                                                            │       │  │
│  SlotLayout.tsx                                            │       │  │
│    ├─ useAuthGate()  ── status 查询/订阅 ──┐                │       │  │
│    │    status='pending'    → <Splash/>   │                │       │  │
│    │    status='unauth'     → <SlotOutlet slot="auth"/>    │       │  │
│    │    status='auth'       → 四槽业务布局（sidebar/stream/input/panel）
│    │                                       │                │       │  │
│    └─ SlotOutlet slot="auth" ── 按 slotRegistry 渲染登录组件（运行时组件表）
│                                            │                │       │  │
└────────────────────────────────────────────┼────────────────┘       │  │
                                             │ cap.dispatch            │  │
                                             ▼                        │  │
                              ┌─────────────────────────┐            │  │
                              │  CapBus（进程内总线）      │            │  │
                              │  gate: manifest.capabilities 声明放行 │  │
                              │  audit: 审计链（meta 自省除外）        │  │
                              └───────────┬─────────────┘            │  │
                                          │ target='cap.auth'        │  │
                                          ▼                          │  │
                  ┌───────────────────────────────────────┐          │  │
                  │  权限插件（外部 ESM，动态加载）           │◄─────────┼──┘
                  │  mock-auth / sso-auth（可替换）          │ registry │
                  │  - setup(): registerCapability('cap.auth', handler)
                  │  - contributes.slots += {slot:'auth', component:'LoginForm'}
                  │  - 会话凭据自持（cap.config / sessionStorage）       │
                  │  - 状态变化 emit('auth-changed')                    │
                  └───────────────────────────────────────┘          │
```

要点：
- 壳层只认识 `cap.auth` 这个**契约 id**与 `auth` 这个**槽位名**，不认识任何插件实现；
- 权限插件是普通外部插件：registry.json 注册 → `loadExternalPlugins` 动态 import → `host.registerPlugin` → `setup` 里 `registerCapability.register('cap.auth', handler)`（`hostRuntime.ts:80-89` 的 provides 校验自动生效）；
- 登录 UI 走既有槽位机制：插件 manifest 声明 `contributes.slots: [{slot:'auth', component:'LoginForm'}]`，`SlotOutlet` 经 `getRuntimeComponent`（`externalPlugins.ts:32`）取组件渲染，宿主零引用。

## 2. cap.auth 契约完整定义

契约类型放 `src/core/types.ts`（总线层单源，壳层与插件共用类型，但运行时互不依赖）：

```ts
// ---------- cap.auth 契约（追加到 src/core/types.ts） ----------

/** 登录态 */
export type AuthStatus = 'authenticated' | 'unauthenticated';

/** 登录用户信息（脱敏视图，token 全文永不进壳层） */
export interface AuthUser {
  id: string;
  name: string;
  /** 角色标识，供 check(permission) 使用；具体语义由权限插件定义 */
  roles: string[];
}

/** status / login 成功后的统一返回 */
export interface AuthStatusResult {
  status: AuthStatus;
  user: AuthUser | null;
  /** token 摘要（如 'ab12…cd34'），仅用于展示，不可反推原文 */
  tokenDigest?: string;
  /** 凭据过期时间戳（ms）；缺省 = 会话期有效 */
  expiresAt?: number;
}

/** login 请求载荷：凭据形态由插件自定义（账号密码 / OAuth code / SSO ticket…） */
export interface AuthLoginPayload {
  /** 约定字段：登录方式，缺省 'password'；SSO 插件可用 'sso' | 'oauth' 等 */
  method?: string;
  /** 其余字段自由扩展；mock-auth 使用 { username, password } */
  [field: string]: unknown;
}

/** check 请求/响应 */
export interface AuthCheckPayload {
  /** 权限点，如 'panel.model-admin' | 'chat.send'；语义由权限插件定义 */
  permission: string;
  /** 可选上下文（如目标资源 id），插件按需解释 */
  context?: Record<string, unknown>;
}
export interface AuthCheckResult {
  allowed: boolean;
  /** 拒绝原因（审计/提示用），允许时可省略 */
  reason?: string;
}

/** logout 响应 */
export interface AuthLogoutResult {
  ok: true;
}

/** cap.auth 动作表（请求 → 响应） */
export interface AuthCapabilityContract {
  status: { payload: undefined; result: AuthStatusResult };
  login: { payload: AuthLoginPayload; result: AuthStatusResult };
  logout: { payload: undefined; result: AuthLogoutResult };
  check: { payload: AuthCheckPayload; result: AuthCheckResult };
}

/** 权限插件状态变化事件（经 SlotHostApi.emit，宿主事件总线广播） */
export type AuthChangedEvent = {
  source: string; // 插件自动附加
  payload: { status: AuthStatus };
};
```

调用侧统一走既有信封（`types.ts:39-49` 的 `CapRequest`/`CapResponse`）：

```ts
// status（壳层调用）
await host.bus.dispatch('core', ['cap.auth'], { target: 'cap.auth', action: 'status' });
// → CapResponse<AuthStatusResult>

// login（登录组件调用，组件在插件内部，用 SlotHostApi.dispatch）
api.dispatch<AuthStatusResult>({ target: 'cap.auth', action: 'login', payload: { username, password } });

// check（业务插件调用，需在自身 manifest.capabilities 声明 'cap.auth'）
api.dispatch<AuthCheckResult>({ target: 'cap.auth', action: 'check', payload: { permission: 'panel.model-admin' } });

// logout
api.dispatch<AuthLogoutResult>({ target: 'cap.auth', action: 'logout' });
```

失败语义（复用总线既有错误通道 `CapResponse.error`）：

| 场景 | 返回 |
|---|---|
| 凭据错误 | `{ ok:false, error:{ code:'AUTH_INVALID_CREDENTIALS', message:'用户名或密码错误' } }` |
| 未登录却调 check/login 之外的受限动作 | 由各 cap 自行拒绝；cap.auth 自身不抛 |
| token 过期后再查 status | 返回 `status:'unauthenticated'`（插件负责检测），并 emit `auth-changed` |
| 总线未注册 cap.auth（无权限插件） | `{ ok:false, error:{ code:'CAP_ERROR', message:'unknown cap: cap.auth' } }` → 壳层按 §4 降级策略处理 |

## 3. 宿主壳最小改动点（文件级）

| 文件 | 改动 | 说明 |
|---|---|---|
| `src/core/types.ts` | ① `SlotId` 扩为 `'sidebar' \| 'stream' \| 'input' \| 'panel' \| 'auth'`；② 追加 §2 全部契约类型；③ `SLOT_IDS` 保持四业务槽不变（`auth` 是门禁槽，不进四槽布局枚举） | 契约单源 |
| `src/core/hostRuntime.ts` | 新增公开方法 `subscribe(event, fn): () => void`：把 `this.listeners` 的读写开放给核心内部（现 `listeners` 是 private，`hostRuntime.ts:20`）。实现为 `runtime.listeners` 的 add/delete 包装，**不经过 manifest.events 校验**（调用方是核心自身，非插件） | 壳层订阅 `auth-changed` 用 |
| `src/core/useAuthGate.ts`（新建） | `export function useAuthGate(): { state: 'pending'\|'authenticated'\|'unauthenticated'\|'open-no-provider'; refresh(): void }`。逻辑：mount 时经 `host.bus.dispatch('core', ['cap.auth'], {action:'status'})` 查询；`host.subscribe('auth-changed', refresh)`；查询失败（unknown cap）→ `open-no-provider` | 壳层门禁 hook |
| `src/core/SlotLayout.tsx` | 组件头部接入 `const gate = useAuthGate()`；渲染分支：`pending` → 最小 Splash（纯壳内 div，无插件依赖）；`unauthenticated` → `<main className="shell-gate"><SlotOutlet slot="auth"/></main>`；`authenticated` / `open-no-provider` → 现有四槽布局原样 | 拦截点只有这一处 |
| `src/core/SlotOutlet.tsx` | 无逻辑改动；空态文案对 `slot==='auth'` 显示「未找到登录插件（registry.json 未启用 cap.auth 提供方）」 | 复用既有运行时组件表 |
| `src/main.tsx` | **不改**。`bootstrap` 已 `await loadExternalPlugins(...)` 后才 `createRoot`（`main.tsx:21-33`），这正好保证 SlotLayout 首次查询 status 时 cap.auth 必然已注册（见 §4 时序） | 零改动 |
| `src/core/externalPlugins.ts` | **不改**。`auth` 槽组件经既有 `registerPluginComponent/getRuntimeComponent` 通道解析 | 零改动 |

「宿主零插件引用」核对：
- 壳层新增代码只出现 `cap.auth`（字符串 cap id）、`auth`（字符串槽名）、`auth-changed`（字符串事件名）三个**契约常量**；
- 不新增任何 `import ... from 'plugins/...'`；组件解析走 `externalPlugins.ts` 既有运行时注册表；
- 建议把三个常量收敛到 `src/core/types.ts`（`export const CAP_AUTH='cap.auth'; export const SLOT_AUTH='auth'; export const EVENT_AUTH_CHANGED='auth-changed';`），避免魔法串散落。

## 4. 登录 UI 呈现与「等 status」时序

**呈现方式**：登录 UI 是权限插件贡献到 `auth` 门禁槽的普通组件（mock-auth 的 `LoginForm`）。未登录时 `SlotLayout` 不渲染四槽业务区，只渲染 `<SlotOutlet slot="auth"/>` 全屏视图；登录成功后插件 emit `auth-changed`，壳层重查 status 放行业务槽。若插件未贡献 `auth` 槽组件但 cap.auth 存在（纯 headless 插件），`SlotOutlet` 空态兜底提示 + 壳层提供「重试」按钮（调 `refresh()`）。

**时序问题（壳要等 status 才能渲染）的解法——三段式，不引入轮询**：

1. **装配期已保证提供方在场**：`main.tsx` 的 `bootstrap` 是 `await loadExternalPlugins(...)` 完成后才 `createRoot(<SlotLayout/>)`。因此 SlotLayout 首帧时，cap.auth handler 已注册完毕。这是现有启动链免费给到的保证，不需要改 main.tsx。
2. **首帧 pending 态**：`useAuthGate` 初始 `state='pending'`，SlotLayout 先渲染无依赖 Splash（品牌名 + 加载点）。status dispatch 是进程内总线调用（微秒级），用户几乎无感；即使插件 setup 里做了异步初始化（如读持久化会话），pending 也只覆盖到 status 返回为止。
3. **变更驱动刷新**：登录/登出/过期由插件 emit `auth-changed`，壳层 `refresh()` 重查 status。**不轮询**——总线审计链（`bus.ts:80-101`，ring 500）不会被 status 心跳淹没；`status` 也因此无需加入 `isReadonlySelfInspection` 豁免。

降级策略（`open-no-provider`）：registry.json 没启用任何 cap.auth 提供方时，dispatch 返回 `unknown cap`。此时壳层**默认放行**（fail-open）渲染四槽，并 `console.warn` 一条。理由：polaris-lite 是开发工作台，未装配权限插件时保持可用性优先；若部署方需要 fail-closed，可在 `useAuthGate` 顶部用一个常量开关切换（`const FAIL_OPEN_WITHOUT_PROVIDER = true`）。

## 5. 替换场景：mock-auth ↔ 企业 SSO

两个插件是**同一契约的两个实现**，切换只动 `plugins/relay-hosts.json` 不存在——实际开关在构建脚本与产物注册表：

- `plugins/build-plugins.mjs` 的 `plugins[]` 数组追加 `{ id:'mock-auth', ... }`、`{ id:'sso-auth', ... }` 两个构建项（产物落到 `public/plugins/<id>/plugin.js`）；
- 生成出的 `public/plugins/registry.json` 里，**同一时刻只 enable 一个** auth 插件（`enabled: true/false`）。总线 `register` 对重复 cap 直接抛 `cap.auth already registered`（`bus.ts:47`），即使误配双开也会立刻暴露，不会静默半接管；
- 演示：`mock-auth` enabled=true、`sso-auth` enabled=false；企业环境：反转即可，壳层与业务插件零改动。

```ts
// plugins/mock-auth/index.ts（新插件，形态对齐 config-manager）
export const mockAuthPlugin: LitePlugin = {
  manifest: {
    id: 'mock-auth',
    name: '演示登录',
    version: '0.1.0',
    capabilities: ['cap.config'],              // 可选：借 config-manager 持久化会话
    provides: ['cap.auth'],
    events: [],
    contributes: { slots: [{ slot: 'auth', component: 'LoginForm', order: 0 }] },
  },
  setup(api) {
    api.registerCapability.register('cap.auth', createAuthHandler(api));
  },
};
```

- mock-auth 的 handler：`login` 接受任意非空 `username` + 长度≥4 的 `password`，签发 `{ status:'authenticated', user:{ id, name: username, roles:['user'] }, tokenDigest, expiresAt }`；会话存 `sessionStorage`（刷新保持、关窗即失效）；`check` 对 `roles.includes('user')` 放行；登录成功 `emit('auth-changed',{status:'authenticated'})`。
- sso-auth（后续实施）：`login({method:'sso'})` 触发 OAuth 重定向/弹窗，回调后换取 token；token 只存插件作用域（建议 `sessionStorage` + 内存双份），status 返回 digest；`check` 走企业权限服务或本地解析的 role claim。壳层不感知差异。
- 业务插件（如 model-admin）若要按权限隐藏面板，在自身 manifest `capabilities` 追加 `'cap.auth'` 并在挂载时 `check({permission:'panel.model-admin'})`；不声明的插件不受影响（总线默认拒绝其 cap.auth 调用，但 P1 下业务插件可以完全不调 check）。

## 6. 边界与风险

1. **token 存哪**：token 全文只存在于权限插件作用域（`sessionStorage` 或经 cap.config 落 localStorage）。status/login 返回体只带 `tokenDigest`（掩码），壳层与业务插件拿不到原文。风险：localStorage 可被同源脚本读取——lite 是同窗口非沙箱加载（`externalPlugins.ts` Blob import），因此**约定**：真实 SSO 插件优先 `sessionStorage` + 尽快换取短时效凭据；P1 不承诺防恶意插件（那是沙箱化议题，超出本期）。
2. **过期处理**：插件在每次 status/check 时校验 `expiresAt`，过期则清会话、返回 `unauthenticated` 并 emit `auth-changed`；壳层收到后回到登录视图。不做壳层主动定时器轮询（避免审计噪声与无谓重渲染）；如需提前刷新，由 SSO 插件自己起 timer 并 emit 事件。
3. **并发 status 检查**：`useAuthGate` 内做 single-flight——同一时刻只保留一个在途 status dispatch，后续调用复用同一 Promise；并用递增 `querySeq` 丢弃迟到旧响应，防止「登出后旧的 authenticated 响应晚到覆盖新状态」。`refresh()` 强制发起新查询。
4. **重复注册**：两个 auth 插件同时 enabled → `bus.register` 抛错 → `loadExternalPlugins` 捕获记入 `failed`（`externalPlugins.ts:120-122`），壳层查 status 得 `unknown cap` → 走 `open-no-provider` 降级。表现为「登录插件加载失败」警告而非 UI 锁死。
5. **fail-open 残留风险**：`open-no-provider` 放行意味着「忘配权限插件 = 无鉴权」。文档须写明：生产/企业部署必须 enable 恰好一个 auth 插件，或将开关置为 fail-closed。
6. **纯前端门禁的边界**：壳层拦截只是 UX 层放行/拦截；真正的安全边界必须由各 cap 提供方在后端/服务侧校验凭据。P1 不解决「绕过 UI 直调 cap」的问题（lite 总线本就运行在可信同源页内）。
7. **审计**：status 仅在 mount 与 auth-changed 时调用，量级为个位数，不会触发 `bus.ts:155` 的 500 条 ring 覆盖问题；login/logout/check 照常入审计链，可事后追溯。

## 7. 实施步骤清单（文件级）

1. `src/core/types.ts`：扩展 `SlotId` 加 `'auth'`；追加 `CAP_AUTH`/`SLOT_AUTH`/`EVENT_AUTH_CHANGED` 常量与 §2 全部契约类型。
2. `src/core/hostRuntime.ts`：新增 `subscribe(event, fn)` 公开方法（核心内部订阅通道）。
3. `src/core/useAuthGate.ts`：新建门禁 hook（single-flight status 查询 + auth-changed 订阅 + fail-open 常量开关）。
4. `src/core/SlotLayout.tsx`：接入 `useAuthGate`；`pending` 渲染 Splash、`unauthenticated` 渲染 `<SlotOutlet slot="auth"/>`、其余渲染现有四槽。
5. `src/core/SlotOutlet.tsx`：`auth` 槽空态文案定制（提示未启用登录插件 + 重试按钮）。
6. `src/styles.css`：追加 `.shell-gate`（全屏居中）、`.shell-splash`、`.gate-retry` 样式，沿用主题 token，不硬编码色值。
7. `plugins/mock-auth/index.ts`：新插件（cap.auth handler + LoginForm 组件 + sessionStorage 会话 + auth-changed 广播）。
8. `plugins/mock-auth/vite.config.ts`：对齐 `plugins/config-manager/vite.config.ts` 的 lib 构建配置。
9. `plugins/build-plugins.mjs`：`plugins[]` 追加 mock-auth 构建项（后续再加 sso-auth）。
10. `public/plugins/registry.json`：由构建脚本再生成；确认仅 mock-auth 的 auth 提供方 `enabled:true`。
11. 业务插件可选适配：`plugins/model-admin/index.ts` manifest `capabilities` 追加 `'cap.auth'`，Panel 挂载时 `check({permission:'panel.model-admin'})` 控制渲染（不影响其他插件）。
12. 验证：`pnpm build && pnpm build-plugins`（或项目既有脚本）→ 打开宿主，冒烟断言：a) 未登录只见登录视图；b) 任意账号登录后四槽出现；c) 刷新页面会话保持；d) logout 回到登录视图；e) registry 关掉 mock-auth 后四槽直接放行且控制台有 warn；f) `tsc --noEmit` 通过。

## 8. 自评（对照评分维度）

- **A 目标符合度**：契约（§2）覆盖 status/login/logout/check 四动作；替换只动 registry enabled；壳层零插件引用，插件化程度高。
- **B 可实现性**：改动集中在一个 hook + 一处分支渲染 + 一个标准形态插件；启动时序由既有 `await loadExternalPlugins` 免费保证，无新基础设施。
- **C 体验与安全**：pending Splash 消除闪烁；token digest 不出插件；过期经 auth-changed 平滑回到登录；明确 fail-open 风险与开关。
- **D 侵入度**：核心改 4 个文件且均为小改；main.tsx、externalPlugins.ts、bus.ts 零改动。
