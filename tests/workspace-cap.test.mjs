/**
 * `cap.ui.layout` 处理器回归测试。
 *
 * 布局是**跨插件共享的可变状态**，所以这里测的重点不是「能不能开视图」，而是
 * **谁能动谁的东西**：无授权的视图不能开、别人的视图不能关、整体替换布局需要二级权限。
 * 这些规则一旦漏掉，任何插件都能把审计面板关掉、把别人的面板挤到角落。
 *
 * 直接调用处理器（不经总线）可以精确断言「拒绝」与「放行」，总线那层已有 core.test.mjs 覆盖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceStore } from '../plugins/workspace-layout/store.ts';
import { ViewRegistry } from '../src/core/workspace/viewRegistry.ts';
import { createLayoutHandler, CAP_UI_LAYOUT, CAP_UI_LAYOUT_GLOBAL } from '../plugins/workspace-layout/layoutCap.ts';
import { createDefaultTree, replaceById } from '../plugins/workspace-layout/treeOps.ts';
import { findNode, validateWorkspace } from '../plugins/sdk/schema.ts';

function setup() {
  const registry = new ViewRegistry();
  registry.register({ viewType: 'demo.gantt', pluginId: 'demo', component: 'Gantt', title: '甘特' });
  registry.register({ viewType: 'demo.logs', pluginId: 'demo', component: 'Logs', title: '日志' });
  registry.register({ viewType: 'other.widget', pluginId: 'other', component: 'Widget', title: '别人的' });

  const store = new WorkspaceStore({
    persistence: null,
    isAliveViewType: (t) => registry.has(t),
    knownViewTypes: () => registry.types(),
  });
  store.restore();
  const handler = createLayoutHandler({ store, registry });
  const call = (action, payload, ctx) => handler({ target: CAP_UI_LAYOUT, action, payload }, ctx);
  return { store, registry, handler, call };
}

const demo = (extra = []) => ({ pluginId: 'demo', capabilities: [CAP_UI_LAYOUT, ...extra] });
const other = (extra = []) => ({ pluginId: 'other', capabilities: [CAP_UI_LAYOUT, ...extra] });

test('getTree 返回深拷贝：插件改返回值不会污染宿主状态', () => {
  const { store, call } = setup();
  const tree = call('getTree', undefined, demo());
  assert.deepEqual(tree, createDefaultTree());
  tree.id = 'hacked';
  assert.equal(store.getSnapshot().tree.id, 'root');
});

test('listViews 只暴露元信息，不暴露组件实现', () => {
  const { call } = setup();
  const views = call('listViews', undefined, demo());
  assert.equal(views.length, 3);
  assert.deepEqual(Object.keys(views[0]).sort(), ['pluginId', 'title', 'viewType']);
});

test('open：未注册的 viewType 被拒', () => {
  const { call } = setup();
  assert.throws(() => call('open', { viewType: 'nope.view' }, demo()), /未注册/);
});

test('open：开别人的视图需要 cap.ui.layout.global', () => {
  const { call } = setup();
  assert.throws(() => call('open', { viewType: 'other.widget' }, demo()), /无权打开他人视图/);
  // 拿到二级权限后放行
  const res = call('open', { viewType: 'other.widget' }, demo([CAP_UI_LAYOUT_GLOBAL]));
  assert.ok(res.id);
});

test('open：自己的视图可以开，落位后树仍合法', () => {
  const { store, call } = setup();
  const res = call('open', { viewType: 'demo.gantt', anchor: 'panel' }, demo());
  const tree = store.getSnapshot().tree;
  assert.equal(validateWorkspace(tree, { requireAllAnchors: true }).ok, true);
  assert.notEqual(findNode(tree, res.id), null);
});

test('open：where / anchor 参数非法时给出明确错误，而不是静默回落', () => {
  const { call } = setup();
  assert.throws(() => call('open', { viewType: 'demo.gantt', where: 'floating' }, demo()), /where/);
  assert.throws(() => call('open', { viewType: 'demo.gantt', anchor: 'auth' }, demo()), /anchor/);
  assert.throws(() => call('open', {}, demo()), /viewType/);
});

test('close：别人的视图被拒，自己的放行', () => {
  const { store, call } = setup();
  const opened = call('open', { viewType: 'other.widget', anchor: 'panel' }, other());
  assert.throws(() => call('close', { nodeId: opened.id }, demo()), /无权操作他人视图/);
  assert.equal(call('close', { nodeId: opened.id }, other()), undefined);
  assert.equal(findNode(store.getSnapshot().tree, opened.id), null);
});

test('close：锚点是保留位置，谁都关不掉（含全局权限）', () => {
  const { call } = setup();
  assert.throws(() => call('close', { nodeId: 'anchor-panel' }, demo([CAP_UI_LAYOUT_GLOBAL])), /锚点/);
});

test('split：目标不存在 / 视图未注册都要有明确错误', () => {
  const { call } = setup();
  assert.throws(() => call('split', { nodeId: 'nope', viewType: 'demo.gantt' }, demo()), /节点不存在/);
  assert.throws(() => call('split', { nodeId: 'anchor-stream', viewType: 'zzz.zzz' }, demo()), /未注册/);
});

test('move：目标不是 tabs 组时被拒（而不是把节点弄丢）', () => {
  const { store, call } = setup();
  const opened = call('open', { viewType: 'demo.gantt', anchor: 'panel' }, demo());
  const before = store.getSnapshot().tree;
  assert.throws(() => call('move', { nodeId: opened.id, tabsId: 'anchor-stream', index: 0 }, demo()), /目标不是 tabs 组/);
  assert.equal(store.getSnapshot().tree, before);
});

test('applyTree：需要二级权限，且必须是合法树 + 已注册视图', () => {
  const { store, call } = setup();
  assert.throws(() => call('applyTree', { tree: createDefaultTree() }, demo()), /global/);

  // 未注册视图 → 拒绝
  const bad = {
    ...createDefaultTree(),
    children: [
      { kind: 'anchor', id: 'anchor-sidebar', anchor: 'sidebar' },
      {
        ...createDefaultTree().children[1],
        children: [
          {
            kind: 'tabs',
            id: 'g',
            active: 'x',
            children: [
              { kind: 'view', id: 'x', viewType: 'ghost.view' },
              { kind: 'view', id: 'y', viewType: 'demo.gantt' },
            ],
          },
          { kind: 'anchor', id: 'anchor-panel', anchor: 'panel' },
        ],
      },
    ],
  };
  assert.throws(() => call('applyTree', { tree: bad }, demo([CAP_UI_LAYOUT_GLOBAL])), /未注册/);
  assert.equal(store.getSnapshot().tree.id, 'root');
});

test('reset：需要二级权限（它会把别人的视图一起清掉）', () => {
  const { call } = setup();
  assert.throws(() => call('reset', undefined, demo()), /global/);
  assert.equal(call('reset', undefined, demo([CAP_UI_LAYOUT_GLOBAL])), undefined);
});

test('未知动作直接报错，不静默 no-op（静默失败最难排查）', () => {
  const { call } = setup();
  assert.throws(() => call('explode', {}, demo()), /未知布局动作/);
});

test('applyTree：缺锚点的树被拒绝（落盘后下次启动会回默认，不能放行）', () => {
  const { store, call } = setup();
  const noSidebar = {
    kind: 'split',
    id: 'root',
    dir: 'row',
    size: { mode: 'px', value: 252 },
    children: [
      { kind: 'view', id: 'v-a', viewType: 'demo.gantt' },
      {
        kind: 'split',
        id: 'root-main',
        dir: 'row',
        size: { mode: 'px', value: 320, of: 'second' },
        children: [
          { kind: 'split', id: 'main-column', dir: 'col', size: { mode: 'auto', of: 'second' },
            children: [
              { kind: 'anchor', id: 'anchor-stream', anchor: 'stream' },
              { kind: 'anchor', id: 'anchor-input', anchor: 'input' },
            ] },
          { kind: 'anchor', id: 'anchor-panel', anchor: 'panel' },
        ],
      },
    ],
  };
  assert.throws(() => call('applyTree', { tree: noSidebar }, demo([CAP_UI_LAYOUT_GLOBAL])), /缺少必需锚点/);
  assert.equal(store.getSnapshot().tree.id, 'root');
  assert.equal(findNode(store.getSnapshot().tree, 'anchor-sidebar')?.kind, 'anchor');
});

test('split：非法 dir 直接报错，不静默当成 row', () => {
  const { call } = setup();
  assert.throws(() => call('split', { nodeId: 'anchor-stream', dir: 'diagonal', viewType: 'demo.gantt' }, demo()), /dir 只能是/);
});

// ---------------------------------------------------------------------------
// tab 组归属：并入别人的 tab 条 = 借别人的位置获得曝光，必须有闸门
// ---------------------------------------------------------------------------

/** 在面板里放一个 tabs 组（第一个 tab 归属 other，第二个归属 demo） */
function panelWithMixedTabs(store) {
  const panel = findNode(store.getSnapshot().tree, 'anchor-panel');
  const tree = replaceById(store.getSnapshot().tree, 'anchor-panel', {
    ...panel,
    children: [
      {
        kind: 'tabs',
        id: 't-panel',
        active: 'tp-1',
        children: [
          { kind: 'view', id: 'tp-1', viewType: 'other.widget' },
          { kind: 'view', id: 'tp-2', viewType: 'demo.gantt' },
        ],
      },
    ],
  });
  const res = store.apply(tree, { requireKnownViews: true, requireAllAnchors: true });
  assert.equal(res.ok, true);
}

