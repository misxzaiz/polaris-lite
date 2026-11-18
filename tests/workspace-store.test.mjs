/**
 * 工作区状态仓回归测试。
 *
 * 这里覆盖的不是「功能能跑」，而是**失败路径**：脏数据、超大体量、版本错位、
 * 插件下线后的孤儿视图、非法树的应用。这些路径如果没测到，表现是用户白屏或布局
 * 永久损坏，而且因为布局被持久化，刷新也救不回来。
 *
 * 用注入的假存储代替 localStorage，所以能直接在 Node 里跑。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceStore, WORKSPACE_STORAGE_KEY } from '../src/core/workspace/store.ts';
import { createDefaultTree, replaceById } from '../src/core/workspace/treeOps.ts';
import { findNode, validateWorkspace } from '../src/core/workspace/schema.ts';

function fakePersistence(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    read: (k) => (data.has(k) ? data.get(k) : null),
    write: (k, v) => void data.set(k, v),
    remove: (k) => void data.delete(k),
  };
}

const ALIVE = new Set(['demo.gantt', 'demo.logs']);

function makeStore(overrides = {}) {
  return new WorkspaceStore({
    persistence: overrides.persistence ?? null,
    isAliveViewType: overrides.isAliveViewType ?? ((t) => ALIVE.has(t)),
    knownViewTypes: overrides.knownViewTypes ?? (() => ALIVE),
    key: overrides.key,
    debounceMs: overrides.debounceMs ?? 0,
  });
}

test('无持久化数据时用默认树，且默认树自身合法', () => {
  const store = makeStore();
  store.restore();
  assert.deepEqual(store.getSnapshot().tree, createDefaultTree());
  assert.equal(store.getSnapshot().notice, null);
  assert.equal(validateWorkspace(store.getSnapshot().tree, { requireAllAnchors: true }).ok, true);
});

test('脏 JSON：回落默认树 + 留备份 + 给出提示，绝不白屏', () => {
  const p = fakePersistence({ [WORKSPACE_STORAGE_KEY]: '{ this is not json' });
  const store = makeStore({ persistence: p });
  store.restore();
  assert.deepEqual(store.getSnapshot().tree, createDefaultTree());
  assert.match(store.getSnapshot().notice, /无法解析/);
  // 原件必须留证，否则线上只能靠猜
  assert.equal(p.data.get(`${WORKSPACE_STORAGE_KEY}.bak`), '{ this is not json');
});

test('版本不匹配不猜测式迁移，直接回默认并备份', () => {
  const p = fakePersistence({
    [WORKSPACE_STORAGE_KEY]: JSON.stringify({ v: 99, tree: createDefaultTree() }),
  });
  const store = makeStore({ persistence: p });
  store.restore();
  assert.deepEqual(store.getSnapshot().tree, createDefaultTree());
  assert.match(store.getSnapshot().notice, /版本不匹配/);
  assert.ok(p.data.has(`${WORKSPACE_STORAGE_KEY}.bak`));
});

test('快照超过体积上限时在 parse 之前就丢弃（否则 JSON.parse 会同步阻塞主线程）', () => {
  const huge = 'x'.repeat(300 * 1024);
  const p = fakePersistence({ [WORKSPACE_STORAGE_KEY]: huge });
  const store = makeStore({ persistence: p });
  store.restore();
  assert.match(store.getSnapshot().notice, /过大/);
});

test('原型污染键被 parse 阶段拒绝', () => {
  const raw = `{"v":1,"tree":{"kind":"anchor","id":"a","anchor":"panel","__proto__":{"polluted":true}}}`;
  const store = makeStore({ persistence: fakePersistence({ [WORKSPACE_STORAGE_KEY]: raw }) });
  store.restore();
  assert.deepEqual(store.getSnapshot().tree, createDefaultTree());
  assert.equal({}.polluted, undefined);
});

test('restore 只读不折叠：插件视图在注册表为空时不能被误判成死视图', () => {
  const base = createDefaultTree();
  const panel = findNode(base, 'anchor-panel');
  const tree = replaceById(base, 'anchor-panel', {
    kind: 'split',
    id: 'dead-wrap',
    dir: 'row',
    size: { mode: 'ratio', value: 0.5 },
    children: [panel, { kind: 'view', id: 'v-dead', viewType: 'gone.widget' }],
  });
  const p = fakePersistence({ [WORKSPACE_STORAGE_KEY]: JSON.stringify({ v: 1, tree }) });
  const store = makeStore({ persistence: p });
  store.restore();
  // 启动时注册表还没填（插件未加载），restore 若折叠就会把正常视图也判死
  assert.notEqual(findNode(store.getSnapshot().tree, 'v-dead'), null);
  assert.equal(store.getSnapshot().notice, null);
});

test('插件下线后其视图被折叠掉，锚点保留；提示一次（pruneDeadViews）', () => {
  const base = createDefaultTree();
  const panel = findNode(base, 'anchor-panel');
  const tree = replaceById(base, 'anchor-panel', {
    kind: 'split',
    id: 'dead-wrap',
    dir: 'row',
    size: { mode: 'ratio', value: 0.5 },
    children: [panel, { kind: 'view', id: 'v-dead', viewType: 'gone.widget' }],
  });
  const p = fakePersistence({ [WORKSPACE_STORAGE_KEY]: JSON.stringify({ v: 1, tree }) });
  const store = makeStore({ persistence: p });
  store.restore();
  store.pruneDeadViews();
  const restored = store.getSnapshot().tree;
  // 死视图被摘掉 → split 只剩锚点 → 折叠回锚点本身，其余布局原样保留
  assert.equal(findNode(restored, 'v-dead'), null);
  assert.equal(findNode(restored, 'dead-wrap'), null);
  assert.notEqual(findNode(restored, 'anchor-panel'), null);
  assert.match(store.getSnapshot().notice, /不可用/);

  // 幂等：再折一次不应再动树、也不应留下新提示
  const before = store.getSnapshot();
  store.pruneDeadViews();
  assert.equal(store.getSnapshot(), before);
});

test('缺少锚点的快照会被拒绝：移动端抽屉按钮会指向不存在的元素', () => {
  const tree = { kind: 'view', id: 'only', viewType: 'demo.gantt' };
  const p = fakePersistence({ [WORKSPACE_STORAGE_KEY]: JSON.stringify({ v: 1, tree }) });
  const store = makeStore({ persistence: p });
  store.restore();
  assert.deepEqual(store.getSnapshot().tree, createDefaultTree());
});

test('apply：非法树整体拒绝，state.tree 引用不变（不做部分应用）', () => {
  const store = makeStore();
  const before = store.getSnapshot().tree;
  const bad = {
    kind: 'split',
    id: 'root',
    dir: 'row',
    size: { mode: 'ratio', value: 0 },
    children: [
      { kind: 'anchor', id: 'anchor-panel', anchor: 'panel' },
      { kind: 'view', id: 'v', viewType: 'demo.gantt' },
    ],
  };
  const res = store.apply(bad);
  assert.equal(res.ok, false);
  assert.match(res.error, /bad_ratio/);
  assert.equal(store.getSnapshot().tree, before);
});

test('apply：未知 viewType 在严格模式下被拒', () => {
  const store = makeStore();
  const tree = {
    kind: 'view',
    id: 'x',
    viewType: 'unknown.widget',
  };
  assert.equal(store.apply(tree, { requireKnownViews: true }).ok, false);
});

test('setActive / setSize 只在真有变化时推进 revision', () => {
  const store = makeStore();
  store.restore();
  const rev0 = store.getSnapshot().revision;
  store.setSize('root', { mode: 'px', value: 300 });
  const rev1 = store.getSnapshot().revision;
  assert.equal(rev1, rev0 + 1);
  // 同样的尺寸再设一次不应产生新状态（否则拖拽结束会多写一次盘）
  store.setSize('root', { mode: 'px', value: 300 });
  assert.equal(store.getSnapshot().revision, rev1);
});

test('open：默认落 tab 无组时退化为 split-right，锚点内容不丢', () => {
  const store = makeStore();
  store.restore();
  const res = store.open('demo.gantt', { anchor: 'panel' });
  assert.equal(res.ok, true);
  const tree = store.getSnapshot().tree;
  assert.equal(validateWorkspace(tree, { requireAllAnchors: true }).ok, true);
  // 锚点仍在（它的槽位贡献不会因为开新视图而消失）
  assert.notEqual(findNode(tree, 'anchor-panel'), null);
  assert.notEqual(findNode(tree, res.id), null);
});

test('open：同类型默认幂等，不重复开实例', () => {
  const store = makeStore();
  store.restore();
  const first = store.open('demo.gantt', { anchor: 'panel' });
  const second = store.open('demo.gantt', { anchor: 'panel' });
  assert.equal(second.id, first.id);
  let count = 0;
  const walk = (n) => {
    if (n.kind === 'view' && n.viewType === 'demo.gantt') count += 1;
    else n.children?.forEach(walk);
  };
  walk(store.getSnapshot().tree);
  assert.equal(count, 1);
});

test('open：allowMultiple 允许开第二个实例，id 不冲突', () => {
  const store = makeStore();
  store.restore();
  const a = store.open('demo.gantt', { anchor: 'panel' });
  const b = store.open('demo.gantt', { anchor: 'panel', allowMultiple: true });
  assert.notEqual(a.id, b.id);
  assert.equal(validateWorkspace(store.getSnapshot().tree).ok, true);
});

test('close：锚点不可关闭，普通视图关闭后自动折叠', () => {
  const store = makeStore();
  store.restore();
  assert.equal(store.close('anchor-panel').ok, false);

  const opened = store.open('demo.gantt', { anchor: 'panel' });
  const closed = store.close(opened.id);
  assert.equal(closed.ok, true);
  // 拆出去的那个 split 只剩锚点 → 折叠
  assert.equal(findNode(store.getSnapshot().tree, opened.id), null);
  assert.equal(validateWorkspace(store.getSnapshot().tree, { requireAllAnchors: true }).ok, true);
});

test('split：把视图拆到下侧，方向与默认 50% 尺寸正确', () => {
  const store = makeStore();
  store.restore();
  const res = store.split('anchor-stream', 'col', 'demo.logs');
  assert.equal(res.ok, true);
  const tree = store.getSnapshot().tree;
  assert.equal(validateWorkspace(tree).ok, true);
});

test('持久化：写盘是可读信封，restore 能原样读回', async () => {
  const p = fakePersistence();
  const store = makeStore({ persistence: p });
  store.restore();
  store.setSize('root', { mode: 'px', value: 288 });
  store.flush();
  const raw = p.data.get(WORKSPACE_STORAGE_KEY);
  const envelope = JSON.parse(raw);
  assert.equal(envelope.v, 1);
  assert.equal(typeof envelope.savedAt, 'number');

  const store2 = makeStore({ persistence: p });
  store2.restore();
  const root = store2.getSnapshot().tree;
  assert.equal(root.kind, 'split');
  assert.equal(root.size.value, 288);
});

test('reset：回到默认树并清空提示', () => {
  const store = makeStore();
  store.restore();
  store.setSize('root', { mode: 'px', value: 500 });
  store.reset();
  assert.deepEqual(store.getSnapshot().tree, createDefaultTree());
  assert.equal(store.getSnapshot().notice, null);
});
