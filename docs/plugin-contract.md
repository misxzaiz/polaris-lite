# 插件契约（Plugin Contract）

这份文档回答一个问题：**插件能做什么、不能做什么、越界了会在哪里被拦下。**

它存在的理由是项目的一条硬经验：约束的失效是渐进且无声的。先在核心 import 一个插件常量，再在插件里引用宿主 store，最后核心与插件又长回一块。等功能堆积起来再拆，成本是重做。所以规则必须先写下来，再由构建与测试强制执行——不能只靠自觉。

> 三条执行层：**构建期**（`npm run check:plugins`，违规直接中止）、**测试期**（`npm test`）、**运行时**（`resolvePolicy` + `CapBus` 拒绝）。文档里每条约束都标了执行层。

---

## 一、三层边界

```
┌─ 宿主壳层：不可改 ──────────────────────────────────┐
│  工作区树渲染器 / 分隔条 / 抽屉 / 键盘 / aria / 令牌 │
│  ┌─ 布局契约层：只能声明 ────────────────────────┐  │
│  │  contributes.views[] = viewType/component/    │  │
│  │                        title/defaultAnchor    │  │
│  │  运行时经 cap.ui.layout 提申请（可被拒/被审计）│  │
│  │  ┌─ 槽位契约层（存量）：只能声明 ──────────┐  │  │
│  │  │  contributes.slots[] = slot/component/  │  │  │
│  │  │                        order/title      │  │  │
│  │  │  ┌─ 插件内容层：完全自由 ────────────┐  │  │  │
│  │  │  │ 组件内部 DOM/CSS/二级 tab/图表     │  │  │  │
│  │  │  └────────────────────────────────────┘  │  │  │
│  │  └──────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

两层契约**并存**，不是替代关系：`slots` 回答「填哪个固定位置」（存量插件全在这层，零改动），
`views` 回答「我有哪些可被摆放的界面」（布局树里的叶子）。一个插件可以同时用两层。

- **越往外层，一致性收益越大、插件自由度越小**。
- 插件不是「不能自由」，而是「在自己的容器内无限自由，在共享区域必须协商」。
- 一份插件 CSS 出问题只应该坏它自己那一块；如果它能改掉宿主的 tab 栏，那就是契约失效。

---

## 二、槽位贡献

```ts
contributes: {
  slots: [
    { slot: 'panel', component: 'MyPanel', order: 3, title: '模型' },
  ],
}
```

| 字段 | 必填 | 约束 | 执行层 |
|---|---|---|---|
| `slot` | 是 | `sidebar` / `stream` / `input` / `panel` / `auth` | 构建期 |
| `component` | 是 | 插件模块里的导出名 | 构建期 |
| `order` | 建议 | **同一槽位内必须唯一** | 构建期 |
| `title` | panel 槽必填 | tab 文本，**建议 ≤ 4 字** | 构建期 |

**为什么 order 必须唯一**：并列 order 时顺序取决于插件加载时序（registry 顺序 + 依赖拓扑序），表现为「tab 顺序偶尔变化」。这是最难复现的一类问题，所以直接禁止，而不是靠稳定排序兜底。

**为什么 panel 槽必须给 title**：缺省回退 `manifest.name`，长度不可控。面板 320px、tabbar 内宽约 296px，4 个 tab 时每格只剩 74px——超过 4 字必然被 `ellipsis` 截断。`manifest.name` 表达的是「插件是谁」（开发者视角），`title` 表达的是「这块 UI 是什么」（用户视角），两者不要混用。

**auth 槽是特例**：它是门禁保留路径，不参与多面板 tab 体系，未登录时全屏渲染，且不在工作区树内。不要把登录组件当成普通视图。

### 视图贡献（新契约）

```ts
contributes: {
  views: [
    { viewType: 'my-plugin.gantt', component: 'GanttView', title: '甘特', defaultAnchor: 'stream' },
  ],
}
```

| 字段 | 必填 | 约束 | 执行层 |
|---|---|---|---|
| `viewType` | 是 | **必须以 `<pluginId>.` 开头**，只允许小写字母数字与 `. _ -`，全局唯一 | 构建期 + 运行时 |
| `component` | 是 | **入口文件里必须真的导出这个名字** | 构建期（`isExported`）+ 运行时红框 |
| `title` | 是 | tab 文本与可访问名，建议 ≤ 4 字 | 构建期 |
| `defaultAnchor` | 否 | `sidebar` / `stream` / `input` / `panel`，缺省 `panel` | 构建期 |

三条门禁各自对应一类真实事故：

- **前缀**：两个插件都声明 `chat` 时，后注册者被静默拒绝，用户看到「插件装了但视图打不开」；
- **唯一性**：同上，且更难查——注册表按 viewType 去重，重复项连告警都不明显；
- **组件导出**：声明了却忘了 `export`，运行时只得到「插件 X 未导出组件 Y」红框，**而布局已经把这个 viewType 持久化进用户的树里了**，下次启动继续红框，自救方式是清 localStorage。

**为什么 title 必填**：没有名字的视图无法拥有可访问名，读屏用户只会听到一串 `my-plugin.gantt`。

### 宿主槽位视图（`host.slot.<anchor>`）

四个锚点原有的槽位内容，也注册成了视图类型：

| viewType | 内容 | 关闭按钮 |
|---|---|---|
| `host.slot.sidebar` | 侧栏槽位的插件面板 | 无（结构视图） |
| `host.slot.stream` | 主区槽位的插件面板 | 无 |
| `host.slot.input` | 输入区槽位的插件面板 | 无 |
| `host.slot.panel` | 面板槽位的插件面板（能力/模型/账号…） | 无 |

存在的理由只有一个：锚点的渲染规则是「有 `children` 就渲染 `children`」，所以预设一旦给面板
写了子节点，面板里原有的 4 个槽位面板就整片消失。有了这四个类型，预设才能写
「我的视图和原有面板共处一个 tab 条」：

```js
{ kind: 'tabs', id: 'panel-tabs', active: 'p1', children: [
  { kind: 'view', id: 'p0', viewType: 'host.slot.panel' },
  { kind: 'view', id: 'p1', viewType: 'my-plugin.gantt' },
]}
```

`host.` 是**保留命名空间**，插件不得占用（构建期拦截）。`host.slot.*` 也不能经 `open`/`split`
开第二份——同一个槽位挂两次会得到两个互不相认的实例（各自的激活 tab、各自的滚动位置）。

---

## 三、样式规则

插件 CSS 会以 `<link>` **全局注入** `document.head`，没有隔离。因此以下选择器一律禁止：

| 禁止 | 原因 | 执行层 |
|---|---|---|
| `:root` | 全局令牌只属于宿主，改写会破坏双主题 | 构建期 |
| `html` / `body` / `#root` | 越过命名空间（滚动锁等请走宿主 API） | 构建期 |
| `.slot-*` / `.shell-*` / `.polaris-lite-shell` | 宿主类名，改了会让布局静默错乱 | 构建期 + 测试 |
| `@import` | 会引入不受门禁约束的外部样式 | 构建期 |
| 裸 `*` 选择器 | 影响面不可控 | 构建期 |
| `position: fixed` | 会逃出窗格、盖住分隔条与抽屉 | 构建期 |
| `!important` | **仅 `prefers-reduced-motion` 块内允许** | 构建期（提示） |

