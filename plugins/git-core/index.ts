/**
 * git-core 插件：Git 能力提供方（cap.git）。
 *
 * 职责（能力插件只做转发，不做业务）：
 * 1. describe 动作：返回工具描述（对齐 agent-files 的 describe 协议，将来可挂 agent-loop）；
 * 2. 其余动作转发 POST /api/git/dispatch（服务端半边 server.mjs：白名单 + 根校验 + 写串行）。
 *
 * 动作集（一期九动作，与 server.mjs 白名单一一对应）：
 *   读：get_status / get_worktree_diff / get_worktree_file_diff / get_log / get_branches
 *   写：batch_stage / batch_unstage / commit_changes / checkout_branch
 */
import type { CapabilityHandler, LitePlugin, SlotHostApi } from '@sdk';

interface GitDispatchResult {
  ok: boolean;
  action?: string;
  result?: unknown;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  truncated?: boolean;
  durationMs?: number;
  error?: string;
  code?: string;
}

async function dispatch(payload: Record<string, unknown>): Promise<GitDispatchResult> {
  const resp = await fetch('/api/git/dispatch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(payload),
  });
  const json = (await resp.json().catch(() => null)) as GitDispatchResult | null;
  if (!json) return { ok: false, error: `HTTP ${resp.status}` };
  return json;
}

/** 服务端动作白名单（与 server.mjs READ_ACTIONS/WRITE_ACTIONS 同步维护） */
const ACTIONS: Record<string, string> = {
  get_status: '读取仓库状态（分支/领先落后/三区文件清单）',
  get_worktree_diff: '工作区 numstat（每文件增删行数）',
  get_worktree_file_diff: '单文件工作区 diff 正文',
  get_log: '提交日志（limit ≤ 200，skip 分页）',
  get_branches: '本地分支列表（含当前标记）',
  batch_stage: '批量暂存文件',
  batch_unstage: '批量取消暂存',
  commit_changes: '提交（message 必填；stageAll 可选）',
  checkout_branch: '切换分支（name）',
};

function createGitHandler(): CapabilityHandler {
  return async (req) => {
    const payload = (req.payload ?? {}) as Record<string, unknown>;
    if (req.action === 'describe') {
      return {
        descriptor: {
          cap: 'cap.git',
          name: 'git',
          description:
            'Git 查询与操作（只读浏览 + 受控写）。动作：' +
            Object.entries(ACTIONS).map(([k, v]) => `${k}=${v}`).join('；') +
            '。rootId 从 files 工具的 roots 获取；写动作经服务端串行队列与审计。',
          parameters: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: Object.keys(ACTIONS), description: '要执行的动作' },
              rootId: { type: 'string', description: '工作区根 id（files.roots 返回；缺省内建 workspace）' },
              params: { type: 'object', description: '动作参数（filePath/filePaths/message/name/limit/skip 等）' },
            },
            required: ['action'],
          },
          danger: 'write',
        },
      };
    }
    if (!(req.action in ACTIONS)) return { ok: false, error: `unknown action: ${req.action}` };
    return await dispatch({ action: req.action, rootId: payload.rootId, params: payload.params ?? payload });
  };
}

export const gitCorePlugin: LitePlugin = {
  manifest: {
    id: 'git-core',
    name: 'Git 能力',
    version: '0.1.0',
    capabilities: [],
    provides: ['cap.git'],
    events: [],
    contributes: { slots: [] },
  },
  setup(api: SlotHostApi) {
    api.registerCapability.register('cap.git', createGitHandler());
  },
};

export default gitCorePlugin;
