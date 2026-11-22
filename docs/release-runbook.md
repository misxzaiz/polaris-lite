# 发版运行手册（release runbook）

> 2026-11-22 制定。起因：当天发版 9826 出现「代码是新的、版本戳是旧的」，app-updater 误报
> 「有新版本」——根因是发版顺序没有固化，各环境各取各的代码来源。本手册 + `npm run release`
> 脚本把正确顺序固化为**一条命令**，任何 AI / 人照着跑都不会发错版。

## TL;DR：怎么发版

```bash
# 在仓库本体 D:\space\base\polaris-lite 执行
git add -A                  # 把要发布的改动 stage 好（未跟踪文件也会包含）
npm run release             # commit → push → deploy:9826 → build+restart 9825 → 一致性终检 → 冒烟
```

**就这一条命令。** 不要再手工拼 deploy:9826 / build / pm2 restart 的组合——顺序错了就会重演
版本漂移。想先看状态不想发布：

```bash
npm run release -- --dry        # 干跑：打印各环境版本对照，不执行任何变更
```

## 为什么必须走 release 脚本（三个环境的代码来源不同）

| 环境 | 代码来源 | 谁触发更新 |
|---|---|---|
| 5000 开发 | 工作树 | `dev:standalone` 起停，不参与发版 |
| 9825 生产 | 工作树 build 产物 | `npm run build` + `pm2 restart`（随仓库走） |
| 9826 钉住分析 | **独立 clone 的 origin/master** | 只有 `deploy:9826` 显式发布 |

差异点在 9826：它不读工作树，只认已 push 的 commit。于是：

- **先 commit+push、再 deploy:9826、最后 build/restart 9825**——三者对齐同一 commit 才是完整发版
- 任何一步顺序颠倒（比如先 build 9825 再 commit），就会出现「9825 跑新代码、9826 还在旧 commit」
  的漂移；app-updater 拿 9826 数据目录里的版本戳与 origin/master 比对，立刻暴露不一致

## release 脚本做了什么（scripts/release.mjs）

1. **预检**：工作树必须干净（或只有已 stage 的改动）；未跟踪文件不自动提交（避免把截图/临时
   文件带上去）
2. **commit + push**：改动已 stage 则自动 commit（message 可 `--msg` 指定，默认按改动文件推断
   scope）；无改动则视为「幂等重发当前 HEAD」
3. **deploy:9826**：复用既有脚本——clone reset 到新 commit → 构建 → `pm2 restart` → **写版本戳**
   （`.polaris-lite-pm2/app-updater-version.json` + clone/logs 部署日志一行）
4. **build + restart 9825**：生产环境随仓库走
5. **一致性终检**：`git HEAD` = `9826 clone HEAD` = `9826 版本戳`，三者不等直接报错退出，并给出
   修复提示
6. **HTTP 冒烟**：9825 / 9826 首页 200

可选项：

```bash
npm run release -- --msg "fix: xxx"   # 指定 commit message
npm run release -- --skip-9825        # 只发 9826（9825 由别处管理时）
npm run release -- --skip-9826        # 只发 9825（改动不涉及分析实例时）
```

## 版本戳机制（app-updater 误报的根因）

app-updater 插件（应用更新面板）的「服务器版本」读 `.polaris-lite-pm2/app-updater-version.json`
（9826 数据目录），**由 deploy-9826.mjs 在部署末尾 `stamp()` 写入**；前端拿它与 origin/master
最新 commit 比对提示更新。三个坑：

1. **发布的是 commit，不是工作树**——未提交的改动进不了 9826。脚本预检会拦。
2. **stamp 在 restart 之后**——deploy 中途被打断（终端断开、工具超时）会出现「代码新、戳旧」。
   核实：`npx pm2 jlist` 看重启时间 vs `type logs\deploy-9826.log` 最后一行。修复：手改
   `.polaris-lite-pm2/app-updater-version.json` 的 sha/subject 为实际运行 commit。
3. **9825 没有版本戳**——stamp 只有 deploy-9826 写。9825 上 app-updater 显示 sha: null，
   不提示更新。若要 9825 也参与版本提示，需在其发布流程（release 脚本步骤 4）加同样的写戳。

## 给 AI 的发版纪律（写进 AGENTS.md 的简化版）

> 发版一律 `npm run release`（在仓库本体执行），禁止手工拼 deploy/build/restart 组合。
> 脚本终检三处 commit 一致（git HEAD / 9826 clone / 9826 版本戳），不一致会报错并给出修复
> 指引。先 `--dry` 看状态，确认无误去掉 `--dry` 真发。

## 排查速查

| 症状 | 原因 / 处理 |
|---|---|
| 更新面板显示「有新版本」但功能已是新的 | 版本戳停在旧 commit（deploy 被打断 / 漏 stamp）。`type .polaris-lite-pm2\app-updater-version.json` 对照 `git log -1 origin/master`，不一致手改戳文件 |
| release 终检报「9826 版本戳 ≠ HEAD」 | deploy-9826 的 stamp 没跑完。重跑 `npm run release -- --skip-9825`，或手改戳文件后重跑终检 |
| release 预检报「工作树有未提交改动」 | `git add -A` 后重跑；确实不想发布的文件 `git stash` 或删掉 |
| 9826 打开 AI 空 | fresh clone 无 public/plugins（gitignore）。deploy 已带 build:plugins；手工补：clone 里 `npm run build:plugins && npm run sync:dist` |
| 两实例都没了 | daemon 消失：`npx pm2 resurrect` |

## 相关文件

- `scripts/release.mjs` — 统一发版脚本（npm script：`release`）
- `scripts/deploy-9826.mjs` — 9826 发布（含版本戳写入），被 release 调用
- `scripts/soft-deploy-9826.mjs` — 软发布（对话中安全重启），照旧独立使用
- `docs/pm2-9826-isolation.md` — 9826 隔离架构与版本戳机制细节
- `plugins/app-updater/` — 应用更新插件（版本比对展示）