**做法**：所有选择器都以自己的插件前缀类名为根，例如 `.chat-*`、`.ma-*`、`.cap-*`、`.auth-*`。

### 可用令牌（只读）

插件必须消费宿主令牌，不得写死颜色——否则暗色主题下必炸。

```css
/* 背景 */ --bg --bg-panel --bg-hover --bg-elevated --bg-translucent --bg-code
/* 边框 */ --border --border-strong --border-rgb
/* 文本 */ --text --text-soft --text-dim --text-faint
/* 强调 */ --accent --accent-rgb --accent-bright --accent-soft --on-accent
/* 语义 */ --plite-success/-soft --plite-warning/-soft --plite-danger/-soft --plite-info/-soft
/* 尺寸 */ --plite-space-1..6 --plite-h-sm/md/lg --plite-fs-xs/sm/md/lg
/* 圆角 */ --radius --radius-lg --plite-radius-sm
/* 字体 */ --plite-font-sans --plite-font-display --plite-font-mono
/* 动效 */ --plite-dur --plite-dur-slow --plite-ease
/* 焦点 */ --plite-focus-ring
/* 阴影 */ --plite-shadow-1 --plite-shadow-2
```

衍生色用三元组：`rgba(var(--accent-rgb), 0.12)`、`rgba(var(--border-rgb), 0.08)`——这样同一套规则在两套主题下都成立。

