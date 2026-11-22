/**
 * goal-keeper 面板：目标管理 + 状态卡（进行中/已完成/已中断，含最近检查结论）。
 */
import { useCallback, useEffect, useState } from 'react';
import type { GoalRecord } from './model-types';
import { currentSessionId, loadGoal, saveGoal, newGoalOf } from './panel-store';

const STATUS_LABEL: Record<string, string> = {
  active: '进行中',
  done: '已达成',
  abandoned: '已放弃',
};

const OUTCOME_LABEL: Record<string, string> = {
  achieved: '✅ 已达成',
  partial: '⏳ 进行中',
  not_started: '◻ 尚未开始',
  interrupted: '⛔ 被中断',
  unknown: '❓ 无法判定',
};

export function GoalKeeperPanel() {
  const [sessionId, setSessionId] = useState('');
  const [goal, setGoal] = useState<GoalRecord | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const sid = currentSessionId();
    setSessionId(sid);
    setGoal(sid ? await loadGoal(sid) : null);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const fn = () => void refresh();
    window.addEventListener('goal-changed', fn);
    return () => window.removeEventListener('goal-changed', fn);
  }, [refresh]);

  const create = async () => {
    const t = text.trim();
    if (!t || !sessionId || busy) return;
    setBusy(true);
    try {
      const g = newGoalOf(t);
      await saveGoal(sessionId, g);
      setGoal(g);
      setText('');
    } finally { setBusy(false); }
  };

  const close = async (status: 'done' | 'abandoned') => {
    if (!goal || !sessionId || busy) return;
    setBusy(true);
    try {
      const next = { ...goal, status };
      await saveGoal(sessionId, next);
      setGoal(next);
    } finally { setBusy(false); }
  };

  if (!sessionId) {
    return <div className="gk-panel" data-testid="goal-keeper"><div className="gk-empty">先打开一个会话再设定目标。</div></div>;
  }

  return (
    <div className="gk-panel" data-testid="goal-keeper">
      {!goal || goal.status === 'abandoned' ? (
        <div className="gk-create">
          <div className="gk-title">为当前会话设定目标</div>
          <textarea
            className="gk-input"
            data-testid="gk-goal-input"
            placeholder="例：完成 goal-keeper 插件并在 5000 环境验证通过"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
          />
          <button className="gk-btn" data-testid="gk-goal-save" disabled={!text.trim() || busy} onClick={() => void create()}>
            设定目标
          </button>
          {goal?.status === 'abandoned' ? <div className="gk-note">上一目标已放弃，可重新设定。</div> : null}
        </div>
      ) : (
        <div className="gk-card">
          <div className="gk-row">
            <span className={`gk-badge gk-badge-${goal.status}`}>{STATUS_LABEL[goal.status]}</span>
            <span className="gk-checks">已检查 {goal.checkCount} 次</span>
          </div>
          <div className="gk-goal-text" data-testid="gk-goal-text">{goal.goalText}</div>
          {goal.lastVerdict ? (
            <div className={`gk-verdict gk-verdict-${goal.lastVerdict.outcome}`} data-testid="gk-verdict">
              <div className="gk-verdict-outcome">{OUTCOME_LABEL[goal.lastVerdict.outcome] ?? goal.lastVerdict.outcome}</div>
              {goal.lastVerdict.evidence ? <div className="gk-verdict-evidence">{goal.lastVerdict.evidence}</div> : null}
              {goal.lastVerdict.gap ? <div className="gk-verdict-gap">建议下一步：{goal.lastVerdict.gap}</div> : null}
              <div className="gk-verdict-time">{new Date(goal.lastVerdict.at).toLocaleString('zh-CN', { hour12: false })}</div>
            </div>
          ) : (
            <div className="gk-verdict gk-verdict-none">尚未检查：对话每 {goal.settings.checkEveryNTurns} 轮自动派发检查 agent（仅分析）。</div>
          )}
          {goal.status === 'active' ? (
            <div className="gk-actions">
              <button className="gk-btn gk-btn-ghost" onClick={() => void close('done')}>标记达成</button>
              <button className="gk-btn gk-btn-ghost" onClick={() => void close('abandoned')}>放弃目标</button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

export default GoalKeeperPanel;
