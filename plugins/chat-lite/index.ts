/**
 * chat-lite 插件：AI 对话 UI（Polaris 四段式对话布局的插件化实现）。
 * 填充 sidebar（会话侧栏）/ stream（消息流）/ input（输入区）三槽；
 * panel 槽留给其它面板插件。会话状态由本插件私有 store 持有（核心零业务），
 * AI 回复经 cap.ai.chat 流式总线驱动。
 *
 * 关键约束（踩过的坑，改动时别退回去）：
 * - 事件按 messageId 精确过滤，否则同会话并发流会串台；
 * - settle 幂等：done / error / 看门狗 / 中断 都可能触发收敛，只允许复位一次；
 * - 任何收敛路径都必须补发 settle，否则输入框永远停在「停止」态；
 * - delta 按帧合并写 store：逐 token 写会让整棵消息树每个 token 重渲染。
 */
import type { LitePlugin, SlotHostApi, ChatMessage } from '@sdk';
import { useSessionStore, isToolCard, hasBlocks, type StoreMessage, type ToolCardData, type ToolCardMessage } from './store';
import type { Attachment } from './attachments';
import { SessionSidebar } from './SessionSidebar';
import { MessageStream } from './MessageStream';
import { ChatInput } from './ChatInput';
// 插件自带样式：会话侧栏 / 消息流 / 空态 / Markdown / 工具卡（原先散落在宿主 src/styles.css）
import './chat.css';

/** 与 mock-auth 的会话镜像键保持一致（跨插件约定） */
const MOCK_AUTH_SESSION_KEY = 'mock-auth.session.v1';

/** 看门狗：流式期间超过该时长没有任何增量，强制收敛（防按钮永久卡在「停止」） */
const STREAM_IDLE_TIMEOUT_MS = 30_000;
/** 工具阶段（执行/审批挂起）看门狗：审批上限 120s + 执行余量 */
const TOOL_PHASE_TIMEOUT_MS = 180_000;

/** 空态快捷建议 → 输入框的填写通道（避免为一句「填入草稿」在组件间拉一条状态） */
type ComposeListener = (text: string) => void;
const composeListeners = new Set<ComposeListener>();

/** 订阅「填入输入框」；返回取消订阅（ChatInput 挂载时注册） */
export function onCompose(fn: ComposeListener): () => void {
  composeListeners.add(fn);
  return () => {
    composeListeners.delete(fn);
  };
}

/** 把一段文本填入输入框（不发送），供空态建议复用 */
export function requestCompose(text: string): void {
  if (!hostApi) {
    // 插件尚未装配（理论上不会发生：空态本身由本插件渲染）——退化为直接发送
    void sendUserMessage(text);
    return;
  }
  if (composeListeners.size === 0) {
    void sendUserMessage(text);
    return;
  }
  composeListeners.forEach((fn) => fn(text));
}

let hostApi: SlotHostApi | null = null;
let msgCounter = 0;

function nextMsgId(): string {
  msgCounter += 1;
  return `m-${Date.now().toString(36)}-${msgCounter.toString(36)}`;
}

export function getChatHost(): SlotHostApi | null {
  return hostApi;
}

export const chatLitePlugin: LitePlugin = {
  manifest: {
    id: 'chat-lite',
    name: '对话',
    version: '0.3.0',
    capabilities: ['cap.ai.chat', 'cap.ai.chat.interrupt', 'cap.agent.loop', 'cap.meta'],
    /** 依赖 AI 引擎提供的流式能力：宿主据此让引擎先于对话 UI 装配 */
    requires: ['cap.ai.chat'],
    // user.prompt：发送时对外广播用户输入原文，供 ai-events 等旁听插件按 messageId 归到同一轮
    events: ['cap.ai.chat:event', 'cap.agent.loop:event', 'user.prompt'],
    contributes: {
      slots: [
        { slot: 'sidebar', component: 'SessionSidebar', order: 1 },
        { slot: 'stream', component: 'MessageStream', order: 1 },
        { slot: 'input', component: 'ChatInput', order: 1 },
      ],
    },
  },
  setup(api) {
    hostApi = api;
    // 跨插件输入注入通道（file-browser「发到对话」等使用；经本函数保证走合法发送路径）
    (window as unknown as Record<string, unknown>).__FILE_BROWSER_COMPOSE__ = (text: string) => requestCompose(text);
  },
};

