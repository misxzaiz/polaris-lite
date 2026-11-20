# 内置浏览器插件方案（browser-lite）· 规划分析

> 需求：polaris-lite 提供内置浏览器能力，便于 AI 实施网上内容（搜索/阅读/交互）；支持**按 AI 会话关联浏览器标签**（多会话并行时互不踩踏）；可查看当前所有打开的浏览器标签。纯插件方案实现，宿主零改动。
> 日期：2026-11-20。前置事实全部实读自当前代码（polaris-lite HEAD `72b6eea`；参照物：Polaris-plugin 仓 `plugins/browser-desk` v0.1.0，已在 Polaris 主仓真机 E2E 验证）。
> 结论先行：**完全可行，且大部分引擎代码可从 browser-desk 移植**。lite 侧需要做三件适配：① MCP stdio 通道改为 `cap.tool.browser`（describe 协议）+ agent-loop 专用分支；② 常驻 service 改为 lite 的 server 半边（`createServerPart` 中间件内自管引擎，不再依赖 PluginServiceManager）；③ agentKey 直接复用 chat-lite 的 `sessionId`，绑定/路由/TTL 语义照搬 browser-desk（已在 Polaris 验证）。

---

## 0. 目标与边界

**目标**：
1. AI 可搜索网页、阅读正文、点击/填表/按键/滚动、截图、等待条件、监听页面事件——「实施网上内容」的最小闭环；
2. **会话级隔离**：每个 AI 会话（chat-lite `sessionId`）绑定自己的标签；A 会话的操作绝不落到 B 会话打开的标签上；
3. 用户可在 panel 槽看到当前所有打开的标签（标题/URL/归属会话），并可手动开关；
4. 纯插件（UI 半边 + server 半边），`src/`、`server/` 宿主目录零改动（`server-registry.mjs` + `grants.json` + `build-plugins.mjs` 清单各加一行属配置，非宿主代码）。

**不做**（边界）：
- 不做 MCP stdio（lite 无 MCP 体系，工具统一走 cap 总线 + describe 协议）；
- 不做 webview 内嵌页面渲染（lite 是纯 Web 宿主，无 Tauri WebView；页面呈现在**独立系统 Chrome 窗口**，面板用 screencast 内嵌实时画面做辅助显示——与 browser-desk 的裁定一致）；
- 不做圈选（marquee/region-select）、AI overlay、assert 校验、storage 直读（webview 时代语义，CDP 下由 evaluate 原生替代，browser-desk 已验证此取舍）；
- 不做多浏览器引擎（仅 Chrome/Edge，经 CDP；Firefox 不支持）；
- 不做网络请求体拦截抓取（仅摘要级 network 事件环）。

## 1. 现状关键事实（决定方案的约束）

