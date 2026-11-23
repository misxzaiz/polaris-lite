/**
 * goal-keeper 插件：目标守护（纯插件实现，零宿主改动）。
 *
 * v4（无人值守闭环——用户派发即离线场景）：
 * - 检查触发点收窄为「会话中断」：goal active 期间 AI 正常推进不检查不打扰；
 *   message.done(interrupted:true) 才触发审查（正常轮次不再检查——2048 教训：
 *   刚交付就被三选一卡打断）。goal_check 工具作为 AI 主动申报检查点的补充通道。
 * - 审查 AI 结论直接闭环，不再等用户点选：achieved 连续 2 次 → status=done 自动关闭；
 *   partial/not_started 保持 active 静默守护；interrupted 单向通知。用户睡觉也要能走完流程。
 * - 交互卡全部降级为无需作答的通知卡（confirm 形态「知道了」，answered 无副作用）；
 *   手动管理保留在 /goal-status、/goal-done、/goal-abandon 与面板。
 *
 * 事件信封契约（对齐 chat-lite/agent-loop 消费姿势）：
 * - 流式通道（cap.agent.loop:event）：宿主 broadcastStream 注入的
 *   { source, kind, payload }，业务字段在 payload 内（v1 直接读信封顶层是错的）；
 * - 普通事件（user.prompt / interactive.*）：hostRuntime.emit 包装的
 *   { source, payload }；interactive-cards 的 answered 载荷只含
 *   callId/answer/kind/title/sessionId/messageId，无 __source——回流识别改用
 *   卡片标题前缀（cmd: / check:），不再依赖不存在的字段（v1 过滤恒 false，按钮失效）。
 *
 * 交互卡落位：chat-lite 只把带 sessionId+messageId 的卡块挂进对应 assistant 消息。
 * /goal 命令在 user.prompt 时刻（assistant 消息尚未 append）先入队列，等本会话
 * 下一条 assistant 消息出现再 dispatch（v1 只带 sessionId，卡从未渲染）。
 *
 * 防自激红线：检查调用走 /api/model-relay 直连，不经 agent-loop 用户对话通道；
 * goal/goal_check 工具只读（danger:'read'），目标只能由用户经 /goal 命令或面板设置；
 * 通知卡不产生新的对话轮次，无自激回路。
 */
import type { LitePlugin, SlotHostApi } from '@sdk';
import { GoalKeeperPanel } from './Panel';
import { setGoalApi, loadGoal, saveGoal, notifyChanged } from './store';
import { runGoalCheck } from './check';
import { newGoal, type GoalRecord, type VerdictOutcome } from './model-types';
import './panel.css';

/** 同会话检查互斥（sessionId → 检查中标志） */
const checking = new Map<string, boolean>();
/** 检查期间的 message.done 合并标志（检查完成后若 dirty 再补检一次） */
const dirty = new Map<string, boolean>();

/** achieved 自动关闭的保险丝：连续 N 次审查判达成才落 done（防单次误判） */
const ACHIEVED_STREAK_N = 2;

/** 待落位的命令族交互卡（sessionId → 队列）：等本会话 assistant 消息出现后 dispatch */
const pendingCards = new Map<string, { title: string; options: string[] }[]>();
/** 已 dispatch 的 assistant 消息 id（防同一条消息重复落多张卡时重复订阅） */
const watched = new WeakSet<object>();

interface LoopEvent {
  kind?: string;
  sessionId?: string;
  messageId?: string;
  interrupted?: boolean;
}

/** 流式通道信封：{ source, kind, payload:{...} } */
interface StreamEnvelope {
  source?: string;
  kind?: string;
  payload?: LoopEvent;
}

/** 普通事件信封：{ source, payload:{...} } */
interface EventEnvelope {
  source?: string;
  payload?: Record<string, unknown>;
}

/** 从信封解出业务载荷（两种通道同形：业务字段都在 payload） */
function envelopePayload(raw: unknown): Record<string, unknown> {
  const env = raw as EventEnvelope | null;
  return (env?.payload ?? {}) as Record<string, unknown>;
}

/** 检查结论 → 通知卡（无需作答：confirm 形态 +「知道了」，answered 无副作用）。
 *  v4 起不再发「三选一裁决卡」——结论由审查 AI 直接闭环，卡片只做单向告知。 */
