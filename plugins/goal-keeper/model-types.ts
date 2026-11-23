/** goal-keeper 数据模型（kv namespace='goal-keeper'，key=goal:<sessionId>） */

export type GoalStatus = 'active' | 'done' | 'abandoned';

/** 检查结论（检查 agent 输出的结构化判定） */
export type VerdictOutcome =
  | 'achieved'      // 已达成
  | 'partial'       // 部分完成/进行中
  | 'not_started'   // 尚未开始/无实质进展
  | 'interrupted'   // 中断（事件层判定，非模型输出）
  | 'unknown';      // 无法判定（模型失败/解析失败）

export interface GoalVerdict {
  outcome: VerdictOutcome;
  /** 判定依据摘要（给用户看的证据） */
  evidence: string;
  /** 差距说明（未完成时；同时作为「建议下一步」提示文案） */
  gap: string;
  at: number;
}

export interface GoalSettings {
  /** 距上次检查隔多少轮才再检查（成本节流） */
  checkEveryNTurns: number;
  /** 哪些结论弹交互卡（其余静默记录，面板可见） */
  notifyOn: VerdictOutcome[];
}

export interface GoalRecord {
  goalText: string;
  status: GoalStatus;
  createdAt: number;
  lastCheckedAt: number;
  /** 自上次检查以来经历的对话轮数 */
  turnsSinceCheck: number;
  checkCount: number;
  /** 连续判「达成」的次数（达到 N 次自动关闭的保险丝） */
  achievedStreak?: number;
  lastVerdict?: GoalVerdict;
  settings: GoalSettings;
}

export const DEFAULT_SETTINGS: GoalSettings = {
  checkEveryNTurns: 3,
  notifyOn: ['achieved', 'interrupted'],
};

export function newGoal(goalText: string): GoalRecord {
  return {
    goalText,
    status: 'active',
    createdAt: Date.now(),
    lastCheckedAt: 0,
    turnsSinceCheck: 0,
    checkCount: 0,
    settings: { ...DEFAULT_SETTINGS },
  };
}

/** 从模型输出解析结论 JSON（失败返回 unknown，不阻塞流程） */
export function parseVerdict(text: string): { outcome: VerdictOutcome; evidence: string; gap: string } {
  // 容错提取：模型可能带 ```json 围栏或前后闲话，抓第一个 {..} 块
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const raw = JSON.parse(m[0]) as { outcome?: string; evidence?: string; gap?: string };
      const outcome = ['achieved', 'partial', 'not_started', 'unknown'].includes(String(raw.outcome))
        ? (raw.outcome as VerdictOutcome)
        : 'unknown';
      return {
        outcome,
        evidence: String(raw.evidence ?? '').slice(0, 500),
        gap: String(raw.gap ?? '').slice(0, 500),
      };
    } catch {
      /* fallthrough */
    }
  }
  return { outcome: 'unknown', evidence: text.slice(0, 200), gap: '' };
}
