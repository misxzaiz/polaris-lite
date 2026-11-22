/**
 * 窄屏断点桥接：shell-chrome 与宿主 shellState 共用同一份 matchMedia 断点。
 *
 * 插件不能 import 宿主实现（arch 门禁），但断点值「(max-width: 768px)」是视觉契约——
 * 在此就地定义同一字面量（同 @sdk 共享常量的纪律：字面量只定义一次,另一侧对齐）。
 * 若宿主调整断点,需同步本文件与 src/core/shellState.ts。
 */
const NARROW_QUERY = '(max-width: 768px)';

function readNarrow(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia(NARROW_QUERY).matches;
}

const subs = new Set<(n: boolean) => void>();
let initialized = false;
let current = false;

function ensureInit(): void {
  if (initialized || typeof window === 'undefined' || !window.matchMedia) return;
  initialized = true;
  current = readNarrow();
  const mql = window.matchMedia(NARROW_QUERY);
  mql.addEventListener?.('change', () => {
    current = mql.matches;
    subs.forEach((fn) => fn(current));
  });
}

export function getIsNarrow(): boolean {
  ensureInit();
  return current || readNarrow();
}

export function subscribeNarrow(fn: (n: boolean) => void): () => void {
  ensureInit();
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}
