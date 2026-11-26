# deploy-panel：9826 一键部署面板

> 目标：把「更新 9826 分析实例」从「让人在对话里跑命令（会把当前会话所在进程重启掉）」
> 变成「面板上点一下 → 后台跑 → 回来通知」。

## 为什么需要它

9826 跑在独立 clone（`D:\space\base\polaris-lite-9826`），代码不随仓库构建更新，升级必须
显式发布。而发布命令 `npm run deploy:9826` 里的 `pm2 restart polaris-lite-9826` 会重启
**发起者所在的进程** —— 如果是在 9826 的对话框里让 AI 执行，这条命令跑一半自己就没了。

面板把发布动作拆成两段：

```
浏览器 ──POST /api/deploy/run──► 9826（只写任务文件 + pm2 start 拉起 worker，立刻 202）
                                        │
                                        ▼  （pm2 托管：父进程是 pm2 daemon，不在 9826 进程树里）
                              scripts/deploy-worker.mjs
                                        │ spawn
                                        ▼
                              scripts/deploy-9826.mjs（reset → build → pm2 restart → 写版本戳）
                                        │
                                        ▼
                    <dataDir>/deploy/{job.json,last-run.json,job-<id>.log}
                                        │
浏览器 ──GET /api/deploy/status──► 读上述文件（轮询，页面重连后继续可见）
```

## 端点

| 端点 | 作用 | 关键行为 |
|---|---|---|
| `GET /api/deploy/status` | 版本差距 / 进行中的 job / 待确认的完成通知 | clone 的 `git fetch` 节流 10s；日志只回尾部 40 行 |
| `POST /api/deploy/run` | 投递一次发布 | 202 `{jobId,targetSha}`；已有活 job → 409；目标固定 `origin/master` |
| `POST /api/deploy/ack` | 标记完成通知已弹 | 幂等；旧 id 的迟到 ack 不会误标新通知 |

## 为什么 worker 必须由 pm2 托管（实测结论，不是选择偏好）

第一版用的是 `detached + unref` 子进程，理由是「Windows 上父进程退出后进程树断开」。
**实测证明这个判断是错的**：在 9826 里点「一键部署」，日志跑到
`[PM2] Applying action restartProcessId on app [polaris-lite-9826]` 就断了，
`job.json` 永远停在 `queued`，`last-run.json` 根本没写出来 —— pm2 停进程用的是
`taskkill /T`（沿 `ParentProcessId` 杀整棵进程树），detached 只换进程组、不改 PPID。

现在改成 `pm2 start scripts/deploy-worker.mjs --name plite-deploy-9826 --no-autorestart -- <dataDir> <jobId> <srcDir>`：
worker 的父进程是 pm2 daemon，`pm2 restart polaris-lite-9826` 从进程结构上就碰不到它。
两个配套措施：

- **幂等护栏**：`pm2 save` 会把本 app 存进 dump，机器重启后 `resurrect` 可能把它拉起；
  worker 启动时若发现 `job.json` 已经是 `done` 就直接退出，绝不在没人点按钮时又发布一次；
- **冷启动空窗期**：pm2 托管时 pid 要等 worker 起来才写，`queued + pid=null` 在 60s 内
  不判 `stale`，否则面板会瞬间显示「已中断」。

`node_modules/.bin/pm2` 不存在时才退回 detached（老机器可用，但具备上面那个已知缺陷，
日志会留痕）。

## 安全边界（这是本插件最重要的部分）

1. **实例门禁**：`PLITE_DEPLOY_PANEL=1` 或 `PORT=9826` 才启用，否则 `/api/deploy/*` 一律 404。
   9825 生产即使拿到了插件产物，端点也不存在 —— 「按钮存在但没接线」比「按钮能重启生产」
   安全一个数量级。加 `PORT` 判断是因为 `pm2 restart` 不会重载 ecosystem 的 env，
   只靠环境变量会在「改了配置但进程 env 还是旧的」时静默失效。
2. **会话门禁**：未登录 401（`getSession` 由宿主注入，复用 auth 插件）。
3. **目标写死**：只发布 `origin/master`，不接受任意 sha / 分支 / ref，也不 commit、不 push。
4. **单飞**：已有活 job 时 409，不做并发构建（两个 build 互相踩会把 clone 写坏）。
5. **进程判活**：`job.json` 里的 pid 死了 → status 判 `stale`，面板显示「已中断」并允许重投，
   不会被一次异常中断永久锁死。
6. **审计**：每次投递落 `<dataDir>/deploy-audit.log`（时间 / jobId / targetSha / pid / 操作者）。

## 完成通知为什么是「重启后拉」而不是「推」

成功发布的那一瞬间 9826 正在重启，页面不在，toast 弹不出来。所以：

```
worker 完成 → 写 last-run.json { ok:true, notified:false }
9826 新进程起来 → 前端 setup 的 watcher 轮询 status → 见到 notice →
   cap.ui.notify（toast + 通知中心 inbox，按 dedupeKey 去重）→ POST ack 置 notified:true
```

即便当时把页面关了，下次打开 9826 第一次轮询照样补弹一次，且能在「通知」Tab 回看。
失败不推通知：失败时 9826 没重启、页面还在，直接看 job 里的日志更准。

## 自举

这个面板本身也要先部署到 9826 才能用，所以：

```
第一次：仓库里 npm run release（或 npm run deploy:9826）—— 手工一次
之后：面板自助
```

## 故障处理

| 现象 | 含义 | 处理 |
|---|---|---|
| 面板显示「已中断」 | worker 进程没了（被系统回收 / 手工杀） | 直接「重新部署」 |
| 面板显示「已是最新」但按钮灰 | clone 与 origin/master 一致 | 无改动可发；若上次失败，按钮会变「重新部署」 |
| `DEPLOY_NO_TARGET` | clone 路径或 git 状态异常 | 检查 `D:\space\base\polaris-lite-9826` 是否存在、`git status` 是否正常 |
| `DEPLOY_BUSY` | 已有部署在跑 | 等它结束（面板会显示阶段） |
| 9825 上看到「本实例未启用部署面板」 | 预期行为 | 9825 是生产，不放发布动作 |

## 代码位置

```
plugins/deploy-panel/index.tsx      manifest + 完成通知 watcher
plugins/deploy-panel/Panel.tsx      面板（版本差距 / 一键部署 / 进度 / 历史）
plugins/deploy-panel/server.mjs     /api/deploy/* + pm2 托管投递
plugins/deploy-panel/panel.css
scripts/deploy-worker.mjs           一次性后台发布进程（pm2 app: plite-deploy-9826）
scripts/deploy-phases.mjs           输出行 → 用户可读阶段名（纯函数，可单测）
tests/deploy-panel.test.mjs         门禁 / 单飞 / 竞态 / 通知 / 阶段映射（15 条）
```

改完记得：`npm run typecheck && npm test && npm run build:plugins`，再 `npm run release`。
