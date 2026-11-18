# S3 方案：可滚动分组 + 置顶收藏（左侧面板导航）

> 路线代号：S3（对应 `brief-sidebar.md` 路线表第三行）。
> 核心思路：图标栏**可纵向滚动**、**按分组分段**；**常用/收藏置顶**，其余按分组折叠；支持置顶/收藏交互（原型简化为点击置顶，拖拽排序后续增强）。
> 产物形态：单文件可交互 HTML 原型（`prototypes/sidebar-S3.html`，≥10 个示例面板）+ 本设计说明。不直接改动宿主源码。

---

## 1. 交互结构图（文字图）

```
┌────────────────────────── 左侧 sidebar（宽度 260px，桌面） ──────────────────────────┐
│ ┌────────────────────────────────────────────────────────────────────────────────┐ │
│ │ 品牌 Brand（Polaris Lite）                          [固定，不滚动]               │ │
│ ├────────────────────────────────────────────────────────────────────────────────┤ │
│ │ ① 置顶区 Pinned（收藏 + 高频）            [固定，不滚动，独立于下方滚动区]      │ │
│ │   ┌────┐ ┌────┐ ┌────┐ ┌────┐                                                 │ │
│ │   │ 💬 │ │ 📊 │ │ 🔧 │ │ +  │   点击 = 切换该面板；长按/右键/角标 ⭐ = 取消置顶   │ │
│ │   └────┘ └────┘ └────┘ └────┘                                                 │ │
│ ├────────────────────────────────────────────────────────────────────────────────┤ │
│ │ ② 分组滚动区 Groups（唯一纵向滚动容器，overflow-y: auto）                       │ │
│ │   ▾ 对话 (2)                                   ← 分组头，可折叠                 │ │
│ │       ● 会话面板 A            ⭐                                               │ │
│ │       ○ 会话面板 B                                                             │ │
│ │   ▸ 开发 (4)                                   ← 折叠态：仅分组头 + 计数        │ │
│ │   ▸ 数据 (3)                                                                   │ │
│ │   ▸ 工具 (5)                                                                   │ │
│ │   ▸ 更多插件 (N)              ← 未分组插件的兜底分组，永不消失                  │ │
│ ├────────────────────────────────────────────────────────────────────────────────┤ │
│ │ ③ 会话列表 Sessions（chat-lite 贡献，保持现状）      [固定底部区域，自身可滚动]  │ │
│ │   + 新会话                                                                     │ │
│ │   · 会话 1                                                                     │ │
│ │   · 会话 2                                                                     │ │
│ └────────────────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────────────┘

交互事件流（点击置顶）：
用户点击面板行角标 ⭐ / 置顶按钮
  → pinStore.toggle(pluginId)
  → 持久化 localStorage（polaris.sidebar.pins / polaris.sidebar.collapsed）
  → 订阅者重算渲染：该面板从所属分组移入「置顶区」（或反向移回）
  → 若原分组因此变空且非「更多插件」分组 → 该分组自动隐藏
```

布局要点：

- sidebar 纵向分四段：品牌（固定）→ 置顶区（固定）→ 分组滚动区（flex:1，唯一滚动容器）→ 会话列表（固定高度上限，内部自滚）。
- 滚动只发生在「分组滚动区」，置顶区始终可见——多面板再多，常用入口也不被挤出视口（对应 brief 痛点 1/3）。
- 面板从「tab 条挤压」改为「纵向列表」，宽度恒定 260px（移动端抽屉 78vw），数量增长只增加纵向滚动长度，不产生横向挤压。

## 2. 分组与置顶规则

### 2.1 数据结构

```ts
/** 单个导航条目：由插件 manifest 派生 */
interface NavItem {
  pluginId: string;        // 插件 id，如 'cap-panel'
  name: string;            // 展示名，取 manifest.name
  icon?: string;           // 图标（lucide 名 / emoji 兜底），缺省用 name 首字
  group: string;           // 分组 id，缺省 'misc'
  order?: number;          // 组内排序权重，缺省 100
  pinned?: boolean;        // 是否置顶（用户态，持久化）
  lastUsedAt?: number;     // 最近使用时间（用户态，点击时更新）
}

/** 分组定义：静态骨架 + 动态归并 */
interface NavGroup {
  id: string;              // 'pinned' | 'chat' | 'dev' | 'data' | 'tools' | 'misc'
  label: string;           // '置顶' | '对话' | '开发' | '数据' | '工具' | '更多插件'
  collapsed: boolean;      // 折叠态（用户态，持久化）
  items: NavItem[];
}

/** 用户侧持久化状态（localStorage 单 key，JSON） */
interface SidebarPrefs {
  pins: string[];                  // 置顶 pluginId 列表，上限 8 个，按置顶先后排序
  collapsedGroups: string[];       // 已折叠分组 id
  lastUsed: Record<string, number>;// pluginId -> 最近使用时间戳
}
```

