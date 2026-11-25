# 排查报告：AI 对话发送后关闭 App/浏览器，后台没有继续处理

**日期**：2026-11-25
**结论**：该问题在当前代码（服务端编排 agent-runner 通道）上**已不存在**——E2E 实测「发消息后彻底关闭页面（等价杀 App）」，服务端 run 继续执行 30s+ 并正常收敛、产物落盘。用户遇到的现象来自**旧链路（前端 agent-loop 通道）**：循环跑在页面 JS 闭包里，关页面=杀任务。只要手机/浏览器装的是 2026-11-25 10:44（commit `141116b`）之前的 chat-lite（0.2.3 APK 内置、或当天上午前的网页缓存），就会复现。

---

## 1. 架构事实（排查确认）

- App 是纯 WebView 壳（Capacitor），AI/工具/会话全在电脑端 Node 服务（连接档 9825 / dev 5000）。`MainActivity.java` 首启引导填电脑地址后 `loadUrl` 切源，一切相对 `/api/*` 请求都打到电脑。
- chat-lite 发送链路（`plugins/chat-lite/index.ts:746`）：优先 `POST /api/agent/start`（服务端编排 agent-runner），探活失败才回落旧通道 `cap.agent.loop`（前端闭包循环）。
- agent-runner 服务端（`plugins/agent-runner/server.mjs`）：
  - 循环在服务端异步执行，HTTP start 立即返回 runId；
  - 事件先落盘（`agent-runs/<runId>.events.jsonl`）再 SSE 扇出；
  - SSE 断开只做 `run.subs.delete(res)`（server.mjs:1422），**不 abort run**；
  - 唯一停止路径：`POST /api/agent/interrupt`、护栏到顶、跑完收敛、进程重启。

## 2. 实测证据

### 2.1 关页面持久性 E2E（本次新增，`tests/_aichat/goal-close-page-persistence.mjs`）

在 dev(5000) 真实跑通：新会话发 48s 长任务 → run 启动（76ms 进入 running）→ **导航到 about:blank 并杀掉 Chrome 进程** → 服务端轮询：

| 时刻 | /api/agent/state |
|---|---|
| 关页面后 30s | `running: true, seq: 100`（仍在跑） |
| 关页面后 60s | `running: false`（已收敛） |

事件日志 `r-mww3cw53-19746761.events.jsonl` 完整记录了页面死后继续产生的 bash 执行、files_write、message.delta「后台任务完成」、loop.done；产物 `.polaris-lite-dev/workspace/goal-close-check.txt` 六行 tick 全部落盘。报告：`tests/_aichat/refresh-reports/goal-close-report.json`。

### 2.2 现存 run 日志面

`.polaris-lite-dev/agent-runs/` 74 个 run 全部以 `stop`/`INTERRUPTED`（均有标记）收敛，无「静默死亡」形态；最长 169s，符合各自主任务时长。

### 2.3 版本考古（用户为何仍见旧现象）

| 载体 | chat-lite 形态 | 结论 |
|---|---|---|
| 0.2.2/0.2.3 APK（11-21/11-22） | **内置旧 plugins**（含 chat-lite plugin.js，`grep cap.agent.loop` 命中 12 处、`api/agent/start` 0 处） | 纯前端 loop，关页面杀任务 |
| 0.2.4 APK（11-24 18:19） | 未内置 plugins（打包缺 plugins 目录），但早于 runner 合入 | 若切源成功→用 9825 当时的旧 chat-lite（仍无 runner） |
| 0.2.5 APK（11-25 19:03） | 未内置 plugins；切源后从 9825 拉到**含 runner 的 chat-lite**（19:07 产物，`api/agent/start` 已打入） | 理论上已修复 |
| 9825 现网 | 40 个插件，chat-lite 含 runner；`/api/agent/state` 401 门禁正常 | 服务端就绪 |

即：**只要手机上跑的 chat-lite 是今天 10:44 之前的版本（0.2.3 内置包，或 9825 当时的旧插件），「关闭页面任务死」就是那个版本的真实行为**；新版已从根上修掉。

## 3. 残留风险（与「感觉任务停了」相关的次生因素）

1. **通知不可达**：完成通知（notification-center 的 done toast）只在页面活着时弹出。关了 App，任务其实跑完了，但用户没有任何感知——「没继续处理」的体感可能部分来自这里（无推送通道是 mobile-app-plan 明确不做的项）。
2. **手机休眠断网**：Android 壳 WebView 在息屏/后台时会冻结 JS、断 SSE；这**不影响**服务端 run 继续，但回前台前看不到进度。`restoreRunnerRuns`（chat-lite setup 3s 后对账）已做：回前台/刷新后会从事件日志重放追平。
3. **旧通道看门狗**：前端 agent-loop 的 watchdog 只软提示不收敛，但页面一关整个闭包消失——旧通道无解，属设计淘汰路径。
4. **审批卡死**：confirm 模式下工具审批挂 120s 无人应答自动拒绝；若用户关页面前任务正等审批，回来看到的是「被拒」而非「继续」——这是既有语义（无人值守拒绝），不是「任务死了」，但观感接近。

## 4. 处置建议

1. **升级手机端到 0.2.5+**（并确认已切源到 9825、插件从 9825 拉取）；浏览器端强刷一次（或清 SW 缓存）确保 chat-lite 是 11-25 之后的产物。旧版行为（关页面杀任务）随旧 chat-lite 淘汰。
2. **核对 0.2.5 真机实际生效**：在 App 里打开同一会话发长任务，关 App 2 分钟后回来——消息流应自动追平（事件日志重放）。若未追平，查 `console` 的 `[chat-lite] detectLoop` / `probeRunner` 日志与 `/api/agent/state`。
3. **打包纪律**：0.2.4/0.2.5 APK 均未把 `dist/plugins` 打进包（`unzip -l | grep plugins/` 为 0）。当前连接档靠切源后从服务端拉插件没问题，但按 `docs/apk-release-guide.md` 的检查清单，包内应能 grep 到 `assets/public/plugins/registry.json`——下次打包含规检查要补上（独立档/无电脑场景会踩空）。
4. **可选增强**（若「关 App 也要知道做完了」是硬需求）：服务端 run 收敛时经 phone-gateway 给手机发一条本地通知（手机在前台/最近活跃时可达）；或接入系统推送（mobile-app-plan §1 已列「不做双端推送」，需要时再立项）。

## 5. 本次改动

- 新增 `tests/_aichat/goal-close-page-persistence.mjs`：彻底关页面（非刷新）持久性 E2E，结论报告落 `tests/_aichat/refresh-reports/goal-close-report.json`。
- 未改动任何业务代码——问题在旧版本载体上，当前代码路径已验证为断连安全。
