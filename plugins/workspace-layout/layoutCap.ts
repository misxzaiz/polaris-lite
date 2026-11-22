/**
 * `cap.ui.layout`：布局变更的**唯一**插件入口。
 *
 * 为什么不做成 `api.workspace` 直连宿主单例（早期草案）：布局是跨插件共享的可变状态，
 * 直连等于开一条「无授权、无审计、无归属」的第二写通道——任何插件都能关掉审计面板、
 * 把别人的视图挤到角落，而 `policy.ts` / `bus.ts` 建立起来的「申请≠授权、默认拒绝、
 * 全程审计」将形同虚设。
 *
 * 走总线的三个好处是**白拿**的，不需要在这里重写：
 * - 授权：`manifest.capabilities ∩ grants`（bus.assertAllowed）；
 * - 审计：每次调用自动落一条 AuditEntry（含 pluginId / action / ok）；
 * - 登录门禁：authGuard 自动生效。`cap.ui.layout` 在 `bus.isPublicCap` 里**部分豁免**——
 *   读与「动自己视图」登录前可用（插件 setup 期就要装配 UI），
 *   `applyTree` / `reset` 仍要求登录（会波及其他插件），且另需 `.global` 静态授权。
 *
 * 本文件只补两件总线管不了的事：**归属校验**（只能动自己的视图）与**参数校验**。
 */
import type { CapBus, CapContext } from './capTypes.ts';
import type { CapRequest } from '@sdk';
import type { TabsNode, WorkspaceNode } from '../sdk/schema.ts';
import { findNode, validateWorkspace } from '../sdk/schema.ts';
import type { WorkspaceStore } from './store.ts';
import type { ViewRegistry, ViewDefinition } from './viewAccessTypes.ts';
import { isHostSlotView } from './hostViews.ts';
import { anchorNode } from './treeOps.ts';

export const CAP_UI_LAYOUT = 'cap.ui.layout';
/** 二级权限：可重排/关闭**他人**视图、可整体替换布局（预设/透视） */
export const CAP_UI_LAYOUT_GLOBAL = 'cap.ui.layout.global';

export interface LayoutCapDeps {
  store: WorkspaceStore;
  registry: ViewRegistry;
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}

function requireString(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.length === 0) throw new Error(`${field} 必须是非空字符串`);
  return v;
}

/** 视图的归属插件：优先查注册表，其次按 `<pluginId>.<local>` 约定推断（离线视图也能判归属） */
function ownerOfView(viewType: string, registry: ViewRegistry): string {
  const def = registry.get(viewType);
  if (def) return def.pluginId;
  const dot = viewType.indexOf('.');
  return dot > 0 ? viewType.slice(0, dot) : viewType;
}

/**
 * `host.slot.*` 是**结构视图**（承载某个锚点原有的槽位内容），只能出现在 `applyTree`
 * 的预设里，不能经 `open`/`split` 新建第二份：同一个槽位被挂两次会得到两个互不相认的
 * 槽位实例（各自的激活 tab、各自的滚动位置），用户看到的是「面板凭空多了一份」。
 */
function assertNotStructuralNode(node: WorkspaceNode): void {
  if (node.kind === 'view' && isHostSlotView(node.viewType)) {
    throw new Error(`${node.viewType} 是宿主结构视图，不能关闭 / 拆分 / 移动`);
  }
}

function assertNotStructuralView(viewType: string): void {
  if (isHostSlotView(viewType)) {
    throw new Error(`${viewType} 是宿主结构视图，不能直接打开；请在 applyTree 预设的 tabs 里引用`);
  }
}

function nodeOwner(node: WorkspaceNode, registry: ViewRegistry): string | null {
  return node.kind === 'view' ? ownerOfView(node.viewType, registry) : null;
}

/** 子树内所有视图的归属插件集合（tabs 组合并前的越权检查） */
function ownersIn(node: WorkspaceNode, registry: ViewRegistry): Set<string> {
  const out = new Set<string>();
  const walk = (n: WorkspaceNode): void => {
    if (n.kind === 'view') out.add(ownerOfView(n.viewType, registry));
    else n.children?.forEach(walk);
  };
  walk(node);
  return out;
}

