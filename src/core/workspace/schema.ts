/**
 * 工作区树契约（Workspace Tree）—— 布局的唯一数据模型与校验器。
 *
 * 为什么需要它：当前布局是「四槽固定结构 + 每个槽内的 tab」，槽位与 tab 数一多就
 * 无处可扩（4 个面板时每格只剩 74px，再多只能截断）。要允许插件自由定义布局，
 * 必须把布局变成**可校验的数据**，而不是散落在 CSS 与 JSX 里的硬编码。
 *
 * 三条设计取舍（评审结论，改动前请先读）：
 *
 * 1. `split` 严格二分（`children: [Node, Node]`）。早期草案是 `children: Node[]` +
 *    单个 `ratio`，但"多子节点只给一个比例"无法定义语义，也无法校验求和。
 *    三栏及以上用嵌套表达——这也是 CSS Grid 与 IDE 类产品的通行做法。
 * 2. 尺寸有两种模式：`ratio`（可拖动）与 `px`（固定，用于复现现状的 252px 侧栏与
 *    320px 面板）。只有比例的话，1920px 屏上侧栏会被拉成 380px，视觉直接回退。
 * 3. 视图节点拆成 `id`（实例）与 `viewType`（类型）。合成一个字段会导致同一视图
 *    无法在两处打开，且 `tabs.active` 在重排后会指向不明。
 *
 * 本文件是**纯函数、零 DOM、零 React、零副作用**，被三处共用（运行时应用 / 反序列化 /
 * 构建期校验预设），因此不允许出现任何依赖宿主的 import。
 */

// ============================================================================
// 限制常量（所有上限集中在此，改这里即改全局）
// ============================================================================

export const WORKSPACE_LIMITS = {
  /** 树深度上限（root 深度 0）。超过 8 层时键盘用户要穿过 8 根分隔条才能到内容 */
  maxDepth: 8,
  /** 叶子（视图实例）总数上限。每个叶子是活的 React 子树 + 可能的订阅 */
  maxLeaves: 16,
  /** 节点总数上限（含 split / tabs 容器），防止满二叉树把主线程打死 */
  maxNodes: 64,
  /** 单个 tabs 组的子项上限 */
  maxTabsChildren: 12,
  /** 比例下限/上限：夹住极端值，避免出现 0 宽但仍挂载、仍订阅的"幽灵窗格" */
  minRatio: 0.05,
  maxRatio: 0.95,
  /** 固定像素尺寸的合法区间 */
  minPx: 40,
  maxPx: 2000,
  /** 持久化体积上限：必须在 JSON.parse **之前**判断，否则超大串会同步阻塞主线程 */
  maxSerializedBytes: 256 * 1024,
  /** id / viewType 的长度与字符集 */
  maxIdLength: 64,
} as const;

/** 节点 id 与视图类型名的合法格式：小写字母数字开头，允许 . _ - */
export const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

// ============================================================================
// 类型
// ============================================================================

export type SplitDir = 'row' | 'col';

/**
 * 子项尺寸。`ratio` 表示第一个子项占比（第二个取剩余），`px` 表示第一个子项固定宽度。
 * 固定宽用于侧栏/面板这类「不该随窗口等比例放大」的锚点。
 */
export type SplitSize =
  | { mode: 'ratio'; value: number }
  | { mode: 'px'; value: number };

/** 分割容器：恰好两个子节点（三元组从类型层面强制，杜绝 children 与 ratio 失配） */
export interface SplitNode {
  kind: 'split';
  id: string;
  dir: SplitDir;
  /** 第一个子节点的尺寸；第二个子节点占据剩余空间 */
  size: SplitSize;
  children: [WorkspaceNode, WorkspaceNode];
}

/**
 * 标签组。`active` 指向**某个直接子节点的 id**（不是数组下标，也不是 viewType）——
 * 用下标会在关闭/重排后把激活态漂到别的视图上，这正是当前 activeIdx 的隐患。
 */
export interface TabsNode {
  kind: 'tabs';
  id: string;
  active: string;
  children: WorkspaceNode[];
}

/** 视图叶子：id 是实例标识，viewType 指向插件注册的视图类型 */
export interface ViewLeaf {
  kind: 'view';
  id: string;
  viewType: string;
}

export type WorkspaceNode = SplitNode | TabsNode | ViewLeaf;

/** tabs 组至少要两个子项才有存在意义；只有一个时由调用方折叠掉 */
export const MIN_TABS_CHILDREN = 2;

// ============================================================================
// 校验
// ============================================================================

