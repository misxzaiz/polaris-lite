/**
 * phone-agent 服务端集成测试：手机端点信令枢纽（docs/mobile-app-plan.md §9）。
 *
 * 复用「独立实例 + cookie client」模式。覆盖：
 * 登录门禁 / SSE 注册与 consent 门禁（未确认设备 AI 调不到）/
 * 指令下发→手机执行→结果回传全链路 / 未声明能力拒绝 / 无设备与离线结构化错误 /
 * consent 撤销立即除名 / 结果体积截断。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProdServer } from '../server/prod-server.mjs';

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'plite-phone-agent-'));
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

async function login(t, env) {
  const c = env.client();
  const r = await c.send('/api/auth/login', {
    method: 'POST',
    body: { username: 'boss', password: 'secret123' },
  });
  assert.equal(r.status, 200);
  return c;
}

/** 模拟一台手机：SSE 连接 + 收 command 事件执行并回传结果（ownerClient 为已登录 client） */
async function connectPhone(t, env, ownerClient, { consent = true, caps = ['clipboard.read'] } = {}) {
  // SSE：手动建连读流（fetch 流式读取）
  const controller = new AbortController();
  const res = await fetch(env.base + '/api/phone/events', {
    headers: { cookie: ownerClient.cookie() },
    signal: controller.signal,
  });
  assert.equal(res.status, 200);

  const phone = {
    deviceId: null,
    closed: false,
    controller,
    /** 持续 reader：SSE 连接只建一次 reader，帧缓冲在实例上 */
    _reader: null,
    _buf: '',
    async nextEvent(timeoutMs = 3000) {
      if (!phone._reader) phone._reader = res.body.getReader();
      const decoder = new TextDecoder();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        while (true) {
          // 缓冲里已有完整帧 → 直接返回（并从缓冲消费）
          const m = /event: ([\w.]+)\ndata: (.+?)\n\n/.exec(phone._buf);
          if (m) {
            phone._buf = phone._buf.slice(m.index + m[0].length);
            return { event: m[1], data: JSON.parse(m[2]) };
          }
          const { done, value } = await phone._reader.read();
          if (done) break;
          phone._buf += decoder.decode(value, { stream: true });
        }
      } finally {
        clearTimeout(timer);
      }
      throw new Error('SSE stream ended');
    },
    async close() {
      phone.closed = true;
      controller.abort();
    },
  };

  // 注册流：registered 事件给 deviceId
  const reg = await phone.nextEvent();
  assert.equal(reg.event, 'registered');
  phone.deviceId = reg.data.deviceId;

  if (consent) {
    const cr = await ownerClient.send('/api/phone/consent', {
      method: 'POST',
      body: { deviceId: phone.deviceId, allow: true, name: '测试手机' },
    });
    assert.equal(cr.status, 200);
  }
  const rr = await ownerClient.send('/api/phone/register', {
    method: 'POST',
    body: { deviceId: phone.deviceId, name: '测试手机', capabilities: caps },
  });
  return phone;
}

test('未登录：全部 /api/phone/* 一律 401', async (t) => {
  const env = await startHost(t, tempRoot());
  const anon = env.client();
  for (const p of ['/api/phone/hello', '/api/phone/command', '/api/phone/result']) {
    const r = await anon.send(p, { method: 'POST', body: {} });
    assert.equal(r.status, 401, p);
  }
  const h = await anon.send('/api/phone/hello');
  assert.equal(h.status, 401);
});

test('hello：登录后可用（前端握手探针）', async (t) => {
  const env = await startHost(t, tempRoot());
  const c = await login(t, env);
  const r = await c.send('/api/phone/hello');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
});

