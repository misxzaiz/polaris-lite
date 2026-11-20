/** agent-files server.mjs 逻辑冒烟（临时；node test/server-smoke.mjs） */
import { createServerPart } from '../../plugins/agent-files/server.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'agent-files-'));
const handler = createServerPart({ dataDir, getSession: () => ({ user: { name: 'tester' } }) });

function makeReq(method, url, bodyObj) {
  const data = bodyObj ? JSON.stringify(bodyObj) : '';
  return {
    url, method, headers: {}, socket: { remoteAddress: '127.0.0.1' },
    on(ev, cb) { if (ev === 'data') setImmediate(() => cb(data)); if (ev === 'end') setImmediate(() => cb()); },
  };
}

async function call(action, args) {
  let resolveRes;
  const done = new Promise((r) => { resolveRes = r; });
  const res = {
    _code: 0,
    writeHead(code) { this._code = code; },
    end(b) { resolveRes({ status: this._code, json: JSON.parse(b || '{}') }); },
  };
  await handler(makeReq('POST', '/api/files-write/exec', { action, sessionId: 's1', ...args }), res, () => {});
  return done;
}

const ws = join(dataDir, 'workspace');

// 1. write 新文件（建父目录）
let r = await call('write', { path: join(ws, 'sub/hello.txt'), content: 'hello\nworld\n' });
assert.equal(r.status, 200, JSON.stringify(r));
assert.equal(r.json.ok, true);
assert.equal(r.json.eol, 'LF');

// 2. write 已存在 CRLF 文件 → 行尾保持
r = await call('write', { path: join(ws, 'crlf.txt'), content: 'a\r\nb\r\n' });
assert.equal(r.json.eol, 'LF', '首次写入按内容自身行尾（LF 内容 → LF）');
r = await call('write', { path: join(ws, 'crlf.txt'), content: 'a\nb\n' });
assert.equal(r.json.eol, 'CRLF', '二次写入应保持文件既有 CRLF');
assert.equal(readFileSync(join(ws, 'crlf.txt'), 'utf8'), 'a\r\nb\r\n');

// 3. edit 唯一替换
r = await call('edit', { path: join(ws, 'sub/hello.txt'), old_string: 'world', new_string: 'polaris' });
assert.equal(r.json.ok, true);
assert.equal(readFileSync(join(ws, 'sub/hello.txt'), 'utf8'), 'hello\npolaris\n');

// 4. edit 多命中歧义（crlf.txt 现为 'A\r\nb\r\n'——首字符 A 唯一，改用行内多命中串）
r = await call('edit', { path: join(ws, 'sub/hello.txt'), old_string: 'l', new_string: 'L' });
assert.equal(r.json.code, 'AMBIGUOUS', JSON.stringify(r));

// 5. edit expected_replacements 全替换（hello/polaris 里 l 出现 3 次）
r = await call('edit', { path: join(ws, 'sub/hello.txt'), old_string: 'l', new_string: 'L', expected_replacements: 3 });
assert.equal(r.json.ok, true, JSON.stringify(r));

// 6. edit 0 命中给提示
r = await call('edit', { path: join(ws, 'sub/hello.txt'), old_string: 'helo', new_string: 'x' });
assert.equal(r.json.code, 'NOT_MATCHED');
assert.ok(r.json.error.includes('Closest line') || r.json.error.includes('not found'));

// 7. patch update 锚点（此刻文件内容为 heLLo\npoLaris\n）
r = await call('patch', { patch: '*** Begin Patch\n*** Update File: ' + join(ws, 'sub/hello.txt') + '\n@@\n heLLo\n-poLaris\n+POLARIS\n*** End Patch' });
assert.equal(r.json.ok, true, JSON.stringify(r));
assert.ok(readFileSync(join(ws, 'sub/hello.txt'), 'utf8').includes('POLARIS'));

// 8. patch add + delete
r = await call('patch', { patch: '*** Begin Patch\n*** Add File: ' + join(ws, 'new.txt') + '\n+added\n*** Delete File: ' + join(ws, 'crlf.txt') + '\n*** End Patch' });
assert.equal(r.json.ok, true, JSON.stringify(r));
assert.ok(readFileSync(join(ws, 'new.txt'), 'utf8').includes('added'));
assert.throws(() => readFileSync(join(ws, 'crlf.txt'), 'utf8'));

// 9. 越界拒绝（写面不提供漫游）
r = await call('write', { path: 'D:/space/base/Polaris/evil.txt', content: 'x' });
assert.equal(r.status, 403, JSON.stringify(r));
assert.equal(r.json.code, 'PATH_ESCAPE');

// 10. 二进制拒写
r = await call('write', { path: join(ws, 'x.exe'), content: 'MZ' });
assert.equal(r.json.code, 'BINARY_DENIED');

// 11. 未知动作
r = await call('wat', {});
assert.equal(r.json.code, 'BAD_ACTION');

// 12. 未认证 401
{
  let resolveRes;
  const done = new Promise((r2) => { resolveRes = r2; });
  const res = { _code: 0, writeHead(c) { this._code = c; }, end(b) { resolveRes({ status: this._code, json: JSON.parse(b || '{}') }); } };
  const noAuth = createServerPart({ dataDir, getSession: () => null });
  await noAuth(makeReq('POST', '/api/files-write/exec', { action: 'write', path: 'x.txt', content: 'y' }), res, () => {});
  const rr = await done;
  assert.equal(rr.status, 401);
}

rmSync(dataDir, { recursive: true, force: true });
console.log('agent-files server smoke: ALL PASS');
