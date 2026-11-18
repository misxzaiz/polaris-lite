# S1 · 固定图标栏 + 溢出收纳（左侧面板导航方案）

> 对应总纲：`docs/sidebar-schemes/brief-sidebar.md` 路线 S1。
> 参考实现：`src/core/SlotLayout.tsx`（四槽壳）、`src/core/SlotOutlet.tsx`（panel 槽 Tab 逻辑）、`src/styles.css`（`.shell-sidebar` / `.slot-tab*` / 移动端抽屉）。

## 0. 一句话方案

侧栏左缘放一条**固定宽度（48px）的竖向图标栏**，承载全部面板入口；可见容量按容器高度动态计算，**放不下的图标一律收进底部常驻的「更多 ⋮」按钮**，点击弹出浮层（桌面）/ 抽屉（移动端）列出剩余面板。图标栏宽度恒定、不换行、不滚动，从结构上消灭「挤压变形」。

---

## 1. 交互结构图（文字图）

```
桌面（>768px）四槽结构（对齐现有 .polaris-lite-shell grid）：

┌──────────────────────────────────────────────────────────────────────┐
│ ┌────┐ ┌───────────────┐ ┌──────────────────────┐ ┌───────────────┐ │
│ │图标栏│ │  会话列表区    │ │      消息流区         │ │   面板内容区   │ │
│ │48px │ │  (sidebar     │ │      (stream)        │ │  (panel 槽)   │ │
│ │     │ │   槽剩余部分)  │ │                      │ │               │ │
│ │ [◇] │ │               │ │                      │ │               │ │
│ │ [◇] │ │  会话 item     │ │      消息气泡…        │ │  当前激活面板  │ │
│ │ [◇] │ │  会话 item     │ │                      │ │  的插件内容   │ │
│ │ [◇] │ │  会话 item     │ │                      │ │               │ │
│ │ [⋮]←┼─┼──「更多」按钮常驻底缘，点击弹浮层                │ │               │ │
│ └────┘ └───────────────┘ └──────────────────────┘ └───────────────┘ │
└──────────────────────────────────────────────────────────────────────┘

图标栏内部（无滚动、无换行，容量 = f(高度)）：

┌──────────┐
│ brand 缩略│  ← 可选：品牌点（.brand-dot 缩为图标）
├──────────┤
│ 面板 1 ◇ │  ← 可见区：按 order 排序取前 N-1 个
│ 面板 2 ◇ │
│ 面板 3 ● │  ← ● = 激活态（accent 色 + 左侧指示条）
│  …       │
│ 面板 N-1◇│
├──────────┤
│ ⋮ 更多 ●│  ← 常驻；若激活面板被收纳，⋮ 上挂 accent 小圆点
└──────────┘
      │ 点击
      ▼
┌─────────────────┐
│ 浮层（桌面，锚定 │
│ 在 ⋮ 右上方）    │
│ ─────────────── │
│ 面板 N   ◇      │
│ 面板 N+1 ●      │  ← 图标 + 名称 + 激活标记；点击即切换并收起
│ 面板 N+2  ◇     │
│ ─────────────── │
│ ＋ 管理面板…    │  ← 可选扩展位
└─────────────────┘

移动端（≤768px）：图标栏随 .shell-sidebar 一起抽屉化；「更多」浮层
改为贴底的 action-sheet（见 §4）。
```

事件顺序（切换一个被收纳的面板）：

```
用户点击浮层内「面板 X」
  → 设置 activePanelId = X
  → 重算可见容量：若 X 不在可见区，把 X 与可见区末位图标对调（钉住激活项）
  → 关闭浮层 → panel 槽渲染 X 的插件组件 → 图标栏/浮层同步激活态
```

---

## 2. 收纳规则

### 2.1 什么条件进「更多」

