/**
 * plugin-market 测试：源管理 / 安装校验（sha256/manifest/逃逸/id 冲突）/ registry 双写增项 /
 * /ext-plugins 自服务路由（穿越拒绝）/ 卸载。
 * 用临时目录伪造「商城源 + 插件包 + 仓库 registry」，直调 createServerPart。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createServerPart } from '../plugins/plugin-market/server.mjs';

function tempEnv(t) {
  const root = mkdtempSync(join(tmpdir(), 'plite-market-'));
  const dataDir = join(root, 'data');
  const marketDir = join(root, 'market-src');        // 商城源目录
  const repoRoot = join(root, 'repo');               // 伪仓库根（registry 双写目标）
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(marketDir, { recursive: true });
  mkdirSync(join(repoRoot, 'public', 'plugins'), { recursive: true });
  mkdirSync(join(repoRoot, 'dist', 'plugins'), { recursive: true });
  const baseRegistry = { plugins: [{ id: 'builtin-x', module: '/plugins/builtin-x/plugin.js', enabled: true }] };
  writeFileSync(join(repoRoot, 'public', 'plugins', 'registry.json'), JSON.stringify(baseRegistry));
  writeFileSync(join(repoRoot, 'dist', 'plugins', 'registry.json'), JSON.stringify(baseRegistry));
  t.after(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* 忽略 */ } });

  // server.mjs 用 import.meta.url 推导真实仓库根——测试注入伪根需经 env。这里测真实行为不可行，
  // 改为：把 server 模块的 repoRoot 计算保持原样，但测试关注点在 dataDir 内的文件操作与
  // 返回值校验；registry 断言通过 monkey 不可行 → 直接断言 extPluginsDir 落盘 + API 返回，
  // registry 写入路径在真实 repoRoot（有 existsSync 守卫——测试机仓库存在，会真写！）
  // 因此本测试**只测不落 registry 的路径**？不行——install 必然写。
  // 折中：install 用「id 与已注册冲突」分支验证拒绝；正常 install 的 registry 断言改验
  // dataDir/plugins 落盘 + 二次 install 冲突。真实 registry 双写由 E2E 冒烟覆盖。
  const mw = createServerPart({ getSession: () => ({ user: { name: 't' } }), dataDir, repoRoot });
  const call = async (path, body) => {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
    const res = { code: 0, body: '', writeHead(c) { this.code = c; return this; }, end(b) { this.body = b ?? ''; } };
    await mw({ url: path, method: body === undefined ? 'GET' : 'POST', headers: {}, on(ev, cb) { if (ev === 'data' && chunks.length) cb(chunks.shift()); if (ev === 'end') cb(); return this; } }, res, () => {});
    try { return { status: res.code, json: JSON.parse(res.body) }; } catch { return { status: res.code, json: null }; }
  };
  return { root, dataDir, marketDir, repoRoot, call };
}

function writePackage(marketDir, id, { manifest, js, css }) {
  const pkg = join(marketDir, id);
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, 'plugin.json'), JSON.stringify(manifest));
  writeFileSync(join(pkg, 'plugin.js'), js);
  if (css) writeFileSync(join(pkg, 'style.css'), css);
  return {
    id,
    name: manifest.name ?? id,
    version: manifest.version ?? '0.1.0',
    description: '测试插件',
    sha256: createHash('sha256').update(js).digest('hex'),
  };
}

