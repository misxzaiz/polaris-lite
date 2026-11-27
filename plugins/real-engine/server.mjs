/**
 * real-engine 的服务端适配器（引擎 server 半边）。
 *
 * 职责：把「real 引擎如何调用上游模型」的领域知识留在引擎插件内部——
 * resolveModel（读 provider store）/ runTurn（undici 流式 + 断流续写 + tool_call 聚合）/
 * complete（非流式，压缩摘要用）/ contextWindow（能力表窗口）。
 *
 * agent-runner 只按 engineId 查注册表拿到本适配器并调用这四个方法，**不认识任何
 * 供应商 / 端点 / 方言**——这是「引擎皆插件」在服务端执行域的落地，与前端
 * cap.ai.chat.<id> 命名空间对称。
 *
 * 这里刻意不产生 HTTP 端点（real 引擎的浏览器侧走宿主 /api/model-relay）；
 * createServerPart 仅注册适配器并返回 passthrough 中间件。
 */
import { Agent, fetch as undiciFetch } from 'undici';

const UPSTREAM_TIMEOUT_MS = 30 * 60 * 1000;
const upstreamAgent = new Agent({ headersTimeout: UPSTREAM_TIMEOUT_MS, bodyTimeout: UPSTREAM_TIMEOUT_MS });
const MAX_STREAM_RETRIES = 10;
const DEFAULT_CONTEXT_WINDOW = 200_000;

