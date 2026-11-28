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
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProdServer } from '../server/prod-server.mjs';
import { createAuthMiddleware } from '../server/auth-session.mjs';

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

test('endedAt 消息字段透传：PUT 带 endedAt → GET 原样保留（含多设备二次写回不丢）', async (t) => {
  const c = await login(t, tempRoot());
  const sess = mkSession('s-endedat');
  sess.messages[1].endedAt = 1700000005321; // assistant 收敛时刻（settle 落）
  const put = await c.send('/api/chat/sessions/s-endedat', { method: 'PUT', body: { session: sess, baseVersion: 0 } });
  assert.equal(put.status, 200);

  const get = await c.send('/api/chat/sessions/s-endedat');
  assert.equal(get.status, 200);
  // 服务端整对象透传：新字段不剥落（旧快照兼容的前提——读到多余字段原样回写）
  assert.equal(get.json.session.messages[1].endedAt, 1700000005321);
  assert.equal(get.json.session.messages[0].endedAt, undefined); // user 消息不带，也透传为无

  // 模拟另一设备读→改标题→写回：endedAt 不丢（旧客户端整对象回写场景）
  const sess2 = get.json.session;
  sess2.title = '另一设备改名';
  const put2 = await c.send('/api/chat/sessions/s-endedat', { method: 'PUT', body: { session: sess2, baseVersion: 1 } });
  assert.equal(put2.status, 200);
  const get2 = await c.send('/api/chat/sessions/s-endedat');
  assert.equal(get2.json.session.messages[1].endedAt, 1700000005321);

  // 旧快照（无 endedAt）：正常读写不炸
  const sessOld = mkSession('s-legacy');
  const put3 = await c.send('/api/chat/sessions/s-legacy', { method: 'PUT', body: { session: sessOld, baseVersion: 0 } });
  assert.equal(put3.status, 200);
  const get3 = await c.send('/api/chat/sessions/s-legacy');
  assert.equal(get3.json.session.messages[1].endedAt, undefined);
});

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

// ---------------------------------------------------------------- 单一权威化：/messages 与 /meta

test('POST /messages replace：同对象重推幂等不涨版本，内容变更涨版本且不叠块', async (t) => {
  const c = await login(t, tempRoot());
  const m1 = { id: 'm1', role: 'assistant', content: '你好！第一版', createdAt: 1700000000100, blocks: [{ type: 'text', text: '你好！第一版' }] };

  const first = await c.send('/api/chat/sessions/s-msg/messages', { method: 'POST', body: { messages: [m1] } });
  assert.equal(first.status, 200);
  assert.equal(first.json.ok, true);
  assert.equal(first.json.version, 1, '建壳后首推版本从 1 起');
  assert.ok(!first.json.noChange);

  // 同一对象（连 createdAt 都相同）重推：不得空转版本号
  const again = await c.send('/api/chat/sessions/s-msg/messages', { method: 'POST', body: { messages: [m1] } });
  assert.equal(again.status, 200);
  assert.equal(again.json.noChange, true);
  assert.equal(again.json.version, 1);

  // 内容变更（replace 语义，不要求 mergeBlocks）：必须涨版本并整条替换
  const m1b = { ...m1, content: '你好！！第二版', blocks: [{ type: 'text', text: '你好！！第二版' }] };
  const changed = await c.send('/api/chat/sessions/s-msg/messages', { method: 'POST', body: { messages: [m1b] } });
  assert.equal(changed.status, 200);
  assert.equal(changed.json.version, 2);
  assert.ok(!changed.json.noChange);

  const got = await c.send('/api/chat/sessions/s-msg');
  assert.equal(got.status, 200);
  const session = got.json.session ?? got.json;
  assert.equal(session.messages.length, 1, 'replace 不得叠加重复消息');
  assert.equal(session.messages[0].content, '你好！！第二版');
  assert.equal(session.messages[0].blocks.length, 1, 'replace 是整条覆盖，块不追加');
});

