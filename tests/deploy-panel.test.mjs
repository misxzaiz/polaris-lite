/**
 * deploy-panel 服务端测试：9826「一键部署」的端点契约。
 *
 * 为什么值得单独测：这个插件会在**生产实例上重启自己**，出错代价是「页面挂了、发布
 * 也没起来」。所以每条边界都必须钉住：
 * - 门禁：未启用 404 / 未登录 401（9825 生产拿到产物也打不动）；
 * - 单飞：已有活进程在跑 → 409；进程已死的残留 → 判 stale 且允许重新投递；
 * - 投递语义：**job.json 必须先于 spawn 落盘**（否则 worker 读不到 targetSha）；
 * - 通知：成功且未确认 → status 带 notice，ack 后消失（多标签页不重复弹）；
 * - 阶段映射：deploy-9826 的原始输出 → 用户可读阶段名。
 *
 * 直接测中间件（不经 HTTP / 不建宿主）：这层是纯 req/res 函数，注入 getSession 与
 * spawn 就能覆盖全部分支，跑起来是毫秒级；真跑一次 build 的端到端验证留给发版冒烟。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename, dirname } from 'node:path';
import { createServerPart } from '../plugins/deploy-panel/server.mjs';
import { phaseOf, DEPLOY_PHASES } from '../scripts/deploy-phases.mjs';

// 测试要自己决定「仓库本体 / clone 在哪」，不能被外部 shell 的变量带偏
delete process.env.PLITE_SRC_DIR;
delete process.env.PLITE_9826_DIR;

// ── 测试替身 ────────────────────────────────────────────────────────

function makeRes() {
  const state = { status: 0, headers: {}, body: '', ended: false };
  return {
    state,
    writeHead(code, headers) { state.status = code; state.headers = headers ?? {}; },
    end(chunk) { if (chunk !== undefined) state.body += String(chunk); state.ended = true; },
    json() { return state.body ? JSON.parse(state.body) : null; },
  };
}

function makeReq(url, { method = 'GET', body } = {}) {
  const req = new EventEmitter();
  req.url = url;
  req.method = method;
  // 监听器是 middleware 内部才挂的，所以请求体必须异步投递（setTimeout 0 足够晚）
  setTimeout(() => {
    if (body !== undefined) req.emit('data', Buffer.from(body));
    req.emit('end');
  }, 0);
  return req;
}

async function call(mw, url, opts) {
  const res = makeRes();
  await mw(makeReq(url, opts), res, () => {});
  return res;
}

/** 临时仓库布局：root/polaris-lite/.data（数据目录）+ root/polaris-lite-9826（clone） */
function layout() {
  const root = mkdtempSync(join(tmpdir(), 'plite-deploy-'));
  const srcDir = join(root, 'polaris-lite');
  const dataDir = join(srcDir, '.data');
  const cloneDir = join(root, 'polaris-lite-9826');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(cloneDir, { recursive: true });
  return { root, srcDir, dataDir, cloneDir };
}

const git = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8' });
const rev = (cwd, r = 'HEAD') => git(['rev-parse', r], cwd).stdout.trim();

/** 造一个最小 git 仓库：HEAD 与 origin/master 都指向第一个 commit */
function initClone(cloneDir) {
  git(['init', '-q'], cloneDir);
  git(['config', 'user.email', 't@t'], cloneDir);
  git(['config', 'user.name', 't'], cloneDir);
  git(['commit', '-q', '--allow-empty', '-m', 'first'], cloneDir);
  const first = rev(cloneDir);
  git(['update-ref', 'refs/remotes/origin/master', first], cloneDir);
  return { first, branch: git(['symbolic-ref', '--short', 'HEAD'], cloneDir).stdout.trim() };
}