- **容量判定**：`visibleMax = floor((iconbarHeight - moreBtnHeight - padding) / itemHeight)`。`itemHeight` 取 44px（含 4px 间距），`moreBtnHeight` 44px。用 `ResizeObserver` 监听图标栏容器，窗口缩放/侧栏高度变化时重算。
- **收纳规则**：排序后的面板列表中，**索引 ≥ visibleMax 的条目全部进「更多」**；可见区永远给「更多」按钮预留 1 个坑位，因此可见面板数 = visibleMax - 1（visibleMax 至少为 2，保证极端矮窗口下也有 1 个可见 + 1 个更多）。
- **激活钉住（pinned-active）**：若当前激活面板落入收纳区，则将它**提升到可见区末位**，把原本末位的可见面板挤进「更多」。保证「正在用的面板永远一键可达」。
- **不进图标栏的东西**：会话列表、设置、登录/登出等非「面板切换」动作不占图标坑位，仍走 sidebar 槽原插件（如 chat-lite 的 SessionSidebar）。

### 2.2 排序规则

1. 一级：沿用现有 `SlotDescriptor.order`（`src/core/types.ts`）升序，未填 order 按 0，稳定排序（与 `SlotRegistry.list` / `SlotOutlet` 现行为一致）。
2. 二级：同 order 按插件 id 字典序，保证渲染稳定不跳动。
3. 原型阶段不做用户自定义排序/拖拽（那是 S3 的卖点，S1 保持简单）；但保留 `data-panel-id` 属性，为后续「常用置顶」留钩子。

### 2.3 激活态如何显示

- **可见区激活项**：图标变 accent 色 + 背景用 `--accent-soft` 圆角块 + 左缘 2px accent 指示条；`aria-selected="true"`。
- **被收纳的激活项**：浮层内对应行高亮；同时「更多 ⋮」按钮挂一个 6px accent 圆点（badge），提示「激活的面板在更多里」。
- **tooltip**：可见图标 hover/focus 显示面板名（`title` 或自绘 tooltip）；浮层内则图标+全名并列，弥补图标语义不清的问题。
- **切换后**：激活面板若原本在收纳区，按 §2.1 钉住规则移入可见区；浮层关闭。

---

## 3. 原型页面结构说明（HTML 骨架，单文件可直开）

```
<body>
  <div class="shell" data-layout="four-slot">          <!-- 对齐 .polaris-lite-shell -->
    <aside class="shell-sidebar">                      <!-- 对齐现有 .shell-sidebar -->
      <div class="iconbar" data-overflow="s1">
        <div class="iconbar-brand">●</div>             <!-- 品牌缩略 -->
        <div class="iconbar-list" role="tablist">      <!-- 可见面板图标（JS 按容量裁剪） -->
          <button class="iconbar-item active" role="tab"
                  data-panel-id="chat" title="对话">◇</button>
          <button class="iconbar-item" role="tab"
                  data-panel-id="models" title="模型管理">◇</button>
          <!-- …前 N-1 个… -->
        </div>
        <div class="iconbar-more-wrap">
          <button class="iconbar-more" aria-haspopup="listbox"
                  aria-expanded="false" title="更多面板">⋮</button>
          <span class="iconbar-more-dot"></span>        <!-- 收纳区有激活项时显示 -->
        </div>
      </div>

      <div class="sidebar-body">                        <!-- sidebar 槽剩余：会话列表 -->
        <div class="session-new">＋ 新会话</div>
        <div class="session-list">
          <div class="session-item active">会话标题…</div>
          <!-- …≥10 条示例会话… -->
        </div>
      </div>
    </aside>

    <main class="shell-main">
      <section class="shell-stream">…消息气泡…</section>
      <section class="shell-input"><textarea></textarea><button>发送</button></section>
    </main>

    <aside class="shell-panel">
      <div class="panel-body" data-active-panel="chat">…激活面板内容…</div>
    </aside>

    <div class="more-popover" role="listbox" hidden>    <!-- 桌面浮层，锚定 ⋮ -->
      <div class="more-popover-title">更多面板</div>
      <button class="more-item" role="option">◇ 面板 N</button>
      <!-- …收纳区面板，含激活高亮… -->
    </div>

    <div class="more-sheet" hidden>                     <!-- 移动端底部抽屉 -->
      …同浮层条目，底部安全区 padding…
    </div>

    <div class="drawer-mask" hidden></div>              <!-- 点遮罩收浮层/抽屉 -->
  </div>
  <script> /* 容量计算 + 钉住激活 + 浮层/抽屉开合，~150 行原生 JS */ </script>
</body>
```

