import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { createHost } from './server/host.mjs';

// 宿主内嵌服务端（dev 形态）：鉴权 / 供应商配置 / 模型中继 全部走 server/host.mjs，
// 与 prod(node server) 同一份实现，避免两套行为漂移。
// 单端口 9825；密钥只在服务端（.polaris-lite/providers.json），前端永不持有明文。
const embeddedHost = {
  name: 'polaris-lite-embedded-host',
  configureServer(server) {
    const { middlewares } = createHost({ dataDir: process.env.PLITE_DATA_DIR });
    for (const mw of middlewares) server.middlewares.use(mw);
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
  },
  build: {
    target: 'es2020',
  },
});