`--text-faint` 是浅色主题下对比度最低的档位（约 3.4:1），只用于非关键辅助信息，不要用它承载正文。

---

## 四、运行时 API 的边界

```ts
setup(api: SlotHostApi) {
  api.dispatch(req)        // cap 总线：唯一允许的跨插件调用通道
  api.listen(evt, fn)      // 仅 manifest.events 声明过的事件
  api.emit(evt, payload)   // 自动附加来源插件 id
  api.registerCapability   // 仅 manifest.provides 声明过、仅 setup 内可用
  api.theme.mode / setMode
  api.t('key')
  api.layout.isMobile / openDrawer('sidebar' | 'panel' | 'none')
  api.workspace            // 仅当 manifest 声明且被授予 cap.ui.layout 时才存在
}
```

- 插件**拿不到**宿主实现（`src/` 下的 store / bus / hostRuntime），构建期会因 `@` 别名缺失而失败。
- 跨插件协作只有一条路：cap 总线。它自带三重治理——`capabilities ∩ grants` 授权、审计留痕、authGuard。**不要试图开第二条通道。**
- `api.layout` 只让你「感知移动端」和「请求开抽屉」；定义布局要经 `api.workspace`（理由见下）。

### `api.workspace`：布局的插件入口

```ts
api.workspace.getTree()                       // 深拷贝，改它不影响宿主
api.workspace.listViews()                     // [{ viewType, title, pluginId }]
api.workspace.open(viewType, { where, anchor, allowMultiple })
api.workspace.close(nodeId)
api.workspace.split(nodeId, dir, viewType)
api.workspace.move(nodeId, tabsId, index)
api.workspace.applyTree(tree)                 // 需 cap.ui.layout.global，且必须含四个锚点
api.workspace.reset()                         // 需 cap.ui.layout.global
```

**这些方法全部只是 `dispatch({ target: 'cap.ui.layout' })` 的薄包装**，没有一条直连宿主单例。
早期草案里 `api.workspace` 直接持有 `workspaceStore`，被评审否掉：布局是跨插件共享的可变状态，
直连等于开一条「无授权、无审计、无归属」的第二写通道——任何插件都能关掉审计面板、把别人的视图
挤到角落，而 `policy.ts` / `bus.ts` 建立的「申请≠授权、默认拒绝、全程审计」就形同虚设。

三道闸门：

| 闸门 | 规则 | 位置 |
|---|---|---|
| 授权 | `manifest.capabilities ∩ grants` 必须含 `cap.ui.layout`；未授权时 `api.workspace` **整个字段不存在**（fail-closed，不是「存在但报错」） | `bus.assertAllowed` + `hostRuntime` |
| 归属 | 只能 `close`/`move` **自己的**视图（`viewType` 前缀 = `pluginId`）；不能动锚点、不能动别人的视图；`applyTree`/`reset` 另需 `.global` | `layoutCap.assertCanTouch` |
| tab 组 | 并入一个已有 tabs 组 = 与组内视图共享 tab 条与激活态，所以非 `.global` 时**只能并入全部属于自己的组**；`host.slot.*` 的归属是宿主，插件不能往里塞（空锚点上的自动组装除外） | `layoutCap.assertTabsJoinable` |
| 结构视图 | `host.slot.*` 不可 `close`/`split`/`move`：它代表锚点内容，动了只会得到「按钮看起来坏了」或重复实例 | `layoutCap.assertNotStructuralNode` + `store.close` |
| 登录 | `cap.ui.layout` 在 `bus.isPublicCap` 里**白名单豁免**（只读 + 动自己的视图）；新增动作默认要求登录 | `bus.isPublicCap` |