### 2.2 分组归并规则

1. 遍历 `host.slots.list('panel')`（以及未来扩展到 sidebar 槽的导航型插件），以插件 manifest 为准生成 `NavItem`。
2. 分组来源优先级：manifest 显式声明 `contributes.nav.group` > 内置映射表（已知插件 id → 分组）> 兜底 `misc`（「更多插件」）。
3. 分组固定顺序：`对话 → 开发 → 数据 → 工具 → 更多插件`；空分组不渲染；`misc` 恒在（哪怕为空也显示占位文案，提示用户可归组）。
4. 组内排序：`order` 升序 → `lastUsedAt` 降序 → `name` 字典序。保证确定性渲染，避免每次刷新顺序跳变。

### 2.3 置顶规则

1. 置顶区独立于分组，容量上限 **8 个**；超过后提示「置顶已满，请先取消一个」（原型用 toast）。
2. 点击置顶交互（原型简化版）：条目行右侧 ⭐/☆ 按钮切换置顶；置顶后条目**移入顶部置顶区**并以图标块形式横排展示。
3. 高频自动置顶（可选增强，原型不实现）：`lastUsedAt` 距今 < 7 天且使用次数 ≥ 阈值的面板，在置顶区以「常用」半透明角标展示（不占置顶配额，仅排序提前）。
4. 取消置顶：置顶区图标块长按（移动端）/ 右键（桌面）弹出确认，或点击块上小 ×；取消后条目回到原分组原排序位。
5. 被置顶的条目从所属分组中**移除渲染**（不重复出现）；分组计数随之减少；分组因此为空且非 `misc` 时整组隐藏。

### 2.4 折叠展开规则

1. 分组头点击切换 `collapsed`；折叠态仅显示「分组名 + 计数 + ▸」，展开显示「▾ + 全部条目」。
2. **默认展开**用户置顶过的分组与当前激活面板所在分组；其余默认折叠（首次进入减少视觉噪声）。
3. 当前激活面板若位于折叠分组内，该分组强制展开并高亮条目（保证激活态永远可见，状态不丢）。
4. 折叠态持久化到 `SidebarPrefs.collapsedGroups`；切换会话/刷新页面后保持。

## 3. 原型页面结构说明（HTML 骨架层级）

单文件 `prototypes/sidebar-S3.html`，无构建依赖，浏览器直接打开。骨架：

```html
<body class="s3-body">
  <div class="s3-shell">                       <!-- 三栏 grid：sidebar | main | panel -->
    <header class="s3-topbar">…</header>       <!-- 移动端顶栏，桌面隐藏 -->

    <aside class="s3-sidebar" data-drawer="sidebar">
      <div class="s3-brand">Polaris Lite</div>          <!-- 段1 品牌（固定） -->

      <div class="s3-pinned">                            <!-- 段2 置顶区（固定） -->
        <div class="s3-pinned-head">置顶 <span class="s3-pinned-count">2/8</span></div>
        <div class="s3-pinned-row">
          <button class="s3-pin-item active">…</button>  <!-- 图标块，点击切换面板 -->
          <button class="s3-pin-item">…</button>
        </div>
      </div>

      <nav class="s3-groups">                            <!-- 段3 分组滚动区（唯一滚动容器） -->
        <section class="s3-group" data-group="chat">
          <button class="s3-group-head">                 <!-- 折叠头：名+计数+箭头 -->
            <span class="s3-caret">▾</span> 对话 <span class="s3-count">2</span>
          </button>
          <div class="s3-group-body">
            <div class="s3-item active">                 <!-- 面板条目行 -->
              <span class="s3-item-icon">💬</span>
              <span class="s3-item-name">会话面板 A</span>
              <button class="s3-item-pin">⭐</button>     <!-- 点击置顶/取消 -->
            </div>
            …
          </div>
        </section>
        <section class="s3-group collapsed" data-group="dev">…</section>
        <section class="s3-group collapsed" data-group="misc">…</section>
      </nav>

      <div class="s3-sessions">                          <!-- 段4 会话列表（固定底部） -->
        <button class="s3-session-new">+ 新会话</button>
        <div class="s3-session-item active">…</div>
        …
      </div>
    </aside>

    <main class="s3-main">
      <div class="s3-stream">…</div>                     <!-- 对齐 shell-stream -->
      <div class="s3-input">…</div>                      <!-- 对齐 shell-input -->
    </main>

    <aside class="s3-panel" data-drawer="panel">…</aside><!-- 能力面板（可简化为占位） -->
    <div class="s3-mask"></div>                          <!-- 移动端抽屉遮罩 -->
  </div>
  <script>/* 渲染 10+ 示例面板 + 置顶/折叠/移动端抽屉逻辑 */</script>
</body>
```