| 事实 | 出处 | 影响 |
|---|---|---|
| lite 工具进 agent-loop 的唯一协议：`cap.tool.*` 提供 `describe` → ToolDescriptor；loop 按 `desc.cap` 分派 | `plugins/agent-loop/index.ts:127-140`（discoverTools）、`:160-168`（toolDefs 组装） | 浏览器工具必须提供 describe，工具名经 `cap.meta/list` 过滤 `cap.tool.*` 自动发现 |
| loop 的通用执行路径**只会** `dispatch({target: desc.cap, action:'exec', payload:{command,timeoutMs,sessionId,approved,cwd}})`，并把返回按 `{ok,stdout,stderr,exitCode}` 消费 | `agent-loop/index.ts:702-725` | 结构化返回（如搜索结果数组、截图 base64）走通用路径会被压扁成 `stdout=undefined`——**浏览器工具需要 loop 加专用分支**（先例：interactive/render/ledger 三个 special-case，`:610/:637/:677`） |
| special-case 分支是既有惯例，非破例 | interactive（免审批 ask）、render（免审批落盘）、ledger（动作语义透传） | browser 分支按同一模式加，风险可控；且 `files` 工具目前正因「无分支、被塞进 exec 通用路径、handler 无 exec action」而不可用（`file-browser/index.ts:97-143` 无 `case 'exec'`）——**browser 不能重蹈这个覆辙** |
| 服务端领域能力 = 插件 server 半边：`plugins/<id>/server.mjs` 导出 `createServerPart({dataDir,getSession,store,policy,verifyTempToken,tempTokens})` → connect 中间件；`server-registry.mjs` 登记 | `plugins/server-registry.mjs:20-24`、`server/host.mjs:32` | 浏览器引擎（spawn Chrome、CDP 长连接）放 server 半边，与 agent-bash spawn 同先例；**无 PluginServiceManager**，生命周期随宿主进程（dev=vite 中间件，prod=node server），启动/退出钩子需自行处理 |
| 宿主注入给 server 半边的只有 6 项平台能力，**没有端口注入** | `server/host.mjs:32` | 引擎不需要自己的 HTTP 端口——UI 半边与 server 半边同源（同进程内 fetch `/api/browser/*`，cookie 自动携带），**比 browser-desk 的「service 独立端口 + 三级发现」更简单**，三级端口自发现整个砍掉 |
| 插件 UI 半边不能 require 任何 node 模块/其它插件；只依赖 `@sdk`、react、zustand | `tests/arch.test.mjs:88-114` | 面板只走 `api.dispatch('cap.tool.browser')` + fetch 同源 `/api/browser/*` |
| 会话 id 形如 `s-<ts36>-<rand>`，由 chat-lite store 生成；发送时经 `start` payload 进 loop，loop 再放进每个工具调用的 `payload.sessionId` | `chat-lite/store.ts:216`、`chat-lite/index.ts:556-570`、`agent-loop/index.ts:705` | **agentKey := sessionId，零新增协议**——loop 现在就给每个工具调用带 sessionId，browser handler 拿到即可做绑定路由 |
| 多会话可并行流式（running Map 按 sessionId 分键；单会话内串行+队列） | `agent-loop/index.ts:76,344-353`；`chat-lite/ChatInput.tsx:117-120` | 并行会话各持 agentKey，绑定表天然按 key 隔离；同会话内工具调用串行（loop for 循环），无同 key 并发写冲突 |
| grants 是唯一授权事实源；manifest 申请 ⊆ grants 授权，构建期 fail-fast | `build-plugins.mjs:398-416`、`public/grants.json` | 新增 `cap.tool.browser` 须同步 agent-loop.capabilities 与 grants |
| 宿主可能公网穿透部署（120.79.164.155:9825） | `docs/agent-loop-analysis.md:174`、`docs/file-browser-analysis.md:16` | 浏览器是「AI 代开任意网页」的通道，须有 SSRF/敏感内网导航围栏 + `PLITE_BROWSER=0` 总开关 + 全量审计 |
| puppeteer-core 可在插件目录自带 node_modules（Node 从模块文件向上解析） | browser-desk 实测：service 启动时探测缺失则 `npm install --no-save` | lite 版直接 `plugins/browser-lite/node_modules` 自带，server.mjs 用 `createRequire(import.meta.url)` 加载 CJS 的 puppeteer-core |

## 2. 架构与方案比选

### 2.1 三个候选形态

| 方案 | 形态 | 优势 | 劣势 | 判定 |
|---|---|---|---|---|
| **A. server 半边内嵌引擎（选定）** | `server.mjs` 中间件内懒加载 puppeteer-core + 引擎核；UI 与 AI 都打同源 `/api/browser/*` | 零新端口、零服务发现；复用宿主 cookie 门禁/审计；与 agent-bash 同构；engine.js 可从 browser-desk 近乎原样移植（986 行，纯逻辑注入 puppeteer） | 引擎随宿主进程存活（vite 重启即冷启动，可接受）；中间件模型下长轮询需注意不阻塞其它请求 | ✅ |
| B. 复刻 browser-desk 的独立 service + 端口发现 | 独立 node 进程 + env/kv/扫描三级发现 | 与 Polaris 侧代码 100% 同构 | lite 无 PluginServiceManager/Supervisor，要自造进程托管；端口扫描在 lite 场景是多余复杂度；两套鉴权（service 无 cookie 门禁） | ❌ 过度设计 |
| C. 纯浏览器侧实现（CDP over WebSocket 由前端直连） | 面板/AI 直接连 Chrome DevTools WS | 无后端 | Chrome 不允许跨源 WS 直连调试端口；密钥/攻击面进浏览器；不可行 | ❌ |

