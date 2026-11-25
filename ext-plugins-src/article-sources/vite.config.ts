import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@sdk': resolve(base, '../../plugins/sdk'),
    },
  },
  build: {
    lib: {
      entry: resolve(base, 'index.tsx'),
      formats: ['es'],
      fileName: () => 'plugin.js',
    },
    outDir: resolve(base, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      external: ['react', 'react-dom', 'react-dom/client'],
      output: { globals: {} },
    },
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
});
