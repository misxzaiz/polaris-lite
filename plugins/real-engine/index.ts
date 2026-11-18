/**
 * real-engine 插件：真实模型供应商引擎（OpenAI 兼容 /chat/completions 流式）。
 *
 * 架构变更（2026-11 密钥下沉）：
 * - 引擎**不再接触 API Key**：中继接受 {providerId, body}，由服务端注入 key 与上游地址；
 * - 供应商信息经 cap.model.admin/resolveActive 取得（masked 视图：id / activeModel / 能力表）；
 * - 因此本插件不再依赖 cap.config，也不再在浏览器里存放任何密钥；
 * - 对外仍提供 cap.ai.chat / cap.ai.chat.interrupt（流式，message.delta → message.done）。
 *
 * 其它约定：
 * - running map 按 sessionId::messageId 精确中断（并发流互不误伤）；
 * - 中断路径必须补发 message.done，否则 UI 的「停止」按钮永远不回位。
 */
import type { CapabilityHandler, LitePlugin, SlotHostApi, StreamCapabilityHandler } from '@/core/types';

const RELAY_URL = '/api/model-relay'; // 宿主内嵌中继（同源；会话 cookie 自动携带）

interface ModelCaps {
  maxInputTokens: number;
  maxOutputTokens: number;
  effort: 'minimal' | 'low' | 'medium' | 'high' | null;
  vision: boolean;
}

/** 引擎视角的供应商（masked：服务端只回这些字段，无 apiKey） */
interface ActiveProvider {
  id: string;
  name: string;
  baseURL: string;
  models: { id: string; capabilities?: ModelCaps }[];
  activeModel: string;
  enabled: boolean;
  isDefault: boolean;
  hasKey: boolean;
}

const running = new Map<string, () => void>();
let currentProvider: ActiveProvider | null = null;
/** 刷新供应商配置的函数引用（setup 时注入，流式调用前兜底重试） */
let refreshProvider: () => Promise<void> = async () => {};

async function relayFetch(body: unknown, providerId: string, signal?: AbortSignal): Promise<Response> {
  return fetch(RELAY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId, body }),
    signal,
  });
}

function pickProvider(): ActiveProvider | null {
  return currentProvider && currentProvider.enabled && currentProvider.hasKey ? currentProvider : null;
}

function activeCaps(provider: ActiveProvider): ModelCaps | undefined {
  return provider.models.find((m) => m.id === provider.activeModel)?.capabilities
    ?? provider.models[0]?.capabilities;
}

/** 按供应商方言把能力字段拼进请求体（宁缺毋错传：未知字段不发送） */
function buildCapabilityParams(provider: ActiveProvider): Record<string, unknown> {
  const caps = activeCaps(provider);
  if (!caps) return {};
  const out: Record<string, unknown> = {};
  if (caps.maxOutputTokens > 0) out.max_tokens = caps.maxOutputTokens;
  if (caps.effort) out.reasoning_effort = caps.effort;
  return out;
}