### 2.2 总体架构

```
┌─ 浏览器（UI 半边）────────────────────────────────────────────┐
│ chat-lite 会话流          browser-lite Panel（panel 槽）      │
│  │ tool_calls: browser_*   │ 标签列表/搜索框/screencast/日志  │
│  ▼                         ▼                                  │
│ agent-loop ── dispatch cap.tool.browser {action,...} ──┐      │
│   （browser 专用分支：审批策略按 action 分级）          │      │
└────────────────────────────────────────────────────────┼──────┘
                                                         ▼
┌─ Node（server 半边 plugins/browser-lite/server.mjs）─────────┐
│ POST /api/browser/dispatch   {action, params, sessionId}     │
│   ├─ cookie/Bearer 门禁（同 file-browser 模式）              │
│   ├─ PLITE_BROWSER=0 总开关                                  │
│   ├─ 导航围栏（SSRF/敏感地址）+ 全量审计 browser-audit.log   │
│   └─ engine.js（移植自 browser-desk，注入 puppeteer）        │
│        ├─ Chrome 生命周期（launch/断连自愈）                 │
│        ├─ tab 池 + agentKey 绑定表（TTL 30min）              │
│        ├─ 每 tab 事件环（200 条）+ 等待器 + 下载跟踪         │
│        └─ screencast 帧缓存                                  │
└──────────────────────────────────────────────────────────────┘
          │ puppeteer-core (CDP)
          ▼
   系统 Chrome（headful，独立窗口；BROWSER_LITE_CHROME 可指定路径）
```

**关键点：一个 Chrome 实例服务所有会话**。隔离不靠多实例（多 Chrome 进程内存开销大、且「看当前有哪些标签」的需求反而要全局视图），靠 **tab 池 + agentKey 绑定表**——这正是 browser-desk 已验证的模型：

- `agentBinds: Map<agentKey, {tabId, lastUsedAt}>`：会话 → 标签绑定；
- AI 每次操作带 `agentKey`（=sessionId）：handler 先查绑定表，命中则路由到该标签；未绑定则按 action 语义（acquire 新建并绑定 / 其它动作报「请先 acquire」）；
- 30 分钟无活动自动解绑（防僵尸绑定占住标签）；标签被手动关闭时反查解绑；
- `mode: reuse|create|require_new`：reuse=复用绑定标签（默认）；create=总是新建标签；require_new=开独立窗口。多会话并行时各自 reuse 自己的标签，互不可见对方操作。

## 3. 契约定案

### 3.1 能力与工具面（cap.tool.browser，单 cap 多 action）

manifest 声明：

```ts
// plugins/browser-lite/index.ts
provides: ['cap.tool.browser'],
events: ['tool-registered', 'artifact.created'],
contributes: { slots: [{ slot: 'panel', component: 'BrowserPanel', order: 10, title: '浏览器' }] },
```

describe 描述（单工具 `browser`，动作在参数里，与 ledger 同构；避免 16 个工具撑爆 prompt 缓存——loop 的 tools 集合指纹按内容变化即全量 miss，`agent-loop/index.ts:144-155`）：

