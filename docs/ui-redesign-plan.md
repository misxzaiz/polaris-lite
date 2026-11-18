# UI 重设计汇总报告（输入区 + 模型供应商面板）· 仅设计，未实施

> 产生方式：3 个设计 agent 并行（A=输入区交互、B=模型面板控制台、C=壳层 token 体系），各自实读源码后产出；本报告做交叉校验、冲突仲裁与统一实施清单。
> 依据：docs/shot-02/03/04/06/07/08/09 截图审计 + 几何实测 + docs/ui-redesign-brief.md。

---

## 一、三方案要点

### A · 输入区（chat-lite）
- **形态**：对齐 Polaris chat-desk 的「一体化 Composer 卡片」——输入区从裸条变为悬浮圆角卡片（bg 底、1px 边框、radius 12、margin 10/16），textarea 无边框内嵌，边框/聚焦环作用在卡片整体。
- **塌缩根因修正**：`flex-direction:column` 本身没错，错在宿主遗留的 `align-items:flex-end` 在纵向布局下变成横向收缩。修复 = 卡片补 `align-items:stretch`，textarea `width:100%; min-width:0`。
- **高度统一**：CSS `max-height` 140→200 与 JS `MAX_HEIGHT=200` 对齐；首选 CSS `field-sizing: content`（WebView2 支持），JS 只做旧内核兜底并补 2px 边框口径（scrollHeight 不含 border）。
- **三态**：空态（禁用发送+ghost 附件钮）/ 流式态（停止红实心独占 + 边框呼吸 + 顶缘流光线）/ 排队态（`:has(.queue)` 让停止降级 danger 描边、排队升实心主按钮）。
- **按钮体系**：新增 `--danger/--danger-soft/--ring/--radius-lg/--control-h` token；主按钮 34px 高、min-width 72；focus-visible 双环。
- **移动端**：安全区移到 `.shell-input`；`--control-h:42px`；textarea max-height 120；附件条横滚。

### B · 模型供应商面板（model-admin）
- **卡片三段式**：head（名称+徽标｜开关）/ body（baseURL、key、模型 chips ≤4 折叠 +N）/ test-line（状态行）/ foot（编辑、测试 + 「更多」菜单收纳：识别能力/设默认/删除）。5 按钮减为 2+菜单。
- **Tab 修复**：`.slot-tab { flex:1 1 0; min-width:0; height:40px; line-height:38px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis }` + tabbar `overflow-x:auto` 兜底。55px→40px 单行。
- **cap-grid**：`grid-template-columns: 68px minmax(0,1fr)`（label 固定列），控件统一 `height:26px; box-sizing:border-box`；select `appearance:none` 自绘箭头 + `padding-right:22px`；**checkbox 排除规则**（修复勾选框被输入框通配样式拉伸）。
- **表单规范**：新增 `--ctl-h:30px / --ctl-h-sm:26px / --ctl-font / --ctl-radius:6px / --ctl-focus-ring` + 语义色 `--danger/--ok/--warn/--neutral-soft`；勾选行 checkbox `flex:0 0 auto; margin:0`（修复「设为默认」重叠）。
- **识别异步态**：按钮 `aria-busy=true` + CSS 转圈 + `pointer-events:none` 防重复点击；结果从裸 `pre` 改为结构化 `ma-detect-report`（结论行 + 逐模型小节 + 来源徽标 + 提示行）。
- **徽标语义映射**：人工=蓝实底 / 实测=绿实底 / 内置表=灰实底 / 图=蓝描边 / 思=橙 / 上下文=灰描边 / +N=灰。
- **删除确认**：不引 modal，行内两段式（`.danger.arm` 红底「确认删除？」，3s 超时回退）。

### C · 壳层与 token 体系
- **token 扩展**：9 存量 + 21 新增（`--plite-` 前缀）：间距 5 档（4/8/12/16/24）、控件高 3 档（28/36/44）、字号 4 档（11/12/13/16）、语义色 4、focus-ring、shadow-1、动效 2 时长+1 曲线。总量 30。
- **断点体系**：默认 260/`minmax(0,1fr)`/300；≥1440 右栏 360；900–1199 右栏收 48px 图标栏；768–899 侧栏 56px 图标栏；≤767 全抽屉。中栏内容 `max-width:820px` 居中。
- **空态**：logo 方块 + 标题 + 副标题 + 4 个快捷建议 chips（点击填入输入框）+ 1px 渐变引导线垂向输入区。
- **移动端抽屉**：z-index 体系（scrim 190/drawer 200）、260ms 滑入（iOS 曲线）、⚙ `aria-pressed` 激活态（必修）、`.plite-scroll-lock` 滚动锁、手势关闭规范。
- **落地策略**：独立 `plite-tokens.css`（不动 styles.css 的 :root）；插件经构建期 `@import` 消费，禁止插件重定义 `--plite-*`；壳层兜底样式用 `:where()` 压低特异性，从机制上防「插件覆盖壳层」复发。

---

## 二、交叉校验与冲突仲裁

