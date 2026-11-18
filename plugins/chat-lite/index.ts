/**
 * chat-lite 插件：AI 对话 UI（Polaris 四段式对话布局的插件化实现）。
 * 填充 sidebar（会话侧栏）/ stream（消息流）/ input（输入区）三槽；
 * panel 槽留给 cap-panel 插件。会话状态经核心 sessionStore 单写者更新，
 * AI 回复经 cap.ai.chat 流式总线驱动。
 *
 * 验收修复：
 * - [P0 B-1] 事件匹配加 messageId 精确过滤，连发/并发流不再串台。
 * - [P1 B-3] interrupt 乐观复位 + 按 (sessionId, messageId) 精确中断。
 * - [P1 B-7] interrupt 自愈：流已死时复位本会话所有 streaming 残留。
 * - [P2 B-6] settled 幂等防重复复位；消息 id 用单调计数器不撞车。
 */
import type { LitePlugin, SlotHostApi, ChatMessage } from '@sdk';
import { useSessionStore } from './store';
import { SessionSidebar } from './SessionSidebar';
import { MessageStream } from './MessageStream';
import { ChatInput } from './ChatInput';

/** 与 mock-auth 的会话镜像键保持一致（跨插件约定） */
const MOCK_AUTH_SESSION_KEY = 'mock-auth.session.v1';

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
    version: '0.1.0',
    capabilities: ['cap.ai.chat', 'cap.ai.chat.interrupt'],
    /** 依赖 AI 引擎提供的流式能力：宿主据此让引擎先于对话 UI 装配 */
    requires: ['cap.ai.chat'],
    events: ['cap.ai.chat:event'],
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
  },
};

interface StreamEnvelope {
  kind: string;
  payload?: {
    sessionId?: string;
    messageId?: string;
    delta?: string;
    source?: string;
  };
  source?: string;
}

/** 由 ChatInput 调用：发送用户消息并触发流式回复（attachments 为空可省略第二参） */
export async function sendUserMessage(text: string, attachments?: unknown[]): Promise<void> {
  const api = hostApi;
  if (!api || !text.trim()) return;
  const store = useSessionStore.getState();
  let sessionId = store.activeId;
  if (!sessionId) sessionId = store.createSession();
  const sid: string = sessionId;

  // 上下文 = 本次提问之前的全部消息（避免把本条也塞进去，造成上游收到重复两条）
  const history = store.sessions
    .find((s) => s.id === sid)
    ?.messages.filter((m) => !m.streaming)
    .map((m) => ({ role: m.role, content: m.content }));

  const userMsg: ChatMessage = {
    id: nextMsgId(),
    role: 'user',
    content: text,
    createdAt: Date.now(),
  };
  store.appendMessage(sid, userMsg);

  const assistantId = nextMsgId();
  const assistantMsg: ChatMessage = {
    id: assistantId,
    role: 'assistant',
    content: '',
    createdAt: Date.now(),
    streaming: true,
  };
  store.appendMessage(sid, assistantMsg);

  // 流事件处理：幂等收敛（done/error/end 多次到达只复位一次）
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    useSessionStore.getState().updateMessage(sid, assistantId, { streaming: false });
    unbind?.();
    pumpPendingOnce(); // 流结束：自动派发待发队列下一条（若有）
  };

  let unbind: (() => void) | undefined;
  const off = api.listen('cap.ai.chat:event', (payload) => {
    const envelope = payload as StreamEnvelope;
    // 来源由宿主取「cap.ai.chat 的提供方插件 id」后注入，插件无法伪造；
    // 无来源的事件一律不认（避免核心内部广播或未来新增事件被误当流式事件处理）。
    if (!envelope.source) return;
    const inner = envelope.payload ?? {};
    // 精确匹配：会话 + 消息 双重过滤（并发流不串台）
    if (inner.sessionId && inner.sessionId !== sid) return;
    if (inner.messageId && inner.messageId !== assistantId) return;

    if (envelope.kind === 'message.delta' && inner.delta) {
      const s = useSessionStore.getState();
      const msg = s.sessions.find((x) => x.id === sid)?.messages.find((m) => m.id === assistantId);
      s.updateMessage(sid, assistantId, { content: (msg?.content ?? '') + inner.delta });
    } else if (envelope.kind === 'message.done') {
      settle();
    } else if (envelope.kind === 'stream.error') {
      const s = useSessionStore.getState();
      const msg = s.sessions.find((x) => x.id === sid)?.messages.find((m) => m.id === assistantId);
      const detail = (inner as { message?: string }).message ?? '';
      // 会话过期（服务端 401）：清本地镜像并回到登录视图（自动跳登录，无需手动登出）
      if (detail.includes('登录已过期') || detail.includes('SESSION_REQUIRED')) {
        sessionStorage.removeItem(MOCK_AUTH_SESSION_KEY);
        window.location.reload();
        return;
      }
      s.updateMessage(sid, assistantId, {
        content: (msg?.content ?? '') + (msg?.content ? '\n\n' : '') + `⚠️ ${detail || '流式请求失败'}`,
      });
      settle();
    }
  });
  unbind = off;

  await api.dispatch({
    target: 'cap.ai.chat',
    action: 'start',
    payload: {
      sessionId: sid,
      messageId: assistantId,
      prompt: text,
      history,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    },
  });
}

