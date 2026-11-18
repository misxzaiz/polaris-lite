/**
 * 工作区树的**结构操作**：默认树、折叠、增删改、移动、尺寸变更。
 *
 * 与 schema.ts 的分工：schema 只回答「这棵树合法吗」，本文件只回答「怎么改」。
 * 两者都是纯函数（入参不修改，返回新引用），所以可以在 Node 里直接单测，
 * 不需要 DOM、不需要 React。
 *
 * 一条贯穿全文件的规则：**改结构必然触发折叠**。删掉一个子节点后，只剩一个子项的
 * split / tabs 必须就地折叠成那个子项——否则用户会看到一个 0 宽的空栏或一个只剩
 * 一个 tab 的 tab 条，而没有任何办法把它收拾干净（这正是大部分布局系统「越用越乱」
 * 的根因）。
 */
import type {
  AnchorId,
  AnchorNode,
  SplitDir,
  SplitNode,
  SplitSize,
  TabsNode,
  ViewLeaf,
  WorkspaceNode,
} from './schema.ts';
// 带 .ts 扩展名：这些模块会被 `node --experimental-strip-types --test` 直接加载，
// Node 的 ESM 解析不做扩展名补全（tsconfig 已开 allowImportingTsExtensions）。
import { findNode } from './schema.ts';

// ============================================================================
// 默认树：与改造前的四槽布局逐节点等价
// ============================================================================

/**
 * 默认布局（与旧 `grid-template-columns: 252px minmax(0,1fr) 320px` 等价）：
 *
 * ```
 * split(row, first=252px)
 * ├─ anchor:sidebar
 * └─ split(row, second=320px)
 *    ├─ split(col, second=auto)
 *    │  ├─ anchor:stream
 *    │  └─ anchor:input      ← 随内容长高，不按比例
 *    └─ anchor:panel
 * ```
 *
 * 三处 sizing 各自对应一条既有视觉语义，缺一就会被看出差别：
 * - 侧栏 252px 固定：只有比例的话 1920px 屏上会变成 380px；
 * - 面板 320px 固定在**第二个**子节点：所以需要 `of: 'second'`；
 * - 输入区 auto：它随 textarea 内容长高，用比例会把它钉死在固定高度。
 */
export function createDefaultTree(): WorkspaceNode {
  return {
    kind: 'split',
    id: 'root',
    dir: 'row',
    size: { mode: 'px', value: 252 },
    children: [
      { kind: 'anchor', id: 'anchor-sidebar', anchor: 'sidebar' },
      {
        kind: 'split',
        id: 'root-main',
        dir: 'row',
        size: { mode: 'px', value: 320, of: 'second' },
        children: [
          {
            kind: 'split',
            id: 'main-column',
            dir: 'col',
            size: { mode: 'auto', of: 'second' },
            children: [
              { kind: 'anchor', id: 'anchor-stream', anchor: 'stream' },
              { kind: 'anchor', id: 'anchor-input', anchor: 'input' },
            ],
          },
          { kind: 'anchor', id: 'anchor-panel', anchor: 'panel' },
        ],
      },
    ],
  };
}

/** 默认尺寸：新建分割时用（各占一半） */
export const DEFAULT_SPLIT_SIZE: SplitSize = { mode: 'ratio', value: 0.5 };

// ============================================================================
// 查询
// ============================================================================

/** 收集全部节点的 id（生成新 id 时避让） */
export function collectIds(node: WorkspaceNode, out = new Set<string>()): Set<string> {
  out.add(node.id);
  if (node.kind !== 'view') node.children?.forEach((c) => collectIds(c, out));
  return out;
}

/** 生成树内唯一的节点 id */
export function nextNodeId(root: WorkspaceNode, prefix: string): string {
  const ids = collectIds(root);
  let n = 1;
  while (ids.has(`${prefix}-${n}`)) n += 1;
  return `${prefix}-${n}`;
}