```ts
const DESCRIPTOR = {
  cap: 'cap.tool.browser',
  name: 'browser',
  description:
    '驱动系统 Chrome 浏览器：搜索网页、阅读正文、点击/填表/按键/滚动、截图、等待条件、查看打开的标签。' +
    '每个 AI 会话绑定自己的标签（acquire 后续操作自动路由，不会动到其他会话的标签）。' +
    '动作：acquire(打开/获取绑定标签) navigate(导航/搜索) search(结构化搜索) read(正文抽取) ' +
    'click/fill/press_key/scroll/find(交互) screenshot(截图) wait(等待条件) watch(页面事件) ' +
    'tabs(列出当前全部标签及归属会话) close(关标签) history(浏览历史)。' +
    '首次调用 acquire 获得本会话标签；之后所有动作缺省作用于该标签。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: '见 description；必填',
        enum: ['acquire','navigate','search','read','click','fill','press_key','scroll','find',
               'screenshot','wait','watch','tabs','close','history'] },
      url: { type: 'string', description: '目标 URL 或搜索词（acquire/navigate/read）' },
      query: { type: 'string', description: '搜索词（search/navigate）' },
      engine: { type: 'string', enum: ['bing','baidu','duckduckgo','google'] },
      limit: { type: 'number' },
      label: { type: 'string', description: '元素可见文本（click/fill）' },
      selector: { type: 'string', description: 'CSS 选择器（click/fill）' },
      index: { type: 'number', description: '候选序号（click）' },
      value: { type: 'string', description: '填入值（fill）' },
      keys: { type: 'string', description: '按键（press_key），如 Enter/Escape' },
      amount: { type: 'number', description: '滚动像素（scroll）' },
      direction: { type: 'string', enum: ['down','up'] },
      script: { type: 'string', description: '页内 JS（find 上下文/备用）' },
      fullPage: { type: 'boolean' },
      selector_wait: { type: 'string', description: 'wait：等待出现的 CSS' },
      urlPattern: { type: 'string', description: 'wait：URL 正则' },
      downloadComplete: { type: 'boolean', description: 'wait：等下载完成' },
      timeoutMs: { type: 'number', description: '默认 15000，上限 60000' },
      mode: { type: 'string', enum: ['reuse','create','require_new'], description: 'acquire 模式' },
      newWindow: { type: 'boolean' },
      tabId: { type: 'string', description: '显式指定标签（一般不用；缺省=本会话绑定标签）' },
      closeAll: { type: 'boolean', description: 'close：关闭全部标签' },
    },
    required: ['action'],
  },
  danger: 'write' as const,
};
```

**分拆说明**：相比 browser-desk 的 16 个 `desk_*` MCP 工具，这里收敛为**单工具 + action 枚举**。理由：① lite 的 describe 协议一个 cap 一个工具名（bash/files/interactive 先例）；② tools 数组每多一个条目都消耗 prompt 缓存前缀（`buildToolDefs` 指纹机制）；③ 模型对「单工具多 action」的适配已被 ledger 验证。

### 3.2 agent-loop 集成（第四个 special-case 分支）

在 `agent-loop/index.ts` 现有 `cap.tool.ledger` 分支之后新增（同构模式）：

```ts
// 浏览器（cap.tool.browser）：动作语义工具，不走 exec 通用路径——
// 返回是结构化结果（搜索数组/截图 base64/标签列表），且导航类操作需要服务端围栏与审计。
if (desc?.cap === 'cap.tool.browser') {
  let br: { ok?: boolean; error?: string; /* 各 action 的结构化载荷 */ };
  try {
    const args = safeBrowserArgs(call.arguments);   // 只透传白名单参数键
    const res = await hostApi.dispatch({
      target: 'cap.tool.browser',
      action: String(args.action ?? ''),
      payload: { ...args, sessionId },              // sessionId 即 agentKey
    });
    br = res.data ?? { ok: false, error: 'empty response' };
  } catch (err) { br = { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  // 喂回 shadow：截图走 artifact 通道（见 §6），其余 JSON 摘要
  ...
  continue;
}
```

- `safeBrowserArgs`：按白名单键透传（action/url/query/engine/limit/label/selector/index/value/keys/amount/direction/script/fullPage/selector_wait/urlPattern/downloadComplete/timeoutMs/mode/newWindow/tabId/closeAll），防参数注入面扩张（对齐 `safeArgs`/`safeLedgerArgs` 纪律）；
- manifest.capabilities += `'cap.tool.browser'`，grants 同步；
- system prompt 增补一句 browser 使用指引（何时用 search/read、会话绑定语义、不要用 evaluate 绕过交互工具）。

