# 右侧面板 Tab 拥挤问题：方案规划（panel-tabs-schemes）

> **状态：已实施（2026-11-20）。** 落地记录见文末「八、实施记录」；规划原文保留如下。

> 背景：右侧面板（`panel` 槽）顶部的 tab 条随插件数量线性增长。当前 9 个槽位贡献
> （能力/模型/Bash/账号/预览/文件/取证/记账/临时凭证）在 320px 宽、内宽约 296px 的
> tabbar 里已极限；第 10 个起必然挤压/截断/溢出。本文是**规划**，不含实施。
>
> 与左侧同题探索（`docs/sidebar-schemes/`、`docs/nav10-schemes/`）的关系：左侧已评出
> S3「滚动分组 + 置顶」冠军并落地原型；右侧是同一类问题在不同容器里的复发。左侧的
> 经验直接继承，但右侧多一条硬约束——**它是宿主渲染的 tab 条，左侧是插件内容区**。

## 一、现状（代码事实）

- 渲染者：宿主 `src/core/SlotOutlet.tsx`。panel 槽有多个贡献时用 `slot-tabs` /
  `slot-tabbar` 渲染 tab 条；tab 文本取 `SlotDescriptor.title`。
- 布局：`src/styles.css` `slot-tab { flex: 1 1 0 }` —— **等分挤压**，不是滚动。
  tabbar 有 `overflow-x: auto` 但因等分而永不触发，纯摆设。
- tab 来源：`SlotRegistry.list('panel')` 按 `order` 排序（order 必须唯一，构建期校验）。
- a11y：role=tablist/tab/tabpanel、roving tabindex、←→/Home/End、Enter/Space。
- 已存在**第二套 tab 条**：工作区树的 `TabsNode`（`WorkspaceTree.tsx` `TabsView`），
  支持鼠标拖拽重排、关闭按钮、`maxTabsChildren: 12`。两套互不相认。
- 移动端（≤768px）：panel 锚点整体变抽屉，tab 条跟着进抽屉，宽度反而更紧张。

## 二、方案矩阵（按用户提示的三种基本动作展开）

| # | 方案 | 核心交互 | 优点 | 缺点 |
|---|---|---|---|---|
| A | 横向滚动条 | tab 改自然宽度 + 左右滑动 + 激活项自动滚入视口 | 实现极轻（CSS 为主）；与左栏一致；保活/键盘语义零破坏 | 只解决「放得下」不解决「找得到」；超宽 tab（4 字 × 12）需 mask 渐隐 + 滚动指示 |
| B | 下拉展开 | tab 条尾部「⋮/＋n」chip，点开浮层列剩余 tab（搜索 + 置顶） | 承接 N1 浮层模式（冠军经验）；面板再多也是常量高度 | 发现性弱（溢出 tab 不可见）；浮层关闭策略需定义；触屏两跳 |
| C | 滚动 + 下拉混合 | 容纳得下时滚动；溢出时自动出现「＋n」入口收纳低频项 | 容量自适应（两评委一致的落地前置条件）；各规模都有合理形态 | 两条通道（滚动/浮层）状态同步面大；实现复杂度最高 |
| D | 收敛为图标 | tab 只显示图标（无文字），hover/激活显示全名 | 单 tab 宽度骤降（~32px），容量提升 ~3 倍 | 图标配不出全 9 类（能力/模型/Bash…）不重复；辨认靠记忆，可发现性最差 |
| E | 命令面板 | Ctrl+K 搜索切换（N3） | 对数量最免疫；键盘最快 | 浏览型查找弱；移动端优势归零；单独用不解决可见导航 |

**推荐：C（滚动 + 下拉混合，S3 经验在右栏的镜像）**。

理由：左侧 S3 已证明「结构性消灭挤压 + 保高频入口」是两评委一致的最优解；右栏的
空间约束（横向）与左栏（纵向）同构——滚动消化数量，「＋n」收纳低频。A 是 C 的子集，
B 是 C 的浮层半边，D/E 因辨识度/可见性不作为主形态（E 可作为后续增强）。

## 三、目标形态（C 展开）

```
┌──────────────────────────┐
│ [能][模]│Bash 账号 ⋯⋯⋯ › │   ← 可滚动区（自然宽度，激活项滚入视口）
├──────────────────────────┤     尾部「＋n」：溢出/低频面板收纳浮层
│  当前激活面板内容          │     （搜索行 + 置顶 grid + 全量列表，ToolSwitcher 语言）
└──────────────────────────┘
```

