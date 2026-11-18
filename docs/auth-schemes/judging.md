# 权限验证插件方案评审（judging）

> 评审方式：两位评委（评委 A、评委 B）**独立评审**，互不影响打分；各自的评分与结论分别记录于本文件「评委 A」「评委 B」两节。
> 评分维度与权重（来自 `brief-auth.md`）：A 目标符合度 40% / B 具体可实现性 30% / C 体验与安全 20% / D 侵入度 10%，1-10 分、0.5 步进。
> 评委 B 视角：工程落地与体验安全。评审前已逐行核对 `src/core/{main.tsx, hostRuntime.ts, bus.ts, SlotLayout.tsx, SlotOutlet.tsx, externalPlugins.ts, types.ts}`、`src/styles.css`、`index.html`、`plugins/build-plugins.mjs`、`public/plugins/registry.json` 及 `plugins/config-manager` 现有插件形态。

---

## 评委 B（工程落地与体验安全视角）

### 通用核查结论（适用于三案）

- **启动时序主张属实**：`main.tsx:21-34` 的 `bootstrap` 先 `await loadExternalPlugins(...)`（内部逐个 `await registerPlugin` → `await setup()`）后才 `createRoot(<SlotLayout/>)`。因此「SlotLayout 首帧时 cap.auth handler 必已注册」（P1）与「setup 内同步挂覆盖层先于首帧」（P2）均成立，无需改启动链。
- **三案共同缺陷（实施时必须修正）**：三案的登录组件都经 `api.dispatch({target:'cap.auth', action:'login'})` 调用**自己提供**的能力，但 `bus.dispatch` 会先跑 `assertAllowed(pluginId, declared, target)`（`bus.ts:73-78,85`），而三案给 auth 插件自身声明的 `capabilities` 均未包含 `'cap.auth'`（P1 为 `['cap.config']`、P2 为 `[]`、P3 为 `['cap.config']`）→ 登录请求会被总线以 "not granted cap.auth" 拒绝。修法任选其一：auth 插件 manifest 的 `capabilities` 追加 `'cap.auth'`；或总线为「提供方调自身 cap」加豁免；或登录组件直接调用插件内本地 handler 不过总线。该缺陷不影响三案相对排序，但直接照抄会首跑即挂。
- **P1 小误**：`externalPlugins.ts` 是同源 URL 动态 `import`（`externalPlugins.ts:111`），不是「Blob import」；结论不变（同源非沙箱），仅表述不准。

### P1 壳层拦截（Shell Gate）

| 维度 | 得分 | 加权 |
|---|---|---|
| A 目标符合度（40%） | 9.0 | 3.60 |
| B 具体可实现性（30%） | 9.0 | 2.70 |
| C 体验与安全（20%） | 8.0 | 1.60 |
| D 侵入度（10%） | 9.0 | 0.90 |
| **加权总分** | | **8.80** |

**评语**：三案中唯一做到「行号级可核对」的方案——`hostRuntime.ts:20`（listeners private）、`bus.ts:47`（重复注册抛错）、`externalPlugins.ts:120-122`（failed 捕获）、`main.tsx:21-33`（启动时序）全部与源码一致；改动收敛为一个 hook + 一处渲染分支 + 一个标准形态插件，复用既有槽位机制承载登录 UI，`main.tsx`/`bus.ts`/`externalPlugins.ts` 零改动。single-flight + 递增 querySeq 丢弃迟到响应、fail-open 带常量开关、pending Splash，边界处理完整且克制。

**最大缺陷**：未登录时业务插件其实已全部完成 `setup()`（启动链无差别加载所有启用插件），P1 只是不渲染其槽位组件——总线层对未登录态的 cap 调用毫无约束，「壳层拦截」本质是纯渲染层门禁；且默认 fail-open（忘配插件即无鉴权），生产部署依赖文档纪律或手工切 fail-closed 开关。

### P2 覆盖层插件（Overlay Plugin）

| 维度 | 得分 | 加权 |
|---|---|---|
| A 目标符合度（40%） | 9.0 | 3.60 |
| B 具体可实现性（30%） | 8.0 | 2.40 |
| C 体验与安全（20%） | 8.5 | 1.70 |
| D 侵入度（10%） | 8.0 | 0.80 |
| **加权总分** | | **8.50** |

