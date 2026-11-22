/**
 * 壳层状态：移动端抽屉 + 断点。
 *
 * 从 SlotLayout 抽出来是为了打破循环依赖：树渲染器要画锚点，需要知道「当前是不是窄屏、
 * 抽屉开着没有」，而树渲染器又被 SlotLayout 引用。把这份状态放进独立模块，
 * 两边都只依赖它，不再互相依赖。
 *
 * 两份状态都是模块级 + 订阅，不放进 React state 树：抽屉开关是**壳层级**的，
 * 不属于任何一棵子树，放 state 里会导致整棵树重渲。
 */

export type LayoutDrawer = 'none' | 'sidebar' | 'panel';

// ---------- 抽屉 ----------

let currentDrawer: LayoutDrawer = 'none';
const drawerSubs = new Set<(d: LayoutDrawer) => void>();

// 抽屉跨模块同步（P2-2 必修包修1）:布局插件经 stateBridge 只读镜像本状态。
// 变更双向通知:本侧 setDrawer 派发事件(插件侧监听同步);插件侧 setDrawer 也派发,
// 本侧监听同步——监听方**不得**再派发(防环;派发只发生在两侧 setDrawer 入口)。
// 通道名 = @sdk CHANNEL_DRAWER_STATE / CHANNEL_DRAWER_EVENT,宿主侧就地字面量对齐。
const DRAWER_EVENT = 'plite-drawer-changed';

function mirrorDrawer(d: LayoutDrawer): void {
  try {
    (window as unknown as Record<string, unknown>)['__PLITE_DRAWER_STATE__'] = d;
    window.dispatchEvent(new CustomEvent(DRAWER_EVENT, { detail: d }));
  } catch { /* 非浏览器环境忽略 */ }
}

// 初始化即发布初值 + 监听插件侧变更(不得再派发,防环)
if (typeof window !== 'undefined') {
  try {
    (window as unknown as Record<string, unknown>)['__PLITE_DRAWER_STATE__'] = currentDrawer;
    window.addEventListener(DRAWER_EVENT, (e) => {
      const d = (e as CustomEvent<LayoutDrawer>).detail;
      if (d && d !== currentDrawer && ['none', 'sidebar', 'panel'].includes(d)) {
        currentDrawer = d;
        drawerSubs.forEach((fn) => fn(d));
      }
    });
  } catch { /* 非浏览器环境忽略 */ }
}

export function setDrawer(d: LayoutDrawer): void {
  if (currentDrawer === d) return;
  currentDrawer = d;
  drawerSubs.forEach((fn) => fn(d));
  mirrorDrawer(d);
}

export function getDrawer(): LayoutDrawer {
  return currentDrawer;
}

export function subscribeDrawer(fn: (d: LayoutDrawer) => void): () => void {
  drawerSubs.add(fn);
  return () => {
    drawerSubs.delete(fn);
  };
}

// ---------- 断点 ----------

const NARROW_QUERY = '(max-width: 768px)';

function readNarrow(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia(NARROW_QUERY).matches;
}

let currentNarrow = readNarrow();
const narrowSubs = new Set<(n: boolean) => void>();

export function getIsNarrow(): boolean {
  return currentNarrow;
}

export function subscribeNarrow(fn: (n: boolean) => void): () => void {
  narrowSubs.add(fn);
  return () => {
    narrowSubs.delete(fn);
  };
}

/** 断点变化：变宽时自动关闭抽屉，否则抽屉会「卡」在桌面布局上 */
function applyNarrow(next: boolean): void {
  if (currentNarrow === next) return;
  currentNarrow = next;
  narrowSubs.forEach((fn) => fn(next));
  if (!next) setDrawer('none');
}

if (typeof window !== 'undefined') {
  const mq = window.matchMedia(NARROW_QUERY);
  const onChange = (e: MediaQueryListEvent) => applyNarrow(e.matches);
  if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange);
  else if (typeof (mq as MediaQueryList).addListener === 'function') {
    // Safari 13 及更早
    (mq as MediaQueryList).addListener(onChange);
  }
  // resize 兜底：部分 WebView（分数 DPI 缩放 / 视口注入式 resize）不派发 media query change
  // 事件，断点会冻结在加载时的值（实测表现为窗口拉宽后仍单列堆叠、面板仍全宽）。
  // resize 在真实浏览器里只在窗口变化时触发且已做事件合并，兜底成本为零。
  window.addEventListener('resize', () => applyNarrow(readNarrow()));
}

/** 测试/SSR 用：强制设置断点状态 */
export function __setNarrowForTest(next: boolean): void {
  applyNarrow(next);
}

export function isMobileViewport(): boolean {
  return currentNarrow;
}

// ---------- 启动告警 ----------

/**
 * 启动告警（插件加载失败 / 权限收紧 / 视图声明被拒）。
 *
 * 以前是 `document.body.appendChild(<div position:fixed>)`：它盖在壳层最上方，
 * 把侧栏品牌和面板自己的 tab 条一起压掉 37px——出问题的场景恰恰最需要看清界面。
 * 改成壳层里的第一行（flex 子项），告警占位、界面下移，且可以关掉。
 *
 * 也不能只打在 console：插件没装成功在 UI 上表现为「某个面板空了」，
 * 用户和开发者都不会去看控制台。
 */
export interface BootNotice {
  id: number;
  title: string;
  lines: string[];
}

let notices: BootNotice[] = [];
let noticeSeq = 0;
const noticeSubs = new Set<() => void>();

export function pushNotice(title: string, lines: string[]): void {
  if (lines.length === 0) return;
  noticeSeq += 1;
  notices = [...notices, { id: noticeSeq, title, lines }];
  noticeSubs.forEach((fn) => fn());
}

export function dismissNotice(id: number): void {
  const next = notices.filter((n) => n.id !== id);
  if (next.length === notices.length) return;
  notices = next;
  noticeSubs.forEach((fn) => fn());
}

export function getNotices(): BootNotice[] {
  return notices;
}

export function subscribeNotices(fn: () => void): () => void {
  noticeSubs.add(fn);
  return () => {
    noticeSubs.delete(fn);
  };
}