/** agent-loop 可用性缓存（每次发送时经 cap.meta 刷新，避免装配顺序竞态） */
let loopAvailable: boolean | null = null;

async function detectLoop(): Promise<boolean> {
  if (!hostApi) return false;
  if (loopAvailable !== null) return loopAvailable;
  try {
    const res = await hostApi.dispatch<{ capabilities?: string[] }>({ target: 'cap.meta', action: 'list' });
    loopAvailable = (res.data?.capabilities ?? []).includes('cap.agent.loop');
  } catch {
    loopAvailable = false;
  }
  return loopAvailable;
}

interface StreamEnvelope {
  kind: string;
  payload?: {
    sessionId?: string;
    messageId?: string;
    delta?: string;
    message?: string;
    interrupted?: boolean;
    finishReason?: string;
    // 工具卡事件（cap.agent.loop:event；source='agent-loop' 宿主注入不可伪造）
    callId?: string;
    name?: string;
    command?: string;
    argsJson?: string;
    status?: 'done' | 'error' | 'denied';
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    durationMs?: number;
    truncated?: boolean;
    decision?: 'once' | 'always' | 'deny';
    turns?: number;
  };
  source?: string;
}

/** 工具块事件处理（仅 loop 模式；块内嵌于 assistant 消息，按 callId 幂等建块/更新） */
function handleToolEvent(
  kind: string,
  inner: NonNullable<StreamEnvelope['payload']>,
  sid: string,
  assistantId: string,
  armLongWatchdog: () => void,
): void {
  const st = useSessionStore.getState();
  // 工具阶段（执行/审批）无 delta 流，看门狗须用长时限，否则 30s 就误杀在途编排
  armLongWatchdog();
  const patchCard = (callId: string, patch: (card: ToolCardData) => ToolCardData): void => {
    // 新版：块内嵌于 assistant 消息；旧版（历史会话）：独立 tool 卡消息
    const msg = st.sessions.find((s) => s.id === sid)?.messages.find((m) => m.id === assistantId);
    if (msg && hasBlocks(msg)) {
      const blk = msg.blocks.find((b) => b.type === 'tool' && b.card.callId === callId);
      st.patchAssistantToolBlock(sid, assistantId, callId, patch(blk && blk.type === 'tool' ? blk.card : ({} as ToolCardData)));
      return;
    }
    const legacy = st.sessions.find((s) => s.id === sid)?.messages.find((m) => m.id === `card-${callId}`) as ToolCardMessage | undefined;
    if (legacy) {
      st.updateMessage(sid, legacy.id, { tool: patch(legacy.tool) } as Partial<StoreMessage>);
    }
  };

  if (kind === 'tool.card' || kind === 'tool.approval.required') {
    const callId = inner.callId ?? '';
    const msg = st.sessions.find((s) => s.id === sid)?.messages.find((m) => m.id === assistantId);
    const exists = msg && hasBlocks(msg) && msg.blocks.some((b) => b.type === 'tool' && b.card.callId === callId);
    if (!exists) {
      // 新块（tool.card 先到即建 running 卡）
      st.appendAssistantBlock(sid, assistantId, {
        type: 'tool',
        card: {
          callId,
          name: inner.name ?? 'tool',
          command: inner.command ?? inner.argsJson,
          status: kind === 'tool.card' ? 'running' : 'awaiting',
        },
      });
      return;
    }
    if (kind === 'tool.approval.required') {
      patchCard(callId, (c) => ({ ...c, status: 'awaiting' }));
    }
    return;
  }
  if (kind === 'tool.approval.resolved') {
    patchCard(inner.callId ?? '', (c) => ({
      ...c,
      status: inner.decision === 'deny' ? 'denied' : 'resolved',
      decision: inner.decision,
    }));
    return;
  }
  if (kind === 'tool.result') {
    patchCard(inner.callId ?? '', (c) => ({
      ...c,
      status: inner.status ?? 'error',
      stdout: inner.stdout,
      stderr: inner.stderr,
      exitCode: inner.exitCode,
      durationMs: inner.durationMs,
      truncated: inner.truncated,
    }));
    return;
  }
}

