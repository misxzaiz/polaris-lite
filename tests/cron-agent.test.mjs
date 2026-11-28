/**
 * cron-agent 定时 AI 任务服务端集成测试。
 *
 * 复用 chat-store.test.mjs 的「独立实例 + cookie client」模式。核心回归点是
 * 2026-11-28 的 401 事故：系统临时凭证的 owner 曾从幽灵全局 __pliteNodeFs 读
 * （从未被设置），回退 'root'——dev（root 账号）碰巧可用，非 root 账号在
 * 「临时凭证换会话 cookie」一环必 401，任务执行全部失败（start 失败(401)）。
 * 测试用非 root 用户名（tester）首登注册，覆盖这条链路：
 * run-now → ensureSystemToken(owner=真实用户名) → /api/auth/login(Bearer) →
 * 拿 cookie → /api/agent/start。测试环境无供应商密钥，start 落 400 级业务错误
 * （NO_PROVIDER / ENGINE_NOT_FOUND），只要不是 401 就证明凭证链已通。
 *
 * 附带覆盖：门禁（未登录 401 / 坏 cron 400）、失败通知落通知中心收件箱、
 * 旧版 notify {desktop,phone} 数据兼容。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProdServer } from '../server/prod-server.mjs';

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'plite-cron-agent-'));
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
  // 插件 loopback（auth-login / agent-start / agent-state）打到本实例：
  // listen(0) 的端口在装配期不可知，故插件侧惰性读 PLITE_SELF_PORT，这里装配后补设。
  process.env.PLITE_SELF_PORT = String(port);
  t.after(() => { delete process.env.PLITE_SELF_PORT; });

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
    return { send };
  };

  return { base, port, client, dataDir };
}

/** 轮询直到条件成立（run-now 是异步发起，落账有延迟） */
async function waitFor(fn, { tries = 16, intervalMs = 500 } = {}) {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

test('cron：门禁与校验——未登录 401 / 坏 cron 400', async (t) => {
  const env = tempRoot();
  const { client } = await startHost(t, env);
  // 先注册 server.close（startHost 内），后注册 rmSync → 收尾顺序：先停服务再删目录
  t.after(() => { try { rmSync(env.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* Windows 句柄释放竞态，残留交给系统临时目录 */ } });
  const anon = client();
  const gate = await anon.send('/api/cron/tasks');
  assert.equal(gate.status, 401, '未登录访问任务列表应 401');

  const res = await anon.send('/api/auth/login', { method: 'POST', body: { username: 'tester', password: 'test12345' } });
  assert.equal(res.status, 200);
  const bad = await anon.send('/api/cron/tasks', { method: 'POST', body: { name: 'x', cron: '99 * * * *', prompt: 'p' } });
  assert.equal(bad.status, 400, '越界 cron 字段应 400');
  const badShape = await anon.send('/api/cron/tasks', { method: 'POST', body: { name: 'x', cron: '0 8 * *', prompt: 'p' } });
  assert.equal(badShape.status, 400, '非 5 段 cron 应 400');
});

test('cron：非 root 账号 run-now 不再 401（2026-11-28 事故回归）', async (t) => {
  const env = tempRoot();
  const { client } = await startHost(t, env);
  // 先注册 server.close（startHost 内），后注册 rmSync → 收尾顺序：先停服务再删目录
  t.after(() => { try { rmSync(env.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* Windows 句柄释放竞态，残留交给系统临时目录 */ } });
  const c = client();
  // 非 root 用户名首登即注册——旧实现的 owner 回退 'root' 与之错位即 401
  const login = await c.send('/api/auth/login', { method: 'POST', body: { username: 'tester', password: 'test12345' } });
  assert.equal(login.status, 200);

  const created = await c.send('/api/cron/tasks', { method: 'POST', body: { name: '回归任务', cron: '0 3 1 1 *', prompt: 'reply ok' } });
  assert.equal(created.status, 200, `创建失败: ${created.text}`);
  const taskId = created.json?.task?.id;
  assert.ok(taskId, '应返回任务 id');
  assert.ok(created.json?.task?.nextRunAt, '创建时应算出下次触发时间');

  const fire = await c.send('/api/cron/tasks/run-now', { method: 'POST', body: { id: taskId } });
  assert.equal(fire.status, 200);

  const hit = await waitFor(async () => {
    const r = await c.send('/api/cron/tasks');
    const task = (r.json?.tasks ?? []).find((x) => x.id === taskId);
    const run = task?.runs?.[0];
    return run && run.status !== 'running' ? { task, run } : null;
  });
  assert.ok(hit, '试跑应很快落一条终态 run 记录');
  const { run } = hit;
  assert.equal(run.status, 'failed', '无供应商密钥的测试环境应失败');
  assert.ok(!String(run.error ?? '').includes('401'), `不应再是 401 凭证错误：${run.error}`);
  assert.match(String(run.error ?? ''), /start 失败\(4\d\d\)/, `应是 start 的 400 级业务错误（NO_PROVIDER 等）：${run.error}`);
  assert.equal(hit.task.lastRunAt != null, true, '任务应回写 lastRunAt');
});

test('cron：失败通知写入通知中心收件箱', async (t) => {
  const env = tempRoot();
  const { client } = await startHost(t, env);
  // 先注册 server.close（startHost 内），后注册 rmSync → 收尾顺序：先停服务再删目录
  t.after(() => { try { rmSync(env.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* Windows 句柄释放竞态，残留交给系统临时目录 */ } });
  const c = client();
  await c.send('/api/auth/login', { method: 'POST', body: { username: 'tester', password: 'test12345' } });
  const created = await c.send('/api/cron/tasks', { method: 'POST', body: { name: '通知落箱任务', cron: '0 3 1 1 *', prompt: 'reply ok' } });
  const taskId = created.json?.task?.id;
  await c.send('/api/cron/tasks/run-now', { method: 'POST', body: { id: taskId } });

  const hit = await waitFor(async () => {
    const r = await c.send('/api/kv/get?namespace=notification-center&key=inbox');
    const list = Array.isArray(r.json?.value) ? r.json.value : [];
    return list.find((n) => n?.source === 'cron-agent' && String(n?.title ?? '').includes('通知落箱任务')) ?? null;
  });
  assert.ok(hit, '失败通知应写入 notification-center 收件箱（kv）');
  assert.equal(hit.level, 'error', '失败通知应为 error 级');
  assert.ok(hit.sessionId, '通知应带会话入口');
  assert.ok(String(hit.body ?? '').includes('失败原因'), '通知正文应含失败原因');
});

test('cron：旧版 notify {desktop,phone} 数据兼容——publicTask 输出 {enabled}', async (t) => {
  const env = tempRoot();
  const { client } = await startHost(t, env);
  // 先注册 server.close（startHost 内），后注册 rmSync → 收尾顺序：先停服务再删目录
  t.after(() => { try { rmSync(env.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* Windows 句柄释放竞态，残留交给系统临时目录 */ } });
  const c = client();
  await c.send('/api/auth/login', { method: 'POST', body: { username: 'tester', password: 'test12345' } });
  const created = await c.send('/api/cron/tasks', { method: 'POST', body: { name: '兼容任务', cron: '0 3 1 1 *', prompt: 'p' } });
  const taskId = created.json?.task?.id;
  assert.deepEqual(created.json?.task?.notify, { enabled: true }, '新任务通知默认开');

  const off = await c.send('/api/cron/tasks/update', { method: 'POST', body: { id: taskId, notify: { desktop: false, phone: false } } });
  assert.equal(off.status, 200);
  assert.deepEqual(off.json?.task?.notify, { enabled: false }, '旧形态双关应归一为 enabled=false');

  const on = await c.send('/api/cron/tasks/update', { method: 'POST', body: { id: taskId, notify: { desktop: true, phone: false } } });
  assert.deepEqual(on.json?.task?.notify, { enabled: true }, '旧形态任一开应归一为 enabled=true');
});
