/**
 * agent-loop 插件：AI 对话编排器（模型与工具的循环调用）。
 *
 * 职责：
 * - 聚合工具描述（cap.tool.* /describe + tool-registered 事件）→ 组装 OpenAI tools 数组；
 * - 流式编排：cap.ai.chat 带 tools → 收 tool_calls → 审批 → cap.tool.* 执行 →
 *   结果以 role:'tool' 喂回 → 循环到 finish_reason=stop 或上限；
 * - 审批：confirm 模式出 tool.approval.required 事件，chat-lite 渲染审批卡，
 *   resolveApproval 动作回填决策；120s 超时=拒绝；
 * - 中断：interrupt 动作杀引擎流 + abort 在途 exec + 挂起审批按 deny 收敛；
 * - shadow transcript：每会话自持协议消息数组（含 tool 消息），刷新后由可见历史重新播种。
 *
 * 事件（经宿主镜像到 cap.agent.loop:event，source='agent-loop' 宿主注入不可伪造）：
 * message.delta/done/stream.error（转发）、tool.card/tool.result/tool.approval.required/
 * tool.approval.resolved/loop.done。
 *
 * 边界：无工具注册时进入直通模式（start 原样透传 cap.ai.chat，自身不监听不转发）。
 */
import type { CapabilityHandler, LitePlugin, SlotHostApi, StreamCapabilityHandler } from '@sdk';

// 轮次/工具调用数量上限：应用户要求移除（曾为 8 轮 / 16 次）——任务时长靠用户
// 「停止」即时收敛与单条命令超时兜底。
const APPROVAL_TIMEOUT_MS = 120_000;
/** 喂回模型的工具结果截断（上下文防爆） */
const FEEDBACK_CAP = 8 * 1024;

interface ToolCallProto {
  id: string;
  name: string;
  arguments: string;
}
interface ToolDescriptorProto {
  cap: string;
  name: string;
  description: string;
  parameters: unknown;
  danger: 'read' | 'write' | 'execute';
}
interface ShadowMsg {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  name?: string;
}
interface EngineEvent {
  kind: string;
  payload?: {
    sessionId?: string;
    messageId?: string;
    delta?: string;
    message?: string;
    interrupted?: boolean;
    finishReason?: string;
    toolCalls?: ToolCallProto[];
  };
}

const shadows = new Map<string, ShadowMsg[]>();
const running = new Map<string, () => void>();
const tools = new Map<string, ToolDescriptorProto>();
/** callId → resolve(decision)；confirm 模式挂起点 */
const pendingApprovals = new Map<string, (d: 'once' | 'always' | 'deny') => void>();
/** 会话在途 exec 的 callId（中断时用于立即回执工具卡） */
const inFlightExec = new Map<string, string>();
/** sessionId → 会话级「总是允许」前缀（内存；持久化在服务端白名单） */
const sessionAllow = new Map<string, Set<string>>();
/** 会话级信任工具集（审批卡「本会话信任」沉淀；内存态，不跨会话不持久化） */
const sessionTrustedTools = new Map<string, Set<string>>();

let hostApi: SlotHostApi | null = null;

function emitTo(emit: (ev: { kind: string; payload: unknown }) => void, kind: string, payload: Record<string, unknown>): void {
  emit({ kind, payload });
}