test('open(where:tab)：含他人视图的 tabs 组不能并入', () => {
  const { store, call } = setup();
  panelWithMixedTabs(store);
  const before = JSON.stringify(store.getSnapshot().tree);
  assert.throws(() => call('open', { viewType: 'demo.logs', where: 'tab', anchor: 'panel' }, demo()), /他人视图/);
  assert.equal(JSON.stringify(store.getSnapshot().tree), before);
});

test('move：不能把视图挪进含他人视图的 tabs 组', () => {
  const { store, call } = setup();
  panelWithMixedTabs(store);
  const opened = call('open', { viewType: 'demo.logs', anchor: 'stream' }, demo());
  const before = JSON.stringify(store.getSnapshot().tree);
  assert.throws(() => call('move', { nodeId: opened.id, tabsId: 't-panel', index: 0 }, demo()), /他人视图/);
  assert.equal(JSON.stringify(store.getSnapshot().tree), before);
});

test('move：全局权限可以并入（它是被显式授予的「重排他人布局」）', () => {
  const { store, call } = setup();
  panelWithMixedTabs(store);
  const opened = call('open', { viewType: 'demo.logs', anchor: 'stream' }, demo());
  assert.equal(call('move', { nodeId: opened.id, tabsId: 't-panel', index: 0 }, demo([CAP_UI_LAYOUT_GLOBAL])), undefined);
});

test('结构视图（host.slot.*）不能被关闭 / 拆分 / 移动', () => {
  const { store, call } = setup();
  const panel = findNode(store.getSnapshot().tree, 'anchor-panel');
  const tree = replaceById(store.getSnapshot().tree, 'anchor-panel', {
    ...panel,
    children: [
      { kind: 'view', id: 'slot-panel', viewType: 'host.slot.panel' },
      { kind: 'view', id: 'mine', viewType: 'demo.gantt' },
    ],
  });
  assert.equal(store.apply(tree, { requireAllAnchors: true }).ok, true);
  assert.throws(() => call('close', { nodeId: 'slot-panel' }, demo([CAP_UI_LAYOUT_GLOBAL])), /结构视图/);
  assert.throws(() => call('split', { nodeId: 'slot-panel', dir: 'row', viewType: 'demo.logs' }, demo([CAP_UI_LAYOUT_GLOBAL])), /结构视图/);
  assert.throws(() => call('move', { nodeId: 'slot-panel', tabsId: 'nope', index: 0 }, demo([CAP_UI_LAYOUT_GLOBAL])), /结构视图/);
});
