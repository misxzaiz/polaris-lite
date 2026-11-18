/**
 * 工作区树校验器回归测试。
 *
 * 校验器是「布局可以交给插件」这个前提的唯一保险。它一旦失效，插件就能用一棵
 * 深 10 万层的树、一条 NaN 比例、或一个悬空的 tabs.active 把宿主卡死或搞白屏，
 * 而且这些树会被持久化——下次启动继续崩，用户无法自救。所以这里覆盖的是
 * **负例矩阵**而不是"能跑通"。
 *
 * 纯函数、零 DOM、零 React，直接跑 TS 源码。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WORKSPACE_LIMITS,
  validateWorkspace,
  flattenLeaves,
  findNode,
  collectViewTypes,
} from '../src/core/workspace/schema.ts';

/** 构造一棵合法的三层树：split(row) → [view, tabs[view, view]] */
function validTree() {
  return {
    kind: 'split',
    id: 'root',
    dir: 'row',
    size: { mode: 'px', value: 252 },
    children: [
      { kind: 'view', id: 'sessions', viewType: 'chat-lite.sessions' },
      {
        kind: 'tabs',
        id: 'right',
        active: 'panel',
        children: [
          { kind: 'view', id: 'panel', viewType: 'model-admin.panel' },
          { kind: 'view', id: 'caps', viewType: 'cap-panel.panel' },
        ],
      },
    ],
  };
}

test('合法树通过校验，并统计节点 / 叶子 / 深度', () => {
  const r = validateWorkspace(validTree());
  assert.equal(r.ok, true);
  assert.equal(r.stats.nodes, 5); // split + view + tabs + 两个 view
  assert.equal(r.stats.leaves, 3);
  assert.equal(r.stats.depth, 2);
});

test('非对象 / 数组 / null 一律拒绝', () => {
  for (const bad of [null, undefined, 0, 'tree', [], [validTree()]]) {
    const r = validateWorkspace(bad);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'not_object');
    assert.equal(r.path, 'root');
  }
});

test('未知节点类型与危险键拒绝（防原型污染）', () => {
  const badKind = validateWorkspace({ kind: 'grid', id: 'g' });
  assert.equal(badKind.code, 'bad_kind');

  const proto = validateWorkspace({ kind: 'view', id: 'v', viewType: 'a.b', __proto__: { polluted: 1 } });
  // 字面量里的 __proto__ 会改变原型而不是成为键；显式构造才能测到
  const explicit = Object.create(null);
  explicit.kind = 'view';
  explicit.id = 'v';
  explicit.viewType = 'a.b';
  explicit.constructor = {};
  assert.equal(proto.ok === true || proto.ok === false, true);
  assert.equal(validateWorkspace(explicit).code, 'forbidden_key');
});

test('split 必须恰好两个子节点（多栏要嵌套）', () => {
  const three = {
    kind: 'split',
    id: 's',
    dir: 'row',
    size: { mode: 'ratio', value: 0.3 },
    children: [
      { kind: 'view', id: 'a', viewType: 'a.a' },
      { kind: 'view', id: 'b', viewType: 'b.b' },
      { kind: 'view', id: 'c', viewType: 'c.c' },
    ],
  };
  const r = validateWorkspace(three);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'bad_children');

  const one = { ...three, children: [{ kind: 'view', id: 'a', viewType: 'a.a' }] };
  assert.equal(validateWorkspace(one).code, 'bad_children');
});

test('比例必须是有限数且夹在合法区间（0 / NaN / Infinity 会让窗格塌陷或幽灵挂载）', () => {
  const withRatio = (value) => ({
    kind: 'split',
    id: 's',
    dir: 'row',
    size: { mode: 'ratio', value },
    children: [
      { kind: 'view', id: 'a', viewType: 'a.a' },
      { kind: 'view', id: 'b', viewType: 'b.b' },
    ],
  });

  for (const bad of [0, 1, -0.1, 1e9, Number.NaN, Number.POSITIVE_INFINITY]) {
    const r = validateWorkspace(withRatio(bad));
    assert.equal(r.ok, false, `ratio=${bad} 应被拒绝`);
    assert.ok(['bad_ratio', 'bad_size'].includes(r.code), `ratio=${bad} 的错误码是 ${r.code}`);
  }

  const okMin = validateWorkspace(withRatio(WORKSPACE_LIMITS.minRatio));
  const okMax = validateWorkspace(withRatio(WORKSPACE_LIMITS.maxRatio));
  assert.equal(okMin.ok, true);
  assert.equal(okMax.ok, true);
});

test('固定像素尺寸越界拒绝（>2000px 的侧栏会把窗口顶爆）', () => {
  const withPx = (value) => ({
    kind: 'split',
    id: 's',
    dir: 'row',
    size: { mode: 'px', value },
    children: [
      { kind: 'view', id: 'a', viewType: 'a.a' },
      { kind: 'view', id: 'b', viewType: 'b.b' },
    ],
  });
  assert.equal(validateWorkspace(withPx(10)).code, 'bad_px');
  assert.equal(validateWorkspace(withPx(99999)).code, 'bad_px');
  assert.equal(validateWorkspace(withPx(252)).ok, true);
});

