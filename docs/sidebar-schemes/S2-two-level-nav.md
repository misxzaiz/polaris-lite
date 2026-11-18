# S2 双层导航方案（Two-Level Navigation）

> 路线：S2 —— 第一层大分类（对话 / 开发 / 数据 / 工具），第二层为该分类下的面板列表；点击分类展开二级列表。
> 目标：解决「面板插件线性增长 → 左侧 tab 挤压溢出」的问题，把 O(n) 的平面 tab 变成 O(分类数 × 单分类面板数) 的两级结构，一级分类数恒定（≤6），面板再怎么加也不挤。
> 对应总纲：`docs/sidebar-schemes/brief-sidebar.md`。本方案为设计文档 + 原型骨架说明，不直接改动宿主源码。

---

## 0. 方案概述

- **一级（分类层）**：固定四个内置分类——对话、开发、数据、工具。每个分类一行，含图标、名称、面板计数徽标、展开箭头。点击展开/收起该分类的二级列表（手风琴，默认单开，记忆上次展开项）。
- **二级（面板层）**：该分类下的面板条目（图标 + 名称），点击即切换右侧 panel 槽的激活面板。「会话列表 + 新会话」作为「对话」分类的二级内容，与面板条目同一交互形态，统一信息架构。
- **空间策略**：侧栏 260px 不变；分类行常驻（4 行），二级列表按需展开，纵向滚动兜底。面板总数增长只影响「单分类内的列表长度」，不影响一级结构。

---

## 1. 交互结构图（文字图）

```
桌面（>768px）
┌──────────────────────────────┬──────────────────┬──────────────────┐
│ 左侧栏 260px                 │ 主区（stream）    │ 面板区 300px      │
│ ┌──────────────────────────┐ │                  │ ┌──────────────┐ │
│ │ 品牌 Polaris Lite        │ │                  │ │ 激活面板内容  │ │
│ ├──────────────────────────┤ │                  │ │ （由二级条目  │ │
│ │ ▼ 💬 对话        (2)     │ │                  │ │  点击决定）   │ │
│ │    ・新会话              │ │                  │ │              │ │
│ │    ・会话列表  ←active   │ │                  │ │              │ │
│ │ ▶ 🛠 开发        (3)     │ │                  │ │              │ │
│ │ ▶ 🗄 数据        (4)     │ │                  │ │              │ │
│ │ ▶ 🧰 工具        (5)     │ │                  │ │              │ │
│ ├──────────────────────────┤ │                  │ │              │ │
│ │ （侧栏剩余空间：          │ │                  │ │              │ │
│ │   对话分类展开时即会话    │ │                  │ │              │ │
│ │   列表本体，无需重复区）  │ │                  │ │              │ │
│ └──────────────────────────┘ │                  │ └──────────────┘ │
└──────────────────────────────┴──────────────────┴──────────────────┘

状态机（点击行为）
  点击一级分类行
    ├─ 该分类未展开 → 展开（若单开模式，先收起其他分类）；记录 expandedCats
    ├─ 该分类已展开 → 收起
    └─ 不改变 panel 激活态（浏览不产生副作用）

  点击二级面板条目
    ├─ setActivePanelId(panelId) → 右侧 panel 槽切换内容
    ├─ 移动端：随后 setDrawer('none') 收起抽屉
    └─ 该条目标记 active（accent 高亮）

  面板插件动态注册/卸载
    └─ SlotRegistry 通知 → 分类计数徽标与二级列表响应式更新
        （新面板按 manifest 声明的 category 落位；未声明进「工具」兜底）
```

单开 vs 多开：默认**单开**（同一时刻只展开一个分类，侧栏纵向空间可控）；用户可在设置中切多开。展开状态持久化到 `cap.config`（namespace `panel-nav`）。

---

## 2. 分类规则

### 2.1 内置一级分类

