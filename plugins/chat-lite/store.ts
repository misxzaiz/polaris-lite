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
import { loadWorkspacePrefs } from './workspace-prefs';
import {
  createSync, cacheGetAll, pullSession, pushSession, deleteSessionRemote,
  type SyncHandle, type SessionSnapshot, type SyncStatus, type ConflictInfo,
} from './sync';

const STORAGE_KEY = 'chat-lite.sessions.v1';
const PERSIST_DEBOUNCE_MS = 800;
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
  | { type: 'thinking'; text: string }
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

/** 会话的 store 形态：核心 ChatSession 的 role 不足以容纳工具卡，消息用 StoreMessage 放宽 */
export type ChatSessionShape = Omit<ChatSession, 'messages'> & {
  /** 会话绑定的文件工作区根 id（file-browser roots.id；缺省=跟随全局默认） */
  workspaceId?: string;
  /** 关联只读目录 root id：可被 files 工具读取，但 bash 不在此执行、不可写 */
  linkedWorkspaceIds?: string[];
  /** 最后活跃时间（任意消息/标题/绑定变更即刷新）；侧栏与相邻切换按此排序（新→旧）。
   *  缺省回退 createdAt（旧快照兼容）。随会话 JSON 一并上云，多端排序一致。 */
  lastActiveAt?: number;
};

/** 会话列表排序口径（唯一权威）：按最后活跃时间倒序（最新在前），缺省用 createdAt。
 *  sessions 数组的下标语义（相邻切换/滑切/侧栏展示）全部依赖本函数，勿在别处自行排序。 */
export function sortSessions<T extends { createdAt: number; lastActiveAt?: number }>(sessions: T[]): T[] {
  return [...sessions].sort((a, b) => (b.lastActiveAt ?? b.createdAt) - (a.lastActiveAt ?? a.createdAt));
}

/** 触摸会话：刷新 lastActiveAt 并标记脏（所有会话内容变更的唯一入口） */
function touch(s: ChatSessionShape & { messages: StoreMessage[] }): ChatSessionShape & { messages: StoreMessage[] } {
  return { ...s, lastActiveAt: Date.now() };
}

interface SessionState {
  sessions: (ChatSessionShape & { messages: StoreMessage[] })[];
  activeId: string | null;
  /** 待发队列：sessionId → 队列（内存态，不落盘） */
  pending: Record<string, PendingSend[]>;
  /** 服务端同步版本表（sessionId → version；0/缺省 = 服务端还没有） */
  versions: Record<string, number>;
  /** 待推送集合（本次防抖窗口内被改写过的会话；推送成功后移除） */
  dirty: Set<string>;
  /** 多设备同步状态（侧栏小状态点消费） */
  syncStatus: 'idle' | 'syncing' | 'offline' | 'conflict';
  /** 待用户决策的冲突（sessionId → 服务端版本；非空时输入区提示条） */
  conflicts: Record<string, { serverVersion: number }>;
  createSession: (title?: string) => string;
  setActive: (id: string) => void;
  renameSession: (id: string, title: string) => void;
  /** 设置/清除会话绑定的文件工作区根 id（undefined=跟随全局默认） */
  setSessionWorkspace: (id: string, workspaceId: string | undefined) => void;
  /** 设置会话的关联只读目录（最多 3 个；主目录自动排除） */
  setSessionLinkedWorkspaces: (id: string, linked: string[]) => void;
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
  updatePending: (sessionId: string, itemId: string, patch: Partial<PendingSend>) => void;
  removePending: (sessionId: string, itemId: string) => void;
  clearPending: (sessionId: string) => void;
}

/** ---- 服务端同步（多设备共享；spec docs/chat-multi-device-sync-plan.md） ----
 * 写模型：动作方法只改内存并标记 dirty → 防抖窗口到期整会话 PUT（带 baseVersion）；
 * 读模型：启动时 IndexedDB 缓存秒开 → 服务端索引对账（新会话/版本升高拉全文）；
 * localStorage 旧库（chat-lite.sessions.v1）只读一次做「检测到旧数据」提示，不再写入、不迁移。
 */
let syncTimer: ReturnType<typeof setTimeout> | null = null;

