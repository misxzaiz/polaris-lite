# 交接单 ②：手机独立运行（脱离电脑）方案设计

> 生成时间：2026-11-26 13:52
> 来源会话：zcode `sess_2f15cab2-743a-448e-98c9-e7c3f8b36e40`（标题「dshgo 安全检查与 App 版本改造」）
> 接手人：另一个 AI（**无本会话上下文，本文件即全部前提**）
> 并行任务见 `docs/handoff-agent-runner-2026-11-26.md`（工作区里有一批那條线的未提交改动，**先别动**）

---

## 0. 任务定义

**用户原话（本次需求的起点）**：

> 目前 polarislite 的问题是依赖电脑，无法独立使用，我想要第一步解决的是这个

即：现在 APK 只是个「指向电脑服务端的壳」，电脑关机/不在同一网络，手机就完全不可用。
要做的是**让手机在没有电脑的情况下自洽可用**。

**当前状态**：调研已完成，方案**尚未成型**。会话在 plan mode 里读了
`scripts/make-portable.mjs` / `MainActivity.java` / `android/variables.gradle` / `package.json` 之后中断，**没有产出计划文件**。
你的交付物是 `docs/mobile-standalone-plan.md`（或同义命名）+ 一份需要用户拍板的决策清单。

---

## 1. 先看已有的两份文档（别重复造）

| 文档 | 内容 | 与本任务的关系 |
|---|---|---|
| `docs/mobile-app-plan.md`（plan v2.2, 2026-11-20） | 手机 App 版三层需求：R1-R7；「一仓三档」形态定案；§9 手机=电脑外设；§10 手机独立 App 档；§11 纯插件路线审计 | **本任务的直接上位文档，但它有一条假设被本次需求挑战**（见 §3） |
| `docs/dsh-security-comparison.md`（13.9KB, 2026-11-26 13:09） | DSH Go 安全模型核实 + polaris-lite 差距 + P0/P1/P2 改造建议 | 本任务上半场的产出。P0 里 R1/R3 直接关系到「本机跑服务端」的暴露面 |

`dsh-security-comparison.md` 的结论摘要（已写进文档，此处只作索引）：

- **P0（App 化后真正变危险的洞）**：R4 approved 可伪造（审批需服务端记账 + 一次性 token）；R1 监听地址要显式化（当前默认 `0.0.0.0`）；R2 上游分级（默认放行任意主机，应拦云元数据段）；R3 App 传输层（`allowMixedContent` 应收掉、中期做自签 + 钉证书）。
- **P1（最值得引入的 DSH Go 机制）**：风险三档确认体系、语义级硬规则、插件安装风险确认 + grants 版本键控、审批卡「问 AI」出口、phone-agent 操作中可感知可停止。
- **P2**：bypassApproval 横幅显性化、敏感信息打码、`docs/security-model.md`、`PLITE_SAFE=1` 只读模式。
- **明确不照搬**：DSH Go 的代码（**AGPL-3.0 传染，只能借鉴设计思想，实现必须自己写**）。

---

## 2. DSH Go 的本机运行方案（已核实的事实）

- 仓库：`ccch1mneyyy/dsh-Go`（会话内核实为公开开源，AGPL-3.0，Flutter/Dart 桌面+移动双端，star 数万级；**接手后建议自行复核 LICENSE 与 star 数**）。
- **核心形态**：APK 内嵌完整 Linux 运行时（**PRoot Ubuntu + Node**），在手机本机 `127.0.0.1` 跑 `dsh web`，UI 连 localhost。
  这正是 polaris-lite 需要的形态。
- **运行时分层（其文档 §构建入口与 rootfs 打包）**：默认单包 `rootfs-<abi>.tar.xz`（`runtime/build-runtime.sh arm64-v8a`）；
  `RUNTIME_LAYERS=1` 时拆两层 `base-<abi>.tar.xz` + `engine-<abi>.tar.xz`。**两层资产随 APK 携带，不联网下载**，缓存可独立保留。
