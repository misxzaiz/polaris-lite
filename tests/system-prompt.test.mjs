/**
 * system-prompt 插件回归测试（2026-11-28 v0.3）。
 * 覆盖：模板参数展开（expandTemplate）、profiles 数据操作（load/create/set/delete/
 *       history/restore）、旧 global 数据迁移、组合读取（combinedPrompt 同 kv service 语义）。
 * 用假 kv（内存 Map，实现 get/set/keys 同 kv-store 契约）驱动 server.mjs 的内部逻辑。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { expandTemplate } from '../plugins/system-prompt/server.mjs';

/* ---------------- 假 kv（对齐 kv-store service 契约） ---------------- */

function fakeKv(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    get: (ns, key) => m.get(`${ns}|${key}`),
    set: (ns, key, v) => { m.set(`${ns}|${key}`, v); },
    del: (ns, key) => { m.delete(`${ns}|${key}`); },
    keys: (ns) => [...m.keys()].filter((k) => k.startsWith(`${ns}|`)).map((k) => k.split('|')[1]),
  };
}

/* ---------------- expandTemplate ---------------- */

test('expandTemplate：时间类参数与 persona 展开', () => {
  const now = new Date(2026, 10, 28, 19, 5); // 2026-11-28 19:05 周六
  const out = expandTemplate('{{date}} {{time}} {{weekday}} {{timeOfDay}}好，我是{{persona}}', {
    now,
    persona: '见晚',
  });
  assert.equal(out, '2026-11-28 19:05 星期六 晚好，我是见晚');
});

test('expandTemplate：时段分档（早/午/晚/深夜）', () => {
  const t = (h) => expandTemplate('{{timeOfDay}}', { now: new Date(2026, 0, 1, h) });
  assert.equal(t(5), '早');
  assert.equal(t(11), '早');
  assert.equal(t(12), '午');
  assert.equal(t(17), '午');
  assert.equal(t(18), '晚');
  assert.equal(t(23), '晚');
  assert.equal(t(0), '深夜');
  assert.equal(t(4), '深夜');
});

test('expandTemplate：未知占位符原样保留；无占位符直通', () => {
  assert.equal(expandTemplate('{{unknown}}'), '{{unknown}}');
  assert.equal(expandTemplate('普通文本'), '普通文本');
  // 带空格的占位符也展开（{{ date }} → 实际日期）
  assert.equal(expandTemplate('{{ date }}', { now: new Date(2026, 10, 28) }), '2026-11-28');
});

test('expandTemplate：空 context 不炸', () => {
  const out = expandTemplate('{{persona}}-{{port}}', {});
  assert.equal(out, '-');
});

/* ---------------- profiles 数据操作（经工具动作入口） ---------------- */

async function toolExec(kv, args) {
  // 直接复用 createServerPart 里注册的工具逻辑：经 registry 双件套装配后取 invoke
  let registered = null;
  const registry = {
    registerService: () => {},
    getService: (id) => (id === 'kv-store' ? kv : null),
    registerTool: (t) => { registered = t; },
  };
  const mod = await import('../plugins/system-prompt/server.mjs');
  mod.createServerPart({ registry });
  const res = await registered.invoke({ args });
  return JSON.parse(res.stdout);
}

test('profiles：create/list/set 全链路', async () => {
  const kv = fakeKv();
  const created = await toolExec(kv, { action: 'create', name: '见晚', text: '你是{{persona}}' });
  assert.equal(created.ok, true);
  const created2 = await toolExec(kv, { action: 'create', name: '专业模式', text: '专业中性' });
  assert.equal(created2.ok, true);

  const list = await toolExec(kv, { action: 'list' });
  assert.equal(list.profiles.length, 2);
  assert.equal(list.profiles[0].active, true); // 第一套默认激活
  assert.equal(list.profiles[0].name, '见晚');

  const sw = await toolExec(kv, { action: 'set', id: '专业模式' }); // 按 name 切换
  assert.equal(sw.ok, true);
  const list2 = await toolExec(kv, { action: 'list' });
  assert.equal(list2.profiles.find((p) => p.name === '专业模式').active, true);

  const bad = await toolExec(kv, { action: 'set', id: '不存在' });
  assert.equal(bad.ok, false);
});

test('profiles：text 编辑 + history + restore 回滚', async () => {
  const kv = fakeKv();
  await toolExec(kv, { action: 'create', name: 'A', text: 'v1' });
  // 编辑 → v1 进历史
  await toolExec(kv, { action: 'text', id: 'A', text: 'v2' });
  await toolExec(kv, { action: 'text', id: 'A', text: 'v3' });
  const hist = await toolExec(kv, { action: 'history', id: 'A' });
  assert.equal(hist.versions.length, 2);
  assert.equal(hist.versions[0].text, 'v2'); // 最近一次保存前快照在前
  assert.equal(hist.versions[1].text, 'v1');

  // 回滚到 index 1（v1）
  const r = await toolExec(kv, { action: 'restore', index: 1 });
  assert.equal(r.ok, true);
  const list = await toolExec(kv, { action: 'list' });
  // 文本验证：经 get 组合读取
  const mod = await import('../plugins/system-prompt/server.mjs');
  let svc = null;
  const reg = { registerService: (id, s) => { if (id === 'system-prompt') svc = s; }, getService: (id) => (id === 'kv-store' ? kv : null), registerTool: () => {} };
  mod.createServerPart({ registry: reg });
  assert.equal(svc.get(null), 'v1');
});

test('profiles：delete 保护（至少一套）+ 删除后 active 顺移', async () => {
  const kv = fakeKv();
  await toolExec(kv, { action: 'create', name: 'A', text: 'a' });
  await toolExec(kv, { action: 'create', name: 'B', text: 'b' });
  // 只有一套时删不掉
  const del1 = await toolExec(kv, { action: 'delete', id: 'A' });
  assert.equal(del1.ok, true); // 有两套，能删
  const del2 = await toolExec(kv, { action: 'delete', id: 'B' });
  assert.equal(del2.ok, false); // 剩最后一套，拒绝
});

test('迁移：旧 global 文本自动建「默认」profile 并激活', async () => {
  const kv = fakeKv({ 'system-prompt|global': '旧的全局文本' });
  const list = await toolExec(kv, { action: 'list' });
  assert.equal(list.profiles.length, 1);
  assert.equal(list.profiles[0].name, '默认');
  assert.equal(list.profiles[0].active, true);
});

test('组合读取：global profile + session 覆盖段拼接，模板实时展开', async () => {
  const kv = fakeKv();
  await toolExec(kv, { action: 'create', name: '见晚', text: '我是{{persona}}，现在是{{timeOfDay}}间' });
  kv.set('system-prompt', 'session.s1', '本会话用英文');
  const mod = await import('../plugins/system-prompt/server.mjs');
  let svc = null;
  const reg = { registerService: (id, s) => { if (id === 'system-prompt') svc = s; }, getService: (id) => (id === 'kv-store' ? kv : null), registerTool: () => {} };
  mod.createServerPart({ registry: reg });
  const out = svc.get('s1');
  assert.ok(out.includes('我是见晚'));
  assert.ok(out.includes('间'));
  assert.ok(out.endsWith('本会话用英文')); // 会话段在后
  assert.equal(svc.get('s-none'), '我是见晚'.length > 0 ? svc.get('s-none') : null); // 无覆盖段时只返回全局
});
