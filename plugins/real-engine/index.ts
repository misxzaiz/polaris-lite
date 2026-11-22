/**
 * real-engine 插件：真实模型供应商引擎（OpenAI 兼容 /chat/completions 流式）。
 *
 * 架构变更（2026-11 密钥下沉）：
 * - 引擎**不再接触 API Key**：中继接受 {providerId, body}，由服务端注入 key 与上游地址；
 * - 供应商信息经 cap.model.admin/resolveActive 取得（masked 视图：id / activeModel / 能力表）；
 * - 因此本插件不再依赖 cap.config，也不再在浏览器里存放任何密钥；
 * - 对外仍提供 cap.ai.chat / cap.ai.chat.interrupt（流式，message.delta → message.done）。
 *
 * 独立档直连（docs/mobile-app-plan.md §10.3，B 档数据面）：
 * - 监听 mode-changed：standalone（宿主不可达）时经 /api/providers/direct-config
 *   取一次「当前供应商明文配置」（服务端三重约束：登录+回环+PLITE_ALLOW_DIRECT_CONFIG），
 *   后续请求直连供应商 baseURL——手机在无电脑时仍可对话；
 * - 可直连白名单 CORS_ALLOW：直连要求供应商放行浏览器跨域（历史实证：Moonshot 拦
 *   OPTIONS 404）。不在名单且探测失败的供应商返回结构化错误「需连接电脑使用」，
 *   不假装可用；名单按实测维护（OpenAI 等放行 ACAO:*）。
 * - connected 恢复：丢弃直连配置，回到中继路径（密钥重新只在服务端）。
 *
 * 其它约定：
 * - running map 按 sessionId::messageId 精确中断（并发流互不误伤）；
 * - 中断路径必须补发 message.done，否则 UI 的「停止」按钮永远不回位。
 */
import { CHANNEL_REAL_ENGINE_DIRECT, type CapabilityHandler, type LitePlugin, type SlotHostApi, type StreamCapabilityHandler } from '@sdk';
import { buildUsagePayload, createSseReader, isUpstreamDisconnectFrame, aggregateToolCallDelta, classifyLimitError, type WireUsage as KitWireUsage } from '../engine-kit';

const RELAY_URL = '/api/model-relay'; // 宿主内嵌中继（同源；会话 cookie 自动携带）
const DIRECT_CONFIG_URL = '/api/providers/direct-config';

interface ModelCaps {
  maxInputTokens: number;
  maxOutputTokens: number;
  effort: 'minimal' | 'low' | 'medium' | 'high' | null;
  vision: boolean;
}

/** ai.usage 事件载荷（spec：docs/context-insight-plan.md §4.1；v2 增缓存字段） */

/**
 * OpenAI 兼容 usage 块（流末帧；字段名按协议，camelCase 由本层转换）。
 * 缓存字段提取链对齐 simple_ai stream.rs：标准 `prompt_tokens_details.cached_tokens`，
 * 兼容 DeepSeek/GLM 变体 `prompt_cache_hit_tokens`；缓存写入取
 * `prompt_tokens_details.cache_creation_tokens` / 变体 `prompt_cache_miss_tokens`。
 */
type WireUsage = KitWireUsage;


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

/** ---- 独立档直连态（docs/mobile-app-plan.md §10.3；v2 修订：key 由用户显式同意后存本机） ---- */
/**
 * 直连配置的本机存储键。独立档设计（真机可用版）：
 * - 手机在**连接档**时，用户在「端点/独立模式」面板显式点「保存直连配置到本机」→
 *   前端调 /api/providers/direct-config（登录会话门禁）拉取当前供应商明文配置 → 存 localStorage；
 * - 宿主不可达（standalone）时，real-engine 读这份本地配置**直连供应商**（不经宿主中继）；
 * - key 属于「用户显式同意后保存在自己设备上」——与服务端持钥模型并存：
 *   连接档永远走中继（服务端 key），独立档才用本机副本。
 */
const DIRECT_STORE_KEY = 'real-engine.direct-config.v1';
/** 直连配置的服务端形态（models 供能力参数；activeModel 供请求体） */
interface DirectConfigFull {
  id: string;
  name: string;
  baseURL: string;
  apiKey: string;
  models: { id: string; capabilities?: ModelCaps }[];
  activeModel: string;
}
/** 宿主是否可达（standalone-mode 插件经 mode-changed 广播；缺省 connected 语义） */
let hostReachable = true;

