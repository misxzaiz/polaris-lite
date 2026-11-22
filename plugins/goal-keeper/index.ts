/**
 * goal-keeper 插件：目标守护（纯插件实现，零宿主改动）。
 *
 * 职责：
 * - panel 槽：目标管理面板（设定/关闭/放弃 + 检查结论展示）；
 * - 事件监听 cap.agent.loop:event：message.done（含 interrupted 标志）→ 判定是否
 *   派发检查 agent（节流 + 防抖 + 同会话互斥）；
 * - 检查 agent：后台非流式模型调用（POST /api/model-relay，context-compact 同款），
 *   不挂任何 tool cap → 物理只读（仅分析，不实施）；
 * - 提示呈现：结论命中 notifyOn 时 dispatch cap.interactive ask 弹交互卡
 *   （目标是否完成/是否继续等），用户经交互卡选项决定关目标/再验证/放弃。
 *
 * 防自激红线：
 * 1. 检查调用走 /api/model-relay 直连，不经 agent-loop 用户对话通道，不产生
 *    message.done 事件 → 无检查→触发检查的死循环；
 * 2. 「继续推进」仅更新 goal.lastVerdict.gap 作为面板提示文案，绝不自动注入对话。
 *
 * 可替换性：provides 为空（纯消费者），卸载即摘除；数据在 kv namespace='goal-keeper'。
 */
import type { LitePlugin, SlotHostApi } from '@sdk';
import { GoalKeeperPanel } from './Panel';
import { setGoalApi, loadGoal, saveGoal, notifyChanged } from './store';
import { runGoalCheck, shouldCheck } from './check';
import type { GoalRecord, VerdictOutcome } from './model-types';
import './panel.css';

/** 同会话检查互斥（sessionId → 检查中标志） */
const checking = new Map<string, boolean>();
/** 检查期间的 message.done 合并标志（检查完成后若 dirty 再补检一次） */
const dirty = new Map<string, boolean>();

interface LoopEvent {
  kind?: string;
  sessionId?: string;
  interrupted?: boolean;
}

/** 结论 → 交互卡文案与选项 */
function cardFor(v: { outcome: string; evidence: string; gap: string }, goalText: string): { title: string; options: string[] } | null {
  switch (v.outcome) {
    case 'achieved':
      return {
        title: `✅ 目标已达成：${goalText}${v.evidence ? `（${v.evidence}）` : ''}`,
        options: ['关闭目标', '再验证一次', '保持关注'],
      };
    case 'interrupted':
      return {
        title: `⛔ 目标推进被中断：${goalText}${v.evidence ? `（${v.evidence}）` : ''}`,
        options: ['继续推进（手动）', '放弃目标'],
      };
    default:
      return null; // partial/not_started/unknown 默认静默（面板可见）
  }
}

async function dispatchCard(
  api: SlotHostApi,
  sessionId: string,
  title: string,
  options: string[],
): Promise<void> {
  try {
    await api.dispatch({
      target: 'cap.interactive',
      action: 'ask',
      payload: { kind: 'question', title, options, sessionId, __source: 'goal-keeper' },
    });
  } catch {
    /* interactive-cards 未启用等场景静默降级 */
  }
}

async function performCheck(api: SlotHostApi, sessionId: string, reason: 'turn' | 'interrupt'): Promise<void> {
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
      if (card) await dispatchCard(api, sessionId, card.title, card.options);
    }
  } finally {
    checking.set(sessionId, false);
    if (dirty.get(sessionId)) {
      dirty.set(sessionId, false);
      void performCheck(api, sessionId, 'turn');
    }
  }
}

export const goalKeeperPlugin: LitePlugin = {
  manifest: {
    id: 'goal-keeper',
    name: '目标守护',
    version: '0.1.0',
    capabilities: ['cap.kv', 'cap.model.admin', 'cap.interactive', 'cap.agent.loop'],
    provides: [], // 纯消费者：不对外提供 cap，保证可替换/可并存
    events: ['cap.agent.loop:event', 'interactive.answered'],
    contributes: {
      slots: [{ slot: 'panel', component: 'GoalKeeperPanel', order: 26, title: '目标' }],
    },
  },
  setup(api: SlotHostApi) {
    setGoalApi(api);

    // 触发源：agent-loop 轮次完成（正常/中断）
    api.listen('cap.agent.loop:event', (payload: unknown) => {
      const ev = (payload ?? {}) as LoopEvent;
      if (ev.kind !== 'message.done' || !ev.sessionId) return;
      const interrupted = ev.interrupted === true;
      void (async () => {
        const goal = await loadGoal(ev.sessionId!);
        if (!goal || goal.status !== 'active') return;
        if (interrupted) {
          // 中断立即检查（不管节流）
          void performCheck(api, ev.sessionId!, 'interrupt');
          return;
        }
        const next: GoalRecord = { ...goal, turnsSinceCheck: goal.turnsSinceCheck + 1 };
        await saveGoal(ev.sessionId!, next);
        if (shouldCheck(next, Date.now())) void performCheck(api, ev.sessionId!, 'turn');
      })();
    });

    // 交互卡作答回流（callId 前缀 gk: 过滤；interactive-cards 的 ask 自生成 callId，
    // answered 事件带 __source 透传时按其过滤，双保险）
    api.listen('interactive.answered', (payload: unknown) => {
      const ev = (payload ?? {}) as { callId?: string; answer?: Record<string, unknown>; sessionId?: string; __source?: string };
      if (ev.__source !== 'goal-keeper') return;
      const sid = ev.sessionId ?? '';
      const sel = String((ev.answer ?? {}).selected ?? '');
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
          const verdict = await runGoalCheck(api, { sessionId: sid, goalText: goal.goalText });
          await saveGoal(sid, {
            ...goal,
            lastCheckedAt: Date.now(),
            checkCount: goal.checkCount + 1,
            turnsSinceCheck: 0,
            lastVerdict: verdict,
          });
          notifyChanged();
        }
        // 「保持关注」「继续推进（手动）」：仅提示文案已在面板（gap），不注入对话——防自激红线
      })();
    });
  },
};

export { GoalKeeperPanel };
export default goalKeeperPlugin;