> 白名单而不是黑名单：早期实现是「除 `applyTree`/`reset` 之外都放行」，将来新增一个会波及他人的动作就会默认放行。安全默认值必须是「拒绝」。

**为什么部分豁免**：全拦会让插件视图只能等用户登录后才出现，而外壳自己的固定槽位并不经过总线——
等于「宿主的 UI 权利 > 插件的 UI 权利」，与「核心零业务、一切皆插件」直接冲突；全豁免则让
未登录的插件能重排别人的界面。不豁免的是 `cap.config`（未登录读写任意命名空间属于 V2 漏洞）
与 `cap.ui.badge`（角标常承载未读数/告警，属信息泄漏面）。

**`open` 的落位语义**：

| `where` | 行为 |
|---|---|
| `'split-right'`（默认） | 把目标锚点一分为二，新视图占新增的一半 |
| `'split-bottom'` | 同上，纵向 |
| `'tab'` | 进目标锚点下已有的树内 tabs 组；**没有 tabs 组时**，若锚点还没子节点，就把该锚点的 `host.slot.*` 与新视图装进一个新 tabs 组（不会把 320px 面板劈成两半） |

默认锚点是 `stream`（主区）：落到 `panel` 会把 320px 一分为二，两个 160px 窗格谁也放不下内容——实测结论，不是推测。

默认幂等：同一 `viewType` 已在树中时直接聚焦、不重复开实例（`allowMultiple` 可覆盖）。

**提交前一定校验**：所有结构变更都经过 `store.commitChecked`（先 `validateWorkspace` 再落地）。
`applyTree` 额外要求 `requireAllAnchors`——缺锚点的树语法合法，但会被持久化，而下次启动
`restore` 会拒绝它（用户看到「插件说成功了，刷新就没了」），移动端的抽屉按钮也会指向
不存在的元素。预设可以只排一部分区域，但**落盘的那一份必须是完整布局**。

**`close` 只接受视图**：`split` / `tabs` 容器不可关闭。删掉一个容器会连带删掉它内部的
所有视图，其中若含锚点，就得到一棵缺锚点的树；容器的消失应当是「关掉最后一个视图后
自动折叠」的结果。

---

## 五、工作区树（已落地）

布局的唯一数据模型是一棵可校验的树（`src/core/workspace/schema.ts`），由
`WorkspaceTree.tsx` 渲染。四个固定槽位不再写死在 JSX 里，而是默认树里的四个锚点。

```ts
type WorkspaceNode =
  | { kind: 'anchor'; id; anchor: 'sidebar'|'stream'|'input'|'panel'; children?: Node[] }
  | { kind: 'split';  id; dir: 'row'|'col'; size: SplitSize; children: [Node, Node] }
  | { kind: 'tabs';   id; active: string; children: Node[] }
  | { kind: 'view';   id; viewType: string }

type SplitSize = { mode: 'ratio'|'px'|'auto'; value?: number; of?: 'first'|'second' }
```

默认树与旧的四槽布局**逐节点等价**（CLI 实测：侧栏 252px、面板 320px、输入区自适应）：

```
split(row, px 252 of first)
├─ anchor:sidebar
└─ split(row, px 320 of second)
   ├─ split(col, auto of second)
   │  ├─ anchor:stream
   │  └─ anchor:input
   └─ anchor:panel
```

五条已定死的设计：

