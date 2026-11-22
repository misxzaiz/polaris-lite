/**
 * 工作区树渲染器：把 `WorkspaceNode` 递归渲染成真实的界面。
 *
 * 四条实现原则（每条都对应一种会「越用越乱」的失败模式）：
 *
 * 1. **锚点复用既有视觉**：`anchor` 节点渲染出的仍是 `.shell-sidebar` / `.shell-stream`
 *    / `.shell-input` / `.shell-panel`，因此 8 个存量插件与全部样式零改动。
 * 2. **拖动不经过 React**：分隔条拖动只改被拖那一侧的 inline style，松手才提交一次
 *    尺寸。否则每帧一次 commit，两个窗格里的消息列表都要重排。
 * 3. **tabs 懒挂载 + 保活**：首次激活才挂载，之后用 `display:none` 隐藏而不是卸载。
 *    旧实现每切一次 tab 就重建一次，滚动位置、未发送草稿、折叠状态全丢。
 * 4. **宽度全交给 CSS**：`flex-basis` 由数据算出，渲染时不测量容器（测量→setState
 *    →改样式是 ResizeObserver 死循环的典型成因）。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties, ComponentType, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import type { AnchorId, AnchorNode, SplitNode, SplitSize, TabsNode, ViewLeaf, WorkspaceNode } from '../sdk/schema.ts';
import { WORKSPACE_LIMITS } from '../sdk/schema.ts';
import { createLocalPersistence } from './store.ts';
import { workspaceStore } from './hostStore.ts';
import { getViewDef, listViewDefs, resolveInjectedView } from './viewAccess.ts';
import { anchorOfSlotView, isHostSlotView } from './hostViews.ts';
import { getDrawer, getIsNarrow, setDrawer, subscribeDrawer, subscribeNarrow } from './stateBridge.ts';

/** 单个窗格的最小像素宽/高：再小就放不下内容，且手指也抓不住分隔条 */
const MIN_PANE_PX = WORKSPACE_LIMITS.minPx;

const ANCHOR_LABEL: Record<AnchorId, string> = {
  sidebar: '侧栏',
  stream: '主区',
  input: '输入区',
  panel: '面板',
};

/**
 * 能不能被用户关掉。
 * - 锚点不行：它是保留位置，关掉就没有侧栏/面板了。
 * - 宿主槽位视图（`host.slot.*`）不行：它承载的是该锚点原有的槽位面板，
 *   给它一个 × 等于给用户一个「把面板清空」的按钮，而清空后渲染又回到同一个槽位内容
 *   （锚点 children 为空 → SlotOutlet），按钮行为与结果不一致。
 */
function isClosable(node: WorkspaceNode): boolean {
  return node.kind === 'view' && !isHostSlotView(node.viewType);
}

// ============================================================================
// 壳层状态订阅
// ============================================================================

function useDrawerState(): ReturnType<typeof getDrawer> {
  return useSyncExternalStore(subscribeDrawer, getDrawer, getDrawer);
}

function useNarrow(): boolean {
  return useSyncExternalStore(subscribeNarrow, getIsNarrow, () => false);
}

// ============================================================================
// 尺寸 → 样式
// ============================================================================

/**
 * 把 `SplitSize` 翻译成两个窗格的 flex 样式。
 *
 * 为什么不用 CSS Grid：Grid 模板需要一次性知道所有轨道，嵌套 split 时要拼字符串；
 * 而 flex 每层独立解析，嵌套天然成立，且拖动时只改一个 `flex-basis` 即可。
 */
