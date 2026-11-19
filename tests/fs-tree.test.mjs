/**
 * 文件浏览器 v2 新端点回归：/api/fs/tree、/api/fs/roots/from-path、L0 漫游读取。
 *
 * 这些端点在 v2 里新增，此前零单测——一旦禁区校验/漫游开关/预览上限被改坏，
 * 只靠浏览器手测很难发现。这里用真实 HTTP（createProdServer）覆盖关键安全契约：
 *  - tree 顶层骨架含 builtin 根 + sessionRoam 标记；
 *  - L0 漫游可列临时目录、受 PLITE_FS_SESSION 开关控制；
 *  - from-path 拒绝盘符根与 dataDir 禁区；
 *  - roam 读取文本预览上限更紧（256KB）；
 *  - 全部端点未登录 401。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProdServer } from '../server/prod-server.mjs';

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'plite-fstree-'));
  const dist = join(root, 'dist');
  const dataDir = join(root, 'data');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>shell</title>');
  return { root, dist, dataDir };
}

async function startHost(t, env, { sessionRoam } = {}) {
  const prev = process.env.PLITE_FS_SESSION;
  if (sessionRoam === false) process.env.PLITE_FS_SESSION = '0';
  else delete process.env.PLITE_FS_SESSION;
  t.after(() => {
    if (prev === undefined) delete process.env.PLITE_FS_SESSION;
    else process.env.PLITE_FS_SESSION = prev;
  });
  const server = createProdServer({ dist: env.dist, dataDir: env.dataDir });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const send = async (path, { method = 'GET', body, raw } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
      redirect: 'manual',
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const pair = c.split(';')[0];
      if (pair.startsWith('plite.sid=')) cookie = pair;
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: res.status, json };
  };
  const login = () => send('/api/auth/login', { method: 'POST', body: { username: 'boss', password: 'secret123' } });
  return { send, login, dataDir: env.dataDir };
}

// ---------------------------------------------------------------- 鉴权

test('fs v2 端点：未登录一律 401', async (t) => {
  const { send } = await startHost(t, tempRoot());
  for (const p of ['/api/fs/tree', '/api/fs/drives', '/api/fs/roots']) {
    const r = await send(p);
    assert.equal(r.status, 401, `${p} 应要求会话`);
  }
});

// ---------------------------------------------------------------- tree 顶层骨架

test('tree 顶层骨架：返回 builtin 根 + sessionRoam 标记', async (t) => {
  const h = await startHost(t, tempRoot());
  await h.login();
  const r = await h.send('/api/fs/tree');
  assert.equal(r.status, 200);
  assert.equal(r.json.sessionRoam, true);
  const builtin = r.json.nodes.find((n) => n.isRoot && n.builtin);
  assert.ok(builtin, '必须含内置 workspace 根');
  assert.equal(builtin.hasChildren, true);
});

// ---------------------------------------------------------------- L0 漫游

test('tree L0 漫游：可列临时目录，dir 绝对路径返回单层节点', async (t) => {
  const env = tempRoot();
  mkdirSync(join(env.root, 'roam'));
  writeFileSync(join(env.root, 'roam', 'a.txt'), 'hello');
  const h = await startHost(t, env);
  await h.login();
  const r = await h.send(`/api/fs/tree?dir=${encodeURIComponent(join(env.root, 'roam'))}`);
  assert.equal(r.status, 200);
  assert.ok(r.json.nodes.some((n) => n.name === 'a.txt' && !n.isDir));
});

test('PLITE_FS_SESSION=0：L0 漫游被禁用且顶层不再列盘符', async (t) => {
  const env = tempRoot();
  mkdirSync(join(env.root, 'roam'));
  const h = await startHost(t, env, { sessionRoam: false });
  await h.login();
  const top = await h.send('/api/fs/tree');
  assert.equal(top.status, 200);
  assert.equal(top.json.sessionRoam, false);
  assert.ok(!top.json.nodes.some((n) => n.isDrive), '禁用漫游后顶层不应出现盘符');
  const roam = await h.send(`/api/fs/tree?dir=${encodeURIComponent(join(env.root, 'roam'))}`);
  assert.equal(roam.status, 403);
  assert.equal(roam.json.code, 'FS_ROAM_DISABLED');
});

// ---------------------------------------------------------------- from-path

test('from-path：拒绝盘符根（范围过大）', async (t) => {
  const h = await startHost(t, tempRoot());
  await h.login();
  const drive = process.platform === 'win32' ? 'C:\\' : '/';
  const r = await h.send('/api/fs/roots/from-path', { method: 'POST', body: { path: drive } });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'FS_ROOT_TOO_SHALLOW');
});

test('from-path：拒绝 dataDir 禁区（除内置 workspace 外）', async (t) => {
  const env = tempRoot();
  const h = await startHost(t, env);
  await h.login();
  const r = await h.send('/api/fs/roots/from-path', { method: 'POST', body: { path: env.dataDir } });
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'FS_FORBIDDEN');
});

test('read L0 漫游：超过 256KB 文本返回 tooLarge 且提示用 head/tail', async (t) => {
  const env = tempRoot();
  mkdirSync(join(env.root, 'roam'));
  const big = join(env.root, 'roam', 'big.txt');
  writeFileSync(big, 'x'.repeat(257 * 1024));
  const h = await startHost(t, env);
  await h.login();
  const r = await h.send(`/api/fs/read?path=${encodeURIComponent(big)}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.tooLarge, true);
  assert.match(r.json.hint, /head\/tail/);
});

test('from-path：合法目录可一步登记为根', async (t) => {
  const env = tempRoot();
  mkdirSync(join(env.root, 'work'));
  const h = await startHost(t, env);
  await h.login();
  const r = await h.send('/api/fs/roots/from-path', { method: 'POST', body: { path: join(env.root, 'work'), label: '我的工作' } });
  assert.equal(r.status, 200);
  const entry = r.json.roots.find((x) => x.label === '我的工作');
  assert.ok(entry && !entry.builtin);
});
