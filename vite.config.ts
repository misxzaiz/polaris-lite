import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { createHost } from './server/host.mjs';

// 构建期注入当前 commit sha（app-updater 插件据此比对客户端/服务器版本）：
// - index.html 加 <meta name="plite-build-sha" content="<sha>">；
// - dev（vite dev 无 transformIndexHtml 之外的注入点）/ git 不可用时 meta 不存在，
//   app-updater 按「开发环境」降级（后台检查关闭，仅保留面板手动功能）。
function buildSha(): string {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}
const injectBuildSha = {
  name: 'polaris-lite-build-sha',
  transformIndexHtml(html: string) {
    const sha = buildSha();
    if (!sha) return html;
    return html.replace(
      '<meta name="theme-color" content="#ffffff" />',
      `<meta name="theme-color" content="#ffffff" />\n    <meta name="plite-build-sha" content="${sha}" />`,
    );
  },
};

// 宿主内嵌服务端（dev 形态）：鉴权 / 供应商配置 / 模型中继 全部走 server/host.mjs，
// 与 prod(node server) 同一份实现，避免两套行为漂移。
// 单端口 9825；密钥只在服务端（.polaris-lite/providers.json），前端永不持有明文。
const embeddedHost = {
  name: 'polaris-lite-embedded-host',
  configureServer(server) {
    // 插件产物禁缓存：build:plugins 改版后 reload 必须拉新 bundle，否则浏览器磁盘
    // 缓存启发式命中旧版（transferSize=0），表现为「改了没生效」的假象。
    // 仅 dev 服务端行为；prod 静态服务不受影响。
    server.middlewares.use((req, res, next) => {
      if (req.url?.startsWith('/plugins/')) {
        res.setHeader('Cache-Control', 'no-store');
      }
      next();
    });
    const { middlewares } = createHost({ dataDir: process.env.PLITE_DATA_DIR });
    for (const mw of middlewares) server.middlewares.use(mw);
  },
};

export default defineConfig({
  plugins: [react(), injectBuildSha, embeddedHost],
  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
  },
  server: {
    port: 9825,
    strictPort: true,
    host: '0.0.0.0', // 允许内网穿透/局域网访问（鉴权由会话 cookie 把守）
  },
  build: {
    target: 'es2020',
  },
});
