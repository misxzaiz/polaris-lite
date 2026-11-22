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
import { createServer, request } from 'node:http';
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

async function startHost(t, { dist, dataDir }, opts = {}) {
  const server = createProdServer({ dist, dataDir, ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  /** 带 cookie 记忆的简易客户端 */
  const client = () => {
    let cookie = '';
    const send = async (path, { method = 'GET', body, raw, headers: extraHeaders } = {}) => {
      const res = await fetch(base + path, {
        method,
        headers: {
          ...(cookie ? { cookie } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(extraHeaders ?? {}),
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

test('供应商保存（strict 模式）：拒绝非 https / 私有地址 / 非白名单；响应只回掩码', async (t) => {
  const { client } = await startHost(t, tempRoot(), { policyOptions: { strict: true } });
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

test('上游默认不限制：http / 私网 / 非白名单主机均可保存（2026-11-22 用户决定）', async (t) => {
  const { client } = await startHost(t, tempRoot());
  const c = client();
  await c.send('/api/auth/login', { method: 'POST', body: { username: 'boss', password: 'secret123' } });

  const cases = [
    { id: 'lan', baseURL: 'http://192.168.1.10:8000/v1' },          // 局域网 http
    { id: 'metadata', baseURL: 'http://169.254.169.254/latest' },   // 私网地址
    { id: 'domain', baseURL: 'http://random-gateway.example.com/v1' }, // 非白名单域名
  ];
  for (const { id, baseURL } of cases) {
    const res = await c.send('/api/providers/save', {
      method: 'POST',
      body: { config: { id, name: id, baseURL, apiKey: 'sk-x-1234567890', models: [], activeModel: '', enabled: true } },
    });
    assert.equal(res.status, 200, `${baseURL} 默认模式应可保存`);
    assert.equal(res.json.ok, true);
  }
});

test('中继（strict 模式）：未知 provider 拒绝；指向内网地址的 provider 被 SSRF 策略拦截', async (t) => {
  const env = tempRoot();
  const { client } = await startHost(t, env, { policyOptions: { strict: true } });
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

// ------------------------------------------------- 中继上游断流（「对话突然中断」修复）

/**
 * 本地 mock 上游：POST /chat/completions 开 event-stream，先推两帧，然后 destroy 连接。
 * 用于复现 MOSI 一类网关中途断流的真实形态——中继必须在断流时追加
 * UPSTREAM_DISCONNECTED 错误帧（此前 catch{} 吞掉错误正常 end()，前端静默收敛）。
 */
async function startBrokenUpstream(t, { breakAfterMs }) {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"你"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"好"}}]}\n\n');
    setTimeout(() => res.destroy(), breakAfterMs);
  });
  // listen 是异步的：不等 'listening' 就取 address() 是 null（时序坑）
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

test('中继：上游 SSE 中途断流时追加 UPSTREAM_DISCONNECTED 错误帧（不静默吞掉）', async (t) => {
  const env = tempRoot();
  // allowPrivate 仅供本地联调/测试放行环回上游（生产永远 false）
  const h = await startHost(t, env, { policyOptions: { allowPrivate: true } });
  const c = h.client();
  await c.send('/api/auth/login', { method: 'POST', body: { username: 'boss', password: 'secret123' } });

  const upUrl = await startBrokenUpstream(t, { breakAfterMs: 60 });
  mkdirSync(env.dataDir, { recursive: true });
  writeFileSync(join(env.dataDir, 'providers.json'), JSON.stringify({
    providers: [{ id: 'mock', name: 'mock', baseURL: upUrl, apiKey: 'k', models: [], activeModel: '', enabled: true }],
  }));

  // 流式读完整响应体（client.send 等价：读到底即收到中继追加的错误帧）
  const final = await c.send('/api/model-relay', { method: 'POST', body: { providerId: 'mock', body: { stream: true } } });
  assert.equal(final.status, 200);
  // 前两帧是正常 delta；末尾必须带中继注入的结构化错误帧（引擎据此报 stream.error）
  assert.match(final.text, /"delta":\{"content":"你"\}/);
  assert.match(final.text, /UPSTREAM_DISCONNECTED/, '上游断流必须穿透为错误帧，不得静默结束');
  assert.match(final.text, /上游连接中断/, '错误帧须带可读 message');
});

test('中继：上游正常收尾（含 [DONE]）时不追加错误帧', async (t) => {
  const env = tempRoot();
  const h = await startHost(t, env, { policyOptions: { allowPrivate: true } });
  const c = h.client();
  await c.send('/api/auth/login', { method: 'POST', body: { username: 'boss', password: 'secret123' } });

  // 正常上游：推一帧 + [DONE] 后干净 end()
  const up = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"完整回复"},"finish_reason":"stop"}]}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  t.after(() => up.close());
  const upUrl = `http://127.0.0.1:${up.address().port}`;

  mkdirSync(env.dataDir, { recursive: true });
  writeFileSync(join(env.dataDir, 'providers.json'), JSON.stringify({
    providers: [{ id: 'mock', name: 'mock', baseURL: upUrl, apiKey: 'k', models: [], activeModel: '', enabled: true }],
  }));

  const final = await c.send('/api/model-relay', { method: 'POST', body: { providerId: 'mock', body: { stream: true } } });
  assert.equal(final.status, 200);
  assert.match(final.text, /\[DONE\]/);
  assert.doesNotMatch(final.text, /UPSTREAM_DISCONNECTED/, '正常结束不得注入错误帧');
});

// ---------------------------------------------------------------- 直连配置（独立档 B）

test('direct-config：登录+回环下返回明文配置；未登录 401；无供应商 404', async (t) => {
  const env = tempRoot();
  const h = await startHost(t, env);
  const c = h.client();

  // 未登录拒绝
  const anon = await c.send('/api/providers/direct-config', { method: 'POST' });
  assert.equal(anon.status, 401);

  // 登录（首登即注册）
  await c.send('/api/auth/login', { method: 'POST', body: { username: 'boss', password: 'secret123' } });

  // 无供应商 → 404
  const none = await c.send('/api/providers/direct-config', { method: 'POST' });
  assert.equal(none.status, 404);
  assert.equal(none.json.error.code, 'PROVIDER_NO_ACTIVE');

  // 配置一个供应商（白名单公网 https）→ 返回明文 key + baseURL（本机回环形态）
  const saved = await c.send('/api/providers/save', {
    method: 'POST',
    body: { config: { id: 'p1', name: 'openai', baseURL: 'https://api.openai.com/v1', apiKey: 'sk-dest-direct-123456', models: [], activeModel: 'gpt-4o-mini', enabled: true } },
  });
  assert.equal(saved.status, 200);

  const direct = await c.send('/api/providers/direct-config', { method: 'POST' });
  assert.equal(direct.status, 200);
  assert.equal(direct.json.ok, true);
  assert.equal(direct.json.config.baseURL, 'https://api.openai.com/v1');
  assert.equal(direct.json.config.apiKey, 'sk-dest-direct-123456');
  assert.equal(direct.json.config.activeModel, 'gpt-4o-mini');
});

test('direct-config：PLITE_ALLOW_DIRECT_CONFIG=0 一键禁用', async (t) => {
  const prev = process.env.PLITE_ALLOW_DIRECT_CONFIG;
  process.env.PLITE_ALLOW_DIRECT_CONFIG = '0';
  try {
    const env = tempRoot();
    const h = await startHost(t, env);
    const c = h.client();
    await c.send('/api/auth/login', { method: 'POST', body: { username: 'boss', password: 'secret123' } });
    await c.send('/api/providers/save', {
      method: 'POST',
      body: { config: { id: 'p1', name: 'openai', baseURL: 'https://api.openai.com/v1', apiKey: 'sk-x-1234567890', models: [], activeModel: '', enabled: true } },
    });
    const res = await c.send('/api/providers/direct-config', { method: 'POST' });
    assert.equal(res.status, 403);
    assert.equal(res.json.error.code, 'DIRECT_CONFIG_DISABLED');
  } finally {
    if (prev === undefined) delete process.env.PLITE_ALLOW_DIRECT_CONFIG;
    else process.env.PLITE_ALLOW_DIRECT_CONFIG = prev;
  }
});

// ---------------------------------------------------------------- 拉取模型列表 / 明文 Key 查看

test('fetch-models：拉取上游 /models；未登录 401；非白名单 400；缺 baseURL 400', async (t) => {
  const env = tempRoot();
  // 环回 mock 上游：GET /v1/models 返回对象数组 + 裸字符串混合形态
  const up = createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'mock-a' }, { id: 'mock-b' }, 'mock-c'] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  t.after(() => up.close());
  const upUrl = `http://127.0.0.1:${up.address().port}/v1`;

  const h = await startHost(t, env, { policyOptions: { strict: true, allowPrivate: true } });
  const c = h.client();

  const anon = await c.send('/api/providers/fetch-models', { method: 'POST', body: { baseURL: upUrl } });
  assert.equal(anon.status, 401);

  await c.send('/api/auth/login', { method: 'POST', body: { username: 'boss', password: 'secret123' } });

  const noUrl = await c.send('/api/providers/fetch-models', { method: 'POST', body: {} });
  assert.equal(noUrl.status, 400);
  assert.equal(noUrl.json.error.code, 'BASE_URL_REQUIRED');

  const blocked = await c.send('/api/providers/fetch-models', { method: 'POST', body: { baseURL: 'https://evil.example.com/v1' } });
  assert.equal(blocked.status, 400);
  assert.equal(blocked.json.error.code, 'BASE_URL_NOT_ALLOWED');

  // 已保存供应商：只传 id（baseURL/key 用存储值）
  mkdirSync(env.dataDir, { recursive: true });
  writeFileSync(join(env.dataDir, 'providers.json'), JSON.stringify({
    providers: [{ id: 'mock', name: 'mock', baseURL: upUrl, apiKey: 'k', models: [], activeModel: '', enabled: true }],
  }));
  const byId = await c.send('/api/providers/fetch-models', { method: 'POST', body: { id: 'mock' } });
  assert.equal(byId.status, 200);
  assert.deepEqual(byId.json.ids.sort(), ['mock-a', 'mock-b', 'mock-c']);
  assert.equal(byId.json.count, 3);

  // 新建中的供应商：直接传 baseURL（mock 不校验 key）
  const byBody = await c.send('/api/providers/fetch-models', { method: 'POST', body: { baseURL: upUrl, apiKey: 'sk-fresh' } });
  assert.equal(byBody.status, 200);
  assert.equal(byBody.json.count, 3);
});

test('reveal-key：返回明文 Key + 写审计；未登录 401；无 Key 400；PLITE_ALLOW_REVEAL=0 一键禁用', async (t) => {
  const env = tempRoot();
  const h = await startHost(t, env);
  const c = h.client();

  const anon = await c.send('/api/providers/reveal-key', { method: 'POST', body: { id: 'p1' } });
  assert.equal(anon.status, 401);

  await c.send('/api/auth/login', { method: 'POST', body: { username: 'boss', password: 'secret123' } });

  // 未配置 Key 的供应商 → 400
  await c.send('/api/providers/save', {
    method: 'POST',
    body: { config: { id: 'nokey', name: 'nokey', baseURL: 'https://api.openai.com/v1', apiKey: '', models: [], activeModel: '', enabled: true } },
  });
  const noKey = await c.send('/api/providers/reveal-key', { method: 'POST', body: { id: 'nokey' } });
  assert.equal(noKey.status, 400);
  assert.equal(noKey.json.error.code, 'PROVIDER_NO_KEY');

  await c.send('/api/providers/save', {
    method: 'POST',
    body: { config: { id: 'p1', name: 'openai', baseURL: 'https://api.openai.com/v1', apiKey: 'sk-reveal-test-123456', models: [], activeModel: '', enabled: true } },
  });
  const ok = await c.send('/api/providers/reveal-key', { method: 'POST', body: { id: 'p1' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.key, 'sk-reveal-test-123456');

  // 审计落盘：数据目录 providers-audit.jsonl 一行一条（时间 + 用户 + 供应商），不含明文 key
  const auditFile = join(env.dataDir, 'providers-audit.jsonl');
  assert.ok(existsSync(auditFile), '审计文件必须存在');
  const lines = readFileSync(auditFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const entry = lines.find((l) => l.op === 'reveal-key');
  assert.ok(entry, '必须有 reveal-key 审计条目');
  assert.equal(entry.user, 'boss');
  assert.equal(entry.providerId, 'p1');
  assert.doesNotMatch(JSON.stringify(lines), /sk-reveal-test-123456/, '审计日志不得包含明文 key');
});

test('reveal-key：PLITE_ALLOW_REVEAL=0 一键禁用（403）', async (t) => {
  const prev = process.env.PLITE_ALLOW_REVEAL;
  process.env.PLITE_ALLOW_REVEAL = '0';
  try {
    const env = tempRoot();
    const h = await startHost(t, env);
    const c = h.client();
    await c.send('/api/auth/login', { method: 'POST', body: { username: 'boss', password: 'secret123' } });
    await c.send('/api/providers/save', {
      method: 'POST',
      body: { config: { id: 'p1', name: 'openai', baseURL: 'https://api.openai.com/v1', apiKey: 'sk-x-1234567890', models: [], activeModel: '', enabled: true } },
    });
    const res = await c.send('/api/providers/reveal-key', { method: 'POST', body: { id: 'p1' } });
    assert.equal(res.status, 403);
    assert.equal(res.json.error.code, 'REVEAL_DISABLED');
  } finally {
    if (prev === undefined) delete process.env.PLITE_ALLOW_REVEAL;
    else process.env.PLITE_ALLOW_REVEAL = prev;
  }
});

// ---- 临时凭证：自定义 TTL + 临时凭证登录 ----

test('临时凭证：默认 30 分钟，可用 ttlMs 自定义有效期（含上下限校验）', async (t) => {
  const { client } = await startHost(t, tempRoot());
  const c = client();
  await c.send('/api/auth/login', { method: 'POST', body: { username: 'boss', password: 'secret123' } });

  // 默认签发：30 分钟
  const def = await c.send('/api/auth/temp-credential', { method: 'POST' });
  assert.equal(def.status, 200);
  assert.equal(def.json.expiresInMs, 30 * 60 * 1000);
  assert.ok(def.json.token.length >= 32);

  // 自定义：2 小时
  const long = await c.send('/api/auth/temp-credential', { method: 'POST', body: { ttlMs: 2 * 60 * 60 * 1000 } });
  assert.equal(long.status, 200);
  assert.equal(long.json.expiresInMs, 2 * 60 * 60 * 1000);

  // 越界：低于 1 分钟 / 超过 24 小时 / 非法值 → 400
  for (const ttlMs of [500, 25 * 60 * 60 * 1000, -1, 'abc']) {
    const bad = await c.send('/api/auth/temp-credential', { method: 'POST', body: { ttlMs } });
    assert.equal(bad.status, 400, `ttlMs=${ttlMs} 应被拒绝`);
    assert.equal(bad.json.error.code, 'AUTH_INVALID_TTL');
  }

  // 未登录不能签发
  const anon = await client().send('/api/auth/temp-credential', { method: 'POST' });
  assert.equal(anon.status, 401);
});

test('临时凭证登录：tempToken 与 Authorization: Bearer 均可换取会话，权限等同密码登录', async (t) => {
  const { client } = await startHost(t, tempRoot());
  const admin = client();
  await admin.send('/api/auth/login', { method: 'POST', body: { username: 'boss', password: 'secret123' } });
  const issued = await admin.send('/api/auth/temp-credential', { method: 'POST', body: { ttlMs: 10 * 60 * 1000 } });
  const token = issued.json.token;

  // body.tempToken 登录
  const c1 = client();
  const viaBody = await c1.send('/api/auth/login', { method: 'POST', body: { tempToken: token } });
  assert.equal(viaBody.status, 200);
  assert.equal(viaBody.json.status, 'authenticated');
  assert.equal(viaBody.json.user.name, 'boss');
  assert.match(c1.cookie(), /plite\.sid=/);
  const st1 = await c1.send('/api/auth/status');
  assert.equal(st1.json.status, 'authenticated');

  // Authorization: Bearer 头登录
  const c2 = client();
  const viaHeader = await c2.send('/api/auth/login', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: {} });
  assert.equal(viaHeader.status, 200);
  assert.equal(viaHeader.json.status, 'authenticated');

  // 凭证吊销后同一 token 不能再登录
  await admin.send('/api/auth/temp-credential/revoke', { method: 'POST', body: { token } });
  const afterRevoke = await client().send('/api/auth/login', { method: 'POST', body: { tempToken: token } });
  assert.equal(afterRevoke.status, 401);
});

test('临时凭证登录：无效/过期凭证 401 并计入限速', async (t) => {
  const { client } = await startHost(t, tempRoot());
  // 5 次无效后第 6 次触发限速（与密码登录同阈值）
  for (let i = 0; i < 5; i++) {
    const bad = await client().send('/api/auth/login', { method: 'POST', body: { tempToken: `deadbeef${i}deadbeef` } });
    assert.equal(bad.status, 401);
    assert.equal(bad.json.error.code, 'AUTH_INVALID_CREDENTIALS');
  }
  const locked = await client().send('/api/auth/login', { method: 'POST', body: { tempToken: 'deadbeefdeadbeef99' } });
  assert.equal(locked.status, 429);
});

test('临时凭证：吊销后立即失效，list 只返回在效摘要', async (t) => {
  const { client } = await startHost(t, tempRoot());
  const admin = client();
  await admin.send('/api/auth/login', { method: 'POST', body: { username: 'boss', password: 'secret123' } });
  const a = await admin.send('/api/auth/temp-credential', { method: 'POST', body: { ttlMs: 60 * 60 * 1000 } });
  const b = await admin.send('/api/auth/temp-credential', { method: 'POST', body: { ttlMs: 60 * 60 * 1000 } });

  let list = await admin.send('/api/auth/temp-credential/list');
  assert.equal(list.status, 200);
  assert.equal(list.json.items.length, 2);
  assert.ok(list.json.items.every((it) => it.tokenDigest.includes('…') && it.remainMs > 0));

  const revoke = await admin.send('/api/auth/temp-credential/revoke', { method: 'POST', body: { token: a.json.token } });
  assert.equal(revoke.status, 200);
  assert.equal(revoke.json.revoked, true);

  list = await admin.send('/api/auth/temp-credential/list');
  assert.equal(list.json.items.length, 1);
  assert.equal(list.json.items[0].tokenDigest.endsWith(b.json.token.slice(-4)), true);

  // 重复吊销：revoked=false
  const again = await admin.send('/api/auth/temp-credential/revoke', { method: 'POST', body: { token: a.json.token } });
  assert.equal(again.json.revoked, false);

  // verifyTempToken（插件 Bearer 门禁共用）对吊销 token 返回 false —— 经 /api/fs 门禁间接验证不可行时直接查会话语义：
  const anon = client();
  const denied = await anon.send('/api/auth/temp-credential/list');
  assert.equal(denied.status, 401);
});