function paneStyles(size: SplitSize, dir: 'row' | 'col'): [CSSProperties, CSSProperties] {
  const of = size.of ?? 'first';
  const fixedIdx = of === 'first' ? 0 : 1;
  const minMain = dir === 'row' ? 'minWidth' : 'minHeight';
  const minCross = dir === 'row' ? 'minHeight' : 'minWidth';

  /**
   * 固定侧用 `0 1 <basis>`（**可收缩**）而不是 `0 0 <basis>`。
   *
   * `0 0` 在「容器比固定值还小」时会把另一侧压成 0：实测 1600px 窗口把侧栏拖到 1480px
   * （合法，maxPx=2000），再缩到 1000px，主区变成 0×464、分隔条被推到 x=1200（视口外），
   * 页面又没有横向滚动 —— 用户鼠标够不到分隔条，布局永久锁死。
   * 允许收缩之后，容器不足时固定侧先让位，主区至少保留 MIN_PANE_PX。
   */
  const basis =
    size.mode === 'px'
      ? `${size.value}px`
      : size.mode === 'ratio'
        ? `${(size.value * 100).toFixed(3)}%`
        : 'auto';
  const sized: CSSProperties = { flex: `0 1 ${basis}` };
  const grows: CSSProperties = { flex: '1 1 0' };
  // 两侧都保 MIN_PANE_PX：允许收缩不等于允许消失。实测 1600px 下把侧栏拖到 1480 再缩到
  // 1000px，若固定侧 floor 为 0，面板会直接变成 0 宽（比被压死更难理解：它凭空不见了）。
  const sizedFloor: CSSProperties = { [minMain]: MIN_PANE_PX, [minCross]: 0 } as CSSProperties;
  const growsFloor: CSSProperties = { [minMain]: MIN_PANE_PX, [minCross]: 0 } as CSSProperties;
  const pair: [CSSProperties, CSSProperties] = fixedIdx === 0 ? [sized, grows] : [grows, sized];
  const floors: [CSSProperties, CSSProperties] = fixedIdx === 0 ? [sizedFloor, growsFloor] : [growsFloor, sizedFloor];
  return [{ ...pair[0], ...floors[0] }, { ...pair[1], ...floors[1] }];
}

/**
 * 「主区 / 输入区」这一列 split 的 `auto` 语义：输入区跟着内容长高。
 *
 * 为什么只有这类 split 才认 auto：侧栏、面板的 auto 没有意义（宽度按内容会塌成一条），
 * 把它们双击复位成 auto 只会更难收拾。输入区则相反——auto 是它最自然的状态，
 * 而拖一下分隔条就会把它固化成 px（`onUp` 只对 ratio 特殊处理），此后再也没有回退入口。
 * 返回 input 锚点所在的侧别，供 `{ mode: 'auto', of }` 使用。
 */
function autoOf(node: SplitNode): 'first' | 'second' | null {
  if (node.dir !== 'col') return null;
  const i = node.children.findIndex((c) => c.kind === 'anchor' && c.anchor === 'input');
  if (i === 0) return 'first';
  if (i === 1) return 'second';
  return null;
}

function splitterAria(size: SplitSize): { now: number; min: number; max: number; text: string } {
  if (size.mode === 'ratio') {
    const pct = Math.round(size.value * 100);
    return { now: pct, min: Math.round(WORKSPACE_LIMITS.minRatio * 100), max: Math.round(WORKSPACE_LIMITS.maxRatio * 100), text: `${pct}%` };
  }
  if (size.mode === 'px') {
    return { now: size.value, min: MIN_PANE_PX, max: WORKSPACE_LIMITS.maxPx, text: `${size.value} 像素` };
  }
  return { now: 50, min: 0, max: 100, text: '自适应' };
}

// ============================================================================
// 节点标题（tab 文本 / 关闭按钮的可访问名）
// ============================================================================

function titleOf(node: WorkspaceNode): string {
  if (node.kind === 'view') {
    const def = getViewDef(node.viewType);
    // 注册表里的 title 是必填的；缺失说明注册被拒，此时退回 viewType 便于排障
    return def?.title ?? node.viewType;
  }
  if (node.kind === 'anchor') return ANCHOR_LABEL[node.anchor];
  if (node.kind === 'tabs') return '标签组';
  return '分栏';
}

// ============================================================================
// 视图叶子
// ============================================================================

function LeafView({ node }: { node: ViewLeaf }) {
  // 宿主槽位视图：`host.slot.<anchor>` 不是插件组件，直接渲染该锚点的槽位内容。
  // 走这一个分支就够了——宿主不需要认识任何具体插件，插件也不需要认识槽位。
  const slotAnchor = anchorOfSlotView(node.viewType);
  if (slotAnchor) {
    return (
      <div className={`ws-slot-body ws-slot-${slotAnchor}`} data-view={node.viewType}>
        {layoutRenderAnchor(slotAnchor)}
      </div>
    );
  }
  const def = getViewDef(node.viewType);
  // 组件解析经宿主注入(核心 externalPlugins 查表;插件不 import 宿主实现)
  const Comp = resolveInjectedView(node.viewType) as ComponentType | undefined;
  if (!def) {
    return (
      <div className="slot slot-empty" data-view={node.viewType}>
        <span>视图不可用（{node.viewType}）</span>
      </div>
    );
  }
  if (!Comp) {
    return (
      <div className="slot slot-error" data-plugin={def.pluginId}>
        <span>插件 {def.pluginId} 未导出组件 {def.component}</span>
      </div>
    );
  }
  // data-plugin 是插件 CSS 作用域化的锚点（构建期加前缀时靠它定位）
  return (
    <div className="slot" data-plugin={def.pluginId} data-view={node.viewType}>
      <Comp />
    </div>
  );
}

