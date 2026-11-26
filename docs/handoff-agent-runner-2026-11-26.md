# 交接单 ①：agent-runner 服务端编排收尾（提交与发版）

> 生成时间：2026-11-26 13:50
> 来源会话：zcode `sess_c10cf928-0e6b-42b7-879e-3a8fc9f95ded`（标题「接手继续实施直到完成 …/share/4f20811…」）
> 接手人：本会话（WorkBuddy）
> 另一条并行任务见 `docs/handoff-mobile-standalone-2026-11-26.md`（**不要**把两边的改动混进同一提交）

---

## 0. 一句话现状

功能已全部实现、门禁已全绿（typecheck 绿 / 死能力探测全绿 / **363 用例 363 通过**），
**唯一没做的是「提交 + 发版」**——上一步正在跑 `npm run build:plugins` 时进程中断。
工作区现在 **73 项未提交**（29 改 / 3 删 / 41 新增），其中**大量是构建产物与调试垃圾，不能整体 `git add .`**。

---

## 1. 这条改动线在做什么

一句话：**把前端的 agent 编排主循环搬到服务端 runner，并把宿主侧工具能力补齐给服务端 loop 调用。**

三条主线：

1. **loop 服务端化**：`plugins/agent-loop/`（前端 loop，1650 行 `index.ts` + `tool-summary.ts` + `vite.config.ts`）整体删除，
   编排主循环落在 `plugins/agent-runner/server.mjs`（净减约 900 行，事件形状与前端保持一致）；
   `tool-summary.ts` 迁到 `plugins/shared/tool-summary.ts` 供前后端共用。
2. **引擎适配器注册表**：新增 `server/adapter-registry.mjs`，`real-engine` 补上 server 半边
   （`plugins/real-engine/server.mjs`，新文件），CodeBuddy 补服务端适配器
   （`runTurn` / `resolveModel` / `systemHint`、采纳 runner 已执行工具、option 透传）。
3. **宿主工具适配器**：新增 `plugins/agent-runner/tool-adapters.mjs`，把
   `suggestions` / `transcript` / `translate` / `phone` / `market_*` 这批「宿主端能力」暴露成服务端 loop 可调用的工具，
   直接消灭了此前的 **16 条死能力警告（16 → 0）**。

### 附带修掉的真实 bug

- `runLoop` 里 `let turn` 在 `try` 块内声明，`catch` / `finally` 是同级块 → 任何早于循环的异常都会抛
  `run-fatal: turn is not defined`（已实证复现）。已把声明提到 `try` 之外。
- `transcript-share` 的 `/api/share/*` 与 `phone-agent` 的 `/api/phone/command` 只认 cookie，
  服务端 loopback 调用拿不到会话 → 补 Bearer 双认证（`verifyTempToken`，与 skill-loader / mcp-bridge / translate 同一纪律）。

---

## 2. 已完成的验收项（会话内实测，均有输出为证）

| # | 项目 | 状态 | 证据 |
|---|---|---|---|
| 1 | 基线确认（typecheck / test 全绿） | ✅ | 起点即绿 |
| 2 | CodeBuddy 服务端适配器 | ✅ | 冒烟通过 |
| 3 | codebuddy manifest `supportsTools` 翻转 + chat-lite 回退直连 + runnerBridge option | ✅ | 纯对话 / CLI 自持工具循环 / 零订阅者跑完（=断联续跑）三种冒烟 |
| 4 | 死能力 16 → 0，suggestions/transcript/phone/market_* 适配器补齐 | ✅ | `suggestions stats` → `{"total":0,"bySource":{}}`；`transcript share` → 返回 `/share/<hash>` |
| 5 | 无依赖工具并行执行 + `readRunEvents` 增量读 | ✅ | 两个工具调用同轮并行发出并收敛 |
| 6 | `turn` 作用域 bug 修复 | ✅ | 修复前 `run-fatal: turn is not defined`，修复后同类跑法正常收敛 |
| 7 | docs 漂移修正（契约 §5.1 服务端适配器 / 编排计划状态头 / 历史文档横幅） | ✅ | `docs/ai-engine-contract.md`、`docs/agent-loop-plan.md`、`docs/agent-runner-implementation.md`、`docs/chat-server-orchestration-plan.md`、`docs/agent-ux-fixes-plan.md` |
| 8 | transcript / phone server 半边补 Bearer | ✅ | transcript share 走 Bearer 成功拿 URL |
| 9 | **全门禁 + 提交** | ⛔ **未完成** | 停在 `npm run build:plugins` |

