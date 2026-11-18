/**
 * real-engine 插件：真实模型供应商引擎（OpenAI 兼容 /chat/completions 流式）。
 *
 * - 供应商配置来自 config-manager（cap.config，namespace='model-admin'）；
 * - 对外提供 cap.ai.chat / cap.ai.chat.interrupt（流式，事件契约 message.delta → message.done）；
 * - 上游请求经宿主内嵌中继 /api/model-relay 转发（同源单端口；会话 cookie 鉴权，
 *   未登录/过期一律 401；CORS 由宿主同源转发解决）；对话发起方（chat-lite）
 *   只经 cap 总线调用，不接触中继/供应商细节；
 * - running map 按 sessionId::messageId 精确中断。
 */
import type { CapabilityHandler, LitePlugin, SlotHostApi, StreamCapabilityHandler } from '@/core/types';

const RELAY_URL = '/api/model-relay'; // 宿主内嵌中继（同源；会话 cookie 自动携带）
const running = new Map<string, () => void>();

interface ModelCaps {
  maxInputTokens: number;
  maxOutputTokens: number;
  effort: 'minimal' | 'low' | 'medium' | 'high' | null;
  vision: boolean;
}

interface ProviderConfig {
  id: string;
  name: string;
  baseURL: string;
  apiKey: string;
  models: { id: string; capabilities?: ModelCaps }[];
  activeModel: string;
  enabled: boolean;
  isDefault?: boolean;
}

let currentProvider: ProviderConfig | null = null;
/** 刷新供应商配置的函数引用（setup 时注入，供流式调用前兜底重试） */
let refreshProvider: () => Promise<void> = async () => {};

async function relayFetch(body: unknown, apiKey: string, signal?: AbortSignal): Promise<Response> {
  return fetch(RELAY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal,
  });
}

function pickProvider(): ProviderConfig | null {
  if (currentProvider && currentProvider.enabled && currentProvider.apiKey) return currentProvider;
  return null;
}

/** 按供应商方言把能力字段拼进请求体（宁缺毋错传：未知字段不发送） */
function buildCapabilityParams(provider: ProviderConfig): Record<string, unknown> {
  const caps = provider.models.find((m) => m.id === provider.activeModel)?.capabilities
    ?? provider.models[0]?.capabilities;
  if (!caps) return {};
  const out: Record<string, unknown> = {};
  const isAnthropic = provider.baseURL.includes('anthropic');
  if (caps.maxOutputTokens > 0) out.max_tokens = caps.maxOutputTokens;
  if (caps.effort) {
    if (isAnthropic) out.thinking = { type: 'enabled', budget_tokens: { low: 2048, medium: 8192, high: 32768 }[caps.effort] ?? 8192 };
    else out.reasoning_effort = caps.effort;
  }
  return out;
}

