/**
 * 核心层回归测试：cap 总线的并发/隔离/权限语义，以及宿主授权表的解析规则。
 *
 * 直接以 Node 的类型剥离能力运行 TS 源码（无需构建），因此这些用例就是
 * 「改核心契约前必须先过」的安全网。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CapBus } from '../src/core/bus.ts';
import { resolvePolicy } from '../src/core/policy.ts';
import { SlotRegistry } from '../src/core/slotRegistry.ts';

const tick = () => new Promise((r) => setTimeout(r, 10));

test('并发流按调用维度隔离，不串台', async () => {
  const bus = new CapBus();
  bus.registerStreaming('cap.echo', async (req, emit) => {
    const { text } = req.payload;
    for (const ch of text) {
      emit({ kind: 'delta', payload: { ch } });
      await tick();
    }
    emit({ kind: 'done', payload: {} });
  });

  const collect = (text) =>
    new Promise((resolve) => {
      const got = [];
      bus.dispatchStream('p', ['cap.echo'], { target: 'cap.echo', action: 'run', payload: { text } }, (ev) => {
        if (ev.kind === 'done') return resolve(got.join(''));
        got.push(ev.payload.ch);
      });
    });

  const [a, b] = await Promise.all([collect('AAA'), collect('BBB')]);
  assert.equal(a, 'AAA');
  assert.equal(b, 'BBB');
});

test('未授权的能力调用被拒绝（默认拒绝）', async () => {
  const bus = new CapBus();
  bus.register('cap.secret', () => 'leak');
  const res = await bus.dispatch('p', ['cap.other'], { target: 'cap.secret', action: 'get' });
  assert.equal(res.ok, false);
  assert.match(res.error.message, /not granted/);
});

test('未知能力返回 ok:false 而非抛出', async () => {
  const bus = new CapBus();
  const res = await bus.dispatch('p', ['cap.none'], { target: 'cap.none', action: 'x' });
  assert.equal(res.ok, false);
  assert.match(res.error.message, /unknown cap/);
});

test('接口级鉴权：未放行受保护 cap，豁免 cap.auth', async () => {
  const bus = new CapBus();
  bus.register('cap.biz', () => 'ok');
  bus.setAuthGuard(() => false);
  const denied = await bus.dispatch('p', ['cap.biz'], { target: 'cap.biz', action: 'x' });
  assert.equal(denied.ok, false);
  assert.match(denied.error.message, /未登录|权限不足/);

  bus.register('cap.auth', () => ({ status: 'unauthenticated' }));
  const auth = await bus.dispatch('p', ['cap.auth'], { target: 'cap.auth', action: 'status' });
  assert.equal(auth.ok, true);
});

test('只读自省（cap.meta describe/list）不入审计链', async () => {
  const bus = new CapBus();
  bus.register('cap.meta', () => ({ capabilities: [] }));
  bus.register('cap.biz', () => 1);
  await bus.dispatch('p', ['cap.meta'], { target: 'cap.meta', action: 'describe' });
  await bus.dispatch('p', ['cap.meta'], { target: 'cap.meta', action: 'list' });
  assert.equal(bus.tailAudit(10).length, 0);
  await bus.dispatch('p', ['cap.biz'], { target: 'cap.biz', action: 'x' });
  assert.equal(bus.tailAudit(10).length, 1);
});

test('流结束后回收订阅槽（不随消息数增长）', async () => {
  const bus = new CapBus();
  bus.registerStreaming('cap.echo', async (_req, emit) => {
    emit({ kind: 'delta', payload: { ch: 'x' } });
  });
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => {
      bus.dispatchStream('p', ['cap.echo'], { target: 'cap.echo', action: 'run', payload: {} }, (ev) => {
        if (ev.kind === 'delta') resolve();
      });
    });
  }
  await tick();
  assert.equal(bus.activeStreams(), 0, '流结束后不应残留订阅槽');
});

test('重复注册同一 cap 抛错（防止提供方互相覆盖）', () => {
  const bus = new CapBus();
  bus.register('cap.a', () => 1);
  assert.throws(() => bus.register('cap.a', () => 2), /already registered/);
});

test('授权表：manifest 只是申请，实际生效 = manifest ∩ grants', () => {
  const manifest = {
    id: 'plug',
    name: 'p',
    version: '1',
    capabilities: ['cap.a', 'cap.b'],
    provides: ['cap.p1', 'cap.p2'],
    events: ['e1', 'e2'],
  };
  const policy = resolvePolicy(manifest, {
    plugins: { plug: { capabilities: ['cap.a'], provides: ['cap.p1'], events: ['e1'] } },
  });
  assert.deepEqual(policy.capabilities, ['cap.a']);
  assert.deepEqual(policy.provides, ['cap.p1']);
  assert.deepEqual(policy.events, ['e1']);
  assert.equal(policy.listed, true);
  assert.equal(policy.denied.length, 3);
});

test('授权表：未登记插件按 manifest 放行但标记未登记', () => {
  const manifest = { id: 'ghost', name: 'g', version: '1', capabilities: ['cap.a'] };
  const policy = resolvePolicy(manifest, { plugins: {} });
  assert.equal(policy.listed, false);
  assert.deepEqual(policy.capabilities, ['cap.a']);
});

test('授权表：unlistedPolicy=deny 时未登记插件零权限', () => {
  const manifest = { id: 'ghost', name: 'g', version: '1', capabilities: ['cap.a'], provides: ['cap.x'] };
  const policy = resolvePolicy(manifest, { unlistedPolicy: 'deny', plugins: {} });
  assert.deepEqual(policy.capabilities, []);
  assert.deepEqual(policy.provides, []);
  assert.equal(policy.denied.length, 2);
});

test('槽位注册表：list 按 order 排序，title 原样透传（tab 名不与插件名耦合）', () => {
  const reg = new SlotRegistry();
  // 故意按「乱序」注册，模拟插件加载时序与 manifest 声明顺序不一致的真实情况
  reg.register('mock-auth', [{ slot: 'panel', component: 'Creds', order: 3, title: '账号' }]);
  reg.register('model-admin', [{ slot: 'panel', component: 'Models', order: 2 }]);
  reg.register('cap-panel', [{ slot: 'panel', component: 'Caps', order: 1 }]);

  // tab 顺序必须由 order 决定，而不是谁先加载谁在前
  assert.deepEqual(
    reg.list('panel').map((e) => e.component),
    ['Caps', 'Models', 'Creds'],
  );
  // 同一插件可给自己的 panel 块单独命名，与 manifest.name 解耦
  assert.equal(reg.list('panel')[2].title, '账号');
  assert.equal(reg.list('panel')[1].title, undefined);
});
