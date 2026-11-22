/**
 * goal-keeper 插件：目标守护（纯插件实现，零宿主改动）。
 *
 * v3（/goal 斜杠命令驱动，Claude Code 风格）：
 * - goal 工具（cap.tool.goal，只读）：AI 每轮经它读取当前会话目标状态；
 *   description 即模型可见协议：/goal = 用户已正式登记目标，立即实施不请示；
 * - /goal 命令族（监听 user.prompt）：/goal <内容> 登记/覆盖目标、/goal-status、
 *   /goal-done、/goal-abandon；非命令族消息完全不响应；
 * - 检查编排（保留 v1）：message.done(interrupted) 立即检查，正常结束按节流；
 *   /goal 登记后 turnsSinceCheck 清零 → 下一轮 message.done 即触发首次检查；
 * - 结论命中 notifyOn 弹交互卡（achieved/interrupted），选项回流可关/再验/放弃。
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
 * 「继续推进」仅更新面板提示文案，绝不自动注入对话；goal 工具只读（danger:'read'），
 * 目标只能由用户经 /goal 命令或面板设置。
 */
import type { LitePlugin, SlotHostApi } from '@sdk';
import { GoalKeeperPanel } from './Panel';
import { setGoalApi, loadGoal, saveGoal, notifyChanged } from './store';
import { runGoalCheck, shouldCheck } from './check';
import { newGoal, type GoalRecord, type GoalVerdict, type VerdictOutcome } from './model-types';
import './panel.css';

/** 同会话检查互斥（sessionId → 检查中标志） */
const checking = new Map<string, boolean>();
/** 检查期间的 message.done 合并标志（检查完成后若 dirty 再补检一次） */
const dirty = new Map<string, boolean>();

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

/** 结论 → 交互卡文案与选项 */
function cardFor(v: { outcome: string; evidence: string; gap: string }, goalText: string): { title: string; options: string[] } | null {
  switch (v.outcome) {
    case 'achieved':
      return {
        title: `check: [达成] 目标已达成：${goalText}${v.evidence ? `（${v.evidence}）` : ''}`,
        options: ['关闭目标', '再验证一次', '保持关注'],
      };
    case 'interrupted':
      return {
        title: `check: [中断] 目标推进被中断：${goalText}${v.evidence ? `（${v.evidence}）` : ''}`,
        options: ['继续推进（手动）', '放弃目标'],
      };
    default:
      return null; // partial/not_started/unknown 默认静默（面板可见）
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

async function performCheck(api: SlotHostApi, sessionId: string, reason: 'turn' | 'interrupt', messageId?: string): Promise<void> {
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
    const next: GoalRecord = {
      ...goal,
      lastCheckedAt: Date.now(),
      turnsSinceCheck: 0,
      checkCount: goal.checkCount + 1,
      lastVerdict: finalVerdict,
    };
    await saveGoal(sessionId, next);
    notifyChanged();
    if (next.settings.notifyOn.includes(finalOutcome)) {
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
    version: '0.3.0',
    capabilities: ['cap.kv', 'cap.model.admin', 'cap.interactive', 'cap.agent.loop'],
    provides: ['cap.tool.goal'],
    events: ['cap.agent.loop:event', 'interactive.answered', 'user.prompt', 'tool-registered'],
    contributes: {
      slots: [{ slot: 'panel', component: 'GoalKeeperPanel', order: 26, title: '目标' }],
    },
  },
  setup(api: SlotHostApi) {
    setGoalApi(api);

    // goal 工具（只读）：agent-loop discoverTools 经 describe 收录，模型无参调用
    api.registerCapability.register('cap.tool.goal', createGoalHandler() as never);
    api.emit('tool-registered', { cap: 'cap.tool.goal', name: 'goal' });

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

    // 触发源：agent-loop 轮次完成（正常/中断）；信封 = { source, kind, payload }
    api.listen('cap.agent.loop:event', (raw: unknown) => {
      const env = raw as StreamEnvelope | null;
      if (env?.kind !== 'message.done') return;
      const ev = (env?.payload ?? {}) as LoopEvent;
      if (!ev.sessionId) return;
      const interrupted = ev.interrupted === true;
      void (async () => {
        const goal = await loadGoal(ev.sessionId!);
        if (!goal || goal.status !== 'active') return;
        if (interrupted) {
          // 中断立即检查（不管节流）
          void performCheck(api, ev.sessionId!, 'interrupt', ev.messageId);
          return;
        }
        const next: GoalRecord = { ...goal, turnsSinceCheck: goal.turnsSinceCheck + 1 };
        await saveGoal(ev.sessionId!, next);
        if (shouldCheck(next, Date.now())) void performCheck(api, ev.sessionId!, 'turn', ev.messageId);
      })();
    });

    // 交互卡作答回流：interactive-cards 的 answered 载荷 = { callId, answer, kind, title, sessionId, messageId }
    // （无 __source 字段；按标题前缀识别本插件卡片——cmd:/check: 前缀在 dispatch 前写入 title）
    api.listen('interactive.answered', (raw: unknown) => {
      const p = envelopePayload(raw);
      const sid = typeof p.sessionId === 'string' ? p.sessionId : '';
      const title = typeof p.title === 'string' ? p.title : '';
      const sel = String((p.answer as Record<string, unknown> | undefined)?.selected ?? '');
      // 非本插件卡片：直接忽略（不能对其他插件的卡做任何动作）
      if (!title.startsWith('cmd:') && !title.startsWith('check:')) return;
      if (title.startsWith('cmd:')) return; // 命令族确认卡：无副作用
      void (async () => {
        const goal = await loadGoal(sid);
        if (!goal) return;
        if (sel.includes('关闭目标') || sel.includes('标记达成')) {
          await saveGoal(sid, { ...goal, status: 'done' });
          notifyChanged();
        } else if (sel.includes('放弃')) {
          await saveGoal(sid, { ...goal, status: 'abandoned' });
          notifyChanged();
        } else if (sel.includes('再验证')) {
          const verdict: GoalVerdict = await runGoalCheck(api, { sessionId: sid, goalText: goal.goalText });
          await saveGoal(sid, {
            ...goal,
            lastCheckedAt: Date.now(),
            checkCount: goal.checkCount + 1,
            turnsSinceCheck: 0,
            lastVerdict: verdict,
          });
          notifyChanged();
        }
        // 「保持关注」「继续推进（手动）」「知道了」：不注入对话——防自激红线
      })();
    });
  },
};

export { GoalKeeperPanel };
export default goalKeeperPlugin;