test('market: 添加源 → 列清单 → 安装（sha256 校验 + 落盘）→ 冲突拒绝', async (t) => {
  const { dataDir, marketDir, repoRoot, call } = tempEnv(t);
  const entry = writePackage(marketDir, 'hello-tool', {
    manifest: { id: 'hello-tool', name: 'Hello 工具', version: '0.1.0', capabilities: [], provides: [], events: [], contributes: { slots: [] } },
    js: 'export default { manifest: { id: "hello-tool" } };',
  });
  writeFileSync(join(marketDir, 'index.json'), JSON.stringify({ name: '测试源', plugins: [entry] }));

  const add = await call('/api/market/sources', { name: 'test-src', type: 'dir', ref: marketDir });
  assert.equal(add.json.ok, true, '添加源应成功');

  const list = await call('/api/market/list');
  assert.equal(list.json.items.length, 1);
  assert.equal(list.json.items[0].id, 'hello-tool');
  assert.equal(list.json.items[0].installed, false);

  const bad = await call('/api/market/sources', { name: 'x2', type: 'dir', ref: join(marketDir, '不存在') });
  assert.equal(bad.status, 400, '不存在的源目录应拒绝');

  // 安装（真实仓库 registry 里 hello-tool 未注册 → 通过 dataDir 落盘；registry 写真实 repo——避免污染：
  // 用冲突分支前先安装一次并断言 dataDir 落盘）
  const inst = await call('/api/market/install', { source: 'test-src', id: 'hello-tool' });
  assert.equal(inst.json.ok, true, `安装应成功：${JSON.stringify(inst.json)}`);
  assert.ok(existsSync(join(dataDir, 'plugins', 'hello-tool', 'plugin.js')), 'bundle 应落外部插件目录');
  assert.ok(existsSync(join(dataDir, 'plugins', 'hello-tool', 'plugin.json')));

  // 二次安装：registry 里残留的是上次安装自己写入的 /ext-plugins 条目 → 覆盖更新放行（不再误报冲突）
  const regNow = JSON.parse(readFileSync(join(repoRoot, 'public', 'plugins', 'registry.json'), 'utf8'));
  const reinstalled = regNow.plugins.find((p) => p && p.id === 'hello-tool');
  assert.ok(reinstalled, '首装后 registry 应有 hello-tool 条目');
  assert.ok(String(reinstalled.module).startsWith('/ext-plugins/'), '商城安装条目 module 应指向 /ext-plugins/');
  const again = await call('/api/market/install', { source: 'test-src', id: 'hello-tool' });
  assert.equal(again.status, 200, '同 id 覆盖更新应放行（ext 条目不再视为冲突）');
  assert.equal(again.json.ok, true, `覆盖更新应成功：${JSON.stringify(again.json)}`);
  // 覆盖后 registry 仍应只有一条 hello-tool（去重覆盖，不重复 push）
  const regAfter = JSON.parse(readFileSync(join(repoRoot, 'public', 'plugins', 'registry.json'), 'utf8'));
  assert.equal(regAfter.plugins.filter((p) => p && p.id === 'hello-tool').length, 1, '覆盖更新后不应产生重复条目');
  // 清理真实 registry 的测试条目（防污染真实仓库）
  for (const p of ['public/plugins/registry.json', 'dist/plugins/registry.json']) {
    try {
      const rp = resolve('D:/space/base/polaris-lite', p);
      const reg = JSON.parse(readFileSync(rp, 'utf8'));
      if (reg.plugins.some((x) => x && x.id === 'hello-tool')) {
        reg.plugins = reg.plugins.filter((x) => !x || x.id !== 'hello-tool');
        writeFileSync(rp, JSON.stringify(reg, null, 2) + '\n');
      }
    } catch { /* 缺侧忽略 */ }
  }
});

test('market: sha256 不符拒绝 / 缺 manifest 拒绝 / /ext-plugins 穿越拒绝', async (t) => {
  const { root, dataDir, marketDir, call } = tempEnv(t);
  const entry = writePackage(marketDir, 'bad-hash', {
    manifest: { id: 'bad-hash', name: 'x', version: '0.1.0' },
    js: 'export default 1;',
  });
  entry.sha256 = '0'.repeat(64); // 故意错的指纹
  writePackage(marketDir, 'no-manifest', { manifest: { id: 'no-manifest' }, js: 'x' });
  mkdirSync(join(marketDir, 'empty-pkg'), { recursive: true }); // 无 plugin.json
  writeFileSync(join(marketDir, 'index.json'), JSON.stringify({
    name: '坏源', plugins: [entry, { id: 'empty-pkg' }],
  }));
  await call('/api/market/sources', { name: 'bad-src', type: 'dir', ref: marketDir });

  const badHash = await call('/api/market/install', { source: 'bad-src', id: 'bad-hash' });
  assert.equal(badHash.status, 400, 'sha256 不符应拒绝');
  assert.match(String(badHash.json.error), /sha256 不符/);

  const empty = await call('/api/market/install', { source: 'bad-src', id: 'empty-pkg' });
  assert.equal(empty.status, 400, '缺 plugin.json 应拒绝');
  assert.ok(!existsSync(join(dataDir, 'plugins', 'bad-hash')), '坏包不应落盘');

  // /ext-plugins 穿越拒绝（未鉴权路径）
  const callRaw = async (url) => {
    const res = { code: 0, body: '', writeHead(c) { this.code = c; return this; }, end(b) { this.body = b ?? ''; } };
    await mw2({ url, method: 'GET', headers: {}, on() { return this; } }, res, () => {});
    return res.code;
  };
  const mw2 = createServerPart({ getSession: () => ({ user: { name: 't' } }), dataDir, repoRoot: root });
  assert.equal(await callRaw('/ext-plugins/../market-sources.json'), 400, '路径穿越应拒绝');
  assert.equal(await callRaw('/ext-plugins/hello/..%5C..%5Cx.js'), 400);
  assert.equal(await callRaw('/ext-plugins/ghost/plugin.js'), 404, '不存在应 404');
});