### 3.3 服务端 API（server.mjs 中间件）

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/browser/dispatch` | POST | `{action, ...params, sessionId}` → 引擎操作；cookie/Bearer 门禁 + PLITE_BROWSER 开关 + 导航围栏 + 审计 |
| `/api/browser/status` | GET | 引擎状态 + 全部标签（含归属会话摘要）+ 绑定表——面板 3s 轮询 |
| `/api/browser/screencast/:tabId` | GET | 最新帧（base64 JPEG + 设备尺寸 + seq），面板内嵌视图 250ms 轮询（browser-desk 同款） |

面板不直接认识引擎内部结构：UI 半边统一经 `api.dispatch('cap.tool.browser', {action:'tabs'|'screencast', ...})` 能力通道取数（面板与 AI 同走 cap，权限/审计一份）；仅 screencast 帧这种高频二进制走 HTTP 端点（cap 通道塞 base64 大帧会污染审计链）。

**引擎核（engine.js）从 browser-desk 移植清单**（986 行，注入式 puppeteer，纯逻辑可测）：
- 保留：Chrome 生命周期（launch/断连自愈/退出）、tab 池、`agentBinds` + `touchAgent/pruneAgentBinds`（30min TTL）、`resolveTab/resolveOrCreate/acquire`（reuse/create/require_new 语义）、事件环（每 tab 200 条：console/network/dialog/download/navigation/error）、等待器（selector/urlPattern/downloadComplete/dialog）、操作面（navigate/search/read/click/fill/pressKey/scroll/find/screenshot/evaluate/history/close）、下载跟踪（`Browser.downloadWillBegin/Progress`）、screencast 三件套、`withTabLock` 同 tab 串行化；
- 改动：`logger` 由注入改为轻量 stderr + `<dataDir>/browser-lite.log`；`findChromePath` 增加 `BROWSER_LITE_CHROME` env；puppeteer 装载改为 `createRequire(import.meta.url)('./node_modules/puppeteer-core')`（缺失时报错并给 `npm install` 指引，不做自动安装——lite 是源码形态，依赖装在插件目录即可）；
- 新增：`tabs` action（status 的子集，只回标签列表 + agentKey 归属摘要）、导航围栏钩子（§5）。

## 4. 会话绑定与隔离设计（核心需求）

### 4.1 绑定生命周期

```
会话A 首次调 browser 工具（任意 action）
  → handler: agentBinds 无 A → 自动 acquire（mode=reuse，开 about:blank 或 url）→ 绑定 A↔tab1