关键体验细节（用户特别要求的 UX 考量）：
- **激活项永不被藏**：切 tab（含键盘）时 scrollIntoView({inline:'nearest'})。
- **溢出感知**：scrollLeft + clientWidth < scrollWidth 时显示 mask 渐隐与「＋n」。
- **顺序可控**：置顶/常用项可拖入滚动区前段（复用 TabsView 已有的鼠标拖拽范式）。
- **a11y 不回退**：现有 roving tabindex 与 ←→/Home/End 全保留；浮层内同规范。
- **移动端**：抽屉内 tab 条同样滚动 + 尾部收纳；浮层全宽从底部弹（sheet 化）。
- **保活语义不破坏**：只动 tab 条，tabbody 的懒挂载/display:none 保活机制原样。

## 四、纯插件实现路径（推荐 A′：cap.ui.layout 预设装配）

**结论：不需要改宿主。** 关键发现：`host.slot.panel` 本身就是一个合法视图类型
（`hostViews.ts`），锚点「有 children 就渲染 children」；而 `TabsView`
（工作区树 tabs）**已经实现了 C 方案的大半**——横向自然宽度滚动、激活滚入、
拖拽重排、关闭按钮、键盘漫游。

一个布局插件在 `setup()` 里做一次装配即可：

```js
// plugins/panel-dock/index.ts（示意）
setup(api) {
  const res = await api.dispatch({
    target: 'cap.ui.layout',
    action: 'applyTree',
    payload: { tree: {
      // ……原默认树的其余部分不变……
      panel 锚点 children: [{
        kind: 'tabs', id: 'panel-tabs', active: hostSlotLeafId,
        children: [
          { kind: 'view', id: 'ps', viewType: 'host.slot.panel' },   // 槽位面板们
          { kind: 'view', id: 'pd', viewType: 'panel-dock.dock' },    // 收纳器（可选）
        ],
      }],
    }},
  });
}
```

等等——这里有一个**必须先做的代码核对**：`TabsView` 的 tab 条当前也是
`flex: 1 1 0` 等分（`styles.css:299` `.slot-tab { flex: 1 1 0 }` 同一条规则同时作用于
两套 tab 条）。所以「TabsView 已实现滚动」不成立——它有溢出容器但同样被等分挤压。
**纯插件路径的这一处需要宿主补一条通用 CSS**（见六），这是全方案唯一越出
「纯插件」边界的点，且属于「现有溢出机制失效」的缺陷修复而非新机制。

### 备选 B′：与槽位贡献并存（不动树）

不动工作区树，由一个插件贡献一个占满 panel 槽的「TabStrip 容器」视图，内部经
`host.slots.list('panel')` 枚举槽位贡献并代理渲染。缺点：双写通道（插槽贡献的 tab
与 TabStrip 容器同抢一个 panel 槽位）、需要新的 host API 暴露 slots 枚举，改动面
反而更大。**不推荐**。

## 五、与左侧 S3 落地路线的关系统一

左栏落地建议（sidebar-schemes/README.md）把「激活态上提为单一权威」列为前置条件，
本方案与之对齐：

- 短期：本方案（A′）不动激活态归属，panel 槽内部自洽；
- 长期：若左侧 S3 落地，导航入口收敛到左栏，右侧 tab 条退化为「当前面板标题 +
  ＋n 收纳」，两栏不再各自维护全量 tab 清单——届时本方案的滚动区自然退化，
  「＋n」浮层（N1/ToolSwitcher 语言）成为唯一入口。

## 六、实施拆解（后续工作，不在本次范围）

1. **宿主 CSS 缺陷修复（先行）**：`.slot-tab` 等分改自然宽度 + 容器滚动
   （两套 tab 条同享）。同时把 TabsView tabbar 补「激活滚入视口」effect。
2. **panel-dock 插件**：manifest 声明 `cap.ui.layout.global`；setup 里 applyTree
   装配 `tabs[host.slot.panel, panel-dock.dock]`；dock 视图实现「＋n」浮层
   （搜索 + 全量列表 + 置顶，ToolSwitcher 视觉语言）。
3. **原型先行**（可选，走 sidebar-schemes 同款流程）：`prototypes/panel-tabs-C.html`
   单文件原型验证 12+ tab 时的滚动/收纳/移动端形态。
4. 验收：12 个槽位贡献时 tab 可达、可发现、可键盘操作；持久化布局刷新后不丢；
   插件禁用后 `pruneDeadViews` 正常折叠（注意：panel-dock 下线时 `host.slot.panel`
   回退为原 SlotOutlet tab 条，天然降级，无黑洞）。

## 七、风险清单

- `applyTree` 需 `.global` 授权且必须含四锚点（layoutCap.ts 校验），树写错=整体拒绝；
- `maxTabsChildren: 12` 上限当前 9+1=10，安全；若未来面板>11 需调 WORKSPACE_LIMITS；
- `host.slot.panel` 不可 close/move（结构视图守卫），dock 插件只能在 applyTree 预设里
  引用它，不能经 open 新开第二份（会得到两个互不相认的实例——layoutCap 已有守卫）；