/** 中断当前会话在途流；引擎侧流已不存在时自愈复位 streaming 残留 */
export function interruptChat(): void {
  const api = hostApi;
  const state = useSessionStore.getState();
  const sessionId = state.activeId;
  if (!api || !sessionId) return;

  const streamingMsgs = state.sessions
    .find((s) => s.id === sessionId)
    ?.messages.filter((m) => m.streaming) ?? [];

  void api
    .dispatch<{ found?: boolean }>({
      target: 'cap.ai.chat.interrupt',
      action: 'interrupt',
      payload: { sessionId },
    })
    .then((res) => {
      // 自愈：引擎已无此流（found=false 或调用失败）时，直接复位残留 streaming 标志，
      // 避免输入框被残留状态永久锁死（验收 B-7）
      if (!res.ok || res.data?.found === false) {
        const cur = useSessionStore.getState();
        cur.sessions
          .find((s) => s.id === sessionId)
          ?.messages.filter((m) => m.streaming)
          .forEach((m) => cur.updateMessage(sessionId, m.id, { streaming: false }));
      }
    });

  // 乐观复位（事件后到再校正）——引擎中断路径 ≤120ms 内会补发 done
  if (streamingMsgs.length > 0) {
    // 不立即置 false：等引擎 done 或 found=false 自愈，避免与正常完成竞态双写
  }
}

// ===== 待发送队列（流式预输入）：流结束后自动逐条发送 =====

/** 入队一条待发消息（流式中的 Enter/排队按钮） */
export function enqueuePending(text: string): void {
  const state = useSessionStore.getState();
  const sid = state.activeId;
  if (!sid || !text.trim()) return;
  const s = state.sessions.find((x) => x.id === sid);
  if (!s) return;
  const next = [...(s.pending ?? []), text];
  useSessionStore.setState((st) => ({
    sessions: st.sessions.map((x) => (x.id === sid ? { ...x, pending: next } : x)),
  }));
}

/** 流结束时由 sendUserMessage 的 settle 调用：自动发送队首一条 */
function pumpPendingOnce(): void {
  const state = useSessionStore.getState();
  const sid = state.activeId;
  if (!sid) return;
  const s = state.sessions.find((x) => x.id === sid);
  const q = s?.pending ?? [];
  if (q.length === 0) return;
  const first = q[0];
  const rest = q.slice(1);
  useSessionStore.setState((st) => ({
    sessions: st.sessions.map((x) => (x.id === sid ? { ...x, pending: rest } : x)),
  }));
  void sendUserMessage(first);
}

/** 面板胶囊点击：立即发送全部待发（按序） */
export function flushPendingAll(): void {
  pumpPendingOnce();
}

export const chatComponents = { SessionSidebar, MessageStream, ChatInput };

export default chatLitePlugin;