/** 由 ChatInput / 快捷建议 / 队列泵调用：发送用户消息并触发流式回复 */
export async function sendUserMessage(text: string, attachments?: Attachment[]): Promise<void> {
  const api = hostApi;
  const hasAttachments = !!attachments && attachments.length > 0;
  if (!api || (!text.trim() && !hasAttachments)) return;
  const store = useSessionStore.getState();
  let sessionId = store.activeId;
  if (!sessionId) sessionId = store.createSession();
  const sid: string = sessionId;

  // 上下文 = 本次提问之前的全部消息（排除工具卡；blocks 模式的 assistant 文本取块拼接）。
  // 协议上下文由 agent-loop 的 shadow transcript 自持，此处只喂可见文本。
  const history = store.sessions
    .find((s) => s.id === sid)
    ?.messages.filter((m) => !m.streaming && !isToolCard(m) && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({
      role: m.role,
      content: hasBlocks(m)
        ? m.blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n') || m.content
        : m.content,
    }));

  // 新消息即过期：本会话挂着的审批（块内/旧版独立卡）直接置为拒绝（Polaris 语义；loop 侧 120s 超时兜底）
  store.expirePendingApprovals(sid);

  store.appendMessage(sid, {
    id: nextMsgId(),
    role: 'user',
    content: text,
    createdAt: Date.now(),
  } satisfies ChatMessage);

  const assistantId = nextMsgId();

  // 对外广播用户输入原文（ai-events 旁听：按 messageId=assistantId 归到同一轮次）。
  // 取证是旁路职责：这里绝不因为 emit 失败而影响发送；附件只报名字，不带 base64 原文。
  try {
    api.emit('user.prompt', {
      sessionId: sid,
      messageId: assistantId,
      text,
      at: Date.now(),
      ...(hasAttachments ? { attachments: attachments!.map((a) => a.name) } : {}),
    });
  } catch {
    /* 无监听者或取证插件未启用：静默跳过 */
  }

  store.appendMessage(sid, {
    id: assistantId,
    role: 'assistant',
    content: '',
    blocks: [], // blocks 模式：文本/工具块按事件序追加（content 为其镜像，供历史映射与兼容消费）
    createdAt: Date.now(),
    streaming: true,
  } as unknown as ChatMessage);

  // loop 模式探测：cap.agent.loop 存在（已启用）则走编排通道，否则回落纯引擎
  const useLoop = await detectLoop();

  // ---- delta 按帧合并（写入 assistant 末尾 text 块；content 镜像由 store 同步） ----
  let buf = '';
  let frame = 0;
  const flushDelta = (): void => {
    if (frame) {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
      frame = 0;
    }
    if (!buf) return;
    const chunk = buf;
    buf = '';
    useSessionStore.getState().appendAssistantBlock(sid, assistantId, { type: 'text', text: chunk });
  };
  const pushDelta = (delta: string): void => {
    buf += delta;
    if (frame) return;
    frame = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(flushDelta)
      : (setTimeout(flushDelta, 16) as unknown as number);
  };

  // ---- 幂等收敛 + 看门狗 ----
  let settled = false;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let unbind: (() => void) | undefined;

  const settle = (): void => {
    if (settled) return;
    settled = true;
    if (watchdog) {
      clearTimeout(watchdog);
      watchdog = null;
    }
    flushDelta();
    useSessionStore.getState().updateMessage(sid, assistantId, { streaming: false });
    unbind?.();
    sendNextPending(); // 流结束：自动派发队列下一条（若有）
  };

  const armWatchdog = (): void => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      if (settled) return;
      useSessionStore.getState().appendAssistantBlock(sid, assistantId, {
        type: 'text',
        text: `响应超时（${STREAM_IDLE_TIMEOUT_MS / 1000}s 无新内容），已结束本次流式`,
      });
      settle();
    }, STREAM_IDLE_TIMEOUT_MS);
  };

  /** 工具阶段（执行/审批挂起）用长看门狗：无 delta 流是常态，30s 会误杀在途编排 */
  const armLongWatchdog = (): void => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      if (settled) return;
      useSessionStore.getState().appendAssistantBlock(sid, assistantId, {
        type: 'text',
        text: `响应超时（${TOOL_PHASE_TIMEOUT_MS / 1000}s 无新内容），已结束本次编排`,
      });
      settle();
    }, TOOL_PHASE_TIMEOUT_MS);
  };

  const handleEnvelope = (payload: unknown): void => {
    const envelope = payload as StreamEnvelope;
    // 来源由宿主取「该 cap 的提供方插件 id」后注入，插件无法伪造；
    // 无来源的事件一律不认（避免核心内部广播被误当流式事件处理）。
    if (!envelope.source) return;
    const inner = envelope.payload ?? {};
    // 精确匹配：会话 + 消息 双重过滤（并发流不串台；loop 的内部轮次 messageId 不同不会误入）
    if (inner.sessionId && inner.sessionId !== sid) return;
    if (inner.messageId && inner.messageId !== assistantId) return;

    // 工具块事件（loop 模式专属）
    if (envelope.kind.startsWith('tool.')) {
      handleToolEvent(envelope.kind, inner, sid, assistantId, armLongWatchdog);
      return;
    }

    if (envelope.kind === 'message.delta' && inner.delta) {
      armWatchdog();
      pushDelta(inner.delta);
    } else if (envelope.kind === 'message.done') {
      settle();
    } else if (envelope.kind === 'stream.error') {
      flushDelta();
      const detail = (inner as { message?: string }).message ?? '';
      // 会话过期（服务端 401）：清本地镜像并回到登录视图（自动跳登录，无需手动登出）
      if (detail.includes('登录已过期') || detail.includes('SESSION_REQUIRED')) {
        sessionStorage.removeItem(MOCK_AUTH_SESSION_KEY);
        window.location.reload();
        return;
      }
      // 错误信息作为独立 text 块追加（blocks 模式渲染以块为准）
      useSessionStore.getState().appendAssistantBlock(sid, assistantId, {
        type: 'text',
        text: `${detail || '流式请求失败'}`,
      });
      settle();
    }
  };

  // 双通道订阅：普通模式收 cap.ai.chat:event（引擎直达）；
  // loop 模式收 cap.agent.loop:event（loop 转发）。loop 的内部轮次 messageId 不同，不会串台。
  const off = api.listen('cap.ai.chat:event', handleEnvelope);
  const offLoop = useLoop ? api.listen('cap.agent.loop:event', handleEnvelope) : null;
  unbind = () => {
    off();
    offLoop?.();
  };
  armWatchdog(); // 首个 delta 之前就无响应（上游挂住）也能收敛

  await api.dispatch({
    target: useLoop ? 'cap.agent.loop' : 'cap.ai.chat',
    action: 'start',
    payload: {
      sessionId: sid,
      messageId: assistantId,
      prompt: text,
      history,
      // 会话绑定的文件工作区（agent-loop 据此设置 bash cwd 与 system prompt；缺省=默认 workspace）
      ...(store.sessions.find((s) => s.id === sid)?.workspaceId
        ? { workspaceId: store.sessions.find((s) => s.id === sid)!.workspaceId }
        : {}),
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    },
  });
}

