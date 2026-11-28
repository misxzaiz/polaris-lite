/**
 * git 工具链路测试：tool.mjs 的动作映射/根回退/结果格式化 + dispatch 端点的
 * Bearer 门禁回归（AI 工具 loopback 调用只带系统 Bearer 不带 cookie——缺了必 401）。
 *
 * 端点用例走真实 git 仓库（tmpdir 里 git init + commit，秒级），沿用
 * agent-bash.test.mjs 的中间件直调模式（不起真 HTTP 服务）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServerPart as gitServerPart } from '../plugins/git-core/server.mjs';
import { registerGitTool } from '../plugins/git-core/tool.mjs';

/** 收集注册的 tool adapter（不走真 registry，避免重复 id 全局态） */
function mockRegistry() {
  const adapters = [];
  return { adapters, registerTool(a) { adapters.push(a); } };
}

function mockHost(dispatchImpl, rootsImpl) {
  return {
    callEndpoint: async (path, body) => ({ status: 200, ok: true, json: await dispatchImpl(path, body) }),
    get: async (path) => ({ status: 200, ok: true, json: rootsImpl ? rootsImpl(path) : { roots: [] } }),
  };
}

// ── tool.mjs：动作映射与格式化 ────────────────────────────────────────────

test('git tool: 注册声明完整', () => {
  const reg = mockRegistry();
  registerGitTool(reg);
  assert.equal(reg.adapters.length, 1);
  const a = reg.adapters[0];
  assert.equal(a.name, 'git');
  assert.equal(a.descriptor.function.name, 'git');
  assert.equal(typeof a.invoke, 'function');
});

test('git tool: 未知动作拒绝', async () => {
  const reg = mockRegistry();
  registerGitTool(reg);
  const r = await reg.adapters[0].invoke({ args: { action: 'commit' }, run: {}, host: mockHost(async () => ({})) });
  assert.equal(r.ok, false);
  assert.match(r.stderr, /可用：status\/diff\/file_diff\/log\/branches/);
});

test('git tool: status 格式化（porcelain 双字母回放）', async () => {
  const reg = mockRegistry();
  registerGitTool(reg);
  const seen = [];
  const host = mockHost(async (p, body) => { seen.push(body); return {
    ok: true, durationMs: 3,
    result: {
      branch: 'master', ahead: 1, behind: 2,
      staged: [{ path: 'a.mjs' }], unstaged: [{ path: 'b.mjs' }], untracked: ['x.log'],
      files: [
        { path: 'a.mjs', x: 'M', y: ' ', staged: true, unstaged: false, untracked: false },
        { path: 'b.mjs', x: ' ', y: 'M', staged: false, unstaged: true, untracked: false },
        { path: 'x.log', x: '?', y: '?', staged: false, unstaged: false, untracked: true },
      ],
    },
  }; });
  const r = await reg.adapters[0].invoke({ args: { action: 'status' }, run: { boundRootId: 'r-x' }, host });
  assert.equal(r.ok, true);
  assert.match(r.stdout, /分支 master（ahead 1 \/ behind 2）/);
  assert.match(r.stdout, /^M  a\.mjs$/m);
  assert.match(r.stdout, /^ M b\.mjs$/m);
  assert.match(r.stdout, /^\?\? x\.log$/m);
  // 派发负载：会话绑定根透传
  assert.equal(seen[0].action, 'get_status');
  assert.equal(seen[0].rootId, 'r-x');
});

test('git tool: log 格式化与 limit 透传', async () => {
  const reg = mockRegistry();
  registerGitTool(reg);
  const seen = [];
  const host = mockHost(async (p, body) => { seen.push(body); return {
    ok: true,
    result: [{ sha: 'ab12cd34', author: 'quan', at: 1764000000, message: 'fix: x' }],
  }; });
  const r = await reg.adapters[0].invoke({ args: { action: 'log', limit: 10, skip: 5 }, run: {}, host });
  assert.equal(r.ok, true);
  assert.match(r.stdout, /^ab12cd34 /m);
  assert.match(r.stdout, /quan fix: x$/m);
  assert.equal(seen[0].action, 'get_log');
  assert.equal(seen[0].limit, 10);
  assert.equal(seen[0].skip, 5);
});

test('git tool: 根回退链——无绑定根时取登记表第一个非内建根', async () => {
  const reg = mockRegistry();
  registerGitTool(reg);
  let gotRootId = '';
  const host = mockHost(
    async (p, body) => { gotRootId = body.rootId; return { ok: true, result: [] }; },
    () => ({ roots: [{ id: 'r-builtin', builtin: true }, { id: 'r-repo', builtin: false }] }),
  );
  const r = await reg.adapters[0].invoke({ args: { action: 'branches' }, run: {}, host });
  assert.equal(r.ok, true);
  assert.equal(gotRootId, 'r-repo');
});

test('git tool: 根回退链——绑定根是内建 workspace 时跳过，用第一个非内建根（真机 E2E 教训）', async () => {
  const reg = mockRegistry();
  registerGitTool(reg);
  let gotRootId = '';
  const host = mockHost(
    async (p, body) => { gotRootId = body.rootId; return { ok: true, result: [] }; },
    () => ({ roots: [{ id: 'r-builtin', builtin: true }, { id: 'r-repo', builtin: false }] }),
  );
  const r = await reg.adapters[0].invoke({ args: { action: 'branches' }, run: { boundRootId: 'r-builtin' }, host });
  assert.equal(r.ok, true);
  assert.equal(gotRootId, 'r-repo');
});