会话A 后续调用 → resolveTab({agentKey:A}) → 命中 tab1 → 操作路由到 tab1
会话B 调用 → agentBinds 无 B → 新建 tab2 → 绑定 B↔tab2   ← 与 A 的 tab1 完全隔离
会话A 30min 无活动 → pruneAgentBinds 解绑（标签保留，变回「无主」标签）
用户在面板关掉 tab1 → 反查 agentBinds 删除 A 的绑定 → A 下次调用重新 acquire 新标签
会话A 调 acquire{mode:'require_new'} → 强制开新窗口标签并**改绑** A→新标签
```

- **隔离保证**：除 `tabs`（只读列表）外，一切操作必须经 `resolveTab`，而 `resolveTab` 只会返回「显式 tabId（仅限本会话绑定过的）或本会话 agentKey 绑定标签」——A 会话的 tabId 参数传 B 的标签时，handler 校验 `tabs.get(tabId).agentKey === A`，不匹配直接拒绝（browser-desk 现状是「显式 tabId 优先」，lite 版收紧为「显式 tabId 也要归属校验」，这是对「避免一个 AI 操作另一个 AI 的标签」需求的直接回应）；
- **透明性**：模型无需理解绑定机制——所有工具参数里没有 agentKey（loop 注入 sessionId），descriptor 里说明「本会话绑定标签」即可；
- **TTL 语义**：30min 无活动解绑只解除「归属关系」，不杀标签——用户手动浏览的标签不受影响；重新活动时若标签还在则重新绑定（`resolveOrCreate` 已处理）。

### 4.2 多会话并行与时序

- 同会话内：loop 的工具执行是 for 串行 + `withTabLock` 同 tab 互斥，无并发写冲突；
- 跨会话并行：不同 tabId，CDP 天然按 target 隔离；引擎级共享状态只有 tab 池 Map 与 Chrome 进程本身；
- 会话中断（用户点停止）：loop interrupt 只杀引擎流与在途 exec，**不关浏览器标签**（任务中断 ≠ 放弃已打开的页面；下次续聊仍可复用绑定标签继续操作）；
- 宿主重启/刷新：server 半边随进程重建，绑定表是内存态会丢失，但 Chrome 若还活着（prod 常驻形态）会出现「标签在、绑定丢」——处理：引擎重建时 `browser.pages()` 全量重新建档（browser-desk 的 `ensureBrowser` 已有此逻辑），绑定表置空，各会话下次调用重新 acquire 时优先复用「无主空白标签」再新建。

## 5. 安全模型

1. **门禁**：`/api/browser/*` 全部走 `getSession`（cookie）或 `verifyTempToken`（本地回环 Bearer，二选一，file-browser 同款）；`PLITE_BROWSER=0` 一键整体禁用（公网穿透形态建议默认关）；
2. **导航围栏（lite 新增，browser-desk 没有——因为 Polaris 是本机桌面应用，lite 可能公网部署）**：`navigate/acquire/read(url)` 前解析目标 host：
   - 拒绝纯 IP 私有/环回/链路本地段（10/8、172.16/12、192.168/16、127/8、169.254/16、::1、fe80::/10）与 `.localhost/.local/.internal` 后缀——防 AI 被诱导探测内网/云元数据端点；
   - 拒绝非 http(s) scheme（file:/、data:/、chrome-devtools:/ 等）；
   - 环回白名单开关 `BROWSER_LITE_ALLOW_LOOPBACK=1` 仅供本机开发联调（与 upstream-policy 的 `allowPrivate` 同思路）；
   - 如实声明：浏览器最终由用户可见的 Chrome 渲染，用户自己可以在地址栏去任何地方；围栏只约束 **AI 的导航动作**，不约束面板里的手动打开；
3. **审计**：每次 dispatch 落一行 `<dataDir>/browser-audit.log`（ts、sessionId、action、url/tabId、verdict、耗时）——「哪个 AI 动了哪个网页」可回溯；
4. **evaluate 逃生舱**：保留（AI 排障必需），但受上述门禁与审计约束，且 descriptor 里标注「谨慎使用」；不做 JS 白名单（静态分析 JS 语义不可行，如实声明）；
5. **截图/读回的体积**：screenshot JPEG base64 默认 quality 60 / 最长边 1280（browser-desk 同款），read 正文截断——防止超大返回撑爆 shadow transcript 与 localStorage（chat-lite 1.5MB 全库额度）；
6. **Chrome 凭据边界**：引擎用**独立 user-data-dir**（`<dataDir>/browser-lite-profile`），不用用户日常 Chrome 配置文件——AI 的 cookie/登录态与用户真实身份隔离，也避免污染用户会话。

## 6. 截图与对话呈现（artifact 通道）

截图返回 base64，直接塞 shadow transcript 会浪费 token 且不可见。复用 html-preview 建立的 artifact 泛型机制：

- handler 的 `screenshot` action 把帧落盘 `<dataDir>/browser-shots/<uuid>.jpg`（配额 50 张，mtime 淘汰），返回 `{shotId, url}`；
- UI 半边 emit `artifact.created {rendererType:'browser-lite-shot', callId:shotId, title:'浏览器截图', data:{url, tabId, pageUrl}, sessionId, messageId}` → chat-lite 通用 artifact 块渲染（零 chat-lite 改动）；
- 渲染器 `ShotCard`：图片 + 页面 URL + 「在新窗口打开」；登记进 `__PLITE_ARTIFACT_RENDERERS__`（html-preview 同款，chat-lite 只认契约）；
- shadow 喂回文案：`[截图已生成] shotId=... url=...（用户可在对话卡片中查看）`。

## 7. 面板（panel 槽）

- **标签列表**：全部标签（含无主标签），行 = favicon 色块 + 标题 + URL + 归属会话徽章（agentKey 前 6 位；无主显示「—」）+ 激活/关闭按钮；当前选中标签高亮；
- **搜索框**：手动发起搜索（结果列表可点击打开）——人也能用这个浏览器；
- **打开 URL**：地址栏回车 = 手动 navigate（不受 AI 导航围栏限制，但记录审计）；
- **内嵌实时画面**（screencast）：选中标签可展开 250ms 轮询帧视图，支持鼠标/键盘回传（坐标按帧尺寸等比映射，browser-desk EmbeddedView 同款移植）；默认收起，避免 320px 面板常驻高刷新；
- **AI 操作日志**：最近 50 条 AI 动作（经 cap 审计尾部过滤 `target=cap.tool.browser`，或引擎事件环）；
- **引擎徽章**：ready/starting/stopped + Chrome 缺失时的安装引导（`BROWSER_LITE_CHROME` env 说明）；
- 刷新纪律：3s 轮询且仅 `document.visibilityState === 'visible'` 时刷新（cap-panel 5s 同款），后台 tab 不空转。

## 8. 权限面（grants 增量）

```json
// public/grants.json
"browser-lite": {
  "capabilities": [],
  "provides": ["cap.tool.browser"],
  "events": ["tool-registered", "artifact.created"]
}
// agent-loop.capabilities += "cap.tool.browser"（manifest 与 grants 双侧）
// chat-lite.events += "artifact.created"？——不需要，已有。
```

`build-plugins.mjs` 清单加 `{ id: 'browser-lite', config: 'browser-lite/vite.config.ts', dist: 'browser-lite/dist', order: 16 }`；`server-registry.mjs` 加 `{ id: 'browser-lite', entry: './browser-lite/server.mjs' }`。构建期自动校验：requires 覆盖（loop 依赖 cap.tool.browser？不——browser-lite 不声明 requires，loop 对 browser 是软依赖：未启用时工具不出现，不影响其它工具）、grants 双向一致、order 唯一（panel 槽现用 1-9，取 10）。

## 9. 实施分期

| 期 | 交付 | 量化 |
|---|---|---|
| P1 | server.mjs + engine.js 移植（Chrome 生命周期/tab 池/agentKey 绑定/事件环/等待器/操作面/围栏/审计）+ 单测（stub puppeteer，移植 browser-desk test/unit.mjs 的 11 项并补归属校验负例） | 服务端 ~1100 行 |
| P2 | UI 半边：manifest + describe + cap handler（dispatch 转发 /api/browser）+ tool-registered；agent-loop browser 分支 + safeBrowserArgs + system prompt 增补 | 插件 UI ~200 行 + loop ~60 行 |
| P3 | 面板（标签列表/搜索/打开 URL/日志/徽章）+ screencast 内嵌 + 截图 artifact 通道（ShotCard） | ~500 行 |
| P4 | 验收打磨：公网开关默认值、审计面板联动、E2E（CDP 探针，tests/_cdp-*.mjs 同款不入库） | — |

**宿主改动：零**（三处配置清单各一行，均非 `src/`、`server/` 代码）。

## 10. 验收

1. `npx tsc --noEmit` + `tsc -p tsconfig.plugins.json` 全绿；`node plugins/build-plugins.mjs --check` 通过（16 插件）；
2. `npm test` 全量绿 + 新增 `tests/browser-engine.test.mjs`（stub 注入）：acquire reuse/create/require_new、agentKey 路由、**跨会话 tabId 归属校验拒绝**、TTL 解绑、事件环容量、等待超时、导航围栏（私有 IP/非 http scheme 拒绝）；
3. server-boundary/arch 纪律：server.mjs 只依赖 `node:*` + 自身相对路径 + 插件目录内 puppeteer-core；无 `@/`、无同级插件 import；
4. 真机冒烟（本机 Chrome）：会话 A `acquire(bing)→search→read`；同时会话 B `acquire(baidu)`；断言 A 的后续 click 落在 A 标签、B 落在 B 标签（tabId 不同）；`tabs` 列出两个标签及归属；面板可见两行；`close(all)` 后绑定清空；
5. 安全冒烟：无 cookie 调 `/api/browser/dispatch` → 401；`navigate(url='http://169.254.169.254/')` → 拒绝 + 审计行；`PLITE_BROWSER=0` 时全部 404/禁用提示；
6. E2E 后数据根恢复纪律照旧（审计日志留存属正常产物）。

## 11. 决策记录（已定案）

| 决策 | 结论 | 理由 |
|---|---|---|
| 形态 | server 半边内嵌引擎（方案 A） | 零端口/零服务发现/同源 cookie 门禁；browser-desk 的独立 service 是为 Polaris Supervisor 生态设计，lite 无此设施 |
| 工具面 | 单工具 `browser` + action 枚举 | describe 协议一 cap 一工具惯例；tools 集合指纹缓存友好；ledger 先例 |
| agentKey | 直接用 chat-lite sessionId | loop 已在每个工具调用 payload 注入 sessionId，零新增协议；「会话绑定」语义与需求逐字对应 |
| 隔离强度 | 显式 tabId 也做归属校验（比 browser-desk 更严） | 需求核心是「避免一个 AI 操作另一个 AI 的标签」；宽松的「显式 tabId 优先」会绕过绑定 |
| Chrome 实例 | 单实例多标签 + 独立 user-data-dir | 全局标签视图是需求（「看当前有哪些打开的浏览器」）；独立 profile 隔离 AI 与用户登录态 |
| 页面呈现 | 独立 Chrome 窗口 + 面板 screencast 内嵌 | browser-desk 已验证裁定；lite 无 webview 容器 |
| 审批策略 | acquire/navigate/search/read/tabs/history/watch 免审批（read 级）；click/fill/press_key/scroll/find/screenshot/wait/evaluate 走既有 confirm/allowlist/yolo 审批链 | 搜索阅读是低危高频；页内交互/JS 执行是写级操作。危险档位复用服务端 tool-exec.json 的 mode 裁决（同 engine 一份配置） |
| 引擎依赖 | puppeteer-core 随插件目录安装，不自动 npm install | lite 是源码形态；自动安装 88MB 依赖在公网形态不可接受，缺失时面板给明确指引 |

## 12. 风险与未决

| 风险/未决 | 说明 | 缓解 |
|---|---|---|
| **files 工具的 exec 缺口**（调研发现） | `cap.tool.fs` 无 `exec` action，但 loop 通用路径以 `action:'exec'` 派发——files 工具在 loop 中实际不可用（恒返回 unknown action） | 本插件用专用分支规避；建议另行修复 files（补 `case 'exec'` 路由到 list/read 或改 loop 对 read 级工具的派发） |
| vite dev 重启丢绑定 | dev 形态 server 中间件随 vite 重建，Chrome 进程被遗弃成孤儿 | 退出钩子尽量 `browser.close()`；孤儿 Chrome 有独立 profile 不污染用户数据，用户可手动关；prod 形态无此问题 |
| 中间件长轮询占用 | `watch`（25s 挂起）/`wait`（≤60s 挂起）在 connect 中间件里挂住请求 | lite 无高并发面（单用户/少数会话）；给 watch/wait 设并发上限（如 4），超限立即返回 busy |
| screencast 带宽 | 250ms 轮询 base64 JPEG 在多标签同开时可观 | 默认收起、仅选中标签开流；面板不可见时停轮询；帧尺寸上限 1280 |
| prompt 缓存 | tools 集合新增 browser 条目会使既有会话首轮缓存 miss 一次 | 一次性成本；toolDefs 指纹机制已把影响限于一轮 |
| 模型误用 evaluate | AI 可能倾向 evaluate 绕过交互工具 | descriptor 与 system prompt 明示「优先结构化交互工具」；审计可回溯 |
| 公网默认值 | 浏览器能力在公网部署的默认开关与围栏档位 | P4 前需用户拍板：建议公网默认 `PLITE_BROWSER=0`，本机开发默认开 |

---

## 附：与 browser-desk（Polaris 版）的差异清单

| 项 | browser-desk（Polaris） | browser-lite（本方案） |
|---|---|---|
| 宿主 | Tauri 桌面 + PluginServiceManager/Supervisor | 纯 Web，server 半边中间件 |
| AI 通道 | MCP stdio（16 个 desk_* 工具）+ 三级端口自发现 | cap.tool.browser 单工具多 action，同源 fetch |
| 面板→引擎 | cap.pluginServiceManager.request 转发独立端口 | 同源 /api/browser/*（cookie 门禁） |
| 会话标识 | agentKey 由 MCP 调用方显式传参 | sessionId 由 agent-loop 自动注入（模型无感） |
| tabId 归属校验 | 显式 tabId 优先（无归属校验） | 显式 tabId 也须属当前会话 |
| 导航围栏 | 无（本机桌面应用） | 私有/环回地址 + scheme 围栏（公网形态） |
| 引擎核 | engine.js 986 行 | 移植 + 围栏/tabs/独立 profile 改动 |
| puppeteer 装载 | 运行时自动 npm install | 插件目录预装，缺失报错指引 |
