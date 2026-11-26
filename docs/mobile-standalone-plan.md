# 手机独立运行（脱离电脑）实施计划 v1

> 生成时间：2026-11-26
> 上游：`docs/handoff-mobile-standalone-2026-11-26.md`（交接单 ②）、`docs/mobile-app-plan.md`（v2.2 → 本计划同步升 v3）
> 状态：**路线已定案，待 spike 验证**。本轮不动任何代码（含 ① 的未提交改动）。
> 一句话：APK 内嵌 PRoot Ubuntu + Node，在手机 `127.0.0.1:9825` 跑完整 polaris-lite 宿主，WebView 指向它。

---

## 0. 决策记录（2026-11-26，用户拍板）

| # | 问题 | 决策 | 备注 |
|---|---|---|---|
| D1 | 独立档能力边界 | **完整能力（走路线 B：手机本机跑 Node）** | 见 §2 的实证理由：A 路线已在仓里落地，但补不到后端层 |
| D2 | 宿主运行时选型 | **先 spike 实测再定** | 本计划已将 `nodejs-mobile` 纸面淘汰（§4.1 有硬证据），spike 只针对 PRoot 做 |
| D3 | 是否推翻 v2.2 §1「不做手机跑 Node」 | **推翻，文档升 v3 并回写 §1/§10/§11** | 已同步 `docs/mobile-app-plan.md` |
| D4 | 与 ① 未提交改动的关系 | **本轮只做只读 spike + 计划，不碰代码** | 冻结 `server/`、`plugins/`、`android/`；等 ① release 后再开工 |

---

## 1. 交付目标与非目标

**第一步的验收定义**（用户原话「第一步解决依赖电脑」= 这个）：

> 手机装 APK → **完全不给电脑开机、不需要同一 Wi-Fi** → 点图标 → 登录 → 与 AI 聊一轮 → 会话落本机、重启不丢 → 能用 `agent-files` 读写本机 workspace、能用 `kv-store`、能开 `html-preview`。

**非目标**（本计划范围外）：

- iOS（现有壳即 Capacitor Android；红线：不承诺 iOS）
- 上架 Play / App Store（v2.2 已定案不做 → **这条直接为 §4.2 的 targetSdk 28 铺平了路**）
- `browser-lite` 在手机上跑真 Chrome（P2 可选，见 §3）
- 手机与电脑的会话双向同步（相遇升级，属 §10.4 后续）
- 任何 AGPL 代码复用（DSH Go 只借鉴形态，实现自写）

---

## 2. 为什么路线 A（纯插件）不够——代码证据

交接单说「路线 A 改动面小」，但**A 已经在仓里落地了大半**，落地后依然"依赖电脑"，原因不是没做，而是**架构天花板**：

| 已有（A 路线的成果） | 位置 | 落地后仍缺什么 |
|---|---|---|
| PWA 资产（manifest / sw.js / icons） | `public/manifest.webmanifest`、`public/sw.js`、`public/icons/` | — |
| 首启引导 + 切源 | `MainActivity.java:45-46,78-92,130,153-160` | 切到本机端口需要**本机真有服务** |
| 独立档模式判定骨架 | `plugins/standalone-mode/index.tsx:1-14`（自述："宿主不可达时它们自己会报错，AI 调用会失败"） | 没有本地数据面 |
| 供应商直连（含 CORS 实测兜底） | `plugins/real-engine/index.ts:12,87,135,407` | 密钥要**先连一次电脑**经 `/api/providers/direct-config` 下发到 localStorage；被 CORS 拦的供应商直接不可用 |

**核心结论**：APK 的 WebView 载的是内嵌 `dist` 静态页（Capacitor `webDir: dist`），**进程里没有 Node**。所以 `chat-store` / `kv-store` / `agent-files` / `html-preview` / 插件市场 / hooks / MCP **一台都没有**。这不是"再补个插件"能解决的——它是"后端不存在"。

→ 只要用户要「完整能力」（D1），就必须有本机服务端。**路线 B 是唯一解，不是偏好问题。**