**评语**：对 `.slot { isolation:isolate; z-index:0 }`（`styles.css:124-130`）导致槽内内容盖不住抽屉（z=30/35/40）的分析准确，body 直挂 + 独立层叠域的解法正确；`acquire/release` 单持有者、`#root` 置 `inert` + `aria-hidden` 防聚焦穿透与程序化点击、fail-closed（校验失败/超时一律保持覆盖层）是三案中体验安全细节最扎实的；宿主新增的 `api.overlay` 是无权限语义的通用能力，架构上干净。

**最大缺陷**：拦截强度 = 插件可用性——插件加载/初始化失败时 `loadExternalPlugins` 仅记入 `failed` 并放行（fail-open），且四槽业务插件在覆盖层下仍处于已挂载状态（inert 只挡交互不卸载）；相比 P1 的「不渲染」与 P3 的「总线裁决」，覆盖层是三者中唯一「内容仍在 DOM 里、仅被视觉+inert 遮住」的方案，绕过面最大。另外新增 `index.html` 挂点 + `SlotHostApi.overlay` API 面，侵入度略高于 P1。

### P3 路由/角色矩阵（Role Matrix）

| 维度 | 得分 | 加权 |
|---|---|---|
| A 目标符合度（40%） | 8.5 | 3.40 |
| B 具体可实现性（30%） | 7.0 | 2.10 |
| C 体验与安全（20%） | 9.0 | 1.80 |
| D 侵入度（10%） | 6.5 | 0.65 |
| **加权总分** | | **7.95** |

**评语**：唯一在总线层（`bus.ts` 的 `dispatch`/`dispatchStream` 的 `assertAllowed` 之后、invoke 之前插入 UserGuard）做真实鉴权裁决的方案，堵住了「绕过 UI 直调 cap」的口子，C 维度最强；L1 渲染过滤 + L2 总线守卫的双层设计、cap.auth 豁免防递归、`__host__` 合成调用方、activeIdx 越界收敛等边界都考虑到了。但代价是改动面最大（bus/hostRuntime/authGate/SlotOutlet/SlotLayout 五处核心逻辑），且每次 cap 调用多一次异步 check 往返（热路径如流式对话需靠 TTL 缓存缓解）；矩阵模型 `matrix`/`setMatrix` 超出 brief 最低动作集，替换提供方（如纯 SSO）时也须实现矩阵语义，契约变重、可替换成本上升。

**最大缺陷**：为「细粒度权限」付出的复杂度与本需求（登录门禁 + 基础 check）不匹配——矩阵维护成本随插件数增长、默认拒绝导致新插件上线即不可见、缓存失效窗口内渲染态与总线态可能短暂不一致；对当前 lite 体量属于过度设计，且 `bus.ts` 是核心安全路径，在此埋入用户态裁决逻辑的风险敞口最大。

### 排名与冠军推荐

| 排名 | 方案 | 加权总分 |
|---|---|---|
| 1 | **P1 壳层拦截** | **8.80** |
| 2 | P2 覆盖层插件 | 8.50 |
| 3 | P3 路由/角色矩阵 | 7.95 |

**推荐冠军：P1（壳层拦截）。**

理由（工程落地与体验安全视角）：

1. **可直接开工**：改动点全部经源码核实成立，启动时序由既有 `await loadExternalPlugins` 免费保证，不需要任何新基础设施；一个 hook + 一处分支 + 一个标准插件即可交付，实施风险与回归面最小。
2. **契约与可替换性干净**：壳层只认 `cap.auth` / `auth` 槽 / `auth-changed` 三个契约常量，mock↔SSO 仅切 registry `enabled`，完全满足 brief 的硬性约束 1/3/4。
3. **失败路径最明确**：未登录不渲染业务槽（而非遮住）、无提供方时 fail-open 可一键切 fail-closed、双开被 `bus.register` 抛错暴露、迟到响应用 querySeq 丢弃——每种异常都有确定行为。
4. **吸收两案优点即可补强**：建议实施时采纳 P2 的 `inert`/`aria-hidden` 思路（登录视图期间锁定背景）与 P3 的「总线级 user-guard」作为后续增强项（先做渲染层门禁上线，再迭代总线裁决），即可在不牺牲落地速度的前提下补齐安全纵深。

---

---

## 评委 A（架构与可替换性视角）