function readStoredDirectConfig(): DirectConfigFull | null {
  try {
    const raw = localStorage.getItem(DIRECT_STORE_KEY);
    if (!raw) return null;
    const cfg = JSON.parse(raw) as DirectConfigFull;
    return cfg?.baseURL && cfg?.apiKey ? cfg : null;
  } catch {
    return null;
  }
}

/** 用户显式同意后拉取直连配置并保存到本机（面板按钮触发；返回结果供 UI 提示） */
async function fetchAndStoreDirectConfig(): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch(DIRECT_CONFIG_URL, { method: 'POST', credentials: 'include' });
    const data = (await res.json().catch(() => null)) as
      | { ok?: boolean; config?: DirectConfigFull }
      | null;
    if (res.ok && data?.ok && data.config?.baseURL && data.config?.apiKey) {
      localStorage.setItem(DIRECT_STORE_KEY, JSON.stringify(data.config));
      return { ok: true, message: `已保存 ${data.config.name ?? data.config.baseURL} 的直连配置到本机` };
    }
    const errCode = (data as { error?: { code?: string; message?: string } } | null)?.error;
    return { ok: false, message: errCode?.message ?? (res.ok ? '服务端无可用供应商' : `拉取失败（HTTP ${res.status}）`) };
  } catch (e) {
    return { ok: false, message: `网络不可达：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 清除本机直连配置（面板「清除」按钮；登出场景同样调用） */
function clearStoredDirectConfig(): void {
  localStorage.removeItem(DIRECT_STORE_KEY);
}

/**
 * 直连供应商的 CORS 预检（实测替代静态白名单——历史实证 Moonshot 拦 OPTIONS 404，
 * 静态清单永远跟不上供应商变化）。发一个最小 OPTIONS 预检：上游必须回
 * access-control-allow-origin（* 或含本 origin）。预检失败=需连接电脑，如实降级。
 */
async function probeDirectCors(baseURL: string): Promise<boolean> {
  const url = `${baseURL.replace(/\/+$/, '')}/chat/completions`;
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('OPTIONS', url);
    xhr.timeout = 8000;
    xhr.onreadystatechange = () => {
      if (xhr.readyState !== 4) return;
      const acao = xhr.getResponseHeader('access-control-allow-origin');
      resolve(xhr.status > 0 && !!acao);
    };
    xhr.ontimeout = () => resolve(false);
    xhr.onerror = () => resolve(false);
    xhr.send();
  });
}

/** 直连请求（OpenAI 兼容 /chat/completions；key 本地注入） */
async function directFetch(body: unknown, signal?: AbortSignal): Promise<Response> {
  const cfg = readStoredDirectConfig();
  if (!cfg) throw new Error('direct config missing');
  return fetch(`${cfg.baseURL.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(body),
    signal,
  });
}

/**
 * 中继请求。sessionId 供浏览器层取证插件（transcript-share netTap）按会话归因
 * API 调用轨迹——服务端不消费该 header，纯旁路标记，不改变请求行为。
 */
async function relayFetch(body: unknown, providerId: string, sessionId: string, signal?: AbortSignal): Promise<Response> {
  return fetch(RELAY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(sessionId && sessionId !== 'unknown' ? { 'X-Plite-Session': sessionId } : {}),
    },
    body: JSON.stringify({ providerId, body }),
    signal,
  });
}

/**
 * 独立档直连流（docs/mobile-app-plan.md §10.3）：SSE 解析与中继路径同构，
 * 但请求直发供应商（key 经 direct-config 下发，本地注入 Authorization）。
 * 工具编排（agent-loop）在宿主侧不可用——直连是纯聊天形态，工具调用不透传。
 */