**顺带的最大红利**：一旦本机有服务端，`real-engine` 走同源 `/api/model-relay`，**§10.3 的 CORS 风险整类消失**，密钥也不再依赖"先连电脑下发"。A 路线里最难缠的问题在 B 里不存在。

---

## 3. 手机上跑本机服务端后的能力矩阵

前提：PRoot Ubuntu rootfs + Node 22 + 便携包形态（`server/` + `plugins/` + `dist/` + `undici`）。

| 插件 | 手机本机 | 说明 |
|---|---|---|
| `real-engine` / `server/relay-core.mjs` | ✅ | 同源经 relay，无 CORS 问题；纯 undici |
| `kv-store` | ✅ | `node:sqlite`（`plugins/kv-store/server.mjs:25`），WAL 落 dataDir |
| `chat-store` | ✅ | 会话本机权威，重启不丢 |
| `agent-files` | ✅ | 无 OS 依赖，写入面限 `<dataDir>/workspace` |
| `html-preview` | ✅ | 纯落盘/读盘 |
| `voice-radio` | ✅ | MiMo TTS 返回 wav，前端原生 `<audio>`，无需 ffmpeg |
| `translate` / `theme-switcher` / `chat-lite` / `interactive-cards` | ✅ | 纯 HTTP / 纯前端 |
| `agent-bash` | ✅ **（PRoot 红利）** | PRoot 内是 Ubuntu → 有真 `bash`，比 ROOT 于 Android 自带 mksh 的降级要好；`shell:true` 走 `/bin/sh -c` |
| `git-core` / `zcode-compat` | ✅ **（PRoot 红利）** | `apt install git` 即得，无需改代码 |
| `plugin-market` / `plugin-manager` | ⚠️ 需改 | 用 `import.meta.url` 锚定仓库根（`plugin-manager/server.mjs:27`、`plugin-market/server.mjs:46`）→ 手机要改成 app 私有目录方案（§5.3） |
| `mcp-bridge` / `hook-bridge` | ⚠️ 视命令 | spawn 用户配置命令；PRoot 内可跑，需逐条实测 |
| `codebuddy-engine` | ❌ | 无 CLI 二进制 → 自动降级 real-engine |
| `browser-lite` | ❌（P2 可选） | 需本机 Chrome 可执行文件；PRoot 里 `apt install chromium` + headless 理论可行，但 +100MB 体积、无 X、性能未知 → **P2 再议，不进第一步** |
| `phone-agent` | ⚠️ 语义变化 | 本机档里"手机端点"与宿主同机，端点意义消失；需评估是自连还是禁用（§5.5） |
| `standalone-mode` | ⚠️ 语义变化 | "宿主不可达"的判定在手机本机档恒为"不可达"，需改判为"本机档"（§5.5） |

---

## 4. 运行时选型（含纸面淘汰）

### 4.1 `nodejs-mobile` 已被硬证据淘汰

- 最新 release 是 **Node 18.20.4**（`nodejs-mobile/nodejs-mobile` releases，2025-10-07）。内置 `undici: 5.28.4`。
- 本仓 `node:sqlite` 需 **Node ≥ 22.13**（实测：本机 v22.22.2 免 flag 可用，仅实验性 warning）。Node 18 **没有** `node:sqlite`。
- 本仓依赖 `undici ^8.12.4`，与内置 5.28.4 代差两个大版本。

→ 选它等于**同时**重写三处存储层（`kv-store` / `agent-runner` / `pocket-ledger` 的 sqlite）+ 降级 undici。这不是"版本滞后"，是"换地基"。**淘汰，不进 spike。**

### 4.2 Android exec 限制——PRoot 与 `targetSdk 36` 在原理上互斥

Android 10（API 29）起，**`targetSdk ≥29` 的应用不允许 `execve()` 自身私有可写目录里的文件**（官方 W^X 行为变更）。而 PRoot 路线必须在私有目录里 exec `proot`、`loader` 以及 rootfs 内的 `node` / `bash`。