- **启动方式**：直接启动（direct）默认关闭、需开发者选项手动开，Android 16 会拦截；失败自动回退兼容启动，且不计入启动失败。
- **保活（其后台执行设计文档）**：`specialUse` 类型前台服务 + 运行期持 `PARTIAL_WAKE_LOCK` + 条件性 `START_STICKY` 恢复；
  文档自己写明边界——**锁不免除内存回收 / Doze / 厂商断网**，另配电池与厂商设置引导。
- **安全设计可借鉴点**（详见 `docs/dsh-security-comparison.md` §一）：手机操控四闸、风险提醒体系、插件市场 check.mjs 启发式风险标记、权限预设 + Auto review、分享链接端到端加密、SSH 首次信任指纹。

---

## 3. 与现有定案的冲突（**这是接手后必须先解决的第一件事**）

`docs/mobile-app-plan.md` §1「本方案明确不做」第一条：

> 不做「手机上跑 Node 服务端」来承接完整宿主职责——agent-bash/agent-files/browser-lite 等要的是宿主机的文件系统与进程，
> 手机本体跑这些没有意义（这不是「手机连电脑」，是「手机变电脑」，超出 lite 定位）。

而 v2.2 的定案是**纯插件路线**：手机独立档（R7）= 客户端直连云供应商 + 薄端点承接手机侧能力，宿主仍在一台机器上。

本次需求（「第一步解决无法独立使用」）**直接挑战了这条假设**。两条路线的差别：

| | 路线 A：维持 v2.2 纯插件（不跑 Node） | 路线 B：手机本机跑 Node 服务端 |
|---|---|---|
| 手机独立时能做什么 | 云端聊天、本地会话缓存、手机侧工具（剪贴板/通知/文件） | 上述全部 **+ agent-bash / agent-files / kv-store / html-preview / 插件市场 / hooks / MCP** |
| 改动面 | 小（新增 install-guide / standalone-mode 插件） | 中到大（APK 内嵌运行时 + 首次启动 rootfs 释放 + 保活 + 端口/数据目录） |
| 风险 | 与 v2.2 一致 | 暴露面、电量、安装包体积、机型兼容、Android 版本限制 |
| 与官方定案 | 一致 | **推翻 v2.2 的一条明确「不做」** |

**需要用户拍板的三问（不要自己替他选）**：

1. 独立档的预期能力边界：只要「能聊 + 能存会话 + 手机侧工具」（→ 路线 A 就够），还是也要 bash/文件/插件的完整能力（→ 路线 B）？
2. 路线 B 的宿主运行时选型：PRoot Ubuntu+Node / nodejs-mobile / Termux 三选一（见 §5，均需实测）。
3. 若走 B，是否接受「推翻 mobile-app-plan v2.2 §1 的『不做』」并同步改那份文档（含 §10 独立档与 §11 纯插件审计的结论回写）。

---

## 4. polaris-lite 服务端依赖面盘点（已完成，直接可用）

> 以下每条都带 `文件:行号` 证据，来自子 agent 的全量盘点（2026-11-26 13:16 完成）。接手时抽检几条即可。

### 4.1 启动形态

**纯 Node ESM 单进程 HTTP 服务，零原生模块，唯一外部 npm 运行时依赖 `undici`。**

- 入口 `npm start` → `node server/prod-server.mjs`；`createProdServer()`（`server/prod-server.mjs:57`）是 `node:http` 手写中间件链（auth → providers → relay → 插件中间件 → 静态文件），**无 express/fastify**。
- 端口 `PORT ?? 9825`（`server/prod-server.mjs:117-134`），兼容 PM2。
- 宿主装配 `server/host.mjs:24-46`：组装 5 个平台件 + `loadServerParts()` 顶层 await 动态 import 约 25 个 `plugins/*/server.mjs`（`plugins/server-registry.mjs:70-89`）。
- **版本下限由 `node:sqlite` 决定 = Node ≥ 22.5**（建议 24）。`package.json` **没有 `engines` 字段**；
  `polaris-lite-portable/README.md` 自称「Node.js 20+」**已过时**。本机开发环境 v24.13.0。