function cardFor(v: { outcome: string; evidence: string; gap: string }, goalText: string): { title: string; options: string[] } | null {
  switch (v.outcome) {
    case 'achieved':
      return {
        title: `check: [达成] 目标已达成，已自动关闭：${goalText}${v.evidence ? `（${v.evidence}）` : ''}`,
        options: ['知道了'],
      };
    case 'interrupted':
      return {
        title: `check: [中断] 目标推进被中断，待你回来继续：${goalText}${v.evidence ? `（${v.evidence}）` : ''}${v.gap ? `；建议：${v.gap}` : ''}`,
        options: ['知道了'],
      };
    default:
      return null; // partial/not_started/unknown 静默记录（面板可见）
  }
}

/**
 * dispatch 交互卡；无 messageId 时入队，等该会话出现 assistant 消息再发
 * （chat-lite 按 sessionId+messageId 归块，缺 messageId 的卡会被丢弃）。
 */
function queueOrDispatchCard(
  api: SlotHostApi,
  sessionId: string,
  card: { title: string; options: string[] },
  messageId?: string,
): void {
  if (messageId) {
    void dispatchCard(api, sessionId, messageId, card.title, card.options);
    return;
  }
  const q = pendingCards.get(sessionId) ?? [];
  q.push(card);
  pendingCards.set(sessionId, q);
  watchAssistantMessages(api, sessionId);
}

/** 订阅流通道，盯本会话 assistant 消息出现 → 冲刷待发卡（一次性） */
function watchAssistantMessages(api: SlotHostApi, sessionId: string): void {
  const token = { sessionId };
  if (watched.has(token)) return;
  watched.add(token);
  const off = api.listen('cap.agent.loop:event', (raw: unknown) => {
    const env = raw as StreamEnvelope | null;
    const p = env?.payload ?? {};
    // assistant 消息出现的首个信号：任意带 messageId 的本轮事件（delta/卡片/完成均可）
    if (p.sessionId !== sessionId || !p.messageId) return;
    off();
    const q = pendingCards.get(sessionId);
    if (!q?.length) return;
    pendingCards.delete(sessionId);
    for (const card of q) void dispatchCard(api, sessionId, p.messageId!, card.title, card.options);
  });
}

async function dispatchCard(
  api: SlotHostApi,
  sessionId: string,
  messageId: string | undefined,
  title: string,
  options: string[],
): Promise<void> {
  try {
    await api.dispatch({
      target: 'cap.interactive',
      action: 'ask',
      payload: {
        kind: 'question',
        title,
        options,
        sessionId,
        ...(messageId ? { messageId } : {}),
      },
    });
  } catch {
    /* interactive-cards 未启用等场景静默降级 */
  }
}

async function performCheck(api: SlotHostApi, sessionId: string, reason: 'turn' | 'interrupt' | 'tool', messageId?: string): Promise<void> {
  if (checking.get(sessionId)) { dirty.set(sessionId, true); return; }
  checking.set(sessionId, true);
  try {
    const goal = await loadGoal(sessionId);
    if (!goal || goal.status !== 'active') return;
    const verdict = await runGoalCheck(api, { sessionId, goalText: goal.goalText });
    // 中断由事件层判定：reason=interrupt 且模型没给出 achieved 时升级为 interrupted
    const finalOutcome: VerdictOutcome =
      reason === 'interrupt' && verdict.outcome !== 'achieved' ? 'interrupted' : verdict.outcome;
    const finalVerdict = { ...verdict, outcome: finalOutcome };
    // achieved 连续 N 次才自动关闭（防单次误判的保险丝）；其余结论保持 active 继续守护
    const streak = finalOutcome === 'achieved' ? (goal.achievedStreak ?? 0) + 1 : 0;
    const autoClose = finalOutcome === 'achieved' && streak >= ACHIEVED_STREAK_N;
    const next: GoalRecord = {
      ...goal,
      lastCheckedAt: Date.now(),
      turnsSinceCheck: 0,
      checkCount: goal.checkCount + 1,
      achievedStreak: streak,
      lastVerdict: finalVerdict,
      ...(autoClose ? { status: 'done' as const } : {}),
    };
    await saveGoal(sessionId, next);
    notifyChanged();
    if (autoClose) {
      // 自动关闭也要让用户回来能看到（无需作答的通知卡）
      const card = cardFor(finalVerdict, next.goalText);
      if (card) queueOrDispatchCard(api, sessionId, card, messageId);
      return;
    }
    if (next.settings.notifyOn.includes(finalOutcome) && finalOutcome !== 'achieved') {
      // 未自动关闭的中断等结论：单向通知卡（无需作答）
      const card = cardFor(finalVerdict, next.goalText);
      if (card) queueOrDispatchCard(api, sessionId, card, messageId);
    }
  } finally {
    checking.set(sessionId, false);
    if (dirty.get(sessionId)) {
      dirty.set(sessionId, false);
      void performCheck(api, sessionId, 'turn');
    }
  }
}

