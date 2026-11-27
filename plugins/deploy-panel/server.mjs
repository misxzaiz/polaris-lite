/**
 * deploy-panel 插件的服务端半边（/api/deploy/*）：9826 分析实例的「一键部署」。
 *
 * 解决的问题：9826 跑在独立 clone，升级只能显式发布；而人工在 9826 对话里跑
 * deploy 会把自己杀掉（当前会话所在进程）。这里把发布动作交给一个 **detached
 * 后台进程**，HTTP 立刻 202 返回，页面轮询进度即可——对话不断，构建照常跑完。
 *
 * 为什么 detached 够用：与官方 scripts/soft-deploy-9826.mjs 同一机制（它在
 * 9826 对话进行中发布已有实战记录）。Windows 上 pm2 restart 只杀目标 PID，
 * detached 子进程的 ParentProcessId 指向已退出进程，不会被级联回收。
 *
 * 安全模型（对齐 git-core / agent-bash 的服务端半边）：
 * - 会话 cookie 硬门禁（未登录 401）；
 * - **PLITE_DEPLOY_PANEL=1 才挂载**：默认关闭，只有 9826 的 ecosystem 打开。
 *   9825 生产即使拿到了插件产物，也只会 404——「按钮存在但没接线」比
 *   「按钮能把生产重启」安全一个数量级；
 * - 只发布 origin/master，不接受任意 sha/分支/ref（目标写死）；
 * - 单飞：已有 job 在跑时 409，不做并发构建（两个 build 互相踩会把 clone 写坏）；
 * - 全量审计落 <dataDir>/deploy-audit.log。
 *
 * 端点：
 *   GET  /api/deploy/status  → 版本差距 / 进行中的 job / 未确认的完成通知
 *   POST /api/deploy/run     → 投递后台发布，202 { jobId }
 *   POST /api/deploy/ack     → 标记完成通知已弹过（防多标签重复弹）
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const FETCH_THROTTLE_MS = 10_000; // status 轮询不该每次都打 git fetch
const LOG_TAIL_LINES = 40;
const LOG_TAIL_BYTES = 8 * 1024;

function readJson(file) {
  try {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null; // 半写/损坏 → 当不存在，不 brick 端点
  }
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

/** 读日志文件尾部若干行（按字节 seek，不把大日志整个读进内存） */
function readTail(file, lines = LOG_TAIL_LINES) {
  let fd = -1;
  try {
    const size = statSync(file).size;
    const start = Math.max(0, size - LOG_TAIL_BYTES);
    const len = size - start;
    if (len <= 0) return '';
    const buf = Buffer.allocUnsafe(len);
    fd = openSync(file, 'r');
    readSync(fd, buf, 0, len, start);
    return buf.toString('utf8').split(/\r?\n/).filter(Boolean).slice(-lines).join('\n');
  } catch {
    return '';
  } finally {
    if (fd >= 0) { try { closeSync(fd); } catch { /* 已关 */ } }
  }
}

function pidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 只保留最近 N 份 job 日志：每次发布一份，不清理会无限长（每份几十~几百 KB） */
function pruneJobLogs(stateDir, keep = 20) {
  try {
    const files = readdirSync(stateDir)
      .filter((f) => f.startsWith('job-') && f.endsWith('.log'))
      .map((f) => ({ f, at: statSync(resolve(stateDir, f)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    for (const { f } of files.slice(keep)) {
      try { unlinkSync(resolve(stateDir, f)); } catch { /* 被占用就跳过 */ }
    }
  } catch { /* 目录还不存在：没东西可清 */ }
}

export function createServerPart(options = {}) {
  const getSession = options.getSession;
  // spawn 可注入：测试要在不真的构建一份代码的前提下验证「投递」语义
  const spawnFn = options.spawn ?? spawn;
  const dataDir = resolve(options.dataDir ?? '.polaris-lite');
  const stateDir = resolve(dataDir, 'deploy');
  const jobFile = resolve(stateDir, 'job.json');
  const lastRunFile = resolve(stateDir, 'last-run.json');
  const versionFile = resolve(dataDir, 'app-updater-version.json');
  const auditFile = resolve(dataDir, 'deploy-audit.log');

  // 仓库本体与 9826 clone：9826 的 dataDir 是 <repo>/.polaris-lite-pm2，
  // dirname 即仓库本体；clone 默认同级 <repo>-9826（与 deploy-9826.mjs 一致）。
  const srcDir = resolve(process.env.PLITE_SRC_DIR ?? dirname(dataDir));
  const cloneDir = resolve(
    process.env.PLITE_9826_DIR ?? resolve(dirname(srcDir), basename(srcDir) + '-9826'),
  );
  const workerPath = resolve(srcDir, 'scripts', 'deploy-worker.mjs');

  // 启用判定以「端口即环境」为准（AGENTS.md：9826 = 钉住分析实例）：
  // pm2 restart 不会重载 ecosystem 的 env，只靠 PLITE_DEPLOY_PANEL 会在
  // 「改了配置但进程 env 还是旧的」时静默失效——那正是最需要面板的时候。
  // 因此：9826 默认开；PLITE_DEPLOY_PANEL=1 可强制开（dev 5000 联调）；
  // PLITE_DEPLOY_PANEL=0 可强制关。9825/5000 默认全部 404。
  const port = String(process.env.PORT ?? '').trim();
  const enabled = typeof options.enabled === 'boolean'
    ? options.enabled
    : (process.env.PLITE_DEPLOY_PANEL === '1'
      || (port === '9826' && process.env.PLITE_DEPLOY_PANEL !== '0'));

  const audit = (entry) => {
    try {
      mkdirSync(dirname(auditFile), { recursive: true });
      appendFileSync(auditFile, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', 'utf8');
    } catch { /* 审计失败不影响主流程 */ }
  };

  const git = (args) => {
    const r = spawnSync('git', args, { cwd: cloneDir, encoding: 'utf8', timeout: 8000, windowsHide: true });
    if (r.error || r.status !== 0) return null;
    return String(r.stdout ?? '').trim();
  };

  // status 的 fetch 节流（clone 的 origin 是本机仓库路径，但仍不必每次轮询都 fetch）
  let lastFetchAt = 0;
  function fetchClone() {
    if (Date.now() - lastFetchAt < FETCH_THROTTLE_MS) return;
    lastFetchAt = Date.now();
    git(['fetch', 'origin', '--quiet']);
  }

  /** 读当前 job，并判定「是否真的有进程在跑」（pid 死掉的残留 = 异常中断） */
  function readJob() {
    const job = readJson(jobFile);
    if (!job) return null;
    if ((job.status === 'running' || job.status === 'queued') && !pidAlive(Number(job.pid))) {
      // pm2 托管时 pid 要等 worker 起来才写（几十毫秒~1s）。刚投递的空窗期不能
      // 判成 stale，否则面板会立刻显示「已中断」并允许重复投递。
      const age = Date.now() - Date.parse(job.startedAt ?? 0);
      if (job.status === 'queued' && !job.pid && age >= 0 && age < 60_000) return job;
      return {
        ...job,
        status: 'stale',
        phase: '已中断',
        error: job.error ?? '后台进程已退出（可能被系统回收），可重新部署',
      };
    }
    return job;
  }

  function currentVersion() {
    const v = readJson(versionFile);
    if (!v || typeof v.sha !== 'string') return { sha: null, subject: null, time: null };
    return { sha: v.sha, subject: v.subject ?? null, time: v.time ?? null };
  }

  function targetVersion() {
    const sha = git(['rev-parse', 'origin/master']);
    if (!sha) return { sha: null, subject: null };
    const subject = git(['log', '-1', '--format=%s', sha]);
    return { sha, subject: subject || null };
  }

  function behindCount() {
    const n = git(['rev-list', '--count', 'HEAD..origin/master']);
    return n && /^\d+$/.test(n) ? Number(n) : null;
  }

  function dirtySrc() {
    const r = spawnSync('git', ['status', '--porcelain'], {
      cwd: srcDir, encoding: 'utf8', timeout: 8000, windowsHide: true,
    });
    if (r.error || r.status !== 0) return null;
    const lines = String(r.stdout ?? '').split('\n').filter(Boolean);
    return { count: lines.length, sample: lines.slice(0, 5) };
  }

  // ── 拉起 worker：pm2 托管优先，detached 仅作无 pm2 时的降级 ─────────────
  const PM2_NAME = 'plite-deploy-9826';
  const pm2Bin = resolve(srcDir, 'node_modules', '.bin', process.platform === 'win32' ? 'pm2.cmd' : 'pm2');
  const spawnSyncFn = options.spawnSync ?? spawnSync;

  function launchWorker({ jobId, logFile }) {
    if (existsSync(pm2Bin) && options.usePm2 !== false) {
      try {
        // 上一个 job 的 app 可能还以 stopped 状态留着：先删掉，避免 --name 冲突
        spawnSyncFn(pm2Bin, ['delete', PM2_NAME], {
          cwd: srcDir, shell: true, windowsHide: true, encoding: 'utf8', timeout: 15_000,
        });
        const r = spawnSyncFn(
          pm2Bin,
          ['start', workerPath, '--name', PM2_NAME, '--no-autorestart', '--', dataDir, jobId, srcDir],
          { cwd: srcDir, shell: true, windowsHide: true, encoding: 'utf8', timeout: 30_000 },
        );
        if (!r?.error && r?.status === 0) return { ok: true, mode: 'pm2' };
        const detail = String(r?.stderr || r?.stdout || r?.error?.message || '').trim().slice(0, 300);
        return { ok: false, error: `pm2 拉起失败（exit ${r?.status ?? '?'}）：${detail || '无输出'}` };
      } catch (e) {
        return { ok: false, error: `pm2 拉起失败：${String(e?.message ?? e)}` };
      }
    }

    // 降级：没有 pm2 的机器上仍可用；注意它的父进程是本实例，pm2 restart 时可能被
    // taskkill /T 连带杀掉（这正是默认走 pm2 的原因，日志里会留痕）
    let child;
    const out = openSync(logFile, 'a');
    try {
      child = spawnFn(process.execPath, [workerPath, dataDir, jobId, srcDir], {
        cwd: srcDir,
        detached: true,
        stdio: ['ignore', out, out],
        windowsHide: true,
        env: {
          ...process.env,
          PLITE_DEPLOY_JOB: jobId,
          PLITE_DEPLOY_DATA_DIR: dataDir,
          PLITE_DEPLOY_SRC_DIR: srcDir,
          PLITE_SRC_DIR: srcDir,
        },
      });
    } catch (e) {
      return { ok: false, error: `拉起部署进程失败：${String(e?.message ?? e)}` };
    } finally {
      closeSync(out); // 子进程已 dup 一份句柄，父进程不再持有
    }
    child.unref();
    return { ok: true, mode: 'detached', pid: child.pid };
  }

  return async function deployApi(req, res, next) {
    const [pathname] = (req.url ?? '').split('?');
    if (!pathname.startsWith('/api/deploy/')) return next?.();

    // 未启用：让前端拿到 404 → 面板显示「本实例不支持部署」。
    // 这是 9825 生产的保险丝：即便插件产物被发布过去，端点也不会存在。
    if (!enabled) {
      res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ error: 'deploy panel disabled on this instance', code: 'DEPLOY_DISABLED' }));
    }

    const session = getSession?.(req);
    if (!session) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'unauthorized', code: 'SESSION_REQUIRED' }));
    }

    const sendJson = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(obj));
    };
    const readBody = () => new Promise((r) => {
      let b = '';
      req.on('data', (c) => { b += c; if (b.length > 16 * 1024) req.destroy(); });
      req.on('end', () => r(b));
      req.on('error', () => r(''));
    });

    try {
      if (pathname === '/api/deploy/status' && req.method === 'GET') {
        fetchClone();
        const job = readJob();
        const last = readJson(lastRunFile);
        return sendJson(200, {
          enabled: true,
          instance: { port: process.env.PORT ?? null, dataDir },
          srcDir,
          cloneDir,
          current: currentVersion(),
          target: targetVersion(),
          behind: behindCount(),
          dirty: dirtySrc(),
          job: job
            ? {
                id: job.id,
                status: job.status,
                phase: job.phase ?? null,
                startedAt: job.startedAt ?? null,
                endedAt: job.endedAt ?? null,
                targetSha: job.targetSha ?? null,
                error: job.error ?? null,
                logTail: readTail(resolve(stateDir, `job-${job.id}.log`)),
              }
            : null,
          // 完成通知：只有「成功且未确认」才让前端补弹（失败时页面还在，直接看 job）
          notice: last && last.ok && last.notified === false
            ? { id: last.id, sha: last.sha, endedAt: last.endedAt, phase: last.phase ?? null }
            : null,
          lastRun: last
            ? {
                id: last.id,
                ok: last.ok,
                sha: last.sha,
                startedAt: last.startedAt ?? null,
                endedAt: last.endedAt ?? null,
                error: last.error ?? null,
                notified: last.notified !== false,
              }
            : null,
        });
      }

      if (pathname === '/api/deploy/run' && req.method === 'POST') {
        await readBody();
        const running = readJob();
        if (running && (running.status === 'running' || running.status === 'queued')) {
          return sendJson(409, {
            error: '已有一个部署在跑', code: 'DEPLOY_BUSY',
            jobId: running.id, phase: running.phase ?? null,
          });
        }

        const target = targetVersion();
        if (!target.sha) {
          return sendJson(409, {
            error: '读不到 origin/master（clone 路径或 git 状态异常）',
            code: 'DEPLOY_NO_TARGET', cloneDir,
          });
        }
        if (!existsSync(workerPath)) {
          return sendJson(500, { error: '缺少 scripts/deploy-worker.mjs', code: 'DEPLOY_NO_WORKER', path: workerPath });
        }

        const jobId = randomUUID().slice(0, 8);
        const logFile = resolve(stateDir, `job-${jobId}.log`);
        const startedAt = new Date().toISOString();
        mkdirSync(stateDir, { recursive: true });
        pruneJobLogs(stateDir);
        writeFileSync(logFile, `[deploy-panel] ${startedAt} 投递部署 ${jobId} → ${target.sha.slice(0, 7)}\n`, 'utf8');

        // job.json 必须**先于拉起 worker** 落盘：worker 第一件事就是读它拿 targetSha，
        // 反过来（先拉起再写）worker 会读到空值，且两边的 running/queued 会互相覆盖。
        writeJson(jobFile, {
          id: jobId,
          status: 'queued',
          phase: '排队',
          pid: null,
          startedAt,
          targetSha: target.sha,
        });

        // 202 必须在拉起 worker **之前**回：pm2 delete/start 是同步阻塞（最长
        // 45s），压住事件循环会让前端的 2.5s status 轮询一起卡住——用户点了
        // 确认却看到按钮退回「一键部署」。提前回 202，前端立刻切「部署中」。
        sendJson(202, { jobId, targetSha: target.sha });

        const launched = launchWorker({ jobId, logFile });
        if (!launched.ok) {
          // 拉起失败在响应之后收尾：前端拿不到这个 500，唯一的信息通道是 status，
          // 所以 job.json 和 last-run.json 都要写——前端 failedLast 读 lastRun，
          // 不写的话按钮会静默退回「一键部署」且不显示任何错误。
          writeJson(jobFile, {
            id: jobId,
            status: 'done',
            phase: '失败',
            startedAt,
            endedAt: new Date().toISOString(),
            targetSha: target.sha,
            error: launched.error,
          });
          writeJson(lastRunFile, {
            id: jobId,
            ok: false,
            sha: null,
            startedAt,
            endedAt: new Date().toISOString(),
            error: launched.error,
            notified: true, // 拉起失败没有「重启后补通知」一说，页面还在直接看
          });
          audit({
            event: 'spawn-failed', jobId, targetSha: target.sha,
            error: launched.error, by: session?.user ?? null,
          });
          return;
        }

        // 只补 launcher/pid 这类元数据，绝不覆盖 worker 可能已经写好的 status/phase
        // （两处写之间没有 await，单线程下不会与 status 轮询交错）。
        writeJson(jobFile, {
          ...(readJson(jobFile) ?? {}),
          launcher: launched.mode,
          ...(launched.pid ? { pid: launched.pid } : {}),
        });
        audit({
          event: 'run', jobId, targetSha: target.sha, launcher: launched.mode,
          pid: launched.pid ?? null, by: session?.user ?? null,
        });
        return; // 202 已回，但必须 return：不然后面还会撞 404 fallback 覆写响应
      }

      if (pathname === '/api/deploy/ack' && req.method === 'POST') {
        const body = JSON.parse((await readBody()) || '{}');
        const last = readJson(lastRunFile);
        if (!last) return sendJson(200, { ok: true, skipped: true });
        if (body.id && String(body.id) !== String(last.id)) {
          return sendJson(200, { ok: true, skipped: true }); // 旧通知的迟到 ack
        }
        writeJson(lastRunFile, { ...last, notified: true });
        return sendJson(200, { ok: true });
      }

      return sendJson(404, { error: 'not found' });
    } catch (e) {
      return sendJson(400, { error: String(e?.message ?? e) });
    }
  };
}
