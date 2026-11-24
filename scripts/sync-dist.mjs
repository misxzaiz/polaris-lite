/**
 * sync-dist.mjs：build 收尾——把 public/ 里「构建期之后仍会被单独修改」的动态文件同步进 dist/。
 *
 * 背景（2026-11-20 真机事故）：vite build 只在构建时刻快照 public/*；
 * 此后每次改 public/grants.json（如补插件授权 v12→v14）不会自动进 dist——
 * 而 prod-server 服务的是 dist/。结果：新插件 bundle（provides cap.market.tool）
 * 配上旧 grants（未授权）→ assertProvides 抛「not declared to provide」整插件加载失败，
 * 手机/桌面一致报错。插件 bundle 同理：build:plugins 只写 public/plugins/。
 *
 * 同步清单（幂等，覆盖式）：
 *   grants.json                       —— 授权表（vite 快照后常改）
 *   plugins/<id>/{plugin.js,plugin.json,style.css} —— build:plugins 的产物
 *   plugins/registry.json             —— 构建期登记表
 *
 * 用法：node scripts/sync-dist.mjs（npm run build 已在尾部自动调用）
 */
import { existsSync, readdirSync, statSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = join(repoRoot, 'public');
const distDir = join(repoRoot, 'dist');

if (!existsSync(distDir)) {
  console.error('[sync-dist] dist/ 不存在——请先 vite build');
  process.exit(1);
}

let copied = 0;
const copy = (srcRel) => {
  const src = join(repoRoot, srcRel);
  const dst = join(distDir, srcRel.replace(/^public[\\/]/, ''));
  if (!existsSync(src)) return;
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  copied += 1;
};

// 授权表与其它 public 根下的动态 JSON
for (const f of ['grants.json']) copy(join('public', f));

// 插件产物（每个 <id>/ 下的三件套）+ registry
const pluginsDir = join(publicDir, 'plugins');
if (existsSync(pluginsDir)) {
  for (const id of readdirSync(pluginsDir)) {
    const p = join(pluginsDir, id);
    if (!statSync(p).isDirectory()) continue;
    for (const f of ['plugin.js', 'plugin.json', 'style.css']) {
      if (existsSync(join(p, f))) copy(join('public', 'plugins', id, f));
    }
  }
}
copy(join('public', 'plugins', 'registry.json'));
// esm-shim：插件 import map 的解析目标，随插件产物一起同步（漏同步会用到陈旧 shim）
if (existsSync(join(publicDir, 'plugins', 'esm-shim.mjs'))) copy(join('public', 'plugins', 'esm-shim.mjs'));

console.log(`[sync-dist] 已同步 ${copied} 个文件到 dist/（grants/插件产物/registry）`);
