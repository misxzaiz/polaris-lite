/**
 * liveTurn：一轮服务端 runner 流的渲染器（发起端与「重开/切回」共用）。
 *
 * 为什么单独成模块（2026-11-26）：
 * 发起端（sendUserMessage）原本把「delta 合帧 → 落块 → 看门狗 → 收敛」写成闭包，
 * 只有本端发起时才存在。页面关闭重开 / 另一台设备切进执行中的会话时，事件其实
 * 一直在服务端 SSE 上（agent-runner 的 /api/agent/events），但没有任何消费者绑定，
 * 于是表现为：**工具卡不实时、要等下一段正文落盘才一起出现；输入框显示"已结束"
 * 而没有「停止」**（本地消息来自 chat-store 快照，streaming 恒为 false）。
 *
 * 这里把渲染器提成可复用的 LiveTurn：
 * - 事件形状与 cap.ai.chat:event 完全一致（runnerBridge 直接转投）；
 * - 收敛只认 message.done / stream.error / run-ended（看门狗只软提示、绝不收敛）；
 * - 重放从服务端 /state 的 syncedSeq 起（= 已落进 chat-store 的事件游标），
 *   已落档的块不会被重复追加，未落档的尾段才补渲染。
 */
import {
  useSessionStore,
  hasBlocks,
  pullNow,
  CARD_STORE_CAP,
  markRunnerOwned,
  unmarkRunnerOwned,
  type StoreMessage,
  type ToolCardData,
} from './store';
import type { StreamEnvelope } from './runnerTypes';
import { setRunnerConsumer, setRunnerEndedHook, subscribeRunner, type RunnerAttach } from './runnerBridge';

/** 流式阶段看门狗（软提示阈值；不是超时上限，更不是收敛信号） */
const STREAM_IDLE_TIMEOUT_MS = 120_000;
/** 工具阶段看门狗（多轮审批 + bash 静默兜底） */
const TOOL_PHASE_TIMEOUT_MS = 600_000;

export interface LiveTurnHooks {
  /** 断流重试的瞬态提示（MessageStream 浮层）；不带=静默 */
  onRetry?: (attempt: number, maxAttempts: number, chars: number) => void;
  /** 收敛后的附加动作（发起端用来泵队列；重开恢复用来补偿对账） */
  onSettle?: () => void;
  /** 登录过期：交回宿主清理会话并回登录视图 */
  onAuthExpired?: () => void;
  /** 事件旁听（ai-events 取证通道）；不带=不投递 */
  onEvent?: (envelope: StreamEnvelope) => void;
}

export interface LiveTurn {
  /** 事件入口（含 sessionId/messageId 过滤与旁听投递）；形状同 cap 总线 payload */
  dispatch: (payload: unknown) => void;
  /** 真收敛（done / error / 用户停止 / run-ended） */
  settle: () => void;
  isSettled: () => boolean;
}

/** sessionId → 当前绑定的渲染器（同一会话同一时刻只允许一个） */
const liveTurns = new Map<string, LiveTurn>();
let dispatcherBound = false;

/** 全局 runner 消费者：按 sessionId 路由到对应 LiveTurn（多会话并发也不串台） */
function bindDispatcher(): void {
  if (dispatcherBound) return;
  dispatcherBound = true;
  setRunnerConsumer((envelope) => {
    const inner = (envelope.payload ?? {}) as { sessionId?: string };
    const sid = typeof inner.sessionId === 'string' ? inner.sessionId : '';
    if (!sid) return;
    const turn = liveTurns.get(sid);
    if (!turn) return;
    turn.dispatch(envelope);
  });
  // 服务端先发 run-ended 再关流；若 message.done 因断连丢了，这里兜底收敛，
  // 否则消息会永久停在 streaming=true（输入框卡在「停止」）。
  setRunnerEndedHook((sid) => { liveTurns.get(sid)?.settle(); });
}