// ===== /goal 命令族 =====

const GOAL_TOOL_DESC =
  '读取当前会话的目标守护状态（目标全文/状态/最近检查结论）。' +
  '协议：①当用户消息以 /goal 开头——表示用户已通过斜杠命令把目标正式登记为本会话目标，' +
  '你应立即调用本工具读取目标全文，然后把它当作任务指派立即开始实施，' +
  '不要请求确认、不要询问要不要开始；' +
  '②当本工具返回 status=active 时，每轮回复前先调用它对齐目标进度，回答要围绕目标推进；' +
  '③当你判断目标已完全达成时，明确宣布「目标已完成」并列出证据；' +
  '④目标只能由用户通过 /goal 命令设置、修改或取消，你没有设置目标的工具。';

const GOAL_DESCRIPTOR = {
  cap: 'cap.tool.goal',
  name: 'goal',
  description: GOAL_TOOL_DESC,
  parameters: { type: 'object', properties: {} },
  danger: 'read' as const,
};

const GOAL_CHECK_DESC =
  '触发一次目标完成度审查（由独立审查 AI 后台判定，非你自己评分）。' +
  '协议：①每完成一个阶段性交付物（文件写入/面板生成/测试通过等），或你判断目标已达成时，' +
  '主动调用本工具申报检查点；②返回结构化结论 achieved/partial/not_started/unknown 与证据；' +
  '③返回 achieved 且连续两次达成时目标将自动关闭——无需请示用户；' +
  '④返回 partial 时会附差距（gap），请继续围绕差距推进；' +
  '⑤会话中断时系统也会自动触发审查，本工具是你主动申报的补充通道。';

const GOAL_CHECK_DESCRIPTOR = {
  cap: 'cap.tool.goal-check',
  name: 'goal_check',
  description: GOAL_CHECK_DESC,
  parameters: { type: 'object', properties: {} },
  danger: 'read' as const,
};

/** goal 工具：无参单动作，恒返回当前会话目标状态（模型只读的眼睛） */
function createGoalHandler(): (req: { action?: string; payload?: unknown }) => Promise<unknown> {
  return async (req) => {
    switch (req.action) {
      case 'describe':
        return { descriptor: GOAL_DESCRIPTOR };
      case 'exec': {
        // agent-loop 通用 exec 路径按 bash 形状消费返回值：
        // exec.ok && exec.exitCode===0 → 工具卡 done，stdout 作为 feedback 喂回模型。
        // 这里恒 ok:true + exitCode:0，把状态 JSON 放进 stdout（capText 截断兜底）。
        const payload = (req.payload ?? {}) as { sessionId?: string };
        const sid = payload.sessionId ?? '';
        let state: unknown;
        if (!sid) {
          state = { status: 'none' };
        } else {
          const goal = await loadGoal(sid);
          state = goal
            ? { status: goal.status, goal: goal.goalText, lastVerdict: goal.lastVerdict ?? null }
            : { status: 'none' };
        }
        return { ok: true, exitCode: 0, stdout: JSON.stringify(state) };
      }
      default:
        return { ok: false, error: `unknown action: ${req.action}` };
    }
  };
}