/** 让 origin/master 领先 clone HEAD 一个 commit（模拟「仓库有新提交」） */
function advanceOrigin(cloneDir, branch) {
  git(['checkout', '-q', '-b', 'upstream'], cloneDir);
  git(['commit', '-q', '--allow-empty', '-m', 'second'], cloneDir);
  const ahead = rev(cloneDir);
  git(['checkout', '-q', branch], cloneDir);
  git(['update-ref', 'refs/remotes/origin/master', ahead], cloneDir);
  return ahead;
}

/** worker 脚本占位：只做存在性检查，永远不会被执行 */
function stubWorker(srcDir) {
  mkdirSync(join(srcDir, 'scripts'), { recursive: true });
  writeFileSync(join(srcDir, 'scripts', 'deploy-worker.mjs'), '// stub\n', 'utf8');
}

const cloneDirOf = (srcDir) => resolve(dirname(srcDir), basename(srcDir) + '-9826');

// ── 门禁 ────────────────────────────────────────────────────────────

test('未启用：未登录也先返回 404，9825 生产拿到产物也打不动', async () => {
  const { dataDir } = layout();
  const mw = createServerPart({ dataDir, getSession: () => ({ user: 'root' }), enabled: false });
  const res = await call(mw, '/api/deploy/status');
  assert.equal(res.state.status, 404);
  assert.equal(res.json().code, 'DEPLOY_DISABLED');

  const run = await call(mw, '/api/deploy/run', { method: 'POST', body: '{}' });
  assert.equal(run.state.status, 404);
});

test('未登录：401，三个端点一致，不因 method 差异漏门禁', async () => {
  const { dataDir } = layout();
  const mw = createServerPart({ dataDir, getSession: () => null, enabled: true });
  for (const [url, method] of [['/api/deploy/status', 'GET'], ['/api/deploy/run', 'POST'], ['/api/deploy/ack', 'POST']]) {
    const res = await call(mw, url, { method, body: method === 'POST' ? '{}' : undefined });
    assert.equal(res.state.status, 401, `${method} ${url}`);
    assert.equal(res.json().code, 'SESSION_REQUIRED');
  }
});

test('非部署路径直接 next()，不吞别的端点', async () => {
  const { dataDir } = layout();
  const mw = createServerPart({ dataDir, getSession: () => null, enabled: true });
  let nexted = false;
  await mw(makeReq('/api/chat/sessions'), makeRes(), () => { nexted = true; });
  assert.equal(nexted, true);
});

test('端口即环境：PORT=9826 默认开启；PLITE_DEPLOY_PANEL=0 可强制关闭', async () => {
  const { dataDir } = layout();
  const savedPort = process.env.PORT;
  const savedFlag = process.env.PLITE_DEPLOY_PANEL;
  const probe = async () => (await call(createServerPart({ dataDir, getSession: () => null }), '/api/deploy/status')).state.status;
  try {
    process.env.PORT = '9826';
    delete process.env.PLITE_DEPLOY_PANEL;
    assert.equal(await probe(), 401, '9826 默认启用 → 走到了登录门禁');

    process.env.PLITE_DEPLOY_PANEL = '0';
    assert.equal(await probe(), 404, '显式关掉 → 404');

    process.env.PORT = '5000';
    delete process.env.PLITE_DEPLOY_PANEL;
    assert.equal(await probe(), 404, '5000 开发实例默认没有部署端点');

    process.env.PLITE_DEPLOY_PANEL = '1';
    assert.equal(await probe(), 401, 'PLITE_DEPLOY_PANEL=1 可在 dev 联调时强制打开');
  } finally {
    if (savedPort === undefined) delete process.env.PORT; else process.env.PORT = savedPort;
    if (savedFlag === undefined) delete process.env.PLITE_DEPLOY_PANEL; else process.env.PLITE_DEPLOY_PANEL = savedFlag;
  }
});

// ── status ──────────────────────────────────────────────────────────

