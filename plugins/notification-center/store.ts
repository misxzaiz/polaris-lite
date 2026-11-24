/**
 * notification-center 通知存储（模块级单例，面板与 toast 同源）。
 *
 * 设计（对齐 pocket-ledger store 的 api 桥模式）：
 * - 持久化走 cap.kv（namespace='notification-center'，服务端 sqlite），key='inbox'；
 *   面板历史多端一致；toast 展示态是瞬时的，不落盘。
 * - 变更通知：宿主事件总线 'notifications-changed' + 同页 DOM 事件双通道
 *   （面板即时刷新；跨插件监听走总线，同页 UI 走 DOM）。
 * - 未读数 = inbox 里 unread=true 的条数（id 幂等去重）。
 */
import type { SlotHostApi } from '@sdk';

export type NotifyLevel = 'info' | 'success' | 'warn' | 'error';

export interface NotifyItem {
  id: string;
  level: NotifyLevel;
  title: string;
  body?: string;
  at: number;
  read: boolean;
  /** 来源插件 id（宿主 dispatch 时由总线注入？——cap 无溯源，这里由 payload 透传） */
  source?: string;
}

const NS = 'notification-center';
const KEY = 'inbox';
export const MAX_INBOX = 100;
/** toast 同时最多可见条数，溢出折叠为 +N */
export const MAX_VISIBLE = 3;
/** 非 error 级自动消退时长 */
export const TOAST_TTL_MS = 5000;

let api: SlotHostApi | null = null;
let cache: NotifyItem[] | null = null;
const subs = new Set<() => void>();

export function setNotifyApi(a: SlotHostApi | null): void {
  api = a;
}

export function subscribe(fn: () => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

function emitChanged(): void {
  api?.emit('notifications-changed', { at: Date.now() });
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('notifications-changed'));
  subs.forEach((fn) => fn());
}

function dedupeById(list: NotifyItem[]): NotifyItem[] {
  const seen = new Set<string>();
  const out: NotifyItem[] = [];
  for (const it of list) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    out.push(it);
  }
  return out;
}

export async function loadInbox(): Promise<NotifyItem[]> {
  if (cache) return cache;
  if (!api) return [];
  try {
    const res = await api.dispatch<{ value?: NotifyItem[] | null }>({
      target: 'cap.kv', action: 'get', payload: { namespace: NS, key: KEY },
    });
    const raw = res.ok ? res.data?.value : null;
    cache = Array.isArray(raw) ? dedupeById(raw).slice(0, MAX_INBOX) : [];
  } catch {
    cache = cache ?? [];
  }
  return cache;
}

async function persist(list: NotifyItem[]): Promise<void> {
  cache = list;
  try {
    await api?.dispatch({
      target: 'cap.kv', action: 'set', payload: { namespace: NS, key: KEY, value: list },
    });
  } catch {
    /* 持久化失败不阻断 UI：会话内仍可见 */
  }
  emitChanged();
}

/** 写入一条通知（去重、置顶、截断到 MAX_INBOX），返回更新后的 inbox */
export async function pushNotice(item: Omit<NotifyItem, 'at' | 'read'> & { at?: number; read?: boolean }): Promise<NotifyItem[]> {
  const list = await loadInbox();
  const next = dedupeById([
    { ...item, at: item.at ?? Date.now(), read: item.read ?? false },
    ...list,
  ]).slice(0, MAX_INBOX);
  await persist(next);
  return next;
}

export async function markRead(id: string): Promise<void> {
  const list = await loadInbox();
  if (!list.some((n) => n.id === id && !n.read)) return;
  await persist(list.map((n) => (n.id === id ? { ...n, read: true } : n)));
}

export async function markAllRead(): Promise<void> {
  const list = await loadInbox();
  if (!list.some((n) => !n.read)) return;
  await persist(list.map((n) => ({ ...n, read: true })));
}

export async function clearInbox(): Promise<void> {
  await persist([]);
}

export function unreadCount(list: NotifyItem[]): number {
  return list.filter((n) => !n.read).length;
}