async function streamDirect(
  payload: { prompt?: string; history?: { role: string; content: unknown }[] },
  sessionId: string,
  messageId: string,
  emit: (ev: { kind: string; payload: unknown }) => void,
): Promise<void> {
  const cfg = readStoredDirectConfig();
  if (!cfg) return; // 无本机直连配置：上游调用方已做降级提示
  const startedAt = Date.now();
  let wireUsage: WireUsage | null = null;
  let responseModel: string | undefined;

  let cancelled = false;
  const abort = new AbortController();
  const streamKey = `${sessionId}::${messageId}`;
  running.set(streamKey, () => { cancelled = true; abort.abort(); });

  try {
    const messages = [
      ...(payload.history ?? []).map((m) => ({ role: m.role as 'user' | 'assistant' | 'system', content: m.content })),
      { role: 'user' as const, content: payload.prompt ?? '' },
    ];
    const caps = cfg.models.find((m) => m.id === cfg.activeModel)?.capabilities ?? cfg.models[0]?.capabilities;
    const resp = await directFetch(
      {
        model: cfg.activeModel || cfg.models[0]?.id || '',
        stream: true,
        messages,
        max_tokens: caps?.maxOutputTokens && caps.maxOutputTokens > 0 ? caps.maxOutputTokens : DEFAULT_MAX_OUTPUT_TOKENS,
        ...(caps?.effort ? { reasoning_effort: caps.effort } : {}),
      },
      abort.signal,
    );
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      let msg = `HTTP ${resp.status}`;
      try {
        const j = JSON.parse(text);
        msg = j.error?.message ?? j.message ?? j.error ?? msg;
      } catch { /* 保留 HTTP 状态描述 */ }
      emit({ kind: 'stream.error', payload: { sessionId, messageId, message: `独立模式直连失败：${String(msg)}` } });
      return;
    }
    // SSE 解析（与中继路径同构：reasoning_content 思考流 + content 正文 + usage；
    // 断尾守卫同中继路径——没有 [DONE] 也没有 finish_reason 就是断流，不装正常）
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    const sse = createSseReader();
    let sawDoneMarker = false;
    let streamedChars = 0;
    for (;;) {
      if (cancelled) {
        emit({ kind: 'message.done', payload: { sessionId, messageId, interrupted: true } });
        return;
      }
      const { done, value } = await reader.read();
      if (done) break;
      for (const frame of sse.push(decoder.decode(value, { stream: true }))) {
        if (frame.done) { sawDoneMarker = true; continue; }
        const data = frame.data;
        if (!data) continue;
        try {
          const json = JSON.parse(data);
          const choice = json.choices?.[0];
          if (json.usage && typeof json.usage === 'object') wireUsage = json.usage as WireUsage;
          if (typeof json.model === 'string' && json.model) responseModel = json.model;
          const reasoning: string | undefined = choice?.delta?.reasoning_content;
          if (reasoning) emit({ kind: 'message.reasoning', payload: { sessionId, messageId, delta: reasoning } });
          const delta: string | undefined = choice?.delta?.content;
          if (delta) {
            streamedChars += delta.length;
            emit({ kind: 'message.delta', payload: { sessionId, messageId, delta } });
          }
          if (choice?.finish_reason) { sawDoneMarker = true; sse.markDone(); }
        } catch { /* 跳过不完整行 */ }
      }
    }
    if (!sawDoneMarker) {
      emit({
        kind: 'stream.error',
        payload: { sessionId, messageId, message: `独立模式直连流中断（已生成 ${streamedChars} 字，未收到完整结束标记）。` },
      });
      return;
    }
    emit({ kind: 'ai.usage', payload: buildUsagePayload({ sessionId, messageId, messages, wireUsage, model: responseModel, maxInputTokens: caps?.maxInputTokens, startedAt }) });
    emit({ kind: 'message.done', payload: { sessionId, messageId } });
  } catch (err) {
    if (cancelled) {
      emit({ kind: 'message.done', payload: { sessionId, messageId, interrupted: true } });
    } else {
      emit({
        kind: 'stream.error',
        payload: { sessionId, messageId, message: `独立模式直连不可达：${err instanceof Error ? err.message : String(err)}` },
      });
    }
  } finally {
    running.delete(streamKey);
  }
}

function pickProvider(): ActiveProvider | null {
  return currentProvider && currentProvider.enabled && currentProvider.hasKey ? currentProvider : null;
}

