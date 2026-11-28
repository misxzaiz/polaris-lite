/**
 * agent-files 在服务端执行域的工具声明（写面 files_write）。
 * 执行仍走本插件自己的 /api/files-write/exec（路径围栏/二进制拒写/审计原样生效）。
 */
export function registerFilesWriteTool(registry, policy = {}) {
  registry.registerTool({
    name: 'files_write',
    descriptor: {
      type: 'function',
      function: {
        name: 'files_write',
        description: '结构化写入与编辑工作区文件（写面；读用 files 工具）。动作：write 写整文件；edit 精确替换；patch 多文件补丁。只能写工作区内；git 仓库内的写入需要审批确认。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['write', 'edit', 'patch'] },
            path: { type: 'string' }, content: { type: 'string' },
            old_string: { type: 'string' }, new_string: { type: 'string' },
            expected_replacements: { type: 'number' }, patch: { type: 'string' }, rootId: { type: 'string' },
          },
          required: ['action'],
        },
      },
    },
    /** 安全闸门（2026-11-28）：git 仓库内的写一律要求审批卡（yolo/会话信任不豁免）。
     *  判定策略在 server 半边（tool.mjs 不能 import node:fs），经 policy 注入。
     *  编排方（runner）在审批裁决期调用本钩子；抛错按「不拦」处理放行到执行期报错。 */
    async needsApproval({ args, run }) {
      if (typeof policy.needsWriteApproval !== 'function') return false;
      try {
        return policy.needsWriteApproval(args?.rootId ?? run?.boundRootId ?? '', args?.path ?? '') === true;
      } catch { return false; }
    },
    async invoke({ args, run, signal, host }) {
      const payload = { ...args, ...(args.rootId ? {} : { rootId: run.boundRootId }), sessionId: run.sessionId, approved: true };
      const r = await host.callEndpoint('/api/files-write/exec', payload, signal);
      const j = r.json ?? {};
      return { ok: r.ok && j.ok !== false, exitCode: j.exitCode ?? (r.ok ? 0 : 1), stdout: j.stdout ?? JSON.stringify(j).slice(0, 2000), stderr: j.error ?? '', durationMs: j.durationMs, denied: j.denied };
    },
  });
}
