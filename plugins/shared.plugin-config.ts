/**
 * 外部插件构建共享配置。
 * 插件与宿主完全解耦：各自独立仓库式构建，产物为自足 ESM bundle。
 * react/react-dom 通过 import map 外部化（宿主已提供），不打进插件包。
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 以调用方配置文件所在目录为基准解析（shared 配置被各插件 vite.config 引用，
// import.meta.url 指向本文件，需要再向上一级到 plugins/，再拼插件子目录）。
const sharedDir = dirname(fileURLToPath(import.meta.url));

export function createPluginConfig(pluginDir: string, entry: string, outDir: string) {
  const base = resolve(sharedDir, pluginDir);
  return defineConfig({
    plugins: [react()],
    resolve: {
      alias: {
        // 插件唯一允许的宿主依赖面：@sdk → plugins/sdk（只含类型与常量契约）。
        // 刻意不再提供 '@' → src 别名：插件误引宿主实现会在构建期直接暴露，而不是形成隐式耦合。
        '@sdk': resolve(sharedDir, 'sdk'),
      },
    },
    build: {
      lib: {
        entry: resolve(base, entry),
        formats: ['es'],
        fileName: () => 'plugin.js',
      },
      outDir: resolve(base, outDir),
      emptyOutDir: true,
      rollupOptions: {
        external: ['react', 'react-dom', 'react-dom/client'],
        output: {
          // 外部依赖以裸 import 引用，由宿主 import map 解析
          globals: {},
        },
      },
    },
    define: {
      // 插件 bundle 运行在浏览器，无 Node process；react 内部的分支按生产路径折叠
      'process.env.NODE_ENV': JSON.stringify('production'),
    },
  });
}