function activeCaps(provider: ActiveProvider): ModelCaps | undefined {
  return provider.models.find((m) => m.id === provider.activeModel)?.capabilities
    ?? provider.models[0]?.capabilities;
}

/** 能力表缺失时的输出上限兜底（思考模型的上游小默认值会高频触发 length 截断；
 *  严格网关若拒绝 8192 会走 400 自愈回填真实上限——见 relayPath classifyLimit） */
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

/** 拒绝 stream_options 的供应商方言（400 实测后拉黑，本会话不再发送） */
const streamOptionsBlocked = new Set<string>();



/** 运行时自愈回填（服务端 note-probe；失败静默——自愈是增益不是门槛） */
async function noteProbeLimits(providerId: string, modelId: string, patch: { maxOutputTokens?: number; maxInputTokens?: number }): Promise<void> {
  try {
    await fetch('/api/providers/note-probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ id: providerId, modelId, patch }),
    });
  } catch { /* 回填失败不影响本次请求 */ }
}

/** 自愈后同步内存供应商视图，让本次重试立刻用上修正值 */
function applyHealedCap(provider: ActiveProvider, patch: { maxOutputTokens?: number; maxInputTokens?: number }): void {
  const model = provider.models.find((m) => m.id === provider.activeModel) ?? provider.models[0];
  if (!model) return;
  const caps = { maxInputTokens: 0, maxOutputTokens: 0, effort: null as 'minimal' | 'low' | 'medium' | 'high' | null, vision: false, ...model.capabilities };
  if (patch.maxOutputTokens) caps.maxOutputTokens = patch.maxOutputTokens;
  if (patch.maxInputTokens) caps.maxInputTokens = patch.maxInputTokens;
  model.capabilities = caps;
}

/** 按供应商方言把能力字段拼进请求体（宁缺毋错传：未知字段不发送） */
function buildCapabilityParams(provider: ActiveProvider): Record<string, unknown> {
  const caps = activeCaps(provider);
  const out: Record<string, unknown> = {};
  // 输出上限：能力表权威（识别自动回填）；未知时给保守下限，不再让上游小默认值掐断回复
  out.max_tokens = caps && caps.maxOutputTokens > 0 ? caps.maxOutputTokens : DEFAULT_MAX_OUTPUT_TOKENS;
  if (caps?.effort) out.reasoning_effort = caps.effort;
  return out;
}