const streamHandler: StreamCapabilityHandler = async (req, emit) => {
  const payload = (req.payload ?? {}) as {
    sessionId?: string;
    messageId?: string;
    prompt?: string;
    history?: { role: string; content: string }[];
  };
  const sessionId = payload.sessionId ?? 'unknown';
  const messageId = payload.messageId ?? 'unknown';
  const streamKey = `${sessionId}::${messageId}`;

  // 兜底：流式调用前再刷一次配置（面板保存/启动时序问题都能自愈）
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
    const attachments = (payload.attachments ?? []) as {
      name?: string; mime?: string; content?: string; textContent?: string;
    }[];
    const activeCaps = provider.models.find((m) => m.id === provider.activeModel)?.capabilities
      ?? provider.models[0]?.capabilities;
    const visionOk = activeCaps?.vision !== false; // 缺省（未知）按支持处理，宁放行不误杀
    const lastUser = messages[messages.length - 1];
    if (attachments.length > 0 && lastUser?.role === 'user') {
      const parts: { type: string; text?: string; image_url?: { url: string } }[] = [];
      let textContent = typeof lastUser.content === 'string' ? lastUser.content : '';
      let imageCount = 0;
      let imageBlocked = 0;
      for (const att of attachments) {
        if (att.content && att.mime?.startsWith('image/')) {
          imageCount += 1;
          if (visionOk) {
            parts.push({ type: 'image_url', image_url: { url: att.content } });
          } else {
            imageBlocked += 1; // 能力表明确不支持图片：降级为文本说明
          }
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
        url: `${provider.baseURL.replace(/\/$/, '')}/chat/completions`,
        body: {
          model: provider.activeModel || (provider.models[0]?.id ?? ''),
          stream: true,
          messages,
          ...(buildCapabilityParams(provider) as Record<string, unknown>),
        },
      },
      provider.apiKey,
      abort.signal,
    );

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      let msg = `HTTP ${resp.status}`;
      try {
        const j = JSON.parse(text);
        msg = j.error?.message ?? j.message ?? msg;
      } catch { /* keep */ }
      if (resp.status === 401) msg = '登录已过期，请重新登录';
      emit({ kind: 'stream.error', payload: { sessionId, messageId, message: msg } });
      return;
    }

    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
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
          const delta: string | undefined = json.choices?.[0]?.delta?.content;
          if (delta) {
            emit({ kind: 'message.delta', payload: { sessionId, messageId, delta } });
          }
        } catch { /* 跳过不完整行 */ }
      }
    }
    emit({ kind: 'message.done', payload: { sessionId, messageId } });
  } catch (err) {
    if (cancelled) {
      // 中断：必须补发 done，否则 chat-lite 的按钮永远停在「停止」态（验收 B-3 教训）
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
    version: '0.2.0',
    capabilities: ['cap.config', 'cap.model.admin'],
    events: ['model-config-changed', 'config-changed'],
    provides: ['cap.ai.chat', 'cap.ai.chat.interrupt'],
    contributes: { slots: [] },
  },
  setup(api: SlotHostApi) {
    // 供应商配置来源（按优先级）：
    // 1. cap.config 的 model-admin.providers（config-manager 权威存储）
    // 2. cap.model.admin/resolveActive（model-admin 面板兜底，含明文 key，本机工具形态）
    const refreshFromConfig = async (): Promise<boolean> => {
      const res = await api.dispatch<{ value?: ProviderConfig[] }>({
        target: 'cap.config',
        action: 'get',
        payload: { namespace: 'model-admin', key: 'providers' },
      });
      // cap.config get 带 key 返回的就是该 key 的值本身（这里 = ProviderConfig[]）
      const providers = res.ok ? res.data?.value : undefined;
      if (Array.isArray(providers) && providers.length) {
        currentProvider =
          providers.find((c) => c.isDefault && c.enabled && c.apiKey) ??
          providers.find((c) => c.enabled && c.apiKey) ??
          null;
        return true;
      }
      return false;
    };
    const refreshFromAdmin = async (): Promise<boolean> => {
      const res = await api.dispatch<{ config?: ProviderConfig }>({ target: 'cap.model.admin', action: 'resolveActive' });
      if (res.ok && res.data?.config) {
        currentProvider = res.data.config;
        return true;
      }
      return false;
    };
    const refresh = async () => {
      if (!(await refreshFromConfig())) {
        const okAdmin = await refreshFromAdmin();
        if (!okAdmin) {
          (window as unknown as Record<string, unknown>).__REAL_ENGINE_LAST_REFRESH__ = {
            time: Date.now(),
            configOk: false,
            adminOk: false,
          };
        }
      } else {
        (window as unknown as Record<string, unknown>).__REAL_ENGINE_LAST_REFRESH__ = {
          time: Date.now(),
          configOk: true,
        };
      }
    };
    refreshProvider = refresh;

    // 启动重试：装配早期 cap.config/cap.model.admin 可能尚未就绪，失败后指数退避重试，
    // 直到拿到配置（生产可用性：不依赖注册顺序）
    let attempts = 0;
    const refreshWithRetry = async () => {
      while (attempts < 8 && !currentProvider) {
        await refresh();
        if (currentProvider) break;
        attempts += 1;
        await new Promise((r) => setTimeout(r, Math.min(500 * attempts, 2000)));
      }
    };
    void refreshWithRetry();
    // 配置热更新：两个来源任一变化都重拉（面板保存 / 其他插件改配置）
    api.listen('model-config-changed', () => void refresh());
    api.listen('config-changed', (payload) => {
      const p = payload as { namespace?: string };
      if (p.namespace === 'model-admin') void refresh();
    });

    api.registerCapability.registerStreaming('cap.ai.chat', streamHandler);
    api.registerCapability.register('cap.ai.chat.interrupt', interruptHandler);
  },
};

export default realEnginePlugin;