- 布局快照版本 `plite.workspace.v1`：装配树的变更会被持久化，panel-dock 下线后残留
  节点会被 pruneDeadViews 折叠，`host.slot.panel` 回退默认渲染——降级路径成立，但
  首次启动会有一次「布局变更已落盘」的 revision 波动，属预期。

---

## 八、实施记录（2026-11-20）

二审否决了规划稿的 A′ 纯插件路线（applyTree 装配 `tabs[host.slot.panel, dock]`）：锚点有
children 后渲染 TabsView 一条 tab 条，而 `host.slot.panel` 内部的 SlotOutlet 因 9 个槽位贡献
**又渲染一条**——双层 tab 条，纯插件无法替换宿主 SlotOutlet 的 tab 条渲染。定案改为
**宿主最小改**：直接升级 SlotOutlet 自身的 tab 条（宿主 4 文件，无新插件）。

### 落地内容

- `src/core/SlotOutlet.tsx`：tab 改自然宽度横向滚动 + 滚轮转横向；溢出几何实测
  （offsetLeft 计数「不滚动看不到」的面板 → ＋n 按钮）；「＋n」收纳菜单（全量列表 +
  >8 个时搜索框 + ☆置顶）；置顶持久化 `plite.slot.pins.<slot>`，置顶项排滚动区最前
  （tab 前加 3px 圆点标识，不占宽度）；激活/焦点项 `scrollIntoView(inline:'nearest',
  behavior:'instant')`；roving tabindex / ←→/Home/End/Enter/Space 全保留。
- `src/core/slotRegistry.ts`：新增纯函数 `orderEntriesWithPins`（置顶排序，脏 key 静默忽略），
  单测 3 组断言进 `tests/core.test.mjs`。
- `src/core/workspace/WorkspaceTree.tsx`：TabsView 补激活滚入视口 + 滚轮转向（共用 tab 条 CSS）。
- `src/styles.css`：`slot-tab` 等分 → 自然宽度；sticky 上移到新增的 `slot-tabbar-wrap`；
  左右渐隐 mask（data-can-left/right 实测驱动）；＋n 按钮、收纳菜单、置顶圆点样式；
  溢出时 tab 条补右 padding 让位 ＋n（防末位 tab 被盖半截）；窄屏收纳菜单 sheet 化
  （fixed 底部 + 安全区）。
- `src/core/shellState.ts`：断点订阅补 window resize 兜底——部分 WebView 不派发
  media query change（分数 DPI 缩放 / 视口注入式 resize），断点冻结在加载值。

### 实测踩坑（验收时全部实锤复现并修复）

1. **`scroll-behavior: smooth` 在 rAF 冻结环境永不前进**：WebView2 隐藏 tab 冻结 rAF，
   smooth 的 scrollLeft 赋值被拦（实测赋 200 只到 147）。滚入视口一律 `behavior:'instant'`。
2. **＋n 盖住末位 tab**：scrollIntoView 对齐滚动容器边缘，浮在容器上层的 ＋n 按钮
   裁掉末位 tab 半截。修法：溢出时给 tab 条补 46px 右 padding，且对齐 effect 依赖
   `geo.hidden`（padding 生效后重跑一次）。
3. **断点翻转后溢出计数陈旧**：窄屏 display:contents 下 clientWidth=0 → hidden 记成 9；
   翻宽后 ResizeObserver 在后台 tab 被 rAF 冻结不触发。修法：SlotOutlet 订阅窄屏断点，
   断点变化强制重测。
4. **IAB 自动化环境限制（非产品 bug）**：setViewportSize 改 CSS 视口但不派发 resize /
   media query change；真实浏览器不受影响，但暴露了 3 号坑并促成 resize 兜底（对主仓
   WebView2 分数缩放同源问题有真实防御价值）。

### 验收断言（全部通过）

- 桌面 1280×720：panel 320px 定位正确；9 tab 自然宽度，溢出 ＋2/＋3 计数与几何实测一致；
- 键盘：Home/End/←→ 焦点漫游 + Enter 激活，焦点跟随滚动；
- 置顶：菜单 ☆「记账」→ 置顶第一 + 圆点 + localStorage 持久化 + 跨刷新保持；清除后回 order 序；
- 菜单项点击「临时凭证」→ 菜单自动关、激活滚入视口（scrollLeft 134）、active key 持久化；
- 移动端 390×844：抽屉内 tab 条滚动 + ＋3；菜单 sheet 化（fixed 底部，y=485~832）；
- `npm run typecheck` 通过；`npm test` 184/184 全绿（含新增置顶排序 3 断言）。
