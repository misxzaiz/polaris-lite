/**
 * 伪全屏（Popover top layer，2026-11-26 二次重写）
 *
 * 演进史（三个死掉的方案，给后来者省排查时间）：
 * 1. requestFullscreen：Android WebView 退出触发窗口焦点周期，实测某 ROM 会把
 *    沉浸模式重放（「退出后又变回全屏」），页面层/壳层均无解——弃。
 * 2. data-plite-ufs + 宿主 fixed 锚定：撞层叠上下文陷阱（.slot 的 z-index:0 +
 *    isolation:isolate 把全屏层关在槽内，顶栏/输入条压在上面，「盖不全 + 对话
 *    还能滚」），另需 :has() 反解宿主抽屉的 transform 劫持——宿主侧塞了 44 行
 *    还修不完，弃。
 * 3. Popover top layer（本方案）：el.popover='manual' + showPopover()——元素
 *    保持 DOM 原位（iframe 不重载、进度不丢），但被浏览器提升到所有层叠上下文
 *    之上渲染。.slot 隔离 / transform 劫持 / 门禁禁 fixed / 触摸滚动穿透，
 *    四个坑逐个天然免疫，宿主零改动。
 *
 * 兼容：popover 需 Chrome 114+（2023），2026 年 WebView 无虞；不支持时
 * 特性检测直接拒绝进入（按钮态不翻转，不会出现「点了没反应还以为全屏了」）。
 *
 * 退出路径（三条全收口到本模块）：
 * 1. 「退出全屏」按钮 → exitPseudoFullscreen()
 * 2. Esc → 模块级 keydown 监听（popover='manual' 不自动收 Esc）
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
  try {
    activeEl.hidePopover();
  } catch {
    /* 未显示时 hidePopover 抛 InvalidStateError——幂等容错 */
  }
  activeEl = null;
  notify();
}

/** 进入伪全屏。同一时刻只允许一个全屏层（activeEl 守卫）。 */
export function enterPseudoFullscreen(el: HTMLElement | null): void {
  if (!el || activeEl) return;
  if (typeof (el as unknown as { showPopover?: unknown }).showPopover !== 'function') return;
  el.setAttribute('popover', 'manual');
  el.showPopover();
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
  return !!el && el.matches(':popover-open');
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
// - Esc：桌面键盘习惯退出（popover='manual' 语义不自动收）。
if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => {
    const st = history.state as { pliteUfs?: boolean } | null;
    if (!(st && st.pliteUfs)) finalize();
  });
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') exitPseudoFullscreen();
  });
}
