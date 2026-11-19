/**
 * 宿主自有视图：把四个锚点的「槽位内容」也注册成树里的**视图**。
 *
 * 为什么需要它：锚点的渲染规则是「有 children 就渲染 children，没有才渲染 SlotOutlet」。
 * 这条规则本身是对的（子节点即覆盖），但它带来一个组合上的坑：插件用 `applyTree`
 * 给面板加一个 tab 时，只要写了 `anchor.children`，面板里 4 个槽位面板（能力/模型/Bash/账号）
 * 就整片消失——插件既拿不到那 4 个面板的 viewType，也无法在树里引用它们。
 *
 * 于是把它们变成 `host.slot.<anchor>` 四个保留视图类型：
 * - 预设可以写 `tabs([host.slot.panel, my.view])`，槽位面板与插件视图共存于同一 tab 条；
 * - `open(viewType, { where: 'tab' })` 在锚点还没有 children 时，自动把「槽位视图 + 新视图」
 *   装进一个 tabs 组，而不是把 320px 的面板一分为二；
 * - 宿主侧只有一个渲染分支（见 WorkspaceTree 的 LeafView），不认识任何具体插件。
 *
 * 保留命名空间：`host.` 前缀不分配给任何插件（插件 viewType 必须 `<pluginId>.<local>`，
 * 而 `host` 由宿主占用）。`host.slot.*` 永远在线，所以永远不会被 pruneDeadViews 折叠。
 */
import type { AnchorId } from './schema.ts';
import { ANCHOR_IDS, HOST_SLOT_VIEW_PREFIX } from './schema.ts';
import { viewRegistry } from './viewRegistry.ts';

/** 宿主在视图注册表里的 pluginId（不是插件，不参与 grants / 生命周期） */
export const HOST_PLUGIN_ID = 'host';

const SLOT_VIEW_PREFIX = HOST_SLOT_VIEW_PREFIX;

/** tab 文本：锚点内容在 tabs 组里的可访问名，保持 2–3 字以免挤爆 tabbar */
const SLOT_VIEW_TITLE: Record<AnchorId, string> = {
  sidebar: '侧栏',
  stream: '主区',
  input: '输入',
  panel: '面板',
};

export function slotViewType(anchor: AnchorId): string {
  return `${SLOT_VIEW_PREFIX}${anchor}`;
}

export function isHostSlotView(viewType: string): boolean {
  return viewType.startsWith(SLOT_VIEW_PREFIX);
}

/** `host.slot.panel` → `panel`；不是槽位视图或锚点名非法时返回 null */
export function anchorOfSlotView(viewType: string): AnchorId | null {
  if (!isHostSlotView(viewType)) return null;
  const rest = viewType.slice(SLOT_VIEW_PREFIX.length);
  return (ANCHOR_IDS as readonly string[]).includes(rest) ? (rest as AnchorId) : null;
}

/**
 * 在 createRoot 之前注册（必须早于 restore/prune，否则槽位视图会被当成死视图）。
 * 幂等：重复调用不会产生重复项（注册表对同 viewType 幂等拒绝）。
 */
export function registerHostSlotViews(): void {
  for (const anchor of ANCHOR_IDS) {
    viewRegistry.register({
      viewType: slotViewType(anchor),
      pluginId: HOST_PLUGIN_ID,
      // 宿主组件不由插件模块导出；LeafView 走专门分支渲染，这里的名字只用于诊断
      component: 'SlotOutlet',
      title: SLOT_VIEW_TITLE[anchor],
      defaultAnchor: anchor,
    });
  }
}