本仓 `android/variables.gradle` 是 **`targetSdkVersion = 36`** → **当前配置下 PRoot 100% 起不来**，这不是"待验证风险"，是确定性冲突。

三条退路与取舍：

| 退路 | 做法 | 判定 |
|---|---|---|
| **① targetSdk 降到 28** | Termux / AndroidIDE 官方同款选择（Termux 至今钉在 28，正因如此） | ✅ **采纳**。代价=不能上架 Play，而 v2.2 §1 已定案"不做商店上架"，**代价为零**。minSdk 24 不变 |
| ② 可执行件打包成 `lib*.so`，从 `nativeLibraryDir` exec | 业界做法（android-builder 等），能绕过限制 | ⚠️ **仅部分可行**。只对少量二进制有效；PRoot 要 exec rootfs 内成百上千个 ELF，不可能逐个改名打包 |
| ③ 放弃 rootfs，单 Node 二进制做 `libnode.so` | 无 rootfs、体积小 | ❌ 退回 nodejs-mobile 的困境（Node 版本/无 bash-git），与"完整能力"目标矛盾 |

→ **定案：PRoot + Ubuntu rootfs + Node 22 + `targetSdk 28`。** 这也是 Termux/AndroidIDE 生态验证过的唯一成熟组合。

### 4.3 与 DSH Go 的形态对齐（只借形态，不借代码）

| 维度 | DSH Go（参考） | 本计划 |
|---|---|---|
| 运行时 | PRoot Ubuntu + Node，APK 内带 rootfs tar.xz | 同形态 |
| 启动 | direct 默认关、失败回退兼容启动 | 采"默认兼容启动，direct 仅开发选项"（避免 Android 16 拦截路径） |
| 保活 | `specialUse` 前台服务 + `PARTIAL_WAKE_LOCK` + 条件 `START_STICKY` | 同，且如实标注"锁不免除 Doze/厂商杀进程"，配电池优化引导 |
| 资产 | rootfs 随包携带不联网下载（可拆 base/engine 两层） | 第一步单层 `rootfs-arm64.tar.xz`；体积超预算再拆层 |

**红线**：DSH Go 是 AGPL-3.0，**一行代码都不抄**，只采形态与工程经验。

### 4.4 体积 / 启动预算（先立预算，再验证）

| 项 | 预算 | 依据 |
|---|---|---|
| 现有 APK | 3.1MB（0.2.5） | 实测 |
| 便携包（`--no-browser`） | ~25MB | `scripts/make-portable.mjs` 注释自述 |
| Ubuntu base rootfs（xz） | 30~50MB | 需 spike 实测 |
| Node 22 arm64 官方二进制 | ~25MB（xz） | 实测钉版本 |
| **目标 APK 总量** | **≤ 120MB** | 超过则拆 base/engine 两层或裁 rootfs |
| 冷启动到可登录 | **≤ 5s** | 超过则做 rootfs 常驻（不重复解压）+ 预热 |
| 首次安装解压耗时 | ≤ 30s，**必须给进度 UI** | 用户可感知 |

---

## 5. 阶段划分

每阶段独立可回滚。**S1/S2 是硬闸门：不通过不进 S3。**

### S0 — 决策与纸面淘汰（✅ 本轮已完成）

产出：本文件 + `mobile-app-plan.md` v3 + 交接单事实修正（Node 版本、A 路线已落地程度）。

### S1 — Spike-A：PRoot 里手跑通完整服务端（不改任何代码）

**目的**：只验证"便携包在 ARM64 Android 上跑得起来、能登录、能聊、会话能落盘"。
**手段**：Termux（F-Droid 版）+ `proot-distro` + Ubuntu + 官方 Node 22 tarball + 现有 `polaris-lite-portable/`（read-only 拷贝，**不重新打包、不碰 ① 的 make-portable.mjs**）。

步骤（在手机上执行）：