原型要求：构造 **12 个示例面板**（对话、模型管理、cap 状态、配置、凭据、日志、图表、任务、知识库、集成、审计、关于），会话列表 ≥10 条；把浏览器窗口高度调低可现场演示「可见数变少 → 更多接收」。

---

## 4. 移动端表现（≤768px）

- **图标栏随侧栏抽屉化**：`.shell-sidebar` 已是 `position: fixed; transform: translateX(-100%)` 的抽屉（见 `styles.css` 媒体查询）。S1 不改变这一结构，图标栏是抽屉内的第一列（宽 44px，触摸目标 ≥40px）。
- **「更多」从浮层变底部 action-sheet**：移动端弹出贴底抽屉（`bottom: 0; width: 100%; max-height: 60vh; border-radius: 12px 12px 0 0`），带 `env(safe-area-inset-bottom)` 安全区；条目行高 ≥48px，便于点按。
- **顶栏入口**：手机端可额外在 `.shell-topbar` 右侧把现有「⚙ 能力面板」按钮语义升级为「打开面板抽屉」，点开后侧栏抽屉内即是图标栏 + 会话列表；避免二次点击。
- **遮罩与滚动锁定**：复用现有 `.drawer-mask` 与 `setDrawer` 的 body overflow 锁定逻辑；浮层/抽屉打开时 `aria-expanded` 同步。
- **极窄屏（≤360px）**：图标栏保持 40px；会话列表列宽自适应收缩（现有 `width: 88vw` 规则继续生效）。

---

## 5. 与现有 SlotLayout / SlotOutlet 的对接点（文件级）

| 文件 | 对接点 |
|---|---|
| `src/core/SlotLayout.tsx` | `.shell-sidebar` 内、`<SlotOutlet slot="sidebar" />` 之前插入 `<SidebarIconBar />`（新组件）；侧栏改为「图标栏列 + sidebar 槽」横向 flex。移动端抽屉开合仍走本文件的 `setDrawer`/`useDrawer`，S1 复用不改动其状态机 |
| `src/core/SlotOutlet.tsx` | panel 槽现有 `useTabs`（`slot-tabbar` 平铺 Tab）逻辑**保留但不再增长**：当接入图标栏后，panel 槽条目 >1 时由图标栏接管切换；`SlotOutlet` 需要暴露受控激活（从 context/props 读 activePanelId），或新增 `renderActiveOnly` 分支只渲染激活条目。tab 名取 `host.getManifest(e.pluginId)?.name` 的逻辑移到图标栏 tooltip |
| `src/core/slotRegistry.ts` | 数据源不变：`host.slots.list('panel')` 取条目，`(order ?? 0)` 稳定排序；S1 的可见/收纳切分是**纯展示层裁剪**，不改注册表结构 |
| `src/core/types.ts` | `SlotDescriptor` 无需新增字段；可选追加 `icon?: string`（lucide 名或 emoji），缺省用首字母块，向后兼容旧插件 |
| `src/core/hostRuntime.ts` | `host.getManifest` 提供面板名/图标；若做图标字段则在此透出 |
| `src/styles.css` | 新增 `.iconbar*` 系列；调整 `.shell-sidebar` 为 `flex-direction: row`（图标栏列 + 原 column 内容）；`.slot-tab*` 样式保留（向后兼容）但 panel 槽不再平铺；移动端媒体查询内补 `.more-sheet` 与触摸目标规则 |
| `plugins/*`（cap-panel、model-admin、mock-auth 等） | **零改动**：插件仍只声明 `contributes.slots: [{ slot: 'panel', … }]`；图标栏自动收录 |

