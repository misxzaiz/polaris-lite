/**
 * workspace-layout 插件：工作区布局树的插件化实现（host-slimming-report §7.1 / §4 P2-2）。
 *
 * 2026-11-21 自 src/core/workspace/ 抽出（核心渲染路径重构）：
 * - 树渲染（WorkspaceTree）、状态仓（store）、树操作（treeOps）、布局能力
 *   （cap.ui.layout 归属/参数校验）、宿主槽位视图（host.slot.*）全部由本插件承载；
 * - 契约层留核心：schema（经 @sdk/schema 单一事实源）、viewRegistry（manifest 解析层）、
 *   LayoutRootProps（renderAnchor/resolveView 注入）；
 * - 宿主禁用本插件时：SlotLayout 回退固定四槽（WorkspaceTree 时代之前的形态），不破可用。
 *
 * 装配流程（setup，宿主注入 api）：
 * 1. setViewAccess/setViewResolver——核心把 viewRegistry 查表能力交给插件（只读）；
 *    这一步经宿主在 layout-root 容器解析时完成（见 SlotLayout 的容器 wiring），
 *    setup 内仅注册 cap.ui.layout 能力处理器。
 * 2. registerHostSlotViews()——把 host.slot.<anchor> 四个保留视图登记进注册表。
 *
 * LayoutRoot 组件（manifest containers 'layout-root'）：
 * - 树快照订阅 + 渲染 + LayoutNotice 启动横幅；
 * - renderAnchor/renderBrand/resolveView 由宿主经 props 注入。
 */
import { useSyncExternalStore, type ReactNode } from 'react';
import { CHANNEL_LAYOUT_WIRE } from '@sdk';
import type { CapabilityHandler, LitePlugin, SlotHostApi } from '@sdk';
import type { AnchorId } from '../sdk/schema.ts';
import { WorkspaceTree, LayoutNotice } from './WorkspaceTree.tsx';
import { workspaceStore } from './hostStore.ts';
import { createLayoutHandler, CAP_UI_LAYOUT, CAP_UI_LAYOUT_GLOBAL } from './layoutCap.ts';
import { registerHostSlotViews, setHostViewRegistry } from './hostViews.ts';
import { setViewAccess, setViewResolver } from './viewAccess.ts';
import type { ViewDefinition } from './viewAccessTypes.ts';
import './layout.css';

/** 布局树根容器：签名对齐契约 LayoutRootProps + 树快照自持 */
export function LayoutRoot({ renderAnchor }: {
  renderAnchor(anchor: AnchorId): ReactNode;
  resolveView(viewType: string): unknown;
}) {
  const snap = useSyncExternalStore(workspaceStore.subscribe, workspaceStore.getSnapshot, workspaceStore.getSnapshot);
  return (
    <>
      <WorkspaceTree
        node={snap.tree}
        renderAnchor={renderAnchor}
        renderBrand={() => null /* 品牌归宿主壳层顶栏,树内不再渲染 */}
      />
      <LayoutNotice />
    </>
  );
}

const hostApiRef: SlotHostApi[] = [];

/** 宿主侧容器装配钩子：核心在解析 layout-root 容器时调用（viewRegistry 注入点） */
export function wireCoreAccess(args: {
  registerView(def: { viewType: string; pluginId: string; component: string; title: string; defaultAnchor?: AnchorId }): boolean;
  getView(viewType: string): ViewDefinition | undefined;
  listViews(): ViewDefinition[];
  resolveComponent(viewType: string): unknown;
  /** 宿主插件装配是否全部成功（false = 跳过孤儿视图折叠） */
  pluginsFailed: boolean;
}): void {
  setHostViewRegistry({ register: args.registerView });
  setViewAccess(args.getView, args.listViews);
  setViewResolver(args.resolveComponent);
  registerHostSlotViews();
  workspaceStore.restore();
  // 孤儿视图折叠：插件加载失败时跳过（那些插件的视图只是「未注册」，prune 会误删）。
  // 该健康位由宿主装配链写入（原 main.tsx prune 段的语义原样搬迁）。
  if (!args.pluginsFailed) workspaceStore.pruneDeadViews();
}

export const workspaceLayoutPlugin: LitePlugin = {
  manifest: {
    id: 'workspace-layout',
    name: '工作区布局',
    version: '0.1.0',
    capabilities: [],
    provides: [CAP_UI_LAYOUT, CAP_UI_LAYOUT_GLOBAL],
    events: [],
    contributes: {
      slots: [],
      containers: [{ container: 'layout-root', component: 'LayoutRoot', order: 1 }],
    },
  },
  setup(api: SlotHostApi) {
    hostApiRef.push(api);
    // 布局能力注册：经宿主 registerCapability 门面（provides 声明 + grants 授权双闸）。
    // layoutCap 是「多 action 单 handler」形态，与 register(target, handler) 完全同构；
    // 权限校验/审计/登录门禁全部由总线白拿（迁前 installLayoutCapability 同一套）。
    api.registerCapability.register(
      CAP_UI_LAYOUT,
      createLayoutHandler({ store: workspaceStore, registry: registryAdapter }) as CapabilityHandler,
    );
    // wire 通道挂载：核心壳层解析 layout-root 容器时经 CHANNEL_LAYOUT_WIRE 注入
    // viewRegistry 查表能力（插件不 import 宿主实现,arch 门禁）。
    const w = window as unknown as Record<string, unknown>;
    w[CHANNEL_LAYOUT_WIRE] = (args: Parameters<typeof wireCoreAccess>[0]) => wireCoreAccess(args);
  },
};

/** layoutCap 期望的 ViewRegistry 形状 ← viewAccess 注入通道 */
const registryAdapter = {
  get: (viewType: string) => getViewDefSafe(viewType),
  list: () => listViewDefsSafe(),
  types: () => new Set(listViewDefsSafe().map((v) => v.viewType)),
  has: (viewType: string) => !!getViewDefSafe(viewType),
} as unknown as import('./viewAccessTypes').ViewRegistry;

// viewAccess 延迟读(注入先于任何 cap 调用)
import { getViewDef, listViewDefs } from './viewAccess.ts';
const getViewDefSafe = (viewType: string): ViewDefinition | undefined => getViewDef(viewType);
const listViewDefsSafe = (): ViewDefinition[] => listViewDefs();

export default workspaceLayoutPlugin;
