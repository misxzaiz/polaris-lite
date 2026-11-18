/**
 * 工作区状态仓：树 + 偏好 + 持久化的唯一权威。
 *
 * 与主题（`plite.theme`）同一套模式——宿主自己持有壳层布局，不依赖任何可被禁用的插件。
 * 这一点与 `docs/sidebar-schemes/README.md` 里「持久化统一走 cap.config」的结论有意偏离：
 * 布局是**壳层自身的状态**，若交给 config-manager，该插件一旦 `enabled: false`，
 * 用户布局就跟着丢。先例是主题：`HostRuntime` 直接读写 localStorage。
 *
 * 四条不变量（每条都对应一类线上事故）：
 * 1. **原子应用**：校验不通过则整棵树不变，绝不部分应用。部分应用的树会被持久化，
 *    下次启动继续崩，用户无法自救。
 * 2. **单个写者**：只有本仓写 localStorage；插件只能经 `cap.ui.layout` 下命令。
 * 3. **先校验再渲染**：`applyTree` 收到的是活对象，可能带环或超深，必须在校验器里挡掉。
 * 4. **失败必回默认**：脏数据 → 备份原件 → 回落默认树 → 给一句提示，任何情况都不白屏。
 */
import type { AnchorId, SplitDir, SplitSize, TabsNode, ViewLeaf, WorkspaceNode } from './schema.ts';
import { WORKSPACE_LIMITS, findNode, validateWorkspace } from './schema.ts';
import { slotViewType } from './hostViews.ts';
import {
  addToTabs,
  anchorNode,
  collapseTree,
  createDefaultTree,
  moveNodeToTabs,
  nextNodeId,
  removeById,
  replaceById,
  setActiveChild,
  setSplitSize,
  splitLeaf,
} from './treeOps.ts';

// ============================================================================
// 持久化适配（可注入，便于在 Node 里用假存储跑脏数据用例）
// ============================================================================

export interface WorkspacePersistence {
  read(key: string): string | null;
  write(key: string, value: string): void;
  remove(key: string): void;
}

/** 默认适配 localStorage；不可用（隐私模式 / SSR）时退化为内存态 */
export function createLocalPersistence(): WorkspacePersistence | null {
  if (typeof window === 'undefined') return null;
  try {
    const probe = '__plite_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
  } catch {
    return null;
  }
  return {
    read: (key) => window.localStorage.getItem(key),
    write: (key, value) => window.localStorage.setItem(key, value),
    remove: (key) => window.localStorage.removeItem(key),
  };
}

export const WORKSPACE_STORAGE_KEY = 'plite.workspace.v1';
const SCHEMA_VERSION = 1;

export interface WorkspaceSnapshot {
  tree: WorkspaceNode;
  /** 每次结构变更 +1，供 React 判断是否需要重渲（树引用已变，这里只是便于观测） */
  revision: number;
  /** 启动/应用失败的提示（非阻塞），UI 可展示 */
  notice: string | null;
}

export type LayoutResult = { ok: true; id?: string } | { ok: false; error: string };

export interface WorkspaceStoreOptions {
  persistence?: WorkspacePersistence | null;
  /** 视图是否仍可用（插件在线/未禁用）；缺省视为全部可用 */
  isAliveViewType?: (viewType: string) => boolean;
  /** 已知视图类型（applyTree 时严格校验用） */
  knownViewTypes?: () => Set<string>;
  key?: string;
  /** 持久化防抖（ms）；拖拽/拖 tab 期间不写盘，改为结束时调用 flush */
  debounceMs?: number;
}

export class WorkspaceStore {
  private state: WorkspaceSnapshot;
  private subs = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly persistence: WorkspacePersistence | null;
  private readonly key: string;
  private readonly debounceMs: number;
  private readonly isAliveViewType: (viewType: string) => boolean;
  private readonly knownViewTypes: () => Set<string> | undefined;

