/**
 * goal-keeper 检查编排（仅分析，物理只读）。
 *
 * 检查 agent = 一次后台非流式模型调用：
 * - 走 POST /api/model-relay（providerId 经 cap.model.admin resolveActive，与
 *   agent-loop context-compact 的 complete 通道同一形状——后台静默调用先例）；
 * - 不挂任何 tool cap → 模型无工具可调，物理上不可能实施任何操作；
 * - 不经用户对话通道 → 不产生 message.done，无自激循环。
 */
import type { SlotHostApi } from '@sdk';
import { parseVerdict, type GoalVerdict, type VerdictOutcome } from './model-types';
import { fetchSessionTail } from './store';

const SYSTEM_PROMPT =
  '你是一个目标完成度审查员。只依据给定的对话证据判断用户目标的完成状态，' +
  '禁止建议任何实施动作，禁止编造证据。输出严格的 JSON（不要围栏、不要多余文字）：' +
  '{"outcome":"achieved|partial|not_started|unknown","evidence":"判定依据摘要(<=120字)","gap":"差距与建议下一步(<=120字,已完成则留空"}';

export interface CheckInput {
  sessionId: string;
  goalText: string;
}

/** 执行一次检查：返回结构化结论；任何失败返回 outcome='unknown'（静默降级） */
export async function runGoalCheck(api: SlotHostApi, input: CheckInput): Promise<GoalVerdict> {
  const tail = await fetchSessionTail(input.sessionId);
  const now = Date.now();
  if (tail.length === 0) {
    return { outcome: 'unknown', evidence: '无法读取会话内容', gap: '', at: now };
  }
  const historyText = tail.map((m) => `[${m.role}] ${m.text}`).join('\n');
  const userPrompt = `用户目标：${input.goalText}\n\n会话尾部证据（新→旧为原始顺序，最末为最新）：\n${historyText}`;

  let outcome: VerdictOutcome = 'unknown';
  let evidence = '';
  let gap = '';
  try {
    // 供应商解析（与 agent-loop complete 同源）
    const res = await api.dispatch<{ config?: { id?: string; activeModel?: string } }>({
      target: 'cap.model.admin', action: 'resolveActive',
    });
    const providerId = res.ok ? res.data?.config?.id : undefined;
    const model = res.ok ? res.data?.config?.activeModel : undefined;
    if (!providerId) return { outcome: 'unknown', evidence: '无可用模型供应商', gap: '', at: now };

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
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ],
          max_tokens: 500,
        },
      }),
    });
    if (!resp.ok) return { outcome: 'unknown', evidence: `模型调用失败 ${resp.status}`, gap: '', at: now };
    const data = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
    const text = data.choices?.[0]?.message?.content ?? '';
    const parsed = parseVerdict(text);
    outcome = parsed.outcome;
    evidence = parsed.evidence;
    gap = parsed.gap;
  } catch (err) {
    return { outcome: 'unknown', evidence: `检查异常: ${err instanceof Error ? err.message : String(err)}`, gap: '', at: now };
  }
  return { outcome, evidence, gap, at: now };
}

/** 检查节流判断：是否到达本目标该检查的时机 */
export function shouldCheck(
  goal: { status: string; turnsSinceCheck: number; lastCheckedAt: number; settings: { checkEveryNTurns: number } },
  now: number,
): boolean {
  if (goal.status !== 'active') return false;
  const since = now - goal.lastCheckedAt;
  // 从未检查过（lastCheckedAt=0）首轮完成即检；之后按轮数节流
  return goal.lastCheckedAt === 0 || goal.turnsSinceCheck >= goal.settings.checkEveryNTurns || since > 30 * 60 * 1000;
}
