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

/** 工具调用卡（参考 Polaris ToolCallBlock 的收敛版） */
export type ToolCardStatus = 'running' | 'done' | 'error' | 'denied' | 'awaiting' | 'resolved';

export interface ToolCardData {
  callId: string;
  name: string;
  command?: string;
  status: ToolCardStatus;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  durationMs?: number;
  truncated?: boolean;
  decision?: 'once' | 'always' | 'trust' | 'deny';
}

/** role:'tool' 的消息形态（旧数据兼容；新编排输出改为 assistant.blocks 内嵌块） */
export interface ToolCardMessage {
  id: string;
  role: 'tool';
  content: string;
  createdAt: number;
  streaming?: boolean;
  tool: ToolCardData;
}

/** assistant 消息的内容块（Polaris ContentBlock 收敛版）：按事件到达序追加，保序交错 */
export type AsstBlock =
  | { type: 'text'; text: string }
  | { type: 'tool'; card: ToolCardData }
  | { type: 'interactive'; card: InteractiveCardData }
  | { type: 'artifact'; card: ArtifactCardData };

/** 交互卡数据（AI 发起 question/form/confirm，用户作答后回填） */
export interface InteractiveCardData {
  callId: string;
  kind: 'question' | 'form' | 'confirm';
  title: string;
  payload: Record<string, unknown>;
  answer?: Record<string, unknown>;
  status: 'awaiting' | 'answered';
}

/**
 * 通用产物块（第二个可视化插件起不再动 chat-lite）：渲染器由产物插件经
 * __PLITE_ARTIFACT_RENDERERS__ 登记（rendererType → 组件），BlockGroup 查表渲染；
 * data 是渲染器私有载荷（html-preview 存 previewId/url 等）。一次性落块，无回填流。
 */
export interface ArtifactCardData {
  callId: string;
  rendererType: string;
  title: string;
  status: 'ready' | 'error';
  data: Record<string, unknown>;
}

export interface AssistantBlocks {
  blocks: AsstBlock[];
}

/**
 * 带 blocks 的 assistant 消息：核心 ChatMessage 的 chat-lite 私有扩展。
 * 不能写成 `ChatMessage & AssistantBlocks` 去做类型守卫——Core 的 role 联合不含 'tool'，
 * 与 ToolCardMessage 交叉会把 role 推断成 never，导致 m.tool 等属性全部不可达。
 */
export type AssistantBlockMessage = ChatMessage & AssistantBlocks;

/** 会话消息统一形态（协议消息[可携 blocks] + 旧版独立工具卡） */
export type StoreMessage = ChatMessage | ToolCardMessage | AssistantBlockMessage;

export function isToolCard(m: StoreMessage): m is ToolCardMessage {
  return (m as ToolCardMessage).role === 'tool' && !!(m as ToolCardMessage).tool;
}

export function hasBlocks(m: StoreMessage): m is AssistantBlockMessage {
  return Array.isArray((m as AssistantBlockMessage).blocks) && (m as AssistantBlockMessage).blocks!.length > 0;
}

/** 卡片数据体积上限（localStorage 1.5MB 全库额度；服务端输出 64KB 全量不留存） */
const CARD_STORE_CAP = 16 * 1024;

function trimCard(card: ToolCardData): ToolCardData {
  const cut = (s?: string) => (s && s.length > CARD_STORE_CAP ? `${s.slice(0, CARD_STORE_CAP)}\n…[已截断]` : s);
  return { ...card, stdout: cut(card.stdout), stderr: cut(card.stderr) };
}

interface PersistShape {
  sessions: (ChatSessionShape & { messages: StoreMessage[] })[];
  activeId: string | null;
  savedAt: number;
}

/** 会话的 store 形态：核心 ChatSession 的 role 不足以容纳工具卡，消息用 StoreMessage 放宽 */
type ChatSessionShape = Omit<ChatSession, 'messages'> & {
  /** 会话绑定的文件工作区根 id（file-browser roots.id；缺省=跟随全局默认） */
  workspaceId?: string;
};