```
# 1. Termux（务必 F-Droid 版，Play 版已停更）
pkg update && pkg install proot-distro -y
proot-distro install ubuntu
proot-distro login ubuntu

# 2. Ubuntu 内装 Node 22（apt 的版本过旧，用官方 tarball）
apt update && apt install -y curl xz-utils ca-certificates
curl -LO https://nodejs.org/dist/v22.22.2/node-v22.22.2-linux-arm64.tar.xz
tar xf node-v22.22.2-linux-arm64.tar.xz -C /opt
ln -sf /opt/node-v22.22.2-linux-arm64/bin/node /usr/local/bin/node
node -v   # 期望 v22.22.2

# 3. node:sqlite 自检（版本下限的真正依据）
node -e "const{DatabaseSync}=require('node:sqlite');new DatabaseSync(':memory:').exec('create table t(a)');console.log('sqlite OK')"

# 4. 拷便携包（PATH 换成手机上的实际路径）
mkdir -p ~/plite && tar xf /sdcard/plite-portable.tar -C ~/plite

# 5. 起服务（注意必须 cd 到包根：prod-server 的 dist 默认 = cwd/dist）
cd ~/plite
export PLITE_DATA_DIR=$HOME/plite-data
export PORT=9825
node server/prod-server.mjs
```

**通过判据**（全部满足才进 S2）：

| # | 判据 | 记录项 |
|---|---|---|
| C1 | `node -v` = 22.x 且 node:sqlite 自检 OK | 版本号 |
| C2 | `node server/prod-server.mjs` 起来无 ESM/native 报错 | 首个报错原文（若有） |
| C3 | 手机浏览器 `http://127.0.0.1:9825` 能打开、能完成首登（= owner 注册） | 登录截图 |
| C4 | 配一个 real-engine 供应商，**聊一轮流式回复成功** | 首字延迟 |
| C5 | 杀掉进程重启，会话仍在 | — |
| C6 | `agent-files` 写一个文件、`html-preview` 打开一次 | — |
| C7 | `agent-bash` 能执行 `ls`、`git --version` | Ubuntu 内应为 ✅ |
| C8 | 冷启动到可登录耗时、`free -h` 内存占用、rootfs 解压后体积 | 三个数字 |

**已知必查点**：`PORT` 用 9825（与桌面同值，语义清晰：手机上的 9825 是本机实例，与桌面生产无关）。

### S2 — Spike-B：exec 合法性验证（`targetSdk 28` 闸门）

**目的**：证明"APK 私有目录里 exec rootfs 二进制"在目标机型 + `targetSdk 28` 下成立——这是整个方案的**唯一门禁**，S1 全过但 S2 不过 = 方案作废。
**手段**：最小验证包，不改业务代码。