/** 服务端版本表 + 脏集合（非响应式；状态镜像在 store.versions/syncStatus） */
const versions: Record<string, number> = {};
const dirty = new Set<string>();
let syncHandle: SyncHandle | null = null;

function scheduleSync(): void {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    void flushDirty();
  }, PERSIST_DEBOUNCE_MS);
}

/** 防抖到期 / pagehide：把 dirty 会话推到服务端（sync.ts 编排） */
const flushDirty = (): Promise<void> => (syncHandle ? syncHandle.pushDirty() : Promise.resolve());

/** 供 sync.ts 回调：读当前会话/版本/脏集合 */
function syncState() {
  const st = useSessionStore.getState();
  return { sessions: st.sessions, versions, dirty, activeId: st.activeId };
}

/** 服务端快照合并进 store（服务端为权威；本地 streaming 消息复位；按 lastActiveAt 归位排序） */
function applyServerSnapshot(snap: SessionSnapshot): void {
  const incoming = snap.session;
  if (!incoming || typeof incoming.id !== 'string') return;
  const clean = touch({
    ...incoming,
    messages: (incoming.messages ?? []).map((m) => ({ ...m, streaming: false })),
  });
  versions[incoming.id] = snap.version;
  useSessionStore.setState(st => ({
    sessions: sortSessions(st.sessions.some(s => s.id === incoming.id)
      ? st.sessions.map(s => (s.id === incoming.id ? clean : s))
      : [clean, ...st.sessions]),
  }));
}

function applyTombstone(id: string): void {
  const st = useSessionStore.getState();
  if (!st.sessions.some(s => s.id === id)) return;
  delete versions[id];
  dirty.delete(id);
  useSessionStore.setState({
    sessions: st.sessions.filter(s => s.id !== id),
    activeId: st.activeId === id ? (st.sessions.find(s => s.id !== id)?.id ?? null) : st.activeId,
  });
}

function setSyncStatus(s: SyncStatus): void {
  if (useSessionStore.getState().syncStatus !== s) useSessionStore.setState({ syncStatus: s });
}

function onSyncConflict(info: ConflictInfo): void {
  const st = useSessionStore.getState();
  useSessionStore.setState({ conflicts: { ...st.conflicts, [info.sessionId]: { serverVersion: info.serverVersion } }, syncStatus: 'conflict' });
}

/** 初始化同步层（模块加载即执行；登录前 pull 会 401，登录后由轮询/事件补齐） */
function bootstrapSync(): void {
  if (typeof window === 'undefined') return;
  syncHandle = createSync({
    applyServerSnapshot,
    applyTombstone,
    setStatus: setSyncStatus,
    onConflict: onSyncConflict,
    getState: syncState,
    isStreaming: (id) => {
      const st = useSessionStore.getState();
      return st.sessions.find(s => s.id === id)?.messages.some(m => !isToolCard(m) && m.streaming) ?? false;
    },
  });
  syncHandle.start();
}