const streamHandler: StreamCapabilityHandler = async (req, emit) => {
  const payload = (req.payload ?? {}) as {
    sessionId?: string;
    messageId?: string;
    prompt?: string;
    history?: { role: string; content: unknown }[];
    attachments?: { name?: string; mime?: string; content?: string; textContent?: string }[];
    /**
     * agent-loop 直传的完整协议消息（含 assistant.tool_calls / tool 角色消息）。
     * 提供时忽略 prompt/history/attachments——引擎做纯管道，不理解工具语义。
     */
    messages?: { role: string; content: unknown; tool_calls?: unknown; tool_call_id?: string; name?: string }[];
    /** OpenAI function 工具定义（agent-loop 传入，透传给上游） */
    tools?: { type: 'function'; function: { name: string; description: string; parameters: unknown } }[];
    toolChoice?: 'auto' | 'none';
  };
  const sessionId = payload.sessionId ?? 'unknown';
  const messageId = payload.messageId ?? 'unknown';
  const streamKey = `${sessionId}::${messageId}`;

  // 兜底：流式调用前再刷一次配置（登录后/面板保存后的时序问题都能自愈）
  if (!pickProvider()) {
    try { await refreshProvider(); } catch { /* 下方统一报错 */ }
  }
  const provider = pickProvider();

  // ---- 独立档分支（standalone；docs/mobile-app-plan.md §10.3）----
  // 宿主不可达时中继/resolveActive 都不通：provider 恒空。此时读本机直连配置
  // （用户在连接档经「保存直连配置到本机」显式同意后存的），并实测供应商 CORS；
  // 不通则给结构化降级——「需连接电脑使用」，不假装可用、不裸抛网络错误。
  if (!hostReachable) {
    const cfg = readStoredDirectConfig();
    if (!cfg) {
      emit({
        kind: 'stream.error',
        payload: {
          sessionId, messageId,
          message: '独立模式：本机没有直连配置。请连接电脑后在「端点」面板点「保存直连配置到本机」，再离线使用。',
        },
      });
      return;
    }
    const corsOk = await probeDirectCors(cfg.baseURL);
    if (!corsOk) {
      emit({
        kind: 'stream.error',
        payload: {
          sessionId, messageId,
          message: `独立模式：该供应商（${new URL(cfg.baseURL).host}）不允许浏览器直连（CORS），需连接电脑后经中继使用。`,
        },
      });
      return;
    }
    await streamDirect(payload, sessionId, messageId, emit);
    return;
  }

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

  // usage 采集（spec §4.1）：流末帧 usage 是上下文水位与压缩触发的真相源；
  // 中断/出错路径数据不完整，不 emit（避免污染 agent-loop 的水位基准）。
  const startedAt = Date.now();
  let wireUsage: WireUsage | null = null;
  let responseModel: string | undefined;

  try {
    // agent-loop 直传协议消息时按原样透传（含 tool_calls / role:'tool'）；
    // 否则走常规 prompt+history 组装。二者互斥，直传路径不做附件拼装。
    const messages = payload.messages
      ? payload.messages.map((m) => ({
          role: m.role,
          content: m.content,
          ...(m.tool_calls !== undefined ? { tool_calls: m.tool_calls } : {}),
          ...(m.tool_call_id !== undefined ? { tool_call_id: m.tool_call_id } : {}),
          ...(m.name !== undefined ? { name: m.name } : {}),
        }))
      : [
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

    // 断流自动重试（2026-11-20「对话突然中断」修复）：上游/中继中途断流不再报错
    // 收敛——先在页面提示「正在重试 N/10」，把已生成正文作为尾随 assistant 消息
    // 喂回上游续写（OpenAI 兼容协议的标准续写形态，避免重生成造成正文重复），
    // 最多 10 次；全部失败才报错。此前中继吞错 + 引擎装正常结束，用户只看到
    // 「说到一半突然停、零报错」。
    const MAX_STREAM_RETRIES = 10;
    let attempt = 0;
    let carriedText = ''; // 跨尝试累积的正文（重试时喂回续写；UI 侧 delta 连续追加）
    let healRetried = false; // 400 自愈重试只做一次（方言守卫/限值回填）

    while (true) {
      attempt += 1;
      wireUsage = null;
      responseModel = undefined;
      // 续写形态：已生成半截回复时作为最后一条 assistant 消息喂回，模型自然接续；
      // 首试或断流时尚无正文时按原消息直发（模型从头生成，UI 无重复风险）。
      const attemptMessages = carriedText
        ? [...messages, { role: 'assistant' as const, content: carriedText }]
        : messages;

      const relayBody: Record<string, unknown> = {
        model: provider.activeModel || (provider.models[0]?.id ?? ''),
        stream: true,
        messages: attemptMessages,
        // 工具定义透传（agent-loop 编排；引擎不理解语义，仅管道）
        ...(payload.tools?.length ? { tools: payload.tools, tool_choice: payload.toolChoice ?? 'auto' } : {}),
        ...buildCapabilityParams(provider),
      };
      // usage 帧主动索取（被动校准与用量归因依赖真实 usage；方言拒绝时拉黑本会话不再发）
      if (!streamOptionsBlocked.has(provider.id)) relayBody.stream_options = { include_usage: true };

      const resp = await relayFetch(relayBody, provider.id, sessionId, abort.signal);

      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        let msg = `HTTP ${resp.status}`;
        try {
          const j = JSON.parse(text);
          msg = j.error?.message ?? j.message ?? j.error ?? msg;
        } catch { /* 保留 HTTP 状态描述 */ }
        if (resp.status === 401) msg = '登录已过期，请重新登录';
        // ---- 400 自愈（每请求一次）：方言守卫 + 限值回填 + 修正值重试 ----
        if (resp.status === 400 && !healRetried) {
          healRetried = true;
          if (/stream_options|include_usage/i.test(String(msg))) {
            streamOptionsBlocked.add(provider.id); // 老网关不认该字段：拉黑后重试
            continue;
          }
          const cls = classifyLimitError(String(msg));
          if (cls.kind === 'output' && cls.limit) {
            // 输出上限真实值揭示：回填能力表（服务端）+ 内存视图，修正值立即重试
            applyHealedCap(provider, { maxOutputTokens: cls.limit });
            void noteProbeLimits(provider.id, provider.activeModel, { maxOutputTokens: cls.limit });
            continue;
          }
          if (cls.kind === 'input' && cls.limit) {
            // 输入超限：本请求重试无意义（消息不会变小），但真实窗口回填后，
            // agent-loop 的压缩水位从此按正确分母工作
            applyHealedCap(provider, { maxInputTokens: cls.limit });
            void noteProbeLimits(provider.id, provider.activeModel, { maxInputTokens: cls.limit });
            msg = `上下文超限（输入超过该模型上限 ${cls.limit} tokens）：请开新会话或精简历史。`;
          }
        }
        emit({ kind: 'stream.error', payload: { sessionId, messageId, message: String(msg) } });
        return;
      }

      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();
      const sse = createSseReader();
      // 工具调用聚合：按 OpenAI 规范 delta.tool_calls 可能分片（index 维度拼接
      // id / function.name / function.arguments），也可能整块一次到齐（MOSI 实测）。
      // 每次尝试独立聚合——断流尝试的半截 tool_calls 不跨尝试拼接（协议不成对）。
      const toolAcc = new Map<number, { id: string; name: string; arguments: string }>();
      let finishReason = '';
      // 正常结束标记：data:[DONE] 或末帧 finish_reason（部分中转只发其一）。
      // 两者都没有、body 却结束 = 中途断流，进入重试。
      let sawDoneMarker = false;
      let broke = false;
      let attemptText = '';
      pump: for (;;) {
        if (cancelled) {
          emit({ kind: 'message.done', payload: { sessionId, messageId, interrupted: true } });
          return;
        }
        const { done, value } = await reader.read();
        if (done) break;
        for (const frame of sse.push(decoder.decode(value, { stream: true }))) {
          if (frame.done) { sawDoneMarker = true; continue; }
          const data = frame.data;
          if (!data) continue;
          try {
            const json = JSON.parse(data);
            // 中继注入的上游断流错误帧（relay-core 对 text/event-stream 追加）：
            // 进入重试流程，不装正常结束
            if (isUpstreamDisconnectFrame(json)) {
              broke = true;
              break pump;
            }
            const choice = json.choices?.[0];
            // usage：流式协议下通常在最后一个 data 帧（stream_options.include_usage）。
            // 逐帧覆盖，最后一条非空 usage 为准（兼容逐帧都带的供应商）。
            if (json.usage && typeof json.usage === 'object') wireUsage = json.usage as WireUsage;
            if (typeof json.model === 'string' && json.model) responseModel = json.model;
            // 推理模型的「思考流」：reasoning_content 是独立于 content 的增量。
            // 必须以 message.reasoning 转发（chat-lite 渲染为思考块），否则长思考期间
            // UI 全程静默，用户会误以为「不回复」（实测 nex-n2.6 思考 30s+ 无任何 content）。
            const reasoning: string | undefined = choice?.delta?.reasoning_content;
            if (reasoning) emit({ kind: 'message.reasoning', payload: { sessionId, messageId, delta: reasoning } });
            // 常规正文增量
            const delta: string | undefined = choice?.delta?.content;
            if (delta) {
              attemptText += delta;
              emit({ kind: 'message.delta', payload: { sessionId, messageId, delta } });
            }
            // 工具调用增量聚合（index 维度）
            aggregateToolCallDelta(toolAcc, choice?.delta?.tool_calls);
            if (choice?.finish_reason) { finishReason = String(choice.finish_reason); sawDoneMarker = true; sse.markDone(); }
          } catch { /* 跳过不完整行 */ }
        }
      }
      if (cancelled) {
        emit({ kind: 'message.done', payload: { sessionId, messageId, interrupted: true } });
        return;
      }
      if (!sawDoneMarker) broke = true; // 干净 EOF 但无结束标记：同样是中途断流

      if (!broke) {
        // 上游要求调用工具：聚合结果整体发出，由编排方（agent-loop）决策执行
        if (finishReason === 'tool_calls' && toolAcc.size > 0) {
          const toolCalls = [...toolAcc.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, v]) => ({ id: v.id, name: v.name, arguments: v.arguments }));
          emit({ kind: 'tool.calls', payload: { sessionId, messageId, toolCalls } });
        }
        // ai.usage：优先真实 usage；供应商不回时按本次 messages 估算兜底（estimated 标记）
        emit({ kind: 'ai.usage', payload: buildUsagePayload({ sessionId, messageId, messages: attemptMessages, wireUsage, model: responseModel, maxInputTokens: activeCaps(provider)?.maxInputTokens, startedAt }) });
        // length 截断时聚合中的半截 tool_calls 上报编排层（不再静默丢弃）：
        // 模型想调工具的意图是重要信号，编排层据此自动 nudge 重试
        const partialToolCalls = finishReason && finishReason !== 'tool_calls' ? toolAcc.size : 0;
        emit({
          kind: 'message.done',
          payload: {
            sessionId, messageId,
            ...(finishReason ? { finishReason } : {}),
            ...(partialToolCalls > 0 ? { partialToolCalls } : {}),
          },
        });
        return;
      }

      // 断流：累积正文 → 未达上限则页面提示后自动续写；达上限如实报错
      carriedText += attemptText;
      if (attempt >= MAX_STREAM_RETRIES) {
        emit({
          kind: 'stream.error',
          payload: {
            sessionId, messageId,
            message: `上游连接反复中断（已自动重试 ${MAX_STREAM_RETRIES} 次，共生成 ${carriedText.length} 字）。请检查网络后重试，或换个模型。`,
          },
        });
        return;
      }
      emit({
        kind: 'stream.retry',
        payload: { sessionId, messageId, attempt, maxAttempts: MAX_STREAM_RETRIES, chars: carriedText.length },
      });
      // 小退避：避免对上游连环重击（500ms × 已试次数，封顶 4.5s）
      await new Promise((r) => setTimeout(r, Math.min(500 * attempt, 4500)));
      if (cancelled) {
        emit({ kind: 'message.done', payload: { sessionId, messageId, interrupted: true } });
        return;
      }
    }
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
    version: '0.4.0',
    capabilities: ['cap.model.admin'],
    /** 依赖供应商管理：装配顺序由声明驱动（面板先于引擎） */
    requires: ['cap.model.admin'],
    // mode-changed：standalone-mode 的运行模式广播（独立档切直连，docs/mobile-app-plan.md §10.3）
    events: ['model-config-changed', 'auth-changed', 'mode-changed'],
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

    // 独立档切换（docs/mobile-app-plan.md §10.3）：只切模式标记——直连配置是
    // 用户显式同意后存的 localStorage 副本，不随模式自动拉取/清除（清除走
    // 面板按钮或登出）。连接档聊天永远走中继（服务端 key），独立档才读本机副本。
    api.listen('mode-changed', (payload) => {
      const p = payload as { status?: string } | null;
      if (p?.status === 'standalone') hostReachable = false;
      else if (p?.status === 'connected') hostReachable = true;
    });

    // 启动尝试一次（若尚未登录会失败，登录后由 auth-changed 补上）
    void refresh();
    // 面板保存时也会直接广播，这里不额外轮询：避免未登录空转

    api.registerCapability.registerStreaming('cap.ai.chat', streamHandler);
    api.registerCapability.register('cap.ai.chat.interrupt', interruptHandler);

    // 独立档配置操作桥（standalone-mode 面板按钮调用；同 CHANNEL_FILE_BROWSER_COMPOSE(@sdk) 先例：
    // 经受限 window 通道而非跨插件 cap——这是「数据搬运动作」而非可声明能力）
    (window as unknown as Record<string, unknown>)[CHANNEL_REAL_ENGINE_DIRECT] = {
      /** 用户显式同意：拉当前供应商直连配置存本机 localStorage */
      save: fetchAndStoreDirectConfig,
      /** 清除本机直连配置 */
      clear: clearStoredDirectConfig,
      /** 本机是否已有直连配置（面板状态显示） */
      has: () => readStoredDirectConfig() !== null,
    };
  },
};

export default realEnginePlugin;
