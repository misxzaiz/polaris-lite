#!/usr/bin/env node
/**
 * 开发环境启动脚本（dev）——与生产（9825）完全隔离。
 *
 * 用法：npm run dev:standalone   （或 node scripts/dev-server.mjs [--build]）
 *
 * 隔离三要素：
 * 1. 端口 5000（生产是 9825）；
 * 2. 独立数据目录 .polaris-lite-dev/（账号/供应商/账本等全部与生产 .polaris-lite/ 互不可见）；
 * 3. 预置开发账号 root / 1234（生产账号 boss 不受影响）。
 *
 * 说明：
 * - 生产请用 `npm run build && npm start`（9825，数据目录 .polaris-lite/）；
 * - AI/agent 在开发调试时必须用本脚本（dev:standalone），不得动 9825 的生产数据。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes, scryptSync } from 'node:crypto';

const DEV_PORT = 5000;
const DEV_DATA_DIR = '.polaris-lite-dev';
const DEV_OWNER = { username: 'root', password: '1234' };

const repoRoot = resolve(import.meta.dirname, '..');
const dataDir = resolve(repoRoot, DEV_DATA_DIR);
mkdirSync(dataDir, { recursive: true });

// ── 预置开发账号（仅当 owner 不存在时；不覆盖已有开发账号）──────────────
const ownerFile = resolve(dataDir, 'auth-owner.json');
if (!existsSync(ownerFile)) {
  const salt = randomBytes(16).toString('hex');
  const passwordHash = scryptSync(DEV_OWNER.password, salt, 64).toString('hex');
  writeFileSync(ownerFile, JSON.stringify({
    username: DEV_OWNER.username,
    algo: 'scrypt',
    salt,
    passwordHash,
    registeredAt: Date.now(),
    dev: true,
  }));
  console.log(`[dev] 已预置开发账号 ${DEV_OWNER.username} / ${DEV_OWNER.password}（仅开发环境）`);
}

// ── 构建（dist 缺失或 --build 时）──────────────────────────────────────
const distDir = resolve(repoRoot, 'dist');
const forceBuild = process.argv.includes('--build') || !existsSync(resolve(distDir, 'index.html'));
if (forceBuild) {
  console.log('[dev] 构建生产 bundle（vite build）…');
  const r = spawnSync('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'inherit', shell: true });
  if (r.status !== 0) {
    console.error('[dev] 构建失败');
    process.exit(r.status ?? 1);
  }
}

// ── 启动生产服务器形态（单进程，同 prod 但端口/数据目录隔离）────────────
console.log(`[dev] 开发环境启动：http://127.0.0.1:${DEV_PORT}（数据目录 ${DEV_DATA_DIR}/，与生产 9825 隔离）`);
const r = spawnSync('node', ['server/prod-server.mjs'], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    PORT: String(DEV_PORT),
    PLITE_DATA_DIR: DEV_DATA_DIR,
  },
});
process.exit(r.status ?? 0);