  constructor(opts: WorkspaceStoreOptions = {}) {
    this.persistence = opts.persistence ?? null;
    this.key = opts.key ?? WORKSPACE_STORAGE_KEY;
    this.debounceMs = opts.debounceMs ?? 400;
    this.isAliveViewType = opts.isAliveViewType ?? (() => true);
    this.knownViewTypes = opts.knownViewTypes ?? (() => undefined);
    this.state = { tree: createDefaultTree(), revision: 0, notice: null };
  }

  // ---------- 订阅 ----------

  getSnapshot = (): WorkspaceSnapshot => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.subs.add(fn);
    return () => {
      this.subs.delete(fn);
    };
  };

  private commit(tree: WorkspaceNode, notice: string | null = this.state.notice): void {
    this.state = { tree, revision: this.state.revision + 1, notice };
    this.subs.forEach((fn) => fn());
    this.schedulePersist();
  }

  // ---------- 恢复 ----------

  /**
   * 同步恢复（必须在 createRoot 之前调用）。
   * 放在 effect 里恢复会变成「先渲染默认布局，下一帧再跳到用户布局」，用户看到一次明显重排。
   *
   * **只做「读 + 校验」，不做孤儿折叠**——折叠需要视图注册表，而注册表要等插件加载完才齐。
   * 这里若顺手折叠，就会在插件还没注册时把所有插件视图判成死视图、整棵树退化成默认布局。
   * 折叠交给插件加载后的 `pruneDeadViews()`（见 main.tsx 的启动顺序）。
   *
   * 反过来也不能等插件加载完再 `restore()`：插件在 `setup()` 里就会调 `cap.ui.layout`
   * 装配自己的视图，而 `restore()` 会整体替换树——先 setup 后 restore 等于把插件的
   * 打开动作全部抹掉（实测：`open` 返回 ok，但界面上没有那个视图）。所以顺序只能是
   * **restore → 插件 setup → prune**。
   */
  restore(): void {
    const raw = this.persistence?.read(this.key) ?? null;
    if (!raw) {
      this.state = { tree: createDefaultTree(), revision: 0, notice: null };
      return;
    }
    if (raw.length > WORKSPACE_LIMITS.maxSerializedBytes) {
      this.fallback('工作区快照过大（超过 256KB），已忽略并恢复默认布局', raw);
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw, reviverRejectingDangerousKeys);
    } catch {
      this.fallback('工作区快照无法解析，已恢复默认布局', raw);
      return;
    }

    const envelope = parsed as { v?: unknown; tree?: unknown } | null;
    if (!envelope || typeof envelope !== 'object' || envelope.v !== SCHEMA_VERSION) {
      // 不做「猜测式迁移」：版本不认就回默认，并留备份供人工分析
      this.fallback('工作区快照版本不匹配，已恢复默认布局', raw);
      return;
    }

    const check = validateWorkspace(envelope.tree);
    if (!check.ok) {
      this.fallback(`工作区快照不合法（${check.code}@${check.path}）：${check.message}`, raw);
      return;
    }

    const anchored = validateWorkspace(envelope.tree, { requireAllAnchors: true });
    if (!anchored.ok) {
      // 缺锚点会让移动端抽屉按钮指向不存在的元素，宁可回默认
      this.fallback(`工作区快照缺少锚点（${anchored.path}）：${anchored.message}`, raw);
      return;
    }

    this.state = { tree: envelope.tree as WorkspaceNode, revision: this.state.revision + 1, notice: null };
  }

  /**
   * 插件加载完后调用：把「插件已下线/被禁用」留下的视图从树里折叠掉。
   *
   * 为什么必须折叠而不是留着：宿主渲染一个没有 provider 的视图只能画空框，
   * 用户看到的是一个占着 320px、点不动、也关不掉的空洞（锚点子树里连关闭按钮都没有）。
   * 折叠是幂等的：没有死视图时不动树、不写盘。
   */
  pruneDeadViews(): void {
    const collapsed = collapseTree(this.state.tree, (t) => this.isAliveViewType(t));
    if (!collapsed) {
      this.commit(createDefaultTree(), '布局中的视图均已不可用，已恢复默认布局');
      return;
    }
    if (collapsed === this.state.tree) return;
    // split 的折叠总会产生新对象（结构未变时也新），所以按序列化结果判等，
    // 否则每次启动都会多一次 revision 与一次落盘
    if (JSON.stringify(collapsed) === JSON.stringify(this.state.tree)) return;
    this.commit(collapsed, '部分视图已不可用，已从布局中移除');
  }

  private fallback(notice: string, raw: string): void {
    // 只保留最近一份备份，避免把 256KB 的垃圾无限复制
    try {
      this.persistence?.write(`${this.key}.bak`, raw);
    } catch {
      /* 备份失败不阻断恢复 */
    }
    this.state = { tree: createDefaultTree(), revision: this.state.revision + 1, notice };
  }

  // ---------- 应用 ----------

  /** 原子应用一棵树：校验失败则整棵树不变 */
  apply(tree: unknown, opts: { requireKnownViews?: boolean } = {}): LayoutResult {
    const known = this.knownViewTypes();
    const check = validateWorkspace(tree, {
      knownViewTypes: known,
      requireKnownViews: opts.requireKnownViews === true && Boolean(known),
    });
    if (!check.ok) return { ok: false, error: `${check.code}@${check.path}：${check.message}` };
    this.commit(tree as WorkspaceNode);
    return { ok: true };
  }

  /** 修改单个 tabs 组的激活项（切 tab） */
  setActive(tabsId: string, childId: string): void {
    const next = setActiveChild(this.state.tree, tabsId, childId);
    if (next !== this.state.tree) this.commit(next);
  }

  /** 修改分割尺寸（拖动结束调用一次；拖动过程直接写 DOM，不经过这里） */
  setSize(splitId: string, size: SplitSize): void {
    const next = setSplitSize(this.state.tree, splitId, size);
    if (next !== this.state.tree) this.commit(next);
  }

  /** 关闭节点（锚点不允许关闭，它是保留位置） */
  close(nodeId: string): LayoutResult {
    const node = findNode(this.state.tree, nodeId);
    if (!node) return { ok: false, error: `节点不存在：${nodeId}` };
    if (node.kind === 'anchor') return { ok: false, error: '锚点不可关闭（它是保留位置）' };
    const next = removeById(this.state.tree, nodeId);
    if (!next) {
      this.reset();
      return { ok: true };
    }
    this.commit(next);
    return { ok: true };
  }

  /**
   * 打开一个视图。
   *
   * 三种落位（`where`）：
   * - `split-right`（默认）：把目标锚点一分为二，新视图占新增的那一半。
   * - `split-bottom`：同上的纵向版本。
   * - `tab`：放进目标锚点下**已有的树内 tabs 组**；没有 tabs 组时退化为 split-right。
   *
   * 为什么默认不是 `tab`：面板锚点的多面板 tab 条来自槽位贡献（SlotOutlet），它不是
   * 树里的 tabs 节点，硬塞会让「插件视图」与「槽位面板」共用一条 tab 条却分属两套状态。
   * 所以默认落到主区开新窗格；要在 tab 里共存，请用 `applyTree` 预设显式声明 tabs。
   *
   * 默认落位锚点是 `stream`（主区）：落到 panel 会把 320px 的面板一分为二，
   * 两个 160px 的窗格谁也放不下内容——这是实测出来的，不是推测。
   *
   * 默认幂等：同一 viewType 已在树中时不重复开实例，直接聚焦（`allowMultiple` 可覆盖）。
   */
  open(
    viewType: string,
    opts: { id?: string; anchor?: AnchorId; where?: 'tab' | 'split-right' | 'split-bottom'; allowMultiple?: boolean } = {},
  ): LayoutResult {
    const where = opts.where ?? 'split-right';
    const anchor = opts.anchor ?? 'stream';
    const target = anchorNode(this.state.tree, anchor);
    if (!target) return { ok: false, error: `锚点不存在：${anchor}（插件预设可以省略锚点，运行时不能）` };

    if (!opts.allowMultiple && !opts.id) {
      const existing = findFirstByViewType(this.state.tree, viewType);
      if (existing) {
        // 已存在就聚焦：找到它所在的 tabs 组并切激活（树没变则不写盘）
        const tabs = findParentTabs(this.state.tree, existing);
        const focused = tabs ? setActiveChild(this.state.tree, tabs, existing) : this.state.tree;
        if (focused !== this.state.tree) this.commit(focused);
        return { ok: true, id: existing };
      }
    }

    const id = opts.id ?? nextNodeId(this.state.tree, `${sanitizeId(viewType)}-i`);
    const leaf: ViewLeaf = { kind: 'view', id, viewType };

    if (where === 'tab') {
      const tabsId = findTabsInside(this.state.tree, target.id);
      if (tabsId) {
        const next = addToTabs(this.state.tree, tabsId, leaf);
        if (!next) return { ok: false, error: '目标 tabs 组已满或 id 冲突' };
        this.commit(next);
        return { ok: true, id };
      }
      // 锚点还没有子节点时，`tab` 不该退化成「把 320px 面一分为二」：
      // 把该锚点的槽位内容（`host.slot.*`）与新视图装进一个 tabs 组，
      // 面板里的 4 个槽位面板才不会因为插件开一个视图就整片消失。
      const anchorSlot = tabHostSlotFor(target);
      if (anchorSlot) {
        const slotLeaf: ViewLeaf = {
          kind: 'view',
          id: nextNodeId(this.state.tree, `${sanitizeId(anchorSlot)}-i`),
          viewType: anchorSlot,
        };
        const tabs: TabsNode = {
          kind: 'tabs',
          id: nextNodeId(this.state.tree, 'tabs'),
          // 激活新打开的视图：用户刚点的东西要立即可见，而不是让他再点一次 tab
          active: leaf.id,
          children: [slotLeaf, leaf],
        };
        const withTabs = replaceById(this.state.tree, target.id, { ...target, children: [tabs] });
        if (withTabs) {
          const res = this.apply(withTabs);
          if (res.ok) return { ok: true, id };
        }
        // 组装失败（例如 id 冲突）时回落为分栏，宁可分栏也不静默失败
      }
    }

    const dir: SplitDir = where === 'split-bottom' ? 'col' : 'row';
    const next = splitLeaf(this.state.tree, target.id, dir, leaf);
    if (!next) return { ok: false, error: '拆分失败（目标不存在或 id 冲突）' };
    this.commit(next);
    return { ok: true, id };
  }

  /** 把已有视图拆到另一侧 */
  split(nodeId: string, dir: SplitDir, viewType: string, id?: string): LayoutResult {
    const leafId = id ?? nextNodeId(this.state.tree, `${sanitizeId(viewType)}-i`);
    const next = splitLeaf(this.state.tree, nodeId, dir, { kind: 'view', id: leafId, viewType });
    if (!next) return { ok: false, error: '拆分失败（目标不存在或 id 冲突）' };
    this.commit(next);
    return { ok: true, id: leafId };
  }

  /** 移动节点到某个 tabs 组（拖 tab 用） */
  move(nodeId: string, tabsId: string, index: number): LayoutResult {
    const next = moveNodeToTabs(this.state.tree, nodeId, tabsId, index);
    if (!next) return { ok: false, error: '移动失败（会把节点拖进自己的子树，或目标不是 tabs 组）' };
    this.commit(next);
    return { ok: true };
  }

  /** 用外部树替换某个子树（预设/插件声明式布局用） */
  replaceSubtree(nodeId: string, next: WorkspaceNode | null): LayoutResult {
    const result = replaceById(this.state.tree, nodeId, next);
    if (!result) {
      this.reset();
      return { ok: true };
    }
    return this.apply(result);
  }

  /** 恢复默认布局 */
  reset(): void {
    this.commit(createDefaultTree(), null);
  }

  /** 当前视图类型集合（诊断/预设差异用） */
  viewTypes(): Set<string> {
    const out = new Set<string>();
    const walk = (n: WorkspaceNode): void => {
      if (n.kind === 'view') out.add(n.viewType);
      else n.children?.forEach(walk);
    };
    walk(this.state.tree);
    return out;
  }

  // ---------- 持久化 ----------

  private schedulePersist(): void {
    if (!this.persistence) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.debounceMs);
  }

  /** 立即落盘（页面隐藏 / 关闭前调用，移动端不一定走 pagehide） */
  flush(): void {
    if (!this.persistence) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const payload = JSON.stringify({ v: SCHEMA_VERSION, tree: this.state.tree, savedAt: Date.now() });
    try {
      this.persistence.write(this.key, payload);
    } catch {
      // 写失败（配额/隐私模式）降级为内存态，不弹错——与主题切换的处理一致
    }
  }

  clearPersisted(): void {
    try {
      this.persistence?.remove(this.key);
    } catch {
      /* ignore */
    }
  }
}