// ============================================================================
// 锚点
// ============================================================================

function AnchorView({ node }: { node: AnchorNode }) {
  const drawer = useDrawerState();
  const narrow = useNarrow();
  const asideRef = useRef<HTMLElement | null>(null);
  const isSidebar = node.anchor === 'sidebar';
  const isPanel = node.anchor === 'panel';

  const open = (isSidebar && drawer === 'sidebar') || (isPanel && drawer === 'panel');
  const className = isSidebar
    ? `shell-sidebar ${open ? 'open' : ''}`
    : isPanel
      ? `shell-panel ${open ? 'open' : ''}`
      : node.anchor === 'stream'
        ? 'shell-stream'
        : 'shell-input';

  const content =
    node.children && node.children.length > 0 ? (
      <div className="ws-anchor-body">
        {node.children.map((child) => (
          <NodeView key={child.id} node={child} />
        ))}
      </div>
    ) : (
      layoutRenderAnchor(node.anchor)
    );

  // 关闭的抽屉必须**真正不可达**：`aria-hidden` 只对读屏生效，
  // 键盘用户按 Tab 仍会聚焦到屏幕外（translateX(-102%)）的那些按钮上，
  // 焦点跑到看不见的地方，视觉上就像「Tab 键坏了」。
  useEffect(() => {
    const el = asideRef.current;
    if (!el) return;
    if (narrow && !open) el.setAttribute('inert', '');
    else el.removeAttribute('inert');
  }, [narrow, open]);

  // 打开时把焦点移进抽屉，否则焦点仍停在打开它的按钮上，读屏用户不知道抽屉已展开
  useEffect(() => {
    if (!narrow || !open) return;
    const el = asideRef.current;
    if (!el) return;
    const first = el.querySelector<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select, [tabindex]:not([tabindex="-1"])',
    );
    first?.focus({ preventScroll: true });
  }, [narrow, open]);

  // 手机端滑动关闭（P2-10）：sidebar 左滑 / panel 右滑 ≥64px（横向明显占优才触发，
  // 不干扰纵向滚动）。与点遮罩等价——面板全宽 87% 时遮罩只剩一条边，滑动是主要出口。
  useEffect(() => {
    const el = asideRef.current;
    if (!el || !narrow || !open) return;
    let sx = 0;
    let sy = 0;
    let tracking = false;
    const onStart = (e: TouchEvent): void => {
      const t = e.touches[0];
      sx = t.clientX;
      sy = t.clientY;
      tracking = true;
    };
    const onMove = (e: TouchEvent): void => {
      if (!tracking) return;
      const t = e.touches[0];
      const dx = t.clientX - sx;
      const dy = t.clientY - sy;
      if (Math.abs(dx) < 64 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
      tracking = false;
      if (isSidebar && dx < 0) setDrawer('none');
      else if (isPanel && dx > 0) setDrawer('none');
    };
    const onEnd = (): void => {
      tracking = false;
    };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: true });
    el.addEventListener('touchend', onEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
    };
  }, [narrow, open, isSidebar, isPanel]);

  const body = isSidebar ? (
    <>
      {layoutRenderBrand()}
      {content}
    </>
  ) : (
    <>
      {/* 能力面板关闭栏（P0-3）：面板窄屏占 87% 屏宽、顶栏按钮被自身盖住，
          此前没有任何可见关闭入口，只能盲点左侧遮罩。侧栏不加速条——
          汉堡按钮/遮罩/左滑三个出口已够，再放一条纯占空间的 bar 反而挤。 */}
      {isPanel && narrow && (
        <div className="shell-drawer-head">
          <span className="shell-drawer-head-title">能力面板</span>
          <button
            type="button"
            className="shell-drawer-close"
            aria-label="关闭能力面板"
            onClick={() => setDrawer('none')}
          >
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      )}
      {content}
    </>
  );

  if (isSidebar || isPanel) {
    return (
      <aside
        ref={asideRef}
        className={className}
        data-anchor={node.anchor}
        data-node={node.id}
        aria-hidden={narrow && !open ? true : undefined}
        // 点会话条目后自动收起抽屉。这里读的是插件内部类名，属于既有的宿主→插件
        // DOM 耦合；等插件提供服务端化的事件再替换（已记入 plugin-contract 的待办）。
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('.chat-session-item, .chat-session-new')) setDrawer('none');
        }}
      >
        {body}
      </aside>
    );
  }
  return (
    <div className={className} data-anchor={node.anchor} data-node={node.id}>
      {body}
    </div>
  );
}