- sqlite 用法：`plugins/kv-store/server.mjs:25` `import { DatabaseSync } from 'node:sqlite'`（WAL 落 `<dataDir>/stores/kv-store.db`）；
  `plugins/agent-runner/server.mjs:468` 直连同库；pocket-ledger 的 mcp-server.cjs 同款。
- 原生模块排查：dependencies 仅 `@modelcontextprotocol/sdk / react / react-dom / undici / zod`；两个 lock 文件里无 better-sqlite3 / sharp / canvas / node-gyp。

### 4.2 构建产物

**服务端零构建（源码即 `.mjs`，直接跑）；`dist/` 是纯静态前端 + 插件 ESM bundle。**

- `npm run build` = typecheck + check:plugins + `vite build` + gen-sw-manifest + sync-dist。
- `npm run build:plugins`（`plugins/build-plugins.mjs`）：每插件独立 vite 构建为 ESM bundle，产出 `public/plugins/<id>/{plugin.js,plugin.json,style.css}` + registry.json；`scripts/sync-dist.mjs:38-57` 再同步进 `dist/`。
- **现成便携包**：`scripts/make-portable.mjs` 打出的包含 `server/ + plugins/ + dist/ + node_modules/undici + plugins/browser-lite/node_modules`，`start.sh` 直接 `node server/prod-server.mjs`。
  **Android 移植可直接复用这个形态。**（注意：`polaris-lite-portable/` 是已生成的产物，在 git 里是未跟踪目录）
- 坑：prod-server 的 dist 默认 `resolve(process.cwd(), 'dist')`（`server/prod-server.mjs:57`）——**工作目录敏感**，App 内启动必须显式切 cwd 或用 `PLITE_DATA_DIR` 之外的方式锚定。

### 4.3 引擎依赖面（决定手机能用哪个引擎）

| 引擎 | 实现 | 手机上 |
|---|---|---|
| `real-engine` | 纯 `undici` fetch 到 `${baseURL}/chat/completions`（OpenAI 兼容），无本机二进制；前端经 `/api/model-relay` SSE | ✅ **完全可行** |
| `mock-engine` | 纯前端字符串假流，`enabled:false` | ✅（调试用） |
| `codebuddy-engine` | spawn 本机 `codebuddy` CLI（win32 走 `cmd.exe /c`，`plugins/codebuddy-engine/adapter.cjs:371-379`）；健康探测 `spawnSync('codebuddy',['--version'])` | ❌ 需 CLI 二进制 → 降级到 real-engine |
| `server/relay-core.mjs` | 同样是 undici 直连上游（中继通道） | ✅ |

### 4.4 外部工具依赖（OS 级清单）

| 插件 | 外部依赖 | 手机上 |
|---|---|---|
| `git-core` | 系统 `git`（`spawn('git',…)`，`git-core/server.mjs:71`） | Termux 可装；纯 Android 无 git → `cap.git` 全失败（fail-soft） |
| `browser-lite` | `puppeteer-core` + 本机 Chrome/Chromium 可执行文件（`browser-lite/server.mjs:73-85`，候选 `/usr/bin/google-chrome`、`/usr/bin/chromium`） | ❌ 无法驱动系统 WebView，需重写引擎 |
| `agent-bash` | win32 找 Git Bash；**非 win32 走 `spawn(cmd,{shell:true})` = `/bin/sh -c`**（`agent-bash/server.mjs:105-126,243-253`），cwd 锁在 workspace 根内 | 可行，但 Android 自带 mksh 非 bash，行为降级 |
| `agent-files` | 无 OS 依赖，写入面限 `<dataDir>/workspace` 或 `workspace-roots.json` 登记根（`agent-files/server.mjs:62-155`） | ✅ |
| `hook-bridge` / `mcp-bridge` | spawn 用户配置的任意命令 | 视命令而定 |
| `zcode-compat` | `spawnSync git`（clone，`zcode-compat/server.mjs:426`） | 同 git |
| `voice-radio` | 无 ffmpeg——MiMo TTS HTTP 返回 wav base64，落 `<dataDir>/voice-radio/cache/*.wav`，前端原生 `<audio>` 播 | ✅ |
| `translate` | 纯 HTTP（百度翻译 API） | ✅ |
| `html-preview` | 纯落盘/读盘 `<dataDir>/previews/<uuid>/` | ✅ |
| `phone-agent` | 无 OS 依赖（SSE + 浏览器 API） | ✅ 反过来更贴手机 |

