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
// fetch 打 /api/agent/start 的链路用环境变量 PLITE_SELF_PORT 指向 mock server，
// 避免 401/agent-runner 依赖，专注验证：防递归护栏 / prompt 校验 / 标题预置 /
// start 失败透传错误 / 成功路径返回 sessionId+runId。

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
  // 未起真实服务：fetch 指向本进程不存在的端口 → 连接层错误也走同一透传分支
  const r = await invoke({ prompt: 'hello' });
  assert.equal(r.ok, false);
  assert.ok(r.stderr.length > 0, '应返回错误信息');
});

