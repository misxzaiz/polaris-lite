# Polaris Lite 手机浏览器体验审计与优化方案

日期：2026-11-22  
测试环境：`http://127.0.0.1:5000/`（开发环境，`root/1234`），**未对 9825 生产做任何写操作**  
测试方式：headless Chrome + CDP，390×844（iPhone 视口）、320×640（窄屏）、键盘弹起模拟 390×480  
复测脚本：`tests/_mobile-audit.mjs`、`tests/_mobile-audit2.mjs`  
截图与原始度量：`gui-test-screenshots/mobile-audit/`（report.json、report2.json 及 14 张截图）

---

## 0. 结论先行

核心链路**能用**：登录、冷启动恢复、草稿保留、会话切换、流式对话、深色主题、+15 面板菜单都正常；之前修过的「聊得越多输入框越扁」也没有回归（注入 40 条长消息后输入区仍是 129px）。

但离「手机浏览器主力使用」还差一层体验，主要卡在三点：

1. **手指点不准**：发送 35×34、附件/调谐/新会话 40×34、分享 chip 22–24、消息操作 28×20，远低于 44×44 的触摸目标标准；
2. **键盘一弹就没地方看消息**：输入区固定 129px，在 480px 可视高度里占 27%，消息区只剩约 290px；
3. **所谓 PWA 离线壳是坏的**：断网刷新直接「插件加载失败：registry（Failed to fetch）」+ 四个空槽，与 `docs/mobile-app-plan.md` §4 的验收目标不符。

另外还有抽屉透字、会话列表难扫、20 个面板入口藏在 +15 后面、未登录时 6 个 401 请求等中低优先级问题。下面按优先级给出改法。

---

## 1. 实测结果总表

| 场景 | 实测结果 | 判定 |
|---|---|---|
| 登录 | `root/1234` 登录成功；清掉 sessionStorage 后刷新，无登录页闪烁，自动恢复 | 通过 |
| 草稿 | 输入「草稿保留测试」后刷新，内容仍在 | 通过 |
| 会话 | 81 条会话，列表/切换正常，条目 296×52 | 通过（但列表难扫） |
| 面板 | 20 个 tab，窄屏只露 5 个；+15 菜单 335×464、带搜索、可滚动 | 通过 |
| 发消息 | 发送按钮点击后流式返回「测试通过」 | 通过 |
| 长会话 | 注入 40 条长消息，输入区仍 129px，不再被压扁 | 通过 |
| 深色主题 | 切换生效，且深色下抽屉不透字 | 通过 |
| 320 窄屏 | 无横向溢出，输入区仍可用（发送键 32×34） | 勉强可用 |
| 离线刷新 | `插件加载失败：registry（Failed to fetch）`，sidebar/stream/input/panel 全空 | **失败** |
| 未登录首屏 | 6 个业务 API 返回 401 | 需优化 |

关键度量（390×844）：顶栏 60px，输入区 129px，textarea 16px 字号（防 iOS 自动缩放，这点做对了），消息正文 14px，抽屉宽 320px，面板宽 335px。  
键盘模拟（390×480）：输入区仍 129px，textarea 位于 y=360，发送键 y=423。

---

## 2. P0：先修这三个

### P0-1 离线 PWA 壳不完整（功能性缺陷）

**证据**：断网刷新后页面文本为「插件加载失败：registry（Failed to fetch）+ 槽位 stream/input/panel/sidebar 暂无插件」。`public/sw.js:79` 明确写着「其余（插件产物等）直连，不拦」；而 `src/core/externalPlugins.ts` 启动时要 fetch `/plugins/registry.json` 和 `/grants.json`，再动态 import 各插件 bundle。文档 `docs/mobile-app-plan.md` §4 P0-4 承诺的「杀网刷新出缓存壳」目前不成立。

**改法**（`public/sw.js` + `scripts/gen-sw-manifest.mjs`）：

- 把 `/plugins/registry.json`、`/grants.json`、`/plugins/**/plugin.js`、`/plugins/**/style.css`、`/plugins/esm-shim.mjs` 纳入 SW 缓存；
- registry/grants 用 network-first + cache fallback（保证在线永远拿最新清单），插件 bundle 用 stale-while-revalidate（bundle URL 自带 `?v=<hash>`，缓存键天然带版本，不会串版）；
- **红线不变**：`/api/*` 与 `/api/model-relay` 依旧不缓存、不拦截；
- 离线时给一个明确提示「当前离线，无法连接电脑；会话与输入暂不可用」，而不是裸的「槽位暂无插件」。

**验收**：在线访问一次后断网刷新，仍能看到登录/会话壳 + 明确离线提示；恢复网络后刷新自动回到全功能。复测：`tests/_mobile-audit2.mjs` 的 `steps.offline`。

### P0-2 触摸目标普遍小于 44px