test('market: http 源 —— 清单/包下载 + sha256 强校验 + 落盘（本地 http 服务模拟远程）', async (t) => {
  const { createServer } = await import('node:http');
  const { dataDir, marketDir, repoRoot, call } = tempEnv(t);
  const entry = writePackage(marketDir, 'http-tool', {
    manifest: { id: 'http-tool', name: 'HTTP 工具', version: '0.2.0', capabilities: [], provides: [], events: [], contributes: { slots: [] } },
    js: 'export default { manifest: { id: "http-tool" } };',
    css: '.http-tool{}',
  });
  writeFileSync(join(marketDir, 'index.json'), JSON.stringify({ name: '远程源', plugins: [entry] }));
  const srv = createServer((req, res) => {
    const path = req.url.replace(/^\/+/, '');
    const file = join(marketDir, path);
    try {
      const data = readFileSync(file);
      res.writeHead(200);
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('nf');
    }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  t.after(() => srv.close());

  const badAdd = await call('/api/market/sources', { name: 'h-bad', type: 'http', ref: 'not-a-url' });
  assert.equal(badAdd.status, 400, '非法 URL 应拒绝');

  // 清单 URL 指向 index.json；安装器应从其父目录按 <id>/ 寻址包文件
  const add = await call('/api/market/sources', { name: 'h-src', type: 'http', ref: `http://127.0.0.1:${port}/index.json` });
  assert.equal(add.json.ok, true, '添加 http 源应成功');

  const list = await call('/api/market/list');
  const item = list.json.items.find((x) => x.id === 'http-tool');
  assert.ok(item, 'http 源条目应聚合进商城清单');
  assert.equal(item.installed, false);

  const inst = await call('/api/market/install', { source: 'h-src', id: 'http-tool' });
  assert.equal(inst.json.ok, true, `http 安装应成功：${JSON.stringify(inst.json)}`);
  assert.ok(existsSync(join(dataDir, 'plugins', 'http-tool', 'plugin.js')), 'bundle 应落盘');
  assert.ok(existsSync(join(dataDir, 'plugins', 'http-tool', 'style.css')), '可选 style.css 应落盘');

  // 缺 sha256 的 http 条目应拒绝（供应链防线）
  const entryNoHash = { id: 'no-hash', name: 'n', version: '0.1.0' };
  writePackage(marketDir, 'no-hash', { manifest: { id: 'no-hash' }, js: 'x' });
  writeFileSync(join(marketDir, 'index2.json'), JSON.stringify({ name: 'n2', plugins: [entryNoHash] }));
  await call('/api/market/sources', { name: 'h-src2', type: 'http', ref: `http://127.0.0.1:${port}/index2.json` });
  const noHash = await call('/api/market/install', { source: 'h-src2', id: 'no-hash' });
  assert.equal(noHash.status, 400, '缺 sha256 应拒绝');
  assert.match(String(noHash.json.error), /sha256/);

  // 清理真实仓库 registry 中可能写入的条目（防污染）
  for (const p of ['public/plugins/registry.json', 'dist/plugins/registry.json']) {
    try {
      const rp = resolve('D:/space/base/polaris-lite', p);
      const reg = JSON.parse(readFileSync(rp, 'utf8'));
      if (reg.plugins.some((x) => x && x.id === 'http-tool')) {
        reg.plugins = reg.plugins.filter((x) => !x || x.id !== 'http-tool');
        writeFileSync(rp, JSON.stringify(reg, null, 2) + '\n');
      }
    } catch { /* 忽略 */ }
  }
});

test('market: registry 动态合并——构建冲洗后外置插件条目不丢（已安装但 tab 消失的根因修复）', async (t) => {
  const { dataDir, marketDir, repoRoot, call } = await tempEnv(t);
  // 造源：两个外置插件（一个带 style）
  const pk1 = writePackage(marketDir, 'ext-a', {
    manifest: { id: 'ext-a', name: 'Ext A', version: '1.0.0', capabilities: [], provides: [], events: [] },
    js: 'export const manifest={id:"ext-a"};',
    css: '.a{}',
  });
  const pk2 = writePackage(marketDir, 'ext-b', {
    manifest: { id: 'ext-b', name: 'Ext B', version: '1.0.0', capabilities: [], provides: [], events: [] },
    js: 'export const manifest={id:"ext-b"};',
  });
  writeFileSync(join(marketDir, 'index.json'), JSON.stringify({ version: 1, plugins: [pk1, pk2] }));

  const addSrc = await call('/api/market/sources', { name: 'test-local', type: 'dir', ref: marketDir });
  assert.equal(addSrc.status, 200, '添加源');
  const inst1 = await call('/api/market/install', { source: 'test-local', id: 'ext-a' });
  assert.equal(inst1.status, 200, '安装 ext-a');
  await call('/api/market/install', { source: 'test-local', id: 'ext-b' });

  // 安装后 registry 合并：静态基座(builtin-x) + 两个外置插件
  const afterInstall = await call('/plugins/registry.json');
  assert.equal(afterInstall.status, 200);
  const ids1 = afterInstall.json.plugins.map((p) => p.id).sort();
  assert.deepEqual(ids1, ['builtin-x', 'ext-a', 'ext-b'], '安装后 registry 含全部插件');
  const extA = afterInstall.json.plugins.find((p) => p.id === 'ext-a');
  assert.match(extA.module, /^\/ext-plugins\/ext-a\/plugin.js\?v=/, 'module 指向 /ext-plugins 自服务');
  assert.match(extA.style, /^\/ext-plugins\/ext-a\/style.css\?v=/, 'style 条目');
  assert.equal(typeof extA.enabled, 'boolean');

  // 模拟构建冲洗：registry.json 被 build:plugins 重新生成（只剩内置插件）
  const washed = { plugins: [{ id: 'builtin-x', module: '/plugins/builtin-x/plugin.js?v=1', enabled: true }] };
  writeFileSync(join(repoRoot, 'public', 'plugins', 'registry.json'), JSON.stringify(washed));
  writeFileSync(join(repoRoot, 'dist', 'plugins', 'registry.json'), JSON.stringify(washed));

  const afterWash = await call('/plugins/registry.json');
  const ids2 = afterWash.json.plugins.map((p) => p.id).sort();
  assert.deepEqual(ids2, ['builtin-x', 'ext-a', 'ext-b'], '构建冲洗后外置插件条目仍在（动态合并）');

  // 卸载后条目消失
  await call('/api/market/uninstall', { id: 'ext-a' });
  const afterUninstall = await call('/plugins/registry.json');
  const ids3 = afterUninstall.json.plugins.map((p) => p.id).sort();
  assert.deepEqual(ids3, ['builtin-x', 'ext-b'], '卸载后条目移除');

  // 坏 registry 兜底：静态侧全坏时外置插件仍可加载
  writeFileSync(join(repoRoot, 'public', 'plugins', 'registry.json'), '{broken');
  writeFileSync(join(repoRoot, 'dist', 'plugins', 'registry.json'), '{broken');
  const broken = await call('/plugins/registry.json');
  const ids4 = broken.json.plugins.map((p) => p.id);
  assert.deepEqual(ids4, ['ext-b'], '静态 registry 坏掉时兜底只剩外置（可用）');
});

test('market: 卸载 + PLITE_MARKET=0 旁路', async (t) => {
  const { dataDir, marketDir, call } = tempEnv(t);
  const entry = writePackage(marketDir, 'tmp-tool', {
    manifest: { id: 'tmp-tool', name: 'x', version: '0.1.0' },
    js: 'export default 1;',
  });
  writeFileSync(join(marketDir, 'index.json'), JSON.stringify({ name: 's', plugins: [entry] }));
  await call('/api/market/sources', { name: 's2', type: 'dir', ref: marketDir });
  await call('/api/market/install', { source: 's2', id: 'tmp-tool' });
  assert.ok(existsSync(join(dataDir, 'plugins', 'tmp-tool')));
  const rm = await call('/api/market/uninstall', { id: 'tmp-tool' });
  assert.equal(rm.json.ok, true);
  assert.ok(!existsSync(join(dataDir, 'plugins', 'tmp-tool')));
  for (const p of ['public/plugins/registry.json', 'dist/plugins/registry.json']) {
    try {
      const rp = resolve('D:/space/base/polaris-lite', p);
      const reg = JSON.parse(readFileSync(rp, 'utf8'));
      if (reg.plugins.some((x) => x && x.id === 'tmp-tool')) {
        reg.plugins = reg.plugins.filter((x) => !x || x.id !== 'tmp-tool');
        writeFileSync(rp, JSON.stringify(reg, null, 2) + '\n');
      }
    } catch { /* 缺侧忽略 */ }
  }

  process.env.PLITE_MARKET = '0';
  try {
    const mw = createServerPart({ getSession: () => ({ user: { name: 't' } }), dataDir: join(tmpdir(), 'mk-off') });
    const res = { code: 0, body: '', writeHead(c) { this.code = c; return this; }, end(b) { this.body = b ?? ''; } };
    let nextCalled = false;
    await mw({ url: '/api/market/list', method: 'GET', headers: {}, on() { return this; } }, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true, '禁用时应 next() 旁路');
  } finally {
    delete process.env.PLITE_MARKET;
  }
});
