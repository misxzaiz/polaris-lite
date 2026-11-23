/**
 * git-panel 宿主桥 —— 唯一允许接触 cap 总线的层（对齐 polaris-git bridge.ts 纪律）。
 * 面板组件不直接 dispatch / fetch，一律经此转发，便于 mock 与总线审计归因。
 */
import type { SlotHostApi } from '@sdk';

let api: SlotHostApi | null = null;

export function bindHost(host: SlotHostApi): void {
  api = host;
}

export interface GitStatusFile {
  path: string;
  x: string;
  y: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}
export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  staged: GitStatusFile[];
  unstaged: GitStatusFile[];
  untracked: string[];
  files: GitStatusFile[];
}
export interface GitLogEntry { sha: string; author: string; at: number; message: string }
export interface GitBranch { name: string; current: boolean }
export interface GitNumstat { path: string; additions: number | null; deletions: number | null }

/** cap.git 调用：action + rootId + params（唯一数据通道） */
export async function git<T>(action: string, rootId: string | null, params: Record<string, unknown> = {}): Promise<T> {
  if (!api) throw new Error('git-panel 未绑定宿主（bindHost 未调用）');
  const res = await api.dispatch<Record<string, unknown>>({
    target: 'cap.git',
    action,
    payload: { rootId: rootId ?? undefined, params },
  });
  if (!res.ok) {
    const err = res.error as { message?: string } | undefined;
    throw new Error(err?.message ?? `cap.git ${action} 调用失败`);
  }
  const data = res.data as { result?: T } | undefined;
  return (data?.result ?? (res.data as unknown)) as T;
}

/** 订阅 git-operation 事件（git-core 写动作后广播；一期由面板本地刷新兜底） */
export function listenGitOperation(handler: (payload: unknown) => void): () => void {
  if (!api) return () => {};
  return api.listen('git-operation', handler);
}
