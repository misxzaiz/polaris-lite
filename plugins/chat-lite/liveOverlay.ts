/**
 * 跨设备实时查看（live overlay）：点开一个「执行中」的远端会话时，
 * 拉最新落盘全文 + 订阅该会话的 live 事件流，把 delta/工具卡渲染成
 * 一条本地临时 assistant 消息（overlay）。
 *
 * 关键复用：overlay 消息带 streaming:true —— store/sync 既有守卫天然跳过
 * 该会话的 push/pull（isStreaming 分支），overlay 不会污染落盘数据；
 * loop.done / stream.error / 看门狗超时（发起端暴毙）时丢弃 overlay、
 * pullNow() 拉最终落盘版收敛。
 */
import { useSessionStore, pullNow } from './store';
import { isToolCard, type StoreMessage, type AssistantBlockMessage, type ToolCardData } from './store';
import { SRV } from './serverApi';

/** SSE 静默超时：超此无任何 live 事件/ping 即放弃 overlay（对齐服务端 GC 余量） */
const OVERLAY_WATCHDOG_MS = 60_000;

interface LiveEnvelope { kind: string; payload: Record<string, unknown>; at?: number }

const active = new Map<string, { es: EventSource; wd: ReturnType<typeof setTimeout>; msgId: string }>();

function armWatchdog(sessionId: string): void {
  const a = active.get(sessionId);
  if (!a) return;
  clearTimeout(a.wd);
  a.wd = setTimeout(() => { void closeOverlay(sessionId, true); }, OVERLAY_WATCHDOG_MS);
}

