# 验收报告 A（布局越界）

> 验收范围：AI 对话交互布局是否保持 Polaris 四段式（会话侧栏 + 消息流 + 底部输入区 + 面板区）；插件是否只填槽不改布局、是否越出自身槽位几何边界（溢出 / 遮挡 / 滚动穿透 / fixed 越权 / z-index 失控）。
> 审查方式：静态代码审查，逐文件核对（src/core/SlotLayout.tsx、src/core/SlotOutlet.tsx、src/styles.css、plugins/chat-lite/*.tsx、plugins/cap-panel/index.tsx、plugins/mock-engine/index.ts、src/core/{hostRuntime,slotRegistry,bus,sessionStore,types}.ts、src/plugins/componentMap.ts、index.html）。
> 结论速览：**0 个 P0，3 个 P1，4 个 P2**。四段式结构与「核心只给四槽、插件只填槽」的约束总体成立；风险集中在移动端滚动链路与抽屉层级的健壮性上。

---

## 总体判断

- 核心侧布局由 `SlotLayout.tsx` 单点定义（grid 三栏 → 移动端单栏 + 抽屉），插件经 `SlotOutlet` 按槽位渲染，`SlotRegistry.resolve` 只取 order 最小的一个组件填槽——**插件在结构上无法改动壳布局**，符合「核心只提供四槽，插件只能填槽不能改布局」。
- 现有三个插件（chat-lite、cap-panel、mock-engine）均未使用 `position: fixed/absolute`、未设置任何 `z-index`、未操作 `document.body`/`document.documentElement` 样式，**当前无插件越权**。
- 但存在若干**潜在越界通道**：host API 暴露了可变更全局滚动状态的路径、MessageStream 的滚动联动可能穿透到页面、移动端 `100dvh` 方案对软键盘场景未做防护。均为 P1/P2 级隐患，当前不构成阻断。

---

## 逐项发现

### 1. 插件组件溢出槽位容器（长内容 / 超宽气泡 / 无换行）

**[P2] 长单词/URL 气泡在 360px 极窄屏下可能横向溢出消息流**

- 证据：`src/styles.css:179-187` `.chat-bubble` 有 `white-space: pre-wrap; word-break: break-word;`；`src/styles.css:161` `.chat-msg { max-width: 860px; }`；`src/styles.css:354` 移动端 `.chat-msg { max-width: 94%; }`。
- 分析：`word-break: break-word` + `pre-wrap` 已覆盖中英文与长 URL 换行；气泡本身无 `min-width`，不会撑破 flex 容器；`.chat-msg` 是 flex 且 bubble 未设 `flex-shrink: 0`，可正常收缩。唯一残余风险是**无空格超长串**在旧内核（`break-word` 已废弃，依赖 `overflow-wrap`）上的表现——建议补 `overflow-wrap: anywhere` 或改用标准 `overflow-wrap: break-word`。
- 影响：极小概率出现气泡横向溢出 `.shell-stream`（该容器自身 `overflow` 未裁剪，见第 2 项），表现为横向滚动或顶宽。
- 建议：`.chat-bubble` 增加 `overflow-wrap: anywhere; min-width: 0;`，并把 `word-break: break-word` 升级为标准写法。

**[已检查通过] 其余溢出路径**

- 会话侧栏标题：`SessionSidebar.tsx:21` 截取前 18 字符 + `.chat-session-item .title` 的 `overflow: hidden; text-overflow: ellipsis; white-space: nowrap`（styles.css:123-129），不会撑宽 260px 侧栏；移动端抽屉宽 `min(78vw, 300px)` 同样安全。
- cap-panel 审计行：`cap-panel/index.tsx:48-53` 仅渲染 target/action 短文本，`.cap-item`/`.cap-audit li` 均为小字号 flex，无越界风险。
- mock-engine 纯逻辑无 UI，不参与布局。

### 2. 消息流滚动是否带动页面滚动（滚动穿透）；100dvh 下输入区被顶起/遮挡

**[P1] `.shell-stream` 未设 `overflow: hidden`，`scrollIntoView` 存在滚动穿透到 body 的通道**

- 证据：`src/styles.css:65-70` `.shell-stream { flex: 1; min-height: 0; display: flex; flex-direction: column; }`——**没有 `overflow: hidden`**；真正滚动的容器是子级 `.chat-stream`（styles.css:144-151，`flex: 1; overflow-y: auto`）。`plugins/chat-lite/MessageStream.tsx:11` 调用 `bottomRef.current?.scrollIntoView({ behavior: 'smooth' })`。
- 分析：`scrollIntoView` 默认会让**所有可滚动祖先**滚动以让目标进入视口。正常情况下 `.chat-stream` 自身可滚，祖先无需动；但当消息流内容暂时不足以滚动（例如刚新建会话、或流式早期）、或 `.chat-stream` 高度计算瞬间异常时，浏览器可能滚动 `.shell-main`/`#root`/`body` 链。桌面端壳 `overflow: hidden`（styles.css:29）兜底；**移动端 `html, body { height: 100% }`（styles.css:16-22）未配 `overflow: hidden`**，一旦触发穿透，页面出现整体滚动，`100dvh` 壳被顶起，底部输入区被地址栏/工具栏遮挡——这正是「滚动穿透 + 输入区被顶起」的组合条件。
- 影响：手机端流式回复期间可能看到输入条随页面滚动漂移、被浏览器工具栏遮挡。
- 建议：双保险修复——① `.shell-stream` 增加 `overflow: hidden;`；② `html, body { overflow: hidden; }`（本应用即全屏壳，body 级滚动本就不该存在），或把 `scrollIntoView` 改为只滚 `.chat-stream`（`container.scrollTop = container.scrollHeight`），从根上消除穿透。

**[P2] 移动端键盘弹起场景未做专门防护（dvh 只解决地址栏，不解决软键盘）**

- 证据：`src/styles.css:276` `height: 100dvh`；`index.html:6` viewport 含 `viewport-fit=cover`；无 `interactive-widget=resizes-content`，也无 VisualViewport 相关处理。
- 分析：Android Chrome 上键盘默认是 `resizes-visual`，`100dvh` 不随 visual viewport 缩小，键盘会物理遮挡输入区；iOS Safari 键盘不缩小 layout viewport，输入区同样可能被盖住。这属于「输入区被遮挡」验收项的直接命中场景。
- 影响：手机端聚焦输入框时，输入条可能被软键盘整体遮挡，需滚动页面才能看到。
- 建议：viewport meta 增加 `interactive-widget=resizes-content`（Android 即时生效），iOS 端可后续用 VisualViewport 高度写入 CSS 变量做键盘补偿。P2 因为不影响桌面回归，且属移动端体验完善项。

**[已检查通过] 常规滚动 containment**

- `.polaris-lite-shell { height: 100vh; overflow: hidden }`（桌面）、移动端 `height: 100dvh` + grid `auto 1fr` + `.shell-main { min-height: 0 }`，消息流滚动被限制在 `.chat-stream` 内，正常路径无穿透。
- 抽屉打开时 `document.body.style.overflow = 'hidden'`（SlotLayout.tsx:36-41）锁 body 滚动，卸载时还原——方向正确（且当前 body 本无滚动内容）。

### 3. 抽屉 z-index 层级（遮罩 35 / 抽屉 40 / topbar 30）；插件渲染 fixed 元素会怎样

**[P1] z-index 体系无挡板：任何插件渲染一个 `position: fixed` + 高 z-index 元素即可凌驾于抽屉、遮罩、topbar 之上**

- 证据：层级仅由 `src/styles.css` 三处类名约定——`.topbar` z-index 30（:287）、`.drawer-mask` 35（:342）、`.shell-sidebar/.shell-panel` 40（:311,:327）；`SlotOutlet.tsx:27-29` 对插件组件**无任何 containment 包裹**（无 `isolation`、无 `contain`、无 portal 限制），插件返回什么就渲染什么。
- 分析：验收标准明确「插件不得越出槽位几何边界（fixed 元素越权、z-index 失控）」。当前架构下，若某插件渲染 `<div style={{position:'fixed', inset:0, zIndex:999}}>`，它将同时盖住遮罩（35）、抽屉（40）、topbar（30），且因为不是核心代码，核心无法感知与回收。mock-engine 这类「引擎插件」将来若实现 toast/浮层，就会天然踩中。
- 影响：插件可越权遮挡全屏（包括抽屉与输入区），破坏四段式的可见性与可操作性；属于规范明令禁止的越界形态，当前仅是「尚未发生」，缺乏结构性防御。
- 建议（择一或组合，成本从低到高）：
  1. 约定层：在插件契约（`src/core/types.ts` 的 SlotHostApi 注释）中明确「插件禁止使用 position: fixed 与 z-index」，并提供 `api.overlay` 之类的受控浮层能力；
  2. 结构层：`.slot` 容器加 `position: relative; z-index: 0; isolation: isolate;`，把插件内容限制在槽位 stacking context 内，使其内部 z-index 无法逃逸到抽屉层级之上；
  3. 运行时层：dev 模式在 SlotOutlet 挂载后遍历插件 DOM，检测 computed style 的 `position: fixed` 并 console.warn 报告越权。

**[已检查通过] 现有层级关系本身**

- 遮罩(35) < 抽屉(40)：抽屉可盖住遮罩正确呈现；遮罩点击关闭（SlotLayout.tsx:98-100）闭环。
- topbar(30) < 遮罩(35)：抽屉打开时 topbar 被遮罩压住，符合抽屉语义。
- 两个抽屉（sidebar/panel）同为 40 但分别固定在 left/right 且互斥（`drawer` 单状态），不会同屏叠放，无同级冲突。
- 现有插件无 fixed/z-index 使用（grep 全量核对，见证据清单）。

### 4. 面板插件（cap-panel）内容过长时是否溢出抽屉

**[P2] cap-panel 审计行过长时可能在抽屉内横向溢出（无 min-width:0 / 换行保护）**

- 证据：`plugins/cap-panel/index.tsx:48-53` 审计行直接拼接 `{a.target} · {a.action}`，`.cap-audit li`（styles.css:260）无 `word-break`/`overflow-wrap`；`.shell-panel` 桌面宽 300px、移动端抽屉 `min(78vw, 300px)`（styles.css:375 极窄屏 88vw）。
- 分析：`.shell-panel` 自身 `overflow-y: auto`（styles.css:81、:332），纵向内容再多也只会在抽屉内滚动，**不会溢出抽屉几何**——主验收点通过。但 cap 的 target/action 字符串（如 `cap.pluginServiceManager · someVeryLongActionName`）无换行保护时，flex 行内容可能把 `li` 撑出横向滚动（移动端抽屉内出现横向滚动条）。
- 影响：抽屉内横向滚动、观感破相，不遮挡其他区域。
- 建议：`.cap-audit li` 与 `.cap-item` 增加 `min-width: 0; overflow-wrap: anywhere;`，长 action 名折行显示。

**[已检查通过] 抽屉纵向滚动与高度**

- 桌面 `.shell-panel { min-height: 0; overflow-y: auto }`；移动端抽屉 `top:0; bottom:0; overflow-y:auto; -webkit-overflow-scrolling: touch`，并留了 `env(safe-area-inset-bottom)` padding——长列表在抽屉内滚动，几何边界受控。

### 5. 空态 / 错误态（槽位无插件、组件缺失）显示是否越界

**[已检查通过]**

- 证据：`SlotOutlet.tsx:11-25`。无插件 → `.slot-empty`（「槽位 {slot} 暂无插件」）；注册了插件但 componentMap 缺组件 → `.slot-error`（「插件 {id} 未导出组件 {name}」）。样式 `styles.css:86-94`：flex 居中、`height: 100%`、dim/red 文字、12px 字号，无固定宽高、无定位、无 z-index。
- 分析：两种兜底态都是纯文本居中，几何上被槽位容器约束（`.slot { min-height: 0 }`），在 stream 槽显示为居中提示、在 sidebar/panel 槽显示为顶部提示，均不溢出、不遮挡。文案能精确定位到 pluginId + component，可诊断性好。
- 备注（不计问题）：`resolve` 取 order 最小者，多插件抢同一槽时其余插件被静默忽略，无控制台提示；不影响布局越界验收，但建议后续在 dev 模式对「多插件争用同一 single 槽」打 warn，便于发现意外覆盖。

### 6. textarea 自动增高是否会把输入区撑到越过屏幕

**[P1] 移动端输入区随内容增长可把消息流压到 0，极端情况下输入区占据大半屏且无上限防护**

- 证据：`plugins/chat-lite/ChatInput.tsx:21-34` textarea 为原生 `rows={1}`，**没有 JS 自动增高逻辑**，增长完全依赖用户手动拖拽右下角 resizer（移动端已被 `::-webkit-resizer { display: none }` 隐藏，styles.css:364）；`.chat-textarea { min-height: 42px; max-height: 140px }`（styles.css:218-219）只约束 textarea 自身；`.shell-input` 无 `max-height`、无 `flex-shrink` 保护；移动端 `.shell-input { padding-bottom: 2px }`（:350）。
- 分析：分两个端看：
  - **桌面**：`.shell-main` 是 flex column，`.shell-stream { flex: 1; min-height: 0 }`，输入区按内容增高会优先压缩消息流——textarea 上限 140px + padding，输入区最高约 168px，消息流被压薄但不至于越屏，**可接受**。
  - **移动端**：问题在于 (a) `max-height: 140px` 在 iOS Safari 上对 textarea 的手动拉伸**不总是生效**（历史版本 max-height 对 resize 不设限），用户可把 textarea 拖到很高；(b) 输入区增高直接吃掉 `1fr` 行高，消息流被压扁后，配合第 2 项的 `100dvh`/软键盘问题，输入区视觉上会「顶到地址栏」，即验收所述「把输入区撑到越过屏幕」的观感。
- 影响：极端输入下移动端消息流被压至不可读，输入区与 topbar 争抢空间。
- 建议：① 给 `.shell-input` 加 `flex-shrink: 0; max-height: 40vh;`（或移动端 `max-height: 32vh`），超出部分由内部滚动消化；② textarea 加 `field-sizing: content`（渐进增强）或实现标准 auto-grow（onInput 里 `style.height='auto'; style.height=Math.min(scrollHeight, 140)+'px'`），把增高收敛为受控行为；③ 移动端显式 `resize: none`（当前 `resize: none` 在基础规则 :211 已有，保持即可，重点是 max-height 的浏览器兼容验证）。

**[已检查通过] 键入长文本的常规表现**

- `white-space: pre-wrap` 继承 + textarea 自身滚动，正常输入不会横向撑破输入栏；Enter 发送 / Shift+Enter 换行逻辑（ChatInput.tsx:28-33）不影响布局。

### 7. 极窄屏 360px 下气泡与输入栏是否重叠

**[已检查通过]（带一条 P2 备注）**

- 证据：移动端壳为 grid `auto 1fr`（topbar / main 两行），main 内 flex column：`.shell-stream { flex: 1; min-height: 0 }` 与 `.shell-input` 上下相邻、**无负 margin、无 transform 交叠、无 fixed 输入条**（输入区在文档流内，非浮层），结构上两区域不可能重叠。360px 断点只进一步压缩 `.chat-stream` padding（styles.css:374-377）与抽屉宽度（88vw），不动 flex 结构。
- 气泡：`.chat-msg { max-width: 94% }` + bubble `pre-wrap/break-word`，纵向排列在 `.chat-stream`（gap 14px）内，随内容增长只会推动滚动，不会压到输入栏。
- **[P2] 备注**：360px 下 `:root { font-size: 15px }`（styles.css:269）而 `.chat-send` 与 `.topbar-btn` 尺寸未随之收紧，`发送`按钮（padding 11px 16px）+ textarea + gap 在 360px 仍可容纳（textarea flex:1 可收缩），暂无重叠；但若后续给输入栏加附件按钮（图片/语音），360px 一行内将放不下，建议预留 `.chat-input-bar { flex-wrap: wrap }` 或在极窄屏隐藏次要按钮的方案预案。此项为前瞻性备注，当前不构成缺陷。

---

## 证据清单（文件:行）

| 主题 | 位置 |
|---|---|
| 四槽壳 grid / overflow hidden（桌面） | src/styles.css:25-30 |
| stream/input flex 关系 | src/styles.css:58-75 |
| `.shell-stream` 无 overflow 裁剪 | src/styles.css:65-70 |
| 消息流滚动容器 | src/styles.css:144-151 |
| scrollIntoView 调用 | plugins/chat-lite/MessageStream.tsx:10-12 |
| 移动端 100dvh / grid areas | src/styles.css:268-277 |
| topbar z-index 30 | src/styles.css:287 |
| 抽屉 fixed + z-index 40 | src/styles.css:304-335 |
| 遮罩 z-index 35 | src/styles.css:337-343 |
| body 滚动锁 | src/core/SlotLayout.tsx:36-41 |
| 槽位空/错态渲染 | src/core/SlotOutlet.tsx:9-31 |
| 槽位空/错态样式 | src/styles.css:84-94 |
| 单槽 resolve（order 最小者胜出） | src/core/slotRegistry.ts:29-32 |
| textarea 约束（42/140px、resize none） | src/styles.css:208-222 |
| 移动端 resizer 隐藏 / 16px 字号 | src/styles.css:357-364 |
| 极窄屏断点 | src/styles.css:373-377 |
| 气泡换行 / 94% 宽 | src/styles.css:179-187、354 |
| 侧栏标题截断 | plugins/chat-lite/SessionSidebar.tsx:21、src/styles.css:123-129 |
| cap-panel 长行渲染 | plugins/cap-panel/index.tsx:48-53 |
| 插件无 fixed/z-index（全量 grep） | src/、plugins/ 内仅 styles.css 命中 position/z-index |

---

## 修复优先级建议

1. **P1 · 滚动穿透**：`.shell-stream` 加 `overflow: hidden`；`html, body` 加 `overflow: hidden`（或改为容器内 scrollTop 滚动）。改动最小、收益最直接。
2. **P1 · z-index 无挡板**：给 `.slot` 加 `position: relative; z-index: 0; isolation: isolate` 形成槽位级 stacking context，并在插件契约中写明禁用 fixed/z-index；dev 模式加越权检测 warn。
3. **P1 · 输入区增高上限**：`.shell-input` 加 `flex-shrink: 0; max-height`（移动端约 32vh），textarea 改受控 auto-grow。
4. **P2 跟进**：气泡 `overflow-wrap: anywhere`；cap-panel 行 `min-width: 0 + overflow-wrap`；viewport 加 `interactive-widget=resizes-content`；360px 输入栏换行预案。

以上 P1 三项修完，移动端「滚动穿透 / 输入区被顶起 / 输入区越屏」三条主线风险即闭环；P2 项可在下一轮迭代消化。