test('全链路：consent → AI 指令下发 → 手机执行 → 结果回传', async (t) => {
  const env = await startHost(t, tempRoot());
  const owner = await login(t, env);
  const phone = await connectPhone(t, env, owner, { consent: true });

  // AI（另一个登录会话，模拟桌面端）下发指令；同时手机侧开始监听
  const commandP = owner.send('/api/phone/command', {
    method: 'POST',
    body: { action: 'clipboard.read', payload: {}, timeoutMs: 5000 },
  });

  const evt = await phone.nextEvent();
  assert.equal(evt.event, 'command');
  assert.equal(evt.data.action, 'clipboard.read');
  // 手机执行后回传
  const fr = await owner.send('/api/phone/result', {
    method: 'POST',
    body: { deviceId: phone.deviceId, commandId: evt.data.commandId, ok: true, data: '剪贴板内容' },
  });
  assert.equal(fr.status, 200);

  const cr = await commandP;
  assert.equal(cr.status, 200);
  assert.equal(cr.json.ok, true);
  assert.equal(cr.json.data, '剪贴板内容');

  await phone.close();
});

test('未 consent 的设备：AI 调用报无设备（consentRequired 链路）', async (t) => {
  const env = await startHost(t, tempRoot());
  const owner = await login(t, env);
  // 只连 SSE，不 consent
  const phone = await connectPhone(t, env, owner, { consent: false });
  // register 应返回 consentRequired
  // （connectPhone 中 consent=false 时 register 的结果这里重发验证）
  const rr = await owner.send('/api/phone/register', {
    method: 'POST',
    body: { deviceId: phone.deviceId, name: 'x', capabilities: [] },
  });
  assert.equal(rr.json.ok, false);
  assert.equal(rr.json.code, 'CONSENT_REQUIRED');

  // AI 调用：无已确认设备 → 结构化错误
  const cr = await owner.send('/api/phone/command', {
    method: 'POST',
    body: { action: 'clipboard.read' },
  });
  assert.equal(cr.status, 404);
  assert.equal(cr.json.code, 'NO_DEVICE');
  await phone.close();
});

test('consent 撤销立即除名（AI 马上不可见）', async (t) => {
  const env = await startHost(t, tempRoot());
  const owner = await login(t, env);
  const phone = await connectPhone(t, env, owner);
  // 撤销
  const revoke = await owner.send('/api/phone/consent', {
    method: 'POST',
    body: { deviceId: phone.deviceId, allow: false },
  });
  assert.equal(revoke.status, 200);
  const cr = await owner.send('/api/phone/command', {
    method: 'POST',
    body: { action: 'clipboard.read' },
  });
  assert.equal(cr.status, 404);
  assert.equal(cr.json.code, 'NO_DEVICE');
  await phone.close();
});

test('未声明能力：allowlist 模式下拒绝并回 denied', async (t) => {
  const env = await startHost(t, tempRoot());
  const owner = await login(t, env);
  const phone = await connectPhone(t, env, owner, { caps: ['clipboard.read'] });
  const cr = await owner.send('/api/phone/command', {
    method: 'POST',
    body: { action: 'notify' }, // 手机没声明 notify
  });
  assert.equal(cr.status, 403);
  assert.equal(cr.json.code, 'CAP_NOT_DECLARED');
  assert.equal(cr.json.denied, true);
  await phone.close();
});

test('结果超限截断（64KB 头尾保留 + truncated 标记）', async (t) => {
  const env = await startHost(t, tempRoot());
  const owner = await login(t, env);
  const phone = await connectPhone(t, env, owner, { caps: ['clipboard.read', 'page.snap'] });
  const big = 'x'.repeat(80 * 1024); // 80KB：超 64KB 截断阈值、低于手机端 result body 上限
  const commandP = owner.send('/api/phone/command', {
    method: 'POST',
    body: { action: 'page.snap', timeoutMs: 5000 },
  });
  const evt = await phone.nextEvent();
  await owner.send('/api/phone/result', {
    method: 'POST',
    body: { deviceId: phone.deviceId, commandId: evt.data.commandId, ok: true, data: big },
  });
  const cr = await commandP;
  assert.equal(cr.status, 200);
  assert.equal(cr.json.ok, true);
  assert.equal(cr.json.truncated, true);
  assert.ok(cr.json.data.length < 100 * 1024);
  assert.ok(cr.json.data.includes('[truncated]'));
  await phone.close();
});
