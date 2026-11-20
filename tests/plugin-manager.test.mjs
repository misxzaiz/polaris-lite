/**
 * plugin-manager server 半边回归测试：启停写盘 / 白名单 / 门禁。
 *
 * 直接调用 createServerPart（不经宿主装配），用临时目录构造 registry.json；
 * 单独成文件是因为宿主集成测试（server.test.mjs）的 tempRoot 不含 public/plugins，
 * 而本插件的全部语义都在「对 registry.json 的读写约束」上。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerPart } from '../plugins/plugin-manager/server.mjs';

/** 临时 repo：public/plugins/registry.json + 一个假插件目录（供版本号 hash） */
function tempRepo(t) {
  const root = mkdtempSync(join(tmpdir(), 'plite-pm-'));
  t.after(() => { /* mkdtemp 目录留给系统清理；不阻塞 */ });
  const pluginsDir = join(root, 'public', 'plugins');
  mkdirSync(join(pluginsDir, 'demo'), { recursive: true });
  writeFileSync(join(pluginsDir, 'demo', 'plugin.js'), '// demo bundle');
  writeFileSync(
    join(pluginsDir, 'registry.json'),
    JSON.stringify({ plugins: [
      { id: 'demo', module: '/plugins/demo/plugin.js', enabled: true, style: '/plugins/demo/style.css' },
      { id: 'other', module: '/plugins/other/plugin.js', enabled: true },
    ] }, null, 2),
  );
  return { root, registryFile: join(pluginsDir, 'registry.json') };
}

/** 以本文件真实 URL 推导 repoRoot——server.mjs 以 import.meta.url 定位，
 *  所以测试里也用真实模块路径注入（复制 server.mjs 到临时目录不可行，直接改 cwd 不可靠）。
 *  这里通过 monkey-patch 不行（ESM 只读），改为：调用真实模块，但把临时 registry 放到
 *  它推导出的 repoRoot 下是不可能的 → 退而求其次，验证真实 repoRoot 的行为。
 *  因此本测试直接对**真实仓库**的 registry.json 做往返后恢复原样（读原值 → 改 → 复原）。 */
function realApi() {
  const mw = createServerPart({ getSession: () => ({ user: { name: 'tester' } }), dataDir: '.polaris-lite-dev' });
  const call = async (path, body) => {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
    const req = {
      url: path,
      method: body === undefined ? 'GET' : 'POST',
      headers: {},
      on(ev, cb) {
        if (ev === 'data' && chunks.length) cb(chunks.shift());
        if (ev === 'end') cb();
        return req;
      },
    };
    const res = {
      code: 0, headers: {}, body: '',
      writeHead(c, h) { this.code = c; Object.assign(this.headers, h ?? {}); return this; },
      end(b) { this.body = b ?? ''; },
    };
    let nextCalled = false;
    await mw(req, res, () => { nextCalled = true; });
    let json = null;
    try { json = JSON.parse(res.body); } catch { /* 非 JSON */ }
    return { status: res.code, json, nextCalled };
  };
  return { call };
}

// ---------------------------------------------------------------- 门禁

test('plugin-admin：未登录 401；PLITE_PLUGIN_ADMIN=0 时直接放行给后续中间件', async () => {
  const anon = createServerPart({ getSession: () => null, dataDir: '.polaris-lite-dev' });
  const res = { code: 0, headers: {}, body: '', writeHead(c, h) { this.code = c; Object.assign(this.headers, h ?? {}); return this; }, end(b) { this.body = b ?? ''; } };
  let next = false;
  await anon({ url: '/api/plugin-admin/list', method: 'GET', headers: {}, on: () => {} }, res, () => { next = true; });
  assert.equal(res.code, 401);
  assert.equal(next, false);

  process.env.PLITE_PLUGIN_ADMIN = '0';
  try {
    const off = createServerPart({ getSession: () => ({ user: { name: 'x' } }), dataDir: '.polaris-lite-dev' });
    let next2 = false;
    await off({ url: '/api/plugin-admin/list', method: 'GET', headers: {}, on: () => {} }, res, () => { next2 = true; });
    assert.equal(next2, true, '硬关闭时应 next() 交给后续中间件');
  } finally {
    delete process.env.PLITE_PLUGIN_ADMIN;
  }
});

test('plugin-admin：非本插件路径一律 next()，不吞请求', async () => {
  const { call } = realApi();
  const res = await call('/api/other/thing');
  assert.equal(res.nextCalled, true);
});

// ---------------------------------------------------------------- list / setEnabled

test('plugin-admin：list 返回 registry 清单；setEnabled 往返改写并 bump 版本号', async () => {
  const registryFile = 'public/plugins/registry.json';
  const original = readFileSync(registryFile, 'utf8');
  try {
    const { call } = realApi();
    const listed = await call('/api/plugin-admin/list');
    assert.equal(listed.status, 200);
    assert.ok(Array.isArray(listed.json.plugins) && listed.json.plugins.length > 0);
    const target = listed.json.plugins.find((p) => p.id === 'browser-lite');
    assert.ok(target, 'browser-lite 应在清单中');
    const origEnabled = target.enabled;
    const origModule = target.module;

    const flip = await call('/api/plugin-admin/set-enabled', { id: 'browser-lite', enabled: !origEnabled });
    assert.equal(flip.status, 200);
    assert.equal(flip.json.changed, true);
    assert.equal(flip.json.applied, false, '变更在下次加载（刷新/重启）才生效');

    const after = JSON.parse(readFileSync(registryFile, 'utf8')).plugins.find((p) => p.id === 'browser-lite');
    assert.equal(after.enabled, !origEnabled);
    if (origModule.includes('?v=')) {
      assert.match(after.module, /\?v=[0-9a-f]{8}$/, '写盘后 module 仍带内容 hash 版本号');
    }

    // 幂等：重复设置同值 changed=false
    const again = await call('/api/plugin-admin/set-enabled', { id: 'browser-lite', enabled: !origEnabled });
    assert.equal(again.json.changed, false);

    // 复原
    await call('/api/plugin-admin/set-enabled', { id: 'browser-lite', enabled: origEnabled });
    const restored = JSON.parse(readFileSync(registryFile, 'utf8')).plugins.find((p) => p.id === 'browser-lite');
    assert.equal(restored.enabled, origEnabled);
  } finally {
    writeFileSync(registryFile, original);
  }
});

test('plugin-admin：未知 id 404；非法参数 400；不存在的端点 404', async () => {
  const { call } = realApi();
  const missing = await call('/api/plugin-admin/set-enabled', { id: 'definitely-not-a-plugin', enabled: false });
  assert.equal(missing.status, 404);

  const bad = await call('/api/plugin-admin/set-enabled', { id: 'browser-lite', enabled: 'yes' });
  assert.equal(bad.status, 400);

  const nf = await call('/api/plugin-admin/nope');
  assert.equal(nf.status, 404);
});