1. **`split` 严格二分**。多子节点只给一个比例无法定义语义，三栏以上用嵌套。`children` 是二元组，从类型层面杜绝「children 与 ratio 失配」。
2. **尺寸三种模式 + 作用侧**。`ratio` 可拖动；`px` 用于固定栏（现状侧栏 252 / 面板 320 必须原样复现，纯比例会在 1920px 上把侧栏拉到 380px）；`auto` 表示「内容自然高」（输入区靠它，否则窗口拉高时输入区跟着变高）。`of` 指定尺寸作用于哪个子项，缺省 `first`——没有它就没法写「右面板固定 320、剩下全给主区」。
3. **实例 id 与视图类型分离**。`id` 是实例标识，`viewType` 指向注册的视图类型；`tabs.active` 只认子节点 `id`。用数组下标做激活态，关闭/重排后会漂到别的视图上。
4. **锚点是保留位置**。`anchor.children` 为空时渲染 `SlotOutlet`（存量槽位贡献）；一旦有子节点就只渲染子节点——所以要在子节点里保留槽位内容，必须显式引用 `host.slot.<anchor>`（见第二节）。
5. **`auth` 不在树内**。门禁是树的**外部**路径：未登录时整个壳层骨架不渲染。把登录页做成锚点会让「未登录也能改布局」变成合法路径。

### 启动顺序（不能换）

```
install 能力 → 注册 host.slot.* → workspaceStore.restore()
  → 加载插件（setup 里就会调 cap.ui.layout 装配视图）
  → workspaceStore.pruneDeadViews() → createRoot
```

- **restore 必须在插件之后渲染、但在插件 setup 之前执行**。反了就会出现「`open` 返回 ok，但界面上没有那个视图」：`restore()` 会整体替换树，把插件刚打开的视图抹掉。
- **折叠死视图必须等插件加载完**（`pruneDeadViews`）。反了就会在注册表还空着的时候把所有插件视图判成死视图，整棵树退化成默认布局——用户的布局被自己的启动流程清掉。

### 校验器的硬不变量（违反即整体拒绝，绝不部分应用）

| 不变量 | 后果 |
|---|---|
| 深度 ≤ 8、叶子 ≤ 16、节点 ≤ 64 | 超深树会让**下一次启动继续崩**，用户无法自救 |
| `ratio ∈ [0.05, 0.95]`、`px ≥ 120` 且必须是有限数 | `0` 会产生 0 宽但仍挂载、仍订阅的幽灵窗格；`NaN` 让整行塌陷 |
| `anchor` 不得重复，且必须包含四个锚点（准入树时） | 重复锚点 = 同一位置被渲染两次；缺锚点会让移动端抽屉按钮指向不存在的元素 |
| `tabs` 至少 2 个子项、不得嵌套 tabs、单组 ≤ 12 项 | 单子项残留空 tabbar；嵌套让「激活的是哪一组」失义；12 项以上等分宽度后每格不足 24px |
| `tabs.active` 必须等于某个子节点 id | 悬空导致整组无选中项，区域全空且无报错 |
| 节点 id 合法且全树唯一、禁止 `__proto__` 等键 | 重名导致双挂载与状态分裂；危险键可污染原型 |
| 无环、序列化后 ≤ 256KB | `applyTree` 接收活对象，自引用会让 React 递归到栈溢出；超体积快照在 `parse` 之前就被丢弃（否则 `JSON.parse` 同步阻塞主线程） |

### 持久化与失败姿态

- 唯一键 `plite.workspace.v1`，信封 `{ v: 1, tree, savedAt }`，**只有 `WorkspaceStore` 写**。
- 版本不认、JSON 脏、超体积、缺锚点、原型污染键 → **一律回默认树**，原件备份到 `plite.workspace.v1.bak`，并在界面上给一条非阻塞提示。**绝不白屏，也绝不做「猜测式迁移」**。
- 拖动过程不写盘（只改 DOM），松手提交一次；切换 tab/尺寸后 400ms 防抖，`pagehide` / `visibilitychange` 兜底 flush。

---

## 六、越界了会怎样

