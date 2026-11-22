/**
 * goal-keeper 存取层（面板与检查编排共用）。
 *
 * 目标存储经 cap.kv（namespace='goal-keeper'，服务端 sqlite）：
 *   key = 'goal:<sessionId>' → GoalRecord
 * 会话上下文直接读 chat-store 的私有数据面 GET /api/chat/sessions/:id（同源 fetch
 * + credentials，与 chat-lite store.ts 同模式——会话存取不经 cap 总线，见 chat-store
 * 插件头注释；本插件以「同源页面脚本」身份只读，不构成跨插件能力）。
 */
import type { SlotHostApi } from '@sdk';
import { DEFAULT_SETTINGS, newGoal, type GoalRecord } from './model-types';

export const NS = 'goal-keeper';

let api: SlotHostApi | null = null;
export function setGoalApi(a: SlotHostApi | null): void { api = a; }

async function kvGet<T>(key: string): Promise<T | null> {
  if (!api) return null;
  const res = await api.dispatch<{ value?: T }>({ target: 'cap.kv', action: 'get', payload: { namespace: NS, key } });
  return res.ok ? (res.data?.value ?? null) : null;
}

async function kvSet(key: string, value: unknown): Promise<void> {
  await api?.dispatch({ target: 'cap.kv', action: 'set', payload: { namespace: NS, key, value } });
}

export function goalKey(sessionId: string): string {
  return `goal:${sessionId}`;
}

export async function loadGoal(sessionId: string): Promise<GoalRecord | null> {
  const raw = await kvGet<Partial<GoalRecord>>(goalKey(sessionId));
  if (!raw || typeof raw.goalText !== 'string') return null;
  return {
    ...newGoal(raw.goalText),
    ...raw,
    settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
  } as GoalRecord;
}

export async function saveGoal(sessionId: string, goal: GoalRecord): Promise<void> {
  await kvSet(goalKey(sessionId), goal);
}

export async function removeGoal(sessionId: string): Promise<void> {
  await kvSet(goalKey(sessionId), null);
}

/** 面板/检查层刷新通知（模块内事件 + DOM 事件双通道，Panel 监听后者） */
export function notifyChanged(): void {
  try { window.dispatchEvent(new CustomEvent('goal-changed')); } catch { /* ssr 保护 */ }
}

/** 当前活跃会话 id：从 location 查询参数拿（chat-lite 会话切换即换 URL） */
export function currentSessionId(): string {
  try {
    const m = window.location.search.match(/[?&]s=([^&]+)/);
    if (m) return decodeURIComponent(m[1]);
  } catch { /* ignore */ }
  return '';
}

/** 会话尾部消息（给检查 agent 的证据材料）。返回 [{role, text}]，超长截断。 */
export async function fetchSessionTail(
  sessionId: string,
  maxMessages = 20,
  maxCharsPer = 400,
): Promise<{ role: string; text: string }[]> {
  if (!sessionId) return [];
  try {
    const resp = await fetch(`/api/chat/sessions/${encodeURIComponent(sessionId)}`, { credentials: 'include' });
    if (!resp.ok) return [];
    const data = (await resp.json()) as {
      session?: { messages?: { role?: string; content?: string | { text?: string }[] }[] };
    };
    const messages = data.session?.messages ?? [];
    const tail = messages.slice(-maxMessages);
    return tail.map((m) => {
      let text = '';
      if (typeof m.content === 'string') text = m.content;
      else if (Array.isArray(m.content)) text = m.content.map((c) => c?.text ?? '').join(' ');
      if (text.length > maxCharsPer) text = `${text.slice(0, maxCharsPer)}…`;
      return { role: String(m.role ?? 'unknown'), text };
    }).filter((m) => m.text.length > 0);
  } catch {
    return [];
  }
}
