# 插件契约（Plugin Contract）

这份文档回答一个问题：**插件能做什么、不能做什么、越界了会在哪里被拦下。**

它存在的理由是项目的一条硬经验：约束的失效是渐进且无声的。先在核心 import 一个插件常量，再在插件里引用宿主 store，最后核心与插件又长回一块。等功能堆积起来再拆，成本是重做。所以规则必须先写下来，再由构建与测试强制执行——不能只靠自觉。

> 三条执行层：**构建期**（`npm run check:plugins`，违规直接中止）、**测试期**（`npm test`）、**运行时**（`resolvePolicy` + `CapBus` 拒绝）。文档里每条约束都标了执行层。

---

## 一、三层边界

```
┌─ 宿主壳层：不可改 ────────────────────────────────┐
│  grid 列宽 / 抽屉 / 键盘 / aria / 主题令牌         │
│  ┌─ 槽位契约层：只能声明 ──────────────────────┐  │
│  │  contributes.slots[] = slot/component/     │  │
│  │                        order/title         │  │
│  │  ┌─ 插件内容层：完全自由 ────────────────┐  │  │
│  │  │  组件内部 DOM / CSS / 二级 tab / 图表  │  │  │
│  │  └───────────────────────────────────────┘  │  │
│  └─────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────┘
```

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
}
```

- 插件**拿不到**宿主实现（`src/` 下的 store / bus / hostRuntime），构建期会因 `@` 别名缺失而失败。
- 跨插件协作只有一条路：cap 总线。它自带三重治理——`capabilities ∩ grants` 授权、审计留痕、authGuard。**不要试图开第二条通道。**
- `api.layout` 只让你「感知移动端」和「请求开抽屉」，不让你定义布局。

---

## 五、工作区树（契约已定，渲染待接入）

布局的长期模型是一棵可校验的树（`src/core/workspace/schema.ts`）：

```ts
type WorkspaceNode =
  | { kind: 'split'; id; dir: 'row'|'col'; size: { mode:'ratio'|'px'; value }; children: [Node, Node] }
  | { kind: 'tabs';  id; active: string; children: Node[] }
  | { kind: 'view';  id; viewType: string }
```

三条已定死的设计：

1. **`split` 严格二分**。多子节点只给一个比例无法定义语义，三栏以上用嵌套。`children` 是二元组，从类型层面杜绝「children 与 ratio 失配」。
2. **尺寸两种模式**。`ratio` 可拖动；`px` 用于固定栏（现状侧栏 252px / 面板 320px 必须原样复现，纯比例会在 1920px 上把侧栏拉到 380px）。
3. **实例 id 与视图类型分离**。`id` 是实例标识，`viewType` 指向注册的视图类型；`tabs.active` 只认子节点 `id`。用数组下标做激活态，关闭/重排后会漂到别的视图上——这正是当前 `activeIdx` 的隐患。

校验器的硬不变量（违反即整体拒绝，绝不部分应用）：

| 不变量 | 后果 |
|---|---|
| 深度 ≤ 8、叶子 ≤ 16、节点 ≤ 64 | 超深树会让**下一次启动继续崩**，用户无法自救 |
| `ratio ∈ [0.05, 0.95]` 且必须是有限数 | `0` 会产生 0 宽但仍挂载、仍订阅的幽灵窗格；`NaN` 让整行塌陷 |
| `tabs` 至少 2 个子项、不得嵌套 tabs | 单子项残留空 tabbar；嵌套让「激活的是哪一组」失义 |
| `tabs.active` 必须等于某个子节点 id | 悬空导致整组无选中项，区域全空且无报错 |
| 节点 id 合法且全树唯一、禁止 `__proto__` 等键 | 重名导致双挂载与状态分裂；危险键可污染原型 |
| 无环 | `applyTree` 接收活对象，自引用会让 React 递归到栈溢出 |

---

## 六、越界了会怎样

| 症状 | 原因 | 修法 |
|---|---|---|
| `构建中止：插件 X：panel 槽必须声明 title` | panel 槽缺 `title` | 补 `title`，≤ 4 字 |
| `构建中止：槽位 panel 的 order=3 被 A 与 B 同时占用` | order 重复 | 改用唯一 order |
| `构建中止：plugins/x/y.css：:root 只属于宿主令牌层` | 改了全局令牌 | 删掉，用宿主令牌 |
| `构建中止：... 插件不得选中宿主类名` | CSS 选中了 `.slot-*` | 改成自己的前缀类名 |
| `npm test` 报「插件 CSS 越界」 | 同上 | 同上 |

所有门禁都是 fail-fast：宁可构建失败，也不要带着会漂移的顺序、会泄漏的样式上生产。

---

## 七、当前未开放的能力（明确不做）

| 能力 | 状态 | 原因 |
|---|---|---|
| 改写宿主 DOM / 类名 | 禁止 | 会破坏主题、a11y、移动端适配；且插件互相踩踏 |
| 直写布局持久化 | 禁止 | 布局只有一个属主（宿主），插件只能经 API 申请 |
| 自定义 tabbar 形态 | 待定 | 倾向做成「槽位级唯一 Layout Provider」，而不是每个插件各画一种 |
| 第三方沙箱（iframe） | 未实现 | 会切断主题与布局集成，仅在未来面向外部插件时考虑 |
| 多窗口 popout | 不做 | 宿主是单 root + 模块级单例，开第二个窗口需要重做多窗口协议 |

---

## 八、变更这份契约

改约束不是改注释，是改三处：`plugins/build-plugins.mjs` 的门禁、`tests/` 的守卫、本文档。三者不一致时以**代码里的门禁为准**——文档会过时，构建不会。
