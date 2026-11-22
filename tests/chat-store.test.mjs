/**
 * chat-store 服务端集成测试：对话会话服务端存储（多设备共享的数据面）。
 *
 * 复用 server.test.mjs 的「独立实例 + cookie client」模式：每个用例起一个
 * createProdServer（独立临时 dataDir），互不干扰。
 * 覆盖：登录门禁 / PUT 新建与版本单调 / 409 冲突与 force 覆盖 / GET 索引与增量 /
 * 墓碑删除 / sessionId 穿越 / 体积超限 / 双 client（两台设备）互见。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProdServer } from '../server/prod-server.mjs';

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'plite-chat-store-'));
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

  /** 带 cookie 记忆的简易客户端（一台「设备」） */
  const client = () => {
    let cookie = '';
    const send = async (path, { method = 'GET', body } = {}) => {
      const res = await fetch(base + path, {
        method,
        headers: {
          ...(cookie ? { cookie } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
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

  return { base, port, client, dataDir };
}

/** 登录并返回已认证 client（首登即注册） */
async function login(t, env, username = 'boss', password = 'secret123') {
  const { client } = await startHost(t, env);
  const c = client();
  const res = await c.send('/api/auth/login', { method: 'POST', body: { username, password } });
  assert.equal(res.status, 200, `login failed: ${res.text}`);
  return c;
}

const mkSession = (id, extra = {}) => ({
  id,
  title: '测试会话',
  createdAt: 1700000000000,
  messages: [
    { id: 'm1', role: 'user', content: '你好', createdAt: 1700000000000 },
    { id: 'm2', role: 'assistant', content: '你好！', createdAt: 1700000000001 },
  ],
  ...extra,
});

// ---------------------------------------------------------------- 门禁

test('未登录访问 chat-store 一律 401', async (t) => {
  const { client } = await startHost(t, tempRoot());
  const c = client();
  const gets = [
    c.send('/api/chat/sessions'),
    c.send('/api/chat/sessions/s-abc'),
    c.send('/api/chat/sessions/index-events'),
  ];
  const puts = c.send('/api/chat/sessions/s-abc', { method: 'PUT', body: { session: mkSession('s-abc'), baseVersion: 0 } });
  const dels = c.send('/api/chat/sessions/s-abc', { method: 'DELETE' });
  for (const r of await Promise.all([...gets, puts, dels])) {
    assert.equal(r.status, 401);
    assert.equal(r.json.code, 'SESSION_REQUIRED');
  }
});

// ---------------------------------------------------------------- 基本读写

test('PUT 新建会话 → GET 回读一致，版本从 1 单调递增', async (t) => {
  const c = await login(t, tempRoot());
  const put = await c.send('/api/chat/sessions/s-abc', { method: 'PUT', body: { session: mkSession('s-abc'), baseVersion: 0 } });
  assert.equal(put.status, 200);
  assert.equal(put.json.ok, true);
  assert.equal(put.json.version, 1);

  const get = await c.send('/api/chat/sessions/s-abc');
  assert.equal(get.status, 200);
  assert.equal(get.json.version, 1);
  assert.equal(get.json.session.title, '测试会话');
  assert.equal(get.json.session.messages.length, 2);

  // 二次写入（baseVersion=1）→ version 2
  const put2 = await c.send('/api/chat/sessions/s-abc', { method: 'PUT', body: { session: mkSession('s-abc', { title: '改名' }), baseVersion: 1 } });
  assert.equal(put2.status, 200);
  assert.equal(put2.json.version, 2);
  const get2 = await c.send('/api/chat/sessions/s-abc');
  assert.equal(get2.json.session.title, '改名');
});

test('版本冲突 409：baseVersion 过期被拒，force 可覆盖', async (t) => {
  const c = await login(t, tempRoot());
  await c.send('/api/chat/sessions/s-cf', { method: 'PUT', body: { session: mkSession('s-cf'), baseVersion: 0 } });

  // 过期版本
  const stale = await c.send('/api/chat/sessions/s-cf', { method: 'PUT', body: { session: mkSession('s-cf', { title: '旧设备写入' }), baseVersion: 0 } });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.code, 'VERSION_CONFLICT');
  assert.equal(stale.json.currentVersion, 1);

  // force 覆盖成功
  const force = await c.send('/api/chat/sessions/s-cf', { method: 'PUT', body: { session: mkSession('s-cf', { title: '强制覆盖' }), baseVersion: 0, force: true } });
  assert.equal(force.status, 200);
  assert.equal(force.json.version, 2);
  const get = await c.send('/api/chat/sessions/s-cf');
  assert.equal(get.json.session.title, '强制覆盖');
});

test('索引与增量查询：?since 过滤 updatedAt，msgCount/预览正确', async (t) => {
  const c = await login(t, tempRoot());
  await c.send('/api/chat/sessions/s-old', { method: 'PUT', body: { session: mkSession('s-old'), baseVersion: 0 } });
  await new Promise((r) => setTimeout(r, 15));
  const t2 = Date.now();
  await new Promise((r) => setTimeout(r, 15));
  await c.send('/api/chat/sessions/s-new', { method: 'PUT', body: { session: mkSession('s-new', { messages: [{ id: 'u', role: 'user', content: '最新一条提问' }] }), baseVersion: 0 } });

  const all = await c.send('/api/chat/sessions');
  assert.equal(all.status, 200);
  const ids = all.json.sessions.map((s) => s.id);
  assert.ok(ids.includes('s-old') && ids.includes('s-new'));
  assert.equal(all.json.sessions[0].id, 's-new'); // updatedAt 倒序
  const newest = all.json.sessions.find((s) => s.id === 's-new');
  assert.equal(newest.msgCount, 1);
  assert.match(newest.lastMsgPreview, /最新一条提问/);

  const inc = await c.send(`/api/chat/sessions?since=${t2}`);
  assert.deepEqual(inc.json.sessions.map((s) => s.id), ['s-new']);
  assert.deepEqual(inc.json.tombstones, []);
});

test('DELETE 软删除：GET 404、索引带墓碑、其他设备据此移除', async (t) => {
  const c = await login(t, tempRoot());
  await c.send('/api/chat/sessions/s-gone', { method: 'PUT', body: { session: mkSession('s-gone'), baseVersion: 0 } });

  const del = await c.send('/api/chat/sessions/s-gone', { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.equal(del.json.ok, true);

  const get = await c.send('/api/chat/sessions/s-gone');
  assert.equal(get.status, 404);

  const idx = await c.send('/api/chat/sessions');
  assert.ok(!idx.json.sessions.some((s) => s.id === 's-gone'));
  assert.ok(idx.json.tombstones.some((tb) => tb.id === 's-gone'));

  // 重复删除幂等
  const del2 = await c.send('/api/chat/sessions/s-gone', { method: 'DELETE' });
  assert.equal(del2.status, 200);
});

// ---------------------------------------------------------------- 校验与安全

test('session.id 与 URL 不一致 / 缺 messages / 畸形 baseVersion → 400', async (t) => {
  const c = await login(t, tempRoot());
  const mism = await c.send('/api/chat/sessions/s-a', { method: 'PUT', body: { session: mkSession('s-other'), baseVersion: 0 } });
  assert.equal(mism.status, 400);
  const noMsg = await c.send('/api/chat/sessions/s-a', { method: 'PUT', body: { session: { id: 's-a', title: 'x', createdAt: 1 }, baseVersion: 0 } });
  assert.equal(noMsg.status, 400);
  const badVer = await c.send('/api/chat/sessions/s-a', { method: 'PUT', body: { session: mkSession('s-a'), baseVersion: -1 } });
  assert.equal(badVer.status, 400);
});

test('sessionId 非法字符（路径穿越形态）→ 404/400，绝不落到任意文件', async (t) => {
  const c = await login(t, tempRoot());
  // %2e%2e 在 fetch 层会被规范化为路径段，这里直接用非法字符（点号不在白名单）
  const evil = await c.send('/api/chat/sessions/..%2f..%2fproviders', { method: 'GET' });
  assert.notEqual(evil.status, 200);
  const dot = await c.send('/api/chat/sessions/foo.bar', { method: 'GET' });
  assert.equal(dot.status, 404);
});

test('单会话超过 4MB → 413', async (t) => {
  const c = await login(t, tempRoot());
  const big = mkSession('s-big', { messages: [{ id: 'm', role: 'user', content: 'x'.repeat(5 * 1024 * 1024), createdAt: 1 }] });
  const res = await c.send('/api/chat/sessions/s-big', { method: 'PUT', body: { session: big, baseVersion: 0 } });
  assert.equal(res.status, 413);
});

// ---------------------------------------------------------------- 索引变更广播（spec v0.2）

/**
 * SSE 订阅端（raw fetch 流式读：client().send 会等完整 body，SSE 永不结束）。
 * readFrame：从字节流里按空行切帧，返回第一条包含 match 的帧。
 */
async function readFrame(reader, bufRef, match, timeoutMs = 3000) {
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const idx = bufRef.s.indexOf('\n\n');
    if (idx >= 0) {
      const frame = bufRef.s.slice(0, idx);
      bufRef.s = bufRef.s.slice(idx + 2);
      if (frame.includes(match)) return frame;
      continue; // ping 等无关帧：跳过继续读
    }
    if (Date.now() > deadline) throw new Error(`SSE frame timeout waiting "${match}"; buf=${bufRef.s.slice(0, 200)}`);
    const remaining = deadline - Date.now();
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise((r) => setTimeout(() => r({ done: true, value: undefined }), remaining)),
    ]);
    if (done) throw new Error('SSE closed early');
    bufRef.s += decoder.decode(value, { stream: true });
  }
}

test('索引变更 SSE：另一设备的 PUT / loop-state / DELETE 都即时扇出 index-changed', async (t) => {
  const env = tempRoot();
  const host = await startHost(t, env);
  const a = host.client();
  const b = host.client();
  for (const c of [a, b]) {
    const res = await c.send('/api/auth/login', { method: 'POST', body: { username: 'boss', password: 'secret123' } });
    assert.equal(res.status, 200);
  }

  // 设备 B 订阅索引变更流
  const controller = new AbortController();
  t.after(() => controller.abort());
  const sseRes = await fetch(`${host.base}/api/chat/sessions/index-events`, {
    headers: { cookie: b.cookie() },
    signal: controller.signal,
  });
  assert.equal(sseRes.status, 200);
  assert.ok((sseRes.headers.get('content-type') ?? '').includes('text/event-stream'));
  const reader = sseRes.body.getReader();
  const bufRef = { s: '' };

  // 设备 A PUT → B 收到变更事件（合批窗口 ≤120ms + 网络投递）
  const put = await a.send('/api/chat/sessions/s-sse', { method: 'PUT', body: { session: mkSession('s-sse'), baseVersion: 0 } });
  assert.equal(put.status, 200);
  const f1 = await readFrame(reader, bufRef, 'index-changed');
  assert.ok(f1.includes('s-sse'), `frame should carry session id: ${f1}`);

  // loop-state start（「执行中」徽标数据）→ 同样扇出
  const ls = await a.send('/api/chat/sessions/s-sse/loop-state', { method: 'POST', body: { event: 'start', device: 'A' } });
  assert.equal(ls.status, 200);
  await readFrame(reader, bufRef, 'index-changed');
  const ld = await a.send('/api/chat/sessions/s-sse/loop-state', { method: 'POST', body: { event: 'done' } });
  assert.equal(ld.status, 200);
  await readFrame(reader, bufRef, 'index-changed');

  // DELETE（墓碑）→ 扇出，其他设备据此即时移除
  const del = await a.send('/api/chat/sessions/s-sse', { method: 'DELETE' });
  assert.equal(del.status, 200);
  const f3 = await readFrame(reader, bufRef, 'index-changed');
  assert.ok(f3.includes('s-sse'));
});

// ---------------------------------------------------------------- 多设备语义

test('两台设备（两个 client）读写同一会话互见；后写 409 可感知', async (t) => {
  const env = tempRoot();
  const a = await login(t, env);
  const b = await login(t, env);

  // 设备 A 建会话
  const put = await a.send('/api/chat/sessions/s-share', { method: 'PUT', body: { session: mkSession('s-share'), baseVersion: 0 } });
  assert.equal(put.status, 200);
  const v1 = put.json.version;

  // 设备 B 索引可见
  const idx = await b.send('/api/chat/sessions');
  assert.ok(idx.json.sessions.some((s) => s.id === 's-share'));

  // 设备 B 基于过期版本写 → 409（拿到 currentVersion 后 force/重读）
  const conflict = await b.send('/api/chat/sessions/s-share', { method: 'PUT', body: { session: mkSession('s-share', { title: 'B 的修改' }), baseVersion: 0 } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.currentVersion, v1);

  // B 以服务端版本为基写入成功
  const ok = await b.send('/api/chat/sessions/s-share', { method: 'PUT', body: { session: mkSession('s-share', { title: 'B 的修改' }), baseVersion: conflict.json.currentVersion } });
  assert.equal(ok.status, 200);

  // A 再拉全文看到 B 的修改
  const aView = await a.send('/api/chat/sessions/s-share');
  assert.equal(aView.json.session.title, 'B 的修改');
});

test('PLITE_CHAT_STORE=0 一键禁用（端点退场，不回会话数据）', async (t) => {
  process.env.PLITE_CHAT_STORE = '0';
  try {
    const { client } = await startHost(t, tempRoot());
    const c = client();
    await c.send('/api/auth/login', { method: 'POST', body: { username: 'boss', password: 'secret123' } });
    // 中间件放行 → 静态服务 SPA fallback 回 index.html（200，但不是会话 JSON）
    const res = await c.send('/api/chat/sessions');
    assert.equal(res.status, 200);
    assert.equal(res.json, null); // index.html 不是 JSON → 会话数据面已退场
  } finally {
    delete process.env.PLITE_CHAT_STORE;
  }
});
