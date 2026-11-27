/**
 * session-hud 内部状态：当前会话标题。
 *
 * 数据来源是事件旁听（零 chat-lite 依赖）：
 * 'session.title:changed'（chat-lite 广播）：当前会话 id/标题/首条消息。
 *
 * 不持久化：顶栏标题是「当前会话的实时显示」，刷新后由 chat-lite
 * 重连时的广播重建。
 */

export interface HudState {
  sessionId: string | null;
  title: string | null;
  firstMessage: string | null;
}

let state: HudState = { sessionId: null, title: null, firstMessage: null };
const subs = new Set<() => void>();

function notify(): void {
  subs.forEach((fn) => fn());
}

export function subscribe(fn: () => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

export function getState(): HudState {
  return state;
}

export function setTitle(sessionId: string | null, title: string | null, firstMessage: string | null): void {
  state = { sessionId, title, firstMessage };
  notify();
}

/** 显示口径：'新会话' 未命名时取首条消息前 18 字（对齐 SessionSidebar.displayTitle） */
export function displayTitle(s: HudState): string {
  if (s.title && s.title !== '新会话') return s.title;
  if (s.firstMessage) return s.firstMessage.replace(/\s+/g, ' ').trim().slice(0, 18);
  return s.title ?? 'Polaris Lite';
}