/** 找到（或创建）overlay 消息；会话切回时服务端全文可能已更新，以 store 当前态为准 */
function ensureOverlay(sessionId: string): AssistantBlockMessage | undefined {  const st = useSessionStore.getState();
  const session = st.sessions.find((s) => s.id === sessionId);
  if (!session) return undefined;
  const existing = session.messages.find((m) => !isToolCard(m) && (m as AssistantBlockMessage).overlayLive === true) as AssistantBlockMessage | undefined;
  if (existing) return existing;
  const msgId = `live-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const msg = {
    id: msgId, role: 'assistant' as const, content: '', createdAt: Date.now(),
    streaming: true, overlayLive: true, blocks: [],
  } as AssistantBlockMessage & { overlayLive: boolean };
  useSessionStore.getState().appendMessage(sessionId, msg as StoreMessage);
  return msg as AssistantBlockMessage;
}

function handleLiveEvent(sessionId: string, ev: LiveEnvelope): void {
  const st = useSessionStore.getState();
  const session = st.sessions.find((s) => s.id === sessionId);
  if (!session) return;
  // overlay 消息尚不存在时先创建（首个 delta/工具卡到达即建）
  const overlay = ensureOverlay(sessionId);
  const msgId = overlay?.id;
  const inner = ev.payload ?? {};
  switch (ev.kind) {
    case 'message.delta': {
      if (!msgId || typeof inner.delta !== 'string') return;
      useSessionStore.getState().appendAssistantBlock(sessionId, msgId, { type: 'text', text: inner.delta });
      break;
    }
    case 'message.reasoning': {
      if (!msgId || typeof inner.delta !== 'string') return;
      useSessionStore.getState().appendAssistantBlock(sessionId, msgId, { type: 'thinking', text: inner.delta });
      break;
    }
    case 'tool.card': {
      if (!msgId || typeof inner.callId !== 'string') return;
      const card: ToolCardData = {
        callId: inner.callId, name: String(inner.name ?? 'tool'),
        ...(typeof inner.command === 'string' ? { command: inner.command } : {}),
        status: 'running',
      };
      useSessionStore.getState().appendAssistantBlock(sessionId, msgId, { type: 'tool', card });
      break;
    }
    case 'tool.result': {
      if (!msgId || typeof inner.callId !== 'string') return;
      const status = inner.status === 'done' ? 'done' : inner.status === 'denied' ? 'denied' : 'error';
      useSessionStore.getState().patchAssistantToolBlock(sessionId, msgId, inner.callId, {
        status,
        ...(typeof inner.stdout === 'string' ? { stdout: inner.stdout } : {}),
        ...(typeof inner.stderr === 'string' ? { stderr: inner.stderr } : {}),
        ...(typeof inner.exitCode === 'number' ? { exitCode: inner.exitCode } : {}),
        ...(typeof inner.durationMs === 'number' ? { durationMs: inner.durationMs } : {}),
      });
      break;
    }
    case 'message.done':
    case 'loop.done':
    case 'stream.error':
      void closeOverlay(sessionId, false);
      return;
    default:
      return; // context.snapshot 等查看端不消费
  }
  armWatchdog(sessionId);
}

/** 结束 overlay：reset 标记=true（看门狗/异常）时先兜底拉全文；false=正常 done，拉最终版 */
async function closeOverlay(sessionId: string, reset: boolean): Promise<void> {
  const a = active.get(sessionId);
  if (a) {
    clearTimeout(a.wd);
    try { a.es.close(); } catch { /* 已断 */ }
    active.delete(sessionId);
  }
  const st = useSessionStore.getState();
  const session = st.sessions.find((s) => s.id === sessionId);
  const overlay = session?.messages.find((m) => !isToolCard(m) && (m as AssistantBlockMessage).overlayLive === true) as AssistantBlockMessage | undefined;
  if (overlay) {
    // 丢弃 overlay（拉取合并会以服务端最终版覆盖整个会话）
    useSessionStore.setState((s) => ({
      sessions: s.sessions.map((x) => (x.id === sessionId
        ? { ...x, messages: x.messages.filter((m) => m.id !== overlay.id) }
        : x)),
    }));
  }
  if (reset) {
    // 发起端疑似暴毙：立刻兜底拉一次落盘版（可能只有任务开始前的内容）
    await pullNow();
  } else {
    // 正常完成：发起端 settle 后会推送；稍候片刻再对账一次拿最终全文
    setTimeout(() => { void pullNow(); }, 1500);
  }
}

/**
 * 打开会话时调用：若该会话正在执行（服务端 running 表有记录）且不是本端
 * 自己在流式，则建立 SSE 订阅并准备 overlay。返回是否进入了 live 观察态。
 */
export async function openLiveIfNeeded(sessionId: string): Promise<boolean> {
  if (active.has(sessionId)) return true;
  const st = useSessionStore.getState();
  const session = st.sessions.find((s) => s.id === sessionId);
  if (!session) return false;
  // 本端自己正在流式：本地已是实时渲染，不需要 overlay
  if (session.messages.some((m) => !isToolCard(m) && m.streaming && !(m as AssistantBlockMessage).overlayLive)) return false;
  if (!st.runningLoops[sessionId]) return false;

  // 先拉最新落盘全文（overlay 之前的前置消息），再订阅事件流
  await pullNow();
  if (active.has(sessionId)) return true;
  const es = new EventSource(`${SRV.chat}/sessions/${encodeURIComponent(sessionId)}/events`);
  const entry = { es, wd: setTimeout(() => { void closeOverlay(sessionId, true); }, OVERLAY_WATCHDOG_MS), msgId: '' };
  active.set(sessionId, entry);
  es.addEventListener('live', (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as { events?: LiveEnvelope[] };
      for (const e of data.events ?? []) handleLiveEvent(sessionId, e);
    } catch { /* 非 JSON 忽略 */ }
  });
  es.addEventListener('ping', () => armWatchdog(sessionId));
  es.onerror = () => { void closeOverlay(sessionId, true); };
  return true;
}

/** 会话关闭/切走时清理（overlay 保留在 store 里，由拉取收敛或下次继续） */
export function closeLive(sessionId: string): void {
  const a = active.get(sessionId);
  if (!a) return;
  clearTimeout(a.wd);
  try { a.es.close(); } catch { /* 已断 */ }
  active.delete(sessionId);
}