export type WorkspaceErrorCode =
  | 'not_object'
  | 'bad_kind'
  | 'forbidden_key'
  | 'bad_id'
  | 'duplicate_id'
  | 'bad_dir'
  | 'bad_size'
  | 'bad_ratio'
  | 'bad_px'
  | 'bad_children'
  | 'bad_active'
  | 'bad_view_type'
  | 'depth_exceeded'
  | 'too_many_leaves'
  | 'too_many_nodes'
  | 'cycle';

export interface WorkspaceStats {
  nodes: number;
  leaves: number;
  depth: number;
}

export type WorkspaceValidation =
  | { ok: true; stats: WorkspaceStats }
  | { ok: false; code: WorkspaceErrorCode; path: string; message: string };

export interface ValidateOptions {
  /** 已知的视图类型集合；提供时用于检查 viewType 是否已注册（缺失则报 bad_view_type） */
  knownViewTypes?: ReadonlySet<string>;
  /** 是否要求每个 viewType 都已注册。关闭时只校验格式，用于反序列化后的降级路径 */
  requireKnownViews?: boolean;
}

/** 形如 root.children[1].children[0] 的定位串，排障时直接指到出问题的节点 */
type Path = string;

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  // 只接受对象字面量与 null 原型，拒绝类实例 / Date / Map 等
  return proto === Object.prototype || proto === null;
}

function hasForbiddenKey(obj: Record<string, unknown>): boolean {
  return Object.keys(obj).some((k) => FORBIDDEN_KEYS.has(k));
}

function fail(code: WorkspaceErrorCode, path: Path, message: string): WorkspaceValidation {
  return { ok: false, code, path, message };
}

/**
 * 校验一棵工作区树。纯函数：不修改入参，不抛异常（除栈溢出外的所有问题都以返回值表达）。
 *
 * 用 `WeakSet` 做环检测——JSON 反序列化出来的树不可能有环，但 `applyTree` 接收的是
 * **活对象**，`a.children.push(a)` 就能构造自引用。校验必须发生在渲染之前，否则
 * React 会递归到栈溢出，而且树一旦被持久化，下次启动继续崩。
 */