最后一次完整门禁输出（13:19 左右）：

```
> tsc --noEmit && tsc -p tsconfig.plugins.json --noEmit
  ok  死能力探测完成：全部 provides 均有插件消费者
ℹ tests 363
ℹ pass 363
ℹ fail 0
```

> 注：会话上下文里的 `translate` 当时实测返回 `"Hello, world"`；末轮修完 Bearer 后重跑的 combination 是
> `transcript share` + `suggestions stats` 并行成功。**这些是 13:20 之前的状态，接手后必须复跑。**

---

## 3. 工作区改动清单（`git status` 实测，共 73 项）

### 3.1 属于本改动线 —— 要进提交

**修改（29）**

```
docs/agent-loop-plan.md
docs/agent-runner-implementation.md
docs/agent-ux-fixes-plan.md
docs/ai-engine-contract.md
docs/chat-server-orchestration-plan.md
plugins/agent-runner/server.mjs          (924 行改动，净减约 900)
plugins/ai-events/index.ts
plugins/build-plugins.mjs
plugins/chat-lite/index.ts               (移除写死的 CodeBuddy 直连通道)
plugins/chat-lite/runnerBridge.ts
plugins/codebuddy-engine/index.ts
plugins/codebuddy-engine/server.mjs      (+228)
plugins/phone-agent/server.mjs           (Bearer 双认证)
plugins/plugin-list.mjs
plugins/server-registry.mjs
plugins/starter-suggestions/index.ts
plugins/transcript-share/server.mjs      (Bearer 双认证)
plugins/voice-radio/controller.ts
plugins/voice-radio/index.ts
public/grants.json                       (+45，新 cap 授权)
server/host.mjs
server/prod-server.mjs
tests/agent-loop-compat.test.mjs
tests/auto-continue.test.mjs
tests/host-budget.test.mjs
tests/reasoning.test.mjs
tests/stream-retry.test.mjs
tests/unattended.test.mjs
tests/voice-radio.test.mjs
```

**删除（3，均为 loop 服务端化的必然结果）**

```
plugins/agent-loop/index.ts              (-1650)
plugins/agent-loop/tool-summary.ts       (-161，迁至 plugins/shared/tool-summary.ts)
plugins/agent-loop/vite.config.ts
```

**新增（6）**

```
plugins/agent-runner/tool-adapters.mjs   宿主工具适配器
plugins/real-engine/server.mjs           real-engine 的 server 半边
plugins/shared/tool-summary.ts           前后端共用工具摘要
server/adapter-registry.mjs              引擎适配器注册表
tests/codebuddy-toolcard.test.mjs        ** 必进 **：package.json 的 test 脚本已引用它
docs/handoff-agent-runner-2026-11-26.md  本文件
```

> ⚠️ `tests/codebuddy-toolcard.test.mjs` 是**未跟踪**状态，但 `package.json` 的 `test` 脚本里已经列了它。
> 漏提交 = 下次 `npm test` 直接报文件不存在。

### 3.2 明确不能进提交 —— 构建产物 / 调试垃圾

`.gitignore` **没有**覆盖这些（所以它们才出现在 `git status` 里）：

```
polaris-lite-0.2.4.apk
polaris-lite-0.2.5-release.apk
polaris-lite-portable.zip
polaris-lite-portable/            （make-portable 产物，含 node_modules 与 apk）
backup-9825-manual/
gui-test-screenshots/             （十余张 png + notification-center/）
logs/
dev-cookies.tmp.txt               ← **含凭据，绝不能入库**
tests/tests/                      （误建，内容 tests/tests/_aichat）
polaris-lite/                     （只剩一个 plugins 的残留副本）
tools-refresh-mcp.py.bak
tools-update-guide.py
analysis-report.md                （根目录散落报告，非交付物）
```

建议顺手把这些规则补进 `.gitignore`（`*.apk`、`polaris-lite-portable/`、`gui-test-screenshots/`、`logs/`、`dev-cookies.tmp.txt`），
否则它们会一直污染 `git status`，下次交接还得再判一遍。

### 3.3 不属于本线 —— 属于并行会话 ②

```
docs/dsh-security-comparison.md   ← dsh-Go 安全对照，另一条线（mobile standalone）的产出
scripts/make-portable.mjs         ← 便携包脚本，② 的本机运行方案要用到
```