// ============================================================================
// 内部工具
// ============================================================================

/** 把 viewType 变成合法 id 片段（ID_PATTERN 只允许小写字母数字与 . _ -） */
function sanitizeId(viewType: string): string {
  return viewType.toLowerCase().replace(/[^a-z0-9._-]/g, '-');
}

function findFirstByViewType(node: WorkspaceNode, viewType: string): string | null {
  if (node.kind === 'view') return node.viewType === viewType ? node.id : null;
  for (const child of node.children ?? []) {
    const hit = findFirstByViewType(child, viewType);
    if (hit) return hit;
  }
  return null;
}

function findParentTabs(node: WorkspaceNode, targetId: string): string | null {
  if (node.kind === 'view') return null;
  for (const child of node.children ?? []) {
    if (child.id === targetId && node.kind === 'tabs') return node.id;
    const hit = findParentTabs(child, targetId);
    if (hit) return hit;
  }
  return null;
}

/** 锚点子树内是否已有 tabs 组（tab 落位靠它） */function findTabsInside(node: WorkspaceNode, rootId: string): string | null {
  if (node.id === rootId) return diveForTabs(node);
  if (node.kind === 'view') return null;
  for (const child of node.children ?? []) {
    const hit = findTabsInside(child, rootId);
    if (hit) return hit;
  }
  return null;
}

function diveForTabs(node: WorkspaceNode): string | null {
  if (node.kind === 'tabs') return node.id;
  if (node.kind === 'view') return null;
  for (const child of node.children ?? []) {
    const hit = diveForTabs(child);
    if (hit) return hit;
  }
  return null;
}

/**
 * `tab` 落位时是否需要先把这个锚点的槽位内容做成一个 tab。
 * 只在锚点**还没有子节点**时成立——此时锚点渲染的是 SlotOutlet，
 * 把它的内容与新视图并列进 tabs，视觉上是「在原面板旁边多一个 tab」，
 * 而不是「原面板被替换成两个半宽的窗格」。
 */
function tabHostSlotFor(node: WorkspaceNode): string | null {
  if (node.kind !== 'anchor') return null;
  if (node.children && node.children.length > 0) return null;
  return slotViewType(node.anchor);
}

/** JSON.parse 的 reviver：拒绝原型污染键，其余原样返回 */
function reviverRejectingDangerousKeys(key: string, value: unknown): unknown {
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
    throw new Error(`非法键：${key}`);
  }
  return value;
}
