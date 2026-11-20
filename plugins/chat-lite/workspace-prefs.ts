/**
 * 工作目录偏好（chat-lite 私有，独立于 config-manager）。
 *
 * 为什么单独存：全局 activeRoot 存在 config-manager 插件的 prefs 里，插件被禁用/重装即失效，
 * 用户表现为「工作区总是丢」。这里只存 chat-lite 自己的两件事：
 * - defaultWorkspaceId：新对话默认绑定的根（undefined = 跟随全局）
 * - recentWorkspaceIds：最近使用（最多 5），用于快速切回
 *
 * 根是否仍然有效由 /api/fs/roots 实时裁定，偏好里只存 id，不存路径。
 */

const PREFS_KEY = 'chat-lite.workspace-prefs.v1';
const RECENT_LIMIT = 5;

export interface WorkspacePrefs {
  /** 新会话默认绑定的 root id；undefined = 跟随全局默认 */
  defaultWorkspaceId?: string;
  /** 最近使用，最新在前 */
  recentWorkspaceIds: string[];
}

const EMPTY: WorkspacePrefs = { recentWorkspaceIds: [] };

export function loadWorkspacePrefs(): WorkspacePrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...EMPTY };
    const j = JSON.parse(raw) as Partial<WorkspacePrefs>;
    const recent = Array.isArray(j.recentWorkspaceIds)
      ? j.recentWorkspaceIds.filter((x): x is string => typeof x === 'string')
      : [];
    return {
      defaultWorkspaceId: typeof j.defaultWorkspaceId === 'string' ? j.defaultWorkspaceId : undefined,
      recentWorkspaceIds: recent.slice(0, RECENT_LIMIT),
    };
  } catch {
    return { ...EMPTY };
  }
}

export function saveWorkspacePrefs(next: Partial<WorkspacePrefs>): WorkspacePrefs {
  const cur = loadWorkspacePrefs();
  const merged: WorkspacePrefs = {
    defaultWorkspaceId: 'defaultWorkspaceId' in next ? next.defaultWorkspaceId : cur.defaultWorkspaceId,
    recentWorkspaceIds: next.recentWorkspaceIds ?? cur.recentWorkspaceIds,
  };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(merged));
  } catch { /* 配额/隐私模式：降级为内存 */ }
  return merged;
}

/** 记录一次选择（去重后插到最前） */
export function pushRecentWorkspace(id: string): void {
  const cur = loadWorkspacePrefs();
  const next = [id, ...cur.recentWorkspaceIds.filter((x) => x !== id)].slice(0, RECENT_LIMIT);
  saveWorkspacePrefs({ recentWorkspaceIds: next });
}

/** 根表变化（登记/改名/删除）广播：让输入区的目录名与列表即时同步 */
type RootsListener = () => void;
const rootsListeners = new Set<RootsListener>();

export function onRootsChanged(fn: RootsListener): () => void {
  rootsListeners.add(fn);
  return () => { rootsListeners.delete(fn); };
}

export function notifyRootsChanged(): void {
  rootsListeners.forEach((fn) => {
    try { fn(); } catch { /* 单个订阅者异常不影响其他 */ }
  });
}
