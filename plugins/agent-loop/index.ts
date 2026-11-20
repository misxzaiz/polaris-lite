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
import type { LitePlugin, SlotHostApi, StreamCapabilityHandler } from '@sdk';
import {
  UsageAccumulator, estimateTokens, compactShadow,
  type NonStreamComplete, type UsageSample,
} from './context-compact';

// 轮次/工具调用数量上限：应用户要求移除（曾为 8 轮 / 16 次）——任务时长靠用户
// 「停止」即时收敛与单条命令超时兜底。
const APPROVAL_TIMEOUT_MS = 120_000;
/** 喂回模型的工具结果截断（上下文防爆） */
const FEEDBACK_CAP = 8 * 1024;

/** 上下文压缩默认策略（chat-lite 可按会话覆盖，spec §4.3） */
const DEFAULT_CTX_POLICY = { autoCompact: true, threshold: 0.75, keepRecent: 6 };
/** 上下文窗口默认值（模型能力表缺失时；与 simple_ai DEFAULT_CONTEXT_WINDOW 对齐） */
const DEFAULT_CONTEXT_WINDOW = 200_000;

/** 会话级上下文策略（chat-lite send payload.ctxPolicy 透传） */
interface CtxPolicy {
  autoCompact?: boolean;
  threshold?: number;
  keepRecent?: number;
}

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
const pendingApprovals = new Map<string, (d: 'once' | 'always' | 'trust' | 'deny') => void>();
/** 会话在途 exec 的 callId（中断时用于立即回执工具卡） */
const inFlightExec = new Map<string, string>();
/** sessionId → 会话级「总是允许」前缀（内存；持久化在服务端白名单） */
const sessionAllow = new Map<string, Set<string>>();
/** 会话级信任工具集（审批卡「本会话信任」沉淀；内存态，不跨会话不持久化） */
const sessionTrustedTools = new Map<string, Set<string>>();
/** 全局 activeRoot（file-browser 树上点「工作区」即全局切换；会话未显式绑定时跟随它） */
const globalActive = new Map<string, string>(); // rootId -> path
/** sessionId → 上下文用量（真实 usage 优先，字符估算兜底；压缩触发基准） */
const usageAcc = new Map<string, UsageAccumulator>();
/** sessionId → 最近一轮 ai.usage（速率/详情展示；chat-lite 消费） */
const lastUsage = new Map<string, UsageSample & { totalTokens?: number; model?: string; contextWindow?: number; estimated?: boolean }>();
/** sessionId → 会话级上下文策略（chat-lite 每次发送时透传） */
const ctxPolicies = new Map<string, CtxPolicy>();
/** sessionId → 模型能力表窗口（ai.usage.contextWindow；压缩窗口优先级高于默认值） */
const ctxWindows = new Map<string, number>();
/** 压缩中标记（防同会话并发触发两次压缩） */
const compacting = new Set<string>();

let hostApi: SlotHostApi | null = null;

/** 引擎事件里的 ai.usage 载荷（real-engine 发出，spec §4.1） */
interface AiUsageEvent {
  kind: string;
  payload?: {
    sessionId?: string;
    messageId?: string;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    durationMs?: number;
    model?: string;
    contextWindow?: number;
    estimated?: boolean;
  };
}

function emitTo(emit: (ev: { kind: string; payload: unknown }) => void, kind: string, payload: Record<string, unknown>): void {
  emit({ kind, payload });
}