test('git tool: 根回退链——绑定根是非内建登记根时优先用绑定根', async () => {
  const reg = mockRegistry();
  registerGitTool(reg);
  let gotRootId = '';
  const host = mockHost(
    async (p, body) => { gotRootId = body.rootId; return { ok: true, result: [] }; },
    () => ({ roots: [{ id: 'r-builtin', builtin: true }, { id: 'r-repo', builtin: false }, { id: 'r-other', builtin: false }] }),
  );
  const r = await reg.adapters[0].invoke({ args: { action: 'branches' }, run: { boundRootId: 'r-other' }, host });
  assert.equal(r.ok, true);
  assert.equal(gotRootId, 'r-other');
});

test('git tool: dispatch 失败转可读错误', async () => {
  const reg = mockRegistry();
  registerGitTool(reg);
  const host = mockHost(async () => ({ ok: false, error: '该目录不是 Git 仓库' }));
  const r = await reg.adapters[0].invoke({ args: { action: 'status' }, run: { boundRootId: 'r-x' }, host });
  assert.equal(r.ok, false);
  assert.match(r.stderr, /该目录不是 Git 仓库/);
});

// ── dispatch 端点：门禁与真实仓库 ────────────────────────────────────────

/** 临时 git 仓库（init + add + commit），返回路径 */
function makeGitRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'gittool-'));
  const run = (args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  run(['init', '-b', 'master']); // -b 定死默认分支名（git 版本间默认值不同）
  run(['-c', 'user.name=t', '-c', 'user.email=t@t.io', 'commit', '--allow-empty', '-m', 'init']);
  writeFileSync(join(dir, 'hello.txt'), 'hi\n');
  run(['add', 'hello.txt']);
  run(['-c', 'user.name=t', '-c', 'user.email=t@t.io', 'commit', '-m', 'add hello']);
  return dir;
}

/** git-core 中间件直调器（session/bearer/socket 可控） */
function gitEnv({ withRoots } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gitcore-'));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  if (withRoots) writeFileSync(join(dataDir, 'workspace-roots.json'), JSON.stringify({ roots: [{ id: 'r-t', path: withRoots }] }));
  const mw = gitServerPart({
    dataDir,
    getSession: null,
    verifyTempToken: (t) => t === 'good-token',
  });
  const call = (body, { bearer = '', remote = '127.0.0.1', session = false } = {}) => new Promise((doneResolve) => {
    const chunks = [Buffer.from(JSON.stringify(body))];
    const res = {
      code: 0, body: '',
      writeHead(c) { this.code = c; return this; },
      end(b) { this.body = b ?? ''; doneResolve({ status: this.code, body: this.body }); },
      on() { return this; },
    };
    mw(
      {
        url: '/api/git/dispatch', method: 'POST', headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
        socket: { remoteAddress: remote },
        on(ev, cb) { if (ev === 'data') cb(chunks.shift()); if (ev === 'end') cb(); return this; },
      },
      res,
      () => {},
    );
  });
  return { dataDir, call };
}

test('dispatch: 无凭证 401；非回环 Bearer 拒绝；合法回环 Bearer 放行', async () => {
  const repo = makeGitRepo();
  const env = gitEnv({ withRoots: repo });
  const r401 = await env.call({ action: 'get_status', rootId: 'r-t' });
  assert.equal(r401.status, 401);
  const rRemote = await env.call({ action: 'get_status', rootId: 'r-t' }, { bearer: 'good-token', remote: '10.0.0.8' });
  assert.equal(rRemote.status, 401);
  const rBad = await env.call({ action: 'get_status', rootId: 'r-t' }, { bearer: 'nope' });
  assert.equal(rBad.status, 401);
  const rOk = await env.call({ action: 'get_status', rootId: 'r-t' }, { bearer: 'good-token' });
  assert.equal(rOk.status, 200);
  const j = JSON.parse(rOk.body);
  assert.equal(j.ok, true);
  assert.equal(j.result.branch, 'master');
  assert.equal(j.result.files.length, 0);
});

test('dispatch: 未知动作 400；get_log 解析为条目数组', async () => {
  const repo = makeGitRepo();
  const env = gitEnv({ withRoots: repo });
  const rUnknown = await env.call({ action: 'rebase_hard', rootId: 'r-t' }, { bearer: 'good-token' });
  assert.equal(rUnknown.status, 400);
  const rLog = await env.call({ action: 'get_log', rootId: 'r-t', limit: 5 }, { bearer: 'good-token' });
  assert.equal(rLog.status, 200);
  const j = JSON.parse(rLog.body);
  assert.equal(j.ok, true);
  assert.ok(Array.isArray(j.result));
  assert.equal(j.result.length, 2);
  assert.equal(j.result[0].message, 'add hello');
});

test('dispatch: 会话 cookie 同样放行（面板路径不受影响）', async () => {
  const repo = makeGitRepo();
  const root = mkdtempSync(join(tmpdir(), 'gitcore-'));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'workspace-roots.json'), JSON.stringify({ roots: [{ id: 'r-t', path: repo }] }));
  const mw = gitServerPart({ dataDir, getSession: () => ({ user: { name: 'boss' } }) });
  const out = await new Promise((doneResolve) => {
    const chunks = [Buffer.from(JSON.stringify({ action: 'get_branches', rootId: 'r-t' }))];
    const res = {
      code: 0, body: '',
      writeHead(c) { this.code = c; return this; },
      end(b) { this.body = b ?? ''; doneResolve({ status: this.code, body: this.body }); },
      on() { return this; },
    };
    mw({ url: '/api/git/dispatch', method: 'POST', headers: {}, socket: {}, on(ev, cb) { if (ev === 'data') cb(chunks.shift()); if (ev === 'end') cb(); return this; } }, res, () => {});
  });
  assert.equal(out.status, 200);
  const j = JSON.parse(out.body);
  assert.equal(j.ok, true);
  assert.ok(j.result.some((b) => b.name === 'master' && b.current));
});