| 步骤 | 内容 |
|---|---|
| B1 | 复制一份 `android/` 到临时目录（**不改仓内 android/**），`targetSdkVersion` 改 28，打一个只带 `proot` + `loader` + 迷你 rootfs 的空壳 APK |
| B2 | 首启把 rootfs 解到 `filesDir`，然后 `Runtime.exec()` 跑 rootfs 内的 `/bin/echo hello` |
| B3 | 若 B2 通过 → 换成真 rootfs，跑 `node -v` |
| B4 | 同时对照测一次 `targetSdk 36` 的同款 APK（预期失败），把失败日志存档 —— **这是"为什么必须降 SDK"的铁证**，写进文档 |

**通过判据**：`targetSdk 28` 下 `node -v` 有输出。失败则触发 §8 的 P0 风险处置（回到 §4.2 的退路②/③ 重新评估，本计划暂停）。

### S3 — 壳集成：内嵌运行时 + 首次释放

| 改动点 | 文件 | 说明 |
|---|---|---|
| rootfs 随包 | `android/app/src/main/assets/rootfs-arm64.tar.xz`（新增） | 首启解压到 `filesDir/plite-runtime`，幂等（版本戳文件） |
| proot/loader 可执行 | `android/app/src/main/jniLibs/arm64-v8a/libproot.so` 等（新增） | 以 `lib*.so` 命名从 `nativeLibraryDir` 取，规避 W^X |
| Node 启动 | `MainActivity.java` 或新 `RuntimeLauncher.java` | `ProcessBuilder` 起 `node server/prod-server.mjs`，显式 `chdir` 到包根（`prod-server.mjs:57` 的 dist 是 cwd 敏感） |
| 环境变量 | 同上 | `PLITE_DATA_DIR=<filesDir>/plite`、`PORT=9825` |
| 首启进度 UI | 引导页 | 解压进度 + 失败可重试，绝不留白屏 |
| 切源 | `MainActivity.java:78-92` 既有 `plite://set-server` | 新增"本机档"：直接写 `http://127.0.0.1:9825`，**无需用户手输** |

**回滚点**：若 S3 不稳定，退化为"A 路线 + 本机档入口隐藏"，用户仍可用连接档，不砸现有可用性。

### S4 — 数据目录与锚定修正（**唯一需要动 `server/`+`plugins/` 的阶段**）

| 问题 | 证据 | 修法 |
|---|---|---|
| `plugin-manager` 锚定仓库根 | `plugin-manager/server.mjs:27` `resolve(dirname(fileURLToPath(import.meta.url)),'..','..')` | 改为"包根 = `import.meta.url` 上两级"仍是包根，但市场扫描源目录要改为可配置 + 手机只扫内置清单 |
| `plugin-market` 同款 | `plugin-market/server.mjs:46` | 同上 |
| `dist` cwd 敏感 | `prod-server.mjs:57` | 启动器里显式 `chdir` 包根即可，**代码零改动**（首选） |
| `engines` 缺失 | `package.json` 无 `engines` | 补 `"engines": { "node": ">=22.13" }`，与 `polaris-lite-portable/README.md` 的"20+"一起修正（文档债 §9） |

> ⚠️ **此阶段必须等 ① release 完成**——`server/prod-server.mjs`、`server/host.mjs`、`plugins/server-registry.mjs` 都在 ① 的改动集里，现在动必然冲突。

### S5 — 保活与生命周期

- 前台服务：`specialUse` 类型 + 常驻通知（"Polaris 运行中"），`AndroidManifest.xml` 补 `FOREGROUND_SERVICE` / `FOREGROUND_SERVICE_SPECIAL_USE` / `POST_NOTIFICATIONS`（当前只有 `INTERNET`，`:41`）
- `PARTIAL_WAKE_LOCK` 运行期持有；`START_STICKY` 条件恢复（用户主动停止则不恢复）
- 电池优化白名单引导页（各厂商路径不同，给文案即可，不追求自动）
- **诚实边界**：Doze / 厂商杀进程 / 内存回收无法完全免疫 → UI 上给"服务已停止，点此重启"，不做"永不掉线"的承诺
- `standalone-mode` 语义改判（`index.tsx`）：本机档 = `reachable` 直连 127.0.0.1 恒真 → 需区分 `mode: 'local' | 'connected' | 'standalone'`
- `phone-agent` 评估：本机档下端点语义消失，建议**默认关闭**，保留连接档行为

### S6 — 安全 P0（与 `docs/dsh-security-comparison.md` 对齐）

本机跑服务端把"暴露面"从"局域网里的一台电脑"变成"手机自己"，以下三项**必须**随 S3/S5 一起做，不能后置：

| 项 | 具体要求 |
|---|---|
| R1 监听地址显式化 | 默认必须 **`127.0.0.1`**，不得 `0.0.0.0`（否则同一 Wi-Fi 任何人可访问你的手机 AI） |
| R3 传输层 | `capacitor.config.json` 的 `allowMixedContent: true` 收掉；`usesCleartextTraffic` 仅对本机回环保留（Android 允许 `127.0.0.1` 明文豁免评估） |
| R4 审批不可伪造 | 审批需服务端记账 + 一次性 token（本机档下审批 UI 与执行同进程，风险更高，不能省） |

### S7 — 收口

降级清单 UI（❌ 能力的灰态与原因）、体积/启动实测回填 §4.4、文档债、回归冒烟（375×812）。

---

## 6. 改动文件总览（供 ① 落地后比对）

| 阶段 | 新增 | 修改 |
|---|---|---|
| S3 | `android/.../assets/rootfs-arm64.tar.xz`、`jniLibs/arm64-v8a/libproot.so` 等、`RuntimeLauncher.java` | `MainActivity.java`、`AndroidManifest.xml`、`variables.gradle`（targetSdk 36→28） |
| S4 | — | `plugins/plugin-manager/server.mjs`、`plugins/plugin-market/server.mjs`、`package.json`（engines） |
| S5 | `ForegroundService.java`、通知渠道配置 | `AndroidManifest.xml`、`plugins/standalone-mode/index.tsx`、`plugins/phone-agent/*` |
| S6 | — | `server/prod-server.mjs`（监听地址）、`capacitor.config.json` |
| S7 | `docs/deploy-android-standalone.md` | `polaris-lite-portable/README.md`、本文件 |

**本轮（S0）不碰任何上述文件。**

---

## 7. 风险表

| # | 风险 | 概率 | 影响 | 对策 |
|---|---|---|---|---|
| P0 | `targetSdk 28` 下 exec 仍被机型/ROM 拦 | 低 | 方案作废 | S2 是闸门，先验再投入；B4 留铁证日志 |
| P0 | `targetSdk 28` 引发其它兼容问题（权限模型、分区存储） | 中 | 需逐条回归 | 现有 APK 3.1MB 极轻、只用 WebView + 文件读写，风险面小；S2 顺带回归 |
| P1 | rootfs 体积/启动超预算 | 中 | 体验差 | 拆 base/engine 两层；rootfs 常驻不解压；Node 预启动 |
| P1 | 厂商杀进程导致"假独立" | 高 | 用户体感"还是不行" | 前台服务 + wake lock + 引导页 + 诚实提示，**不承诺永不掉线** |
| P1 | `node:sqlite` 实验性 API 变更 | 低 | 升级 Node 时炸 | 钉死 Node 版本，写入文档 |
| P2 | PRoot 性能损耗影响 agent-bash 长任务 | 中 | 慢 | 实测记录；重活仍建议连电脑 |
| P2 | ① release 后基线漂移，行号/产物全变 | 高 | 返工 | **S4 前重新 grep 定位**，不依赖本文行号 |
| P3 | AGPL 污染 | 低 | 法务 | 只读设计文档，代码自写 |

---

## 8. 与 ① 的边界（红线）

1. 本轮（S0）：**只读**。不改 `server/`、`plugins/`、`android/`、`scripts/`；不动 `polaris-lite-portable/`（不重打包）。
2. S1 spike 用现有便携包副本即可（基线可能早于 ①，不影响"运行时可行性"这一结论的有效性）。
3. S4 起才碰代码，前提：① release 完成。
4. 9825 = 生产（桌面），只读观察；spike 在手机上跑，不连桌面生产。
5. 9826 = 钉住的 clone，只走 `npm run deploy:9826`。
6. 不抄 DSH Go 代码。不承诺 iOS。

---

## 9. 文档债清单

| 文档 | 要改什么 | 时机 |
|---|---|---|
| `docs/mobile-app-plan.md` | §1「不做手机跑 Node」→ 改为"v3 起采纳"；§10.1 能力边界表；§11 结论回写"纯插件只到前端层" | ✅ 本轮已改（v3） |
| `polaris-lite-portable/README.md` | "Node.js 20+" → "Node ≥ 22.13"（实测下限，非 22.5） | S4 |
| `docs/handoff-mobile-standalone-2026-11-26.md` | §4.1 的 v24.13.0 → 实际 v22.22.2；§3 的"A 路线未落地" → A 已落地大半 | ✅ 本轮附注 |
| `docs/deploy-android-standalone.md` | 新建：手机独立档部署与排障 | S7 |

---

## 10. 下一步（等你确认后执行）

1. 你在手机上按 §5-S1 跑一遍，把 C1~C8 的数字发我（我可以先帮你把命令整理成一份可复制的清单）。
2. 我据此把 §4.4 的预算改成实测值，并把 S2 的最小验证包方案细化。
3. S1/S2 都过 → 等 ① release → 进 S3。