/** 与 store.open 的落位规则保持一致：锚点子树里第一个 tabs 组 */
function diveForTabs(node: WorkspaceNode): TabsNode | null {
  if (node.kind === 'tabs') return node;
  if (node.kind === 'view') return null;
  for (const child of node.children ?? []) {
    const hit = diveForTabs(child);
    if (hit) return hit;
  }
  return null;
}

/**
 * 往一个 tabs 组里加/挪视图，等于与组内其他视图共享一条 tab 条与激活态。
 * 非全局插件只能并入**全部属于自己**的组——否则它就能把自己的界面塞进
 * 「审计面板 / 能力面板」旁边，借别人的位置获得曝光与焦点，而宿主对此毫无记录。
 * `host.slot.*` 的归属是宿主，因此插件不能往槽位视图所在的 tab 组里塞东西
 * （例外：`open({where:'tab'})` 在空锚点上自动组装的那一组由宿主自己创建，不经过这里）。
 */
function assertTabsJoinable(tabs: TabsNode | null, registry: ViewRegistry, ctx: CapContext): void {
  if (!tabs) return;
  if (ctx.capabilities.includes(CAP_UI_LAYOUT_GLOBAL)) return;
  const foreign = [...ownersIn(tabs, registry)].filter((o) => o !== ctx.pluginId);
  if (foreign.length > 0) {
    throw new Error(`目标 tab 组含他人视图（${foreign.join('、')}），无权并入`);
  }
}

function assertCanTouch(nodeId: string, deps: LayoutCapDeps, ctx: CapContext): WorkspaceNode {
  const node = findNode(deps.store.getSnapshot().tree, nodeId);
  if (!node) throw new Error(`节点不存在：${nodeId}`);
  if (node.kind === 'anchor') throw new Error('锚点是保留位置，不可关闭或移动');
  const global = ctx.capabilities.includes(CAP_UI_LAYOUT_GLOBAL);
  const owner = nodeOwner(node, deps.registry);
  if (!global && owner !== ctx.pluginId) {
    throw new Error(`无权操作他人视图（${nodeId} 属于 ${owner ?? '宿主'}）`);
  }
  return node;
}

function deepClone<T>(v: T): T {
  if (typeof structuredClone === 'function') return structuredClone(v);
  return JSON.parse(JSON.stringify(v)) as T;
}