/** 从根到目标节点的祖先链（不含自身），用于判断「拖到自己的子树里」这类非法操作 */
export function ancestorsOf(root: WorkspaceNode, id: string, trail: WorkspaceNode[] = []): WorkspaceNode[] | null {
  if (root.id === id) return trail;
  if (root.kind === 'view') return null;
  for (const child of root.children ?? []) {
    const hit = ancestorsOf(child, id, [...trail, root]);
    if (hit) return hit;
  }
  return null;
}

/** 节点是否位于某棵子树内（含自身） */
export function isInside(root: WorkspaceNode, targetId: string, subtreeId: string): boolean {
  const sub = findNode(root, subtreeId);
  if (!sub) return false;
  return findNode(sub, targetId) !== null;
}

/** 找到包含该节点的最近 tabs 组（不含自身），tab 拖拽的源/目标判定用 */
export function nearestTabs(root: WorkspaceNode, id: string): TabsNode | null {
  const trail = ancestorsOf(root, id);
  if (!trail) return null;
  for (let i = trail.length - 1; i >= 0; i -= 1) {
    if (trail[i].kind === 'tabs') return trail[i] as TabsNode;
  }
  return null;
}

/** 某个视图类型当前出现在几个位置（多实例控制用） */
export function countViewType(root: WorkspaceNode, viewType: string): number {
  let n = 0;
  const walk = (node: WorkspaceNode): void => {
    if (node.kind === 'view') {
      if (node.viewType === viewType) n += 1;
      return;
    }
    node.children?.forEach(walk);
  };
  walk(root);
  return n;
}

// ============================================================================
// 折叠：删掉坏节点 + 收拾只剩下的单子项
// ============================================================================

/**
 * 折叠一棵树：丢弃 `isAlive` 判为死亡的视图，并把只剩一个子项的容器就地替换成该子项。
 *
 * `isAlive` 只对 `view` 节点生效——锚点即使一个贡献都没有也必须保留（否则移动端
 * 抽屉的按钮会指向不存在的元素），此时它渲染自带的空态。
 */
export function collapseTree(node: WorkspaceNode, isAlive: (viewType: string) => boolean): WorkspaceNode | null {
  if (node.kind === 'view') return isAlive(node.viewType) ? node : null;

  if (node.kind === 'anchor') {
    if (!node.children || node.children.length === 0) return node;
    const kids = collapseChildren(node.children, isAlive);
    if (kids.length === 0) return { ...node, children: undefined };
    if (kids.length === 1 && kids[0].id === node.children[0]?.id && node.children.length === 1) return node;
    return { ...node, children: kids };
  }

  if (node.kind === 'split') {
    const kids = collapseChildren(node.children as WorkspaceNode[], isAlive);
    // 两个都没了 → 整个分割消失；只剩一个 → 该子项顶上（不能留 0 宽空栏）
    if (kids.length === 0) return null;
    if (kids.length === 1) return kids[0];
    return { ...node, children: [kids[0], kids[1]] };
  }

  // tabs
  const kids = collapseChildren(node.children, isAlive);
  if (kids.length === 0) return null;
  // 只剩一个 tab 时 tab 条毫无意义，直接折叠成那个视图
  if (kids.length === 1) return kids[0];
  const active = kids.some((k) => k.id === node.active) ? node.active : kids[0].id;
  if (kids.length === node.children.length && active === node.active) return node;
  return { ...node, children: kids, active };
}

function collapseChildren(children: WorkspaceNode[], isAlive: (viewType: string) => boolean): WorkspaceNode[] {
  const out: WorkspaceNode[] = [];
  for (const child of children) {
    const next = collapseTree(child, isAlive);
    if (next) out.push(next);
  }
  return out;
}

// ============================================================================
// 替换 / 删除
// ============================================================================

/**
 * 用 `next` 替换 id 为 `id` 的节点（`next === null` 表示删除），并自动折叠空壳。
 * 返回新树；根被删空时返回 null（调用方负责回落到默认树）。
 */