### 4.5 数据目录

`.polaris-lite/` 内全部相对 dataDir 解析，无硬编码绝对路径（除 win32 的 bash/Chrome 候选与系统禁区表）。

- 结构：`auth-owner.json / auth-sessions.json / providers.json / workspace/ / workspace-roots.json / stores/kv-store.db / chat-store/ / skills/ / previews/ / voice-radio/ / mcp-servers.json / phone-gateway.json` + 十余个 `*-audit.log`。
- dataDir 三来源：`PLITE_DATA_DIR` 环境变量（`prod-server.mjs:57`）→ options → 默认 `'.polaris-lite'` 相对 `process.cwd()`。
- **只有两处非 dataDir 锚定**：`plugin-manager` / `plugin-market` 用 `import.meta.url` 锚定仓库根（`plugin-manager/server.mjs:27`、`plugin-market/server.mjs:46`），手机上要改成 app 私有目录方案。
- **结论：Android 只需 `PLITE_DATA_DIR=/data/data/<pkg>/files/plite`，代码零改动。**

### 4.6 Android 壳现状

**瘦客户端：APK 只嵌 `dist` 静态资产，运行时把 WebView 切到用户手填的电脑地址，无任何本机 Node 痕迹。**

- `android/app/src/main/java/com/polarislite/app/MainActivity.java`：`PREFS="plite.server"` / `KEY_URL="url"`（:45-46）存 SharedPreferences；首启落内嵌引导页（Capacitor `localServer` = `https://localhost`），引导页经 `plite://set-server?u=<addr>` 深链切源（:130-131, 153-165）；`onResume` 幂等 `webView.loadUrl(serverUrl)`（:86-92）；自判定 WebViewClient 做同源/外链分流（:128-150）。
- 全仓 grep `libnode / nodejs-mobile / termux` 在 `android/` **零命中**。
- `capacitor.config.json`：`webDir: dist`、`androidScheme: https`、`allowNavigation: [localhost, 127.0.0.1]`、`allowMixedContent: true`；`AndroidManifest.xml:9` `usesCleartextTraffic=true`。
  → **若本机起 Node（`http://127.0.0.1:9825`），切源机制现成：只要把 `plite.server.url` 指向本机端口即可。**
- `android/variables.gradle`：`minSdkVersion 24` / `compileSdkVersion 36` / `targetSdkVersion 36`
  （⚠️ targetSdk 36 = Android 16，正是 DSH Go 文档里 direct 启动会被拦的那档，需评估兼容启动路径）。
- AndroidManifest 仅 `INTERNET` 权限；若做前台服务保活需补 `FOREGROUND_SERVICE` 等。

### 4.7 总评（盘点结论原文）

> 核心服务端（auth / providers / relay / kv-store / chat-store / agent-runner + real-engine + html-preview + translate + voice-radio）
> 是"纯 Node 内置模块 + undici"的零原生组合，移植 Termux 或 nodejs-mobile 的技术障碍极小：
> 复制便携包（server/ + plugins/ + dist/ + undici），设 `PLITE_DATA_DIR` 指向 app 私有目录即可；
> 现有 `plite.server.url` 切源机制与 `usesCleartextTraffic` 让 WebView 指向 `http://127.0.0.1:9825` 几乎零改动。

