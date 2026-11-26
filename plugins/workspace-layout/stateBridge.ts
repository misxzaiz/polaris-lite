/**
 * 壳层状态桥(P2-2):drawer(移动端抽屉)与窄屏断点。
 * 插件不能 import 宿主 shellState(arch 门禁)——drawer 是跨模块共享态,
 * 经 window 通道双向同步(与 CHANNEL_* 同纪律:通道名先入 @sdk 登记)。
 * 断点字面量与宿主 shellState 对齐((max-width: 768px))。
 */
import { useSyncExternalStore } from 'react';
import { CHANNEL_DRAWER_EVENT, CHANNEL_DRAWER_STATE } from '@sdk';

// 通道名 = @sdk CHANNEL_DRAWER_STATE / CHANNEL_DRAWER_EVENT
// （宿主 shellState 就地字面量对齐,值一致;暗通道门禁禁止本目录裸字面量,统一走 @sdk）
const DRAWER_KEY = CHANNEL_DRAWER_STATE;
const DRAWER_EVENT = CHANNEL_DRAWER_EVENT;

type Drawer = 'none' | 'sidebar' | 'panel';

function readDrawer(): Drawer {
  if (typeof window === 'undefined') return 'none';
  const w = window as unknown as Record<string, unknown>;
  return (w[DRAWER_KEY] as Drawer) ?? 'none';
}

const subs = new Set<(d: Drawer) => void>();
let bridgeInit = false;

/** 监听宿主(或本插件 setDrawer)派发的变更事件,同步插件订阅者——不写盘、不派发(防环) */
function ensureBridge(): void {
  if (bridgeInit || typeof window === 'undefined') return;
  bridgeInit = true;
  window.addEventListener(DRAWER_EVENT, (e) => {
    const d = (e as CustomEvent<Drawer>).detail;
    if (d && ['none', 'sidebar', 'panel'].includes(d)) subs.forEach((fn) => fn(d));
  });
}

export function getDrawer(): Drawer {
  return readDrawer();
}

/** 只读订阅:先同步一次当前值(初值不再靠巧合),此后随宿主/插件变更通知 */
export function subscribeDrawer(fn: (d: Drawer) => void): () => void {
  ensureBridge();
  subs.add(fn);
  fn(readDrawer());
  return () => {
    subs.delete(fn);
  };
}

/** 插件侧变更(布局树内关闭抽屉等):写盘 + 派发事件(宿主监听同步) + 本地通知 */
export function setDrawer(d: Drawer): void {
  if (typeof window !== 'undefined') {
    const w = window as unknown as Record<string, unknown>;
    w[DRAWER_KEY] = d;
    window.dispatchEvent(new CustomEvent(DRAWER_EVENT, { detail: d }));
  }
  subs.forEach((fn) => fn(d));
}

// ---- 窄屏断点(与 shell-chrome/narrowBridge 同纪律) ----
// 2026-11-26 移动端修复：与宿主 shellState 同步扩展为「宽度或触屏」并集
// （手机横屏 >768px 也要走移动形态）。字面量与 shellState.ts 严格对齐。
const NARROW_QUERY = '(max-width: 768px), (hover: none) and (pointer: coarse)';

function readNarrow(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia(NARROW_QUERY).matches;
}

const narrowSubs = new Set<(n: boolean) => void>();
let narrowInit = false;
let narrowNow = false;

function ensureNarrow(): void {
  if (narrowInit || typeof window === 'undefined' || !window.matchMedia) return;
  narrowInit = true;
  narrowNow = readNarrow();
  const mql = window.matchMedia(NARROW_QUERY);
  mql.addEventListener?.('change', () => {
    narrowNow = mql.matches;
    narrowSubs.forEach((fn) => fn(narrowNow));
  });
}

export function getIsNarrow(): boolean {
  ensureNarrow();
  return narrowNow || readNarrow();
}

export function subscribeNarrow(fn: (n: boolean) => void): () => void {
  ensureNarrow();
  narrowSubs.add(fn);
  return () => {
    narrowSubs.delete(fn);
  };
}

export function useNarrow(): boolean {
  return useSyncExternalStore(subscribeNarrow, getIsNarrow, () => false);
}