// ============================================================================
// 标签组
// ============================================================================

interface TabDragState {
  nodeId: string;
  title: string;
  x: number;
  y: number;
  overTabsId: string | null;
  overIndex: number;
}

let tabDrag: TabDragState | null = null;
const tabDragSubs = new Set<() => void>();

function setTabDrag(next: TabDragState | null): void {
  tabDrag = next;
  tabDragSubs.forEach((fn) => fn());
}

function subscribeTabDrag(fn: () => void): () => void {
  tabDragSubs.add(fn);
  return () => {
    tabDragSubs.delete(fn);
  };
}

function useTabDrag(): TabDragState | null {
  return useSyncExternalStore(
    subscribeTabDrag,
    () => tabDrag,
    () => null,
  );
}

/**
 * tab 拖拽：指针事件 + 全屏 ghost，不用 HTML5 DnD
 * （DnD 在触摸上不可用、iframe 上方收不到 dragover、拖影无法定制）。
 *
 * 只在鼠标指针下启动：触摸设备上横向拖动与 tab 条的横向滚动会打架，
 * 移动端改用「更多」/长按菜单是后续计划，不在这里抢手势。
 */
function beginTabDrag(e: ReactPointerEvent<HTMLElement>, nodeId: string, title: string): void {
  if (e.pointerType !== 'mouse' || e.button !== 0) return;
  const startX = e.clientX;
  const startY = e.clientY;
  let started = false;
  let ghost: HTMLDivElement | null = null;

  const cleanup = (): void => {
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('pointercancel', onUp, true);
    ghost?.remove();
    ghost = null;
    document.body.classList.remove('ws-dragging-tab');
    setTabDrag(null);
  };

  const onMove = (ev: PointerEvent): void => {
    if (!started) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
      started = true;
      ghost = document.createElement('div');
      ghost.className = 'ws-tab-ghost';
      ghost.textContent = title;
      document.body.appendChild(ghost);
      document.body.classList.add('ws-dragging-tab');
    }
    if (ghost) ghost.style.transform = `translate(${ev.clientX + 12}px, ${ev.clientY + 8}px)`;
    // ghost 已设 pointer-events:none，elementFromPoint 命中的是下层容器
    const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
    const list = el?.closest('[data-ws-drop]') as HTMLElement | null;
    let overTabsId: string | null = null;
    let overIndex = 0;
    if (list) {
      overTabsId = list.dataset.wsDrop ?? null;
      const tabs = [...list.querySelectorAll<HTMLElement>('[data-ws-tab-id]')];
      overIndex = tabs.length;
      for (let i = 0; i < tabs.length; i += 1) {
        const r = tabs[i].getBoundingClientRect();
        if (ev.clientX < r.left + r.width / 2) {
          overIndex = i;
          break;
        }
      }
    }
    setTabDrag({ nodeId, title, x: ev.clientX, y: ev.clientY, overTabsId, overIndex });
  };

  const onUp = (): void => {
    const state = tabDrag;
    cleanup();
    if (!started || !state?.overTabsId) return;
    workspaceStore.move(state.nodeId, state.overTabsId, state.overIndex);
  };

  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointercancel', onUp, true);
}