export function createLayoutHandler(deps: LayoutCapDeps) {
  const { store, registry } = deps;

  return (req: CapRequest, ctx: CapContext): unknown => {
    const p = asRecord(req.payload);
    const global = ctx.capabilities.includes(CAP_UI_LAYOUT_GLOBAL);

    switch (req.action) {
      // ---------- 只读 ----------
      case 'getTree':
        // 深拷贝：不给插件内部引用，否则它改一个字段宿主状态就与持久化不一致
        return deepClone(store.getSnapshot().tree);
      case 'listViews':
        return registry.list().map((v: ViewDefinition) => ({ viewType: v.viewType, title: v.title, pluginId: v.pluginId }));

      // ---------- 打开 / 关闭 / 拆分 / 移动 ----------
      case 'open': {
        const viewType = requireString(p.viewType, 'viewType');
        assertNotStructuralView(viewType);
        const def = registry.get(viewType);
        if (!def) throw new Error(`视图未注册：${viewType}`);
        if (!global && def.pluginId !== ctx.pluginId) {
          throw new Error(`无权打开他人视图：${viewType} 属于 ${def.pluginId}`);
        }
        const where = p.where;
        if (where !== undefined && where !== 'tab' && where !== 'split-right' && where !== 'split-bottom') {
          throw new Error("where 只能是 'tab' | 'split-right' | 'split-bottom'");
        }
        const anchor = p.anchor;
        if (anchor !== undefined && !['sidebar', 'stream', 'input', 'panel'].includes(anchor as string)) {
          throw new Error(`anchor 不合法：${String(anchor)}`);
        }
        if (where === 'tab') {
          const target = anchorNode(store.getSnapshot().tree, (anchor as 'sidebar' | 'stream' | 'input' | 'panel') ?? 'stream');
          assertTabsJoinable(target ? diveForTabs(target) : null, registry, ctx);
        }
        const res = store.open(viewType, {
          where: where as 'tab' | 'split-right' | 'split-bottom' | undefined,
          anchor: anchor as 'sidebar' | 'stream' | 'input' | 'panel' | undefined,
          allowMultiple: p.allowMultiple === true,
        });
        if (!res.ok) throw new Error(res.error);
        return { id: res.id };
      }
      case 'close': {
        const nodeId = requireString(p.nodeId, 'nodeId');
        assertNotStructuralNode(assertCanTouch(nodeId, deps, ctx));
        const res = store.close(nodeId);
        if (!res.ok) throw new Error(res.error);
        return undefined;
      }
      case 'split': {
        const nodeId = requireString(p.nodeId, 'nodeId');
        const viewType = requireString(p.viewType, 'viewType');
        assertNotStructuralView(viewType);
        if (p.dir !== undefined && p.dir !== 'row' && p.dir !== 'col') {
          throw new Error("dir 只能是 'row' 或 'col'");
        }
        const dir = p.dir === 'col' ? 'col' : 'row';
        const def = registry.get(viewType);
        if (!def) throw new Error(`视图未注册：${viewType}`);
        if (!global && def.pluginId !== ctx.pluginId) throw new Error(`无权打开他人视图：${viewType}`);
        assertNotStructuralNode(assertCanTouch(nodeId, deps, ctx));
        const res = store.split(nodeId, dir, viewType);
        if (!res.ok) throw new Error(res.error);
        return { id: res.id };
      }
      case 'move': {
        const nodeId = requireString(p.nodeId, 'nodeId');
        assertNotStructuralNode(assertCanTouch(nodeId, deps, ctx));
        const tabsId = requireString(p.tabsId, 'tabsId');
        const tabsNode = findNode(store.getSnapshot().tree, tabsId);
        if (!tabsNode || tabsNode.kind !== 'tabs') throw new Error(`目标不是 tabs 组：${tabsId}`);
        assertTabsJoinable(tabsNode, registry, ctx);
        const index = typeof p.index === 'number' && Number.isFinite(p.index) ? Math.max(0, Math.floor(p.index)) : 0;
        const res = store.move(nodeId, tabsId, index);
        if (!res.ok) throw new Error(res.error);
        return undefined;
      }

      // ---------- 全局操作（需要二级权限） ----------
      case 'applyTree': {
        if (!global) throw new Error('整体替换布局需要 cap.ui.layout.global 授权');
        const tree = p.tree;
        // requireAllAnchors：整体替换是**会被持久化**的，缺锚点的树下次启动会被 restore
        // 拒绝（移动端抽屉也依赖锚点定位）——插件会看到「applyTree 成功、刷新就没了」。
        // 预设本身允许只排部分区域，但落盘的那一份必须是完整布局。
        const check = validateWorkspace(tree, {
          knownViewTypes: registry.types(),
          requireKnownViews: true,
          requireAllAnchors: true,
        });
        if (!check.ok) throw new Error(`${check.code}@${check.path}：${check.message}`);
        const res = store.apply(tree, { requireKnownViews: true, requireAllAnchors: true });
        if (!res.ok) throw new Error(res.error);
        return undefined;
      }
      case 'reset': {
        // 重置只影响宿主布局，但会把别人的视图一起清掉 → 同样要求全局权限
        if (!global) throw new Error('重置布局需要 cap.ui.layout.global 授权');
        store.reset();
        return undefined;
      }
      default:
        throw new Error(`未知布局动作：${req.action}`);
    }
  };
}

/** 把布局能力装进总线（与 metaCapability 同一个安装位置、同一套审计） */
export function installLayoutCapability(bus: CapBus, deps: LayoutCapDeps): void {
  bus.register(CAP_UI_LAYOUT, createLayoutHandler(deps));
}
