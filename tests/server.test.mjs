/**
 * 服务端集成测试：鉴权、供应商 API、中继门禁、静态服务安全。
 *
 * 每个用例起一个独立的 createProdServer（独立临时 dataDir / dist），
 * 因此限速计数、会话表、供应商存储互不干扰。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProdServer } from '../server/prod-server.mjs';

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'plite-'));
  const dist = join(root, 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>shell</title>');
  writeFileSync(join(root, 'secret.txt'), 'TOP_SECRET_SHOULD_NOT_LEAK');
  return { root, dist, dataDir: join(root, 'data') };
}

async function startHost(t, { dist, dataDir }) {
  const server = createProdServer({ dist, dataDir });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  /** 带 cookie 记忆的简易客户端 */
  const client = () => {
    let cookie = '';
    const send = async (path, { method = 'GET', body, raw } = {}) => {
      const res = await fetch(base + path, {
        method,
        headers: {
          ...(cookie ? { cookie } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
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
      return { status: res.status, text, json };
    };
    return { send, cookie: () => cookie };
  };

  return { base, port, client, dist, dataDir };
}

/** 绕过 fetch 的路径归一化，直接发原始请求行（路径穿越测试用） */
function rawGet(port, path) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const md5 = (s) => createHash('md5').update(s).digest('hex');

// ---------------------------------------------------------------- 静态服务

test('静态服务：路径穿越不越出 dist，SPA fallback 正常', async (t) => {
  const env = tempRoot();
  const { port } = await startHost(t, env);

  const root = await rawGet(port, '/');
  assert.equal(root.status, 200);
  assert.match(root.body, /shell/);

  for (const evil of ['/%2e%2e/secret.txt', '/..%2fsecret.txt', '/plugins/../../secret.txt']) {
    const res = await rawGet(port, evil);
    assert.equal(res.status, 200, `${evil} 应回落到 index.html`);
    assert.doesNotMatch(res.body, /TOP_SECRET/, `${evil} 泄露了 dist 之外的文件`);
  }
});

test('健康检查可用', async (t) => {
  const env = tempRoot();
  const { port } = await startHost(t, env);
  const res = await rawGet(port, '/healthz');
  assert.equal(res.status, 200);
  assert.match(res.body, /"ok":true/);
});

// ---------------------------------------------------------------- 鉴权

test('未登录访问受保护接口一律 401', async (t) => {
  const { client } = await startHost(t, tempRoot());
  const c = client();
  for (const [path, body] of [
    ['/api/providers/list', undefined],
    ['/api/providers/save', { config: { id: 'x' } }],
    ['/api/model-relay', { providerId: 'x', body: {} }],
  ]) {
    const res = await c.send(path, { method: body === undefined ? 'GET' : 'POST', body });
    assert.equal(res.status, 401, `${path} 应要求登录`);
    assert.equal(res.json.error?.code ?? res.json.code, 'SESSION_REQUIRED');
  }
});

test('畸形 JSON 返回 400 而不是挂死连接', async (t) => {
  const { client } = await startHost(t, tempRoot());
  const res = await client().send('/api/auth/login', { method: 'POST', raw: '{"username":' });
  assert.equal(res.status, 400);
  assert.equal(res.json.error.code, 'BAD_JSON');
});

test('超大请求体返回 413', async (t) => {
  const { client } = await startHost(t, tempRoot());
  const huge = JSON.stringify({ username: 'a', password: 'x'.repeat(200 * 1024) });
  const res = await client().send('/api/auth/login', { method: 'POST', raw: huge }).catch((e) => ({ status: 413, json: { error: { code: 'BODY_TOO_LARGE' } }, err: e }));
  assert.ok(res.status === 413 || res.status === 400, `期望 413/400，实际 ${res.status}`);
});

test('首登注册 + 登录态可用，密码以 scrypt 落盘且不含明文', async (t) => {
  const env = tempRoot();
  const { client } = await startHost(t, env);
  const c = client();

  const login = await c.send('/api/auth/login', { method: 'POST', body: { username: 'boss', password: 'secret123' } });
  assert.equal(login.status, 200);
  assert.equal(login.json.status, 'authenticated');
  assert.match(c.cookie(), /plite\.sid=/);

  const status = await c.send('/api/auth/status');
  assert.equal(status.json.status, 'authenticated');
  assert.equal(status.json.user.name, 'boss');

  const ownerFile = join(env.dataDir, 'auth-owner.json');
  assert.ok(existsSync(ownerFile));
  const owner = JSON.parse(readFileSync(ownerFile, 'utf8'));
  assert.equal(owner.algo, 'scrypt');
  assert.doesNotMatch(JSON.stringify(owner), /secret123/);
  assert.equal(owner.passwordHash.length, 128); // 64 字节 hex

  const list = await c.send('/api/providers/list');
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.configs, []);
});

test('历史 sha256(salt+md5) 凭据登录成功后自动升级为 scrypt', async (t) => {
  const env = tempRoot();
  mkdirSync(env.dataDir, { recursive: true });
  const salt = 'aabbccddeeff0011';
  writeFileSync(join(env.dataDir, 'auth-owner.json'), JSON.stringify({
    username: 'legacy',
    salt,
    passwordHash: sha256(salt + md5('oldpass')),
    registeredAt: Date.now(),
  }));

  const { client } = await startHost(t, env);
  const login = await client().send('/api/auth/login', { method: 'POST', body: { username: 'legacy', password: 'oldpass' } });
  assert.equal(login.status, 200);
  const owner = JSON.parse(readFileSync(join(env.dataDir, 'auth-owner.json'), 'utf8'));
  assert.equal(owner.algo, 'scrypt');
});

test('修改凭据：旧密码错误拒绝，成功后旧会话失效', async (t) => {
  const { client } = await startHost(t, tempRoot());
  const c = client();
  await c.send('/api/auth/login', { method: 'POST', body: { username: 'boss', password: 'secret123' } });

  const bad = await c.send('/api/auth/change-credentials', {
    method: 'POST',
    body: { newUsername: 'boss', oldPassword: 'wrong', newPassword: 'next123' },
  });
  assert.equal(bad.status, 401);

  const ok = await c.send('/api/auth/change-credentials', {
    method: 'POST',
    body: { newUsername: 'boss', oldPassword: 'secret123', newPassword: 'next123' },
  });
  assert.equal(ok.status, 200);

  const status = await c.send('/api/auth/status');
  assert.equal(status.json.status, 'unauthenticated', '改密后旧会话必须失效');
});

test('登录失败限速：连续 5 次后锁定', async (t) => {
  const { client } = await startHost(t, tempRoot());
  const c = client();
  await c.send('/api/auth/login', { method: 'POST', body: { username: 'boss', password: 'secret123' } });

  for (let i = 0; i < 5; i += 1) {
    const res = await c.send('/api/auth/login', { method: 'POST', body: { username: 'boss', password: 'bad-pass' } });
    assert.equal(res.status, 401);
  }
  const locked = await c.send('/api/auth/login', { method: 'POST', body: { username: 'boss', password: 'secret123' } });
  assert.equal(locked.status, 429);
  assert.equal(locked.json.error.code, 'AUTH_RATE_LIMITED');
});

// ---------------------------------------------------------------- 供应商

test('供应商保存：拒绝非 https / 私有地址 / 非白名单；响应只回掩码', async (t) => {
  const { client } = await startHost(t, tempRoot());
  const c = client();
  await c.send('/api/auth/login', { method: 'POST', body: { username: 'boss', password: 'secret123' } });

  const cases = [
    { baseURL: 'http://api.openai.com/v1', expect: /https/ },
    { baseURL: 'https://127.0.0.1/v1', expect: /private upstream/ },
    { baseURL: 'https://169.254.169.254/latest', expect: /private upstream/ },
    { baseURL: 'https://evil.example.com/v1', expect: /host not allowed/ },
  ];
  for (const { baseURL, expect } of cases) {
    const res = await c.send('/api/providers/save', { method: 'POST', body: { config: { id: 'p1', name: 'p', baseURL, apiKey: 'sk-test-1234567890' } } });
    assert.equal(res.status, 400, `${baseURL} 应被拒绝`);
    assert.match(res.json.error.message, expect);
  }

  const okRes = await c.send('/api/providers/save', {
    method: 'POST',
    body: {
      config: {
        id: 'p1', name: 'OpenAI', baseURL: 'https://api.openai.com/v1', apiKey: 'sk-test-1234567890',
        models: [{ id: 'gpt-4o-mini' }], activeModel: 'gpt-4o-mini', enabled: true,
      },
    },
  });
  assert.equal(okRes.status, 200);
  const saved = okRes.json.configs[0];
  assert.equal(saved.hasKey, true);
  assert.doesNotMatch(okRes.text, /sk-test-1234567890/, '响应体不得包含明文 key');
  assert.equal(saved.keyMasked, 'sk-***7890');

  // 留空 apiKey 表示保持原值
  const keep = await c.send('/api/providers/save', {
    method: 'POST',
    body: { config: { id: 'p1', name: 'OpenAI-renamed', baseURL: 'https://api.openai.com/v1', apiKey: '' } },
  });
  assert.equal(keep.status, 200);
  assert.equal(keep.json.configs[0].hasKey, true);
  assert.equal(keep.json.configs[0].keyMasked, 'sk-***7890');
});

test('中继：未知 provider 拒绝；指向内网地址的 provider 被 SSRF 策略拦截', async (t) => {
  const env = tempRoot();
  const { client } = await startHost(t, env);
  const c = client();
  await c.send('/api/auth/login', { method: 'POST', body: { username: 'boss', password: 'secret123' } });

  const unknown = await c.send('/api/model-relay', { method: 'POST', body: { providerId: 'nope', body: {} } });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.json.code, 'PROVIDER_NOT_FOUND');

  // 绕过 API 校验，直接把危险地址写进存储：中继必须在转发前再校验一次
  mkdirSync(env.dataDir, { recursive: true });
  writeFileSync(join(env.dataDir, 'providers.json'), JSON.stringify({
    providers: [{ id: 'meta', name: 'meta', baseURL: 'https://169.254.169.254/latest', apiKey: 'k', models: [], activeModel: '', enabled: true }],
  }));
  const blocked = await c.send('/api/model-relay', { method: 'POST', body: { providerId: 'meta', body: {} } });
  assert.equal(blocked.status, 400);
  assert.equal(blocked.json.code, 'UPSTREAM_NOT_ALLOWED');
  assert.match(blocked.json.error, /private upstream/);
});