export function validateWorkspace(root: unknown, opts: ValidateOptions = {}): WorkspaceValidation {
  const seen = new WeakSet<object>();
  const ids = new Set<string>();
  const counters: WorkspaceStats = { nodes: 0, leaves: 0, depth: 0 };

  const walk = (node: unknown, path: Path, depth: number): WorkspaceValidation | null => {
    if (depth > WORKSPACE_LIMITS.maxDepth) {
      return fail('depth_exceeded', path, `嵌套深度超过 ${WORKSPACE_LIMITS.maxDepth} 层`);
    }
    if (!isPlainObject(node)) return fail('not_object', path, '节点必须是对象字面量');
    if (hasForbiddenKey(node)) return fail('forbidden_key', path, '节点包含 __proto__ / constructor 等危险键');
    if (seen.has(node)) return fail('cycle', path, '节点被重复引用（循环引用或 DAG），渲染会导致无限递归');
    seen.add(node);

    counters.nodes += 1;
    if (counters.nodes > WORKSPACE_LIMITS.maxNodes) {
      return fail('too_many_nodes', path, `节点总数超过 ${WORKSPACE_LIMITS.maxNodes}`);
    }
    if (depth > counters.depth) counters.depth = depth;

    const kind = node.kind;
    if (kind !== 'split' && kind !== 'tabs' && kind !== 'view') {
      return fail('bad_kind', path, `未知节点类型 ${JSON.stringify(kind)}`);
    }

    // 每个节点都必须有稳定 id：tabs.active 靠它定位，焦点与持久化 diff 也靠它
    const id = node.id;
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
      return fail('bad_id', path, `节点 id 必须匹配 ${ID_PATTERN}`);
    }
    if (ids.has(id)) return fail('duplicate_id', path, `节点 id 重复：${id}`);
    ids.add(id);

    if (kind === 'view') {
      if ('children' in node) return fail('bad_children', path, 'view 节点不得有 children');
      const viewType = node.viewType;
      if (typeof viewType !== 'string' || !ID_PATTERN.test(viewType)) {
        return fail('bad_view_type', path, `viewType 必须匹配 ${ID_PATTERN}`);
      }
      if (opts.requireKnownViews && opts.knownViewTypes && !opts.knownViewTypes.has(viewType)) {
        return fail('bad_view_type', path, `视图类型未注册：${viewType}`);
      }
      counters.leaves += 1;
      if (counters.leaves > WORKSPACE_LIMITS.maxLeaves) {
        return fail('too_many_leaves', path, `叶子数量超过 ${WORKSPACE_LIMITS.maxLeaves}`);
      }
      return null;
    }

    const children = node.children;
    if (!Array.isArray(children)) return fail('bad_children', path, `${kind} 节点必须有 children 数组`);

    if (kind === 'split') {
      if (node.dir !== 'row' && node.dir !== 'col') {
        return fail('bad_dir', path, 'split.dir 只能是 row 或 col');
      }
      if (children.length !== 2) {
        return fail('bad_children', path, `split 必须恰好两个子节点（当前 ${children.length}），多栏请嵌套`);
      }
      const size = node.size;
      if (!isPlainObject(size)) return fail('bad_size', path, 'split.size 必须是 { mode, value }');
      const value = size.value;
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fail('bad_size', path, 'split.size.value 必须是有限数字（NaN / Infinity 会让整行塌陷）');
      }
      if (size.mode === 'ratio') {
        if (value < WORKSPACE_LIMITS.minRatio || value > WORKSPACE_LIMITS.maxRatio) {
          return fail(
            'bad_ratio',
            `${path}.size.value`,
            `比例必须在 ${WORKSPACE_LIMITS.minRatio}–${WORKSPACE_LIMITS.maxRatio} 之间（当前 ${value}）`,
          );
        }
      } else if (size.mode === 'px') {
        if (value < WORKSPACE_LIMITS.minPx || value > WORKSPACE_LIMITS.maxPx) {
          return fail(
            'bad_px',
            `${path}.size.value`,
            `固定尺寸必须在 ${WORKSPACE_LIMITS.minPx}–${WORKSPACE_LIMITS.maxPx}px 之间（当前 ${value}）`,
          );
        }
      } else {
        return fail('bad_size', path, `split.size.mode 只能是 ratio 或 px（当前 ${JSON.stringify(size.mode)}）`);
      }
    } else {
      // tabs
      if (children.length < MIN_TABS_CHILDREN) {
        return fail('bad_children', path, `tabs 至少需要 ${MIN_TABS_CHILDREN} 个子节点，单子项请折叠`);
      }
      if (children.length > WORKSPACE_LIMITS.maxTabsChildren) {
        return fail('bad_children', path, `单个 tabs 组最多 ${WORKSPACE_LIMITS.maxTabsChildren} 个子项`);
      }
      // tabs 直接嵌套 tabs 没有视觉意义，且会让「激活的是哪一组」产生歧义
      if (children.some((c) => isPlainObject(c) && c.kind === 'tabs')) {
        return fail('bad_children', path, 'tabs 不得直接嵌套 tabs（请改为 split 或扁平化）');
      }
    }

    for (let i = 0; i < children.length; i += 1) {
      const err = walk(children[i], `${path}.children[${i}]`, depth + 1);
      if (err) return err;
    }

    // active 必须指向直接子节点的 id——检查放在子节点遍历之后，确保子 id 已登记
    if (kind === 'tabs') {
      const active = node.active;
      if (typeof active !== 'string') {
        return fail('bad_active', path, 'tabs.active 必须是子节点 id 字符串');
      }
      const childIds = children.map((c) => (isPlainObject(c) ? c.id : undefined));
      if (!childIds.includes(active)) {
        return fail('bad_active', `${path}.active`, `active 指向不存在的子节点：${active}`);
      }
    }
    return null;
  };

  const result = walk(root, 'root', 0);
  if (result) return result;
  return { ok: true, stats: counters };
}

// ============================================================================
// 辅助：移动端降级与结构查询
// ============================================================================

/**
 * 把任意树压平成「深度优先的叶子序列」。移动端（≤768px）不做分栏，
 * 而是把全部视图收进一条 tab 序列——数据不变、只改呈现，断点来回切不污染持久化。
 */
export function flattenLeaves(node: WorkspaceNode): ViewLeaf[] {
  if (node.kind === 'view') return [node];
  return node.children.flatMap(flattenLeaves);
}

/** 按 id 查找节点（含自身），用于激活态恢复与焦点定位 */
export function findNode(node: WorkspaceNode, id: string): WorkspaceNode | null {
  if (node.id === id) return node;
  if (node.kind === 'view') return null;
  for (const child of node.children) {
    const hit = findNode(child, id);
    if (hit) return hit;
  }
  return null;
}

/** 统计叶子对应的视图类型集合，供「插件下线后哪些视图变孤儿」的诊断使用 */
export function collectViewTypes(node: WorkspaceNode, out = new Set<string>()): Set<string> {
  if (node.kind === 'view') out.add(node.viewType);
  else node.children.forEach((c) => collectViewTypes(c, out));
  return out;
}
