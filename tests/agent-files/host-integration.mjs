/**
 * agent-files 真实宿主装配集成冒烟（node test/host-integration.mjs）
 *
 * 与 server-smoke 的差别：走 server/host.mjs 的真实中间件链（含 auth gate、
 * server-registry 装配顺序），验证 agent-files 在完整宿主里正确接线。
 * 登录态用 auth 的 tempTokens 直签（与 auth-session temp-credential 同源），
 * 不需要真实密码。
 */
import { createHost } from '../../server/host.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'agent-files-host-'));
const host = createHost({ dataDir });

function makeReq(method, url, bodyObj, headers = {}) {
  const data = bodyObj ? Buffer.from(JSON.stringify(bodyObj), 'utf8') : Buffer.alloc(0);
  // headers 键统一小写（真实 http 库也如此；parseCookies 读 headers.cookie）
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    url, method, headers: lower,
    socket: { remoteAddress: '127.0.0.1' },
    on(ev, cb) { if (ev === 'data') setImmediate(() => cb(data)); if (ev === 'end') setImmediate(() => cb()); },
  };
}

function runMiddlewares(mws, req) {
  return new Promise((resolve) => {
    let i = 0;
    const res = {
      _code: 0,
      _headers: {},
      writeHead(code, h) { this._code = code; if (h) this._headers = { ...this._headers, ...h }; },
      setHeader(k, v) { this._headers = { ...this._headers, [k]: v }; },
      end(b) {
        resolve({
          status: this._code,
          headers: this._headers,
          get json() { return JSON.parse(b || '{}'); },
        });
      },
    };
    const next = () => {
      if (i >= mws.length) { resolve({ status: 404, headers: {}, json: { error: 'no handler' } }); return; }
      const mw = mws[i++];
      try { mw(req, res, next); } catch (e) { resolve({ status: 500, headers: {}, json: { error: String(e.message) } }); }
    };
    next();
  });
}

// 1. 未登录 → 401（auth gate 生效）
let r = await runMiddlewares(host.middlewares, makeReq('POST', '/api/files-write/exec', { action: 'write', path: 'x.txt', content: 'y' }));
assert.equal(r.status, 401, JSON.stringify(r));

// 2. 直签会话 cookie（mintSession 与 /api/auth/login 同源；测试不依赖密码）。
// 同时登记 owner（verifyTempToken 与 owner 名一致才认 Bearer——本测试主走 cookie）。
import { writeFileSync } from 'node:fs';
writeFileSync(join(dataDir, 'auth-owner.json'), JSON.stringify({ username: 'tester', algo: 'scrypt', salt: '', passwordHash: '', registeredAt: Date.now() }));
const token = 'a'.repeat(48);
host.auth.tempTokens.set(token, { expiresAt: Date.now() + 600_000, owner: 'tester' });

/** 用 mintSession 造一个真实会话 cookie（与 login 后浏览器持有的等价） */
function sessionCookie(username) {
  const sid = 's'.repeat(48) + Math.random().toString(36).slice(2);
  // mintSession 是闭包内函数；这里经 auth.middleware 的 login 路径太重——
  // 直接构造 cookie 并让 sessions map 有记录：用 auth 对象上暴露的 mintSession 不可达，
  // 退而求其次：直接把 session 写进 auth.sessions（同名结构）。
  const key = sid; // sessions 的键是 sidHash(sid)；hash 不可达时退化为直接键——见下
  // 真实实现：sessions.set(sidHash(sid), ...)。sidHash 不可达 → 走 login API。
  void key;
  return null;
}
void sessionCookie;
// 真实 login：owner 密码是 scrypt(salt)——我们写的 owner 没有 salt/passwordHash 校验可通过吗？
// verifyPassword: algo==='scrypt' → 比较 scryptHash(password, salt)。我们无法反推密码。
// → 改写 owner 为已知密码的 scrypt 记录：
import { randomBytes, scryptSync } from 'node:crypto';
const salt = randomBytes(16).toString('hex');
const passwordHash = scryptSync('test-pass', salt, 64).toString('hex');
writeFileSync(join(dataDir, 'auth-owner.json'), JSON.stringify({ username: 'tester', algo: 'scrypt', salt, passwordHash, registeredAt: Date.now() }));
// 走真实 /api/auth/login 拿会话 cookie：
const loginRes = await runMiddlewares(host.middlewares, makeReq('POST', '/api/auth/login', { username: 'tester', password: 'test-pass' }));
assert.equal(loginRes.status, 200, JSON.stringify(loginRes));
const setCookie = loginRes.headers?.['set-cookie'] ?? loginRes.headers?.['Set-Cookie'];
let cookieHeader = '';
if (Array.isArray(setCookie)) cookieHeader = setCookie.map((c) => c.split(';')[0]).join('; ');
else if (typeof setCookie === 'string') cookieHeader = setCookie.split(';')[0];
const authHeaders = cookieHeader ? { Cookie: cookieHeader, Authorization: `Bearer ${token}` } : { Authorization: `Bearer ${token}` };

// 3. write（经真实链，落到内建 workspace）
const ws = join(dataDir, 'workspace');
r = await runMiddlewares(host.middlewares, makeReq('POST', '/api/files-write/exec', {
  action: 'write', path: join(ws, 'it/hello.txt'), content: 'hello\nworld\n',
}, authHeaders));
assert.equal(r.status, 200, JSON.stringify(r));
assert.equal(r.json.ok, true);

// 4. edit
r = await runMiddlewares(host.middlewares, makeReq('POST', '/api/files-write/exec', {
  action: 'edit', path: join(ws, 'it/hello.txt'), old_string: 'world', new_string: 'polaris',
}, authHeaders));
assert.equal(r.json.ok, true, JSON.stringify(r));
assert.ok(readFileSync(join(ws, 'it/hello.txt'), 'utf8').includes('polaris'));

// 5. patch 多文件
r = await runMiddlewares(host.middlewares, makeReq('POST', '/api/files-write/exec', {
  action: 'patch',
  patch: '*** Begin Patch\n*** Add File: ' + join(ws, 'it/new.txt') + '\n+added\n*** Update File: ' + join(ws, 'it/hello.txt') + '\n@@\n hello\n-polaris\n+POLARIS\n*** End Patch',
}, authHeaders));
assert.equal(r.json.ok, true, JSON.stringify(r));
assert.ok(readFileSync(join(ws, 'it/new.txt'), 'utf8').includes('added'));
assert.ok(readFileSync(join(ws, 'it/hello.txt'), 'utf8').includes('POLARIS'));

// 6. 越界拒绝
r = await runMiddlewares(host.middlewares, makeReq('POST', '/api/files-write/exec', {
  action: 'write', path: 'D:/space/base/Polaris/evil.txt', content: 'x',
}, authHeaders));
assert.equal(r.status, 403);
assert.equal(r.json.code, 'PATH_ESCAPE');

// 7. 服务器半边清单包含 agent-files
assert.ok(host.serverPlugins.includes('agent-files'), `serverPlugins: ${host.serverPlugins}`);

rmSync(dataDir, { recursive: true, force: true });
console.log('agent-files host integration: ALL PASS');