test('status：没有 clone 时也必须 200（面板要能说「读不到目标版本」而不是白屏）', async () => {
  const { srcDir, dataDir } = layout();
  const mw = createServerPart({ dataDir, getSession: () => ({ user: 'root' }), enabled: true });
  const res = await call(mw, '/api/deploy/status');
  assert.equal(res.state.status, 200);
  const body = res.json();
  assert.equal(body.enabled, true);
  assert.equal(body.cloneDir, cloneDirOf(srcDir));
  assert.equal(body.current.sha, null);
  assert.equal(body.target.sha, null);
  assert.equal(body.behind, null);
  assert.equal(body.job, null);
  assert.equal(body.notice, null);
});

test('status：当前版本读版本戳，目标版本/落后数读 clone 的 origin/master', async () => {
  const { srcDir, dataDir } = layout();
  const cloneDir = cloneDirOf(srcDir);
  mkdirSync(cloneDir, { recursive: true });
  const { branch } = initClone(cloneDir);
  const ahead = advanceOrigin(cloneDir, branch);
  writeFileSync(join(dataDir, 'app-updater-version.json'), JSON.stringify({
    sha: 'a'.repeat(40), subject: 'old', time: '2026-01-01T00:00:00.000Z',
  }), 'utf8');

  const mw = createServerPart({ dataDir, getSession: () => ({ user: 'root' }), enabled: true });
  const body = (await call(mw, '/api/deploy/status')).json();
  assert.equal(body.current.sha, 'a'.repeat(40));
  assert.equal(body.target.sha, ahead);
  assert.equal(body.behind, 1);
});

test('status：进程已死的 running job 判为 stale（异常中断不能把面板永久锁死）', async () => {
  const { dataDir } = layout();
  mkdirSync(join(dataDir, 'deploy'), { recursive: true });
  writeFileSync(join(dataDir, 'deploy', 'job.json'), JSON.stringify({
    id: 'dead0001', status: 'running', phase: '安装依赖', pid: 999_999,
  }), 'utf8');
  const mw = createServerPart({ dataDir, getSession: () => ({ user: 'root' }), enabled: true });
  const { job } = (await call(mw, '/api/deploy/status')).json();
  assert.equal(job.status, 'stale');
  assert.ok(job.error);
});

test('status：日志只读尾部，不把整份构建日志回传给前端', async () => {
  const { dataDir } = layout();
  const stateDir = join(dataDir, 'deploy');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'job.json'), JSON.stringify({ id: 'big00001', status: 'running', phase: '构建前端', pid: process.pid }), 'utf8');
  writeFileSync(join(stateDir, 'job-big00001.log'), ('x'.repeat(200) + '\n').repeat(200), 'utf8');
  const mw = createServerPart({ dataDir, getSession: () => ({ user: 'root' }), enabled: true });
  const { job } = (await call(mw, '/api/deploy/status')).json();
  assert.ok(job.logTail.length <= 40 * 201, '尾部只留 40 行');
  assert.ok(job.logTail.split('\n').length <= 40);
});

// ── run ─────────────────────────────────────────────────────────────

test('run：已在跑 → 409 不并发构建', async () => {
  const { dataDir } = layout();
  mkdirSync(join(dataDir, 'deploy'), { recursive: true });
  writeFileSync(join(dataDir, 'deploy', 'job.json'), JSON.stringify({
    id: 'live0001', status: 'running', phase: '构建前端', pid: process.pid,
  }), 'utf8');
  const mw = createServerPart({
    dataDir, getSession: () => ({ user: 'root' }), enabled: true,
    spawn: () => { throw new Error('不该被调用'); },
  });
  const busy = await call(mw, '/api/deploy/run', { method: 'POST', body: '{}' });
  assert.equal(busy.state.status, 409);
  assert.equal(busy.json().code, 'DEPLOY_BUSY');
  assert.equal(busy.json().jobId, 'live0001');
});

