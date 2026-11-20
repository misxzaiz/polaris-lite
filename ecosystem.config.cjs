/**
 * PM2 进程配置 —— polaris-lite 稳定服务（9826 端口）。
 *
 * 用途：给 AI 修改代码时提供一个「不动」的常驻服务。
 * - 与 dev（vite 9825 / dev:standalone 5000）完全隔离：独立数据目录 .polaris-lite-pm2/；
 * - 端口 9826（生产 9825 不受影响）；
 * - dist 缺失时 pm2 启动会失败，请先跑 `npm run build`（见 scripts/rebuild-lite.sh / rebuild-lite.cmd）。
 *
 * 常用命令：
 *   npx pm2 start ecosystem.config.cjs      # 首次启动
 *   npx pm2 restart polaris-lite-9826       # 手动重启（一般不需要）
 *   npx pm2 logs polaris-lite-9826          # 看日志
 *   npx pm2 status                          # 看状态
 */
module.exports = {
  apps: [
    {
      name: 'polaris-lite-9826',
      script: 'server/prod-server.mjs',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 20,
      restart_delay: 3000,
      env: {
        NODE_ENV: 'production',
        PORT: '9826',
        // 独立数据目录：与 9825 生产、5000 dev 三者互不可见
        PLITE_DATA_DIR: '.polaris-lite-pm2',
      },
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
