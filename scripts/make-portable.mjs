#!/usr/bin/env node
/**
 * make-portable.mjs —— 生成「免安装便携包」。
 *
 * 背景：polaris-lite 运行时只需要 Node ≥20 + 极少外部依赖：
 *   - 服务端（server/*.mjs + 全部插件 server.mjs）只用 Node 内置模块；
 *   - 根依赖运行时只用 undici（AI 中继）；
 *   - browser-lite 私有依赖 puppeteer-core 装在 plugins/browser-lite/node_modules（相对解析，位置不可挪）。
 * 因此无需在新机器上 clone / npm install / build——把「dist + server + plugins(server 半边)
 * + undici + browser-lite 依赖」打进一个目录即可直接 `node server/prod-server.mjs` 运行。
 *
 * 打包内容（--browser-lite 开启时）：
 *   dist/                                 前端 + 插件 UI 产物 + grants（整体拷，防版本错位）
 *   server/                               宿主服务端 8 个 .mjs
 *   plugins/server-registry.mjs           服务端插件清单
 *   plugins/relay-hosts.json              上游白名单（upstream-policy 读取）
 *   plugins/<id>/server.mjs 等            各插件 server 半边（按依赖闭包收集）
 *   plugins/browser-lite/node_modules     puppeteer-core（裁剪非运行时目录）
 *   node_modules/undici                   根运行时依赖（裁剪 docs/types）
 *   package.json / package-lock.json      供 createRequire 解析 undici
 *   start.cmd / start.sh / README.md      启动脚本与说明
 *   plite-<ver>-release.apk               手机端（存在则附带）
 *
 * 用法：
 *   node scripts/make-portable.mjs                # 打包到 polaris-lite-portable/
 *   node scripts/make-portable.mjs --out D:/tmp/p # 指定输出目录
 *   node scripts/make-portable.mjs --zip          # 额外生成同名 zip（需系统 zip/PowerShell）
 *   node scripts/make-portable.mjs --no-browser   # 精简包：不带 browser-lite（~25MB）
 */
import {
  cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const withBrowser = !args.includes('--no-browser');
const outDir = resolve(String(opt('out', 'polaris-lite-portable')));
const wantZip = args.includes('--zip');

// ── 前置校验：必须先 build（dist 是运行形态）────────────────────────────
if (!existsSync(join(repoRoot, 'dist', 'index.html'))) {
  console.error('[portable] 缺少 dist/index.html —— 请先 npm run build 再打包');
  process.exit(1);
}
if (!existsSync(join(repoRoot, 'node_modules', 'undici', 'package.json'))) {
  console.error('[portable] 缺少 node_modules/undici —— 请先 npm install');
  process.exit(1);
}
if (withBrowser && !existsSync(join(repoRoot, 'plugins', 'browser-lite', 'node_modules', 'puppeteer-core'))) {
  console.error('[portable] browser-lite 依赖缺失：请在 plugins/browser-lite/ 执行 npm install，或改用 --no-browser');
  process.exit(1);
}

// ── 输出目录准备 ─────────────────────────────────────────────────────────
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const copied = [];
function cp(src, destRel) {
  const dest = join(outDir, destRel);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });
  copied.push(destRel);
}

// ── 1. dist 整体拷（含 grants.json + plugins 产物，保证版本一致）──────────
cp(join(repoRoot, 'dist'), 'dist');

// ── 2. server 宿主（8 个 .mjs，纯内置模块）───────────────────────────────
cp(join(repoRoot, 'server'), 'server');

// ── 3. plugins：registry + relay-hosts + 各插件 server 半边（依赖闭包）───
cp(join(repoRoot, 'plugins', 'server-registry.mjs'), 'plugins/server-registry.mjs');
cp(join(repoRoot, 'plugins', 'relay-hosts.json'), 'plugins/relay-hosts.json');

// 服务端会消费到的非 server.mjs 伴生文件（逐插件显式登记，新插件记得补）
const SERVER_EXTRA = {
  'browser-lite': ['engine.mjs'],
  'transcript-share': ['redact.mjs', 'render.mjs'],
  'codebuddy-engine': ['adapter.cjs'],
};
// server-registry.mjs 里的 id 清单（避免手工维护两份）
const registrySrc = readFileSync(join(repoRoot, 'plugins', 'server-registry.mjs'), 'utf8');
const ids = [...registrySrc.matchAll(/id:\s*'([^']+)'/g)].map((m) => m[1]);
for (const id of ids) {
  const dir = join(repoRoot, 'plugins', id);
  if (!existsSync(dir)) throw new Error(`server-registry 引用的插件目录不存在：${id}`);
  for (const f of ['server.mjs', ...(SERVER_EXTRA[id] ?? [])]) {
    if (existsSync(join(dir, f))) cp(join(dir, f), `plugins/${id}/${f}`);
  }
}