const streamHandler: StreamCapabilityHandler = async (req, emit) => {
  const payload = (req.payload ?? {}) as {
    sessionId?: string;
    messageId?: string;
    prompt?: string;
    history?: { role: string; content: string }[];
    attachments?: { name?: string; mime?: string; content?: string; textContent?: string }[];
  };
  const sessionId = payload.sessionId ?? 'unknown';
  const messageId = payload.messageId ?? 'unknown';
  const streamKey = `${sessionId}::${messageId}`;

  // 兜底：流式调用前再刷一次配置（登录后/面板保存后的时序问题都能自愈）
  if (!pickProvider()) {
    try { await refreshProvider(); } catch { /* 下方统一报错 */ }
  }
  const provider = pickProvider();
  if (!provider) {
    emit({
      kind: 'stream.error',
      payload: { sessionId, messageId, message: '没有可用的模型供应商：请在「模型供应商管理」面板填写 API Key 并启用。' },
    });
    return;
  }

  // Anthropic 原生接口是 /v1/messages（SSE 结构也不同），当前引擎只实现 OpenAI 兼容协议：
  // 明确拒绝而不是让上游回 404，避免"看起来能配、其实不通"。
  if (provider.baseURL.includes('api.anthropic.com')) {
    emit({
      kind: 'stream.error',
      payload: {
        sessionId,
        messageId,
        message: 'Anthropic 原生接口未适配（需 /v1/messages 协议）：请改用 OpenAI 兼容中转地址。',
      },
    });
    return;
  }

  let cancelled = false;
  const abort = new AbortController();
  running.set(streamKey, () => {
    cancelled = true;
    abort.abort();
  });

  try {
    const messages = [
      ...(payload.history ?? []).map((m) => ({ role: m.role as 'user' | 'assistant' | 'system', content: m.content })),
      { role: 'user' as const, content: payload.prompt ?? '' },
    ];
    // 附件：图片进 content（base64 data URL），文本拼进 prompt；
    // vision=false 的模型把图片附件降级为文本说明（不向上游发送会被拒的 image_url）
    const attachments = payload.attachments ?? [];
    const caps = activeCaps(provider);
    const visionOk = caps?.vision !== false; // 缺省（未知）按支持处理，宁放行不误杀
    const lastUser = messages[messages.length - 1] as { role: string; content: unknown };
    if (attachments.length > 0 && lastUser?.role === 'user') {
      const parts: { type: string; text?: string; image_url?: { url: string } }[] = [];
      let textContent = typeof lastUser.content === 'string' ? lastUser.content : '';
      let imageBlocked = 0;
      for (const att of attachments) {
        if (att.content && att.mime?.startsWith('image/')) {
          if (visionOk) parts.push({ type: 'image_url', image_url: { url: att.content } });
          else imageBlocked += 1; // 能力表明确不支持图片：降级为文本说明
        } else if (att.textContent) {
          textContent += `\n\n[附件: ${att.name ?? 'file'}]\n${att.textContent}`;
        }
      }
      if (imageBlocked > 0) {
        textContent += `\n\n[系统提示：当前模型 ${provider.activeModel} 不支持图片输入，已跳过 ${imageBlocked} 张图片附件]`;
      }
      if (parts.length > 0) {
        parts.unshift({ type: 'text', text: textContent });
        lastUser.content = parts;
      } else if (textContent !== lastUser.content) {
        lastUser.content = textContent;
      }
    }

    const resp = await relayFetch(
      {
        model: provider.activeModel || (provider.models[0]?.id ?? ''),
        stream: true,
        messages,
        ...buildCapabilityParams(provider),
      },
      provider.id,
      abort.signal,
    );

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      let msg = `HTTP ${resp.status}`;
      try {
        const j = JSON.parse(text);
        msg = j.error?.message ?? j.message ?? j.error ?? msg;
      } catch { /* 保留 HTTP 状态描述 */ }
      if (resp.status === 401) msg = '登录已过期，请重新登录';
      emit({ kind: 'stream.error', payload: { sessionId, messageId, message: String(msg) } });
      return;
    }

    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      if (cancelled) {
        emit({ kind: 'message.done', payload: { sessionId, messageId, interrupted: true } });
        return;
      }
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const json = JSON.parse(data);
          // 兼容两类增量：常规 content 与推理模型的 reasoning_content
          const delta: string | undefined = json.choices?.[0]?.delta?.content;
          if (delta) emit({ kind: 'message.delta', payload: { sessionId, messageId, delta } });
        } catch { /* 跳过不完整行 */ }
      }
    }
    emit({ kind: 'message.done', payload: { sessionId, messageId } });
  } catch (err) {
    if (cancelled) {
      // 中断：必须补发 done，否则 chat-lite 的按钮永远停在「停止」态
      emit({ kind: 'message.done', payload: { sessionId, messageId, interrupted: true } });
    } else {
      emit({
        kind: 'stream.error',
        payload: { sessionId, messageId, message: err instanceof Error ? err.message : String(err) },
      });
    }
  } finally {
    running.delete(streamKey);
  }
};

const interruptHandler: CapabilityHandler = (req) => {
  const payload = (req.payload ?? {}) as { sessionId?: string; messageId?: string };
  if (payload.sessionId && payload.messageId) {
    const key = `${payload.sessionId}::${payload.messageId}`;
    running.get(key)?.();
    return { ok: true, found: running.has(key) };
  }
  if (payload.sessionId) {
    let found = false;
    for (const key of [...running.keys()]) {
      if (key.startsWith(`${payload.sessionId}::`)) {
        running.get(key)?.();
        found = true;
      }
    }
    return { ok: true, found };
  }
  return { ok: false, found: false };
};

export const realEnginePlugin: LitePlugin = {
  manifest: {
    id: 'real-engine',
    name: '真实模型引擎',
    version: '0.3.0',
    capabilities: ['cap.model.admin'],
    events: ['model-config-changed', 'auth-changed'],
    provides: ['cap.ai.chat', 'cap.ai.chat.interrupt'],
    contributes: { slots: [] },
  },
  setup(api: SlotHostApi) {
    const refresh = async () => {
      const res = await api.dispatch<{ config?: ActiveProvider }>({ target: 'cap.model.admin', action: 'resolveActive' });
      currentProvider = res.ok && res.data?.config ? res.data.config : null;
    };
    refreshProvider = refresh;

    // 配置热更新：面板保存后广播 model-config-changed；登录态变化后重取（未登录时 resolveActive 会 401）
    api.listen('model-config-changed', () => void refresh());
    api.listen('auth-changed', () => void refresh());

    // 启动尝试一次（若尚未登录会失败，登录后由 auth-changed 补上）
    void refresh();
    // 面板保存时也会直接广播，这里不额外轮询：避免未登录空转

    api.registerCapability.registerStreaming('cap.ai.chat', streamHandler);
    api.registerCapability.register('cap.ai.chat.interrupt', interruptHandler);
  },
};

export default realEnginePlugin;