test('run：job.json 先于 spawn 落盘，pid 在 spawn 后补写（worker 必须读得到 targetSha）', async () => {
  const { srcDir, dataDir } = layout();
  stubWorker(srcDir);
  const cloneDir = cloneDirOf(srcDir);
  initClone(cloneDir);
  const target = rev(cloneDir);

  let seenAtSpawn = null;
  let sawDetached = null;
  const fakeSpawn = (_cmd, _args, opts) => {
    // spawn 的那一刻 job.json 必须已经存在且带 targetSha
    seenAtSpawn = JSON.parse(readFileSync(join(dataDir, 'deploy', 'job.json'), 'utf8'));
    sawDetached = opts?.detached;
    assert.equal(opts?.stdio?.[0], 'ignore');
    return { pid: 4242, unref() { /* no-op */ } };
  };

  const mw = createServerPart({ dataDir, getSession: () => ({ user: 'root', id: 'root' }), enabled: true, spawn: fakeSpawn });
  const res = await call(mw, '/api/deploy/run', { method: 'POST', body: '{}' });
  assert.equal(res.state.status, 202);
  const { jobId, targetSha } = res.json();
  assert.equal(targetSha, target);
  assert.ok(jobId);

  assert.equal(seenAtSpawn?.id, jobId);
  assert.equal(seenAtSpawn?.targetSha, target);
  assert.equal(seenAtSpawn?.status, 'queued');
  assert.ok(seenAtSpawn?.startedAt);
  assert.equal(sawDetached, true);

  const job = JSON.parse(readFileSync(join(dataDir, 'deploy', 'job.json'), 'utf8'));
  assert.equal(job.pid, 4242, 'spawn 之后必须补写 pid，否则会被判 stale');

  const audit = JSON.parse(readFileSync(join(dataDir, 'deploy-audit.log'), 'utf8').trim().split('\n').pop());
  assert.equal(audit.event, 'run');
  assert.equal(audit.jobId, jobId);
  assert.equal(audit.targetSha, target);
});

test('run：缺 worker 脚本 → 500；读不到 origin/master → 409，都带可定位的 code', async () => {
  const a = layout();
  mkdirSync(cloneDirOf(a.srcDir), { recursive: true });
  initClone(cloneDirOf(a.srcDir));
  const noWorker = createServerPart({
    dataDir: a.dataDir, getSession: () => ({ user: 'root' }), enabled: true,
    spawn: () => { throw new Error('不该被调用'); },
  });
  const r1 = await call(noWorker, '/api/deploy/run', { method: 'POST', body: '{}' });
  assert.equal(r1.state.status, 500);
  assert.equal(r1.json().code, 'DEPLOY_NO_WORKER');

  const b = layout(); // 另一套布局：worker 有、clone 没有
  stubWorker(b.srcDir);
  const noTarget = createServerPart({
    dataDir: b.dataDir, getSession: () => ({ user: 'root' }), enabled: true,
    spawn: () => { throw new Error('不该被调用'); },
  });
  const r2 = await call(noTarget, '/api/deploy/run', { method: 'POST', body: '{}' });
  assert.equal(r2.state.status, 409);
  assert.equal(r2.json().code, 'DEPLOY_NO_TARGET');
});

test('run：spawn 抛错时给出 500 并把 job 收尾成失败（不留 running 幽灵）', async () => {
  const { srcDir, dataDir } = layout();
  stubWorker(srcDir);
  initClone(cloneDirOf(srcDir));
  const mw = createServerPart({
    dataDir, getSession: () => ({ user: 'root' }), enabled: true,
    spawn: () => { throw new Error('EACCES'); },
  });
  const res = await call(mw, '/api/deploy/run', { method: 'POST', body: '{}' });
  assert.equal(res.state.status, 500);
  assert.equal(res.json().code, 'DEPLOY_SPAWN_FAILED');
  const job = JSON.parse(readFileSync(join(dataDir, 'deploy', 'job.json'), 'utf8'));
  assert.equal(job.status, 'done');
  assert.match(job.error, /EACCES/);
});

// ── pm2 托管（发布中途要 restart 9826，worker 必须不在它的进程树里）──────

