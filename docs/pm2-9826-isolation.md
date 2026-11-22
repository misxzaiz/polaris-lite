# 9826 分析实例隔离与一键发布

> 2026-11-22 起，9826 与仓库本体代码隔离。之前它和生产 9825 共用同一份代码目录，
> pm2 只隔离端口和数据目录——任何 `npm run build` 都会让 9826 的前端产物立刻换新
> （prod-server 对 `plugins/`、registry 等路径禁缓存、按请求读磁盘），服务端插件则在
> 下次 pm2 重启时吃进新代码，「钉住的分析实例」名存实亡。

## 现状架构

| 端口 | 用途 | 代码目录 | 数据目录 | 更新方式 |
|---|---|---|---|---|
| 5000 | 开发 | `D:\space\base\polaris-lite` | `.polaris-lite-dev/` | `npm run dev:standalone` |
| 9825 | 生产 | `D:\space\base\polaris-lite`（随仓库走） | `.polaris-lite/` | pm2（cwd=仓库本体） |
| 9826 | **钉住的分析实例** | `D:\space\base\polaris-lite-9826`（独立 clone） | `D:\space\base\polaris-lite\.polaris-lite-pm2\`（绝对路径） | **只在显式发布时更新** |

- clone 的 `origin` 指向本地仓库本体，发布不依赖 GitHub。
- pm2 配置在 `ecosystem.config.cjs`：`cwd` 指向 clone，`PLITE_DATA_DIR` 是**绝对路径**
  （改相对路径会解析到 clone 下变成空目录，数据看起来「丢了」）。
- 数据目录与代码发布无关：升级 9826 不会动分析数据。

## 日常操作（都在仓库本体执行）

```bash
npm run deploy:9826                    # 发布仓库 master 最新 commit（origin/master）
npm run deploy:9826 -- <sha|tag|分支>   # 发布指定版本（钉旧版对比分析用）
npm run deploy:9826 -- --rebuild       # 不拉代码，只重建 clone 当前状态（实验模式）
npm run status:9826                    # 查看分析实例落后仓库 master 多少
npm run soft:9826                      # 「软发布」：deploy 全流程丢进后台分离进程，人正挂在 9826 对话里也能安全触发
npm run soft:9826 -- log               # 看最近一次软发布的后台日志尾部
```

注意 npm 语法：传**带 `-` 的参数必须写 `--`**（`-- --rebuild`），否则 npm 把 flag 自己吞掉、静默走默认 deploy；非 flag 的 rev 直接跟在后面也行（如 `npm run deploy:9826 dd9621e`）。

## 软发布（soft:9826）：对话中安全重启

场景：你正挂在 9826 的 Web 对话里（比如正和 AI 聊着），此时想按最新代码重启 9826。
直接 `deploy:9826` 的问题：构建完成后 pm2 restart 会杀掉当前进程，正在流式输出的那轮回复被拦腰截断。

`npm run soft:9826`（`scripts/soft-deploy-9826.mjs`）把 deploy 全流程丢进
**detached + unref 的后台分离进程**执行：

- bash 调用立即返回，当前这轮 AI 回复正常说完；
- 构建（通常几十秒）期间对话继续，落库不受影响；
- restart 发生在流程最后，旧进程被杀时当前对话早已结束；pm2 `restart_delay: 3s` 拉起新实例；
- 浏览器走 stream-retry 自动重连，下一条消息即跑在新代码上，历史完整。

细节：

- 后台日志追加在 `logs/soft-deploy-9826.log`（仓库本体），`npm run soft:9826 -- log` 看尾部 40 行；
- 防重入：pid 文件（`logs/soft-deploy-9826.pid`）检测上一个后台发布是否还活着，活着就拒绝触发；
- 同 deploy 一样只发 **已 commit** 的内容（origin/master），先 commit 再 soft；
- 也可钉指定版本：`npm run soft:9826 -- <sha>`。

发布流程：fetch → `git reset --hard` 目标 commit →（`package-lock.json` 变了才 `npm ci`）→
`build:plugins` + `npm run build` → `pm2 restart` + `pm2 save` → 在 `polaris-lite-9826/logs/deploy-9826.log` 记一行版本戳。

约定与注意：

1. **发布的是 commit**。仓库工作树的未提交改动不在发布范围——想发 WIP 先 `git commit`
   （仓库本来就有「WIP: 全量工作快照」的习惯）。脚本检测到脏工作树会提示。
2. deploy 模式会 `reset --hard`：**clone 里的本地实验改动会被覆盖**。要保留请用
   `--rebuild`，或干脆直接在 clone 里改代码做实验（它是个正常 checkout）。
3. 逆向同样成立：想让 9826 跑一份**改过的** polaris-lite 做分析，直接在 clone 里改，
   仓库本体与 9825 不受影响。

## 陷阱与排查

| 症状 | 原因 / 处理 |
|---|---|
| **9826 打开什么都没有（UI 空）** | `public/plugins` 是 gitignore 的构建产物，fresh clone 没有；`npm run build` 的 `check:plugins` 只校验不生成。deploy 脚本已带 `build:plugins`；手工补救：clone 里 `npm run build:plugins && npm run sync:dist`，浏览器刷新即可。另注意 `/plugins/registry.json` 404 时会被 SPA fallback 伪装成 index.html——看 Content-Type 或直接 curl 看 JSON |
| 9826 没更新 | 钉住设计本就如此；先 `git commit` 再 `npm run deploy:9826`，`npm run status:9826` 看差距 |
| 登录/数据「变空」 | 检查 pm2 里 9826 的 `PLITE_DATA_DIR` 是否绝对路径（`npx pm2 env polaris-lite-9826`） |
| 两个实例都没了 | daemon 消失（如承载控制台被关/宿主重启）：`cd D:\space\base\polaris-lite && npx pm2 resurrect`，一条全恢复（2026-11-22 实测有效） |
| 改了 ecosystem 不生效 | `pm2 restart` 不吃新 `cwd`/`env`，要 `delete` + `start ecosystem.config.cjs` + `save` |
| clone 里也有 ecosystem/deploy 脚本 | 正常（首次发布后同步进来）；以仓库本体那份为准 |

## 文件清单

- `scripts/deploy-9826.mjs` —— 发布脚本（npm script：`deploy:9826` / `status:9826`）
- `scripts/soft-deploy-9826.mjs` —— 软发布脚本（npm script：`soft:9826`；detached 后台跑 deploy，对话中安全触发）
- `ecosystem.config.cjs` —— 9826 的 pm2 配置（cwd=clone、数据目录绝对化）
- `D:\space\base\polaris-lite-9826` —— 9826 专属 clone（origin=本仓库，钉在发布过的 commit）