原型必须演示的要点：

1. **≥10 个示例面板**，分布到至少 4 个分组 + misc，其中 2 个预置为置顶，直观展示「多面板不挤压」。
2. 置顶/取消置顶、分组折叠/展开、激活面板切换三个交互闭环可演示。
3. 滚动行为：仅 `.s3-groups` 滚动；面板数量多时置顶区与会话列表始终可见。
4. 样式复用现有 token：`--bg/--bg-panel/--bg-hover/--border/--text/--text-dim/--accent/--accent-soft/--radius`，保证与现有深色主题一致（评分维度 D）。

## 4. 移动端表现（≤768px）

1. **整体结构不变，容器变抽屉**：sidebar 仍由 `SlotLayout` 的抽屉机制承载（`drawer === 'sidebar'` 时 `translateX(0)`），S3 的四段结构原样放进抽屉。
2. **抽屉宽度**：`min(78vw, 300px)`（对齐现有 `.shell-sidebar` 移动端规则）；极窄屏 ≤360px 放宽到 88vw。
3. **置顶区**：图标块横排可换行（`flex-wrap: wrap`），块尺寸 ≥40×40px 满足触摸目标；置顶满 8 个时两行排布，仍不滚动。
4. **分组滚动区**：仍是唯一滚动容器；`-webkit-overflow-scrolling: touch`；分组头点击区域高度 ≥44px。
5. **手势与粘滞**：移动端禁用 hover 高亮（对齐现有 `@media` 内 `.chat-session-item:hover { background: transparent }` 的做法）；置顶取消用长按（`touchstart` 计时 500ms）替代右键。
6. **选中即收**：点击面板条目后调用 `layout.openDrawer('none')` 关闭抽屉（对齐 `SlotLayout.tsx` 中 sidebar 点击 `.chat-session-item` 后收起的现有行为）。
7. **状态保持**：抽屉关闭不卸载 sidebar 状态；pins/折叠态在 localStorage，刷新与重进均保持。

## 5. 与现有 SlotLayout / SlotOutlet 的对接点（文件级）

> 原型阶段不改宿主；下表是**若冠军方案落地宿主**时的对接面，供评审维度 C（实现可行性）参考。

| 文件 | 对接点 | 改动性质 |
|---|---|---|
| `src/core/SlotLayout.tsx` | `<aside className="shell-sidebar">` 内、`<SlotOutlet slot="sidebar" />` 之前插入 `<SidebarNav />`（S3 导航组件）；抽屉开合、`setDrawer`、body 滚动锁均复用现有实现，不改 | 新增子组件挂载点；布局壳零改动 |
| `src/core/SlotOutlet.tsx` | S3 需要读取 panel 槽全部条目做分组：直接调 `host.slots.list('panel')` 与 `host.getManifest(pluginId)`（均为现成公开 API），不改 SlotOutlet 本身 | 只读依赖，无改动 |
| `src/core/types.ts` | `SlotDescriptor` 增加 `group?: string`、`icon?: string`（可选字段，向后兼容；未声明走内置映射/misc 兜底） | 可选字段扩展 |
| `src/core/slotRegistry.ts` | 无需改动（S3 只消费 list 结果）；若后续支持按 order+group 排序，可在 registry 层加纯函数 | 无改动 / 可选小改 |
| 新增 `src/core/SidebarNav.tsx` | S3 导航组件：置顶区 + 分组滚动区；内部管理 `SidebarPrefs`（localStorage） | 新文件 |
| 新增 `src/core/sidebarPrefs.ts` | pins / collapsedGroups / lastUsed 的读写与订阅（小 store） | 新文件 |
| `src/styles.css` | 追加 `.s3-*`（落地时命名 `sidebar-nav-*`）段落；复用现有 CSS 变量；移动端媒体查询对齐现有 768px/360px 断点 | 追加样式，不改既有规则 |
| `plugins/chat-lite/SessionSidebar.tsx` | 会话列表保持现状，仅外层被 S3 的「段4 会话列表」容器包裹（或维持由 sidebar 槽继续渲染，S3 导航置于其上） | 不改或仅包一层 |
| 各插件 manifest | 需要分组的插件在 manifest `contributes.slots[]` 里声明 `group`/`icon`；不声明也能用（落 misc 组） | 渐进采用 |