interface SessionState {
  sessions: (ChatSessionShape & { messages: StoreMessage[] })[];
  activeId: string | null;
  /** 待发队列：sessionId → 队列（内存态，不落盘） */
  pending: Record<string, PendingSend[]>;
  createSession: (title?: string) => string;
  setActive: (id: string) => void;
  renameSession: (id: string, title: string) => void;
  /** 设置/清除会话绑定的文件工作区根 id（undefined=跟随全局默认） */
  setSessionWorkspace: (id: string, workspaceId: string | undefined) => void;
  deleteSession: (id: string) => void;
  appendMessage: (sessionId: string, msg: StoreMessage) => void;
  updateMessage: (sessionId: string, msgId: string, patch: Partial<StoreMessage>) => void;
  /** assistant 块追加：delta 进末尾 text 块（无则新建）；tool 块直接追加。content 镜像同步。 */
  appendAssistantBlock: (sessionId: string, msgId: string, block: AsstBlock) => void;
  /** 按 callId 更新 assistant 消息内的工具块 */
  patchAssistantToolBlock: (sessionId: string, msgId: string, callId: string, patch: Partial<ToolCardData>) => void;
  /** 按 callId 更新 assistant 消息内的交互卡块（interactive.answered 事件回填答案） */
  patchAssistantInteractiveBlock: (sessionId: string, msgId: string, callId: string, patch: Partial<InteractiveCardData>) => void;
  /** 新消息即过期：本会话所有 awaiting 工具块/旧版审批卡置为拒绝 */
  expirePendingApprovals: (sessionId: string) => void;
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

function hydrate(): { sessions: (ChatSessionShape & { messages: StoreMessage[] })[]; activeId: string | null } {
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

  setSessionWorkspace: (id, workspaceId) => {
    set((st) => ({
      sessions: st.sessions.map((s) => (s.id === id ? { ...s, workspaceId } : s)),
    }));
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
          ? { ...s, messages: s.messages.map((m) => (m.id === msgId ? ({ ...m, ...patch } as StoreMessage) : m)) }
          : s,
      ),
    }));
    schedulePersist(get); // 防抖：流式高频更新只会落一次
  },

  appendAssistantBlock: (sessionId, msgId, block) => {
    set((st) => ({
      sessions: st.sessions.map((s) => (s.id !== sessionId ? s : {
        ...s,
        messages: s.messages.map((m) => {
          if (m.id !== msgId) return m;
          const cur = m as AssistantBlockMessage;
          const blocks = cur.blocks ?? [];
          // delta 语义：text 块追加进末尾 text 块（无则新建）——工具块之后的 delta
          // 自然开新 text 块，交错时序天然保序
          if (block.type === 'text') {
            const last = blocks[blocks.length - 1];
            if (last && last.type === 'text') {
              return {
                ...cur,
                blocks: [...blocks.slice(0, -1), { type: 'text' as const, text: last.text + block.text }],
                content: (cur.content ?? '') + block.text, // content 镜像（历史映射/兼容消费）
              };
            }
            return { ...cur, blocks: [...blocks, block], content: (cur.content ?? '') + block.text };
          }
          // 非 text 块按自身类型入列：tool 卡做体积裁剪，interactive/artifact 卡原样保留
          const next: AsstBlock =
            block.type === 'tool'
              ? { type: 'tool', card: trimCard(block.card) }
              : block.type === 'interactive'
                ? { type: 'interactive', card: block.card }
                : { type: 'artifact', card: block.card };
          return { ...cur, blocks: [...blocks, next] };
        }),
      })),
    }));
    schedulePersist(get);
  },

  patchAssistantToolBlock: (sessionId, msgId, callId, patch) => {
    set((st) => ({
      sessions: st.sessions.map((s) => (s.id !== sessionId ? s : {
        ...s,
        messages: s.messages.map((m) => {
          if (m.id !== msgId) return m;
          const cur = m as AssistantBlockMessage;
          if (!cur.blocks) return m;
          return {
            ...cur,
            blocks: cur.blocks.map((b) =>
              b.type === 'tool' && b.card.callId === callId ? { type: 'tool' as const, card: { ...b.card, ...patch } } : b,
            ),
          };
        }),
      })),
    }));
    schedulePersist(get);
  },

  patchAssistantInteractiveBlock: (sessionId, msgId, callId, patch) => {
    set((st) => ({
      sessions: st.sessions.map((s) => (s.id !== sessionId ? s : {
        ...s,
        messages: s.messages.map((m) => {
          if (m.id !== msgId) return m;
          const cur = m as AssistantBlockMessage;
          if (!cur.blocks) return m;
          return {
            ...cur,
            blocks: cur.blocks.map((b) =>
              b.type === 'interactive' && b.card.callId === callId
                ? { type: 'interactive' as const, card: { ...b.card, ...patch } }
                : b,
            ),
          };
        }),
      })),
    }));
    schedulePersist(get);
  },

  expirePendingApprovals: (sessionId) => {
    set((st) => ({
      sessions: st.sessions.map((s) => {
        if (s.id !== sessionId) return s;
        let touched = false;
        const messages = s.messages.map((m) => {
          // 新版：assistant.blocks 内的 awaiting 工具块
          if (hasBlocks(m)) {
            let changed = false;
            const blocks = m.blocks.map((b) => {
              if (b.type === 'tool' && b.card.status === 'awaiting') {
                touched = true; changed = true;
                return { type: 'tool' as const, card: { ...b.card, status: 'denied' as const, decision: 'deny' as const } };
              }
              return b;
            });
            return changed ? { ...m, blocks } : m;
          }
          // 旧版：独立 tool 卡消息
          if (isToolCard(m) && m.tool.status === 'awaiting') {
            touched = true;
            return { ...m, tool: { ...m.tool, status: 'denied', decision: 'deny' } } as StoreMessage;
          }
          return m;
        });
        return touched ? { ...s, messages } : s;
      }),
    }));
    schedulePersist(get);
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

export function activeSession(): (ChatSessionShape & { messages: StoreMessage[] }) | undefined {
  const { sessions, activeId } = useSessionStore.getState();
  return sessions.find((s) => s.id === activeId);
}
