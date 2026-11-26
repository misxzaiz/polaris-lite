/**
 * PM2 进程配置 —— polaris-lite 分析实例（9826 端口，代码隔离版）。
 *
 * 用途：一个「钉住」的常驻分析实例——不随本仓库 build 自动更新，只显式发布。
 * - 代码跑在独立 clone D:/space/base/polaris-lite-9826（origin 指向本仓库），
 *   与 9825 生产 / 5000 dev 彻底解耦；改插件、rebuild 本仓库不会泄漏到 9826；
 * - 独立数据目录（绝对路径钉在仓库本体的 .polaris-lite-pm2/，与代码发布无关）；
 * - 端口 9826（生产 9825 不受影响）。
 *
 * 发布/升级 9826 一律走一键脚本（拉代码→按需 ci→build→pm2 restart+save）：
 *   npm run deploy:9826                    # 发布仓库 master 最新 commit
 *   npm run deploy:9826 -- <sha|tag|分支>   # 发布指定版本
 *   npm run deploy:9826 -- --rebuild       # 不拉代码，只重建 clone 当前状态（实验模式）
 *   npm run status:9826                    # 查看分析实例落后多少
 * 详见 docs/pm2-9826-isolation.md。
 *
 * pm2 常用命令：
 *   npx pm2 start ecosystem.config.cjs      # 首次启动（须先 clone + build:plugins + npm run build）
 *   npx pm2 restart polaris-lite-9826       # 手动重启（改 ecosystem 后需 delete+start）
 *   npx pm2 logs polaris-lite-9826          # 看日志
 *   npx pm2 status                          # 看状态
 *   npx pm2 save                            # 保存进程表，宿主重启后 pm2 resurrect 恢复
 */
const path = require('node:path');

// 9826 专属 clone（与本文件同级的上一目录）；数据目录用绝对路径钉在仓库本体，
// 否则相对路径会解析到 clone 下变成空目录，分析数据看起来「丢了」。
const DEST = path.resolve(__dirname, '..', 'polaris-lite-9826');

module.exports = {
  apps: [
    {
      name: 'polaris-lite-9826',
      script: 'server/prod-server.mjs',
      cwd: DEST,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 20,
      restart_delay: 3000,
      env: {
        NODE_ENV: 'production',
        PORT: '9826',
        // 独立数据目录（绝对路径）：与 9825 生产、5000 dev 三者互不可见
        PLITE_DATA_DIR: path.resolve(__dirname, '.polaris-lite-pm2'),
        // deploy-panel 的唯一开关：9825 生产不设此变量 → /api/deploy/* 全 404，
        // 「部署」按钮即使被发布过去也点不出任何动作。
        PLITE_DEPLOY_PANEL: '1',
      },
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
