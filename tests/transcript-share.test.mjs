/**
 * transcript-share 服务端集成测试：AI 对话全过程只读分享（needs #069）。
 *
 * 复用 server.test.mjs 的「独立实例 + cookie client」模式：每个用例起一个
 * createProdServer（独立临时 dataDir）。数据准备：直接往 <dataDir>/chat-store/
 * 写会话 JSON（chat-store 持久化格式是跨插件公开约定）。
 * 覆盖：管理面门禁 / create 校验（sessionId、ttl 边界）/ list / refresh / revoke /
 * 免登录三出口（HTML/JSON/Markdown）/ token 失效（过期、吊销、乱写）/ 脱敏 /
 * 旧版 role:'tool' 消息 / PLITE_SHARE=0 禁用。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProdServer } from '../server/prod-server.mjs';

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'plite-share-'));
  const dist = join(root, 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>shell</title>');
  return { root, dist, dataDir: join(root, 'data') };
}

async function startHost(t, { dist, dataDir }) {
  const server = createProdServer({ dist, dataDir });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const client = () => {
    let cookie = '';
    const send = async (path, { method = 'GET', body, headers: extraHeaders } = {}) => {
      const res = await fetch(base + path, {
        method,
        headers: {
          ...(cookie ? { cookie } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(extraHeaders ?? {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
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

  return { base, client, dataDir };
}

async function login(t, env, username = 'boss', password = 'secret123') {
  const { client } = await startHost(t, env);
  const c = client();
  const res = await c.send('/api/auth/login', { method: 'POST', body: { username, password } });
  assert.equal(res.status, 200, `login failed: ${res.text}`);
  return c;
}

/** 往 chat-store 目录写一个会话记录（chat-store 持久化格式的公开约定） */
function seedSession(dataDir, id, session) {
  const dir = join(dataDir, 'chat-store');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ version: 3, updatedAt: 1700000000000, session }));
}

const mkSession = (id, messages) => ({
  id,
  title: '测试会话',
  createdAt: 1700000000000,
  messages,
});

const sessionWithTool = mkSession('s-test1', [
  { id: 'm1', role: 'user', content: '帮我跑 ls', createdAt: 1700000000000 },
  {
    id: 'm2', role: 'assistant', content: '', createdAt: 1700000000001,
    blocks: [
      { type: 'text', text: '好的' },
      {
        type: 'tool',
        card: {
          callId: 'c1', name: 'bash', command: 'ls -la', status: 'done',
          stdout: 'file1.txt\nfile2.txt', exitCode: 0, durationMs: 120,
        },
      },
      { type: 'thinking', text: '先看看目录' },
      { type: 'text', text: '目录里有 2 个文件' },
    ],
  },
]);

// ---------------------------------------------------------------- 门禁

test('管理面未登录 401；/share/* 免登录', async (t) => {
  const env = tempRoot();
  seedSession(env.dataDir, 's-test1', sessionWithTool);
  const { client } = await startHost(t, env);
  const anon = client();

  assert.equal((await anon.send('/api/share/list')).status, 401);
  assert.equal((await anon.send('/api/share/create', { method: 'POST', body: { sessionId: 's-test1' } })).status, 401);
  // 未知 token 的 /share 页免登录可访问（404 页面）
  const r = await anon.send('/share/abcdabcdabcdabcdabcdabcdabcdabcd');
  assert.equal(r.status, 404);
  assert.match(r.text, /链接无效/);
});

// ---------------------------------------------------------------- create / list / refresh / revoke