export function replaceById(root: WorkspaceNode, id: string, next: WorkspaceNode | null): WorkspaceNode | null {
  if (root.id === id) return next;
  if (root.kind === 'view') return root;

  if (root.kind === 'anchor') {
    if (!root.children) return root;
    const kids = root.children.map((c) => replaceById(c, id, next)).filter((c): c is WorkspaceNode => c !== null);
    if (kids.length === root.children.length && kids.every((k, i) => k === root.children![i])) return root;
    return { ...root, children: kids.length ? kids : undefined };
  }

  if (root.kind === 'split') {
    const kids = (root.children as WorkspaceNode[])
      .map((c) => replaceById(c, id, next))
      .filter((c): c is WorkspaceNode => c !== null);
    if (kids.length === 2) {
      return kids[0] === root.children[0] && kids[1] === root.children[1]
        ? root
        : { ...root, children: [kids[0], kids[1]] };
    }
    if (kids.length === 1) return kids[0];
    return null;
  }

  // tabs
  const kids = root.children.map((c) => replaceById(c, id, next)).filter((c): c is WorkspaceNode => c !== null);
  if (kids.length === 0) return null;
  if (kids.length === 1) return kids[0];
  const active = kids.some((k) => k.id === root.active) ? root.active : kids[0].id;
  if (kids.length === root.children.length && active === root.active) return root;
  return { ...root, children: kids, active };
}

/** 删除节点（自动折叠） */
export function removeById(root: WorkspaceNode, id: string): WorkspaceNode | null {
  return replaceById(root, id, null);
}

// ============================================================================
// 修改
// ============================================================================

/** 设置 tabs 组的激活子项；目标 group / child 任一不存在时原样返回 */
export function setActiveChild(root: WorkspaceNode, tabsId: string, childId: string): WorkspaceNode {
  const target = findNode(root, tabsId);
  if (!target || target.kind !== 'tabs') return root;
  if (!target.children.some((c) => c.id === childId)) return root;
  if (target.active === childId) return root;
  return (replaceById(root, tabsId, { ...target, active: childId }) ?? root) as WorkspaceNode;
}

/** 设置分割尺寸（拖动结束时调用一次，拖拽过程直接写 DOM 不经过这里） */
export function setSplitSize(root: WorkspaceNode, splitId: string, size: SplitSize): WorkspaceNode {
  const target = findNode(root, splitId);
  if (!target || target.kind !== 'split') return root;
  // 尺寸没变就返回原引用：否则拖拽结束会白白多写一次盘、多渲一帧
  if (sameSize(target.size, size)) return root;
  return (replaceById(root, splitId, { ...target, size }) ?? root) as WorkspaceNode;
}

function sameSize(a: SplitSize, b: SplitSize): boolean {
  if (a.mode !== b.mode) return false;
  if ((a.of ?? 'first') !== (b.of ?? 'first')) return false;
  const av = 'value' in a ? a.value : undefined;
  const bv = 'value' in b ? b.value : undefined;
  return av === bv;
}

/**
 * 把一个叶子拆成两个：`[原叶子, 新叶子]`。
 * 方向决定新面板出现在右/下；尺寸先给 50%，用户随即拖动即可。
 */
export function splitLeaf(
  root: WorkspaceNode,
  leafId: string,
  dir: SplitDir,
  newLeaf: ViewLeaf,
  size: SplitSize = DEFAULT_SPLIT_SIZE,
): WorkspaceNode | null {
  const leaf = findNode(root, leafId);
  if (!leaf) return null;
  // id 冲突必须在构造前挡掉：否则会生成一棵「全树 id 唯一」不成立的树，
  // 校验器拒绝后调用方只看到 applyTree 失败，很难追到是这里。
  if (newLeaf.id === leafId || findNode(root, newLeaf.id)) return null;
  const split: SplitNode = {
    kind: 'split',
    id: nextNodeId(root, 'split'),
    dir,
    size,
    children: [leaf, newLeaf],
  };
  return replaceById(root, leafId, split);
}