**证据**（390×844 实测）：发送 35×34、附件/调谐/新会话 40×34、主题选项 63×34、分享 TTL 22–24 高、分享 chip 22–24 高、消息操作 28×20、会话重命名/目录/删除 30×30、会话刷新 22×22、文件过滤输入框约 30 高。  
样式来源：`plugins/chat-lite/chat-input.css:83-96,423-424`、`plugins/chat-lite/chat.css:1086-1098,1237`、`plugins/theme-switcher/theme.css:53`、`plugins/chat-lite/SessionSidebar.tsx` 会话操作区。

**改法**：

- 在窄屏断点加一条统一规则：参与点击的 `button / [role=button] / input / select` 最小 44×44；图标仍保持 18–20px，靠 padding 撑开命中区，视觉密度不变；
- 分享 chip、消息操作条、会话操作图标优先改（这些是「点歪了就误删/误重答」的高风险区）；
- 顺手加 `touch-action: manipulation`，减少移动端 300ms 双击缩放延迟。

**验收**：重跑 `tests/_mobile-audit.mjs`，390 与 320 两个视口的主流程 `smallTargets` 为 0（抽屉内暂时隐藏的控件不计）。

### P0-3 软键盘场景输入区太占地方

**证据**：390×844 与 390×480 下输入区都是 129px；键盘弹起后占可视高度 27%，消息区约 290px。一次简单问答还展开两个「深度思考」块，几乎把消息区塞满。

**改法**：

- 增加 `@media (max-width: 768px) and (max-height: 560px)` 紧凑模式：输入条 padding 收到 6px，textarea `min-height: 40px`，隐藏输入提示行，把工作目录/信任模式/附件等次要控件收进「调谐」抽屉，只保留输入框 + 发送；
- 目标：键盘弹起时输入区 ≤96px，消息区 ≥360px，发送键始终可见；
- 可选：短回复的 thinking 块在窄屏默认折叠，点「深度思考」再展开。

**验收**：390×480 下 `metrics['06-keyboard-480'].key.input.h <= 96`，发送键 `y + h <= 480`，长回复仍可滚动阅读。

---

## 3. P1：明显提升日常手感的四项

### P1-1 抽屉背景透字

**证据**：截图 `03-sidebar.png`、`11-file-panel.png` 里能清楚看到底层首页文案透过抽屉；浅色主题 token 是 `--bg-translucent: rgba(255,255,255,0.92)`（`src/plite-tokens.css:18`），而 `.shell-sidebar` / `.shell-panel` 在 `src/styles.css:46,136` 用它做背景，`backdrop-filter` 不足以盖住彩色文字。深色主题（0.96 黑）实测无此问题。

**改法**：窄屏断点下给 `.shell-sidebar.open, .shell-panel.open { background: var(--bg); }`，桌面保留半透明质感。纯 CSS，一行改动。

### P1-2 会话列表 81 条却没法找

**证据**：侧栏头部只有同步点、刷新按钮、计数，没有搜索框（`plugins/chat-lite/SessionSidebar.tsx:94-106`）；列表里大量「新会话⌂」空会话与重复标题，81 条里靠肉眼定位一条历史对话基本不可行。条目本身 296×52 是合格的。

**改法**：

- 首条用户消息后自动生成会话标题（取前 12 字），避免长期停在「新会话」；
- 侧栏头部加搜索框（本地过滤即可，不必打服务端）；
- 空会话默认折叠到「未开始对话」分组，或提供「仅显示有消息」开关；
- 重命名/目录/删除三个 30px 图标收进一个 44px 的「···」菜单，降低误触删除的概率。

### P1-3 20 个面板入口藏在 +15 后面

**证据**：tabbar 可视宽 249px / 面板宽 335px，只露出 5 个 tab，其余 15 个要点 +15 再找；+15 菜单本身做得不错（搜索、星标置顶、335×464 可滚动），问题在默认排序是按插件注册顺序，不是按你的使用频率。

**改法**：用 shell-chrome 已有的 pinned 机制默认置顶 4 个高频面板（建议：文件、模型、分享、账号，按你的实际习惯调整），其余按最近使用排序；+15 菜单保留搜索。

### P1-4 未登录首屏 6 个 401

**证据**：登录页每次加载都会请求 `/api/chat/sessions`、`/api/chat/sessions/index-events`、`/api/providers/list`（两次）、`/api/tool/config`、`/api/phone/hello`，全部 401，控制台刷 6 条错误。登录后不再出现。

**改法**：由宿主暴露一个 `authReady` 状态（mock-auth 已在启动时对齐 `/api/auth/status`），各插件 setup 里的首次拉取等鉴权确定后再发；至少把重复的 `providers/list` 合并成一次。移动端弱网下这一步能省掉 6 次往返。

---

