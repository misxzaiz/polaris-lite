/**
 * 会话状态 store：轻量版只有一个权威 store（对齐 Polaris「日志即真相、前端只是缓存」
 * 的单写者思想——本版由引擎事件驱动更新，UI 只读）。
 */
import { create } from 'zustand';
import type { ChatMessage, ChatSession } from '@/core/types';

interface SessionState {
  sessions: ChatSession[];
  activeId: string | null;
  createSession: (title?: string) => string;
  setActive: (id: string) => void;
  appendMessage: (sessionId: string, msg: ChatMessage) => void;
  updateMessage: (sessionId: string, msgId: string, patch: Partial<ChatMessage>) => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  sessions: [],
  activeId: null,
  createSession: (title) => {
    const id = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const session: ChatSession = {
      id,
      title: title ?? '新会话',
      messages: [],
      createdAt: Date.now(),
    };
    set((st) => ({ sessions: [session, ...st.sessions], activeId: id }));
    return id;
  },
  setActive: (id) => set({ activeId: id }),
  appendMessage: (sessionId, msg) =>
    set((st) => ({
      sessions: st.sessions.map((s) =>
        s.id === sessionId ? { ...s, messages: [...s.messages, msg] } : s,
      ),
    })),
  updateMessage: (sessionId, msgId, patch) =>
    set((st) => ({
      sessions: st.sessions.map((s) =>
        s.id === sessionId
          ? {
              ...s,
              messages: s.messages.map((m) => (m.id === msgId ? { ...m, ...patch } : m)),
            }
          : s,
      ),
    })),
}));

export function activeSession(): ChatSession | undefined {
  const { sessions, activeId } = useSessionStore.getState();
  return sessions.find((s) => s.id === activeId);
}