| key | 名称 | 收纳内容 | 示例（现有/未来插件） |
|---|---|---|---|
| `chat` | 对话 | 会话列表、新会话、对话相关面板 | chat-lite（SessionSidebar） |
| `dev` | 开发 | 引擎、调试、日志、构建类面板 | 引擎状态、日志查看器、调试控制台 |
| `data` | 数据 | 模型/配置/存储/知识库管理 | model-admin（模型供应商管理）、配置中心面板 |
| `tool` | 工具 | 能力面板、MCP、终端、文件等通用工具 | cap-panel（能力面板）、MCP 管理 |

约束：**一级分类由宿主内置，插件不得新增一级分类**（保证一级结构稳定可预期）；单分类面板数建议 ≤15，超出时分类内按 `order` 排序 + 提供分类内过滤输入（原型可先只做滚动）。

### 2.2 插件如何归入分类（契约扩展）

在 `SlotDescriptor` 上增加可选字段 `category`（见第 5 节 `types.ts`）：

```ts
// plugins/model-admin/index.ts 的 manifest 示例（改造后）
contributes: {
  slots: [{ slot: 'panel', component: 'ModelAdminPanel', order: 2, category: 'data' }],
}
```

- 归类信息**由插件自声明**（插件最清楚自己是什么）；宿主不做智能推断，避免隐式规则。
- 声明粒度是「插件的面板条目」而非插件本身：同一插件若向 panel 槽贡献多个组件，可各归各类。
- sidebar/stream/input 槽的条目不参与此分类（`chat` 分类的会话列表来自 sidebar 槽，属特例映射，见第 5 节）。

### 2.3 未分类去哪

- 未声明 `category`（或声明值不在内置分类表内）的 panel 条目，**一律落入 `tool`（工具）分类兜底**，并在该分类内排在已声明条目之后（按 `order`，再按 pluginId 字典序保证稳定）。
- 兜底保证「新面板永不丢失、永远可达」——即使插件作者忘了声明，也只是排序靠后，不会从界面上消失。
- 可选增强：开发模式下在「工具」分类头部对未声明条目显示 `未分类` 小徽标，提示插件作者补声明（仅 dev 构建显示）。

### 2.4 分类可配置性

- **v1（本方案）**：分类清单固定四个，不可增删；插件只能选择落入哪个内置分类。展开状态、激活面板 id 经 `cap.config`（namespace `panel-nav`）持久化，跨会话记忆。
- **v1.5**：允许用户调整分类显示顺序、隐藏空分类、单开/多开切换（均存 `cap.config`）。
- **v2（可选）**：开放用户自定义分类（如「我的收藏」），实现为 `cap.config` 里的用户分组定义 + 面板归属映射；插件契约不变。本方案不依赖 v2。

---

## 3. 原型页面结构说明（HTML 骨架层级）

单文件原型建议落 `prototypes/sidebar-S2.html`，浏览器直接打开，内置 ≥10 个示例面板。骨架层级如下（类名对齐宿主 `styles.css` 的命名风格，便于评委对照落地成本）：

