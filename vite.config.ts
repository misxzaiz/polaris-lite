import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { createAuthMiddleware } from './server/auth-session.mjs';
import { createRelayMiddleware } from './server/relay-core.mjs';

// 宿主内嵌 auth + 模型中继：dev(vite middleware) 与 prod(node server) 共用同一份逻辑。
// 单端口 9825；/api/auth/* 登录会话（HttpOnly cookie），/api/model-relay 仅放行已登录会话。
const embeddedHost = {
  name: 'polaris-lite-embedded-host',
  configureServer(server) {
    const auth = createAuthMiddleware();
    server.middlewares.use(auth.middleware);
    server.middlewares.use(createRelayMiddleware({ getSession: auth.getSession }));
  },
};

export default defineConfig({
  plugins: [react(), embeddedHost],
  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
  },
  server: {
    port: 9825,
    strictPort: true,
    host: '0.0.0.0', // 允许内网穿透/局域网访问（鉴权由会话 cookie 把守）
    // 模型 API 中继已内嵌为 /api/model-relay（见 embeddedHost），不再使用独立 9850 进程。
  },
  build: {
    target: 'es2020',
  },
});
