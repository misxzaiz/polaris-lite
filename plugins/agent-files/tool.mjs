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
        description: '结构化写入与编辑工作区文件（写面；读用 files 工具）。动作：write 写整文件；edit 精确替换；patch 多文件补丁。只能写工作区内。',
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
    /** 审批钩子（2026-11-28 引入，2026-11-28 当晚按用户决策停用强制闸门：
     *  信任模式支持任意操作，仓库写入不再强制审批卡。钩子机制保留（宿主能力），
     *  策略注入已断开；未来需要恢复时在 server.mjs 重新注入 needsWriteApproval 即可。 */
    async needsApproval({ args, run }) {
      return false;
    },
    async invoke({ args, run, signal, host }) {
      const payload = { ...args, ...(args.rootId ? {} : { rootId: run.boundRootId }), sessionId: run.sessionId, approved: true };
      const r = await host.callEndpoint('/api/files-write/exec', payload, signal);
      const j = r.json ?? {};
      return { ok: r.ok && j.ok !== false, exitCode: j.exitCode ?? (r.ok ? 0 : 1), stdout: j.stdout ?? JSON.stringify(j).slice(0, 2000), stderr: j.error ?? '', durationMs: j.durationMs, denied: j.denied };
    },
  });
}