```html
<body>
  <div class="polaris-lite-shell" data-layout="four-slot">
    <!-- 手机端顶栏（≤768px 显示） -->
    <header class="shell-topbar">
      <button class="topbar-btn" aria-label="会话列表">☰</button>
      <span class="topbar-title">Polaris Lite</span>
      <button class="topbar-btn" aria-label="能力面板">⚙</button>
    </header>

    <!-- 左侧栏：品牌 + 双层导航 -->
    <aside class="shell-sidebar">
      <div class="shell-brand">…</div>

      <nav class="pnav" role="tree" aria-label="面板导航">
        <!-- 一级分类 ×N；每个分类是一个可展开分组 -->
        <section class="pnav-group" data-cat="chat" aria-expanded="true">
          <button class="pnav-cat" role="treeitem" aria-expanded="true">
            <span class="pnav-cat-icon">💬</span>
            <span class="pnav-cat-name">对话</span>
            <span class="pnav-cat-count">2</span>
            <span class="pnav-cat-chevron">▾</span>
          </button>
          <!-- 二级：该分类下面板/会话条目 -->
          <ul class="pnav-items" role="group">
            <li><button class="pnav-item">＋ 新会话</button></li>
            <li><button class="pnav-item active">会话列表</button></li>
          </ul>
        </section>

        <section class="pnav-group" data-cat="dev" aria-expanded="false">
          <button class="pnav-cat" aria-expanded="false">… 开发 (3) …</button>
          <ul class="pnav-items" hidden>
            <li><button class="pnav-item">引擎状态</button></li>
            <li><button class="pnav-item">日志查看器</button></li>
            <li><button class="pnav-item">调试控制台</button></li>
          </ul>
        </section>

        <section class="pnav-group" data-cat="data" aria-expanded="false">
          … 数据 (4)：模型供应商 / 配置中心 / 知识库 / 数据集 …
        </section>

        <section class="pnav-group" data-cat="tool" aria-expanded="false">
          … 工具 (5)：能力面板 / MCP 管理 / 终端 / 文件浏览器 / API 调试 …
        </section>
      </nav>
    </aside>

    <!-- 中部主区 -->
    <main class="shell-main">
      <div class="shell-stream">…消息流…</div>
      <div class="shell-input">…输入区…</div>
    </main>

    <!-- 右侧面板区：渲染当前激活的二级条目对应内容 -->
    <aside class="shell-panel">
      <div class="panel-body">…激活面板内容…</div>
    </aside>

    <div class="drawer-mask"></div>
  </div>
  <script>/* 手风琴展开/收起、激活切换、抽屉开合、≤768px 断点模拟 */</script>
</body>
```

原型要点：

1. 示例面板总数 ≥10（对话 2 + 开发 3 + 数据 4 + 工具 5 = 14），演示「面板很多时一级分类仍只有 4 行」。
2. 二级条目内容用占位卡片即可，重点是导航交互与状态切换。
3. 样式只使用既有主题 token（`--bg` `--bg-panel` `--bg-hover` `--border` `--text` `--text-dim` `--accent` `--accent-soft` `--radius`），不引入新颜色体系。
4. 激活视觉：一级分类激活 = `--accent-soft` 背景；二级条目激活 = `--accent-soft` 背景 + 左侧 2px accent 边（与 `.chat-session-item.active` 语言一致）。

---

## 4. 移动端表现

- **承载方式**：≤768px 时左侧栏整体变抽屉（复用现有 `setDrawer('sidebar')` / `.shell-sidebar.open` 机制），双层导航随之进入抽屉，不新增独立移动端导航形态，保证两端心智一致。
- **顶栏入口**：现有 ☰ 按钮即导航入口，无需新增按钮；⚙ 仍开右侧面板抽屉。
- **手风琴在抽屉内**：一级分类行高 ≥44px 触摸目标；二级条目高 ≥40px，全宽可点。默认仅展开「当前激活面板所属分类」，减少抽屉内滚动。
- **点击即收**：点击任意二级条目后 `setDrawer('none')` 收起抽屉（对齐现有 `SlotLayout` 中点击 `.chat-session-item` 收抽屉的行为；需把选择器扩展到 `.pnav-item`，或由导航组件直接调用 `layout.openDrawer('none')`）。
- **状态保持**：展开分类、激活面板 id 存模块级 store（不随抽屉卸载重建），抽屉开合、横竖屏切换均不丢状态；并经 `cap.config` 跨会话持久化。
- **极窄屏（≤360px）**：抽屉宽度 88vw 不变；分类名超长省略号截断；计数徽标保留。
- **降级**：若浏览器不支持 `aria-expanded` 动画，退化为直接显隐（`hidden` 属性），功能不受影响。

---

## 5. 与现有 SlotLayout/SlotOutlet 的对接点（文件级）