这两个文件**不要**塞进本提交。`docs/dsh-security-comparison.md` 可以单独一个 `docs:` 提交，或留给 ② 一并提交。

---

## 4. 接手第一步：复跑门禁

工作区被两个并行会话同时在改过，**13:20 的绿色不代表现在还是绿色**。按 AGENTS.md 的快速参考逐条跑：

```bash
cd /d/space/base/polaris-lite
npm run typecheck        # 双 tsconfig：tsc --noEmit && tsc -p tsconfig.plugins.json --noEmit
npm run check:plugins    # 含死能力探测，必须仍是「全部 provides 均有插件消费者」
npm test                 # 42 个测试文件，约 130s，期望 363/363
npm run build:plugins    # 这是当初被打断的那一步
```

全绿再进提交。

---

## 5. 提交与发版方式（按 AGENTS.md，不要手工拼）

AGENTS.md 明文：**发版一律 `npm run release`**（自动 commit → push → deploy:9826 → build+restart 9825 → 三处 commit 一致性终检）。
禁止手工 `git commit` + `deploy:9826` + restart 混搭，否则会出现「9825 新代码 / 9826 旧 commit / app-updater 误报」。

```bash
npm run release -- --dry   # 先看它认为要提交什么、当前三处一致性如何
```

若 `--dry` 显示它会把上述垃圾一起提交，就先补齐 `.gitignore` 并把垃圾移出工作区，再走 release。
若只想先落一个不含发版的提交，至少也要用 `git add` 逐项点名（见 §3.1），**绝对不要 `git add -A`**。

建议提交信息分三条（或合成一条 feat，看 `--dry` 的判定）：

```
refactor(agent-runner): 前端编排循环服务端化 + 引擎适配器注册表

- 删除 plugins/agent-loop（前端 loop 1650 行），编排主循环落到 agent-runner/server.mjs，事件形状不变
- 新增 server/adapter-registry.mjs；real-engine 补 server 半边；codebuddy 补服务端适配器
  （runTurn/resolveModel/systemHint + 采纳 runner 已执行工具 + option 透传）
- 新增 agent-runner/tool-adapters.mjs：suggestions/transcript/translate/phone/market_* 宿主工具，
  死能力 16 → 0
- 无依赖工具并行执行 + readRunEvents 增量读
- fix: runLoop 的 turn 声明移出 try，消除 run-fatal: turn is not defined
- fix: transcript-share /api/share/* 与 phone-agent /api/phone/command 补 Bearer 双认证
```

---

## 6. 已知风险与坑

1. **两线并改同一工作区**：② 那条线也在改 `polaris-lite`（`docs/dsh-security-comparison.md`、`scripts/make-portable.mjs`），
   且它下一步可能要动 `android/`、`server/prod-server.mjs`、`MainActivity`。**先把 ① 落地（release 完）再让 ② 动手**，
   否则这批已验证绿的改动永远分不清边界。
2. **9825 是生产**：只读观察可以，禁止写库、禁止重启（AGENTS.md 环境纪律最高优先级）。冒烟请用 5000（`npm run dev:standalone`，root/1234）。
3. **9826 是钉住的 clone**（`polaris-lite-9826`），只走 `deploy:9826`。
4. **死能力探测是硬门禁**：如果新适配器名和 manifest 的 `provides` 对不上，`check:plugins` 会直接红。
5. **`dev-cookies.tmp.txt`** 里是登录凭据，别让它进 git 历史。
6. 会话记忆资产：`~/.zcode/cli/memories/projects/polaris-lite-*/memory/` 下有几份 md，
   是 zcode 侧的项目记忆，不属于本仓库交付物，别复制进来。

---

## 7. 验收标准

- [ ] `npm run typecheck` / `check:plugins` / `npm test`（363/363）/ `build:plugins` 四项全绿
- [ ] 提交只包含 §3.1 的点名文件，`git status` 里不再有本线相关项
- [ ] `.gitignore` 补上 §3.2 的产物规则（可选但强烈建议）
- [ ] `npm run release` 三处 commit 一致性终检通过（HEAD = 9826 clone = 9826 版本戳）
- [ ] 9825 起来后，用 5000 或浏览器实测一轮：新建会话 → 选 CodeBuddy/real-engine → 跑一轮带工具的任务 → 断网重连能看到事件重放