> 评审前已逐行核对 `src/core/{main.tsx, hostRuntime.ts, bus.ts, SlotLayout.tsx, SlotOutlet.tsx, externalPlugins.ts, types.ts}`、`src/styles.css`（`.slot` 的 `isolation:isolate; z-index:0` 与移动端 z=30/35/40 层级）、`plugins/esm-shim.mjs`、`plugins/shared.plugin-config.ts`、`plugins/config-manager/index.ts`、`public/plugins/registry.json`。评审独立进行，未参考评委 B 打分。

### 通用核查结论（适用于三案）

- **启动时序主张属实**：`main.tsx` 的 `bootstrap` 先 `await loadExternalPlugins(...)`（内部逐个 `await registerPlugin` → `await setup()`）再 `createRoot(<SlotLayout/>)`。P1 的「首帧时 cap.auth 必已注册」与 P2 的「setup 内同步挂覆盖层先于首帧」均成立，无需改启动链。
- **三案共同缺陷（须修，不影响排序）**：三案的登录组件都经 `api.dispatch({target:'cap.auth', action:'login'})` 调用**自己提供**的能力，但 `bus.dispatch` 先跑 `assertAllowed(declared, target)`（`bus.ts:73-78`），而三案给 auth 插件自身声明的 `capabilities` 均不含 `'cap.auth'`（P1 `['cap.config']`、P2 `[]`、P3 `['cap.config']`）→ 登录请求会被总线以 "not granted cap.auth" 拒绝。修法：manifest `capabilities` 追加 `'cap.auth'`，或登录组件直调插件内本地 handler 不过总线。属实施细节，直接照抄会首跑即挂。
- **P2 补充发现（架构层遗漏）**：P2 让插件用 `createRoot(handle.container)` 自建 React 根，但当前插件体系的组件渲染契约是「插件导出组件、由宿主 SlotOutlet 挂载」；插件 bundle 的 `react-dom/client` 经 import map 指向 `plugins/esm-shim.mjs`，而该 shim 目前**只重导出 react 命名成员，未导出 `createRoot`**。P2 的实施清单（index.html/styles/types/hostRuntime 四处）未包含扩展 esm-shim 或改用其他挂载通道这一步，照清单直做会在运行时报「no export named createRoot」。

### P1 壳层拦截（Shell Gate）

| 维度 | 得分 | 加权 |
|---|---|---|
| A 目标符合度（40%） | 9.5 | 3.80 |
| B 具体可实现性（30%） | 9.0 | 2.70 |
| C 体验与安全（20%） | 8.0 | 1.60 |
| D 侵入度（10%） | 9.0 | 0.90 |
| **加权总分** | | **9.00** |

**评语**：三案中契约最干净的一个——cap.auth 类型、错误码表（AUTH_INVALID_CREDENTIALS 等）、三个契约常量（CAP_AUTH/SLOT_AUTH/EVENT_AUTH_CHANGED）单源收敛在 `types.ts`，壳层对权限体系的全部认知就是这三个字符串，替换 mock↔SSO 只动 registry `enabled`，完全命中 brief 的 P1 路线（「宿主壳读 status 决定是否放行渲染」本就是总纲给定的路线，未登录时整壳替换为登录视图不构成对硬性约束 2 的违背）。行号级主张（`hostRuntime.ts:20` private listeners、`bus.ts:47` 重复注册抛错、`externalPlugins.ts` failed 捕获、启动时序）经核对全部属实；改动收敛为一个 hook + 一处渲染分支 + 一个标准形态插件，`main.tsx`/`bus.ts`/`externalPlugins.ts` 零改动，侵入度最低。

**最大缺陷**：门禁只存在于渲染层——启动链会无差别执行所有业务插件的 `setup()`，未登录时总线对 cap 调用毫无用户态约束（可被其他插件绕过 UI 直调）；且默认 fail-open，忘配权限插件即等于无鉴权，生产部署依赖 `FAIL_OPEN_WITHOUT_PROVIDER` 开关或部署纪律兜底。

### P2 覆盖层插件（Overlay Plugin）

| 维度 | 得分 | 加权 |
|---|---|---|
| A 目标符合度（40%） | 9.0 | 3.60 |
| B 具体可实现性（30%） | 8.0 | 2.40 |
| C 体验与安全（20%） | 8.5 | 1.70 |
| D 侵入度（10%） | 8.0 | 0.80 |
| **加权总分** | | **8.50** |

