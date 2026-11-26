/**
 * 伪全屏（CSS overlay，2026-11-26 重写）
 *
 * 背景（为什么放弃 requestFullscreen）：Android WebView 的 DOM 全屏走系统级
 * custom view，退出时移除 view 会触发窗口焦点周期，实测某 ROM 会把沉浸模式
 * 重放——表现为「点退出全屏后画面又变回全屏」。双击重入冷却、全屏中禁重入等
 * 页面层防御全部无效（重放不是页面发起的）。历史结论：该 ROM 的系统栏 hide
 * 同样会被焦点周期重置（MainActivity 注释），页面层与壳层均无解。
 *
 * 根治 = 不触发：全屏层改为 data-plite-ufs 属性驱动的 fixed 覆盖层
 * （fixed 锚定由宿主 styles.css 持有——构建门禁禁插件 CSS 用 position:fixed），
 * 全程不调 requestFullscreen → 系统全屏层/焦点周期重放/强制转横屏（方向锁机制
 * 存在的唯一理由）一并消失。iframe 原元素原位不动，零重载。
 *
 * 退出路径（三条全收口到本模块）：
 * 1. 「退出全屏」按钮 → exitPseudoFullscreen()
 * 2. Esc → 模块级 keydown 监听
 * 3. Android 返回键 → 进入时 pushState 压栈，返回键先弹我们的 state，
 *    popstate 里 finalize（返回键「先退全屏再退页面」）。
 */

let activeEl: HTMLElement | null = null;
const listeners = new Set<(el: HTMLElement | null) => void>();

function notify(): void {
  for (const cb of listeners) cb(activeEl);
}

/** 摘层收尾（popstate / 直接退出共用）。幂等。 */
function finalize(): void {
  if (!activeEl) return;
  activeEl.removeAttribute('data-plite-ufs');
  activeEl = null;
  notify();
}

/** 进入伪全屏。同一时刻只允许一个全屏层（activeEl 守卫）。 */
export function enterPseudoFullscreen(el: HTMLElement | null): void {
  if (!el || activeEl) return;
  el.setAttribute('data-plite-ufs', '');
  activeEl = el;
  history.pushState({ pliteUfs: true }, '');
  notify();
}

/**
 * 退出伪全屏。进入时压的 state 还在栈顶 → history.back() 让返回键路径与
 * 按钮路径共用同一条收敛链；若栈顶已被别人占（罕见：其他浮层后来又压了
 * state），直接 finalize，宁可留一个无害的孤儿 state 也不误弹别人的栈。
 */
export function exitPseudoFullscreen(): void {
  if (!activeEl) return;
  const st = history.state as { pliteUfs?: boolean } | null;
  if (st && st.pliteUfs) history.back(); // popstate → finalize
  else finalize();
}

export function isPseudoFullscreen(el: HTMLElement | null): boolean {
  return !!el && el.hasAttribute('data-plite-ufs');
}

/** 订阅全屏层变化（进入/退出都通知；回调参数 = 当前的全屏元素或 null）。 */
export function onPseudoFullscreenChange(cb: (el: HTMLElement | null) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

// 模块级全局监听，挂一次：
// - popstate：返回键/浏览器后退弹栈 → 非全屏 state 时收层；
// - Esc：桌面键盘习惯退出。
if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => {
    const st = history.state as { pliteUfs?: boolean } | null;
    if (!(st && st.pliteUfs)) finalize();
  });
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') exitPseudoFullscreen();
  });
}