// ── 4. browser-lite 私有依赖（puppeteer-core，位置不可挪：相对 import.meta 解析）
if (withBrowser) {
  const nm = join(repoRoot, 'plugins', 'browser-lite', 'node_modules');
  cp(nm, 'plugins/browser-lite/node_modules');
  // 裁剪非运行时内容（保留 package.json / lib 等）
  const prune = ['.bin', 'docs', 'types', '*.md'];
  for (const name of readdirSync(join(outDir, 'plugins/browser-lite/node_modules'))) {
    for (const p of prune) {
      rmSync(join(outDir, 'plugins/browser-lite/node_modules', name, p), { recursive: true, force: true });
    }
  }
  // 根 undici（裁剪文档/类型）
  cp(join(repoRoot, 'node_modules', 'undici'), 'node_modules/undici');
  for (const p of ['docs', 'types', 'scripts']) {
    rmSync(join(outDir, 'node_modules/undici', p), { recursive: true, force: true });
  }
  cp(join(repoRoot, 'package.json'), 'package.json');
  cp(join(repoRoot, 'package-lock.json'), 'package-lock.json');
}

// ── 5. 启动脚本 + README ────────────────────────────────────────────────
const ver = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;
writeFileSync(join(outDir, 'start.cmd'), `@echo off
rem polaris-lite portable v${ver} —— 一键启动（需 Node.js 20+）
setlocal
cd /d "%~dp0"
if not defined PORT set PORT=9825
echo [polaris-lite] http://127.0.0.1:%PORT%  (data: %cd%\\.polaris-lite)
node server/prod-server.mjs
pause
`);
writeFileSync(join(outDir, 'start.sh'), `#!/usr/bin/env bash
# polaris-lite portable v${ver} —— 一键启动（需 Node.js 20+）
cd "$(dirname "$0")"
export PORT="\${PORT:-9825}"
echo "[polaris-lite] http://127.0.0.1:$PORT  (data: $PWD/.polaris-lite)"
node server/prod-server.mjs
`);
writeFileSync(join(outDir, 'README.md'), `# polaris-lite 便携包 v${ver}

免安装运行包：无需拉代码、无需 npm install、无需构建。只需要 **Node.js 20+**。

## 启动

- Windows：双击 \`start.cmd\`（或命令行 \`node server/prod-server.mjs\`）
- Linux/macOS：\`bash start.sh\`

启动后浏览器打开 http://127.0.0.1:9825 ，**首次登录的账号即注册为 owner**（无需单独注册步骤，密码 ≥4 位）。

## 常用环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| PORT | 9825 | 监听端口 |
| PLITE_DATA_DIR | .polaris-lite | 数据目录（账号/会话/供应商密钥） |
| PLITE_UPSTREAM_STRICT | 未设 | =1 恢复上游白名单防线 |
| PLITE_COOKIE_SECURE | 未设 | =1 走 HTTPS 反代时开启 |

## 说明

- 数据（含会话、供应商 API key）全部落在本目录 \`.polaris-lite/\`，随目录走、删目录即清空；
- 浏览器控制（browser-lite）复用本机已装的 Chrome/Edge，无需下载内核；
- 局域网访问：防火墙放行 PORT 后，其他设备访问 \`http://<本机IP>:PORT\`；
- 升级：重新生成便携包整体替换（不要只覆盖部分文件，grants/插件必须成套）。
`);

// ── 6. APK（存在则附带）─────────────────────────────────────────────────
const apk = join(repoRoot, `plite-${ver}-release.apk`);
if (existsSync(apk)) cp(apk, `plite-${ver}-release.apk`);

// ── 体积统计 ────────────────────────────────────────────────────────────
function dirSize(p) {
  let n = 0;
  for (const f of readdirSync(p, { withFileTypes: true })) {
    const fp = join(p, f.name);
    n += f.isDirectory() ? dirSize(fp) : statSync(fp).size;
  }
  return n;
}
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)}MB`;
console.log(`[portable] 输出目录 ${outDir}`);
console.log(`[portable] 共 ${copied.length} 项，总大小 ${mb(dirSize(outDir))}（browser-lite: ${withBrowser ? '含' : '不含'}）`);

// ── 可选 zip ────────────────────────────────────────────────────────────
if (wantZip) {
  const zipPath = `${outDir}.zip`;
  rmSync(zipPath, { force: true });
  try {
    execFileSync('powershell', ['-NoProfile', '-Command',
      `Compress-Archive -Path '${outDir}\\*' -DestinationPath '${zipPath}' -Force`], { stdio: 'inherit' });
    console.log(`[portable] zip: ${zipPath}（${mb(statSync(zipPath).size)}）`);
  } catch (e) {
    console.error(`[portable] zip 失败（可手动压缩目录）: ${e.message}`);
  }
}
console.log('[portable] 完成。新机器：装 Node 20+ → 解压 → 运行 start.cmd / start.sh');