关键约束：**宿主四槽布局与抽屉机制不动**，S3 全部收敛在 sidebar 槽内部；panel 槽现有的 `slot-tabbar` Tab 逻辑（`SlotOutlet.tsx` 的 `useTabs` 分支）在 S3 落地后可由右侧面板保留（面板内容切换）或后续替换为与左侧导航联动的选中态——原型阶段二者解耦，不阻塞。

## 6. 风险与边界

1. **双入口歧义**：左侧 S3 导航与右侧 panel 槽 Tab 同时存在时，用户可能困惑「在哪切换面板」。边界：原型阶段右侧 Tab 保留；落地时明确「左侧=全局面板导航，右侧=当前面板内容」并在视觉上区分（右侧 Tab 弱化为内容头）。
2. **置顶容量与滥用**：上限 8 个，超出拒绝并提示；自动「常用」只排序不占配额，避免置顶区重新膨胀成新的「tab 条」。
3. **分组映射维护成本**：内置映射表需随插件增删同步；兜底 `misc` 组保证未映射插件可见，不会静默丢失。
4. **折叠态与激活态冲突**：激活面板所在分组被用户折叠时，以「强制展开」为准（激活可见性优先于用户折叠偏好），并在分组头显示高亮提示。
5. **滚动穿透**：唯一滚动容器限定 `.s3-groups`（对齐 `styles.css` 中 body `overflow:hidden`、`.shell-stream` 内滚的既有纪律），触摸设备上需在原型实测 `overscroll-behavior: contain` 防止链式滚动带动页面。
6. **持久化键冲突**：localStorage key 命名空间 `polaris.sidebar.*`，读写做 JSON 容错（损坏时回退默认值，不抛错白屏）。
7. **移动端长按与滚动冲突**：长按置顶手势需在移动超过阈值时取消，避免把滚动误判为长按。
8. **不解决会话列表本身的膨胀**：本方案只治理「面板导航」维度；会话数量增长是另一议题（搜索/归档），不在本方案边界内。

## 7. 实施步骤清单

原型阶段（本工作流交付物）：

- [ ] 1. 建 `prototypes/sidebar-S3.html`：按第 3 节骨架搭三栏 shell + sidebar 四段结构。
- [ ] 2. 构造 12 个示例面板数据（含 group/icon/order），覆盖 4 个业务分组 + misc。
- [ ] 3. 实现分组渲染与组内排序（order → lastUsedAt → name）。
- [ ] 4. 实现置顶交互：⭐ 切换、置顶区横排展示、上限 8、取消回组、空组隐藏。
- [ ] 5. 实现折叠/展开与持久化（localStorage），激活分组强制展开。
- [ ] 6. 接入会话列表演示数据（新会话 + 若干会话项，复用现有类名风格）。
- [ ] 7. 移动端：≤768px 抽屉化（复用现有断点与遮罩交互）、长按取消置顶、选中即收抽屉。
- [ ] 8. 自测：10+ 面板不挤压、置顶区始终可见、滚动仅发生在分组区、折叠/置顶状态刷新后保持。

落地阶段（若评审胜出，进宿主时参照第 5 节对接表）：

- [ ] 9. `types.ts` 扩展 `SlotDescriptor` 可选 `group`/`icon` 字段。
- [ ] 10. 新增 `src/core/sidebarPrefs.ts` 与 `src/core/SidebarNav.tsx`。
- [ ] 11. `SlotLayout.tsx` sidebar 段挂载 `<SidebarNav />`（位于 `<SlotOutlet slot="sidebar" />` 之前）。
- [ ] 12. `styles.css` 追加导航样式段（复用主题 token 与既有断点）。
- [ ] 13. 回归验证：`pnpm typecheck`、现有 vitest、移动端 375px/768px 视口手动验证。
