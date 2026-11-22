/**
 * goal-keeper 面板存取（薄封装：Panel 不直接依赖 host api 单例细节）。
 */
import { newGoal, type GoalRecord } from './model-types';
import { loadGoal as load, saveGoal as save, removeGoal as remove } from './store';

export { currentSessionId } from './store';

export function newGoalOf(goalText: string): GoalRecord {
  return newGoal(goalText);
}

export async function loadGoal(sessionId: string): Promise<GoalRecord | null> {
  return load(sessionId);
}

export async function saveGoal(sessionId: string, goal: GoalRecord): Promise<void> {
  await save(sessionId, goal);
}

export async function removeGoal(sessionId: string): Promise<void> {
  await remove(sessionId);
}