/** 中断当前会话在途流；loop 存在时中断整个编排（引擎流+工具+审批），否则直接打断引擎 */
export function interruptChat(): void {
  const api = hostApi;
  const sessionId = useSessionStore.getState().activeId;
  if (!api || !sessionId) return;
  // 在途 assistant 消息 id：loop 用它立即回执 message.done{interrupted}（UI 即刻收敛）
  const streamingMsg = useSessionStore
    .getState()
    .sessions.find((s) => s.id === sessionId)
    ?.messages.find((m) => !isToolCard(m) && m.streaming);
  const messageId = streamingMsg?.id;

  const doInterrupt = async (): Promise<{ ok: boolean; data?: { found?: boolean } }> => {
    if (await detectLoop()) {
      const res = await api.dispatch<{ found?: boolean }>({
        target: 'cap.agent.loop',
        action: 'interrupt',
        payload: { sessionId, ...(messageId ? { messageId } : {}) },
      });
      // loop 没有在途轮次（found=false）时回落打断引擎直通流
      if (res.ok && res.data?.found !== false) return res;
    }
    return api.dispatch<{ found?: boolean }>({
      target: 'cap.ai.chat.interrupt',
      action: 'interrupt',
      payload: { sessionId },
    });
  };

  void doInterrupt()
    .then((res) => {
      // 自愈：引擎已无此流（found=false 或调用失败）时复位残留 streaming 标志，
      // 避免输入框被残留状态永久锁死；复位后同样要让队列继续流动。
      if (!res.ok || res.data?.found === false) {
        const cur = useSessionStore.getState();
        cur.sessions
          .find((s) => s.id === sessionId)
          ?.messages.filter((m) => !isToolCard(m) && m.streaming)
          .forEach((m) => cur.updateMessage(sessionId, m.id, { streaming: false }));
        sendNextPending();
      }
    })
    .catch(() => undefined);
}