| 文件 | 改动 | 说明 |
|---|---|---|
| `src/core/types.ts` | `SlotDescriptor` 增加可选 `category?: string`；新增 `PANEL_CATEGORIES` 常量（key/名称/图标） | 契约单点；`SlotEntry extends SlotDescriptor` 自动携带 category，`SlotRegistry.register` 的 `{...d, pluginId}` 透传，无需改注册逻辑 |
| `src/core/slotRegistry.ts` | 新增 `listByCategory(slot): Map<category, SlotEntry[]>` 聚合方法与 `onChange(fn)` 订阅 | 现有 `list(slot)` 保留；聚合规则：按 category 分组、组内按 `order`→pluginId 排序，未声明归 `tool` 且排后 |
| `src/core/hostRuntime.ts` | `registerPlugin`/卸载路径末尾触发 `slots.onChange` 通知 | 支撑动态注册插件后导航徽标与列表响应式刷新（当前 `SlotRegistry` 是静态快照，无通知） |
| `src/core/panelNavStore.ts`（新建） | 模块级 store：`activePanelId`、`expandedCats`、subscribe/setters | 仿 `SlotLayout.tsx` 内 `layoutListeners` 模式；导航与 SlotOutlet 共享激活态 |
| `src/core/PanelNav.tsx`（新建） | 双层导航组件：读 `host.slots.listByCategory('panel')` + `host.getManifest(e.pluginId)?.name` 渲染；「对话」分类额外并入 sidebar 槽的会话入口 | 面板名复用 manifest.name（与现 tab 命名同源）；点击条目写 `panelNavStore.setActivePanelId`；移动端点击后 `layout.openDrawer('none')` |
| `src/core/SlotOutlet.tsx` | panel 槽 `useTabs` 分支改为**受控激活**：优先读 `panelNavStore.getActivePanelId()` 匹配 entries；导航未挂载/无匹配时回退现有 `useState(0)` 逻辑 | 保持向后兼容：无分类、无导航时行为与现在完全一致；`slot-tabbar` 代码路径保留为降级形态 |
| `src/core/SlotLayout.tsx` | `shell-sidebar` 内、`<SlotOutlet slot="sidebar" />` 之前渲染 `<PanelNav />`；抽屉点击关闭选择器扩展 `.pnav-item`（或交给 PanelNav 自理） | 品牌区不动；四槽 grid 不动；门禁逻辑不动 |
| `src/styles.css` | 新增 `.pnav-*` 系列样式（分类行/徽标/chevron/二级条目/展开动画），全部使用现有 token；移动端断点内补触控目标尺寸 | 不改既有类；`.slot-tabbar` 样式保留供降级路径 |
| `plugins/*/index.ts`（cap-panel、model-admin 等） | manifest 的 panel slot descriptor 补 `category` 声明 | cap-panel→`tool`，model-admin→`data`；未补声明的插件自动落 `tool` 兜底，不阻塞 |

关键对接约束：

- **核心零插件引用不变**：PanelNav 只依赖 `host.slots` / `host.getManifest` / `panelNavStore`，不 import 任何具体插件。
- **激活态单一权威**：激活面板 id 的唯一写入口是 `panelNavStore.setActivePanelId`；SlotOutlet 只读。避免出现「tab 内部 state 与导航各记一份」的双写漂移。
- **会话列表特例**：会话列表仍由 chat-lite 经 sidebar 槽贡献（`SessionSidebar` 组件不动）；PanelNav 的「对话」分类通过**布局位置**与其相邻（或把 SessionSidebar 渲染于对话分组展开区内，二选一，原型先采用「对话分类的二级条目点击 = 聚焦会话区，会话列表常驻侧栏下部」的简化形态，见第 6 节边界）。

---

## 6. 风险与边界