/** 截断喂回模型的工具结果（保头尾） */
function capText(text: string, cap = FEEDBACK_CAP): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap / 2)}\n…[输出过长已截断 ${text.length}B]…\n${text.slice(-cap / 2)}`;
}

/** 发现工具：主动拉取（cap.meta/list 过滤 cap.tool.* → /describe；
 *  另拉 cap.interactive——交互卡不走 cap.tool.* 前缀但同按 describe 约定提供描述） */
async function discoverTools(): Promise<void> {
  if (!hostApi) return;
  try {
    const res = await hostApi.dispatch<{ capabilities?: string[] }>({ target: 'cap.meta', action: 'list' });
    const caps = (res.data?.capabilities ?? []).filter((c) => c.startsWith('cap.tool.') || c === 'cap.interactive');
    for (const cap of caps) {
      const r = await hostApi.dispatch<{ descriptor?: ToolDescriptorProto; descriptors?: ToolDescriptorProto[] }>({ target: cap, action: 'describe' });
      // A1 兼容两种 describe 形态：单 descriptor（存量插件）与聚合 descriptors 数组
      // （如 mcp-bridge 的 cap.tool.mcp 一次返回全部 MCP 工具）。单形态视作长度 1 数组。
      const list = r.data?.descriptor ? [r.data.descriptor] : (r.data?.descriptors ?? []);
      for (const d of list) {
        if (d?.name) tools.set(d.name, d);
      }
    }
  } catch { /* cap.meta 不可用：靠 tool-registered 事件兜底 */ }
}

/**
 * 工具定义快照（缓存命中率关键，2026-11-20）：
 * 网关的 prompt 缓存键包含 **tools 集合**——tools 数量/内容变化即全量未命中
 * （真网关实测：同前缀 tools+1 个 → cached=0）。此前每次请求都从 tools Map 现场重建
 * toolDefs，且 discoverTools 是异步的：插件 setup 晚于首条消息时，首轮 tools 少、
 * 次轮才齐 → 第二轮请求 tools 集合变化 → 前缀缓存全废。
 * 修复：按 name 排序输出稳定顺序；会话维度记住「上次发过的 tools 集合指纹」，
 * 集合未变时复用同一数组（内容与顺序都稳定）；集合变化只发生在工具真正增删时。
 */
let toolDefsSnapshot: { type: 'function'; function: { name: string; description: string; parameters: unknown } }[] = [];
let toolDefsFingerprint = '';

function buildToolDefs(): typeof toolDefsSnapshot {
  const names = [...tools.keys()].sort();
  const fingerprint = names.join(',');
  if (fingerprint === toolDefsFingerprint && toolDefsSnapshot.length === names.length) {
    return toolDefsSnapshot;
  }
  toolDefsFingerprint = fingerprint;
  toolDefsSnapshot = names.map((name) => {
    const d = tools.get(name)!;
    return {
      type: 'function' as const,
      function: { name: d.name, description: d.description, parameters: d.parameters },
    };
  });
  return toolDefsSnapshot;
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
): Promise<'ok' | 'deny' | 'timeout'> {
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
  let autoRejected = false;
  const decision = await new Promise<'once' | 'always' | 'trust' | 'deny'>((resolve) => {
    pendingApprovals.set(callId, resolve);
    setTimeout(() => {
      if (pendingApprovals.has(callId)) {
        pendingApprovals.delete(callId);
        autoRejected = true; // 无人值守：用户长期不看 → 120s 内未决策，自动拒绝
        resolve('deny');
      }
    }, APPROVAL_TIMEOUT_MS);
  });
  pendingApprovals.delete(callId);
  emitTo(emit, 'tool.approval.resolved', { sessionId, messageId: assistantId, callId, decision, autoRejected });
  if (aborted()) return 'deny';
  if (decision === 'deny') return autoRejected ? 'timeout' : 'deny';
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
  onReasoning?: (delta: string) => void,
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
      } else if (ev.kind === 'message.reasoning' && inner.delta) {
        // 思考流原样转发到编排通道（不进 shadow transcript——思考不是协议消息，
        // 喂回上游会造成重复推理/上下文污染；UI 由 chat-lite 落思考块）
        onReasoning?.(inner.delta);
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
    decision?: 'once' | 'always' | 'trust' | 'deny';
    prompt?: string;
    history?: { role: string; content: string }[];
    ctxPolicy?: CtxPolicy;
  };
  const sessionId = payload.sessionId ?? 'unknown';
  // 会话级上下文策略：chat-lite 每次发送透传（缺省字段回退默认值）
  if (payload.ctxPolicy) ctxPolicies.set(sessionId, payload.ctxPolicy);

  // ---- 审批回填 / 中断：非 start 动作直接处理，绝不进入主循环 ----
  if (action === 'resolveApproval') {
    const resolve = payload.callId ? pendingApprovals.get(payload.callId) : undefined;
    resolve?.(payload.decision ?? 'deny');
    return;
  }
  if (action === 'interrupt') {
    const cancel = running.get(sessionId);
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
    return;
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
    // 稳定快照：按 name 排序 + 集合指纹复用（缓存命中率关键，见 buildToolDefs 注释）
    const toolDefs = buildToolDefs();

    // 无工具：直通模式（start 原样透传 cap.ai.chat；引擎事件直达 chat-lite）。
    // interrupt 语义：注册取消柄，中断时向引擎转发 interrupt——否则直通流无法被「停止」打断。
    if (toolDefs.length === 0) {
      const api = hostApi!; // 上方 272 行已有运行时守卫，闭包内 TS 无法保持窄化
      running.set(sessionId, () => {
        void api.dispatch({
          target: 'cap.ai.chat.interrupt',
          action: 'interrupt',
          payload: { sessionId },
        }).catch(() => undefined);
      });
      try {
        await api.dispatch({
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
    // 工作区解析（会话级绑定优先）：
    // - chat-lite 的 start payload 若带 workspaceId，则该会话绑定该根：bash cwd=根路径（服务端
    //   tool-exec 已白名单放行任一登记根），system prompt 同步；
    // - 无绑定/根失效 → 回落内建 workspace，并在 prompt 里注明回落原因；
    // - 其余登记 roots 是 files 工具的只读可见范围。
    let cwdHint = '<dataDir>/workspace（默认工作区）';
    let readonlyHint = '';
    let execCwd: string | undefined;
    try {
      const wsRes = await hostApi.dispatch<{ roots?: { id: string; label: string; path: string; builtin?: boolean }[] }>({ target: 'cap.tool.fs', action: 'roots' });
      const list = wsRes.data?.roots ?? [];
      const boundId = (payload as { workspaceId?: string }).workspaceId;
      const bound = boundId ? list.find((r) => r.id === boundId) : undefined;
      const builtin = list.find((r) => r.builtin);
      if (bound?.path) {
        cwdHint = `${bound.label}（${bound.path}）`;
        execCwd = bound.path;
      } else if (boundId) {
        // 绑定的根已失效（被移除/盘符不在）：回落默认并在 prompt 说明
        readonlyHint = ` 注意：会话绑定的工作区已失效（id=${boundId}），已回落默认工作区。`;
      }
      // 无会话绑定 → 跟随全局 activeRoot（file-browser 树上点「工作区」即全局切换）
      if (!execCwd) {
        // 根是否仍有效由服务端 roots 列表裁定（插件运行在浏览器，不能碰 node:fs）；
        // 列表里找得到 id 即视为有效，服务端已对 missing 根做标记与 cwd 校验。
        const globalEntry = [...globalActive.entries()].find(([id]) => list.some((r) => r.id === id));
        if (globalEntry) {
          const label = list.find((r) => r.id === globalEntry[0])?.label ?? globalEntry[0];
          cwdHint = `${label}（${globalEntry[1]}）`;
          execCwd = globalEntry[1];
        } else if (builtin?.path) {
          cwdHint = builtin.path;
        }
      } else if (builtin?.path && builtin.path !== execCwd) {
        // 会话绑定优先；builtin 与其它登记根退居「只读可见」提示
      }
      // 只读可见范围：会话显式关联的目录优先（用户在输入区勾选的「关联只读」）；
      // 未关联时退回「其余已登记根」——不改变老会话的行为。
      const linkedIds = (payload as { linkedWorkspaceIds?: string[] }).linkedWorkspaceIds ?? [];
      const linkedSet = new Set(linkedIds);
      const readonly = linkedIds.length > 0
        ? list.filter((r) => linkedSet.has(r.id) && r.path !== (execCwd ?? builtin?.path))
        : list.filter((r) => !r.builtin && r.path !== (execCwd ?? builtin?.path));
      if (readonly.length) {
        readonlyHint += linkedIds.length > 0
          ? ` 用户为本对话关联了这些只读目录（可浏览/读取，不可写、bash 不在其中执行）：${readonly.map((r) => `${r.label}（${r.path}）`).join('、')}。`
          : ` files 工具另可只读浏览这些已登记目录（bash 不可达、不可写入）：${readonly.map((r) => `${r.label}（${r.path}）`).join('、')}。`;
      }
    } catch { /* roots 不可用：保持默认提示 */ }
    let shadow = shadows.get(sessionId);
    if (!shadow) {
      shadow = [
        {
          role: 'system',
          content:
            '你是 polaris-lite 工作台里的 AI 助手，可以使用 bash 工具与 files 工具（浏览/读取文件，只读）。' +
            `当前宿主平台：${navigator.platform || 'unknown'}；bash 的 cwd 固定为：${cwdHint}。` +
            '需要读写文件、跑脚本、查状态时优先用工具，不要凭空编造输出；' +
            '命令要一次做完一件事；输出很长时先自己截取关键部分再回答。' +
            'bash 的读写只能发生在 cwd 内；需要浏览或读取 cwd 之外的文件时，用 files 工具的 roots/list/read（只读）。' +
            'interactive 工具可向用户发起结构化提问/表单/确认（question/form/confirm）；' +
            '当任务缺少用户的必要信息或需要用户拍板时，优先用 interactive 直接问，不要自行猜测用户偏好。' +
            'render 工具可生成自包含 HTML 交互面板（小游戏/原型/图表/教具），在对话卡片与「预览」面板中运行；' +
            'HTML 必须自包含：内联 CSS/JS、不引 CDN、不 fetch、模型与贴图用 base64；改动旧面板传 basePreviewId。' +
            'browser 工具可驱动系统 Chrome 搜索/阅读/操作网页（search 搜索、read 读正文、click/fill 交互、screenshot 截图）；' +
            '本会话的操作自动路由到本会话绑定的标签，不会影响其他会话打开的网页；优先用结构化动作而非 evaluate。' +
            readonlyHint,
        },
        ...(payload.history ?? []).map((m) => ({ role: m.role as ShadowMsg['role'], content: m.content })),
      ];
      shadows.set(sessionId, shadow);
      // A2 系统提示附录：技能索引（# Available skills）+ 项目指令（AGENTS.md/CLAUDE.md）
      // 由 skill-loader 插件经 cap.skill.appendix 提供；插件未装/失败时静默跳过（零影响）。
      try {
        const app = await hostApi!.dispatch<{ text?: string }>({ target: 'cap.skill.appendix', action: 'get', payload: { sessionId, cwd: execCwd } });
        if (app.data?.text) shadow[0].content += '\n\n' + app.data.text;
      } catch { /* 附录不可用：无附录继续 */ }
    }
    shadow.push({ role: 'user', content: prompt });

    // ---- 上下文压缩（spec §5.2；对齐 simple_ai chat_loop：先压缩再请求） ----
    const acc = usageAcc.get(sessionId) ?? new UsageAccumulator();
    usageAcc.set(sessionId, acc);
    const policy = { ...DEFAULT_CTX_POLICY, ...(ctxPolicies.get(sessionId) ?? {}) };
    // 窗口解析：会话还没有 ai.usage（首轮/供应商不回 usage）时主动经 cap.model.admin
    // 预解析当前模型的 maxInputTokens——否则压缩阈值与水位分母会一直停在默认 200k，
    // 用户把供应商输入 token 改成 1m 也不生效。解析失败回退默认值。
    if (!ctxWindows.has(sessionId)) {
      try {
        const res = await hostApi.dispatch<{ config?: { activeModel?: string; models?: { id?: string; capabilities?: { maxInputTokens?: number } }[] } }>({ target: 'cap.model.admin', action: 'resolveActive' });
        const cfg = res.ok ? res.data?.config : undefined;
        const model = cfg?.models?.find((m) => m.id && m.id === cfg?.activeModel) ?? cfg?.models?.[0];
        const win = Number(model?.capabilities?.maxInputTokens ?? 0);
        if (Number.isFinite(win) && win > 0) ctxWindows.set(sessionId, win);
      } catch { /* resolveActive 不可用：回退默认窗口 */ }
    }
    const window = ctxWindows.get(sessionId) ?? DEFAULT_CONTEXT_WINDOW;

    /** 非流式补全：复用 /api/model-relay（key 在服务端注入），摘要请求不进 shadow */
    const complete: NonStreamComplete = async ({ system, user, maxTokens }) => {
      if (!hostApi) throw new Error('host api missing');
      // 供应商解析走 cap.model.admin（与 real-engine 同源；masked 视图无 key）
      const res = await hostApi.dispatch<{ config?: { id?: string; activeModel?: string } }>({ target: 'cap.model.admin', action: 'resolveActive' });
      const providerId = res.ok ? res.data?.config?.id : undefined;
      const model = res.ok ? res.data?.config?.activeModel : undefined;
      if (!providerId) throw new Error('no provider for compact');
      const resp = await fetch('/api/model-relay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          providerId,
          body: {
            ...(model ? { model } : {}),
            stream: false,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            max_tokens: maxTokens,
          },
        }),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`compact HTTP ${resp.status}: ${text.slice(0, 160)}`);
      }
      const json = await resp.json().catch(() => null) as {
        choices?: {
          message?: { content?: string | { text?: string }[]; reasoning?: unknown; reasoning_content?: unknown };
          finish_reason?: string;
        }[];
      } | null;
      const choice = json?.choices?.[0];
      let text = '';
      const content = choice?.message?.content;
      if (typeof content === 'string') text = content;
      else if (Array.isArray(content)) text = content.map((p) => p?.text ?? '').join('');
      const truncated = choice?.finish_reason === 'length'
        || (!text.trim() && (choice?.message?.reasoning !== undefined || choice?.message?.reasoning_content !== undefined));
      return { text, truncated };
    };

    // 触发压缩：水位（真实 usage 优先）达阈值 + 未熔断 + 未在压
    if (policy.autoCompact && !compacting.has(sessionId) && acc.shouldCompact(window, policy.threshold, shadow)) {
      compacting.add(sessionId);
      emitTo(emit, 'context.compacting', {
        sessionId, messageId: assistantId,
        estimatedTokens: acc.lastInput > 0 ? acc.lastInput : estimateTokens(shadow),
        window,
      });
      const outcome = await compactShadow(shadow, window, policy.keepRecent, complete);
      compacting.delete(sessionId);
      if (outcome.ok) {
        acc.resetLast();
        emitTo(emit, 'context.compacted', {
          sessionId, messageId: assistantId,
          summary: outcome.summary, removedMessages: outcome.removedMessages,
          tokensBefore: outcome.tokensBefore, tokensAfter: outcome.tokensAfter, at: Date.now(),
        });
      } else if (outcome.error !== 'range-too-small') {
        emitTo(emit, 'context.compact-failed', { sessionId, messageId: assistantId, reason: outcome.error ?? 'unknown' });
      }
      // range-too-small：静默跳过（下一轮消息增多后区间可选再压），不打扰 UI
    }

    let turn = 0;
    let totalToolCalls = 0;
    for (; !abortedFlag; turn += 1) {
      const turnMessageId = `${assistantId}::t${turn}`;
      // onDelta：引擎可见增量实时转发（messageId=assistantId，chat-lite 流式渲染）
      const t = engineTurn(sessionId, turnMessageId, shadow, toolDefs, (delta) => {
        emitTo(emit, 'message.delta', { sessionId, messageId: assistantId, delta });
      }, (delta) => {
        // 思考流转发（messageId=assistantId，chat-lite 落 thinking 块并喂看门狗）
        emitTo(emit, 'message.reasoning', { sessionId, messageId: assistantId, delta });
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

        // 交互卡：不走审批（无危险面，问用户本身就是「审批」），dispatch cap.interactive.ask
        // 把用户作答作为工具结果喂回 shadow transcript，下一轮模型按作答继续。
        if (desc?.cap === 'cap.interactive') {
          let ia: { ok?: boolean; answer?: Record<string, unknown>; error?: string };
          try {
            const res = await hostApi.dispatch<{ ok?: boolean; answer?: Record<string, unknown>; error?: string }>({
              target: 'cap.interactive',
              action: 'ask',
              payload: { ...safeArgsJson(call.arguments), sessionId, messageId: assistantId },
            });
            ia = res.data ?? { ok: false, error: 'empty response' };
          } catch (err) {
            ia = { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
          // 无人值守：用户长期不看 → 交互卡超时返回 {__timeout:true}，明确告诉 AI 用已有信息继续，别空等
          const timedOut = ia.ok && ia.answer && ia.answer.__timeout === true;
          const feedback = timedOut
            ? `[无人值守：交互卡等待超时，用户未作答。请用已有信息继续当前任务，做出合理默认选择或直接给出结论；不要停下来等待用户回复，也不要重复发起同一提问。]`
            : ia.ok && ia.answer
              ? `[用户交互作答] ${JSON.stringify(ia.answer)}`
              : `[交互卡失败] ${ia.error ?? 'no answer'}`;
          // 工具卡终态回执：交互卡没有 exec 语义，也必须发 tool.result 收敛卡片，
          // 否则 UI 永远停在「执行中」转圈（2026-11-20 工具卡状态不回显修复）。
          // stdout 带作答摘要：hasBody 判定需要非空内容，否则成功卡永远无法展开查看。
          emitTo(emit, 'tool.result', {
            sessionId, messageId: assistantId, callId,
            status: ia.ok ? 'done' : 'error',
            command: `interactive ${String((safeArgsJson(call.arguments) as { kind?: string }).kind ?? '')}`.trim(),
            stdout: ia.ok ? feedback : undefined,
            stderr: ia.ok ? undefined : (ia.error ?? '交互卡失败'),
          });
          shadow.push({ role: 'tool', content: feedback, tool_call_id: call.id, name: call.name });
          continue;
        }

        // HTML 预览：免审批（HTML 惰性无行为 + 服务端扫描/配额锁死写入面 + CSP 沙箱硬边界；
        // 迭代场景连改多版，逐次审批是 UX 灾难）。dispatch cap.tool.render 落盘，
        // 只回 previewId 引用（HTML 留服务端，token 与 localStorage 容量双友好），
        // 卡片渲染由 html-preview 经 artifact.created 事件自行落块，loop 不碰 UI。
        if (desc?.cap === 'cap.tool.render') {
          let pr: { ok?: boolean; previewId?: string; url?: string; versionLabel?: string; title?: string; error?: string };
          try {
            const res = await hostApi.dispatch<{ ok?: boolean; previewId?: string; url?: string; versionLabel?: string; title?: string; error?: string }>({
              target: 'cap.tool.render',
              action: 'render',
              payload: { ...safeArgsRender(call.arguments), sessionId, messageId: assistantId },
            });
            pr = res.data ?? { ok: false, error: 'empty response' };
          } catch (err) {
            pr = { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
          const feedback = pr.ok
            ? `[预览已生成] previewId=${pr.previewId} 版本=${pr.versionLabel ?? '?'} 标题=${pr.title ?? '?'}。用户可在对话卡片与「预览」面板中查看运行。`
            : `[预览生成失败] ${pr.error ?? 'unknown error'}`;
          // 工具卡终态回执：render 不走 exec 通用路径，同样必须发 tool.result 收敛卡片
          // stdout 带生成摘要（previewId/版本/标题），成功卡可展开查看
          emitTo(emit, 'tool.result', {
            sessionId, messageId: assistantId, callId,
            status: pr.ok ? 'done' : 'error',
            command: `render ${pr.title ?? ''}`.trim(),
            stdout: pr.ok ? feedback : undefined,
            stderr: pr.ok ? undefined : (pr.error ?? '预览生成失败'),
          });
          shadow.push({ role: 'tool', content: feedback, tool_call_id: call.id, name: call.name });
          continue;
        }

        if (!desc) {
          const msg = `工具 ${call.name} 未注册`;
          emitTo(emit, 'tool.result', { sessionId, messageId: assistantId, callId, status: 'error', stderr: msg });
          shadow.push({ role: 'tool', content: `[工具执行失败] ${msg}`, tool_call_id: call.id, name: call.name });
          continue;
        }

        // 审批（confirm/allowlist 模式且未在会话级白名单）
        const verdict = await decideApproval(sessionId, callId, call, command, emit, assistantId, aborted);
        if (verdict !== 'ok') {
          emitTo(emit, 'tool.result', { sessionId, messageId: assistantId, callId, status: 'denied', command });
          // 无人值守超时自动拒绝 ≠ 用户主动否决：给 AI 明确可执行的继续指令，避免它停下来等待或反复重试同一命令。
          const feedback = verdict === 'timeout'
            ? `[无人值守：该工具调用等待 ${APPROVAL_TIMEOUT_MS / 1000}s 无用户审批，已自动拒绝（并非用户否决本次操作）。请改用不需要危险权限的安全方式继续当前任务——例如用只读工具查看信息、把需要执行的命令作为建议写给用户、或继续处理其它可自动完成的步骤。不要停下等待用户回复，也不要原样重试同一被拒命令。]`
            : '[工具被用户拒绝执行。请尊重用户决定，改用其他方式或直接回答。]';
          shadow.push({ role: 'tool', content: feedback, tool_call_id: call.id, name: call.name });
          continue;
        }

        // A3 生命周期钩子（hook-bridge 插件经 cap.hook.bridge 提供）：
        // PreToolUse 事件可在用户审批之后、实际执行前拦截工具调用（deny → 跳过执行并告知模型原因）。
        // 钩子桥未装/失败时按放行处理（fail-open），零行为变化。
        try {
          const hv = await hostApi!.dispatch<{ decision?: string; reason?: string; updatedInput?: Record<string, unknown> }>({
            target: 'cap.hook.bridge',
            action: 'preToolUse',
            payload: { sessionId, toolName: call.name, toolInput: hookArgsOf(call.arguments) },
          });
          if (hv.data?.decision === 'deny') {
            const reason = hv.data.reason ? `原因：${hv.data.reason}` : '（无附加原因）';
            emitTo(emit, 'tool.result', { sessionId, messageId: assistantId, callId, status: 'denied', command });
            shadow.push({
              role: 'tool',
              content: `[工具被生命周期钩子拦截] ${reason}。请尊重该策略，改用其他方式或直接回答；不要原样重试同一被拦截调用。`,
              tool_call_id: call.id,
              name: call.name,
            });
            continue;
          }
        } catch { /* 钩子桥不可用：放行 */ }

        // files（cap.tool.fs）：动作语义只读工具（roots/list/read），不走 exec——
        // 服务端只有 GET /api/fs/*；模型给 {action,...}，按动作分发并回结构化结果。
        // 修复（2026-11-20）：此前掉进通用 exec 分支，fs 无 exec 动作恒报
        // unknown action，且 tool.result 事件缺失 → 工具卡永远「执行中」转圈。
        if (desc?.cap === 'cap.tool.fs') {
          let fr: { ok?: boolean; error?: string; [k: string]: unknown } = { ok: false, error: 'fs tool did not run' };
          let frSummary = '';
          try {
            const fa = safeFsArgs(call.arguments);
            const action = String(fa.action ?? '');
            if (action === 'roots') {
              const r = await hostApi.dispatch<{ roots?: { id: string; label: string; path: string; builtin?: boolean }[]; note?: string }>({ target: 'cap.tool.fs', action: 'roots' });
              if (!r.ok) {
                fr = { ok: false, error: r.error?.message ?? 'roots dispatch failed' };
              } else {
                const roots = r.data?.roots ?? [];
                fr = { ok: true, roots: roots };
                frSummary = roots.length
                  ? `roots=${roots.length}: ${roots.map((x) => `${x.label}（id=${x.id}, path=${x.path}${x.builtin ? ', builtin' : ''}）`).join('; ')}`
                  : '（无登记根）';
              }
            } else if (action === 'list') {
              if (!fa.rootId) {
                // 无 rootId 时先拉 roots 取默认（builtin 优先），避免模型必须先查再列两轮
                const rr = await hostApi.dispatch<{ roots?: { id: string; label: string; path: string; builtin?: boolean }[] }>({ target: 'cap.tool.fs', action: 'roots' });
                const builtin = (rr.data?.roots ?? []).find((x) => x.builtin) ?? rr.data?.roots?.[0];
                if (!builtin) {
                  fr = { ok: false, error: 'rootId required（且无可用默认根）' };
                } else {
                  fa.rootId = builtin.id;
                }
              }
              if (fa.rootId) {
                const q = new URLSearchParams({ rootId: fa.rootId, path: fa.path ?? '' });
                const resp = await fetch(`/api/fs/list?${q}`, { credentials: 'include' });
                const json = (await resp.json().catch(() => null)) as { entries?: unknown[]; truncated?: boolean; error?: string } | null;
                fr = !resp.ok || !json ? { ok: false, error: json?.error ?? `HTTP ${resp.status}` } : { ok: true, entries: json.entries, truncated: json.truncated };
                frSummary = fr.ok ? `list ok（${(json?.entries ?? []).length} 项，rootId=${fa.rootId}，path=${fa.path ?? ''}）` : `list 失败：${fr.error}`;
              }
            } else if (action === 'read') {
              if (!fa.rootId) {
                const rr = await hostApi.dispatch<{ roots?: { id: string; label: string; path: string; builtin?: boolean }[] }>({ target: 'cap.tool.fs', action: 'roots' });
                const builtin = (rr.data?.roots ?? []).find((x) => x.builtin) ?? rr.data?.roots?.[0];
                if (!builtin) {
                  fr = { ok: false, error: 'rootId required（且无可用默认根）' };
                } else {
                  fa.rootId = builtin.id;
                }
              }
              if (fa.rootId) {
                const q = new URLSearchParams({ rootId: fa.rootId, path: fa.path ?? '' });
                if (fa.head) q.set('head', String(fa.head));
                if (fa.tail) q.set('tail', String(fa.tail));
                const resp = await fetch(`/api/fs/read?${q}`, { credentials: 'include' });
                const json = (await resp.json().catch(() => null)) as { text?: string; size?: number; truncated?: boolean; tooLarge?: boolean; isText?: boolean; hint?: string; error?: string } | null;
                if (!resp.ok || !json) {
                  fr = { ok: false, error: json?.error ?? `HTTP ${resp.status}` };
                } else if (json.tooLarge) {
                  fr = { ok: false, error: json.hint ?? '文件过大' };
                } else if (!json.isText) {
                  fr = { ok: false, error: '二进制文件不支持文本读取' };
                } else {
                  fr = { ok: true, text: json.text, size: json.size, truncated: json.truncated };
                }
                frSummary = fr.ok ? `read ok（${json?.size ?? '?'}B，path=${fa.path ?? ''}）：\n${capText(String(json?.text ?? ''), 2000)}` : `read 失败：${fr.error}`;
              }
            } else {
              fr = { ok: false, error: `unknown fs action: ${action || '(empty)'}（可用：roots/list/read）` };
            }
          } catch (err) {
            fr = { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
          // 喂回 shadow：结构化结果转摘要（read 全文按上限截断），AI 下一轮据此继续
          const feedback = fr.ok
            ? `[files 完成] ${frSummary || JSON.stringify(fr).slice(0, FEEDBACK_CAP)}`
            : `[files 工具执行失败] ${fr.error ?? 'unknown error'}`;
          // stdout 带结果摘要，成功卡可展开查看（hasBody 需要非空内容）
          emitTo(emit, 'tool.result', {
            sessionId, messageId: assistantId, callId,
            status: fr.ok ? 'done' : 'error',
            command: `files ${String(safeFsArgs(call.arguments).action ?? '')}`.trim(),
            stdout: fr.ok ? feedback : undefined,
            stderr: fr.ok ? undefined : String(fr.error ?? 'files 工具执行失败'),
          });
          shadow.push({ role: 'tool', content: feedback, tool_call_id: call.id, name: call.name });
          continue;
        }

        // 日常记账（cap.tool.ledger）：动作语义工具（add/query/...），不走 exec——
        // 模型在 arguments 里给 {action,...}，解析后透传给 ledger 处理器；入账响应自带预算提醒。
        if (desc?.cap === 'cap.tool.ledger') {
          let lr: { ok?: boolean; error?: string; hint?: string };
          try {
            const args = safeLedgerArgs(call.arguments);
            const res = await hostApi.dispatch<{ ok?: boolean; error?: string; hint?: string }>({
              target: 'cap.tool.ledger',
              action: String(args.action ?? 'add'),
              payload: { ...args, sessionId },
            });
            lr = res.data ?? { ok: false, error: 'empty response' };
          } catch (err) {
            lr = { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
          const feedback = lr.ok
            ? `[记账成功] ${JSON.stringify(lr)}${lr.hint ? `；${lr.hint}` : ''}`
            : `[记账失败] ${lr.error ?? 'unknown error'}`;
          // 工具卡终态回执：ledger 动作语义工具不走 exec 通用路径，同样发 tool.result 收敛卡片
          // stdout 带入账结果摘要，成功卡可展开查看
          emitTo(emit, 'tool.result', {
            sessionId, messageId: assistantId, callId,
            status: lr.ok ? 'done' : 'error',
            command: `ledger ${String((safeLedgerArgs(call.arguments) as { action?: string }).action ?? '')}`.trim(),
            stdout: lr.ok ? feedback : undefined,
            stderr: lr.ok ? undefined : (lr.error ?? '记账失败'),
          });
          shadow.push({ role: 'tool', content: feedback, tool_call_id: call.id, name: call.name });
          continue;
        }

        // 浏览器（cap.tool.browser）：动作语义工具，不走 exec 通用路径——
        // 返回是结构化结果（搜索数组/标签列表/截图引用），且导航动作需要服务端围栏与审计。
        // sessionId 即服务端 agentKey（会话绑定标签，A 会话不会动到 B 会话的标签）。
        if (desc?.cap === 'cap.tool.browser') {
          let br: { ok?: boolean; error?: string; [k: string]: unknown };
          try {
            const args = safeBrowserArgs(call.arguments);
            const res = await hostApi.dispatch<{ ok?: boolean; error?: string; [k: string]: unknown }>({
              target: 'cap.tool.browser',
              action: String(args.action ?? ''),
              // callId 透传：截图动作 emit artifact.created 时以此为 callId，
              // chat-lite 据此把截图 artifact 归位到本工具卡之后（而不是沉到消息尾）。
              payload: { ...args, sessionId, messageId: assistantId, callId },
            });
            br = res.data ?? { ok: false, error: 'empty response' };
            // dispatch 失败（权限/未知动作）时 res.data 为空但 res.error 有值
            if (!res.ok && !br.ok) br = { ok: false, error: res.error?.message ?? 'browser dispatch failed' };
            // 成功路径：结构化结果（tabs 的 {tabs}、search 的数组等）不一定带 ok 字段——
            // dispatch 已 ok 且无 error 即视为成功（2026-11-20 冒烟修正）
            if (res.ok && br.ok === undefined && !br.error) br = { ...br, ok: true };
          } catch (err) {
            br = { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
          // 喂回 shadow：只回摘要级 JSON（截图 base64 不进 transcript——服务端落盘只回引用）
          const feedback = br.ok
            ? `[浏览器操作完成] ${JSON.stringify(br)}`
            : `[浏览器操作失败] ${br.error ?? 'unknown error'}`;
          // 工具卡终态回执：browser 动作语义工具不走 exec 通用路径，同样发 tool.result 收敛卡片
          // stdout 带操作结果摘要（标签/搜索结果/截图引用等），成功卡可展开查看
          emitTo(emit, 'tool.result', {
            sessionId, messageId: assistantId, callId,
            status: br.ok ? 'done' : 'error',
            command: `browser ${String((safeBrowserArgs(call.arguments) as { action?: string }).action ?? '')}`.trim(),
            stdout: br.ok ? feedback : undefined,
            stderr: br.ok ? undefined : String(br.error ?? '浏览器操作失败'),
          });
          shadow.push({ role: 'tool', content: feedback, tool_call_id: call.id, name: call.name });
          continue;
        }

        // 执行（经工具插件的 cap；approved 标记供服务端二次校验）
        // cwd=本会话绑定的工作区根（无绑定/失效回落时 execCwd 为空 → 服务端用默认 workspace）
        inFlightExec.set(sessionId, callId);
        let exec: { ok: boolean; stdout?: string; stderr?: string; exitCode?: number; durationMs?: number; truncated?: boolean; error?: string; denied?: boolean };
        try {
          // files_write（cap.tool.files-write）：动作语义工具，参数透传走 safeArgsFilesWrite
          // （通用 safeArgs 只放行 command/timeoutMs，会把 action/path/content 全剥掉）。
          // cap.tool.skill（read_skill）：参数是 {name}，同样会被 safeArgs 剥掉 → 走完整透传
          // （hookArgsOf，与 A3 钩子入参同一透传器；工具 describe 的 parameters 已约束形状）。
          const payload = desc.cap === 'cap.tool.files-write'
            ? { ...safeArgsFilesWrite(call.arguments), sessionId, approved: true }
            : desc.cap === 'cap.tool.skill'
              ? { ...hookArgsOf(call.arguments), sessionId, approved: true }
              : { ...safeArgs(call.arguments), sessionId, approved: true, ...(execCwd ? { cwd: execCwd } : {}) };
          const res = await hostApi.dispatch<{ ok: boolean; stdout?: string; stderr?: string; exitCode?: number; durationMs?: number; truncated?: boolean; error?: string; denied?: boolean }>({
            target: desc.cap,
            action: 'exec',
            payload,
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
    // 上下文水位快照：ContextMeter 的数据源（估算口径，含工具上下文；spec §5.2）
    emitTo(emit, 'context.snapshot', {
      sessionId, messageId: assistantId,
      usedTokens: acc.lastInput > 0 ? acc.lastInput : estimateTokens(shadow),
      window,
      percent: window > 0 ? Math.min(1, (acc.lastInput > 0 ? acc.lastInput : estimateTokens(shadow)) / window) : 0,
      messages: shadow.length,
      compacted: acc.roundsSinceCompact !== null,
      exhausted: acc.exhausted,
    });
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

/** 安全解析工具参数（bash：只透传 command/timeoutMs，防参数注入面扩张） */
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

/** A3 钩子入参：把模型给的 arguments JSON 完整透传给钩子（不剥字段——
 *  钩子需要看到完整 tool_input 才能按 CC/ZC 语义做 matcher/decision） */
function hookArgsOf(raw: string): Record<string, unknown> {
  try {
    const p = JSON.parse(raw || '{}') as Record<string, unknown>;
    return p && typeof p === 'object' ? p : {};
  } catch {
    return {};
  }
}

/** files_write 参数解析（agent-files：透传动作语义字段，其余丢弃） */
function safeArgsFilesWrite(raw: string): {
  action?: string; path?: string; content?: string;
  old_string?: string; new_string?: string; expected_replacements?: number;
  patch?: string; rootId?: string;
} {
  try {
    const p = JSON.parse(raw || '{}') as Record<string, unknown>;
    return {
      ...(p.action !== undefined ? { action: String(p.action) } : {}),
      ...(p.path !== undefined ? { path: String(p.path) } : {}),
      ...(p.content !== undefined ? { content: String(p.content) } : {}),
      ...(p.old_string !== undefined ? { old_string: String(p.old_string) } : {}),
      ...(p.new_string !== undefined ? { new_string: String(p.new_string) } : {}),
      ...(p.expected_replacements !== undefined ? { expected_replacements: Number(p.expected_replacements) } : {}),
      ...(p.patch !== undefined ? { patch: String(p.patch) } : {}),
      ...(p.rootId !== undefined ? { rootId: String(p.rootId) } : {}),
    };
  } catch {
    return {};
  }
}

/** 交互卡参数解析（interactive：透传 kind/title/options/fields；其余字段丢弃） */
function safeArgsJson(raw: string): { kind?: string; title?: string; options?: string[]; fields?: unknown[] } {
  try {
    const p = JSON.parse(raw || '{}') as Record<string, unknown>;
    return {
      ...(p.kind !== undefined ? { kind: String(p.kind) } : {}),
      ...(p.title !== undefined ? { title: String(p.title) } : {}),
      ...(Array.isArray(p.options) ? { options: p.options.map(String) } : {}),
      ...(Array.isArray(p.fields) ? { fields: p.fields } : {}),
    };
  } catch {
    return {};
  }
}

/** 日常记账参数解析（ledger：动作 + 常用字段透传；金额/limit 数字化） */
function safeLedgerArgs(raw: string): Record<string, unknown> {
  try {
    const p = JSON.parse(raw || '{}') as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of ['action', 'type', 'category', 'note', 'date', 'time', 'timeOfDay', 'id', 'month', 'keyword', 'op', 'name', 'kind']) {
      if (p[k] !== undefined && p[k] !== null && p[k] !== '') out[k] = String(p[k]);
    }
    if (p.amount !== undefined) out.amount = Number(p.amount);
    if (p.limit !== undefined) out.limit = Number(p.limit);
    if (p.patch !== undefined && typeof p.patch === 'object') out.patch = p.patch;
    return out;
  } catch {
    return {};
  }
}

/** HTML 预览参数解析（render：透传 html/title/basePreviewId；html 超长截断交服务端拒） */
function safeArgsRender(raw: string): { html?: string; title?: string; basePreviewId?: string } {
  try {
    const p = JSON.parse(raw || '{}') as Record<string, unknown>;
    return {
      ...(typeof p.html === 'string' && p.html ? { html: p.html } : {}),
      ...(p.title !== undefined ? { title: String(p.title).slice(0, 120) } : {}),
      ...(typeof p.basePreviewId === 'string' && p.basePreviewId ? { basePreviewId: p.basePreviewId } : {}),
    };
  } catch {
    return {};
  }
}

/** 浏览器工具参数解析（browser：动作白名单键透传，与 browser-lite BROWSER_ARG_KEYS 对齐） */
function safeBrowserArgs(raw: string): Record<string, unknown> {
  try {
    const p = JSON.parse(raw || '{}') as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of [
      'action', 'url', 'query', 'engine', 'limit', 'label', 'selector', 'index', 'value', 'keys',
      'amount', 'direction', 'selector_wait', 'urlPattern', 'downloadComplete', 'timeoutMs',
      'fullPage', 'mode', 'closeAll', 'historyAction', 'kinds', 'sinceSeq', 'title', 'newWindow',
    ]) {
      if (p[k] !== undefined && p[k] !== null) out[k] = p[k];
    }
    return out;
  } catch {
    return {};
  }
}

/** files 工具参数解析（fs：action/rootId/path/head/tail 白名单透传，与 file-browser createFsHandler 对齐） */
function safeFsArgs(raw: string): { action?: string; rootId?: string; path?: string; head?: number; tail?: number } {
  try {
    const p = JSON.parse(raw || '{}') as Record<string, unknown>;
    return {
      ...(p.action !== undefined ? { action: String(p.action) } : {}),
      ...(p.rootId !== undefined ? { rootId: String(p.rootId) } : {}),
      ...(p.path !== undefined ? { path: String(p.path) } : {}),
      ...(p.head !== undefined ? { head: Number(p.head) } : {}),
      ...(p.tail !== undefined ? { tail: Number(p.tail) } : {}),
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
    capabilities: ['cap.ai.chat', 'cap.ai.chat.interrupt', 'cap.tool.bash', 'cap.meta', 'cap.tool.fs', 'cap.tool.files-write', 'cap.interactive', 'cap.tool.render', 'cap.model.admin', 'cap.tool.ledger', 'cap.tool.browser', 'cap.tool.skill', 'cap.skill.appendix', 'cap.hook.bridge'],
    requires: ['cap.ai.chat', 'cap.tool.bash'],
    provides: ['cap.agent.loop'],
    events: ['cap.ai.chat:event', 'tool-registered', 'workspace-changed'],
    contributes: { slots: [] },
  },
  setup(api: SlotHostApi) {
    hostApi = api;
    api.registerCapability.registerStreaming('cap.agent.loop', loopHandler);
    // 迟到的工具注册（loop 先于工具装配时的兜底；主路径是启动时主动拉取）。
    // 注册后立即刷新稳定快照（buildToolDefs 按 name 排序，顺序确定）。
    api.listen('tool-registered', () => {
      void discoverTools().then(() => buildToolDefs());
    });
    // ai.usage（real-engine 流末发出）：更新压缩触发基准 + 留存速率样本（spec §4.1/§5.2）
    api.listen('cap.ai.chat:event', (envelope) => {
      const ev = envelope as { source?: string; payload?: AiUsageEvent } & AiUsageEvent;
      const inner = (ev.payload ?? {}) as NonNullable<AiUsageEvent['payload']>;
      if (ev.kind !== 'ai.usage' || !inner.sessionId) return;
      const sid = inner.sessionId;
      const acc = usageAcc.get(sid) ?? new UsageAccumulator();
      usageAcc.set(sid, acc);
      if (inner.inputTokens !== undefined) acc.add(inner.inputTokens);
      // 压缩后冷却期结束：以本轮真实 usage 判断是否熔断（压缩无效则本会话不再自动压）
      acc.notePostCompactRound(inner.inputTokens !== undefined && inner.inputTokens >= (inner.contextWindow ?? DEFAULT_CONTEXT_WINDOW) * DEFAULT_CTX_POLICY.threshold);
      if (inner.contextWindow && inner.contextWindow > 0) ctxWindows.set(sid, inner.contextWindow);
      lastUsage.set(sid, {
        inputTokens: inner.inputTokens ?? 0,
        outputTokens: inner.outputTokens ?? 0,
        estimated: inner.estimated,
        at: Date.now(),
        durationMs: inner.durationMs ?? 0,
        ...(inner.totalTokens !== undefined ? { totalTokens: inner.totalTokens } : {}),
        ...(inner.model ? { model: inner.model } : {}),
        ...(inner.contextWindow !== undefined ? { contextWindow: inner.contextWindow } : {}),
      });
    });
    // 全局工作区切换（file-browser 树上点「工作区」按钮）→ 更新 globalActive 缓存，
    // 供未显式绑定工作区的会话跟随（cwd 解析优先级：会话绑定 > 全局 active > builtin）
    api.listen('workspace-changed', (envelope) => {
      console.log('[agent-loop] got workspace-changed:', JSON.stringify(envelope));
      // 宿主投递的是信封 { source, payload }；真正载荷在 payload 字段
      const p = (envelope as { payload?: { activeRootId?: string; linkedRootIds?: string[] } }).payload;
      if (!p?.activeRootId) return;
      const activeRootId = p.activeRootId;
      void (async () => {
        try {
          const res = await hostApi!.dispatch<{ roots?: { id: string; path: string }[] }>({ target: 'cap.tool.fs', action: 'roots' });
          const match = (res.data?.roots ?? []).find((r) => r.id === activeRootId);
          console.log('[agent-loop] resolve:', activeRootId, '->', match ? match.path : '(missing)');
          if (match) globalActive.set(match.id, match.path);
          else globalActive.delete(activeRootId);
        } catch { /* roots 不可用：保持旧值 */ }
      })();
    });
    void discoverTools();
  },
};

export default agentLoopPlugin;