test('tabs.active 必须指向直接子节点 id（悬空会让整组没有选中项）', () => {
  const tree = validTree();
  tree.children[1].active = 'ghost';
  const r = validateWorkspace(tree);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'bad_active');
  assert.equal(r.path, 'root.children[1].active');
});

test('tabs 单子项与 tabs 嵌套 tabs 都拒绝', () => {
  const single = {
    kind: 'tabs',
    id: 't',
    active: 'a',
    children: [{ kind: 'view', id: 'a', viewType: 'a.a' }],
  };
  assert.equal(validateWorkspace(single).code, 'bad_children');

  const nested = {
    kind: 'tabs',
    id: 't',
    active: 'inner',
    children: [
      {
        kind: 'tabs',
        id: 'inner',
        active: 'a',
        children: [
          { kind: 'view', id: 'a', viewType: 'a.a' },
          { kind: 'view', id: 'b', viewType: 'b.b' },
        ],
      },
      { kind: 'view', id: 'c', viewType: 'c.c' },
    ],
  };
  assert.equal(validateWorkspace(nested).code, 'bad_children');
});

test('view 节点不得携带 children', () => {
  const r = validateWorkspace({
    kind: 'view',
    id: 'v',
    viewType: 'a.b',
    children: [{ kind: 'view', id: 'x', viewType: 'x.x' }],
  });
  assert.equal(r.code, 'bad_children');
});

test('节点 id 必须合法且全树唯一', () => {
  const badId = validateWorkspace({ kind: 'view', id: 'Bad Id!', viewType: 'a.b' });
  assert.equal(badId.code, 'bad_id');

  const dup = {
    kind: 'split',
    id: 'root',
    dir: 'row',
    size: { mode: 'ratio', value: 0.5 },
    children: [
      { kind: 'view', id: 'same', viewType: 'a.a' },
      { kind: 'view', id: 'same', viewType: 'b.b' },
    ],
  };
  assert.equal(validateWorkspace(dup).code, 'duplicate_id');
});

test('循环引用被拦下（applyTree 收到活对象时可能成环）', () => {
  const a = {
    kind: 'split',
    id: 'a',
    dir: 'row',
    size: { mode: 'ratio', value: 0.5 },
    children: [],
  };
  a.children = [a, { kind: 'view', id: 'b', viewType: 'b.b' }];
  const r = validateWorkspace(a);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'cycle');
});

test('深度 / 叶子 / 节点数上限生效（超深树会让下一次启动继续崩）', () => {
  // 逐层套 split，直到超过 maxDepth
  let deep = { kind: 'view', id: 'leaf', viewType: 'a.a' };
  for (let i = 0; i < WORKSPACE_LIMITS.maxDepth + 1; i += 1) {
    deep = {
      kind: 'split',
      id: `s${i}`,
      dir: 'col',
      size: { mode: 'ratio', value: 0.5 },
      children: [deep, { kind: 'view', id: `v${i}`, viewType: 'a.a' }],
    };
  }
  assert.equal(validateWorkspace(deep).code, 'depth_exceeded');

  // 叶子超限：一个 tabs 装不下（maxTabsChildren 更小），用 split 链堆叶子
  let wide = { kind: 'view', id: 'l0', viewType: 'a.a' };
  for (let i = 1; i <= WORKSPACE_LIMITS.maxLeaves; i += 1) {
    wide = {
      kind: 'split',
      id: `w${i}`,
      dir: 'row',
      size: { mode: 'ratio', value: 0.5 },
      children: [wide, { kind: 'view', id: `l${i}`, viewType: 'a.a' }],
    };
  }
  const wideResult = validateWorkspace(wide);
  assert.equal(wideResult.ok, false);
  assert.ok(['too_many_leaves', 'too_many_nodes', 'depth_exceeded'].includes(wideResult.code));
});

test('requireKnownViews 开启时拒绝未注册的视图类型', () => {
  const tree = validTree();
  const known = new Set(['chat-lite.sessions', 'model-admin.panel']);
  const r = validateWorkspace(tree, { knownViewTypes: known, requireKnownViews: true });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'bad_view_type');
  assert.match(r.path, /children\[1\]\.children\[1\]/);

  const relaxed = validateWorkspace(tree, { knownViewTypes: known });
  assert.equal(relaxed.ok, true);
});

test('flattenLeaves 按深度优先给出稳定顺序（移动端单列降级依赖它）', () => {
  const leaves = flattenLeaves(validTree());
  assert.deepEqual(
    leaves.map((l) => l.id),
    ['sessions', 'panel', 'caps'],
  );
});

test('findNode / collectViewTypes 支持孤儿诊断', () => {
  const tree = validTree();
  assert.equal(findNode(tree, 'caps')?.viewType, 'cap-panel.panel');
  assert.equal(findNode(tree, 'nope'), null);
  assert.deepEqual(
    [...collectViewTypes(tree)].sort(),
    ['cap-panel.panel', 'chat-lite.sessions', 'model-admin.panel'],
  );
});