function TabsView({ node }: { node: TabsNode }) {
  const drag = useTabDrag();
  const active = node.active;
  const children = node.children;
  const [mounted, setMounted] = useState<Set<string>>(() => new Set([active]));
  const [focusIdx, setFocusIdx] = useState(() => Math.max(0, children.findIndex((c) => c.id === active)));
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // 懒挂载 + 保活：首次激活才挂载，之后只隐藏不卸载
  useEffect(() => {
    setMounted((prev) => (prev.has(active) ? prev : new Set(prev).add(active)));
  }, [active]);

  // 激活项被外部改变（关闭 / 拖走 / 恢复布局）时同步 roving 焦点
  useEffect(() => {
    const i = children.findIndex((c) => c.id === active);
    if (i >= 0) setFocusIdx(i);
  }, [active, children]);

  // tab 条改自然宽度横向滚动后：激活项必须滚入视口（否则切 tab 后激活项停在视口外，
  // 用户要靠「＋n」菜单找回它）。block:'nearest' 保证纵向不滚动容器。
  const tabBtnRefs = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    const i = children.findIndex((c) => c.id === active);
    tabBtnRefs.current[i]?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  }, [active, children]);

  // 纵向滚轮转横向：tab 条唯一滚动轴是 x（与 SlotOutlet 的 tab 条同一交互约定）
  const tabsBarRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = tabsBarRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent): void => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const activate = useCallback(
    (id: string) => {
      workspaceStore.setActive(node.id, id);
    },
    [node.id],
  );

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const last = children.length - 1;
    let next = focusIdx;
    if (e.key === 'ArrowRight') next = focusIdx >= last ? 0 : focusIdx + 1;
    else if (e.key === 'ArrowLeft') next = focusIdx <= 0 ? last : focusIdx - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    else if (e.key === 'Enter' || e.key === ' ') {
      // 手动激活：焦点移动不触发挂载，避免连按方向键把每个插件都初始化一遍
      const target = children[focusIdx];
      if (target) {
        e.preventDefault();
        activate(target.id);
      }
      return;
    } else if (e.key === 'Delete' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'w')) {
      const target = children[focusIdx];
      if (target && isClosable(target)) {
        e.preventDefault();
        workspaceStore.close(target.id);
      }
      return;
    } else {
      return;
    }
    e.preventDefault();
    setFocusIdx(next);
    tabRefs.current[next]?.focus();
  };

  const dropIndex = drag?.overTabsId === node.id ? drag.overIndex : null;

  return (
    <div className="slot-tabs ws-tabs">
      <div
        className="slot-tabbar"
        role="tablist"
        aria-orientation="horizontal"
        aria-label="视图标签"
        data-ws-drop={node.id}
        ref={tabsBarRef}
        onKeyDown={onKeyDown}
      >
        {children.map((child, i) => {
          const name = titleOf(child);
          const selected = child.id === active;
          return (
            <button
              key={child.id}
              ref={(el) => {
                tabRefs.current[i] = el;
                tabBtnRefs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`ws-tab-${child.id}`}
              aria-controls={`ws-pane-${child.id}`}
              aria-selected={selected}
              // roving tabindex：整组只留一个 tab 停靠点，键盘用户不用按 N 次穿过 tab 条
              tabIndex={i === focusIdx ? 0 : -1}
              className={`slot-tab ${selected ? 'active' : ''}`}
              title={name}
              data-ws-tab-id={child.id}
              data-drop-before={dropIndex === i ? 'true' : undefined}
              onPointerDown={(e) => beginTabDrag(e, child.id, name)}
              onClick={() => activate(child.id)}
            >
              {name}
            </button>
          );
        })}
        {dropIndex !== null && dropIndex >= children.length && <span className="ws-drop-tail" aria-hidden="true" />}
      </div>
      <div className="slot-tabbody">
        {children.map((child) => {
          const selected = child.id === active;
          return (
            <div
              key={child.id}
              role="tabpanel"
              id={`ws-pane-${child.id}`}
              aria-labelledby={`ws-tab-${child.id}`}
              tabIndex={0}
              className="ws-tabpanel"
              // 用 display 而不是 visibility：前者让元素直接退出布局与无障碍树，
              // 也避免嵌套 4 层时每帧仍参与布局计算
              style={selected ? undefined : { display: 'none' }}
            >
              {/* tabs 里的视图没有窗格，因此也没有窗格的 ×：鼠标用户原本无法关闭它们
                  （只有 Delete / Ctrl+W）。这里补一个与窗格一致的浮动关闭按钮。 */}
              {selected && isClosable(child) && (
                <button
                  type="button"
                  className="ws-close ws-tab-close"
                  aria-label={`关闭 ${titleOf(child)}`}
                  title={`关闭 ${titleOf(child)}`}
                  onClick={() => workspaceStore.close(child.id)}
                >
                  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                  </svg>
                </button>
              )}
              {mounted.has(child.id) ? <NodeView node={child} /> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================================
// 分割
// ============================================================================

interface DragSession {
  splitId: string;
  mode: SplitSize['mode'];
  of: 'first' | 'second';
  dir: 'row' | 'col';
  fixedIdx: 0 | 1;
  startPos: number;
  startPx: number;
  containerPx: number;
}

function SplitView({ node }: { node: SplitNode }) {
  const narrow = useNarrow();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const paneRefs = useRef<[HTMLDivElement | null, HTMLDivElement | null]>([null, null]);
  const [preview, setPreview] = useState<SplitSize | null>(null);
  const session = useRef<DragSession | null>(null);
  const pendingPx = useRef<number | null>(null);
  const raf = useRef<number | null>(null);

  const effective = preview ?? node.size;
  const autoSide = autoOf(node);
  // 窄屏不分栏：窗格用 display:contents「溶解」掉，子元素直接成为纵向流的成员。
  // 侧栏/面板此时是 position:fixed 抽屉，会自己脱离文档流，因此不会留下空档。
  const [styleA, styleB] = narrow
    ? [
        { display: 'contents' } as CSSProperties,
        { display: 'contents' } as CSSProperties,
      ]
    : paneStyles(effective, node.dir);

  const cleanup = useCallback(() => {
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('pointercancel', onUp, true);
    delete document.body.dataset.wsResize;
    if (raf.current !== null) {
      cancelAnimationFrame(raf.current);
      raf.current = null;
    }
    session.current = null;
  }, []);

  const onMove = useCallback((ev: PointerEvent) => {
    const s = session.current;
    if (!s) return;
    const pos = s.dir === 'row' ? ev.clientX : ev.clientY;
    const delta = pos - s.startPos;
    // 固定侧在左/上时同向增长，在右/下时反向
    const raw = s.startPx + (s.fixedIdx === 0 ? delta : -delta);
    // 上限同时受 maxPx 与容器约束：拖到 1400px 再换到窄窗口时，pane 会撑爆容器；
    // 而超过 maxPx 的值本身会被校验器拒绝 → 用户看到「拖完弹回去」。
    const max = Math.min(WORKSPACE_LIMITS.maxPx, Math.max(MIN_PANE_PX, s.containerPx - MIN_PANE_PX));
    pendingPx.current = Math.min(Math.max(raw, MIN_PANE_PX), max);
    if (raf.current !== null) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = null;
      const px = pendingPx.current;
      if (px === null) return;
      setPreview({ mode: 'px', value: Math.round(px), of: s.of });
    });
  }, []);

  const onUp = useCallback(() => {
    const s = session.current;
    const px = pendingPx.current;
    cleanup();
    if (!s) return;
    setPreview(null);
    pendingPx.current = null;
    // 只是点了一下没拖动：不改尺寸，也不要把 ratio 无端转成 px
    if (px === null) return;
    // 上限同时受 maxPx 与容器约束：拖到 1400px 再换到窄窗口时，pane 会撑爆容器；
    // 而超过 maxPx 的值本身会被校验器拒绝 → 用户看到「拖完弹回去」。
    const max = Math.min(WORKSPACE_LIMITS.maxPx, Math.max(MIN_PANE_PX, s.containerPx - MIN_PANE_PX));
    const clamped = Math.min(Math.max(px, MIN_PANE_PX), max);
    if (s.mode === 'ratio') {
      const ratio = Math.min(Math.max(clamped / s.containerPx, WORKSPACE_LIMITS.minRatio), WORKSPACE_LIMITS.maxRatio);
      workspaceStore.setSize(s.splitId, { mode: 'ratio', value: Math.round(ratio * 1000) / 1000, of: s.of });
    } else {
      workspaceStore.setSize(s.splitId, { mode: 'px', value: Math.round(clamped), of: s.of });
    }
  }, [cleanup]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || narrow) return;
    const container = containerRef.current;
    if (!container) return;
    const of = node.size.of ?? 'first';
    const fixedIdx: 0 | 1 = of === 'first' ? 0 : 1;
    const pane = paneRefs.current[fixedIdx];
    if (!pane) return;
    const rect = container.getBoundingClientRect();
    const paneRect = pane.getBoundingClientRect();
    session.current = {
      splitId: node.id,
      mode: node.size.mode,
      of,
      dir: node.dir,
      fixedIdx,
      startPos: node.dir === 'row' ? e.clientX : e.clientY,
      startPx: node.dir === 'row' ? paneRect.width : paneRect.height,
      containerPx: node.dir === 'row' ? rect.width : rect.height,
    };
    pendingPx.current = null;
    setPreview(node.size);
    document.body.dataset.wsResize = node.dir;
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
    e.preventDefault();
  };

  /**
   * 双击 / Enter：回到「最自然」的状态。
   * - 主区/输入区列 → 内容自适应（auto）：用户拖一次就会把 auto 固化成 px，
   *   这里是他唯一能退回去的入口；
   * - 其余 ratio → 复位成一半。px 固定栏（侧栏 252 / 面板 320）不参与：
   *   改成 50% 会一口气吃掉半个屏幕且没有撤销——实测双击能让 252px 侧栏变 720px。
   */
  const resetSize = (): void => {
    if (autoSide) {
      workspaceStore.setSize(node.id, { mode: 'auto', of: autoSide });
      return;
    }
    if (node.size.mode === 'ratio') {
      workspaceStore.setSize(node.id, { mode: 'ratio', value: 0.5, of: node.size.of });
    }
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const container = containerRef.current;
    if (!container) return;
    const of = node.size.of ?? 'first';
    const fixedIdx: 0 | 1 = of === 'first' ? 0 : 1;
    const pane = paneRefs.current[fixedIdx];
    if (!pane) return;
    const rect = container.getBoundingClientRect();
    const paneRect = pane.getBoundingClientRect();
    const containerPx = node.dir === 'row' ? rect.width : rect.height;
    const currentPx = node.dir === 'row' ? paneRect.width : paneRect.height;
    const step = e.shiftKey ? 40 : 8;

    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      resetSize();
      return;
    }

    let delta: number;
    if (e.key === (node.dir === 'row' ? 'ArrowLeft' : 'ArrowUp')) delta = -step;
    else if (e.key === (node.dir === 'row' ? 'ArrowRight' : 'ArrowDown')) delta = step;
    else if (e.key === 'Home') delta = -containerPx;
    else if (e.key === 'End') delta = containerPx;
    else return;
    e.preventDefault();

    const raw = currentPx + (fixedIdx === 0 ? delta : -delta);
    const max = Math.min(WORKSPACE_LIMITS.maxPx, Math.max(MIN_PANE_PX, containerPx - MIN_PANE_PX));
    const px = Math.min(Math.max(raw, MIN_PANE_PX), max);
    if (node.size.mode === 'ratio') {
      const ratio = Math.min(Math.max(px / containerPx, WORKSPACE_LIMITS.minRatio), WORKSPACE_LIMITS.maxRatio);
      workspaceStore.setSize(node.id, { mode: 'ratio', value: Math.round(ratio * 1000) / 1000, of: node.size.of });
    } else {
      workspaceStore.setSize(node.id, { mode: 'px', value: Math.round(px), of: node.size.of });
    }
  };

  const aria = splitterAria(effective);
  // 主区/输入区在 px 或 ratio 下都提示可以回到「内容自适应」，否则用户不知道这条路存在
  const ariaText = autoSide && effective.mode !== 'auto' ? `${aria.text}（双击恢复内容自适应）` : aria.text;
  const first = node.children[0];
  const second = node.children[1];

  return (
    <div ref={containerRef} className={`ws-split ws-split-${narrow ? 'col' : node.dir}`} data-node={node.id}>
      <Pane
        node={first}
        style={styleA}
        onMount={(el) => {
          paneRefs.current[0] = el;
        }}
      />
      {!narrow && (
        <div
          className="ws-splitter"
          role="separator"
          aria-orientation={node.dir === 'row' ? 'vertical' : 'horizontal'}
          aria-label={`调整${titleOf(first)}与${titleOf(second)}的尺寸`}
          aria-valuenow={aria.now}
          aria-valuemin={aria.min}
          aria-valuemax={aria.max}
          aria-valuetext={ariaText}
          tabIndex={0}
          data-dir={node.dir}
          onPointerDown={onPointerDown}
          onKeyDown={onKeyDown}
          onDoubleClick={resetSize}
        />
      )}
      <Pane
        node={second}
        style={styleB}
        onMount={(el) => {
          paneRefs.current[1] = el;
        }}
      />
    </div>
  );
}

function Pane({ node, style, onMount }: { node: WorkspaceNode; style: CSSProperties; onMount: (el: HTMLDivElement | null) => void }) {
  const closable = isClosable(node);
  return (
    // `data-pane` 而不是 `data-node`：窗格与它承载的节点是两个元素（锚点/分割/tabs 自己在
    // 根节点上也带 data-node），同属性同值会让 `[data-node="anchor-panel"]` 命中窗格而不是锚点本体，
    // 移动端窗格是 display:contents（宽高为 0），量出来就是「面板宽度 0」的假故障。
    <div className="ws-pane" style={style} ref={onMount} data-pane={node.id}>
      {closable && (
        <button
          type="button"
          className="ws-close"
          aria-label={`关闭 ${titleOf(node)}`}
          title={`关闭 ${titleOf(node)}`}
          onClick={() => workspaceStore.close(node.id)}
        >
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
      )}
      <NodeView node={node} />
    </div>
  );
}

// ============================================================================
// 派发
// ============================================================================

const NodeView = memo(function NodeView({ node }: { node: WorkspaceNode }) {
  switch (node.kind) {
    case 'split':
      return <SplitView node={node} />;
    case 'tabs':
      return <TabsView node={node} />;
    case 'anchor':
      return <AnchorView node={node} />;
    case 'view':
      return <LeafView node={node} />;
  }
});

/** 工作区树入口：SlotLayout 把当前树交给它渲染 */

// ---- 宿主注入点(P2-2):核心经 LayoutRootProps 把锚点渲染与品牌下放 ----
import { setLayoutDeps, renderAnchor as layoutRenderAnchor, renderBrand as layoutRenderBrand, type AnchorRenderer } from './layoutDeps.tsx';

export function WorkspaceTree(props: { node: WorkspaceNode } & {
  renderAnchor: AnchorRenderer;
  renderBrand: () => ReactNode;
}) {
  // 注入写进模块级 deps(LeafView/AnchorView 深处同步取用;宿主单实例,时序安全)
  setLayoutDeps({ renderAnchor: props.renderAnchor, renderBrand: props.renderBrand });
  const { node } = props;
  // 断点变化时整树重渲是必要的（窄屏下所有 split 改单列）
  const narrow = useNarrow();
  const className = useMemo(() => `ws-root ${narrow ? 'ws-root-narrow' : ''}`, [narrow]);
  return (
    <div className={className} data-narrow={narrow ? 'true' : undefined}>
      <NodeView node={node} />
    </div>
  );
}

/**
 * 启动横幅：把「布局快照损坏已回默认」这类非致命问题暴露给用户，
 * 否则用户只会发现自己的布局莫名其妙变回去了。
 */
export function LayoutNotice() {
  const snap = useSyncExternalStore(workspaceStore.subscribe, workspaceStore.getSnapshot, workspaceStore.getSnapshot);
  const [dismissed, setDismissed] = useState<string | null>(null);
  // 提示在「下一次成功的结构变更」时会被清空。清空后同一条文案可能再次出现
  // （比如又有一个插件被下线），此时不能因为文案相同就永久静音。
  useEffect(() => {
    if (!snap.notice) setDismissed(null);
  }, [snap.notice]);
  if (!snap.notice || snap.notice === dismissed) return null;
  return (
    <div className="plite-layout-notice" role="status">
      <span>{snap.notice}</span>
      <button type="button" onClick={() => setDismissed(snap.notice)} aria-label="关闭提示">
        知道了
      </button>
    </div>
  );
}

// 供调试 / 端到端测试断言：树与注册表的只读视图
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__PLITE_WORKSPACE__ = {
    getTree: () => workspaceStore.getSnapshot().tree,
    getViews: () => listViewDefs(),
    reset: () => workspaceStore.reset(),
    // 让验收脚本不必依赖具体按钮，也能验证持久化与文件是否落地
    persisted: () => createLocalPersistence()?.read('plite.workspace.v1') ?? null,
  };
}