export function createServerPart(options = {}) {
  const store = options.store;
  const registry = options.registry;

  /** 供应商解析（原 runner.resolveProvider）：providerId 命中优先，否则 active。 */
  function resolveModel(modelRef = {}) {
    const list = store?.list?.() ?? [];
    let provider = modelRef.providerId ? list.find((c) => c.id === modelRef.providerId) : null;
    if (!provider) provider = store?.getActive?.() ?? null;
    if (!provider || provider.enabled === false || !provider.apiKey) return null;
    const activeModel = modelRef.modelId && (provider.models ?? []).some((m) => m.id === modelRef.modelId)
      ? modelRef.modelId
      : (provider.activeModel || provider.models?.[0]?.id || '');
    return { provider, activeModel };
  }

  function buildCapabilityParams(model) {
    const provider = model.provider;
    const caps = (provider.models ?? []).find((m) => m.id === provider.activeModel)?.capabilities
      ?? provider.models?.[0]?.capabilities;
    const out = {};
    out.max_tokens = caps && caps.maxOutputTokens > 0 ? caps.maxOutputTokens : 8192;
    if (caps?.effort) out.reasoning_effort = caps.effort;
    return out;
  }

  /**
   * 流式一轮（原 runner.engineTurn）：调 OpenAI 兼容 /chat/completions，
   * 聚合 delta/reasoning/tool_calls，断流自动续写。
   * 返回 { text, toolCalls, finishReason, partialToolCalls, usage, lastUsage }。
   */
  async function runTurn({ model, messages, tools, signal, onDelta, onReasoning, onRetry, onToolArgsDelta }) {
    let carriedText = '';
    let wireUsage = null;
    for (let attempt = 1; attempt <= MAX_STREAM_RETRIES; attempt += 1) {
      const attemptMessages = carriedText ? [...messages, { role: 'assistant', content: carriedText }] : messages;
      const body = {
        model: model.activeModel,
        stream: true,
        messages: attemptMessages,
        ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
        ...buildCapabilityParams(model),
        stream_options: { include_usage: true },
      };
      const resp = await undiciFetch(`${model.provider.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${model.provider.apiKey}` },
        body: JSON.stringify(body),
        redirect: 'manual',
        signal,
        dispatcher: upstreamAgent,
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        let msg = `HTTP ${resp.status}`;
        try { const j = JSON.parse(text); msg = j.error?.message ?? j.message ?? j.error ?? msg; } catch { /* 保留状态描述 */ }
        throw new Error(String(msg));
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      const toolAcc = new Map();
      let finishReason = '';
      let sawDone = false;
      let broke = false;
      let attemptText = '';
      let sawUsage = false;
      pump: for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (!data) continue;
          if (data === '[DONE]') { sawDone = true; continue; }
          let json;
          try { json = JSON.parse(data); } catch { continue; }
          if (json?.error?.code === 'UPSTREAM_DISCONNECTED') { broke = true; break pump; }
          if (json.usage && typeof json.usage === 'object') { wireUsage = json.usage; sawUsage = true; }
          const choice = json.choices?.[0];
          const reasoning = choice?.delta?.reasoning_content;
          if (reasoning) onReasoning?.(reasoning);
          const delta = choice?.delta?.content;
          if (delta) { attemptText += delta; onDelta?.(delta); }
          if (Array.isArray(choice?.delta?.tool_calls)) {
            for (const tc of choice.delta.tool_calls) {
              const idx = Number(tc?.index ?? 0);
              const slot = toolAcc.get(idx) ?? { id: '', name: '', arguments: '' };
              if (tc.id) slot.id = slot.id || String(tc.id);
              if (tc.function?.name) slot.name += String(tc.function.name);
              if (tc.function?.arguments) slot.arguments += String(tc.function.arguments);
              toolAcc.set(idx, slot);
              // 参数增量透传（流式预览数据源）：id 先到才发（无法定位 callId 的帧跳过）
              if (tc.function?.arguments && slot.id) onToolArgsDelta?.(slot.id, String(tc.function.arguments));
            }
          }
          if (choice?.finish_reason) { finishReason = String(choice.finish_reason); sawDone = true; }
        }
      }
      if (!sawDone) broke = true;
      if (!broke) {
        const toolCalls = finishReason === 'tool_calls' && toolAcc.size > 0
          ? [...toolAcc.entries()].sort(([a], [b]) => a - b).map(([, v]) => ({ id: v.id, name: v.name, arguments: v.arguments }))
          : [];
        const partialToolCalls = finishReason && finishReason !== 'tool_calls' ? toolAcc.size : 0;
        const usage = wireUsage && sawUsage ? wireUsage : null;
        return { text: attemptText, toolCalls, finishReason, partialToolCalls, usage, lastUsage: usage };
      }
      carriedText += attemptText;
      if (attempt >= MAX_STREAM_RETRIES) {
        throw new Error(`上游连接反复中断（已自动重试 ${MAX_STREAM_RETRIES} 次，共生成 ${carriedText.length} 字）`);
      }
      onRetry?.(attempt, MAX_STREAM_RETRIES);
      await new Promise((r) => setTimeout(r, Math.min(500 * attempt, 4500)));
      if (signal?.aborted) throw new Error('INTERRUPTED');
    }
    throw new Error('unreachable');
  }

  /** 非流式补全（压缩摘要；key 不出服务端，不进 shadow）。 */
  async function complete({ model, system, user, maxTokens, signal }) {
    const body = { model: model.activeModel, stream: false, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: maxTokens };
    const resp = await undiciFetch(`${model.provider.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${model.provider.apiKey}` },
      body: JSON.stringify(body),
      dispatcher: upstreamAgent,
      ...(signal ? { signal } : {}),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`compact HTTP ${resp.status}: ${text.slice(0, 160)}`);
    }
    const json = await resp.json().catch(() => null);
    const choice = json?.choices?.[0];
    let text = '';
    const content = choice?.message?.content;
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) text = content.map((p) => p?.text ?? '').join('');
    const truncated = choice?.finish_reason === 'length'
      || (!text.trim() && (choice?.message?.reasoning !== undefined || choice?.message?.reasoning_content !== undefined));
    return { text, truncated };
  }

  function contextWindow(model) {
    if (!model) return DEFAULT_CONTEXT_WINDOW;
    const caps = (model.provider.models ?? []).find((m) => m.id === model.activeModel)?.capabilities
      ?? model.provider.models?.[0]?.capabilities;
    const win = Number(caps?.maxInputTokens ?? 0);
    return Number.isFinite(win) && win > 0 ? win : DEFAULT_CONTEXT_WINDOW;
  }

  registry?.registerEngine({
    id: 'real',
    kind: 'chat',
    default: true,
    resolveModel,
    runTurn,
    complete,
    contextWindow,
  });

  // real 引擎无自有 HTTP 端点；返回 passthrough 中间件。
  return (req, res, next) => next?.();
}