test('POST /messages append：同 id 多轮块追加，content 取最长，不新增消息', async (t) => {
  const c = await login(t, tempRoot());
  const r1 = await c.send('/api/chat/sessions/s-app/messages', {
    method: 'POST',
    body: { mode: 'append', messages: [{ id: 'a1', role: 'assistant', content: '第一块', blocks: [{ type: 'text', text: '第一块' }], createdAt: 1700000000200 }] },
  });
  assert.equal(r1.status, 200);
  const r2 = await c.send('/api/chat/sessions/s-app/messages', {
    method: 'POST',
    body: { mode: 'append', messages: [{ id: 'a1', role: 'assistant', content: '第一块+第二块', blocks: [{ type: 'text', text: '第二块' }], createdAt: 1700000000201 }] },
  });
  assert.equal(r2.status, 200);
  assert.ok(r2.json.version > r1.json.version);

  const got = await c.send('/api/chat/sessions/s-app');
  const session = got.json.session ?? got.json;
  assert.equal(session.messages.length, 1);
  assert.equal(session.messages[0].blocks.length, 2, 'append 合并块');
  assert.equal(session.messages[0].content, '第一块+第二块', 'content 取累计最长');
});

test('POST /meta：建壳 + 幂等 + 只接受元字段（messages 不许从 meta 进）', async (t) => {
  const c = await login(t, tempRoot());
  const mk = await c.send('/api/chat/sessions/s-meta/meta', { method: 'POST', body: { patch: { title: '改名', pinned: true } } });
  assert.equal(mk.status, 200);
  assert.equal(mk.json.version, 1);

  const same = await c.send('/api/chat/sessions/s-meta/meta', { method: 'POST', body: { patch: { title: '改名', pinned: true } } });
  assert.equal(same.json.noChange, true);
  assert.equal(same.json.version, 1);

  const bad = await c.send('/api/chat/sessions/s-meta/meta', { method: 'POST', body: { patch: { messages: [] } } });
  assert.equal(bad.status, 400, 'meta 不得写入 messages');
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

// ---------------------------------------------------------------- chat_history 工具
// AI 视角的历史会话检索（list/search/read/set_model）。经 mock registry 捕获
// createServerPart 里注册的工具适配器，直接 invoke——不起 HTTP，专注工具逻辑。

/** 捕获 chat_history 工具注册并直接调用 */
async function captureChatHistoryTool(t, { dataDir }) {
  let captured = null;
  const registry = {
    registerTool: (adapter) => { if (adapter?.name === 'chat_history') captured = adapter; },
    registerService: () => {},
  };
  const { createServerPart } = await import('../plugins/chat-store/server.mjs');
  const mw = createServerPart({ dataDir, registry, getSession: () => ({ user: 'boss' }) });
  if (typeof mw === 'function') t.after(() => {}); // 中间件自身无需清理
  assert.ok(captured, 'chat_history 工具应已注册');
  return (args) => captured.invoke({ args });
}

test('chat_history：list 返回会话索引（跳过墓碑，按活跃时间倒序）', async (t) => {
  const { dataDir } = tempRoot();
  const c = await login(t, { dist: undefined, dataDir });
  void c;
  const invoke = await captureChatHistoryTool(t, { dataDir });
  const r = await invoke({ action: 'list' });
  assert.equal(r.ok, true, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.count, 0);
  // 写两个会话再 list
  const { createChatStoreAccess } = await import('../plugins/chat-store/server.mjs');
  const access = createChatStoreAccess({ dataDir });
  access.writeRecord('s-a', { version: 1, updatedAt: 1, session: { ...mkSession('s-a', { lastActiveAt: 1 }), title: 'A' } });
  access.writeRecord('s-b', { version: 1, updatedAt: 2, session: { ...mkSession('s-b', { lastActiveAt: 9 }), title: 'B' } });
  const r2 = await invoke({ action: 'list' });
  const p2 = JSON.parse(r2.stdout);
  assert.equal(p2.count, 2);
  assert.equal(p2.sessions[0].sessionId, 's-b'); // 更活跃在前
});

test('chat_history：search 命中标题与正文，返回片段；q 缺失报错', async (t) => {
  const { dataDir } = tempRoot();
  const { createChatStoreAccess } = await import('../plugins/chat-store/server.mjs');
  const access = createChatStoreAccess({ dataDir });
  access.writeRecord('s-gold', { version: 1, updatedAt: 1, session: {
    id: 's-gold', title: '理财复盘', createdAt: 1, lastActiveAt: 1,
    messages: [
      { id: 'm1', role: 'user', content: '我想买黄金 ETF 练手', createdAt: 1 },
      { id: 'm2', role: 'assistant', content: '可以看看 000217', createdAt: 2 },
    ],
  } });
  access.writeRecord('s-other', { version: 1, updatedAt: 2, session: {
    id: 's-other', title: '别的', createdAt: 1, lastActiveAt: 2,
    messages: [{ id: 'm1', role: 'user', content: '今天天气不错', createdAt: 1 }],
  } });
  const invoke = await captureChatHistoryTool(t, { dataDir });
  const r = await invoke({ action: 'search', q: '黄金' });
  assert.equal(r.ok, true);
  const p = JSON.parse(r.stdout);
  assert.equal(p.hits.length, 1);
  assert.equal(p.hits[0].sessionId, 's-gold');
  assert.ok(p.hits[0].snippet.includes('黄金'));
  // 标题命中
  const r2 = await invoke({ action: 'search', q: '理财' });
  assert.equal(JSON.parse(r2.stdout).hits[0].matched, 'title');
  // q 缺失
  const r3 = await invoke({ action: 'search' });
  assert.equal(r3.ok, false);
  assert.match(r3.stderr, /q required/);
});

test('chat_history：search 命中超过 20 条时按活跃倒序截断（不漏最新命中）', async (t) => {
  const { dataDir } = tempRoot();
  const { createChatStoreAccess } = await import('../plugins/chat-store/server.mjs');
  const access = createChatStoreAccess({ dataDir });
  // 25 个全命中会话：最新 updatedAt 放在字典序最后的 s-25（listRecords 按 readdirSync 名序扫描）
  for (let i = 1; i <= 25; i++) {
    const id = `s-${String(i).padStart(2, '0')}`;
    access.writeRecord(id, { version: 1, updatedAt: i, session: {
      id, title: `话题${i}`, createdAt: i, lastActiveAt: i,
      messages: [{ id: 'm1', role: 'user', content: '黄金定投记录', createdAt: i }],
    } });
  }
  const invoke = await captureChatHistoryTool(t, { dataDir });
  const r = await invoke({ action: 'search', q: '黄金' });
  assert.equal(r.ok, true);
  const p = JSON.parse(r.stdout);
  assert.equal(p.total, 25, 'total 应为全量命中数');
  assert.equal(p.truncated, true);
  assert.equal(p.hits.length, 20, 'hits 截断到上限');
  assert.equal(p.hits[0].sessionId, 's-25', '最新命中应排最前（旧实现扫描期截断会丢掉它）');
});

test('chat_history：read 返回转录（含 modelRef），不存在报错；set_model 写档生效', async (t) => {
  const { dataDir } = tempRoot();
  const { createChatStoreAccess } = await import('../plugins/chat-store/server.mjs');
  const access = createChatStoreAccess({ dataDir });
  access.writeRecord('s-x', { version: 1, updatedAt: 1, session: {
    id: 's-x', title: 'X', createdAt: 1, lastActiveAt: 1,
    modelRef: { engineId: 'real', modelId: 'gpt-x' },
    messages: [{ id: 'm1', role: 'user', content: 'hi', createdAt: 1 }],
  } });
  const invoke = await captureChatHistoryTool(t, { dataDir });
  const r = await invoke({ action: 'read', sessionId: 's-x' });
  const p = JSON.parse(r.stdout);
  assert.equal(p.msgCount, 1);
  assert.deepEqual(p.modelRef, { engineId: 'real', modelId: 'gpt-x' });
  // 不存在
  const r404 = await invoke({ action: 'read', sessionId: 's-none' });
  assert.equal(r404.ok, false);
  assert.match(r404.stderr, /not found/);
  // set_model
  const rsm = await invoke({ action: 'set_model', sessionId: 's-x', modelRef: { engineId: 'codebuddy', option: 'cli' } });
  assert.equal(rsm.ok, true, rsm.stderr);
  const back = access.readRecord('s-x');
  assert.deepEqual(back.session.modelRef, { engineId: 'codebuddy', option: 'cli' });
  assert.equal(back.version, 2); // 版本单调
  // 空对象拒绝
  const rbad = await invoke({ action: 'set_model', sessionId: 's-x', modelRef: {} });
  assert.equal(rbad.ok, false);
});

test('chat_history：未知 action 报错并列出可用项', async (t) => {
  const { dataDir } = tempRoot();
  const invoke = await captureChatHistoryTool(t, { dataDir });
  const r = await invoke({ action: 'bogus' });
  assert.equal(r.ok, false);
  assert.match(r.stderr, /list\/search\/read\/set_model/);
});

// ---------------------------------------------------------------- chat_start 工具
// AI 在对话内发起全新独立会话（P2）。经 mock registry 捕获适配器直接 invoke；
// fetch 打 /api/agent/start 的链路用环境变量 PLITE_SELF_PORT 指向指定端口
// （工具惰性求值该变量），避免撞上本机可能在跑的真实实例，专注验证：
// 防递归护栏 / prompt 校验 / 标题预置 / start 失败透传错误 / 成功路径返回 sessionId+runId。

/** 捕获 chat_start 工具注册并直接调用 */
async function captureChatStartTool(t, { dataDir }, startHandler) {
  let captured = null;
  const registry = {
    registerTool: (adapter) => { if (adapter?.name === 'chat_start') captured = adapter; },
    registerService: () => {},
  };
  // mock verifyTempToken/tempTokens：让 ensureSystemToken 造出的 token 恒有效
  const tempTokens = new Map();
  const verifyTempToken = (tok) => tempTokens.has(tok);
  const { createServerPart } = await import('../plugins/chat-store/server.mjs');
  createServerPart({
    dataDir, registry,
    getSession: () => ({ user: 'boss' }),
    verifyTempToken, tempTokens,
  });
  assert.ok(captured, 'chat_start 工具应已注册');
  return (args, run) => captured.invoke({ args, run });
}

test('chat_start：防递归护栏——AI 发起的会话内再调即拒绝', async (t) => {
  const { dataDir } = tempRoot();
  const invoke = await captureChatStartTool(t, { dataDir });
  const r = await invoke({ prompt: 'hi' }, { sessionId: 'chat-start-abc123' });
  assert.equal(r.ok, false);
  assert.match(r.stderr, /不可再嵌套/);
});

test('chat_start：prompt 校验——空/超长拒绝', async (t) => {
  const { dataDir } = tempRoot();
  const invoke = await captureChatStartTool(t, { dataDir });
  const rEmpty = await invoke({ prompt: '   ' });
  assert.equal(rEmpty.ok, false);
  assert.match(rEmpty.stderr, /1-4000/);
  const rLong = await invoke({ prompt: 'x'.repeat(4001) });
  assert.equal(rLong.ok, false);
  assert.match(rLong.stderr, /1-4000/);
});

test('chat_start：start 失败透传错误（NO_PROVIDER 等服务端报错）', async (t) => {
  const { dataDir } = tempRoot();
  const invoke = await captureChatStartTool(t, { dataDir });
  // PLITE_SELF_PORT 指向必拒连的端口：fetch 连接层错误也走同一透传分支
  // （不依赖「本机 5000 恰好没服务」——dev 实例在跑时这里会真发登录请求）
  const prev = process.env.PLITE_SELF_PORT;
  process.env.PLITE_SELF_PORT = '9';
  t.after(() => { if (prev === undefined) delete process.env.PLITE_SELF_PORT; else process.env.PLITE_SELF_PORT = prev; });
  const r = await invoke({ prompt: 'hello' });
  assert.equal(r.ok, false);
  assert.ok(r.stderr.length > 0, '应返回错误信息');
});

// ---------------------------------------------------------------- chat_start 鉴权回归
// 2026-11-28 401 事故：ensureSystemToken 经从未被任何代码设置的 globalThis.__pliteNodeFs
// 读 owner，解构抛 TypeError 被 catch 吞掉后恒回退 'root'——dev（root 账号）碰巧可用，
// 非 root 账号环境（如钉住实例 owner=boss）登录校验 entry.owner !== readOwner().username
// 必 401，实测 chat_start 返回「start 失败(401): unauthorized」。
// 本用例挂**真实 auth 中间件**复现非 root 环境：首登注册 owner='boss'，chat-store 与
// auth 共享同一 tempTokens 实例，loopback 服务按 agent-runner 同款 getSession 门禁。
// 修复前（owner 回退 root）本用例 401；修复后（直读 auth-owner.json）通过。
test('chat_start：系统凭证 owner 取真实注册用户（非 root 账号 401 事故回归）', async (t) => {
  const { dataDir } = tempRoot();
  // 真实 auth 实例：首登注册 + 临时凭证校验 + 会话 cookie，全是生产代码
  const auth = createAuthMiddleware({ dataDir });
  let captured = null;
  const registry = {
    registerTool: (adapter) => { if (adapter?.name === 'chat_start') captured = adapter; },
    registerService: () => {},
  };
  const { createServerPart } = await import('../plugins/chat-store/server.mjs');
  createServerPart({
    dataDir, registry,
    getSession: () => ({ user: { id: 'u-boss', name: 'boss' } }),
    verifyTempToken: auth.verifyTempToken,
    tempTokens: auth.tempTokens,
  });
  assert.ok(captured, 'chat_start 工具应已注册');

  // loopback 服务：/api/agent/start 按 agent-runner 同款门禁（未登录 401）；
  // 其余路径交给真实 auth 中间件（/api/auth/login 等）
  const loop = http.createServer((req, res) => {
    const [pathname] = (req.url ?? '').split('?');
    if (pathname === '/api/agent/start' && req.method === 'POST') {
      if (!auth.getSession(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized', code: 'SESSION_REQUIRED' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, runId: 'r-test' }));
      return;
    }
    void auth.middleware(req, res, () => { res.writeHead(404); res.end(); });
  });
  await new Promise((r) => loop.listen(0, '127.0.0.1', r));
  t.after(() => loop.close());
  const { port } = loop.address();

  // 首登即注册：auth-owner.json 落盘 username='boss'（非 root 账号环境）
  const reg = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'boss', password: 'secret123' }),
  });
  assert.equal(reg.status, 200, '首登注册 owner=boss 失败');

  const prev = process.env.PLITE_SELF_PORT;
  process.env.PLITE_SELF_PORT = String(port);
  t.after(() => { if (prev === undefined) delete process.env.PLITE_SELF_PORT; else process.env.PLITE_SELF_PORT = prev; });

  const r = await captured.invoke({ args: { prompt: 'hello from regression' }, run: { sessionId: 's-origin' } });
  assert.equal(r.ok, true, `chat_start 应成功（修复前此处 401）: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.match(out.sessionId, /^chat-start-/);
  assert.ok(out.runId, '应返回 runId');
});


// ---------------------------------------------------------------- sleep 工具
// chat_start/chat_continue 异步工作流的等待原语：sleep → chat_history read（带 running）
// 轮询等待收敛。上限 120s/次（免审批工具不长期占用 run 并发槽），abort 感知（run 中断即返回）。

/** 按名捕获工具适配器 + registerService 收集（sleep/chat_continue/running 态用例共用） */
async function captureToolByName(t, { dataDir, toolName }) {
  let captured = null;
  const services = {};
  const registry = {
    registerTool: (adapter) => { if (adapter?.name === toolName) captured = adapter; },
    registerService: (name, svc) => { services[name] = svc; },
  };
  const { createServerPart } = await import('../plugins/chat-store/server.mjs');
  createServerPart({ dataDir, registry, getSession: () => ({ user: 'boss' }) });
  assert.ok(captured, `${toolName} 工具应已注册`);
  return { invoke: (args, run, signal) => captured.invoke({ args, run, signal }), services, adapter: captured };
}

test('sleep：基本等待与边界（1-120）', async (t) => {
  const { dataDir } = tempRoot();
  const { invoke, adapter } = await captureToolByName(t, { dataDir, toolName: 'sleep' });
  assert.equal(adapter.repeatable, true, 'sleep 必须标记 repeatable——同参重复调用是轮询设计内用法，豁免 runner 重复调用护栏');
  const bad0 = await invoke({ seconds: 0 });
  assert.equal(bad0.ok, false);
  assert.match(bad0.stderr, /1-120/);
  const badLong = await invoke({ seconds: 121 });
  assert.equal(badLong.ok, false);
  assert.match(badLong.stderr, /1-120/);
  const badStr = await invoke({ seconds: 'abc' });
  assert.equal(badStr.ok, false);
  const t0 = Date.now();
  const r = await invoke({ seconds: 1 });
  assert.equal(r.ok, true, r.stderr);
  assert.ok(Date.now() - t0 >= 900, '应实际等待约 1s');
  assert.match(r.stdout, /已等待 1s/);
});

test('sleep：abort 感知——run 中断后立即返回不再空等', async (t) => {
  const { dataDir } = tempRoot();
  const { invoke } = await captureToolByName(t, { dataDir, toolName: 'sleep' });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  const t0 = Date.now();
  const r = await invoke({ seconds: 10 }, undefined, ac.signal);
  assert.equal(r.ok, false);
  assert.match(r.stderr, /中断/);
  assert.ok(Date.now() - t0 < 2000, '应立即返回而非等满 10s');
});

// ---------------------------------------------------------------- chat_continue 工具
// 往已存在会话追加下一轮（share3 实测痛点：chat_start 只能新开，续轮只能让用户手动）。
// 模型缺省沿用会话档案 modelRef（保人设/引擎），显式覆盖逐键生效；单飞冲突（目标会话
// 已有 run）显式报错让 AI sleep 重试；防套娃同 chat_start。

test('chat_continue：防套娃护栏 / 校验 / 目标会话不存在', async (t) => {
  const { dataDir } = tempRoot();
  const { invoke } = await captureToolByName(t, { dataDir, toolName: 'chat_continue' });
  const guard = await invoke({ sessionId: 's-x', prompt: 'hi' }, { sessionId: 'chat-start-abc' });
  assert.equal(guard.ok, false);
  assert.match(guard.stderr, /不可再调/);
  const badId = await invoke({ sessionId: 'bad id!', prompt: 'hi' });
  assert.equal(badId.ok, false);
  assert.match(badId.stderr, /sessionId invalid/);
  const noPrompt = await invoke({ sessionId: 's-x', prompt: '   ' });
  assert.equal(noPrompt.ok, false);
  assert.match(noPrompt.stderr, /1-4000/);
  const missing = await invoke({ sessionId: 's-none', prompt: 'hi' });
  assert.equal(missing.ok, false);
  assert.match(missing.stderr, /not found/);
});

/** mock loopback：登录发假 cookie，/api/agent/start 捕获 payload 并按脚本应答 */
async function startLoopMock(t, handler) {
  const bodies = [];
  const loop = http.createServer((req, res) => {
    const [pathname] = (req.url ?? '').split('?');
    if (pathname === '/api/auth/login') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'plite.sid=mock; Path=/' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (pathname === '/api/agent/start' && req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        bodies.push(JSON.parse(raw || '{}'));
        const resp = handler?.(bodies[bodies.length - 1]) ?? { status: 200, body: { ok: true, runId: 'r-cont-1' } };
        res.writeHead(resp.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(resp.body));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => loop.listen(0, '127.0.0.1', r));
  t.after(() => loop.close());
  const prev = process.env.PLITE_SELF_PORT;
  process.env.PLITE_SELF_PORT = String(loop.address().port);
  t.after(() => { if (prev === undefined) delete process.env.PLITE_SELF_PORT; else process.env.PLITE_SELF_PORT = prev; });
  return bodies;
}

test('chat_continue：模型沿用会话档案 modelRef，显式覆盖逐键生效；成功返回 runId', async (t) => {
  const { dataDir } = tempRoot();
  const { createChatStoreAccess } = await import('../plugins/chat-store/server.mjs');
  const access = createChatStoreAccess({ dataDir });
  access.writeRecord('s-cont', { version: 1, updatedAt: 1, session: {
    id: 's-cont', title: '续轮目标', createdAt: 1, lastActiveAt: 1,
    modelRef: { engineId: 'codebuddy', providerId: 'p1', modelId: 'cli-x', option: 'cli' },
    messages: [{ id: 'm1', role: 'user', content: '上一轮', createdAt: 1 }],
  } });
  const { invoke } = await captureToolByName(t, { dataDir, toolName: 'chat_continue' });
  const bodies = await startLoopMock(t);

  const r1 = await invoke({ sessionId: 's-cont', prompt: '下一轮' });
  assert.equal(r1.ok, true, r1.stderr);
  const out1 = JSON.parse(r1.stdout);
  assert.equal(out1.runId, 'r-cont-1');
  assert.equal(bodies[0].sessionId, 's-cont');
  assert.equal(bodies[0].prompt, '下一轮');
  assert.equal(bodies[0].engineId, 'codebuddy', '缺省沿用会话 modelRef');
  assert.equal(bodies[0].modelId, 'cli-x');
  assert.equal(bodies[0].device, 'chat_continue（AI 续轮）');

  const r2 = await invoke({ sessionId: 's-cont', prompt: '再一轮', modelRef: { engineId: 'real' } });
  assert.equal(r2.ok, true, r2.stderr);
  assert.equal(bodies[1].engineId, 'real', '显式覆盖生效');
  assert.equal(bodies[1].modelId, 'cli-x', '未覆盖键沿用会话档案');
});

test('chat_continue：目标会话 run 执行中——existing 冲突显式报错（prompt 不投递）', async (t) => {
  const { dataDir } = tempRoot();
  const { createChatStoreAccess } = await import('../plugins/chat-store/server.mjs');
  createChatStoreAccess({ dataDir }).writeRecord('s-busy', { version: 1, updatedAt: 1, session: {
    id: 's-busy', title: '忙碌', createdAt: 1, lastActiveAt: 1, messages: [],
  } });
  const { invoke } = await captureToolByName(t, { dataDir, toolName: 'chat_continue' });
  const bodies = await startLoopMock(t, () => ({ status: 200, body: { ok: true, existing: true, runId: 'r-busy', phase: 'running' } }));
  const r = await invoke({ sessionId: 's-busy', prompt: 'hi' });
  assert.equal(r.ok, false);
  assert.match(r.stderr, /未投递/);
  assert.match(r.stderr, /sleep/);
  assert.equal(bodies.length, 1, 'start 被调用过（冲突在响应侧识别）');
});

// ---------------------------------------------------------------- read 的 running 执行态
// chat_start/chat_continue 的 run 异步执行，AI 以 sleep → read 轮询等待收敛；
// running=false 才代表本轮已结束（runner 10s 心跳保活后长工具期间也真实）。

test('chat_history：read 返回 running 执行态（loop-state start→true，done→false）', async (t) => {
  const { dataDir } = tempRoot();
  const { createChatStoreAccess } = await import('../plugins/chat-store/server.mjs');
  createChatStoreAccess({ dataDir }).writeRecord('s-run', { version: 1, updatedAt: 1, session: {
    id: 's-run', title: '执行中会话', createdAt: 1, lastActiveAt: 1,
    messages: [{ id: 'm1', role: 'user', content: 'hi', createdAt: 1 }],
  } });
  const { invoke, services } = await captureToolByName(t, { dataDir, toolName: 'chat_history' });
  const before = JSON.parse((await invoke({ action: 'read', sessionId: 's-run' })).stdout);
  assert.equal(before.running, false);
  services['chat-loop-state'].report('s-run', 'start', { device: 'test' });
  const during = JSON.parse((await invoke({ action: 'read', sessionId: 's-run' })).stdout);
  assert.equal(during.running, true);
  assert.equal(during.runPhase, 'running');
  services['chat-loop-state'].report('s-run', 'done');
  const after = JSON.parse((await invoke({ action: 'read', sessionId: 's-run' })).stdout);
  assert.equal(after.running, false);
});
