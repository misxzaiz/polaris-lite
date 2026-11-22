# polaris-lite 协作须知（AI / agent 必读）

## 环境纪律（最高优先级）

- **开发/调试/冒烟一律用开发环境：`http://127.0.0.1:5000`**（启动：`npm run dev:standalone`，数据目录 `.polaris-lite-dev/`，账号 `root / 1234`）。
- **生产环境是 `http://127.0.0.1:9825`**（数据目录 `.polaris-lite/`，账号 `boss`）：只读观察可以，**禁止写入、禁止重启、禁止把测试数据写进去**。
- **9826 是「钉住」的分析实例**：代码在独立 clone `D:\space\base\polaris-lite-9826`，**不随本仓库 build 自动更新**；升级一律走 `npm run deploy:9826`（详见 docs/pm2-9826-isolation.md）。对它写入/重启是允许的。
- 判断环境只看端口：5000 = 开发；9825 = 生产；9826 = 钉住的分析实例。
- **发版一律 `npm run release`**（仓库本体执行）：自动 commit→push→deploy:9826→build+restart 9825→三处 commit 一致性终检（git HEAD / 9826 clone / 9826 版本戳）。禁止手工拼 deploy/build/restart 组合——顺序错了会出现「9825 新代码、9826 旧 commit、app-updater 误报更新」的版本漂移。先 `npm run release -- --dry` 看状态。详见 docs/release-runbook.md。
- 上游策略（2026-11-22 用户决定）：**默认不限制**——dev/生产均允许任意 http/https 主机（含 localhost、局域网、私网），无需白名单。要恢复旧防线（https-only + 白名单 + 私网拦截）设 `PLITE_UPSTREAM_STRICT=1` 重启对应进程。
- 忘记密码/需要重置：改对应数据目录的 auth-owner.json（scrypt salt+passwordHash，64 字节），或直接删掉它——下次登录即重新注册。当前生产（9825）账号：boss / 1234；开发（5000）：root / 1234。
- 需要造数据/跑迁移/试脚本时，把目标 URL 指到 5000；发现自己在对 9825 做写操作，立即停止。

## 快速参考

- 前端/插件改完：`npm run typecheck && npm test && npm run build:plugins`
- 启动开发环境：`npm run dev:standalone`（改前端源码后需 `--build` 重建 dist）
- 服务端插件（server 半边）：放 `plugins/<id>/server.mjs` 并在 `plugins/server-registry.mjs` 登记
- 插件数据存储：用 `cap.kv`（kv-store 插件，服务端 sqlite），不要用 localStorage
