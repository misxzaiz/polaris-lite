/**
 * agent-bash 在服务端执行域的工具声明（runner 只查表派发，不认识 bash）。
 * 执行仍走本插件自己的 /api/tool/exec（模式/denylist/审计原样生效）。
 */
export function registerBashTool(registry) {
  registry.registerTool({
    name: 'bash',
    descriptor: {
      type: 'function',
      function: {
        name: 'bash',
        description:
          '执行 shell 命令。可用于读写文件、运行脚本、安装依赖、调用任意 CLI（cwd 锁定工作区）。写文件优先用 files_write 工具。危险命令会被无条件拒绝。',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: '要执行的命令（完整一行）' },
            timeoutMs: { type: 'number', description: '超时毫秒，默认 30000，上限 300000' },
          },
          required: ['command'],
        },
      },
    },
    async invoke({ args, run, signal, host }) {
      const r = await host.callEndpoint('/api/tool/exec', {
        sessionId: run.sessionId, approved: true,
        command: String(args.command ?? ''),
        timeoutMs: args.timeoutMs ? Number(args.timeoutMs) : undefined,
        cwd: run.execCwd,
      }, signal);
      const j = r.json ?? {};
      return { ok: !!j.ok || r.ok, exitCode: j.exitCode, stdout: j.stdout ?? '', stderr: j.stderr ?? j.error ?? '', durationMs: j.durationMs, truncated: j.truncated, denied: j.denied };
    },
  });
}