/** 截断喂回模型的工具结果（保头尾） */
function capText(text: string, cap = FEEDBACK_CAP): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap / 2)}\n…[输出过长已截断 ${text.length}B]…\n${text.slice(-cap / 2)}`;
}

/** 发现工具：主动拉取（cap.meta/list 过滤 cap.tool.* → /describe） */
async function discoverTools(): Promise<void> {
  if (!hostApi) return;
  try {
    const res = await hostApi.dispatch<{ capabilities?: string[] }>({ target: 'cap.meta', action: 'list' });
    const caps = (res.data?.capabilities ?? []).filter((c) => c.startsWith('cap.tool.'));
    for (const cap of caps) {
      const r = await hostApi.dispatch<{ descriptor?: ToolDescriptorProto }>({ target: cap, action: 'describe' });
      const d = r.data?.descriptor;
      if (d?.name) tools.set(d.name, d);
    }
  } catch { /* cap.meta 不可用：靠 tool-registered 事件兜底 */ }
}

/** 审批裁决：返回 null=放行；字符串=拒绝原因 */
async function decideApproval(
  sessionId: string,
  callId: string,
  call: ToolCallProto,
  command: string,
  emit: (ev: { kind: string; payload: unknown }) => void,
  assistantId: string,
  aborted: () => boolean,
): Promise<'ok' | 'deny'> {
  // 取服务端配置（confirm/allowlist/yolo 由服务端最终裁决，这里只做「是否需要问用户」）
  let mode = 'confirm';
  try {
    const resp = await fetch('/api/tool/config', { credentials: 'include' });
    if (resp.ok) mode = ((await resp.json()) as { mode?: string }).mode ?? 'confirm';
  } catch { /* 配置不可达：按 confirm 处理（宁紧勿松） */ }

  if (mode === 'yolo') return 'ok';
  // 会话级信任工具（审批卡「本会话信任」沉淀）：命中直接放行
  const trusted = sessionTrustedTools.get(sessionId);
  if (trusted?.has(call.name)) return 'ok';
  const allow = sessionAllow.get(sessionId);
  if (allow && [...allow].some((p) => command === p || command.startsWith(`${p} `))) return 'ok';
  // allowlist 模式：本地未命中白名单仍进审批（服务端白名单由「总是允许」沉淀，服务端最终裁决）

  emitTo(emit, 'tool.approval.required', { sessionId, messageId: assistantId, callId, name: call.name, command });
  const decision = await new Promise<'once' | 'always' | 'trust' | 'deny'>((resolve) => {
    pendingApprovals.set(callId, resolve);
    setTimeout(() => {
      if (pendingApprovals.has(callId)) {
        pendingApprovals.delete(callId);
        resolve('deny');
      }
    }, APPROVAL_TIMEOUT_MS);
  });
  pendingApprovals.delete(callId);
  emitTo(emit, 'tool.approval.resolved', { sessionId, messageId: assistantId, callId, decision });
  if (aborted() || decision === 'deny') return 'deny';
  if (decision === 'always') {
    const set = sessionAllow.get(sessionId) ?? new Set<string>();
    set.add(command);
    sessionAllow.set(sessionId, set);
    // 持久化到服务端白名单（下次会话也放行该前缀）
    void fetch('/api/tool/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ addPrefix: command }),
    }).catch(() => undefined);
    return 'ok';
  }
  if (decision === 'trust') {
    // 会话级信任本工具：后续该工具调用不再审批（内存态，不持久化、不跨会话）
    const set = sessionTrustedTools.get(sessionId) ?? new Set<string>();
    set.add(call.name);
    sessionTrustedTools.set(sessionId, set);
    return 'ok';
  }
  return 'ok'; // once
}

/** 引擎流一轮：返回 {text, toolCalls, finishReason} 或抛错；onDelta 实时转发可见增量（流式 UX） */
function engineTurn(
  sessionId: string,
  turnMessageId: string,
  messages: ShadowMsg[],
  toolDefs: { type: 'function'; function: { name: string; description: string; parameters: unknown } }[],
  onDelta?: (delta: string) => void,
): { promise: Promise<{ text: string; toolCalls: ToolCallProto[]; finishReason: string }>; cancel: () => void } {
  let off: (() => void) | undefined;
  const promise = new Promise<{ text: string; toolCalls: ToolCallProto[]; finishReason: string }>((resolve, reject) => {
    if (!hostApi) return reject(new Error('host api missing'));
    let text = '';
    let toolCalls: ToolCallProto[] = [];
    let finishReason = '';
    let done = false;
    off = hostApi.listen('cap.ai.chat:event', (payload) => {
      const ev = payload as EngineEvent;
      // 注意：这里收的是引擎（real-engine）的事件，tool.calls 是引擎发的工具调用
      // 结果，必须消费；loop 自身事件走 cap.agent.loop:event，不会出现在本通道。
      const inner = ev.payload ?? {};
      if (inner.sessionId && inner.sessionId !== sessionId) return;
      if (inner.messageId && inner.messageId !== turnMessageId) return;
      if (ev.kind === 'message.delta' && inner.delta) {
        text += inner.delta;
        onDelta?.(inner.delta); // 实时转发（UI 流式渲染；同时喂 chat-lite 看门狗）
      } else if (ev.kind === 'tool.calls' && inner.toolCalls) {
        toolCalls = inner.toolCalls;
        finishReason = 'tool_calls';
      } else if (ev.kind === 'message.done') {
        if (inner.interrupted) {
          if (!done) { done = true; off?.(); reject(new Error('INTERRUPTED')); }
          return;
        }
        if (inner.finishReason) finishReason = inner.finishReason;
        if (!done) { done = true; off?.(); resolve({ text, toolCalls, finishReason }); }
      } else if (ev.kind === 'stream.error') {
        if (!done) { done = true; off?.(); reject(new Error(inner.message ?? 'stream error')); }
      }
    });
    void hostApi.dispatch({
      target: 'cap.ai.chat',
      action: 'start',
      payload: {
        sessionId,
        messageId: turnMessageId,
        messages,
        ...(toolDefs.length > 0 ? { tools: toolDefs } : {}),
      },
    });
  });
  return {
    promise,
    cancel: () => {
      void hostApi?.dispatch({ target: 'cap.ai.chat.interrupt', action: 'interrupt', payload: { sessionId, messageId: turnMessageId } });
      off?.();
    },
  };
}

const loopHandler: StreamCapabilityHandler = async (req, emit) => {
  // 动作在 req.action（CapRequest 顶层），不在 payload——此前误读 payload.action
  // 导致 resolveApproval/interrupt 全部落空、resolveApproval 还会掉进主循环跑空轮次（上游 400）
  const action = req.action;
  const payload = (req.payload ?? {}) as {
    sessionId?: string;
    messageId?: string;
    callId?: string;
    decision?: 'once' | 'always' | 'deny';
    prompt?: string;
    history?: { role: string; content: string }[];
  };
  const sessionId = payload.sessionId ?? 'unknown';

  // ---- 审批回填 / 中断：非 start 动作直接处理，绝不进入主循环 ----
  if (action === 'resolveApproval') {
    const resolve = payload.callId ? pendingApprovals.get(payload.callId) : undefined;
    resolve?.(payload.decision ?? 'deny');
    return;
  }
  if (action === 'interrupt') {
    const cancel = running.get(sessionId);
    const found = !!cancel;
    cancel?.();
    running.delete(sessionId);
    // 立即收敛 UI：中断回执 + 在途工具卡置为已中断（在途服务端 exec 由其 timeout 兜底回收）
    const inFlight = inFlightExec.get(sessionId);
    if (inFlight && payload.messageId) {
      emitTo(emit, 'tool.result', {
        sessionId, messageId: payload.messageId, callId: inFlight,
        status: 'error', stderr: '已被用户中断',
      });
      inFlightExec.delete(sessionId);
    }
    if (payload.messageId) {
      emitTo(emit, 'message.done', { sessionId, messageId: payload.messageId, interrupted: true });
    }
    return { ok: true, found };
  }
  if (action && action !== 'start') return; // 未知动作不进主循环

  const assistantId = payload.messageId ?? 'unknown';
  const prompt = payload.prompt ?? '';
  let abortedFlag = false;
  const aborted = () => abortedFlag;
  running.set(sessionId, () => {
    abortedFlag = true;
    // 挂起的审批按 deny 收敛（否则 Promise 永悬）；在途 exec 由服务端 timeout 兜底杀树
    for (const [callId, resolve] of [...pendingApprovals.entries()]) {
      pendingApprovals.delete(callId);
      resolve('deny');
    }
    running.get(`${sessionId}::turn`)?.();
  });

  try {
    if (!hostApi) throw new Error('host api missing');
    await discoverTools();
    const toolDefs = [...tools.values()].map((d) => ({
      type: 'function' as const,
      function: { name: d.name, description: d.description, parameters: d.parameters },
    }));

    // 无工具：直通模式（start 原样透传 cap.ai.chat；引擎事件直达 chat-lite）。
    // interrupt 语义：注册取消柄，中断时向引擎转发 interrupt——否则直通流无法被「停止」打断。
    if (toolDefs.length === 0) {
      running.set(sessionId, () => {
        void hostApi.dispatch({
          target: 'cap.ai.chat.interrupt',
          action: 'interrupt',
          payload: { sessionId },
        }).catch(() => undefined);
      });
      try {
        await hostApi.dispatch({
          target: 'cap.ai.chat',
          action: 'start',
          payload: {
            sessionId,
            messageId: assistantId,
            prompt,
            history: payload.history ?? [],
          },
        });
      } finally {
        running.delete(sessionId);
      }
      return; // chat-lite 由 cap.ai.chat:event 收敛；loop.done 不发（直通无编排语义）
    }

    // ---- shadow transcript 播种/续用 ----
    let shadow = shadows.get(sessionId);
    if (!shadow) {
      shadow = [
        {
          role: 'system',
          content:
            '你是 polaris-lite 工作台里的 AI 助手，可以使用 bash 工具在工作区执行命令。' +
            `当前宿主平台：${navigator.platform || 'unknown'}；工作区是你的默认 cwd。` +
            '需要读写文件、跑脚本、查状态时优先用工具，不要凭空编造输出；' +
            '命令要一次做完一件事；输出很长时先自己截取关键部分再回答。',
        },
        ...(payload.history ?? []).map((m) => ({ role: m.role as ShadowMsg['role'], content: m.content })),
      ];
      shadows.set(sessionId, shadow);
    }
    shadow.push({ role: 'user', content: prompt });

    let turn = 0;
    let totalToolCalls = 0;
    for (; !abortedFlag; turn += 1) {
      const turnMessageId = `${assistantId}::t${turn}`;
      // onDelta：引擎可见增量实时转发（messageId=assistantId，chat-lite 流式渲染）
      const t = engineTurn(sessionId, turnMessageId, shadow, toolDefs, (delta) => {
        emitTo(emit, 'message.delta', { sessionId, messageId: assistantId, delta });
      });
      running.set(`${sessionId}::turn`, t.cancel);
      let result: { text: string; toolCalls: ToolCallProto[]; finishReason: string };
      try {
        result = await t.promise;
      } catch (err) {
        running.delete(`${sessionId}::turn`);
        if (abortedFlag) {
          emitTo(emit, 'message.done', { sessionId, messageId: assistantId, interrupted: true });
          return;
        }
        emitTo(emit, 'stream.error', { sessionId, messageId: assistantId, message: err instanceof Error ? err.message : String(err) });
        return;
      }
      running.delete(`${sessionId}::turn`);

      if (result.finishReason !== 'tool_calls' || result.toolCalls.length === 0) {
        shadow.push({ role: 'assistant', content: result.text });
        break;
      }

      // 记录 assistant 的 tool_calls 消息（协议要求成对）
      shadow.push({
        role: 'assistant',
        content: result.text,
        tool_calls: result.toolCalls.map((c) => ({
          id: c.id,
          type: 'function' as const,
          function: { name: c.name, arguments: c.arguments },
        })),
      });

      emitTo(emit, 'tool.calls', { sessionId, messageId: assistantId, turn, toolCalls: result.toolCalls });

      // 逐个执行：审批 → cap.tool.* → 结果卡 + shadow
      for (const call of result.toolCalls) {
        totalToolCalls += 1;
        const desc = tools.get(call.name);
        const callId = call.id || `call-${turn}-${totalToolCalls}`;
        let command = '';
        try {
          const parsed = JSON.parse(call.arguments || '{}') as Record<string, unknown>;
          command = String(parsed.command ?? '');
        } catch { command = ''; }
        emitTo(emit, 'tool.card', {
          sessionId, messageId: assistantId, callId,
          name: call.name, command, argsJson: call.arguments,
        });

        if (!desc) {
          const msg = `工具 ${call.name} 未注册`;
          emitTo(emit, 'tool.result', { sessionId, messageId: assistantId, callId, status: 'error', stderr: msg });
          shadow.push({ role: 'tool', content: `[工具执行失败] ${msg}`, tool_call_id: call.id, name: call.name });
          continue;
        }

        // 审批（confirm/allowlist 模式且未在会话级白名单）
        const verdict = await decideApproval(sessionId, callId, call, command, emit, assistantId, aborted);
        if (verdict === 'deny') {
          emitTo(emit, 'tool.result', { sessionId, messageId: assistantId, callId, status: 'denied', command });
          shadow.push({ role: 'tool', content: '[工具被用户拒绝执行。请尊重用户决定，改用其他方式或直接回答。]', tool_call_id: call.id, name: call.name });
          continue;
        }

        // 执行（经工具插件的 cap；approved 标记供服务端二次校验）
        inFlightExec.set(sessionId, callId);
        let exec: { ok: boolean; stdout?: string; stderr?: string; exitCode?: number; durationMs?: number; truncated?: boolean; error?: string; denied?: boolean };
        try {
          const res = await hostApi.dispatch<{ ok: boolean; stdout?: string; stderr?: string; exitCode?: number; durationMs?: number; truncated?: boolean; error?: string; denied?: boolean }>({
            target: desc.cap,
            action: 'exec',
            payload: { ...safeArgs(call.arguments), sessionId, approved: true },
          });
          exec = res.data ?? { ok: false, error: 'empty response' };
        } catch (err) {
          exec = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
        inFlightExec.delete(sessionId);
        if (abortedFlag) {
          emitTo(emit, 'message.done', { sessionId, messageId: assistantId, interrupted: true });
          return;
        }

        const status = exec.ok && exec.exitCode === 0 ? 'done' : exec.denied ? 'denied' : 'error';
        emitTo(emit, 'tool.result', {
          sessionId, messageId: assistantId, callId, status,
          command,
          stdout: capText(String(exec.stdout ?? '')),
          stderr: capText(String(exec.stderr ?? '')),
          exitCode: exec.exitCode, durationMs: exec.durationMs, truncated: exec.truncated,
        });
        const feedback = exec.ok
          ? `[bash 执行完成 exit=${exec.exitCode ?? '?'} ${exec.durationMs ?? '?'}ms]\nSTDOUT:\n${capText(String(exec.stdout ?? '') || '(空)')}\nSTDERR:\n${capText(String(exec.stderr ?? '') || '(空)')}`
          : `[工具执行失败] ${exec.error ?? `exit=${exec.exitCode}`}\nSTDERR:\n${capText(String(exec.stderr ?? ''))}`;
        shadow.push({ role: 'tool', content: feedback, tool_call_id: call.id, name: call.name });
      }
      // 下一轮：shadow 最后一条是 tool 结果，继续循环
    }

    if (abortedFlag) {
      emitTo(emit, 'message.done', { sessionId, messageId: assistantId, interrupted: true });
      return;
    }
    emitTo(emit, 'loop.done', { sessionId, messageId: assistantId, turns: turn });
    emitTo(emit, 'message.done', { sessionId, messageId: assistantId, finishReason: 'stop' });
  } catch (err) {
    emitTo(emit, 'stream.error', {
      sessionId,
      messageId: assistantId,
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    running.delete(sessionId);
    running.delete(`${sessionId}::turn`);
  }
};

/** 安全解析工具参数（只透传 command/timeoutMs，防参数注入面扩张） */
function safeArgs(raw: string): { command?: string; timeoutMs?: number } {
  try {
    const p = JSON.parse(raw || '{}') as Record<string, unknown>;
    return {
      ...(p.command !== undefined ? { command: String(p.command) } : {}),
      ...(p.timeoutMs !== undefined ? { timeoutMs: Number(p.timeoutMs) } : {}),
    };
  } catch {
    return {};
  }
}

export const agentLoopPlugin: LitePlugin = {
  manifest: {
    id: 'agent-loop',
    name: 'Agent 循环',
    version: '0.1.0',
    capabilities: ['cap.ai.chat', 'cap.ai.chat.interrupt', 'cap.tool.bash', 'cap.meta'],
    requires: ['cap.ai.chat', 'cap.tool.bash'],
    provides: ['cap.agent.loop'],
    events: ['cap.ai.chat:event', 'tool-registered'],
    contributes: { slots: [] },
  },
  setup(api: SlotHostApi) {
    hostApi = api;
    api.registerCapability.registerStreaming('cap.agent.loop', loopHandler);
    // 迟到的工具注册（loop 先于工具装配时的兜底；主路径是启动时主动拉取）
    api.listen('tool-registered', () => void discoverTools());
    void discoverTools();
  },
};

export default agentLoopPlugin;
