/**
 * 全屏 + 方向保持（移动端补丁）。
 *
 * 现象（用户手机实测）：点「全屏」后屏幕被浏览器强制转成横屏。
 * 根因：我们用的是浏览器原生 `requestFullscreen()`，页面没有任何方向锁定
 * （无 manifest orientation、无 screen-orientation meta、无 orientation.lock）。
 * 大量安卓浏览器把「网页全屏」默认当成「看视频」场景，进全屏时直接把屏幕切成
 * landscape；iOS Safari 则保持竖屏。这不是 CSS 造成的。
 *
 * 对冲手段是 Screen Orientation API，但有两个坑：
 * 1. `lock('landscape')` 只在全屏态才允许；`lock('portrait')` 通常随时可锁——
 *    所以竖屏场景要在**进全屏之前**就把竖屏锁上（等进全屏再锁，浏览器的强制
 *    翻转已经发生，后锁可能被拒或来不及）；
 * 2. 锁定目标取「点击那一刻的朝向」：竖着点锁竖屏，横着点锁横屏——既不被浏览器
 *    强制翻转，也不夺走用户本来就想要的横屏。横屏锁在全屏确认后补一次（防拒重试）。
 *
 * 兼容性：lock() 只在移动端全屏态生效；桌面/不支持的环境抛错或被忽略，一律静默
 * 降级，全屏本身照常工作（宁可方向不受控，也不能让全屏按钮失效）。
 */

type OrientationLock = 'portrait' | 'landscape';

interface ScreenOrientationLike {
  type?: string;
  lock?: (orientation: string) => Promise<void>;
  unlock?: () => void;
}

function getOrientationApi(): ScreenOrientationLike | null {
  const so = (screen as unknown as { orientation?: ScreenOrientationLike }).orientation;
  return so && typeof so === 'object' ? so : null;
}

/** 当前朝向（优先看用户此刻看到的视口形状，再退回屏幕方向 API） */
export function currentOrientation(): OrientationLock {
  if (window.innerWidth && window.innerHeight && window.innerWidth !== window.innerHeight) {
    return window.innerWidth > window.innerHeight ? 'landscape' : 'portrait';
  }
  const type = getOrientationApi()?.type;
  if (typeof type === 'string' && type) {
    return type.startsWith('landscape') ? 'landscape' : 'portrait';
  }
  return 'portrait';
}

async function tryLock(orientation: OrientationLock): Promise<boolean> {
  try {
    await getOrientationApi()?.lock?.(orientation);
    return true;
  } catch {
    return false; // 桌面 / 不支持 / 与浏览器强制策略冲突
  }
}

/** 释放方向锁（退出全屏后调用；浏览器多半已自动释放，这里兜底） */
export function releaseOrientationLock(): void {
  try {
    getOrientationApi()?.unlock?.();
  } catch {
    /* 不支持就忽略 */
  }
}

/**
 * 进入全屏，并尽量保持进入前的朝向。
 * 调用方需在用户手势（click）中直接调用，否则 requestFullscreen 会被拒绝。
 *
 * 顺序很关键：
 * 1. 全屏**前**先按当前朝向锁一次——竖屏场景这一步就足够防翻转；
 * 2. requestFullscreen；
 * 3. 横屏场景（lock('landscape') 多数浏览器要求全屏态）在全屏确认后补锁，
 *    失败再试一次（个别浏览器第一次 lock 在翻转动画里会拒）。
 */
export async function enterFullscreenKeepingOrientation(el: HTMLElement | null): Promise<void> {
  if (!el || typeof el.requestFullscreen !== 'function') return;
  const want = currentOrientation(); // 全屏前采样，全屏后读到的可能已经被浏览器翻过去了
  if (want === 'portrait') {
    await tryLock('portrait'); // 竖屏锁不依赖全屏态：进全屏前先钉住，防浏览器强制横屏
  }
  try {
    await el.requestFullscreen();
  } catch {
    return; // 无权限 / 不支持（如 iPhone Safari 上的非视频元素）→ 静默
  }
  if (want === 'landscape') {
    // 横屏锁需要全屏态；刚进全屏可能还在翻转动画里，补一次重试
    if (!(await tryLock('landscape'))) {
      await new Promise((r) => setTimeout(r, 300));
      await tryLock('landscape');
    }
  }
}

/** 退出全屏并释放可能存在的方向锁 */
export function exitFullscreenAndUnlock(): void {
  if (document.fullscreenElement) {
    void document.exitFullscreen?.().catch(() => undefined);
  }
  releaseOrientationLock();
}