/** 造一个「有 pm2」的仓库布局：只要 node_modules/.bin/pm2* 存在即走 pm2 分支 */
function stubPm2Bin(srcDir) {
  const dir = join(srcDir, 'node_modules', '.bin');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, process.platform === 'win32' ? 'pm2.cmd' : 'pm2'), '@echo off\n', 'utf8');
}

test('run：默认用 pm2 托管 worker（--no-autorestart，父进程是 daemon 而非 9826）', async () => {
  const { srcDir, dataDir } = layout();
  stubWorker(srcDir);
  stubPm2Bin(srcDir);
  initClone(cloneDirOf(srcDir));
  const target = rev(cloneDirOf(srcDir));

  const calls = [];
  let jobAtLaunch = null;
  const fakePm2 = (bin, args, opts) => {
    calls.push({ bin, args: [...args], shell: opts?.shell });
    if (args[0] === 'start') jobAtLaunch = JSON.parse(readFileSync(join(dataDir, 'deploy', 'job.json'), 'utf8'));
    return { status: 0, stdout: '', stderr: '' };
  };
  const mw = createServerPart({
    dataDir, getSession: () => ({ user: 'root' }), enabled: true,
    spawnSync: fakePm2,
    spawn: () => { throw new Error('不该退回 detached'); },
  });
  const res = await call(mw, '/api/deploy/run', { method: 'POST', body: '{}' });
  assert.equal(res.state.status, 202);
  const { jobId } = res.json();

  // 先 delete（清理上一轮的 stopped app），再 start
  assert.equal(calls[0].args[0], 'delete');
  assert.equal(calls[0].args[1], 'plite-deploy-9826');
  const start = calls.find((c) => c.args[0] === 'start');
  assert.ok(start, '必须调用 pm2 start');
  assert.equal(start.args[1], join(srcDir, 'scripts', 'deploy-worker.mjs'));
  assert.deepEqual(start.args.slice(2, 6), ['--name', 'plite-deploy-9826', '--no-autorestart', '--']);
  assert.deepEqual(start.args.slice(6), [dataDir, jobId, srcDir], 'dataDir / jobId / srcDir 必须作为 argv 传给 worker');
  assert.equal(start.shell, true, 'Windows 下 .cmd 需要 shell');

  assert.equal(jobAtLaunch?.targetSha, target, 'job.json 必须在拉起 worker 之前就带 targetSha');
  const job = JSON.parse(readFileSync(join(dataDir, 'deploy', 'job.json'), 'utf8'));
  assert.equal(job.launcher, 'pm2');
});

test('run：pm2 拉起失败 → 500 且 job 收尾成失败（不静默退回 detached）', async () => {
  const { srcDir, dataDir } = layout();
  stubWorker(srcDir);
  stubPm2Bin(srcDir);
  initClone(cloneDirOf(srcDir));
  const mw = createServerPart({
    dataDir, getSession: () => ({ user: 'root' }), enabled: true,
    spawnSync: (_bin, args) => (args[0] === 'start'
      ? { status: 1, stdout: '', stderr: 'pm2 daemon not running' }
      : { status: 1, stdout: '', stderr: 'not found' }),
    spawn: () => { throw new Error('不该退回 detached'); },
  });
  const res = await call(mw, '/api/deploy/run', { method: 'POST', body: '{}' });
  assert.equal(res.state.status, 500);
  assert.equal(res.json().code, 'DEPLOY_SPAWN_FAILED');
  assert.match(res.json().error, /pm2 daemon not running/);
  const job = JSON.parse(readFileSync(join(dataDir, 'deploy', 'job.json'), 'utf8'));
  assert.equal(job.status, 'done');
  assert.equal(job.phase, '失败');
});

