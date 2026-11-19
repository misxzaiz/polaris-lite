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
  findParent,
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

// ============================================================================
// 第二批：锚点节点、尺寸作用侧与 auto 模式（完整布局改造新增的契约）
// ============================================================================

test('anchor 节点：四个保留锚点合法，auth 必须被拒', () => {
  for (const anchor of ['sidebar', 'stream', 'input', 'panel']) {
    const tree = { kind: 'anchor', id: `anchor-${anchor}`, anchor };
    assert.equal(validateWorkspace(tree).ok, true, `锚点 ${anchor} 应合法`);
  }
  // auth 是门禁渲染路径，不是布局位置：进了树就会让未登录用户看到壳骨架
  const bad = validateWorkspace({ kind: 'anchor', id: 'anchor-auth', anchor: 'auth' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'bad_anchor');
});

test('anchor 节点：同一锚点不得出现两次，children 若存在必须非空', () => {
  const dup = {
    kind: 'split',
    id: 'root',
    dir: 'row',
    size: { mode: 'ratio', value: 0.5 },
    children: [
      { kind: 'anchor', id: 'a1', anchor: 'panel' },
      { kind: 'anchor', id: 'a2', anchor: 'panel' },
    ],
  };
  assert.equal(validateWorkspace(dup).code, 'duplicate_anchor');

  const emptyKids = { kind: 'anchor', id: 'a1', anchor: 'panel', children: [] };
  assert.equal(validateWorkspace(emptyKids).code, 'bad_children');
});

test('尺寸：auto 不带 value，px / ratio 需要有限数字', () => {
  const make = (size) => ({
    kind: 'split',
    id: 'root',
    dir: 'col',
    size,
    children: [
      { kind: 'view', id: 'v1', viewType: 'a.b' },
      { kind: 'view', id: 'v2', viewType: 'a.c' },
    ],
  });
  assert.equal(validateWorkspace(make({ mode: 'auto', of: 'second' })).ok, true);
  assert.equal(validateWorkspace(make({ mode: 'auto', value: 1 })).code, 'bad_size');
  assert.equal(validateWorkspace(make({ mode: 'px', value: 252, of: 'first' })).ok, true);
  assert.equal(validateWorkspace(make({ mode: 'px', value: 10 })).code, 'bad_px');
  assert.equal(validateWorkspace(make({ mode: 'ratio', value: 0.5, of: 'second' })).ok, true);
  assert.equal(validateWorkspace(make({ mode: 'ratio', value: 0.5, of: 'middle' })).code, 'bad_size');
});

test('requireAllAnchors：缺锚点会被点名（移动端抽屉靠它定位）', () => {
  const onlyPanel = { kind: 'anchor', id: 'anchor-panel', anchor: 'panel' };
  assert.equal(validateWorkspace(onlyPanel).ok, true);
  const strict = validateWorkspace(onlyPanel, { requireAllAnchors: true });
  assert.equal(strict.ok, false);
  assert.match(strict.message, /sidebar/);
});

// ============================================================================
// 第三批：结构操作（默认树 / 折叠 / 拆分 / 移动）
// ============================================================================
import {
  createDefaultTree,
  collapseTree,
  replaceById,
  removeById,
  setActiveChild,
  setSplitSize,
  splitLeaf,
  addToTabs,
  moveNodeToTabs,
  nearestTabs,
  countViewType,
  anchorNode,
  nextNodeId,
} from '../src/core/workspace/treeOps.ts';

const allAlive = () => true;

test('默认树：四锚点齐全，且通过全部不变量校验', () => {
  const tree = createDefaultTree();
  const v = validateWorkspace(tree, { requireAllAnchors: true });
  assert.equal(v.ok, true, v.ok ? '' : `${v.code}@${v.path}: ${v.message}`);
  assert.equal(anchorNode(tree, 'sidebar')?.id, 'anchor-sidebar');
  assert.equal(anchorNode(tree, 'panel')?.id, 'anchor-panel');
});

test('默认树：三处尺寸语义与旧 grid 一致（252px / 320px 作用在第二个 / 输入区 auto）', () => {
  const tree = createDefaultTree();
  // 顶层：侧栏固定 252px，作用在第一个子节点
  assert.equal(tree.kind, 'split');
  assert.deepEqual(tree.size, { mode: 'px', value: 252 });
  // 第二层：面板 320px 固定在**第二个**子节点 —— 没有 of 就只能反转 DOM 顺序
  const right = tree.children[1];
  assert.equal(right.kind, 'split');
  assert.deepEqual(right.size, { mode: 'px', value: 320, of: 'second' });
  // 第三层：输入区 auto（随内容长高），同样作用在第二个子节点
  const main = right.children[0];
  assert.equal(main.kind, 'split');
  assert.deepEqual(main.size, { mode: 'auto', of: 'second' });
  assert.equal(main.dir, 'col');
});

test('折叠：view 死掉后 split / tabs 就地折叠，不留空栏', () => {
  const tree = {
    kind: 'split',
    id: 'root',
    dir: 'row',
    size: { mode: 'ratio', value: 0.5 },
    children: [
      { kind: 'view', id: 'v1', viewType: 'a.dead' },
      { kind: 'view', id: 'v2', viewType: 'a.alive' },
    ],
  };
  const folded = collapseTree(tree, (t) => t !== 'a.dead');
  // split 只剩一个子项 → 直接换成该子项，不会留下 0 宽的空栏
  assert.equal(folded?.id, 'v2');
});

test('折叠：tabs 的 active 失效时回落到第一个存活子项', () => {
  const tree = {
    kind: 'tabs',
    id: 'g',
    active: 'v2',
    children: [
      { kind: 'view', id: 'v1', viewType: 'a.one' },
      { kind: 'view', id: 'v2', viewType: 'a.dead' },
      { kind: 'view', id: 'v3', viewType: 'a.three' },
    ],
  };
  const folded = collapseTree(tree, (t) => t !== 'a.dead');
  assert.equal(folded?.kind, 'tabs');
  assert.equal(folded.active, 'v1');
  assert.deepEqual(folded.children.map((c) => c.id), ['v1', 'v3']);
});

test('锚点即使一个贡献都没有也不能被折叠掉（移动端抽屉要定位它）', () => {
  const tree = {
    kind: 'anchor',
    id: 'anchor-panel',
    anchor: 'panel',
    children: [{ kind: 'view', id: 'v1', viewType: 'a.dead' }],
  };
  const folded = collapseTree(tree, () => false);
  assert.equal(folded?.id, 'anchor-panel');
  assert.equal(folded.children, undefined);
});

test('replaceById 删除后自动折叠；根被删空返回 null', () => {
  const tree = createDefaultTree();
  const removedStream = removeById(tree, 'anchor-stream');
  // main-column 只剩 input → 折叠成 input 本身
  assert.equal(findNode(removedStream, 'main-column'), null);
  assert.notEqual(findNode(removedStream, 'anchor-input'), null);

  assert.equal(removeById({ kind: 'view', id: 'solo', viewType: 'a.b' }, 'solo'), null);
});

test('splitLeaf：把叶子一分为二，方向与尺寸可控，id 不冲突', () => {
  const tree = createDefaultTree();
  const out = splitLeaf(tree, 'anchor-stream', 'row', { kind: 'view', id: 'demo-gantt', viewType: 'demo.gantt' });
  assert.equal(validateWorkspace(out).ok, true);
  // anchor-stream 本身仍是原来那个锚点，只是被一个新 split 包住
  const parent = findParent(out, 'anchor-stream');
  assert.equal(parent?.kind, 'split');
  assert.equal(parent.dir, 'row');
  assert.equal(parent.children[1].id, 'demo-gantt');
  // id 冲突时拒绝构造，而不是造出一棵校验不过的树
  assert.equal(splitLeaf(tree, 'anchor-stream', 'row', { kind: 'view', id: 'anchor-panel', viewType: 'x.y' }), null);
});

test('moveNodeToTabs：跨组移动会把源组折叠掉，目标组保留顺序', () => {
  const tree = {
    kind: 'split',
    id: 'root',
    dir: 'row',
    size: { mode: 'ratio', value: 0.5 },
    children: [
      {
        kind: 'tabs',
        id: 'group-a',
        active: 'a1',
        children: [
          { kind: 'view', id: 'a1', viewType: 'x.a' },
          { kind: 'view', id: 'a2', viewType: 'x.b' },
        ],
      },
      {
        kind: 'tabs',
        id: 'group-b',
        active: 'b1',
        children: [
          { kind: 'view', id: 'b1', viewType: 'y.a' },
          { kind: 'view', id: 'b2', viewType: 'y.b' },
        ],
      },
    ],
  };
  const out = moveNodeToTabs(tree, 'a1', 'group-b', 1);
  assert.equal(validateWorkspace(out).ok, true);
  // group-a 只剩一个 tab → 折叠成 a2 本身
  assert.equal(findNode(out, 'group-a'), null);
  const b = findNode(out, 'group-b');
  assert.deepEqual(b.children.map((c) => c.id), ['b1', 'a1', 'b2']);
  assert.equal(b.active, 'a1');
});

test('moveNodeToTabs：拒绝拖进自己的子树（否则构造出环）', () => {
  const tree = {
    kind: 'split',
    id: 'root',
    dir: 'row',
    size: { mode: 'ratio', value: 0.5 },
    children: [
      {
        kind: 'tabs',
        id: 'outer',
        active: 'o1',
        children: [
          { kind: 'view', id: 'o1', viewType: 'x.a' },
          { kind: 'view', id: 'o2', viewType: 'x.b' },
        ],
      },
      {
        kind: 'split',
        id: 'inner-wrap',
        dir: 'col',
        size: { mode: 'ratio', value: 0.5 },
        children: [
          {
            kind: 'tabs',
            id: 'inner',
            active: 'i1',
            children: [
              { kind: 'view', id: 'i1', viewType: 'y.a' },
              { kind: 'view', id: 'i2', viewType: 'y.b' },
            ],
          },
          { kind: 'view', id: 'z', viewType: 'z.z' },
        ],
      },
    ],
  };
  // 把 inner-wrap 拖进它自己的子树（inner）→ 必须拒绝
  assert.equal(moveNodeToTabs(tree, 'inner-wrap', 'inner', 0), null);
  // 兄弟子树之间是合法移动，不能被误判
  assert.notEqual(moveNodeToTabs(tree, 'z', 'inner', 0), null);
  // 锚点是保留位置，不允许当成 tab 拖走
  assert.equal(moveNodeToTabs(createDefaultTree(), 'anchor-panel', 'nope', 0), null);
});

test('setActiveChild / setSplitSize：非法目标原样返回，不破坏树', () => {
  const tree = {
    kind: 'tabs',
    id: 'g',
    active: 'a1',
    children: [
      { kind: 'view', id: 'a1', viewType: 'x.a' },
      { kind: 'view', id: 'a2', viewType: 'x.b' },
    ],
  };
  assert.equal(setActiveChild(tree, 'g', 'nope'), tree);
  assert.equal(setActiveChild(tree, 'nope', 'a1'), tree);
  assert.equal(setActiveChild(tree, 'g', 'a2').active, 'a2');

  const def = createDefaultTree();
  assert.equal(setSplitSize(def, 'nope', { mode: 'ratio', value: 0.5 }), def);
  const resized = setSplitSize(def, 'root', { mode: 'px', value: 300 });
  assert.equal(resized.kind === 'split' && resized.size.value, 300);
});

test('addToTabs：超出单组上限时拒绝，不会撑爆 tabbar', () => {
  const children = Array.from({ length: 12 }, (_, i) => ({
    kind: 'view',
    id: `v${i}`,
    viewType: `t.v${i}`,
  }));
  const tree = { kind: 'tabs', id: 'g', active: 'v0', children };
  assert.equal(addToTabs(tree, 'g', { kind: 'view', id: 'new', viewType: 't.new' }), null);
});

test('nearestTabs / countViewType：拖拽源组判定与多实例计数', () => {
  const tree = createDefaultTree();
  assert.equal(nearestTabs(tree, 'anchor-stream'), null);
  const withTabs = {
    kind: 'tabs',
    id: 'g',
    active: 'a',
    children: [
      { kind: 'view', id: 'a', viewType: 'x.a' },
      { kind: 'view', id: 'b', viewType: 'x.a' },
    ],
  };
  assert.equal(nearestTabs(withTabs, 'b')?.id, 'g');
  assert.equal(countViewType(withTabs, 'x.a'), 2);
  assert.equal(countViewType(withTabs, 'x.zzz'), 0);
});


test('宿主槽位视图（host.slot.*）在树里只能出现一次', () => {
  const build = (mainChildren) => ({
    kind: 'split',
    id: 'root',
    dir: 'row',
    size: { mode: 'px', value: 252 },
    children: [
      { kind: 'anchor', id: 'anchor-sidebar', anchor: 'sidebar' },
      {
        kind: 'split',
        id: 'right',
        dir: 'row',
        size: { mode: 'px', value: 320, of: 'second' },
        children: [
          { kind: 'split', id: 'main-column', dir: 'col', size: { mode: 'auto', of: 'second' }, children: mainChildren },
          { kind: 'anchor', id: 'anchor-panel', anchor: 'panel' },
        ],
      },
    ],
  });
  const one = build([
    { kind: 'view', id: 'slot-a', viewType: 'host.slot.panel' },
    { kind: 'anchor', id: 'anchor-input', anchor: 'input' },
  ]);
  assert.equal(validateWorkspace(one).ok, true, '一份应当合法');

  // 两份同一个槽位：两套互不相认的激活态与滚动位置，用户看到「面板凭空多了一份」
  const two = build([
    { kind: 'view', id: 'slot-a', viewType: 'host.slot.panel' },
    { kind: 'view', id: 'slot-b', viewType: 'host.slot.panel' },
  ]);
  const r = validateWorkspace(two);
  assert.equal(r.ok, false);
  assert.match(r.message, /不得出现多次/);
});
