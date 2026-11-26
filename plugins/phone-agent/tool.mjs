/**
 * phone-agent 在服务端执行域的工具声明（phone）。
 * 下发仍走本插件自己的 /api/phone/command（等手机 SSE 结果）。
 */
const FEEDBACK_CAP = 8 * 1024;

export function registerPhoneTool(registry) {
  registry.registerTool({
    name: 'phone',
    descriptor: {
      type: 'function',
      function: {
        name: 'phone',
        description:
          '访问用户的手机端点：读/写手机剪贴板、发手机通知、抓取手机当前页面文本。手机必须在线（App 处于打开状态）且用户已在手机上确认允许访问；离线或未确认会返回明确错误，请把错误转述给用户而不是重试。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', description: 'clipboard.read / clipboard.write / notify / page.snap' },
            text: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' },
            timeoutMs: { type: 'number' },
          },
          required: ['action'],
        },
      },
    },
    async invoke({ args, signal, host }) {
      const r = await host.callEndpoint('/api/phone/command', {
        action: String(args.action ?? ''),
        payload: {
          ...(args.text !== undefined ? { text: String(args.text) } : {}),
          ...(args.title !== undefined ? { title: String(args.title) } : {}),
          ...(args.body !== undefined ? { body: String(args.body) } : {}),
        },
        timeoutMs: args.timeoutMs ? Number(args.timeoutMs) : undefined,
      }, signal);
      const j = r.json ?? {};
      const ok = r.ok && j.ok !== false;
      return { ok, stdout: ok ? JSON.stringify(j.result ?? j).slice(0, FEEDBACK_CAP) : '', stderr: ok ? '' : String(j.error ?? `HTTP ${r.status}`) };
    },
  });
}
