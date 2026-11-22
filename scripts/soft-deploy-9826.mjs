/**
 * soft-deploy-9826.mjs —— 「软发布」：人正挂在 9826 对话里时也能安全地按最新代码重启。
 *
 * 原理：deploy-9826.mjs 的全部动作（fetch/checkout 最新 → 按需 npm ci → build →
 * pm2 restart + save → 版本戳）放进一个 detached + unref 的后台进程执行：
 * - bash 工具立即返回，当前这轮 AI 回复可以正常说完；
 * - 构建通常耗时数十秒，restart 发生在最后一步，届时对话早已落库；
 * - pm2 daemon 是独立进程，旧 9826 被杀后 restart_delay 3s 内拉起新实例；
 * - 浏览器自动重连（stream-retry），下一条消息即跑在新代码上，历史完整。
 *
 * 用法（仓库本体执行）：
 *   npm run soft:9826            # 后台发布 origin/master 最新 commit
 *   npm run soft:9826 -- <sha>   # 后台发布指定版本
 *   node scripts/soft-deploy-9826.mjs log   # 查看最近一次后台发布日志
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LOG_DIR = join(ROOT, 'logs');
const LOG = join(LOG_DIR, 'soft-deploy-9826.log');
const PID = join(LOG_DIR, 'soft-deploy-9826.pid');
const stamp = () => new Date().toLocaleString('sv-SE');

// log 子命令：打印最近一次后台发布的日志尾部
if (process.argv[2] === 'log') {
  if (!existsSync(LOG)) {
    console.log('[soft-deploy-9826] 还没有任何后台发布记录');
    process.exit(0);
  }
  const text = readFileSync(LOG, 'utf8');
  const lines = text.split(/\r?\n/).filter(Boolean);
  console.log(lines.slice(-40).join('\n'));
  process.exit(0);
}

mkdirSync(LOG_DIR, { recursive: true });

// 防重入：上一个后台发布还活着就拒绝（否则两个 build 互相踩，restart 两次）
if (existsSync(PID)) {
  const pid = Number(readFileSync(PID, 'utf8').trim());
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch { /* 已退出 */ }
  if (alive && pid !== process.pid) {
    console.error(`[soft-deploy-9826] 已有一个后台发布在跑（pid ${pid}），等它结束再试；看进度：npm run soft:9826 -- log`);
    process.exit(1);
  }
  unlinkSync(PID);
}

const args = process.argv.slice(2);
const target = args[0] ?? 'origin/master';
appendFileSync(LOG, `\n===== [soft-deploy-9826] ${stamp()} 触发后台发布（目标 ${target}） =====\n`);

const out = openSync(LOG, 'a');
const child = spawn(process.execPath, [join(ROOT, 'scripts', 'deploy-9826.mjs'), ...args], {
  cwd: ROOT,
  detached: true,
  stdio: ['ignore', out, out],
  windowsHide: true,
});
child.unref();
writeFileSync(PID, String(child.pid));

console.log(`[soft-deploy-9826] 已在后台触发（pid ${child.pid}）：拉 ${target} → 构建 → 重启 9826`);
console.log('[soft-deploy-9826] 当前对话可继续；构建完成后 9826 重启，浏览器自动重连。');
console.log('[soft-deploy-9826] 看进度：npm run soft:9826 -- log');
