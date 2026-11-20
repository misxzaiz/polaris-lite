/**
 * codebuddy-engine 插件：腾讯 CodeBuddy CLI 引擎（cap.ai.chat 流式实现）。
 *
 * 纯插件集成（可行性分析 2026-11-20）：
 * - 引擎执行在**服务端半边**（server.mjs）：spawn 本目录 adapter.js（复用 Polaris-plugin
 *   的 codebuddy 适配器）→ adapter 再 spawn `codebuddy -p --output-format stream-json`；
 * - 前端半边只做 cap.ai.chat / cap.ai.chat.interrupt 的**流式转发壳**：dispatch 进来后
 *   POST 到服务端 /api/codebuddy/stream（SSE），把服务端事件原样 emit 给宿主总线；
 * - 与 real-engine 互斥：cap.ai.chat 是单注册位（bus.register 重复即抛），两者只能
 *   启用一个（registry enabled 开关切换）。
 *
 * 事件流（服务端 → 前端 → 宿主广播 cap.ai.chat:event）：
 *   message.delta / message.reasoning / tool.card / tool.result / ai.usage /
 *   message.done / stream.error / engine.status（冷启动等状态行，喂 chat-lite 看门狗）
 */
import type { CapabilityHandler, LitePlugin, SlotHostApi, StreamCapabilityHandler } from '@sdk';

const STREAM_URL = '/api/codebuddy/stream';
const INTERRUPT_URL = '/api/codebuddy/interrupt';

/** chat-lite 的 start payload 形状（含 agent-loop 透传的 messages/tools——本引擎不用） */
interface ChatStartPayload {
  sessionId?: string;
  messageId?: string;
  prompt?: string;
  history?: { role: string; content: unknown }[];
  attachments?: { name?: string; mime?: string; content?: string; textContent?: string }[];
}

const running = new Map<string, () => void>();

const streamHandler: StreamCapabilityHandler = async (req, emit) => {
  const payload = (req.payload ?? {}) as ChatStartPayload;
  const sessionId = payload.sessionId ?? 'unknown';
  const messageId = payload.messageId ?? 'unknown';
  const streamKey = `${sessionId}::${messageId}`;

  // abort：前端中断 = 关闭 SSE fetch；服务端检测到连接断开会杀 CLI 树
  const abort = new AbortController();
  running.set(streamKey, () => abort.abort());

  try {
    const resp = await fetch(STREAM_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(payload),
      signal: abort.signal,
    });
    if (!resp.ok || !resp.body) {
      const text = await resp.text().catch(() => '');
      let msg = `HTTP ${resp.status}`;
      try {
        const j = JSON.parse(text);
        msg = j.error?.message ?? j.error ?? msg;
      } catch { /* 保留状态码描述 */ }
      emit({ kind: 'stream.error', payload: { sessionId, messageId, message: String(msg) } });
      emit({ kind: 'message.done', payload: { sessionId, messageId } });
      return;
    }

    // SSE 解析（与 real-engine 的中继路径同构）
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const ev = JSON.parse(data) as { kind?: string; payload?: unknown };
          if (ev.kind) emit({ kind: ev.kind, payload: ev.payload ?? {} });
        } catch { /* 跳过不完整行 */ }
      }
    }
    // 服务端在 CLI 退出时必发 message.done；SSE 正常关闭兜底补发（防 UI 永久 streaming）
    emit({ kind: 'message.done', payload: { sessionId, messageId } });
  } catch (err) {
    // abort = 用户中断：服务端已杀树并补发 done；这里不再重复 emit
    if (!abort.signal.aborted) {
      emit({
        kind: 'stream.error',
        payload: { sessionId, messageId, message: err instanceof Error ? err.message : String(err) },
      });
      emit({ kind: 'message.done', payload: { sessionId, messageId } });
    }
  } finally {
    running.delete(streamKey);
  }
};

const interruptHandler: CapabilityHandler = async (req) => {
  const payload = (req.payload ?? {}) as { sessionId?: string; messageId?: string };
  // 先本地 abort SSE（立即断流），再通知服务端杀树（幂等；进程可能已退出）
  if (payload.sessionId && payload.messageId) {
    running.get(`${payload.sessionId}::${payload.messageId}`)?.();
  }
  if (payload.sessionId) {
    for (const key of [...running.keys()]) {
      if (key.startsWith(`${payload.sessionId}::`)) running.get(key)?.();
    }
  }
  try {
    await fetch(INTERRUPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(payload),
    });
  } catch { /* 服务端不可达：本地 abort 已断流 */ }
  return { ok: true, found: true };
};

export const codebuddyEnginePlugin: LitePlugin = {
  manifest: {
    id: 'codebuddy-engine',
    name: 'CodeBuddy 引擎',
    version: '0.1.0',
    capabilities: [],
    provides: ['cap.ai.chat', 'cap.ai.chat.interrupt'],
    events: [],
    contributes: { slots: [] },
  },
  setup(api: SlotHostApi) {
    api.registerCapability.registerStreaming('cap.ai.chat', streamHandler);
    api.registerCapability.register('cap.ai.chat.interrupt', interruptHandler);
  },
};

export default codebuddyEnginePlugin;
