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
import { useSessionStore } from './store';
import type { Attachment } from './attachments';
import { SessionSidebar } from './SessionSidebar';
import { MessageStream } from './MessageStream';
import { ChatInput } from './ChatInput';

/** 与 mock-auth 的会话镜像键保持一致（跨插件约定） */
const MOCK_AUTH_SESSION_KEY = 'mock-auth.session.v1';

/** 看门狗：流式期间超过该时长没有任何增量，强制收敛（防按钮永久卡在「停止」） */
const STREAM_IDLE_TIMEOUT_MS = 30_000;

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
    version: '0.2.0',
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

/** 由 ChatInput / 快捷建议 / 队列泵调用：发送用户消息并触发流式回复 */
export async function sendUserMessage(text: string, attachments?: Attachment[]): Promise<void> {
  const api = hostApi;
  const hasAttachments = !!attachments && attachments.length > 0;
  if (!api || (!text.trim() && !hasAttachments)) return;
  const store = useSessionStore.getState();
  let sessionId = store.activeId;
  if (!sessionId) sessionId = store.createSession();
  const sid: string = sessionId;

  // 上下文 = 本次提问之前的全部消息（避免把本条也塞进去，造成上游收到重复两条）
  const history = store.sessions
    .find((s) => s.id === sid)
    ?.messages.filter((m) => !m.streaming)
    .map((m) => ({ role: m.role, content: m.content }));

  store.appendMessage(sid, {
    id: nextMsgId(),
    role: 'user',
    content: text,
    createdAt: Date.now(),
  } satisfies ChatMessage);

  const assistantId = nextMsgId();
  store.appendMessage(sid, {
    id: assistantId,
    role: 'assistant',
    content: '',
    createdAt: Date.now(),
    streaming: true,
  } satisfies ChatMessage);

  const readContent = (): string =>
    useSessionStore.getState().sessions
      .find((x) => x.id === sid)?.messages.find((m) => m.id === assistantId)?.content ?? '';

  // ---- delta 按帧合并 ----
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
    useSessionStore.getState().updateMessage(sid, assistantId, { content: readContent() + chunk });
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
      const prev = readContent();
      useSessionStore.getState().updateMessage(sid, assistantId, {
        content: `${prev}${prev ? '\n\n' : ''}⚠️ 响应超时（${STREAM_IDLE_TIMEOUT_MS / 1000}s 无新内容），已结束本次流式`,
      });
      settle();
    }, STREAM_IDLE_TIMEOUT_MS);
  };

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
      const prev = readContent();
      useSessionStore.getState().updateMessage(sid, assistantId, {
        content: `${prev}${prev ? '\n\n' : ''}⚠️ ${detail || '流式请求失败'}`,
      });
      settle();
    }
  });
  unbind = off;
  armWatchdog(); // 首个 delta 之前就无响应（上游挂住）也能收敛

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
  const sessionId = useSessionStore.getState().activeId;
  if (!api || !sessionId) return;

  void api
    .dispatch<{ found?: boolean }>({
      target: 'cap.ai.chat.interrupt',
      action: 'interrupt',
      payload: { sessionId },
    })
    .then((res) => {
      // 自愈：引擎已无此流（found=false 或调用失败）时复位残留 streaming 标志，
      // 避免输入框被残留状态永久锁死；复位后同样要让队列继续流动。
      if (!res.ok || res.data?.found === false) {
        const cur = useSessionStore.getState();
        cur.sessions
          .find((s) => s.id === sessionId)
          ?.messages.filter((m) => m.streaming)
          .forEach((m) => cur.updateMessage(sessionId, m.id, { streaming: false }));
        sendNextPending();
      }
    });
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
