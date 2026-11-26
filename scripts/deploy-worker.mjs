/**
 * deploy-worker.mjs —— deploy-panel 投递的一次性后台发布进程。
 *
 * 由 plugins/deploy-panel/server.mjs 以 detached 方式拉起（父进程是 9826，
 * detached 后不再受其生死影响）。职责：
 * 1. 把 job.json 标成 running（带自己的 pid，供 status 判活）；
 * 2. spawn scripts/deploy-9826.mjs（目标写死 origin/master），逐行解析输出推进 phase；
 * 3. 完成后写 last-run.json（供 9826 新进程起来后补弹通知）+ job.json 收尾。
 *
 * 为什么不让面板直接 spawn deploy-9826：面板请求的生命周期属于 9826，进程重启会
 * 断开 HTTP；而 worker 把「构建 → 重启 9826 → 写结果」跑完，页面重连后读文件即可。
 *
 * 参数全部走环境变量（避免 Windows argv 引号问题）：
 *   PLITE_DEPLOY_JOB        job id
 *   PLITE_DEPLOY_DATA_DIR   数据目录（写 job/last-run）
 *   PLITE_DEPLOY_SRC_DIR    仓库本体（跑 deploy-9826.mjs）
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { phaseOf } from './deploy-phases.mjs';

const jobId = String(process.env.PLITE_DEPLOY_JOB ?? '').trim();
const dataDir = resolve(process.env.PLITE_DEPLOY_DATA_DIR ?? '.');
const srcDir = resolve(process.env.PLITE_DEPLOY_SRC_DIR ?? '.');
const stateDir = resolve(dataDir, 'deploy');
const jobFile = resolve(stateDir, 'job.json');
const lastRunFile = resolve(stateDir, 'last-run.json');
const logFile = resolve(stateDir, `job-${jobId}.log`);

const stamp = () => new Date().toISOString();
const log = (line) => {
  try {
    appendFileSync(logFile, `${line}\n`, 'utf8');
  } catch { /* 日志写不进去也不该中断发布 */ }
};

function readJson(file) {
  try {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

/** 读改写 job.json：保留 server 写入的 id/targetSha/startedAt */
function patchJob(patch) {
  const cur = readJson(jobFile) ?? { id: jobId };
  if (cur.id && jobId && cur.id !== jobId) return; // 已被新 job 顶替，不再回写
  writeJson(jobFile, { ...cur, ...patch });
}

if (!jobId) {
  console.error('[deploy-worker] 缺少 PLITE_DEPLOY_JOB');
  process.exit(2);
}
mkdirSync(stateDir, { recursive: true });

const job = readJson(jobFile);
if (job && job.id !== jobId) {
  log(`[deploy-worker] job.json 已被 ${job.id} 顶替，本次 ${jobId} 放弃`);
  process.exit(0);
}

const startedAt = job?.startedAt ?? stamp();
const targetSha = job?.targetSha ?? null;
patchJob({ status: 'running', phase: '准备', pid: process.pid, startedAt });
log(`[deploy-worker] ${stamp()} 开始（pid ${process.pid}，目标 ${targetSha ? targetSha.slice(0, 7) : 'origin/master'}）`);

const childEnv = { ...process.env, PLITE_SRC_DIR: srcDir, PLITE_9826_DATA_DIR: dataDir };
// 空串会被 deploy-9826 里的 resolve('') 解析成 cwd —— 只在本实例确有覆盖时才传
if (process.env.PLITE_9826_DIR) childEnv.PLITE_9826_DIR = process.env.PLITE_9826_DIR;

const child = spawn(process.execPath, [resolve(srcDir, 'scripts', 'deploy-9826.mjs')], {
  cwd: srcDir,
  env: childEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

let buf = '';
let phase = '准备';
function consume(chunk) {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    log(line);
    const next = phaseOf(line, phase);
    if (next) {
      phase = next;
      patchJob({ phase });
    }
  }
}
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', consume);
child.stderr.on('data', consume);

let finished = false;
function finish(code, signal) {
  if (finished) return;
  finished = true;
  if (buf.trim()) { log(buf); buf = ''; }
  const ok = code === 0;
  const endedAt = stamp();
  const error = ok ? null : `deploy-9826 退出码 ${code}${signal ? ` (${signal})` : ''}`;
  log(`[deploy-worker] ${endedAt} ${ok ? '成功' : '失败：' + error}`);
  patchJob({ status: 'done', phase: ok ? '完成' : '失败', endedAt, error });
  writeJson(lastRunFile, {
    id: jobId,
    ok,
    sha: targetSha,
    startedAt,
    endedAt,
    phase: ok ? '完成' : '失败',
    error,
    notified: false, // 由前端 fetch status 后经 /api/deploy/ack 置 true
  });
  process.exit(ok ? 0 : 1);
}

child.on('error', (e) => {
  log(`[deploy-worker] 启动 deploy-9826 失败：${e.message}`);
  finish(1, null);
});
child.on('close', finish);
