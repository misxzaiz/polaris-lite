/**
 * codebuddy-engine 插件：腾讯 CodeBuddy CLI 引擎（cap.ai.chat 流式实现）。
 *
 * 纯插件集成（可行性分析 2026-11-20）：
 * - 引擎执行在**服务端半边**（server.mjs）：spawn 本目录 adapter.js（复用 Polaris-plugin
 *   的 codebuddy 适配器）→ adapter 再 spawn `codebuddy -p --output-format stream-json`；
 * - 前端半边注册 cap.ai.chat.codebuddy / .interrupt / .models：dispatch 进来后
 *   POST 到服务端 /api/codebuddy/stream（SSE），把服务端事件原样 emit 给核心分派器；
 * - 与 real-engine 并存：核心按 payload.engineId 路由到各自的 namespaced cap，
 *   切换引擎不再改 registry 开关，消费方（chat-lite）零改动。
 *
 * 事件流（服务端 → 前端 → 宿主广播 cap.ai.chat:event）：
 *   message.delta / message.reasoning / tool.card / tool.result / ai.usage /
 *   message.done / stream.error / engine.status（冷启动等状态行，喂 chat-lite 看门狗）
 */
import type { CapabilityHandler, LitePlugin, SlotHostApi, StreamCapabilityHandler } from '@sdk';
import { createSseReader, createInterruptMap } from '../engine-kit';

const STREAM_URL = '/api/codebuddy/stream';
const INTERRUPT_URL = '/api/codebuddy/interrupt';

/** 会话绑定的工作区 id → 服务端登记根 path（服务端仍做白名单校验；解析失败不传） */
async function resolveWorkdir(workspaceId: string | undefined): Promise<string | undefined> {
  if (!workspaceId) return undefined;
  try {
    const r = await fetch('/api/fs/roots', { credentials: 'include' });
    const j = (await r.json()) as { roots?: { id: string; path: string; missing?: boolean }[] };
    const root = j.roots?.find((x) => x.id === workspaceId && !x.missing);
    return root?.path;
  } catch {
    return undefined;
  }
}

/** chat-lite 的 start payload 形状（含 agent-loop 透传的 messages/tools——本引擎不用） */
interface ChatStartPayload {
  sessionId?: string;
  messageId?: string;
  prompt?: string;
  history?: { role: string; content: unknown }[];
  attachments?: { name?: string; mime?: string; content?: string; textContent?: string }[];
  /** 会话级 CLI 模型（chat-lite 的 modelRef.option 经分派器透传）；缺省=CLI 默认 */
  option?: string;
  model?: string;
  workdir?: string;
  workspaceId?: string;
}

const running = createInterruptMap();

const streamHandler: StreamCapabilityHandler = async (req, emit) => {
  const payload = (req.payload ?? {}) as ChatStartPayload;
  const sessionId = payload.sessionId ?? 'unknown';
  const messageId = payload.messageId ?? 'unknown';
  const streamKey = `${sessionId}::${messageId}`;
  const workdir = payload.workdir ?? await resolveWorkdir(payload.workspaceId);

  // abort：前端中断 = 关闭 SSE fetch；服务端检测到连接断开会杀 CLI 树
  const abort = new AbortController();
  running.set(streamKey, () => abort.abort());

  try {
    const resp = await fetch(STREAM_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      // modelRef.option 是本引擎的模型选择；服务端沿用 model 字段。映射留在引擎内部。
      body: JSON.stringify({
        ...payload,
        ...(payload.option && !payload.model ? { model: payload.option } : {}),
        ...(workdir ? { workdir } : {}),
      }),
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

    // SSE 解析（engine-kit 共享 reader；服务端事件已是 { kind, payload } 形态）
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    const sse = createSseReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const frame of sse.push(decoder.decode(value, { stream: true }))) {
        if (!frame.data) continue;
        try {
          const ev = JSON.parse(frame.data) as { kind?: string; payload?: unknown };
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

/** 动态模型目录：CLI 升级新增模型自动跟随，清单不在前端写死。
 *  核心 cap.ai.engine 通过 cap.ai.chat.codebuddy.models 读取本目录与可用性。 */
const modelsHandler: CapabilityHandler = async () => {
  try {
    const resp = await fetch('/api/codebuddy/health', { credentials: 'include', cache: 'no-store' });
    const j = (await resp.json().catch(() => null)) as
      | { ok?: boolean; cliFound?: boolean; models?: string[] }
      | null;
    const available = !!j?.ok && !!j?.cliFound;
    return {
      available,
      models: available && Array.isArray(j?.models) ? j!.models!.map((id) => ({ id })) : [],
    };
  } catch {
    return { available: false, models: [] };
  }
};

export const codebuddyEnginePlugin: LitePlugin = {
  manifest: {
    id: 'codebuddy-engine',
    name: 'CodeBuddy 引擎',
    version: '0.2.0',
    capabilities: [],
    provides: ['cap.ai.chat.codebuddy', 'cap.ai.chat.codebuddy.interrupt', 'cap.ai.chat.codebuddy.models'],
    aiEngine: {
      id: 'codebuddy',
      displayName: 'CodeBuddy CLI',
      kind: 'agent',
      modelSource: 'builtin',
      features: { supportsTools: false, slashSkills: false },
    },
    events: [],
    contributes: { slots: [] },
  },
  setup(api: SlotHostApi) {
    api.registerCapability.registerStreaming('cap.ai.chat.codebuddy', streamHandler);
    api.registerCapability.register('cap.ai.chat.codebuddy.interrupt', interruptHandler);
    api.registerCapability.register('cap.ai.chat.codebuddy.models', modelsHandler);
  },
};

export default codebuddyEnginePlugin;