/** goal_check 工具：AI 主动申报检查点 → 触发独立审查（结论直接闭环） */
function createGoalCheckHandler(api: SlotHostApi): (req: { action?: string; payload?: unknown }) => Promise<unknown> {
  return async (req) => {
    switch (req.action) {
      case 'describe':
        return { descriptor: GOAL_CHECK_DESCRIPTOR };
      case 'exec': {
        const payload = (req.payload ?? {}) as { sessionId?: string; messageId?: string };
        const sid = payload.sessionId ?? '';
        if (!sid) return { ok: true, exitCode: 0, stdout: JSON.stringify({ status: 'none', note: '当前会话未设置目标' }) };
        const goal = await loadGoal(sid);
        if (!goal || goal.status !== 'active') {
          return { ok: true, exitCode: 0, stdout: JSON.stringify({ status: 'none', note: '当前会话没有进行中的目标' }) };
        }
        // 同步触发审查（互斥锁防重入），把审查结论喂回模型
        await performCheck(api, sid, 'tool', payload.messageId);
        const after = await loadGoal(sid);
        return {
          ok: true,
          exitCode: 0,
          stdout: JSON.stringify({
            status: after?.status ?? 'unknown',
            verdict: after?.lastVerdict ?? null,
            note: after?.status === 'done' ? '审查判定目标已达成，目标已自动关闭' : '审查完成，目标继续守护',
          }),
        };
      }
      default:
        return { ok: false, error: `unknown action: ${req.action}` };
    }
  };
}

interface CommandCard {
  title: string;
  options: string[];
}

/** 命令族交互卡选项（确认型，无副作用；answered 回流按标题前缀识别后 no-op） */
function confirmCard(title: string): CommandCard {
  return { title, options: ['知道了'] };
}

/** 处理 /goal 命令族；返回 null 表示不属于命令族（调用方完全忽略） */
async function handleGoalCommand(sessionId: string, text: string): Promise<CommandCard | null> {
  const t = text.trim();

  // 长前缀命令先匹配（/goal-status 等必须先于 /goal 判定）；/goal 精确匹配用锚定正则
  // （\s 或串尾，避免误伤 /goals 等）。
  if (/^\/goal-status(\s|$)/.test(t)) {
    const goal = await loadGoal(sessionId);
    if (!goal) return confirmCard('cmd: 未设置目标。用 /goal 目标内容 设定本会话目标。');
    const v = goal.lastVerdict;
    const verdictLine = v
      ? `最近检查：${v.outcome}${v.evidence ? `（${v.evidence}）` : ''}${v.gap ? `；建议：${v.gap}` : ''}`
      : '尚未检查。';
    return confirmCard(`cmd: 当前目标（${goal.status === 'active' ? '进行中' : goal.status === 'done' ? '已达成' : '已放弃'}）\n${goal.goalText}\n${verdictLine}`);
  }

  if (/^\/goal-done(\s|$)/.test(t)) {
    const goal = await loadGoal(sessionId);
    if (goal) {
      await saveGoal(sessionId, { ...goal, status: 'done' });
      notifyChanged();
    }
    return confirmCard(goal ? 'cmd: 目标已手动关闭。' : 'cmd: 未设置目标，无需关闭。');
  }

  if (/^\/goal-abandon(\s|$)/.test(t)) {
    const goal = await loadGoal(sessionId);
    if (goal) {
      await saveGoal(sessionId, { ...goal, status: 'abandoned' });
      notifyChanged();
    }
    return confirmCard(goal ? 'cmd: 目标已放弃。' : 'cmd: 未设置目标，无需放弃。');
  }

  const m = /^\/goal\s+([\s\S]+)$/.exec(t);
  if (m) {
    const goalText = m[1].trim();
    const existing = await loadGoal(sessionId);
    // 覆盖式登记：已有 active 目标直接更新；清零检查节流 → 下轮 message.done 即首检
    const next: GoalRecord = existing
      ? { ...existing, goalText, status: 'active', turnsSinceCheck: 0 }
      : { ...newGoal(goalText), turnsSinceCheck: 0 };
    await saveGoal(sessionId, next);
    notifyChanged();
    const head = existing && existing.status === 'active' ? '已更新原目标' : '目标已登记';
    return confirmCard(`cmd: ${head}\n${goalText}`);
  }

  if (t === '/goal') {
    return confirmCard('cmd: 用法：/goal 目标内容（例如 /goal 完成 xx 模块并通过验证）');
  }

  return null;
}

