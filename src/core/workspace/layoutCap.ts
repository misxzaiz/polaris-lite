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
import type { CapBus, CapContext } from '../bus';
import type { CapRequest } from '../types';
import type { WorkspaceNode } from './schema.ts';
import { findNode, validateWorkspace } from './schema.ts';
import type { WorkspaceStore } from './store.ts';
import type { ViewRegistry } from './viewRegistry.ts';
import { isHostSlotView } from './hostViews.ts';

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
function assertNotStructuralView(viewType: string): void {
  if (isHostSlotView(viewType)) {
    throw new Error(`${viewType} 是宿主结构视图，不能直接打开；请在 applyTree 预设的 tabs 里引用`);
  }
}

function nodeOwner(node: WorkspaceNode, registry: ViewRegistry): string | null {
  return node.kind === 'view' ? ownerOfView(node.viewType, registry) : null;
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
        return registry.list().map((v) => ({ viewType: v.viewType, title: v.title, pluginId: v.pluginId }));

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
        assertCanTouch(nodeId, deps, ctx);
        const res = store.close(nodeId);
        if (!res.ok) throw new Error(res.error);
        return undefined;
      }
      case 'split': {
        const nodeId = requireString(p.nodeId, 'nodeId');
        const viewType = requireString(p.viewType, 'viewType');
        assertNotStructuralView(viewType);
        const dir = p.dir === 'col' ? 'col' : 'row';
        const def = registry.get(viewType);
        if (!def) throw new Error(`视图未注册：${viewType}`);
        if (!global && def.pluginId !== ctx.pluginId) throw new Error(`无权打开他人视图：${viewType}`);
        assertCanTouch(nodeId, deps, ctx);
        const res = store.split(nodeId, dir, viewType);
        if (!res.ok) throw new Error(res.error);
        return { id: res.id };
      }
      case 'move': {
        const nodeId = requireString(p.nodeId, 'nodeId');
        assertCanTouch(nodeId, deps, ctx);
        const tabsId = requireString(p.tabsId, 'tabsId');
        const index = typeof p.index === 'number' && Number.isFinite(p.index) ? Math.max(0, Math.floor(p.index)) : 0;
        const res = store.move(nodeId, tabsId, index);
        if (!res.ok) throw new Error(res.error);
        return undefined;
      }

      // ---------- 全局操作（需要二级权限） ----------
      case 'applyTree': {
        if (!global) throw new Error('整体替换布局需要 cap.ui.layout.global 授权');
        const tree = p.tree;
        const check = validateWorkspace(tree, { knownViewTypes: registry.types(), requireKnownViews: true });
        if (!check.ok) throw new Error(`${check.code}@${check.path}：${check.message}`);
        const res = store.apply(tree, { requireKnownViews: true });
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
