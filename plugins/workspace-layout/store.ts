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
import type { AnchorId, SplitDir, SplitSize, TabsNode, ViewLeaf, WorkspaceNode } from '../sdk/schema.ts';
import { WORKSPACE_LIMITS, findNode, validateWorkspace } from '../sdk/schema.ts';
import { isHostSlotView, slotViewType } from './hostViews.ts';
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
  /** 恢复幂等标志(P2-2):restore 的时序不变量「restore → 变更」由 ensureRestored 机械化 */
  private restored = false;

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

  private commit(tree: WorkspaceNode, notice: string | null = null): void {
    this.state = { tree, revision: this.state.revision + 1, notice };
    this.subs.forEach((fn) => fn());
    this.schedulePersist();
  }

  /**
   * 结构变更的唯一提交口：**先校验再落地**。
   *
   * 树操作是纯函数，理论上产出必然合法——但「理论上」已经不够：实测中
   * `move` 会把一个 tabs 组拖进另一个 tabs 组，产出的树违反「tabs 不得嵌套 tabs」，
   * 而 store 直接 commit 并写盘；用户下次启动时 restore 校验失败 → 整棵布局回默认，
   * 且无法自愈（坏树已被持久化）。
   *
   * 所以所有结构变更走这里：非法树不进内存、不写盘，只在控制台留证。
   * 代价是每次变更多一次 O(64) 校验，可以忽略。
   */
  private commitChecked(tree: WorkspaceNode, notice: string | null = null): string | null {
    const check = validateWorkspace(tree);
    if (!check.ok) {
      const reason = `${check.code}@${check.path}：${check.message}`;
      console.warn(`[workspace] 拒绝应用非法布局：${reason}`);
      return reason;
    }
    this.commit(tree, notice);
    return null;
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
  /** P2-2:restore 时序机械化——任何树变更前若尚未 restore,先恢复(幂等,单次开销)。
   *  无持久化数据时不替换 state(保留当前树引用——「整体拒绝不改引用」的语义不受影响)。 */
  private ensureRestored(): void {
    if (this.restored) return;
    this.restored = true;
    const raw = this.persistence?.read(this.key) ?? null;
    if (!raw) return;
    this.restore();
  }

  restore(): void {
    this.restored = true;
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
    this.ensureRestored();
    const collapsed = collapseTree(this.state.tree, (t) => this.isAliveViewType(t));
    if (!collapsed) {
      this.commitChecked(createDefaultTree(), '布局中的视图均已不可用，已恢复默认布局');
      return;
    }
    if (collapsed === this.state.tree) return;
    // split 的折叠总会产生新对象（结构未变时也新），所以按序列化结果判等，
    // 否则每次启动都会多一次 revision 与一次落盘
    if (JSON.stringify(collapsed) === JSON.stringify(this.state.tree)) return;
    this.commitChecked(collapsed, '部分视图已不可用，已从布局中移除');
  }

  private fallback(notice: string, raw: string): void {
    // 只保留最近一份备份，避免把 256KB 的垃圾无限复制
    try {
      this.persistence?.write(`${this.key}.bak`, raw);
    } catch {
      /* 备份失败不阻断恢复 */
    }
    // 清掉主键：否则这份坏数据会被每次启动重新读到，用户每次都要看一遍同样的提示，
    // 而 .bak 也被反复覆盖（第一次的现场反而丢了）。备份留着供人工分析即可。
    try {
      this.persistence?.remove(this.key);
    } catch {
      /* 清不掉也不能阻断恢复：本次仍回默认，只是下次还会提示 */
    }
    this.state = { tree: createDefaultTree(), revision: this.state.revision + 1, notice };
  }

  // ---------- 应用 ----------

  /**
   * 原子应用一棵树：校验失败则整棵树不变。
   *
   * `requireAllAnchors` 必须由**持久化/全局替换**路径打开（applyTree）：缺锚点的树虽然
   * 语法合法（预设可以刻意只排一部分），但一旦落盘，下次 restore 会因缺锚点回默认，
   * 移动端的抽屉按钮也会指向不存在的元素——表现为「插件说成功了，刷新就没了」。
   */
  apply(tree: unknown, opts: { requireKnownViews?: boolean; requireAllAnchors?: boolean } = {}): LayoutResult {
    this.ensureRestored();
    // **深拷贝**：插件传进来的是活对象，applyTree 返回后它仍可能在用同一个引用
    // （切换透视时复用模板、往常量里 push 视图都是常见写法）。不克隆的话，宿主状态与
    // 校验时的快照会分叉——渲染器读到 `children[1] === undefined` 直接抛 TypeError，
    // 整棵树被 React 卸载 → 白屏且无法自愈（树已被持久化）。
    let snapshot: unknown;
    try {
      snapshot = typeof structuredClone === 'function' ? structuredClone(tree) : JSON.parse(JSON.stringify(tree));
    } catch {
      return { ok: false, error: '布局树包含无法复制的值（函数 / DOM 节点 / 循环引用以外的不可克隆对象）' };
    }

    const known = this.knownViewTypes();
    const check = validateWorkspace(snapshot, {
      knownViewTypes: known,
      requireKnownViews: opts.requireKnownViews === true && Boolean(known),
      requireAllAnchors: opts.requireAllAnchors === true,
    });
    if (!check.ok) return { ok: false, error: `${check.code}@${check.path}：${check.message}` };
    this.commit(snapshot as WorkspaceNode);
    return { ok: true };
  }

  /** 修改单个 tabs 组的激活项（切 tab） */
  setActive(tabsId: string, childId: string): void {
    const next = setActiveChild(this.state.tree, tabsId, childId);
    if (next !== this.state.tree) this.commitChecked(next);
  }

  /** 修改分割尺寸（拖动结束调用一次；拖动过程直接写 DOM，不经过这里） */
  setSize(splitId: string, size: SplitSize): void {
    const next = setSplitSize(this.state.tree, splitId, size);
    if (next !== this.state.tree) this.commitChecked(next);
  }

  /**
   * 关闭节点。只允许**视图**：
   * - 锚点不可关闭（保留位置）；
   * - split / tabs 也不可关闭——删掉一个容器会连带删掉它里面所有视图，若其中恰好
   *   含锚点，还会得到一棵缺锚点的树（落盘后下次启动回默认，用户布局全丢）。
   *   容器的消失应当是「关闭其下最后一个视图时自动折叠」的结果，而不是被直接关闭。
   * - `host.slot.*` 不可关闭：它代表该锚点的槽位内容，关掉只是让它回退到同一个槽位，
   *   行为与结果不一致，用户会以为按钮坏了。
   */
  close(nodeId: string): LayoutResult {
    this.ensureRestored();
    const node = findNode(this.state.tree, nodeId);
    if (!node) return { ok: false, error: `节点不存在：${nodeId}` };
    if (node.kind === 'anchor') return { ok: false, error: '锚点不可关闭（它是保留位置）' };
    if (node.kind !== 'view') return { ok: false, error: `只有视图可以关闭（${node.kind} 是容器，请关闭其中的视图）` };
    if (isHostSlotView(node.viewType)) return { ok: false, error: '宿主槽位视图不可关闭（它就是该锚点的内容）' };
    const next = removeById(this.state.tree, nodeId);
    if (!next) {
      this.reset();
      return { ok: true };
    }
    // 关掉视图后若剩余布局不合法（理论上不该发生），保持原树而不是落地一棵坏树
    const closeErr = this.commitChecked(next);
    if (closeErr) return { ok: false, error: `关闭后布局不合法（${closeErr}）` };
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
    this.ensureRestored();
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
        if (focused !== this.state.tree) this.commitChecked(focused);
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
        const openErr = this.commitChecked(next);
        if (openErr) return { ok: false, error: `打开后布局不合法（${openErr}）` };
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
    const splitErr = this.commitChecked(next);
    if (splitErr) return { ok: false, error: `拆分后布局不合法（${splitErr}）` };
    return { ok: true, id };
  }

  /** 把已有视图拆到另一侧 */
  split(nodeId: string, dir: SplitDir, viewType: string, id?: string): LayoutResult {
    this.ensureRestored();
    const leafId = id ?? nextNodeId(this.state.tree, `${sanitizeId(viewType)}-i`);
    const next = splitLeaf(this.state.tree, nodeId, dir, { kind: 'view', id: leafId, viewType });
    if (!next) return { ok: false, error: '拆分失败（目标不存在或 id 冲突）' };
    const splitErr = this.commitChecked(next);
    if (splitErr) return { ok: false, error: `拆分后布局不合法（${splitErr}）` };
    return { ok: true, id: leafId };
  }

  /** 移动节点到某个 tabs 组（拖 tab 用） */
  move(nodeId: string, tabsId: string, index: number): LayoutResult {
    this.ensureRestored();
    const next = moveNodeToTabs(this.state.tree, nodeId, tabsId, index);
    if (!next) return { ok: false, error: '移动失败（会把节点拖进自己的子树，或目标不是 tabs 组）' };
    // 拖拽产生的结构必须仍然合法：tabs 拖进 tabs 会被校验器拒绝，宁可不动
    const moveErr = this.commitChecked(next);
    if (moveErr) return { ok: false, error: `移动后布局不合法（${moveErr}）` };
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
    this.ensureRestored();
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

/**
 * 把 viewType 变成合法 id 片段（ID_PATTERN 只允许小写字母数字与 . _ -）。
 * 截到 48 字符：`nextNodeId` 还会追加 `-NN`，而 id 上限是 64——不截断的话
 * 一个被声明成 `<64 长插件 id>.<长组件名>` 的 viewType 会生成超长 id，
 * 校验器拒绝后表现为「open 返回失败」，排障时完全看不出是长度问题。
 */
function sanitizeId(viewType: string): string {
  const cleaned = viewType.toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/^[^a-z0-9]+/, '');
  return cleaned.slice(0, 48).replace(/[-._]+$/, '') || 'view';
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
