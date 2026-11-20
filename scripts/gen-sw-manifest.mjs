#!/usr/bin/env node
/**
 * gen-sw-manifest.mjs：构建后生成 SW 的产物清单（dist/sw-manifest.js）。
 *
 * 为什么需要：vite build 产出的 assets 带 hash 文件名，每次构建都变；
 * sw.js 若写死清单就永远喂旧文件。本脚本在 build 完成后扫 dist/assets/
 * 生成 `self.__PLITE_ASSETS = ['/assets/xxx.js', ...]`，由 sw.js importScripts。
 *
 * 生成位置=dist/（不是 public/）：public→dist 的拷贝发生在 vite build 过程中，
 * 而 sw-manifest 依赖 build 的产物清单，生成时拷贝早已结束——写 public 会错过。
 * dev:standalone 直接服务 dist/，所以 dist/ 即部署面。
 *
 * 挂载点：package.json 的 build 脚本（vite build && node scripts/gen-sw-manifest.mjs）。
 * 用法：node scripts/gen-sw-manifest.mjs   （须在 vite build 之后运行）
 */
import { readdirSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const assetsDir = resolve(repoRoot, 'dist', 'assets');

if (!existsSync(assetsDir)) {
  console.error('gen-sw-manifest: dist/assets 不存在——请先运行 vite build');
  process.exit(1);
}

const files = readdirSync(assetsDir)
  .filter((f) => /\.(js|css|woff2?|png|svg|webp)$/.test(f))
  .map((f) => `/assets/${f}`)
  .sort();

const out = `// 构建期生成（scripts/gen-sw-manifest.mjs）——勿手改\nself.__PLITE_ASSETS = ${JSON.stringify(files, null, 0)};\n`;
writeFileSync(resolve(repoRoot, 'dist', 'sw-manifest.js'), out);
console.log(`ok  dist/sw-manifest.js ← ${files.length} assets`);