关键约束：S1 是**壳层展示层改造**，不改 cap 总线、不改插件契约、不改 auth 门禁；`SlotOutlet` 的多实例渲染语义（按 order 排序、key=`pluginId-component`）原样保留。

---

## 6. 风险与边界

1. **激活态双源**：图标栏激活 id 与 `SlotOutlet` 内部 `useState(activeIdx)` 若各自维护会失步。必须把 activePanelId 提升为单一权威（context 或轻量 store），`SlotOutlet` 只消费。**这是本次改造最主要的回归点。**
2. **容量抖动**：窗口高度在临界值附近变化会导致图标在「可见/更多」间来回跳。对策：容量计算结果做 1 帧延迟 + 高度变化 ±1 项才重排；或对 `visibleMax` 做滞回（进入收纳比退出收纳阈值高 4px）。
3. **插件无图标语义**：缺省首字母块在 12+ 面板时辨识度下降。边界：原型阶段接受；宿主落地时在 `LiteManifest` 补 `icon` 字段并给 lucide 白名单。
4. **浮层遮挡/裁剪**：`.slot` 有 `isolation: isolate`（限制插件 z-index 逃逸），浮层必须挂在 shell 根层级（与 `.drawer-mask` 同级 z-index ≥35），不能挂在某个 `.slot` 内部，否则可能被裁剪。
5. **可达性**：浮层需支持 Escape 关闭、点击外部关闭、`role="listbox"/option"`、焦点返回 ⋮ 按钮；原型阶段至少做到 Escape + 遮罩关闭。
6. **不做的事（边界）**：不做拖拽排序、不做用户自定义分组、不做图标栏横向模式、不改会话列表内部交互（那些属于 S2/S3 路线）。
7. **SSR/首帧**：容量依赖测量，首帧先渲染前 6 个（保守值）+ ⋮，`ResizeObserver` 就绪后再校正，避免闪烁。

---

## 7. 实施步骤清单

原型（本次产物，单文件 `prototypes/sidebar-s1.html`）：

- [ ] 1. 搭四槽骨架 + 深色主题变量（对齐 `styles.css` 的 `--bg/--bg-panel/--accent` 等 token 值）
- [ ] 2. 实现 `iconbar`：固定 48px、`ResizeObserver` 容量计算、按 order 渲染前 N-1 个 + 常驻 ⋮
- [ ] 3. 实现「更多」浮层（桌面）：锚定 ⋮、列出收纳面板、激活高亮、badge 圆点、Escape/遮罩关闭
- [ ] 4. 实现钉住激活规则：点击收纳面板 → 与可见末位对调 → 关浮层 → 右侧 panel 内容切换
- [ ] 5. 移动端：≤768px 侧栏抽屉化 + ⋮ 改底部 action-sheet + 安全区
- [ ] 6. 构造 12 面板 + 10 会话的示例数据；压低窗口高度验证溢出降级
- [ ] 7. 自测清单：10+ 面板不换行不溢出；激活项永远可见或 badge 提示；键盘 Escape 可关浮层；≤360px 不破版

宿主落地（后续，若该方案胜出）：

- [ ] 8. 新增 `src/core/SidebarIconBar.tsx`：读 `host.slots.list('panel')`，输出可见/收纳两组条目
- [ ] 9. `SlotLayout.tsx` 侧栏改双列；`SlotOutlet.tsx` panel 槽改受控激活（activePanelId 上提）
- [ ] 10. `styles.css` 增补 `.iconbar*`、`.more-popover`、`.more-sheet`；跑 `pnpm typecheck` + `pnpm lint`
- [ ] 11. 回归：单面板/2 面板/12 面板三档；移动端抽屉；auth 门禁态下不渲染图标栏