/** 工具块事件处理（前后端同一套语义；按 callId 幂等建块/更新） */
function handleToolEvent(
  kind: string,
  inner: NonNullable<StreamEnvelope['payload']>,
  sid: string,
  assistantId: string,
  armPhaseWatchdog: () => void,
): void {
  const st = useSessionStore.getState();
  // 工具阶段（执行/审批）无 delta 流，用长看门狗并逐事件续期，避免误杀在途编排
  armPhaseWatchdog();
  // patchCard 路径不过 trimCard（appendAssistantBlock 才过）——argsJson 在此手动裁剪
  const capArgs = (raw?: string): string | undefined =>
    raw ? (raw.length > CARD_STORE_CAP ? `${raw.slice(0, CARD_STORE_CAP)}…[已截断]` : raw) : undefined;
  const patchCard = (callId: string, patch: (card: ToolCardData) => ToolCardData): void => {
    const msg = st.sessions.find((s) => s.id === sid)?.messages.find((m) => m.id === assistantId);
    if (msg && hasBlocks(msg)) {
      const blk = msg.blocks.find((b) => b.type === 'tool' && b.card.callId === callId);
      st.patchAssistantToolBlock(sid, assistantId, callId, patch(blk && blk.type === 'tool' ? blk.card : ({} as ToolCardData)));
      return;
    }
    // 旧版（历史会话）：独立 tool 卡消息
    const legacy = st.sessions.find((s) => s.id === sid)?.messages.find((m) => m.id === `card-${callId}`) as
      | { id: string; tool: ToolCardData }
      | undefined;
    if (legacy) st.updateMessage(sid, legacy.id, { tool: patch(legacy.tool) } as Partial<StoreMessage>);
  };

  if (kind === 'tool.card' || kind === 'tool.approval.required') {
    const callId = inner.callId ?? '';
    const msg = st.sessions.find((s) => s.id === sid)?.messages.find((m) => m.id === assistantId);
    const exists = msg && hasBlocks(msg) && msg.blocks.some((b) => b.type === 'tool' && b.card.callId === callId);
    if (!exists) {
      // 新块（tool.card 先到即建 running 卡）。command 空串时落到 argsJson（ArgsBlock 可折叠细看）
      st.appendAssistantBlock(sid, assistantId, {
        type: 'tool',
        card: {
          callId,
          name: inner.name ?? 'tool',
          command: inner.command || inner.argsJson,
          argsJson: inner.argsJson,
          status: kind === 'tool.card' ? 'running' : 'awaiting',
        },
      });
      return;
    }
    if (kind === 'tool.card') {
      // 部分引擎对同一 callId 连发两帧：首帧 input 恒为空，收尾帧才带完整参数。
      // name 一并回填：args.delta 先到时建过「工具调用」占位卡，这里换成真名。
      patchCard(callId, (c) => ({
        ...c,
        ...(inner.name ? { name: inner.name } : {}),
        ...(inner.command ? { command: capArgs(inner.command) } : {}),
        ...(inner.argsJson ? { argsJson: capArgs(inner.argsJson) } : {}),
      }));
    } else {
      patchCard(callId, (c) => ({
        ...c,
        status: 'awaiting',
        ...(inner.command ? { command: inner.command } : {}),
        ...(inner.argsJson ? { argsJson: capArgs(inner.argsJson) } : {}),
      }));
    }
    return;
  }
  if (kind === 'tool.args.delta') {
    // 工具参数流式增量（render 等大参数工具的实时预览数据源）：
    // 按 callId 累积进 argsDelta（字符串拼接，容量上限对齐 argsJson 裁剪策略）。
    // delta 总是先于 runner 的 tool.card 到达（后者在 turn 收敛才发）——
    // 卡片不存在时先建 running 临时卡（name 未知先用「工具调用」占位），
    // tool.card 到达时按 callId 幂等回填真名/参数，绝不重复建块。
    if (typeof inner.delta === 'string' && inner.delta) {
      const callId = inner.callId ?? '';
      const msg = st.sessions.find((s) => s.id === sid)?.messages.find((m) => m.id === assistantId);
      const exists = msg && hasBlocks(msg) && msg.blocks.some((b) => b.type === 'tool' && b.card.callId === callId);
      if (!exists) {
        st.appendAssistantBlock(sid, assistantId, {
          type: 'tool',
          card: { callId, name: '工具调用', status: 'running' },
        });
      }
      patchCard(callId, (c) => ({
        ...c,
        argsDelta: ((c.argsDelta ?? '') + inner.delta).slice(0, CARD_STORE_CAP),
      }));
    }
    return;
  }
  if (kind === 'tool.approval.resolved') {
    patchCard(inner.callId ?? '', (c) => ({
      ...c,
      status: inner.decision === 'deny' ? 'denied' : 'resolved',
      decision: inner.decision,
      stderr: inner.autoRejected ? '无人值守：120s 无审批，已自动拒绝' : c.stderr,
    }));
    return;
  }
  if (kind === 'tool.result') {
    patchCard(inner.callId ?? '', (c) => ({
      ...c,
      status: inner.status ?? 'error',
      ...(inner.command ? { command: inner.command } : {}),
      stdout: inner.stdout,
      stderr: inner.stderr,
      exitCode: inner.exitCode,
      durationMs: inner.durationMs,
      truncated: inner.truncated,
    }));
  }
}