**评语**：对 `.slot { isolation:isolate; z-index:0 }` 层叠陷阱的分析准确（槽内内容确实盖不住 z=30/35/40 的移动端抽屉），body 直挂 + 独立层叠域的解法正确。架构上最「插件自治」：拦截决策权完全在插件，宿主新增的 `api.overlay` 是无权限语义的通用挂载能力，宿主对「登录」零感知；契约类型完备且带 `AUTH_CHANGED_EVENT` 常量。`acquire` 单持有者 + `#root` 置 `inert`/`aria-hidden` 防聚焦穿透、校验失败/超时一律保持覆盖层（fail-closed）是三案中交互封锁与无障碍细节最扎实的。扣分点：引入「插件自建 React 根」这一宿主尚未支持的第二条渲染路径，esm-shim 需扩展 `createRoot` 导出而方案清单未列；`index.html` 挂点 + `SlotHostApi.overlay` 新 API 面使侵入度高于 P1。

**最大缺陷**：拦截强度 = 插件可用性——插件加载/初始化失败时 `loadExternalPlugins` 仅记入 `failed` 即放行（fail-open），且业务内容在覆盖层下仍处于已挂载状态（inert 只挡交互不卸载，数据仍在 DOM/内存），是三案中唯一「内容在场、仅被遮蔽」的方案，绕过面最大；叠加 esm-shim 遗漏，直接开工的摩擦高于表面评估。

### P3 路由/角色矩阵（Role Matrix）

| 维度 | 得分 | 加权 |
|---|---|---|
| A 目标符合度（40%） | 8.0 | 3.20 |
| B 具体可实现性（30%） | 7.0 | 2.10 |
| C 体验与安全（20%） | 9.0 | 1.80 |
| D 侵入度（10%） | 6.5 | 0.65 |
| **加权总分** | | **7.75** |

**评语**：唯一在总线层做真实用户态裁决的方案——在 `bus.ts` 的 `dispatch`/`dispatchStream` 的 `assertAllowed` 之后插入 UserGuard，堵住「绕过 UI 直调 cap」；cap.auth 豁免防递归、`__host__` 合成调用方、SlotOutlet 过滤 + panel Tab activeIdx 越界收敛等边界都考虑周全，C 维度最强。但从架构与可替换性视角，契约明显超重：`matrix`/`setMatrix`/`RoleMatrix` 超出 brief 最低动作集，任何替换提供方（包括纯 SSO）都被迫实现并维护矩阵语义，而宿主侧 `evaluatePermission` 又把矩阵求值算法固化在核心——「契约可替换」退化成「模型可替换、算法不可替换」；且每次 cap 调用多一次异步 check 往返，热路径（流式对话）需 TTL 缓存缓解。

**最大缺陷**：为「细粒度权限」付出的复杂度与本需求（登录门禁 + 基础 check）不匹配——改动横跨 bus（核心安全路径）、hostRuntime、authGate、SlotOutlet、SlotLayout 五处，矩阵条目随插件数增长、默认拒绝导致新插件上线即不可见、缓存窗口内渲染态与总线态可能短暂不一致；对 lite 体量属过度设计，且在总线这一最高信任路径埋入用户态逻辑的风险敞口最大。

### 排名与冠军推荐

| 排名 | 方案 | 加权总分 |
|---|---|---|
| 1 | **P1 壳层拦截** | **9.00** |
| 2 | P2 覆盖层插件 | 8.50 |
| 3 | P3 路由/角色矩阵 | 7.75 |

**推荐冠军：P1（壳层拦截）。**

理由（架构与可替换性视角）：

1. **契约即边界**：壳层与权限体系之间只有 `cap.auth` / `auth` 槽 / `auth-changed` 三个契约常量加一组 TS 类型，宿主源码零插件引用、零新 API 面；任何满足契约的插件（mock/SSO/LDAP）经 registry `enabled` 即插即换，是三案中对「可替换」这一核心目标执行得最纯粹的。
2. **架构侵入最小且方向正确**：核心只改 4 个文件且均为小改（1 个 hook + 1 处分支 + 常量/类型追加），不触碰 bus、启动链与插件加载器；权限作为「门禁槽」复用既有 SlotOutlet 运行时组件表，没有为登录另起第二条渲染/挂载通道。
3. **P2/P3 的优点可作为增量吸收**：实施时建议把 P2 的 `inert`/`aria-hidden` 交互封锁用于登录视图期间锁定背景，把 P3 的总线级 UserGuard 列为二期增强（先以渲染层门禁上线，再迭代安全纵深），即可在不牺牲契约简洁性与落地速度的前提下补齐 P1 的主要短板。