test('create → list → refresh → revoke 全链路', async (t) => {
  const env = tempRoot();
  seedSession(env.dataDir, 's-test1', sessionWithTool);
  const c = await login(t, env);

  // create：不存在会话 404
  assert.equal((await c.send('/api/share/create', { method: 'POST', body: { sessionId: 'nope' } })).status, 404);
  // create：ttl 越界 400（<1h）
  assert.equal((await c.send('/api/share/create', { method: 'POST', body: { sessionId: 's-test1', ttlMs: 1000 } })).status, 400);
  // create：ttl 越界 400（>30d）
  assert.equal(
    (await c.send('/api/share/create', { method: 'POST', body: { sessionId: 's-test1', ttlMs: 31 * 24 * 3600 * 1000 } })).status,
    400,
  );

  const created = await c.send('/api/share/create', { method: 'POST', body: { sessionId: 's-test1', ttlMs: 3600 * 1000 } });
  assert.equal(created.status, 200);
  assert.equal(created.json.ok, true);
  assert.match(created.json.url, /^\/share\/[A-Za-z0-9_-]+$/);
  assert.equal(created.json.live, true);

  // list：能看到完整 token 与摘要
  const list = await c.send('/api/share/list');
  assert.equal(list.status, 200);
  assert.equal(list.json.items.length, 1);
  assert.equal(list.json.items[0].token, created.json.token);
  assert.equal(list.json.items[0].sessionId, 's-test1');

  // refresh：续期
  const rf = await c.send('/api/share/refresh', {
    method: 'POST',
    body: { token: created.json.token, ttlMs: 7 * 24 * 3600 * 1000 },
  });
  assert.equal(rf.status, 200);
  assert.ok(rf.json.expiresAt > created.json.expiresAt);

  // revoke → 分享页 404
  const rv = await c.send('/api/share/revoke', { method: 'POST', body: { token: created.json.token } });
  assert.equal(rv.status, 200);
  assert.equal(rv.json.revoked, true);
  const gone = await c.send(created.json.url);
  assert.equal(gone.status, 404);
  assert.match(gone.text, /链接无效/);
  // 重复 revoke：幂等 false
  const rv2 = await c.send('/api/share/revoke', { method: 'POST', body: { token: created.json.token } });
  assert.equal(rv2.json.revoked, false);
});

// ---------------------------------------------------------------- 三出口内容