| 冲突点 | A | B | C | 仲裁 |
|---|---|---|---|---|
| 语义色命名 | `--danger/--warning/--ring` | `--danger/--ok/--warn/--neutral-soft` | `--plite-success/warning/danger/info` | **采 C 的 `--plite-*` 前缀为唯一 token 源**；A/B 的同名变量视为别名过渡（`:root { --danger: var(--plite-danger) ... }`），两插件 CSS 原样可跑，后续迁干净 |
| 控件高度 | `--control-h:34px`（输入区按钮） | `--ctl-h:30px / --ctl-h-sm:26px`（表单） | `--plite-h-sm/md/lg = 28/36/44` | 三套并存会造成新的不一致。统一映射：`--plite-h-sm=28`(面板小按钮/cap-grid 控件 26→28)、`--plite-h-md=36`(表单主输入/普通按钮 34→36)、`--plite-h-lg=44`(移动端触控/主输入条)。B 的 26/30 并入 28/36，A 的 34 并入 36 |
| textarea 上限 | 200px（与 JS 一致） | — | — | 采 A：CSS max-height 200 = JS MAX_HEIGHT 200，单一事实来源 |
| 面板宽度 | — | 以 268px 可用宽为基准设计 | ≥1440 右栏 360 | 兼容两者：先按 300px 落地 B 的栅格；≥1440 加宽到 360 后 cap-grid 可升两列（后续增强，不阻塞） |
| tab 高度 | — | 40px/38px line-height | — | 采 B |
| 圆角 | `--radius-lg:12px`（composer 卡片） | `--ctl-radius:6px`（控件） | 沿用 `--radius:8px` | 三档圆角成立：`--radius`(8) 控件/消息、`--radius-lg`(12) composer 卡片、控件内部小件 6px 并入 `--radius` 不单列（减少 token 数） |
| 聚焦环 | `0 0 0 3px var(--ring)` | `--ctl-focus-ring: 0 0 0 2px accent-soft` | `--plite-focus-ring: 0 0 0 2px rgba(91,140,255,.45)` | 采 C 单一定义 `--plite-focus-ring`，A 的双环（外圈 bg-panel）用于 composer 卡片局部，作为特例保留 |

**结论**：三方案无根本冲突，可合并为一个实施包；差异都在 token 命名与档位归并，已给出统一口径。

---

## 三、统一实施清单（按依赖排序，每步可独立验证）

**P0 · token 与防回归机制**（C）
1. 新建 `src/plite-tokens.css`：21 个 `--plite-*` token + 存量 9 token 兜底重申 + 语义别名（`--danger: var(--plite-danger)` 等兼容别名，供 A/B 现有 CSS 过渡）。
2. 壳层兜底样式改写为 `:where(.plite-slot ...)` 特异性隔离（防插件覆盖复发）。

**P1 · 输入区修复 + 重设计**（A）
3. `chat-input.css` 全量替换：Composer 卡片（align-items:stretch 修塌缩、margin 浮起、focus-within 环）。
4. textarea：`width:100%; min-width:0; max-height:200px; field-sizing:content; line-height:1.55; overflow-y:auto`；宿主 styles.css 同步 max-height 200。
5. `ChatInput.tsx`：field-sizing 支持检测 + JS 兜底补 2px 边框口径（约 6 行改动）。
6. 按钮组：`--control-h`→`--plite-h-md`；发送/附件/停止/排队四态 + `:has(.queue)` 双按钮层级让位。
7. 流式氛围：边框呼吸 + 顶缘流光 + 停止中呼吸（含 prefers-reduced-motion 关停）。

**P2 · 模型面板重设计**（B）
8. styles.css：slot-tab 收缩省略（40px 单行）+ tabbar 横滚兜底。
9. 列表卡片三段式改造（head/body/test-line/foot + 更多菜单），识别能力与删除收进菜单。
10. cap-grid：68px label 固定列 + 控件 28px 统一高 + select 自绘箭头 + checkbox 排除规则。
11. 表单控件统一 `--plite-h-md`/focus 环/box-sizing；勾选行 flex 修正。
12. 识别 busy 态（aria-busy + 转圈 + pointer-events:none）+ 结果结构化 `ma-detect-report`（替代裸 pre）。
13. 徽标语义配色（t-manual/t-probe/t-builtin/t-vision/t-effort/t-ctx）+ chips ≤4 折叠。
14. 删除两段式确认（danger.arm）。

**P3 · 壳层与移动端**（C）
15. 空态重设计：logo + 标题 + 快捷建议 chips（点击填入输入框并聚焦）+ 引导线。
16. 断点体系落地（minmax(0,1fr)、≥1440 面板 360、中栏 820px 容器）。
17. 移动端：⚙ aria-pressed 激活态、抽屉 z-index/动画/滚动锁、安全区移到 shell-input、viewport meta `interactive-widget=resizes-content`。

**验证方式**：每步后跑 `npx tsc --noEmit` + `node plugins/build-plugins.mjs` + Playwright 截图对比（1440/1024/390 三档宽度），重点回归：输入区满宽、textarea 无裁切、tab 单行、面板表单不贴边、识别 busy 态、删除确认。

## 四、暂不做（记录备查）
- 附件 📎 emoji 换 SVG 图标（缩小本期改动面）
- `.chat-queue-pill` 死样式清理（随下期队列可视化一起）
- tab `shortName` manifest 契约扩展（CSS 方案已够用）
- 900–1199 图标栏交互（先保持 300px 栏 + 抽屉现状，断点体系先落 grid 值）

---

## 附：三份原始设计
- A 输入区：含完整替换版 chat-input.css 与 ChatInput.tsx 6 行配套
- B 模型面板：含 panel.css 完整改动集（A~H 分块）与 Panel.tsx 交互位清单
- C 壳层：含 plite-tokens.css 全量定义、断点 grid 值、空态/抽屉规范
（原文见各 agent 输出，已并入本报告仲裁结论；实施时以本报告「统一实施清单」+ 各方案 CSS 原文为准。）