| 症状 | 原因 | 修法 |
|---|---|---|
| `构建中止：插件 X：panel 槽必须声明 title` | panel 槽缺 `title` | 补 `title`，≤ 4 字 |
| `构建中止：槽位 panel 的 order=3 被 A 与 B 同时占用` | order 重复 | 改用唯一 order |
| `构建中止：... viewType 必须以 "x." 开头` | 视图类型没带插件前缀 | 改成 `x.my-view` |
| `构建中止：... 入口没有导出组件 Gantt` | 声明了视图但组件没 `export` | 在入口导出该组件 |
| `构建中止：viewType 重复：x.a 被 A 与 B 同时声明` | 两个插件抢同一个类型 | 各自加前缀/改名 |
| `构建中止：... host. 是宿主保留命名空间` | 插件用了 `host.` 前缀 | 换自己的前缀 |
| `构建中止：plugins/x/y.css：:root 只属于宿主令牌层` | 改了全局令牌 | 删掉，用宿主令牌 |
| `构建中止：... 插件不得选中宿主类名` | CSS 选中了 `.slot-*` | 改成自己的前缀类名 |
| `npm test` 报「插件 CSS 越界」 | 同上 | 同上 |
| 运行时 `api.workspace` 是 `undefined` | 没声明或没被授予 `cap.ui.layout` | 在 manifest 声明 + `public/grants.json` 登记 |
| 运行时 `无权操作他人视图` | 动了别人 `viewType` 前缀的节点 | 只操作自己的视图；跨插件编排需 `.global` |
| 界面上视图显示「视图不可用」 | 插件被禁用/下线，`pruneDeadViews` 已从布局摘除但它还在持久化里 | 重新启用插件，或让用户重开该视图 |

所有门禁都是 fail-fast：宁可构建失败，也不要带着会漂移的顺序、会泄漏的样式、会白屏的布局上生产。

---

## 七、当前未开放的能力（明确不做）

| 能力 | 状态 | 原因 |
|---|---|---|
| 改写宿主 DOM / 类名 | 禁止 | 会破坏主题、a11y、移动端适配；且插件互相踩踏 |
| 直写布局持久化 | 禁止 | 布局只有一个属主（宿主），插件只能经 `cap.ui.layout` 申请 |
| 自定义 tabbar **形态** | 部分开放 | tab 条本身仍由宿主画（等分宽度、roving tabindex、拖拽排序是共享区行为，各画一种必然不一致）；插件能做的是决定「哪些视图在同一组、顺序如何、谁激活」——即写 `tabs` 节点 |
| 在锚点之外任意落位（自由画布） | 不做 | 树模型只有「分割 / 分组」两种关系，没有绝对定位。引入坐标等于放弃响应式与移动端单列折叠 |
| 第三方沙箱（iframe） | 未实现 | 会切断主题与布局集成，仅在未来面向外部插件时考虑 |
| 多窗口 popout | 不做 | 宿主是单 root + 模块级单例，开第二个窗口需要重做多窗口协议（评审已定：v1 砍掉，不做半成品） |
| 插件间共享「布局预设市场」 | 未开放 | 预设只能由插件 `applyTree` 提交，跨插件分发缺少信任模型（谁的预设可以替换整棵树？） |

---

## 八、变更这份契约

改约束不是改注释，是改三处：`plugins/build-plugins.mjs`（或它引用的 `plugins/manifest-views.mjs`）的门禁、`tests/` 的守卫、本文档。三者不一致时以**代码里的门禁为准**——文档会过时，构建不会。

本轮新增约束的落点，供下次改的时候对照：

| 约束 | 门禁 | 守卫测试 |
|---|---|---|
| `viewType` 前缀 / 唯一 / `title` / 组件导出 / 锚点白名单 | `plugins/manifest-views.mjs`（`validateViews`） | `tests/manifest-views.test.mjs` |
| `host.` 保留命名空间、结构视图不可 `open` | `layoutCap.assertNotStructuralView` | `tests/host-views.test.mjs` |
| 树不变量（深度/叶子/ratio/锚点/tabs/环/原型污染） | `schema.validateWorkspace` | `tests/workspace.test.mjs` |
| 恢复与折叠的失败姿态（脏数据回默认 + 备份） | `store.restore` / `store.pruneDeadViews` | `tests/workspace-store.test.mjs` |
| 归属与二级权限（只能动自己的视图） | `layoutCap.assertCanTouch` | `tests/workspace-cap.test.mjs` |
| 插件 CSS 不得触碰宿主命名空间 | `lintPluginCss` | `tests/arch.test.mjs` |
