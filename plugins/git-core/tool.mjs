/**
 * git-core 在服务端执行域的工具声明（只读 git 工具）。
 * 执行仍走本插件自己的 /api/git/dispatch（根白名单/动作白名单/写串行/审计原样生效）。
 *
 * 一期只暴露读动作：写动作（stage/commit/checkout）留在 Git 面板人工操作——
 * AI 要提交可走 bash 工具的既有审批链，这里故意不给绕行入口。
 */
const OUT_CAP = 8 * 1024;

function capText(text, cap = OUT_CAP) {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap / 2)}\n…[输出过长已截断]…\n${text.slice(-cap / 2)}`;
}

/** dispatch 响应 → 模型可读文本。result 已由 server 半边解析为结构化 JSON。 */
function formatResult(action, j) {
  const res = j.result;
  if (action === 'status') {
    if (!res) return capText(String(j.stdout ?? ''));
    const files = res.files ?? [];
    const head = `分支 ${res.branch}（ahead ${res.ahead} / behind ${res.behind}）：staged ${res.staged?.length ?? 0}、unstaged ${res.unstaged?.length ?? 0}、untracked ${res.untracked?.length ?? 0}，共 ${files.length} 项改动`;
    const body = files.map((f) => {
      // 直接回放 porcelain 双字母状态（staged x / unstaged y），untracked 用 ??
      const code = f.untracked ? '??' : `${f.x ?? ' '}${f.y ?? ' '}`;
      return `${code} ${f.path}`;
    }).join('\n');
    return capText(`${head}\n${body}`);
  }
  if (action === 'diff') {
    const rows = Array.isArray(res) ? res : [];
    if (!rows.length) return '工作区无改动（干净）';
    return capText(rows.map((r) => `${r.path}  +${r.additions ?? 0} -${r.deletions ?? 0}`).join('\n'));
  }
  if (action === 'file_diff') return capText(String(j.stdout ?? '').trim() || '（无差异）');
  if (action === 'log') {
    const entries = Array.isArray(res) ? res : [];
    if (!entries.length) return '（无提交）';
    return capText(entries.map((e) => {
      const d = new Date((e.at ?? 0) * 1000).toISOString().slice(0, 16).replace('T', ' ');
      return `${e.sha} ${d} ${e.author} ${e.message}`;
    }).join('\n'));
  }
  if (action === 'branches') {
    const list = Array.isArray(res) ? res : [];
    return list.map((b) => `${b.current ? '* ' : '  '}${b.name}`).join('\n') || '（无分支）';
  }
  return capText(String(j.stdout ?? ''));
}

export function registerGitTool(registry) {
  registry.registerTool({
    name: 'git',
    descriptor: {
      type: 'function',
      function: {
        name: 'git',
        description:
          '查看 Git 仓库状态（只读，结构化）。动作：status 分支与改动清单；diff 工作区改动统计（+/-行数）；file_diff 单文件 diff；log 提交历史；branches 分支列表。只读——暂存/提交/切分支等写操作请在 Git 面板人工执行。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['status', 'diff', 'file_diff', 'log', 'branches'] },
            rootId: { type: 'string', description: '工作区根 id（默认用会话绑定根，其次登记的第一个非内建根）' },
            filePath: { type: 'string', description: 'file_diff 用：文件路径（相对仓库根）' },
            limit: { type: 'number', description: 'log 条数，默认 50，上限 200' },
            skip: { type: 'number', description: 'log 跳过条数（翻页）' },
          },
          required: ['action'],
        },
      },
    },
    async invoke({ args, run, signal, host }) {
      const action = String(args.action ?? '');
      const map = { status: 'get_status', diff: 'get_worktree_diff', file_diff: 'get_worktree_file_diff', log: 'get_log', branches: 'get_branches' };
      const apiAction = map[action];
      if (!apiAction) {
        return { ok: false, stdout: '', stderr: `unknown git action: ${action}（可用：status/diff/file_diff/log/branches）` };
      }

      // 根解析：显式 rootId > 会话绑定根 > 登记表第一个非内建根
      // （内建 workspace 不是 git 仓库，dispatch 回退到它只会得到「不是 Git 仓库」）
      let rootId = args.rootId ?? run?.boundRootId ?? '';
      if (!rootId) {
        try {
          const rr = await host.get('/api/fs/roots', signal);
          const roots = rr.json?.roots ?? [];
          rootId = (roots.find((x) => !x.builtin) ?? roots[0])?.id ?? '';
        } catch { /* 保持空：dispatch 会回退并返回可读错误 */ }
      }

      const r = await host.callEndpoint('/api/git/dispatch', {
        action: apiAction,
        rootId,
        ...(action === 'file_diff' && args.filePath ? { filePath: String(args.filePath) } : {}),
        ...(action === 'log' && args.limit ? { limit: Number(args.limit) } : {}),
        ...(action === 'log' && args.skip ? { skip: Number(args.skip) } : {}),
      }, signal);
      const j = r.json ?? {};
      if (!r.ok || j.ok === false) {
        return { ok: false, stdout: '', stderr: `[git 工具执行失败] ${j.error ?? `HTTP ${r.status}`}` };
      }
      return { ok: true, stdout: formatResult(action, j), stderr: '', durationMs: j.durationMs };
    },
  });
}