必须降级/禁用的：`codebuddy-engine`（无 CLI）、`browser-lite`（无桌面 Chrome）、`git-core`（需装 git）、部分 hook/MCP、`agent-bash` 落 sh。
即：**"手机独立聊天（real-engine 直连云供应商）+ kv + 文件 workspace + html-preview + voice-radio" 本机跑完全成立**；
要 bash/git/browser 就得接受降级或另行实现。

---

## 5. 宿主运行时三选一（**均未实测，别当结论用**）

| 方案 | 思路 | 优点 | 待验证风险 |
|---|---|---|---|
| **A. PRoot + Ubuntu rootfs + Node**（DSH Go 路线） | APK 内带 rootfs tar.xz，首次启动解到私有目录，`proot` 起 Ubuntu，里面跑 node | 生态最完整（git/bash/npm 全有）；可直接复用便携包；与 DSH Go 对齐 | rootfs 体积（几十 MB~百 MB）；targetSdk 36 下 exec 限制（W^X）；启动耗时；机型兼容；PRoot 性能 |
| **B. nodejs-mobile** | 把 Node 编进 APK 作为库（JNI 调） | 无 rootfs、启动快、体积可控、Android 原生内嵌方式 | 版本滞后（node:sqlite 需 ≥22.5，**要确认 nodejs-mobile 是否已跟进**）；无 bash/git；`spawn`/`child_process` 行为受限 |
| **C. Termux 依赖** | 让用户装 Termux，服务端跑在里面 | 实现最省事 | 体验断裂（两个 App）、非独立 APK，**基本违反「独立使用」的初衷**；只能当过渡验证手段 |

选型判据（建议写进计划）：`node:sqlite` 可用性 > APK 体积 > 启动时间 > bash/git 是否需要 > targetSdk 36 兼容。

---

## 6. 建议的推进步骤

1. **先决策后编码**：把 §3 的三问整理成一份简短决策单，让用户拍板（路线 A/B + 运行时选型 + 是否改 v2.2 定案）。
   **不要**在决策前动 `MainActivity` 或改 `mobile-app-plan.md`。
2. 决策 B 路线后，先做**最小可行性验证（spike）**，不集成：在目标机型上手跑 §5 选中的运行时 → 拷便携包 → `PLITE_DATA_DIR` 指私有目录 → `node server/prod-server.mjs` → 手机浏览器访问 `127.0.0.1:9825` 能登录、能跟 real-engine 聊一轮。
   spike 成功再谈壳集成（WebView 指向本机端口 + 首次启动引导 + 前台服务保活）。
3. 把 spike 结论写进 `docs/mobile-standalone-plan.md`：阶段划分、每阶段的降级清单（哪些 cap 在手机上是 `unavailable`）、体积与启动预算、回滚点。
4. 同步文档债：`mobile-app-plan.md` §1 的「不做」、§10 独立档、§11 纯插件审计结论；
   `polaris-lite-portable/README.md` 的 Node 版本要求（20+ → 22.5+/24）。
5. 与 ① 的边界：① 那批改动一旦 release 完，`server/` 与插件层的基线就变了，**文档里的行号可能整体偏移**，接手时以 `grep` 重新定位为准。

---

## 7. 红线

1. **不要动 ① 的未提交改动**（29 改 / 3 删 / 41 新增，见另一份交接单）。先在 ① 落地后再动手改 `server/` 或 `plugins/`。
2. **9825 是生产**：只读观察，禁止写入/重启。跑东西用 5000（`npm run dev:standalone`，root/1234）。
3. **9826 是钉住的 clone**，只走 `npm run deploy:9826`。
4. **不抄 DSH Go 的代码**（AGPL-3.0），只借鉴设计思想。
5. **不要承诺 iOS**：本任务默认 Android 侧（现有壳即 Capacitor Android）。