## 4. P2：有余力再做

| 项 | 证据 / 改法 |
|---|---|
| 正文 14px 偏小 | `plugins/chat-lite/chat.css:403` 手机端 `.chat-bubble { font-size: 14px }`，建议 15px、行高 1.65 |
| 禁止缩放 | `index.html:7` 有 `user-scalable=no, maximum-scale=1.0`，妨碍低视力用户；去掉这两项，保留 `viewport-fit=cover` 与 `interactive-widget=resizes-content` |
| 首屏 95 个资源 / 约 1MB | 本地加载 95ms 看不出问题，但公网弱网值得做面板懒加载；20 个面板的 JS/CSS 不必首屏全挂 |
| 思考块太占屏 | 短回答的 thinking 块默认折叠（见 P0-3） |

---

## 5. 建议实施顺序

| 批次 | 内容 | 预估 | 风险 |
|---|---|---|---|
| 1 | P0-2 + P0-3 + P1-1（纯 CSS，一个断点 + 一组 min-size） | 1 个会话 | 低，需回归桌面布局 |
| 2 | P0-1（SW 缓存插件清单与产物 + 离线提示） | 1 个会话 | 中，重点防版本错配 |
| 3 | P1-4（鉴权就绪门控）+ P1-2（会话搜索/自动标题） | 1~2 个会话 | 中，涉及插件启动时序与 store |
| 4 | P1-3（面板置顶/最近使用）+ P2 各项 | 按需 | 低 |

每批完成后跑：`npm run typecheck && npm test && npm run build:plugins`，再用两个审计脚本在 5000 环境复测；改完前端记得重建 dist（`npm run dev:standalone --build`），否则手机端还拿旧包。

---

## 6. 本次未做的事

- 没有改任何应用代码或生产数据；只在 `tests/` 下新增了两个审计脚本，并写了本文档。
- 9825 生产环境只做过只读观察，没有登录、写入或重启。
- 离线问题是功能缺陷，不是网络波动：同一脚本在线时所有流程正常，切 offline 后稳定复现「registry Failed to fetch」。

---

## 7. 2026-11-22 傍晚复测（修复落地核对 + 交互实测）

方式：重跑两个审计脚本（重建后的 17:16 dist）+ 新增真交互脚本 `tests/_mobile-hands-on.mjs`（真实坐标点击，逐场景截图 `gui-test-screenshots/mobile-hands-on/`）+ `tests/_panel-probe.mjs`（面板专项）。

### 7.1 已修（实测确认有效）

| 审计项 | 实测结果 |
|---|---|
| P1-2 会话列表 | 搜索框（296×40）+ 今天/7天内/更早分组 + 行内 44px ⋮ 收纳；搜「星尘」即时过滤命中；新会话首条消息后自动带标题 |
| 消息操作 sheet | 点消息 ⋯ 弹全宽底部 sheet（复制正文/重新生成/取消），行高充足 |
| 面板窄屏重设计 | 窄屏不再渲染 tab 行，改为「能力 ▾」sheet 头 + 20 项全宽下拉菜单（带搜索），实测可开可点 |
| P2 缩放 | user-scalable 已放开 |
| 主链路 | 登录、草稿、会话恢复、发送+流式回复、深色主题全部通过 |

### 7.2 未修（复测仍在，维持原优先级）

| 审计项 | 复测证据 |
|---|---|
| P0-1 离线壳 | 断网刷新仍为「插件加载失败：registry（Failed to fetch）」+ 四空槽（t10_offline.png） |
| P0-2 触摸目标 | 发送 35×34、附件/调谐/新会话 40×34、会话刷新 22×22、分享 chip 22–24、主题选项 63×34、登录页「临时凭证」行高仅 19；消息操作 28×20 有伪元素外扩（命中 ~40×45）但视觉仍偏小 |
| P0-3 键盘紧凑 | 390×480 下输入区仍 129px（占 27%），消息区 ~350px（t6_keyboard_480.png） |
| P1-1 抽屉透字 | 浅色下侧栏抽屉右缘与行间隙可见底层文字鬼影；面板左缘同样透字（p2 截图）；深色正常 |
| P1-4 401 | 登录前首屏仍 6 个 401（sessions/index-events/providers×2/tool config/phone hello） |
| P2 字号 | 消息正文仍 14px |
| P2 首屏体积 | 97 个资源 / 869KB transfer（本机 123ms，公网弱网是负担） |

### 7.3 复测新发现

- 窄屏面板的 sheet 化重构后，`.slot-tab` 不再渲染——依赖它的旧选择器（含本档两个审计脚本的 moreMenu/filePanel 步骤）需按新结构更新。
- 侧栏搜索词跨抽屉开关持久保留（合理，但搜索后忘清除会让人以为「会话丢了」，建议无结果时给「清除筛选」入口）。