test('status：刚投递、pid 还没写回来的空窗期不算「已中断」；超时才判 stale', async () => {
  const { dataDir } = layout();
  const stateDir = join(dataDir, 'deploy');
  mkdirSync(stateDir, { recursive: true });
  const write = (startedAt) => writeFileSync(join(stateDir, 'job.json'), JSON.stringify({
    id: 'warm0001', status: 'queued', phase: '排队', pid: null, startedAt,
  }), 'utf8');
  const mw = createServerPart({ dataDir, getSession: () => ({ user: 'root' }), enabled: true });

  write(new Date().toISOString());
  assert.equal((await call(mw, '/api/deploy/status')).json().job.status, 'queued', '1s 内的空窗期不能误判');

  write(new Date(Date.now() - 120_000).toISOString());
  assert.equal((await call(mw, '/api/deploy/status')).json().job.status, 'stale', '两分钟还没起来就是真挂了');
});

// ── ack / notice ────────────────────────────────────────────────────

test('notice：成功且未确认 → 补弹一次；ack 后消失；旧 id 的迟到 ack 不误标', async () => {
  const { dataDir } = layout();
  mkdirSync(join(dataDir, 'deploy'), { recursive: true });
  const lastRun = join(dataDir, 'deploy', 'last-run.json');
  writeFileSync(lastRun, JSON.stringify({
    id: 'job00001', ok: true, sha: 'b'.repeat(40), startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:01:00.000Z', phase: '完成', notified: false,
  }), 'utf8');

  const mw = createServerPart({ dataDir, getSession: () => ({ user: 'root' }), enabled: true });
  const s1 = (await call(mw, '/api/deploy/status')).json();
  assert.deepEqual(s1.notice, {
    id: 'job00001', sha: 'b'.repeat(40), endedAt: '2026-01-01T00:01:00.000Z', phase: '完成',
  });
  assert.equal(s1.lastRun.notified, false);

  const late = await call(mw, '/api/deploy/ack', { method: 'POST', body: JSON.stringify({ id: 'other' }) });
  assert.equal(late.json().skipped, true);
  assert.equal(JSON.parse(readFileSync(lastRun, 'utf8')).notified, false, '迟到的旧 ack 不能把新通知标记掉');

  const ok = await call(mw, '/api/deploy/ack', { method: 'POST', body: JSON.stringify({ id: 'job00001' }) });
  assert.equal(ok.json().ok, true);
  const s2 = (await call(mw, '/api/deploy/status')).json();
  assert.equal(s2.notice, null);
  assert.equal(s2.lastRun.notified, true);
});

test('notice：失败不推成功通知（失败时页面还在，直接看 job 即可）', async () => {
  const { dataDir } = layout();
  mkdirSync(join(dataDir, 'deploy'), { recursive: true });
  writeFileSync(join(dataDir, 'deploy', 'last-run.json'), JSON.stringify({
    id: 'job00002', ok: false, sha: null, error: 'deploy-9826 退出码 1', notified: false,
  }), 'utf8');
  const mw = createServerPart({ dataDir, getSession: () => ({ user: 'root' }), enabled: true });
  const s = (await call(mw, '/api/deploy/status')).json();
  assert.equal(s.notice, null);
  assert.equal(s.lastRun.ok, false);
  assert.equal(s.lastRun.error, 'deploy-9826 退出码 1');
});

// ── 阶段映射 ────────────────────────────────────────────────────────

test('phaseOf：deploy-9826 的原始输出能翻成用户可读阶段，重复行不回写', () => {
  assert.equal(phaseOf('[deploy-9826] node_modules 缺失 → npm ci'), '安装依赖');
  assert.equal(phaseOf('> polaris-lite@0.2.8 build:plugins'), '构建插件');
  assert.equal(phaseOf('vite v5.4.10 building for production...'), '构建前端');
  assert.equal(phaseOf('✓ built in 1.23s'), '构建前端');
  assert.equal(phaseOf('npx pm2 restart polaris-lite-9826'), '重启 9826');
  assert.equal(phaseOf('[deploy-9826] 完成：4f9bccf fix(...)'), '完成');
  assert.equal(phaseOf('随便一行输出'), null);
  assert.equal(phaseOf(''), null);
  assert.equal(phaseOf('> vite build', '构建前端'), null, '同阶段重复不该触发回写');
  assert.ok(DEPLOY_PHASES.length >= 5);
});