---

## 8. 关键文件地图

```
docs/mobile-app-plan.md              上位文档（v2.2，含被挑战的「不做」条款）
docs/dsh-security-comparison.md      上半场产出（DSH Go 安全对照 + P0/P1/P2）
android/app/src/main/java/com/polarislite/app/MainActivity.java   切源逻辑
android/variables.gradle             minSdk 24 / targetSdk 36
android/app/src/main/AndroidManifest.xml   cleartext + 权限
capacitor.config.json                allowNavigation / allowMixedContent
scripts/make-portable.mjs            便携包脚本（B 路线的复用基座）
server/prod-server.mjs               createProdServer / PORT / PLITE_DATA_DIR / dist cwd 敏感
server/host.mjs                      createHost + loadServerParts
plugins/server-registry.mjs          插件 server 半边登记表
plugins/kv-store/server.mjs          node:sqlite 用法（版本下限依据）
plugins/agent-bash/server.mjs        非 win32 的 /bin/sh 回退
plugins/browser-lite/server.mjs      puppeteer-core + Chrome 候选路径
plugins/plugin-manager|plugin-market/server.mjs   import.meta.url 锚定仓库根（手机需改）
```

---

## 9. 接手人附注（2026-11-26，事实修正 + 决策结果）

**决策已拍板**（详见 `docs/mobile-standalone-plan.md` §0）：走 B 路线 / 先 spike 再定运行时 / 推翻 v2.2 §1 并升 v3（已完成）/ 本轮只读不碰代码。

**本文档三处需修正（保留原文，以本节为准）**：

1. **§4.1 Node 版本**：本机实测 **v22.22.2**（非 v24.13.0）。且 `node:sqlite` 在 22.x **免 flag 可用**（仅 ExperimentalWarning）→ 真实下限是 **Node ≥ 22.13**，不是"22.5 + flag"，也不必 24。
2. **§3 的前提偏差**：路线 A **不是"改动面小、还没做"**，而是**已在仓内落地了大半**——
   P0 资产齐全（`public/manifest.webmanifest`、`public/sw.js`、`public/icons/`）、切源壳已在（`MainActivity.java:45-46,78-92,130,153-160`）、
   `plugins/standalone-mode/index.tsx`、`plugins/real-engine/index.ts`（direct 模式 + CORS 实测）、`plugins/phone-agent` 均存在。
   所以 A 的问题不是"没做"，而是**止步于前端层**：APK 的 WebView 载内嵌 `dist`，进程里没有 Node，
   `chat-store`/`kv-store`/`agent-files`/`html-preview`/插件装配全部无后端，密钥还要"先连一次电脑"下发。
   → 这正是"依赖电脑"的硬核，也是走 B 的理由。
3. **§5 运行时选型**：`nodejs-mobile` 已被硬证据淘汰——最新 release 是 **Node 18.20.4**（内置 undici 5.28.4），
   而本仓 `node:sqlite` 需 ≥22.13、依赖 `undici ^8`。选它等于重写三处存储层 + 降级 undici。
   spike 只需针对 PRoot 做。

**新增的两条关键结论（本文档原本没有）**：

- **`targetSdk 36` 与 PRoot 在原理上互斥**：Android 10 起 `targetSdk ≥29` 禁止 `execve()` 自身私有目录的文件（官方 W^X 变更），
  而 PRoot 必须 exec rootfs 里的 `node`/`bash`。→ **必须把 `targetSdk` 降到 28**（Termux / AndroidIDE 同款选择）；
  代价是不能上架商店，而 v2.2 §1 已定案不上架，**代价为零**。
- **本机有服务端后，§10.3 的 CORS 风险整类消失**：`real-engine` 走同源 `/api/model-relay`，不必再赌供应商放行跨域，
  密钥也不再依赖"先连电脑下发"。这是 B 路线相对 A 的额外红利。