/** 审批决策回填（ToolCard 按钮调用；仅 loop 模式会出现审批卡） */
export function resolveApproval(callId: string, decision: 'once' | 'always' | 'trust' | 'deny'): void {
  const api = hostApi;
  const sessionId = useSessionStore.getState().activeId;
  if (!api || !sessionId || !callId) return;
  void api
    .dispatch({ target: 'cap.agent.loop', action: 'resolveApproval', payload: { sessionId, callId, decision } })
    .catch(() => undefined);
}

// ===== 待发送队列（流式预输入）：流结束后自动逐条发送，附件随队列项完整保留 =====

/** 入队一条待发消息（流式中的 Enter / 「排队」按钮） */
export function enqueuePending(text: string, attachments: Attachment[] = []): void {
  const st = useSessionStore.getState();
  const sid = st.activeId;
  if (!sid || (!text.trim() && attachments.length === 0)) return;
  st.enqueue(sid, {
    id: `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    text: text.trim(),
    attachments,
    createdAt: Date.now(),
  });
}

/** 派发队首一条（含附件）；返回是否真的派发了。队列串行：下一条由 settle 再触发。 */
export function sendNextPending(): boolean {
  const st = useSessionStore.getState();
  const sid = st.activeId;
  if (!sid) return false;
  const next = st.shiftPending(sid);
  if (!next) return false;
  void sendUserMessage(next.text, next.attachments);
  return true;
}

/** 「全部发送」：第一条立即发，其余在其 settle 后接着发（保持串行，不并发抢占） */
export function flushPendingAll(): void {
  sendNextPending();
}

/** 清空当前会话待发队列 */
export function clearPending(): void {
  const st = useSessionStore.getState();
  if (st.activeId) st.clearPending(st.activeId);
}

export const chatComponents = { SessionSidebar, MessageStream, ChatInput };

export default chatLitePlugin;