/**
 * 创建并绑定一轮渲染器。调用方负责：
 * - 发起端：消息已由 sendUserMessage 建好（streaming:true）；
 * - 恢复端：先 attachRunnerLive（内部补建/复位消息）。
 */
export function createLiveTurn(opts: {
  sessionId: string;
  assistantId: string;
  hooks?: LiveTurnHooks;
}): LiveTurn {
  const { sessionId: sid, assistantId, hooks } = opts;
  bindDispatcher();

  // ---- delta / reasoning 按帧合并 ----
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
    useSessionStore.getState().appendAssistantBlock(sid, assistantId, { type: 'text', text: chunk });
  };
  const pushDelta = (delta: string): void => {
    buf += delta;
    if (frame) return;
    frame = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(flushDelta)
      : (setTimeout(flushDelta, 16) as unknown as number);
  };

  let rbuf = '';
  let rframe = 0;
  const flushReasoning = (): void => {
    if (rframe) {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rframe);
      rframe = 0;
    }
    if (!rbuf) return;
    const chunk = rbuf;
    rbuf = '';
    useSessionStore.getState().appendAssistantBlock(sid, assistantId, { type: 'thinking', text: chunk });
  };
  const pushReasoning = (delta: string): void => {
    rbuf += delta;
    if (rframe) return;
    rframe = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(flushReasoning)
      : (setTimeout(flushReasoning, 16) as unknown as number);
  };

  // ---- 幂等收敛 + 看门狗（两个 timer 必须独立，理由见旧实现注释） ----
  let settled = false;
  let streamWatchdog: ReturnType<typeof setTimeout> | null = null;
  let phaseWatchdog: ReturnType<typeof setTimeout> | null = null;
  let idleHintShown = false;

  const clearWatchdogs = (): void => {
    if (streamWatchdog) { clearTimeout(streamWatchdog); streamWatchdog = null; }
    if (phaseWatchdog) { clearTimeout(phaseWatchdog); phaseWatchdog = null; }
  };

  const settle = (): void => {
    if (settled) return;
    settled = true;
    clearWatchdogs();
    flushDelta();
    flushReasoning();
    useSessionStore.getState().updateMessage(sid, assistantId, {
      streaming: false,
      endedAt: Date.now(),
    });
    // 会话档单一权威化：runner 编排结束——解除占用，后续 pull 按服务端档案刷新本地镜像
    unmarkRunnerOwned(sid);
    liveTurns.delete(sid);
    hooks?.onSettle?.();
  };

  /**
   * 软提示：超时只告诉用户「仍在等待」，绝不 settle / unbind。
   * 收敛权交给后端权威信号（message.done / stream.error / run-ended）和用户「停止」——
   * 这样模型长思考或后台长编排期间静默再久，结果到达后仍会被订阅到并落块。
   */
  const showIdleHint = (label: string): void => {
    if (settled || idleHintShown) return;
    idleHintShown = true;
    useSessionStore.getState().appendAssistantBlock(sid, assistantId, {
      type: 'text',
      text: `[运行提示] ${label}暂无新内容，任务可能仍在后台执行；结果到达后会自动更新。如需中止请点「停止」。`,
    });
  };

  const armWatchdog = (): void => {
    if (phaseWatchdog) return; // 已进入工具阶段：流式看门狗长期让位
    if (streamWatchdog) clearTimeout(streamWatchdog);
    streamWatchdog = setTimeout(() => {
      if (settled) return;
      streamWatchdog = null;
      showIdleHint(`已 ${STREAM_IDLE_TIMEOUT_MS / 1000}s`);
    }, STREAM_IDLE_TIMEOUT_MS);
  };

  const armPhaseWatchdog = (): void => {
    if (streamWatchdog) { clearTimeout(streamWatchdog); streamWatchdog = null; }
    if (phaseWatchdog) clearTimeout(phaseWatchdog);
    phaseWatchdog = setTimeout(() => {
      if (settled) return;
      phaseWatchdog = null;
      showIdleHint(`工具阶段已 ${TOOL_PHASE_TIMEOUT_MS / 1000}s`);
    }, TOOL_PHASE_TIMEOUT_MS);
  };

  const handleEnvelope = (envelope: StreamEnvelope): void => {
    // 来源由宿主取「该 cap 的提供方插件 id」后注入，插件无法伪造
    if (!envelope.source) return;
    const inner = envelope.payload ?? {};
    // 精确匹配：会话 + 消息 双重过滤（并发流不串台）
    if (inner.sessionId && inner.sessionId !== sid) return;
    if (inner.messageId && inner.messageId !== assistantId) return;

    if (envelope.kind.startsWith('tool.')) {
      handleToolEvent(envelope.kind, inner, sid, assistantId, armPhaseWatchdog);
      return;
    }

    if (envelope.kind === 'interactive.required') {
      armPhaseWatchdog();
      const callId = String(inner.callId ?? '');
      if (!callId) return;
      const st2 = useSessionStore.getState();
      const msg2 = st2.sessions.find((s) => s.id === sid)?.messages.find((m) => m.id === assistantId);
      const blocks2 = (msg2 as { blocks?: { type: string; card?: { callId: string } }[] } | undefined)?.blocks;
      if (!msg2 || !Array.isArray(blocks2)) return;
      if (blocks2.some((b) => b.type === 'interactive' && b.card?.callId === callId)) return; // 幂等
      st2.appendAssistantBlock(sid, assistantId, {
        type: 'interactive',
        card: {
          callId,
          kind: (inner.kind as 'question' | 'form' | 'confirm') ?? 'question',
          title: String(inner.title ?? '请确认'),
          payload: { options: inner.options ?? [], fields: inner.fields ?? [] },
          status: 'awaiting',
        },
      });
      return;
    }
    if (envelope.kind === 'interactive.resolved') {
      const callId = String(inner.callId ?? '');
      if (!callId) return;
      useSessionStore.getState().patchAssistantInteractiveBlock(sid, assistantId, callId, {
        status: 'answered',
        answer: (inner.answer ?? {}) as Record<string, unknown>,
      });
      return;
    }

    if (envelope.kind === 'artifact.created') {
      const callId = String(inner.callId ?? '');
      if (!callId || !inner.rendererType) return;
      const st4 = useSessionStore.getState();
      const msg4 = st4.sessions.find((s) => s.id === sid)?.messages.find((m) => m.id === assistantId);
      const blocks4 = (msg4 as { blocks?: { type: string; card?: { callId: string } }[] } | undefined)?.blocks;
      if (!msg4 || !Array.isArray(blocks4)) return;
      if (blocks4.some((b) => b.type === 'artifact' && b.card?.callId === callId)) return; // 幂等
      st4.appendAssistantBlock(sid, assistantId, {
        type: 'artifact',
        card: {
          callId,
          rendererType: String(inner.rendererType),
          title: String(inner.title ?? '产物'),
          status: 'ready',
          data: (inner.data ?? {}) as Record<string, unknown>,
        },
      });
      return;
    }

    if (envelope.kind === 'message.reasoning' && inner.delta) {
      armWatchdog();
      pushReasoning(inner.delta);
    } else if (envelope.kind === 'stream.retry') {
      hooks?.onRetry?.(inner.attempt ?? 0, inner.maxAttempts ?? 10, inner.chars ?? 0);
      armWatchdog();
    } else if (envelope.kind === 'message.truncated') {
      useSessionStore.getState().appendAssistantBlock(sid, assistantId, {
        type: 'truncated',
        text: inner.text ?? '回复因达到输出上限被截断',
      });
    } else if (envelope.kind === 'message.continued') {
      armWatchdog();
      useSessionStore.getState().appendAssistantBlock(sid, assistantId, {
        type: 'notice',
        text: `[已自动续写 ${inner.attempt ?? '?'}/${inner.max ?? 3}${inner.reason === 'tool-truncated' ? ' · 工具参数被截断，已引导重试' : inner.reason === 'reasoning-exhausted' ? ' · 思考耗尽预算，已引导直出结论' : ''}]`,
      });
    } else if (envelope.kind === 'message.delta' && inner.delta) {
      armWatchdog();
      pushDelta(inner.delta);
    } else if (envelope.kind === 'message.done') {
      settle();
    } else if (envelope.kind === 'stream.error') {
      flushDelta();
      const detail = (inner as { message?: string }).message ?? '';
      if (detail.includes('登录已过期') || detail.includes('SESSION_REQUIRED')) {
        hooks?.onAuthExpired?.();
        return;
      }
      useSessionStore.getState().appendAssistantBlock(sid, assistantId, { type: 'text', text: `${detail || '流式请求失败'}` });
      settle();
    }
  };

  const turn: LiveTurn = {
    dispatch: (payload) => {
      const envelope = payload as StreamEnvelope;
      // 旁听层（ai-events 取证）：形状保持 envelope 原样
      hooks?.onEvent?.(envelope);
      handleEnvelope(envelope);
    },
    settle,
    isSettled: () => settled,
  };

  liveTurns.set(sid, turn);
  armWatchdog(); // 首个 delta 之前就无响应（上游挂住）也能软提示
  return turn;
}