/** 初始态：空会话；真实数据由启动引导（IndexedDB 缓存 → 服务端对账）异步填充 */
const initial = { sessions: [] as (ChatSessionShape & { messages: StoreMessage[] })[], activeId: null as string | null };
export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: initial.sessions,
  activeId: initial.activeId,
  pending: {},
  versions: {},
  dirty: new Set<string>(),
  syncStatus: 'idle',
  conflicts: {},

  createSession: (title) => {
    const id = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    // 新会话默认绑定：用户显式设过「新对话默认使用」才继承，否则跟随全局（undefined）
    const defaultWs = loadWorkspacePrefs().defaultWorkspaceId;
    const session = touch({
      id, title: title ?? '新会话', messages: [], createdAt: Date.now(),
      ...(defaultWs ? { workspaceId: defaultWs } : {}),
    });
    set((st) => ({ sessions: sortSessions([session, ...st.sessions]), activeId: id }));
    versions[id] = versions[id] ?? 0;
    dirty.add(id);
    scheduleSync();
    return id;
  },

  setActive: (id) => {
    set({ activeId: id });
    scheduleSync();
  },

  renameSession: (id, title) => {
    set((st) => ({ sessions: sortSessions(st.sessions.map((s) => (s.id === id ? touch({ ...s, title }) : s))) }));
    dirty.add(id);
    scheduleSync();
  },

  setSessionWorkspace: (id, workspaceId) => {
    set((st) => ({
      sessions: sortSessions(st.sessions.map((s) => {
        if (s.id !== id) return s;
        // 主目录与关联目录互斥：新主目录从关联列表里剔除，避免同一目录两种语义
        const linked = (s.linkedWorkspaceIds ?? []).filter((x) => x !== workspaceId);
        return touch({
          ...s,
          workspaceId,
          ...(linked.length !== (s.linkedWorkspaceIds ?? []).length ? { linkedWorkspaceIds: linked } : {}),
        });
      })),
    }));
    dirty.add(id);
    scheduleSync();
  },

  setSessionLinkedWorkspaces: (id, linked) => {
    set((st) => ({
      sessions: sortSessions(st.sessions.map((s) => (s.id === id ? touch({ ...s, linkedWorkspaceIds: linked }) : s))),
    }));
    dirty.add(id);
    scheduleSync();
  },

  deleteSession: (id) => {
    set((st) => {
      const sessions = st.sessions.filter((s) => s.id !== id);
      const { [id]: _dropped, ...pending } = st.pending;
      const { [id]: _v, ...versionsRest } = st.versions;
      const { [id]: _c, ...conflictsRest } = st.conflicts;
      return {
        sessions,
        pending,
        versions: versionsRest,
        conflicts: conflictsRest,
        activeId: st.activeId === id ? (sessions[0]?.id ?? null) : st.activeId,
      };
    });
    delete versions[id];
    dirty.delete(id);
    if (syncHandle) void deleteSessionRemote(id).catch(() => undefined);
  },

  appendMessage: (sessionId, msg) => {
    set((st) => ({
      sessions: sortSessions(st.sessions.map((s) => (s.id === sessionId ? touch({ ...s, messages: [...s.messages, msg] }) : s))),
    }));
    dirty.add(sessionId);
    scheduleSync();
  },

  updateMessage: (sessionId, msgId, patch) => {
    set((st) => ({
      sessions: sortSessions(st.sessions.map((s) =>
        s.id === sessionId
          ? touch({ ...s, messages: s.messages.map((m) => (m.id === msgId ? ({ ...m, ...patch } as StoreMessage) : m)) })
          : s,
      )),
    }));
    dirty.add(sessionId);
    scheduleSync(); // 防抖：流式高频更新只会落一次（推送也只落一次）
  },

  appendAssistantBlock: (sessionId, msgId, block) => {
    set((st) => ({
      sessions: sortSessions(st.sessions.map((s) => {
        if (s.id !== sessionId) return s;
        return touch({
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
            // thinking 块同构合并（进末尾 thinking 块，无则新建）；不进 content 镜像——
            // content 只承载可见正文，思考文本不参与历史映射与 ai-events 统计
            if (block.type === 'thinking') {
              const last = blocks[blocks.length - 1];
              if (last && last.type === 'thinking') {
                return {
                  ...cur,
                  blocks: [...blocks.slice(0, -1), { type: 'thinking' as const, text: last.text + block.text }],
                };
              }
              return { ...cur, blocks: [...blocks, block] };
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
        });
      })),
    }));
    dirty.add(sessionId);
    scheduleSync();
  },

  patchAssistantToolBlock: (sessionId, msgId, callId, patch) => {
    set((st) => ({
      sessions: sortSessions(st.sessions.map((s) => {
        if (s.id !== sessionId) return s;
        return touch({
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
        });
      })),
    }));
    dirty.add(sessionId);
    scheduleSync();
  },

  patchAssistantInteractiveBlock: (sessionId, msgId, callId, patch) => {
    set((st) => ({
      sessions: sortSessions(st.sessions.map((s) => {
        if (s.id !== sessionId) return s;
        return touch({
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
        });
      })),
    }));
    dirty.add(sessionId);
    scheduleSync();
  },

  expirePendingApprovals: (sessionId) => {
    set((st) => ({
      sessions: sortSessions(st.sessions.map((s) => {
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
        return touched ? touch({ ...s, messages }) : s;
      })),
    }));
    dirty.add(sessionId); // 无 awaiting 时多标一次脏成本可忽略；换取不再复制 touched 判定
    scheduleSync();
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

  updatePending: (sessionId, itemId, patch) => {
    set((st) => ({
      pending: {
        ...st.pending,
        [sessionId]: (st.pending[sessionId] ?? []).map((it) => (it.id === itemId ? { ...it, ...patch } : it)),
      },
    }));
  },

  removePending: (sessionId, itemId) => {
    set((st) => ({
      pending: { ...st.pending, [sessionId]: (st.pending[sessionId] ?? []).filter((it) => it.id !== itemId) },
    }));
  },

  clearPending: (sessionId) => {
    set((st) => ({ pending: { ...st.pending, [sessionId]: [] } }));
  },
}));