/** 打开一个视图到指定 tabs 组（已存在同实例则只切激活） */
export function addToTabs(root: WorkspaceNode, tabsId: string, leaf: ViewLeaf, index?: number): WorkspaceNode | null {
  const target = findNode(root, tabsId);
  if (!target || target.kind !== 'tabs') return null;
  if (target.children.length >= 12) return null;
  if (findNode(root, leaf.id)) return null; // 同 id 已在树里，会让全树 id 唯一失效
  const at = index === undefined ? target.children.length : Math.max(0, Math.min(index, target.children.length));
  const children = [...target.children.slice(0, at), leaf, ...target.children.slice(at)];
  return replaceById(root, tabsId, { ...target, children, active: leaf.id });
}

/** 把节点移动到某个 tabs 组的指定位置（跨组 or 组内重排） */
export function moveNodeToTabs(root: WorkspaceNode, nodeId: string, tabsId: string, index: number): WorkspaceNode | null {
  if (nodeId === tabsId) return null;
  const node = findNode(root, nodeId);
  const target = findNode(root, tabsId);
  if (!node || !target || target.kind !== 'tabs') return null;
  if (node.kind === 'anchor') return null; // 锚点是保留位置，不允许当成 tab 拖走
  // 拖进自己的子树会构造出环——校验器会拒，但这里直接不让发生
  if (isInside(root, tabsId, nodeId)) return null;

  const sourceTabs = nearestTabs(root, nodeId);
  // 同组内重排：先摘后插，下标要按摘除后的数组重算
  if (sourceTabs && sourceTabs.id === tabsId) {
    const without = target.children.filter((c) => c.id !== nodeId);
    const fromIdx = target.children.findIndex((c) => c.id === nodeId);
    let at = Math.max(0, Math.min(index, without.length));
    if (fromIdx !== -1 && fromIdx < index) at = Math.max(0, Math.min(at - 1, without.length));
    const children = [...without.slice(0, at), node, ...without.slice(at)];
    return replaceById(root, tabsId, { ...target, children, active: nodeId });
  }

  const removed = replaceById(root, nodeId, null);
  if (!removed) return null;
  return addToTabs(removed, tabsId, node as ViewLeaf, index);
}

/** 把某个视图类型的叶子全部换掉（插件下线时用：保留位置改成占位视图） */
export function replaceViewType(root: WorkspaceNode, from: string, to: ViewLeaf): WorkspaceNode {
  let tree = root;
  const hits: string[] = [];
  const walk = (node: WorkspaceNode): void => {
    if (node.kind === 'view' && node.viewType === from) hits.push(node.id);
    else if (node.kind !== 'view') node.children?.forEach(walk);
  };
  walk(root);
  for (const id of hits) tree = replaceById(tree, id, { ...to, id }) ?? tree;
  return tree;
}

/** 找到第一个可用作新 tab 容器的 tabs 组（没有就返回 null） */
export function firstTabs(root: WorkspaceNode): TabsNode | null {
  let hit: TabsNode | null = null;
  const walk = (node: WorkspaceNode): void => {
    if (hit) return;
    if (node.kind === 'tabs') {
      hit = node;
      return;
    }
    if (node.kind !== 'view') node.children?.forEach(walk);
  };
  walk(root);
  return hit;
}

/** 锚点节点所在位置（打开视图到某个锚点时用） */
export function anchorNode(root: WorkspaceNode, anchor: AnchorId): AnchorNode | null {
  let hit: AnchorNode | null = null;
  const walk = (node: WorkspaceNode): void => {
    if (hit) return;
    if (node.kind === 'anchor' && node.anchor === anchor) {
      hit = node;
      return;
    }
    if (node.kind !== 'view') node.children?.forEach(walk);
  };
  walk(root);
  return hit;
}