test('三出口：HTML 自包含 / JSON 结构化 / Markdown', async (t) => {
  const env = tempRoot();
  seedSession(env.dataDir, 's-test1', sessionWithTool);
  const c = await login(t, env);
  const created = await c.send('/api/share/create', { method: 'POST', body: { sessionId: 's-test1' } });
  const url = created.json.url;

  const html = await c.send(url);
  assert.equal(html.status, 200);
  assert.match(html.text, /测试会话/);
  assert.match(html.text, /ls -la/); // 工具命令进页面
  assert.match(html.text, /file1\.txt/); // stdout 进页面
  assert.match(html.text, /__SHARE__/); // 内联数据

  const json = await c.send(`${url}/json`);
  assert.equal(json.status, 200);
  const t1 = json.json;
  assert.equal(t1.sessionId, 's-test1');
  assert.equal(t1.messages.length, 2);
  const asst = t1.messages[1];
  assert.ok(Array.isArray(asst.blocks));
  const tool = asst.blocks.find((b) => b.type === 'tool');
  assert.equal(tool.tool.name, 'bash');
  assert.equal(tool.tool.command, 'ls -la');
  assert.equal(tool.tool.status, 'done');
  assert.equal(tool.tool.durationMs, 120);
  assert.equal(tool.tool.exitCode, 0);

  const md = await c.send(`${url}/markdown`);
  assert.equal(md.status, 200);
  assert.match(md.text, /# 测试会话/);
  assert.match(md.text, /```sh\nls -la\n```/);
  assert.match(md.text, /file1\.txt/);
});

// ---------------------------------------------------------------- 脱敏

test('脱敏：token 形态密钥不进任何出口', async (t) => {
  const env = tempRoot();
  // 拼接构造假密钥字面量，避免触发 arch 密钥扫描（源码不得出现 sk-… 形态）
  const SK1 = `sk-AbCdEf${'1234567890'}GhIjKl`;
  const SK2 = `sk-ZxYy${'123456789012345'}Qq`;
  seedSession(env.dataDir, 's-sec', mkSession('s-sec', [
    { id: 'm1', role: 'user', content: `我的 key 是 ${SK1} 请保密`, createdAt: 1700000000000 },
    {
      id: 'm2', role: 'assistant', content: '', createdAt: 1700000000001,
      blocks: [{
        type: 'tool',
        card: {
          callId: 'c1', name: 'bash', command: `echo ${SK2}`, status: 'done',
          stdout: 'Bearer aaaabbbbccccdddd', exitCode: 0,
        },
      }],
    },
  ]));
  const c = await login(t, env);
  const created = await c.send('/api/share/create', { method: 'POST', body: { sessionId: 's-sec' } });
  const url = created.json.url;

  for (const [label, path] of [['json', `${url}/json`], ['md', `${url}/markdown`], ['html', url]]) {
    const r = await c.send(path);
    assert.ok(!r.text.includes(SK1), `${label} 泄露了 prompt 中的 sk- 密钥`);
    assert.ok(!r.text.includes(SK2), `${label} 泄露了命令中的 sk- 密钥`);
    assert.ok(!r.text.includes('Bearer aaaabbbbccccdddd'), `${label} 泄露了 Bearer`);
    assert.match(r.text, /已脱敏/, `${label} 应有脱敏标记`);
  }
});

// ---------------------------------------------------------------- token 形态与过期

test('乱写 token 404；过期 token 410 且被清理', async (t) => {
  const env = tempRoot();
  seedSession(env.dataDir, 's-test1', sessionWithTool);
  const c = await login(t, env);
  const created = await c.send('/api/share/create', { method: 'POST', body: { sessionId: 's-test1', ttlMs: 3600 * 1000 } });

  // 直接改 tokens.json 把它做过期（模拟时间流逝）
  const tokensFile = join(env.dataDir, 'transcript-share', 'tokens.json');
  const map = JSON.parse(readFileSync(tokensFile, 'utf8'));
  const tok = Object.keys(map)[0];
  map[tok].expiresAt = Date.now() - 1000;
  writeFileSync(tokensFile, JSON.stringify(map));

  const r = await c.send(created.json.url);
  assert.equal(r.status, 410);
  assert.match(r.text, /已过期/);
  // 惰性清理：tokens.json 里已删
  const map2 = JSON.parse(readFileSync(tokensFile, 'utf8'));
  assert.equal(Object.keys(map2).length, 0);
});

// ---------------------------------------------------------------- 旧版 tool 消息 + 删除的会话

test('旧版 role:tool 消息可渲染；会话删除后 404', async (t) => {
  const env = tempRoot();
  seedSession(env.dataDir, 's-old', mkSession('s-old', [
    { id: 'm1', role: 'user', content: 'hi', createdAt: 1700000000000 },
    { id: 'm2', role: 'tool', content: '', createdAt: 1700000000001, tool: { callId: 'c1', name: 'fs', command: 'cat a.txt', status: 'done', stdout: 'A' } },
  ]));
  const c = await login(t, env);
  const created = await c.send('/api/share/create', { method: 'POST', body: { sessionId: 's-old' } });
  const j = await c.send(`${created.json.url}/json`);
  const toolMsg = j.json.messages.find((m) => m.role === 'tool');
  assert.equal(toolMsg.tool.name, 'fs');
  assert.equal(toolMsg.tool.command, 'cat a.txt');

  // 软删除：直接改 chat-store 文件加 deletedAt
  const recFile = join(env.dataDir, 'chat-store', 's-old.json');
  const rec = JSON.parse(readFileSync(recFile, 'utf8'));
  writeFileSync(recFile, JSON.stringify({ ...rec, deletedAt: Date.now() }));
  const r = await c.send(created.json.url);
  assert.equal(r.status, 404);
  assert.match(r.text, /已删除/);
});

// ---------------------------------------------------------------- API 轨迹 + 标题推导

test('trace 上报 → 分享三出口含 apiCalls；标题自动推导', async (t) => {
  const env = tempRoot();
  seedSession(env.dataDir, 's-trace', mkSession('s-trace', [
    { id: 'm1', role: 'user', content: '帮我看看这个报错是怎么回事？它出现在启动的时候', createdAt: 1700000000000 },
    { id: 'm2', role: 'assistant', content: '好的', createdAt: 1700000000001 },
  ]));
  const c = await login(t, env);

  const trace = {
    id: 'tr1', sessionId: 's-trace', at: 1700000000100, durMs: 1234, status: 200,
    model: 'gpt-test', providerId: 'p1',
    reqBody: JSON.stringify({ model: 'gpt-test', messages: [{ role: 'user', content: '帮我看看' }], stream: true }),
    sse: {
      frames: 12, textLen: 8, finishReason: 'stop',
      usage: { prompt_tokens: 100, completion_tokens: 20 },
      toolCalls: [{ name: 'bash', args: '{"command":"ls"}' }],
      first: ['data: {"choices":[]}'],
      last: ['data: [DONE]'],
    },
  };
  const r1 = await c.send('/api/share/trace', { method: 'POST', body: { traces: [trace] } });
  assert.equal(r1.status, 200);
  assert.equal(r1.json.stored, 1);

  // 空数组 / 超上限 400
  assert.equal((await c.send('/api/share/trace', { method: 'POST', body: { traces: [] } })).status, 400);
  assert.equal(
    (await c.send('/api/share/trace', { method: 'POST', body: { traces: Array.from({ length: 65 }, () => trace) } })).status,
    400,
  );

  // 创建分享 → 三出口验证
  const created = await c.send('/api/share/create', { method: 'POST', body: { sessionId: 's-trace' } });
  const url = created.json.url;

  // JSON：apiCalls 合并 + 标题推导（会话默认 title「测试会话」种子是有标题的——这里验证非默认标题优先）
  const j = await c.send(`${url}/json`);
  assert.equal(j.json.title, '测试会话'); // seed 有 title
  assert.equal(j.json.apiCalls.length, 1);
  const call = j.json.apiCalls[0];
  assert.equal(call.model, 'gpt-test');
  assert.equal(call.status, 200);
  assert.equal(call.durMs, 1234);
  assert.equal(call.sse.frames, 12);
  assert.equal(call.sse.usage.prompt_tokens, 100);
  assert.equal(call.sse.toolCalls[0].name, 'bash');
  assert.match(call.reqBody, /帮我看看/);

  // HTML：自包含页的渲染由浏览器 JS 完成，服务端断言内联数据与结构存在
  const html = await c.send(url);
  assert.match(html.text, /apiCalls/);
  assert.match(html.text, /gpt-test/);
  assert.match(html.text, /"durMs":1234/);
  assert.match(html.text, /API 调用轨迹/); // 渲染函数字符串内联在页面脚本里
  assert.match(html.text, /renderApiCalls/);

  // Markdown：API 轨迹区
  const md = await c.send(`${url}/markdown`);
  assert.match(md.text, /## API 调用轨迹/);
  assert.match(md.text, /#### API #1/);
  assert.match(md.text, /tokens: 100→20/);
});

test('标题自动推导：默认「新会话」时取首条用户消息', async (t) => {
  const env = tempRoot();
  seedSession(env.dataDir, 's-title', {
    id: 's-title',
    title: '新会话', // chat-lite 默认标题（只有手动重命名才改）
    createdAt: 1700000000000,
    messages: [
      { id: 'm1', role: 'assistant', content: '', createdAt: 1700000000000 },
      { id: 'm2', role: 'user', content: '  帮我优化下这个函数的性能问题\n它很慢', createdAt: 1700000000001 },
    ],
  });
  const c = await login(t, env);
  const created = await c.send('/api/share/create', { method: 'POST', body: { sessionId: 's-title' } });
  const j = await c.send(`${created.json.url}/json`);
  assert.equal(j.json.title, '帮我优化下这个函数的性能问题 它很慢');
});

test('trace 上报未登录 401；未知会话丢弃', async (t) => {
  const env = tempRoot();
  const { client } = await startHost(t, env);
  const anon = client();
  assert.equal(
    (await anon.send('/api/share/trace', { method: 'POST', body: { traces: [{ sessionId: 'x', at: 1 }] } })).status,
    401,
  );
  // 已登录但 sessionId 为空 → 不落盘
  const c = await login(t, env);
  const r = await c.send('/api/share/trace', {
    method: 'POST',
    body: { traces: [{ id: 't1', sessionId: '', at: 1, durMs: 5, status: 200, reqBody: null }] },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.stored, 0);
  assert.equal((await c.send('/api/share/list')).json.items.length, 0);
});

test('PLITE_SHARE=0 一键禁用', async (t) => {
  const env = tempRoot();
  seedSession(env.dataDir, 's-test1', sessionWithTool);
  process.env.PLITE_SHARE = '0'; // 必须在 createProdServer 之前：hardOff 在工厂调用时捕获
  let server;
  try {
    server = createProdServer({ dist: env.dist, dataDir: env.dataDir });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(() => server.close());
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/share/list`);
    // 禁用后中间件放行 → 落到 SPA 静态 fallback（200 index.html），不再 401
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /shell/);
  } finally {
    delete process.env.PLITE_SHARE;
  }
});