/**
 * 挂载一个「已在执行」的 run（页面重开 / 切进执行中的会话）。
 *
 * 顺序有意如此（先挂渲染器、后订阅 SSE）：订阅会**立即重放** lastSeq 之后的事件，
 * 渲染器必须已在位，否则首批事件（常常就是 tool.card）会被丢掉——这正是
 * 「重开后工具卡不出、要等正文」的直接原因。
 *
 * 返回 false 表示会话还没拉到本地（由调用方稍后重试）。
 */
export function attachRunnerLive(att: RunnerAttach, hooks?: LiveTurnHooks): boolean {
  const { sessionId: sid, assistantId } = att;
  if (!sid || !assistantId) return false;
  if (liveTurns.has(sid)) return true;
  const st = useSessionStore.getState();
  const session = st.sessions.find((s) => s.id === sid);
  if (!session) return false;

  const existing = session.messages.find((m) => m.id === assistantId);
  if (existing) {
    // 快照来自 chat-store：streaming 恒为 false（服务端不落交互态），这里按 run 存活复位，
    // 输入框才会从「发送」变回「停止」，MessageStream 也会重新走 live 渲染。
    st.updateMessage(sid, assistantId, { streaming: true });
  } else {
    st.appendMessage(sid, {
      id: assistantId,
      role: 'assistant',
      content: '',
      blocks: [],
      createdAt: Date.now(),
      streaming: true,
    } as unknown as StoreMessage);
  }
  // 服务端直写会话档：本端只渲染，不参与 flushDirty 推送
  markRunnerOwned(sid);
  createLiveTurn({
    sessionId: sid,
    assistantId,
    hooks: {
      ...hooks,
      // 收敛后补一次对账：把本轮服务端落档的最终版（含 endedAt）拉回来
      onSettle: () => {
        hooks?.onSettle?.();
        setTimeout(() => { void pullNow(); }, 800);
      },
    },
  });
  // 渲染器就位后再订阅：重放的事件立刻有人接
  subscribeRunner(att);
  return true;
}
