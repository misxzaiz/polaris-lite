/**
 * 会话状态 store（chat-lite 私有，核心不持有任何会话状态）。
 *
 * 设计要点：
 * - 单写者：引擎事件驱动写入，UI 只读；一条消息在流式期间可被高频 update，
 *   因此写盘走「防抖 + 容量上限」，不做逐 delta 持久化；
 * - 持久化：localStorage `chat-lite.sessions.v1`，刷新/重开页面不丢会话；
 *   超出容量时从最旧的会话开始丢弃（lite 形态不做分片存储）；
 * - 待发队列（流式预输入）随会话存在内存里，**不持久化**（重开页面视为放弃排队），
 *   队列项携带完整附件，避免「排队后图片丢失」。
 */
import { create } from 'zustand';
import type { ChatMessage, ChatSession } from '@sdk';
import type { Attachment } from './attachments';

const STORAGE_KEY = 'chat-lite.sessions.v1';
const PERSIST_DEBOUNCE_MS = 800;
/** 单库容量上限：超过则丢弃最旧会话（1.5MB ≈ 数十万字对话） */
const MAX_BYTES = 1_500_000;

/** 待发队列项：文本 + 完整附件（附件不再压成 `[附件: name]` 文本） */
export interface PendingSend {
  id: string;
  text: string;
  attachments: Attachment[];
  createdAt: number;
}

interface PersistShape {
  sessions: ChatSession[];
  activeId: string | null;
  savedAt: number;
}

interface SessionState {
  sessions: ChatSession[];
  activeId: string | null;
  /** 待发队列：sessionId → 队列（内存态，不落盘） */
  pending: Record<string, PendingSend[]>;
  createSession: (title?: string) => string;
  setActive: (id: string) => void;
  renameSession: (id: string, title: string) => void;
  deleteSession: (id: string) => void;
  appendMessage: (sessionId: string, msg: ChatMessage) => void;
  updateMessage: (sessionId: string, msgId: string, patch: Partial<ChatMessage>) => void;
  enqueue: (sessionId: string, item: PendingSend) => void;
  shiftPending: (sessionId: string) => PendingSend | null;
  clearPending: (sessionId: string) => void;
}

/** ---- 持久化（防抖 + 容量裁剪） ---- */
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersist(get: () => SessionState): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      const { sessions, activeId } = get();
      // 流式标记不可跨会话存活：刷新后残留 streaming 会锁死输入框
      const clean = sessions.map((s) => ({
        ...s,
        messages: s.messages.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
      }));
      let payload: PersistShape = { sessions: clean, activeId, savedAt: Date.now() };
      let raw = JSON.stringify(payload);
      // 超限：从最旧会话开始丢（sessions 按创建时间倒序，尾部最旧）
      while (raw.length > MAX_BYTES && payload.sessions.length > 1) {
        payload = { ...payload, sessions: payload.sessions.slice(0, -1) };
        if (!payload.sessions.some((s) => s.id === payload.activeId)) {
          payload.activeId = payload.sessions[0]?.id ?? null;
        }
        raw = JSON.stringify(payload);
      }
      localStorage.setItem(STORAGE_KEY, raw);
    } catch {
      /* 隐私模式 / 配额不足：静默降级为纯内存 */
    }
  }, PERSIST_DEBOUNCE_MS);
}

function hydrate(): { sessions: ChatSession[]; activeId: string | null } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { sessions: [], activeId: null };
    const data = JSON.parse(raw) as PersistShape;
    const sessions = (Array.isArray(data.sessions) ? data.sessions : [])
      .filter((s) => s && typeof s.id === 'string')
      .map((s) => ({
        ...s,
        messages: (Array.isArray(s.messages) ? s.messages : []).map((m) => ({ ...m, streaming: false })),
      }));
    const activeId = sessions.some((s) => s.id === data.activeId) ? data.activeId : (sessions[0]?.id ?? null);
    return { sessions, activeId };
  } catch {
    return { sessions: [], activeId: null };
  }
}

const initial = hydrate();

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: initial.sessions,
  activeId: initial.activeId,
  pending: {},

  createSession: (title) => {
    const id = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const session: ChatSession = { id, title: title ?? '新会话', messages: [], createdAt: Date.now() };
    set((st) => ({ sessions: [session, ...st.sessions], activeId: id }));
    schedulePersist(get);
    return id;
  },

  setActive: (id) => {
    set({ activeId: id });
    schedulePersist(get);
  },

  renameSession: (id, title) => {
    set((st) => ({ sessions: st.sessions.map((s) => (s.id === id ? { ...s, title } : s)) }));
    schedulePersist(get);
  },

  deleteSession: (id) => {
    set((st) => {
      const sessions = st.sessions.filter((s) => s.id !== id);
      const { [id]: _dropped, ...pending } = st.pending;
      return {
        sessions,
        pending,
        activeId: st.activeId === id ? (sessions[0]?.id ?? null) : st.activeId,
      };
    });
    schedulePersist(get);
  },

  appendMessage: (sessionId, msg) => {
    set((st) => ({
      sessions: st.sessions.map((s) => (s.id === sessionId ? { ...s, messages: [...s.messages, msg] } : s)),
    }));
    schedulePersist(get);
  },

  updateMessage: (sessionId, msgId, patch) => {
    set((st) => ({
      sessions: st.sessions.map((s) =>
        s.id === sessionId
          ? { ...s, messages: s.messages.map((m) => (m.id === msgId ? { ...m, ...patch } : m)) }
          : s,
      ),
    }));
    schedulePersist(get); // 防抖：流式高频更新只会落一次
  },

  enqueue: (sessionId, item) => {
    set((st) => ({ pending: { ...st.pending, [sessionId]: [...(st.pending[sessionId] ?? []), item] } }));
  },

  shiftPending: (sessionId) => {
    const q = get().pending[sessionId] ?? [];
    if (q.length === 0) return null;
    const [first, ...rest] = q;
    set((st) => ({ pending: { ...st.pending, [sessionId]: rest } }));
    return first;
  },

  clearPending: (sessionId) => {
    set((st) => ({ pending: { ...st.pending, [sessionId]: [] } }));
  },
}));

/** 页面卸载前尽力落盘（防抖窗口内的最后一次改动不丢） */
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    if (!persistTimer) return;
    clearTimeout(persistTimer);
    persistTimer = null;
    try {
      const { sessions, activeId } = useSessionStore.getState();
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ sessions, activeId, savedAt: Date.now() }));
    } catch { /* 忽略 */ }
  });
}

export function activeSession(): ChatSession | undefined {
  const { sessions, activeId } = useSessionStore.getState();
  return sessions.find((s) => s.id === activeId);
}
