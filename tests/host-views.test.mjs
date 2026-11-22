/**
 * 宿主槽位视图（`host.slot.<anchor>`）回归测试。
 *
 * 这层存在的唯一理由是**组合**：锚点的渲染规则是「有 children 就渲染 children」，
 * 于是插件一旦用 `applyTree` 给面板加 tab，面板里原有的 4 个槽位面板就整片消失。
 * 把槽位内容变成可引用的视图类型，预设才能写出「我的视图和原有面板共处一个 tab 条」。
 *
 * 因此这里测的是三件事：命名空间的映射是双向可逆的、`tab` 落位不会退化成把面板劈两半、
 * 以及结构视图不能被当成普通视图二次打开。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HOST_PLUGIN_ID,
  anchorOfSlotView,
  isHostSlotView,
  registerHostSlotViews,
  setHostViewRegistry,
  slotViewType,
} from '../plugins/workspace-layout/hostViews.ts';
import { viewRegistry } from '../src/core/workspace/viewRegistry.ts';
import { ViewRegistry } from '../src/core/workspace/viewRegistry.ts';
import { WorkspaceStore } from '../plugins/workspace-layout/store.ts';
import { createLayoutHandler, CAP_UI_LAYOUT, CAP_UI_LAYOUT_GLOBAL } from '../plugins/workspace-layout/layoutCap.ts';
import { findNode, validateWorkspace } from '../plugins/sdk/schema.ts';
import { createDefaultTree } from '../plugins/workspace-layout/treeOps.ts';

// ---------- 命名空间 ----------

test('slotViewType / anchorOfSlotView 双向可逆，非法锚点返回 null', () => {
  for (const anchor of ['sidebar', 'stream', 'input', 'panel']) {
    const vt = slotViewType(anchor);
    assert.equal(vt, `host.slot.${anchor}`);
    assert.equal(isHostSlotView(vt), true);
    assert.equal(anchorOfSlotView(vt), anchor);
  }
  assert.equal(anchorOfSlotView('host.slot.auth'), null, 'auth 不是锚点');
  assert.equal(anchorOfSlotView('host.slot.'), null);
  assert.equal(anchorOfSlotView('chat-lite.chat'), null);
  assert.equal(anchorOfSlotView('evilhost.slot.panel'), null, '前缀必须完整匹配');
  assert.equal(isHostSlotView('host.slot'), false);
});

test('registerHostSlotViews 注册 4 个槽位视图，且归属宿主、带可访问名', () => {
  // P2-2:hostViews 迁插件后注册表经注入(setHostViewRegistry);测试用真实 viewRegistry 注入
  setHostViewRegistry({ register: (def) => viewRegistry.register(def) });
  registerHostSlotViews();
  for (const anchor of ['sidebar', 'stream', 'input', 'panel']) {
    const def = viewRegistry.get(slotViewType(anchor));
    assert.ok(def, `${anchor} 槽位视图应已注册`);
    assert.equal(def.pluginId, HOST_PLUGIN_ID);
    assert.ok(def.title.length >= 2 && def.title.length <= 4, 'tab 文本必须短');
    assert.equal(def.defaultAnchor, anchor);
  }
  // 幂等：重复注册不产生重复项
  const before = viewRegistry.list().length;
  registerHostSlotViews();
  assert.equal(viewRegistry.list().length, before);
});

// ---------- tab 落位 ----------

function setup() {
  const registry = new ViewRegistry();
  registry.register({ viewType: 'demo.gantt', pluginId: 'demo', component: 'Gantt', title: '甘特' });
  registry.register({ viewType: 'demo.logs', pluginId: 'demo', component: 'Logs', title: '日志' });
  for (const anchor of ['sidebar', 'stream', 'input', 'panel']) {
    registry.register({
      viewType: slotViewType(anchor),
      pluginId: HOST_PLUGIN_ID,
      component: 'SlotOutlet',
      title: anchor,
      defaultAnchor: anchor,
    });
  }
  const store = new WorkspaceStore({
    persistence: null,
    isAliveViewType: (t) => registry.has(t),
    knownViewTypes: () => registry.types(),
  });
  store.restore();
  return { store, registry };
}

const asPlugin = (extra = []) => ({ pluginId: 'demo', capabilities: [CAP_UI_LAYOUT, ...extra] });

test('open({where:"tab"}) 在空锚点上把槽位内容与新视图装进同一 tabs 组', () => {
  const { store } = setup();
  const res = store.open('demo.gantt', { where: 'tab', anchor: 'panel' });
  assert.equal(res.ok, true);

  const tree = store.getSnapshot().tree;
  assert.equal(validateWorkspace(tree, { requireAllAnchors: true }).ok, true);

  const panel = findNode(tree, 'anchor-panel');
  assert.equal(panel.kind, 'anchor');
  assert.equal(panel.children.length, 1, '不能在面板里再分栏');
  const tabs = panel.children[0];
  assert.equal(tabs.kind, 'tabs');
  assert.equal(tabs.children.length, 2);
  const types = tabs.children.map((c) => c.viewType).sort();
  assert.deepEqual(types, ['demo.gantt', 'host.slot.panel']);
  // 激活项是用户刚打开的那个，而不是回到槽位内容
  assert.equal(tabs.active, res.id);
  // 槽位视图没有关闭按钮（见 isClosable），所以它必须一直能在树里被找到
  assert.ok(tabs.children.some((c) => c.viewType === 'host.slot.panel'));
});

test('open({where:"tab"}) 幂等：第二次开同一视图只聚焦，不新建实例', () => {
  const { store } = setup();
  const first = store.open('demo.gantt', { where: 'tab', anchor: 'panel' });
  const second = store.open('demo.gantt', { where: 'tab', anchor: 'panel' });
  assert.equal(second.id, first.id);
  const tabs = findNode(store.getSnapshot().tree, 'anchor-panel').children[0];
  assert.equal(tabs.children.length, 2);
});

test('锚点已有 children 时 tab 落位回落为分栏（不猜结构）', () => {
  const { store } = setup();
  // 第一次把面板变成 tabs 组；之后继续用 tab 落位应进入同一组
  store.open('demo.gantt', { where: 'tab', anchor: 'panel' });
  const res = store.open('demo.logs', { where: 'tab', anchor: 'panel' });
  assert.equal(res.ok, true);
  const panel = findNode(store.getSnapshot().tree, 'anchor-panel');
  assert.equal(panel.children.length, 1, '仍然是单个 tabs 组，没有多长一栏');
  assert.equal(panel.children[0].children.length, 3);
});

test('tab 落位不会凭空造出第二个槽位视图', () => {
  const { store } = setup();
  store.open('demo.gantt', { where: 'tab', anchor: 'panel' });
  store.open('demo.logs', { where: 'tab', anchor: 'panel' });
  let slots = 0;
  const walk = (n) => {
    if (n.kind === 'view' && n.viewType === 'host.slot.panel') slots += 1;
    (n.children ?? []).forEach(walk);
  };
  walk(store.getSnapshot().tree);
  assert.equal(slots, 1);
});

test('默认树不带槽位视图：存量视觉零变化，槽位仍走 SlotOutlet 兜底', () => {
  const { store } = setup();
  const tree = store.getSnapshot().tree;
  assert.deepEqual(tree, createDefaultTree());
  const panel = findNode(tree, 'anchor-panel');
  assert.equal(panel.children, undefined);
});

// ---------- 结构视图不可二次打开 ----------

test('cap：open("host.slot.panel") 被拒，即使是全局权限', () => {
  const { store, registry } = setup();
  const handler = createLayoutHandler({ store, registry });
  const call = (action, payload, ctx) => handler({ target: CAP_UI_LAYOUT, action, payload }, ctx);
  assert.throws(() => call('open', { viewType: 'host.slot.panel' }, asPlugin()), /结构视图/);
  assert.throws(
    () => call('open', { viewType: 'host.slot.panel' }, asPlugin([CAP_UI_LAYOUT_GLOBAL])),
    /结构视图/,
    '全局权限也不行：同一槽位挂两份会得到两个互不相认的槽位实例',
  );
});

test('cap：applyTree 预设里可以引用槽位视图（组合的正当路径）', () => {
  const { store, registry } = setup();
  const handler = createLayoutHandler({ store, registry });
  const call = (action, payload, ctx) => handler({ target: CAP_UI_LAYOUT, action, payload }, ctx);

  const tree = createDefaultTree();
  const preset = JSON.parse(JSON.stringify(tree));
  // 找到面板锚点，塞一个 [槽位内容, 我的视图] 的 tabs 组
  const walk = (n) => {
    if (n.kind === 'anchor' && n.anchor === 'panel') {
      n.children = [
        {
          kind: 'tabs',
          id: 'preset-tabs',
          active: 'preset-tabs-a',
          children: [
            { kind: 'view', id: 'preset-tabs-slot', viewType: 'host.slot.panel' },
            { kind: 'view', id: 'preset-tabs-a', viewType: 'demo.gantt' },
          ],
        },
      ];
      return true;
    }
    return (n.children ?? []).some(walk);
  };
  walk(preset);
  const res = call('applyTree', { tree: preset }, asPlugin([CAP_UI_LAYOUT_GLOBAL]));
  assert.equal(res, undefined);
  const tabs = findNode(store.getSnapshot().tree, 'anchor-panel').children[0];
  assert.equal(tabs.kind, 'tabs');
  assert.equal(tabs.children.length, 2);
});