1. **SlotOutlet 激活态提升的兼容风险**：现 `activeIdx` 是组件内 `useState`。改受控时若处理不当，无导航场景会回归。对策：保留内部 state 作为回退，仅当 `panelNavStore` 有明确匹配项时走受控分支；补 vitest 覆盖「无导航时 tab 仍可用」。
2. **SlotRegistry 无变更通知**：当前 `list()` 是快照，动态注册插件后导航不会自动刷新。对策：给 `SlotRegistry` 加最小 `onChange` 订阅（改动 ~10 行），或由 `hostRuntime.registerPlugin` 广播内部事件。不引入全局状态库。
3. **会话列表与新导航的_space 争用**：260px 侧栏要同时容纳导航与会话列表，小屏高度下会话列表可能被压扁。对策（二选一，原型验证后定）：a) 会话列表作为「对话」分类展开后的二级内容，收起时让位给其他分类；b) 导航在上、会话列表 `flex:1` 常驻在下。方案默认 a，因其在「会话很多 + 面板很多」时仍只有一个滚动容器。
4. **一级分类本身膨胀**：本方案治「面板多」，不治「分类多」。若未来内置分类 >6，一级行也会拥挤——届时应合并语义相近分类，或叠加 S1 的「更多」收纳，本方案不承诺无限扩展。
5. **旧插件无 category 声明**：升级初期所有未声明面板集中落「工具」，该分类可能临时偏长。属可接受的视觉回退；dev 模式徽标提示作者补声明。
6. **协议契约变更**：`SlotDescriptor.category` 是对插件 manifest 契约的扩展。虽是可选字段（向后兼容），仍需在插件仓样例中同步示例，避免第三方插件不知晓该能力。
7. **无障碍**：手风琴需 `aria-expanded`/`aria-controls`/`role="tree"`，键盘可达（Enter/Space 触发，`focus-visible` 样式）；原型阶段至少保证语义属性正确。
8. **不做的事**：不做三级导航；不做拖拽排序（归 S3 路线）；不做分类内搜索的完整实现（仅预留输入框位）；不改四槽布局框架与门禁流程。

---

## 7. 实施步骤清单

原型阶段（不接宿主）：

- [ ] P1. 建 `prototypes/sidebar-S2.html` 单文件原型：四槽壳 + 双层导航 + 14 个示例面板 + 手风琴交互 + ≤768px 抽屉模拟。
- [ ] P2. 自测清单：展开/收起、单开记忆、激活切换、移动端点击收抽屉、10+ 面板不溢出、≤360px 不破版。

宿主落地阶段（冠军方案胜出后）：

- [ ] H1. `types.ts`：`SlotDescriptor.category` + `PANEL_CATEGORIES` 常量（含中文名/图标）。
- [ ] H2. `slotRegistry.ts`：`listByCategory` 聚合 + `onChange` 订阅；`hostRuntime.ts` 注册/卸载后触发通知。
- [ ] H3. 新建 `panelNavStore.ts`（激活 id + 展开分类 + subscribe）与 `PanelNav.tsx`（双层导航组件，读 manifest.name 与 category）。
- [ ] H4. `SlotOutlet.tsx`：panel 槽激活态受控化（读 `panelNavStore`，保留内部 state 回退）。
- [ ] H5. `SlotLayout.tsx`：sidebar 内挂载 `<PanelNav />`；抽屉点击关闭行为接入 `.pnav-item`。
- [ ] H6. `styles.css`：`.pnav-*` 样式（token 化，移动端触控目标 ≥40px）。
- [ ] H7. 现有插件 manifest 补 `category`（cap-panel→tool，model-admin→data）；会话列表与「对话」分类的共存形态按第 6.3 条结论定稿。
- [ ] H8. 持久化：展开分类/激活面板写 `cap.config` namespace `panel-nav`（复用 config-manager 提供方）。
- [ ] H9. 验证：`pnpm exec tsc --noEmit`、`pnpm lint`、`pnpm test:run` 全绿；手动验证桌面三栏与 ≤768px 抽屉两种形态；确认「无分类声明时退化为现有 tab 栏」的回退路径可用。