/** 页面卸载前尽力推送脏会话（防抖窗口内的最后一次改动不丢；fire-and-forget，不阻塞卸载） */
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    if (syncTimer) {
      clearTimeout(syncTimer);
      syncTimer = null;
    }
    void flushDirty();
  });
}

/**
 * 冲突决策：用户选「覆盖服务端」后调用——以本地当前会话强制 PUT（force=true）。
 * 服务端版本被本地取代，冲突提示清除。
 */
export async function forceOverrideServer(sessionId: string): Promise<void> {
  const st = useSessionStore.getState();
  const session = st.sessions.find((s) => s.id === sessionId);
  if (!session || !syncHandle) return;
  setSyncStatus('syncing');
  const res = await pushSession(sessionId, session, versions[sessionId] ?? 0, true);
  if (res.ok) {
    versions[sessionId] = res.data.version;
    dirty.delete(sessionId);
    const { [sessionId]: _c, ...rest } = useSessionStore.getState().conflicts;
    useSessionStore.setState({ conflicts: rest, syncStatus: 'idle' });
  } else {
    setSyncStatus('offline');
  }
}

/** 冲突决策：用户选「以服务端为准」——丢弃本地未推送修改，重拉服务端全文 */
export async function acceptServerVersion(sessionId: string): Promise<void> {
  dirty.delete(sessionId);
  const snap = await pullSession(sessionId);
  if (snap.ok) {
    applyServerSnapshot(snap.data);
    const { [sessionId]: _c, ...rest } = useSessionStore.getState().conflicts;
    useSessionStore.setState({ conflicts: rest, syncStatus: 'idle' });
  } else {
    setSyncStatus('offline');
  }
}

/** 主动拉一次服务端对账（发送消息后等场景可调用；平时由 30s 轮询覆盖） */
export async function pullNow(): Promise<void> {
  if (syncHandle) await syncHandle.pullNow();
}

/**
 * 独立档开关（standalone-mode 插件经 mode-changed 驱动；spec docs/mobile-app-plan.md §10.4）：
 * on=true（宿主不可达）：暂停服务端同步，会话变更只写 IndexedDB 本地镜像——手机独立使用不丢；
 * on=false（恢复连接）：立即对账并补偿上传独立期间积攒的脏会话。
 */
export function setOfflineMode(on: boolean): void {
  syncHandle?.setOfflineMode(on);
}

/** 启动：IndexedDB 缓存秒开 → 服务端对账。旧 localStorage 只提示不迁移（R5）。 */
void (async () => {
  if (typeof window === 'undefined') return;
  // 旧库存在性提示（一次性；不读取内容、不迁移——多设备版以服务端为权威）
  let legacyHint = '';
  try {
    if (localStorage.getItem(STORAGE_KEY)) {
      legacyHint = '检测到本机旧版对话数据（localStorage）；多设备同步版以服务端为准，旧数据未迁移。';
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch { /* 隐私模式忽略 */ }
  const cached = await cacheGetAll();
  if (cached.length > 0) {
    const sessions = sortSessions(cached.map(e => ({
      ...e.session,
      messages: (e.session.messages ?? []).map(m => ({ ...m, streaming: false })),
    })));
    for (const e of cached) versions[e.session.id] = e.version;
    useSessionStore.setState(st => ({
      sessions,
      activeId: st.activeId ?? sessions[0]?.id ?? null,
    }));
  }
  bootstrapSync();
  if (legacyHint) console.info(`[chat-lite] ${legacyHint}`);
})();


export function activeSession(): (ChatSessionShape & { messages: StoreMessage[] }) | undefined {
  const { sessions, activeId } = useSessionStore.getState();
  return sessions.find((s) => s.id === activeId);
}