export const goalKeeperPlugin: LitePlugin = {
  manifest: {
    id: 'goal-keeper',
    name: '目标守护',
    version: '0.4.0',
    capabilities: ['cap.kv', 'cap.model.admin', 'cap.interactive', 'cap.agent.loop'],
    provides: ['cap.tool.goal', 'cap.tool.goal-check'],
    events: ['cap.agent.loop:event', 'interactive.answered', 'user.prompt', 'tool-registered'],
    contributes: {
      slots: [{ slot: 'panel', component: 'GoalKeeperPanel', order: 26, title: '目标' }],
    },
  },
  setup(api: SlotHostApi) {
    setGoalApi(api);

    // goal（只读状态）+ goal_check（主动申报检查点 → 独立审查闭环）双工具
    api.registerCapability.register('cap.tool.goal', createGoalHandler() as never);
    api.registerCapability.register('cap.tool.goal-check', createGoalCheckHandler(api) as never);
    api.emit('tool-registered', { cap: 'cap.tool.goal', name: 'goal' });
    api.emit('tool-registered', { cap: 'cap.tool.goal-check', name: 'goal_check' });

    // /goal 命令族：旁听用户输入原文（user.prompt 载荷 = { sessionId, messageId, text, at }）
    api.listen('user.prompt', (raw: unknown) => {
      const p = envelopePayload(raw);
      const sid = typeof p.sessionId === 'string' ? p.sessionId : '';
      const text = typeof p.text === 'string' ? p.text : '';
      // 入口守卫覆盖整个命令族（/goal 与 /goal-status/-done/-abandon）；
      // 命令族内部的细分匹配交给 handleGoalCommand（长前缀先判）。
      if (!sid || !/^\/goal(?:-(?:status|done|abandon))?(\s|$)/.test(text.trim())) return; // 非命令族：完全不响应
      void (async () => {
        const card = await handleGoalCommand(sid, text);
        if (card) queueOrDispatchCard(api, sid, card);
      })();
    });

    // 触发源（v4 收窄）：只在「会话中断」时自动派发审查——正常轮次不检查不打扰。
    // AI 主动申报走 goal_check 工具；这里兜底覆盖「AI 忘了申报就中断」的场景。
    api.listen('cap.agent.loop:event', (raw: unknown) => {
      const env = raw as StreamEnvelope | null;
      if (env?.kind !== 'message.done') return;
      const ev = (env?.payload ?? {}) as LoopEvent;
      if (!ev.sessionId || ev.interrupted !== true) return; // 非中断：完全不响应
      void (async () => {
        const goal = await loadGoal(ev.sessionId!);
        if (!goal || goal.status !== 'active') return;
        void performCheck(api, ev.sessionId!, 'interrupt', ev.messageId);
      })();
    });

    // 交互卡作答回流：全部卡片均已通知化（「知道了」），这里只处理用户主动操作
    // （面板/命令族已覆盖关闭/放弃/重验；通知卡的作答无副作用，直接忽略）。
    api.listen('interactive.answered', (raw: unknown) => {
      const p = envelopePayload(raw);
      const sid = typeof p.sessionId === 'string' ? p.sessionId : '';
      const title = typeof p.title === 'string' ? p.title : '';
      const sel = String((p.answer as Record<string, unknown> | undefined)?.selected ?? '');
      // 非本插件卡片：直接忽略（不能对其他插件的卡做任何动作）
      if (!title.startsWith('cmd:') && !title.startsWith('check:')) return;
      if (title.startsWith('check:')) return; // 通知卡：无副作用（结论已自动闭环）
      void (async () => {
        // 命令族卡是确认型；保留 /goal-abandon 之类的命令作为唯一主动操作入口。
        // （旧版「关闭目标/再验证/放弃」选项已从检查卡移除——闭环不依赖用户点选。）
        const goal = await loadGoal(sid);
        if (!goal || sel.includes('放弃')) {
          if (goal && sel.includes('放弃')) {
            await saveGoal(sid, { ...goal, status: 'abandoned' });
            notifyChanged();
          }
          return;
        }
      })();
    });
  },
};

export { GoalKeeperPanel };
export default goalKeeperPlugin;
