/**
 * /api/fs/grep 端点测试：根内检索、跳过依赖/产物/二进制/超大文件、glob 过滤、
 * 非法正则降级字面量、子目录限定、maxResults 截断与门禁。
 *
 * 沿用 agent-bash.test.mjs 的中间件直调模式（不起真 HTTP 服务）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerPart } from '../plugins/file-browser/server.mjs';

/** 搭一个临时仓库形目录树 + 中间件直调器 */
function grepEnv() {
  const root = mkdtempSync(join(tmpdir(), 'fsgrep-'));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const src = join(root, 'repo', 'src');
  const deep = join(src, 'deep');
  mkdirSync(deep, { recursive: true });
  mkdirSync(join(root, 'repo', 'node_modules'), { recursive: true });
  mkdirSync(join(root, 'repo', 'dist'), { recursive: true });

  writeFileSync(join(src, 'a.mjs'), 'const a = "hello world";\nconst b = "HELLO WORLD";\nconst c = "(hello" ;\n');
  writeFileSync(join(deep, 'b.ts'), 'export const hi = "hello world";\n');
  writeFileSync(join(root, 'repo', 'node_modules', 'c.js'), 'const noise = "hello world";\n');
  writeFileSync(join(root, 'repo', 'dist', 'd.mjs'), 'const noise = "hello world";\n');
  writeFileSync(join(root, 'repo', 'notes.me'), 'const noise = "hello world";\n'); // 未知扩展名按文本扫描
  // 二进制启发：头部含 NUL
  writeFileSync(join(src, 'bin.dat'), Buffer.concat([Buffer.from([0x00, 0x01, 0x02]), Buffer.from('hello world\n')]));
  // 超过 1MB 的大文件（含命中也不读）
  writeFileSync(join(src, 'big.log'), 'x'.repeat(1024 * 1024 + 16) + '\nhello world\n');

  writeFileSync(join(dataDir, 'workspace-roots.json'), JSON.stringify({ roots: [{ id: 'r-t', path: join(root, 'repo') }] }));

  const mw = createServerPart({
    dataDir,
    getSession: () => ({ user: { name: 'tester' } }),
    verifyTempToken: () => false,
  });
  const call = (body, method = 'POST') => new Promise((doneResolve) => {
    const chunks = method === 'POST' ? [Buffer.from(JSON.stringify(body))] : [];
    const res = {
      code: 0, body: '',
      writeHead(c) { this.code = c; return this; },
      end(b) { this.body = b ?? ''; doneResolve({ status: this.code, body: this.body }); },
      on() { return this; },
    };
    mw(
      {
        url: '/api/fs/grep', method, headers: {}, socket: {},
        on(ev, cb) { if (ev === 'data' && chunks.length) cb(chunks.shift()); if (ev === 'end') cb(); return this; },
      },
      res,
      () => {},
    );
  });
  const parse = (r) => JSON.parse(r.body);
  return { root, repo: join(root, 'repo'), dataDir, call, parse };
}

test('grep: 基本命中——跳过 node_modules/dist/二进制/超大文件', async () => {
  const env = grepEnv();
  const r = await env.call({ rootId: 'r-t', pattern: 'hello', ignoreCase: true });
  assert.equal(r.status, 200);
  const j = env.parse(r);
  assert.equal(j.ok, true);
  const paths = j.matches.map((m) => m.path);
  assert.ok(paths.includes('src/a.mjs'), 'src/a.mjs 命中');
  assert.ok(paths.includes('src/deep/b.ts'), 'src/deep/b.ts 命中');
  assert.ok(!paths.some((p) => p.includes('node_modules')), '跳过 node_modules');
  assert.ok(!paths.some((p) => p.startsWith('dist/')), '跳过 dist');
  assert.ok(!paths.includes('src/bin.dat'), '跳过二进制');
  assert.ok(!paths.includes('src/big.log'), '跳过超大文件');
  assert.ok(paths.includes('notes.me'), '未知扩展名按文本扫描');
  assert.ok(j.scanned >= 3);
  assert.ok(j.durationMs < 8000);
});

test('grep: glob 过滤 + 大小写敏感默认', async () => {
  const env = grepEnv();
  const r = await env.call({ rootId: 'r-t', pattern: 'HELLO', glob: '*.ts' });
  const j = env.parse(r);
  assert.equal(j.matches.length, 0, '大小写敏感 + glob *.ts 下 a.mjs 的大写命中不算，b.ts 只有 hello');
  const r2 = await env.call({ rootId: 'r-t', pattern: 'hello', glob: '*.mjs', ignoreCase: true });
  const j2 = env.parse(r2);
  assert.ok(j2.matches.every((m) => m.path.endsWith('.mjs')), 'glob 限定 mjs');
  assert.ok(j2.matches.length >= 1);
});

test('grep: 非法正则降级字面量', async () => {
  const env = grepEnv();
  const r = await env.call({ rootId: 'r-t', pattern: '(hello' });
  const j = env.parse(r);
  assert.equal(j.ok, true);
  assert.equal(j.matches.length, 1);
  assert.equal(j.matches[0].path, 'src/a.mjs');
  assert.ok(j.matches[0].text.includes('(hello'));
});

test('grep: 子目录限定 + maxResults 截断', async () => {
  const env = grepEnv();
  const r = await env.call({ rootId: 'r-t', pattern: 'hello', path: 'src/deep', ignoreCase: true });
  const j = env.parse(r);
  assert.equal(j.matches.length, 1);
  // 路径相对扫描基点（限定子目录时以子目录为根）
  assert.equal(j.matches[0].path, 'b.ts');

  const r2 = await env.call({ rootId: 'r-t', pattern: 'hello', ignoreCase: true, maxResults: 1 });
  const j2 = env.parse(r2);
  assert.equal(j2.matches.length, 1);
  assert.equal(j2.truncated, true);
  assert.ok(j2.totalMatches >= j2.matches.length);
});

test('grep: 门禁——未知根 400、无会话 401、GET 404', async () => {
  const env = grepEnv();
  const r = await env.call({ rootId: 'r-none', pattern: 'x' });
  assert.equal(r.status, 400);
  const root2 = mkdtempSync(join(tmpdir(), 'fsgrep2-'));
  const mw = createServerPart({ dataDir: join(root2, 'd'), getSession: () => null, verifyTempToken: () => false });
  const res = { code: 0, body: '', writeHead(c) { this.code = c; return this; }, end(b) { this.body = b ?? ''; }, on() { return this; } };
  await mw({ url: '/api/fs/grep', method: 'POST', headers: {}, socket: {}, on(ev, cb) { if (ev === 'data') cb(Buffer.from('{}')); if (ev === 'end') cb(); return this; } }, res, () => {});
  assert.equal(res.code, 401);
  const env2 = grepEnv();
  const rGet = await env2.call({ rootId: 'r-t' }, 'GET');
  assert.equal(rGet.status, 404);
});
