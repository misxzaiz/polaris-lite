/**
 * file-browser 在服务端执行域的工具声明（只读 files 工具）。
 * 读取仍走本插件自己的 /api/fs/*（根白名单/realPath 校验原样生效）。
 */
const FEEDBACK_CAP = 8 * 1024;

function capText(text, cap = FEEDBACK_CAP) {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap / 2)}\n…[输出过长已截断 ${text.length}B]…\n${text.slice(-cap / 2)}`;
}

export function registerFilesTool(registry) {
  registry.registerTool({
    name: 'files',
    descriptor: {
      type: 'function',
      function: {
        name: 'files',
        description:
          '浏览与读取文件（只读）。动作：roots 列出工作区根；list 列目录；read 读文件。path 传相对工作区根的相对路径。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['roots', 'list', 'read'] },
            rootId: { type: 'string' }, path: { type: 'string' },
            head: { type: 'number' }, tail: { type: 'number' },
          },
          required: ['action'],
        },
      },
    },
    async invoke({ args, run, signal, host }) {
      const action = String(args.action ?? '');
      async function pickRoot() {
        if (args.rootId ?? run.boundRootId) return args.rootId ?? run.boundRootId;
        const rr = await host.get('/api/fs/roots', signal);
        const roots = rr.json?.roots ?? [];
        return (roots.find((x) => x.builtin) ?? roots[0])?.id;
      }
      if (action === 'roots') {
        const r = await host.get('/api/fs/roots', signal);
        const roots = r.json?.roots ?? [];
        const summary = roots.length
          ? `roots=${roots.length}: ${roots.map((x) => `${x.label}（id=${x.id}, path=${x.path}${x.builtin ? ', builtin' : ''}）`).join('; ')}`
          : '（无登记根）';
        return { ok: r.ok, stdout: `[files 完成] ${summary}`, stderr: r.ok ? '' : `HTTP ${r.status}` };
      }
      if (action === 'list' || action === 'read') {
        const rootId = await pickRoot();
        if (!rootId) return { ok: false, stdout: '', stderr: 'rootId required（且无可用默认根）' };
        const q = new URLSearchParams({ rootId, path: String(args.path ?? '') });
        if (action === 'read') {
          if (args.head) q.set('head', String(args.head));
          if (args.tail) q.set('tail', String(args.tail));
        }
        const r = await host.get(`/api/fs/${action}?${q}`, signal);
        const j = r.json ?? {};
        if (!r.ok) return { ok: false, stdout: '', stderr: `[files 工具执行失败] ${action} 失败：${j.error ?? `HTTP ${r.status}`}` };
        if (action === 'read') {
          if (j.tooLarge) return { ok: false, stdout: '', stderr: `[files 工具执行失败] ${j.hint ?? '文件过大'}` };
          if (j.isText === false) return { ok: false, stdout: '', stderr: '[files 工具执行失败] 二进制文件不支持文本读取' };
          return { ok: true, stdout: `[files 完成] read ok（${j.size ?? '?'}B，path=${args.path ?? ''}）：\n${capText(String(j.text ?? ''), 2000)}`, stderr: '' };
        }
        const summary = `list ok（${(j.entries ?? []).length} 项，rootId=${rootId}，path=${args.path ?? ''}）`;
        return { ok: true, stdout: `[files 完成] ${summary}`, stderr: '' };
      }
      return { ok: false, stdout: '', stderr: `unknown fs action: ${action}（可用：roots/list/read）` };
    },
  });
}
