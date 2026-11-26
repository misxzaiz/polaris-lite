/**
 * browser-lite 在服务端执行域的工具声明（browser 工具）。
 * 派发仍走本插件自己的 /api/browser/dispatch（导航围栏/会话绑定/审计原样生效）。
 */
const FEEDBACK_CAP = 8 * 1024;

export function registerBrowserTool(registry) {
  registry.registerTool({
    name: 'browser',
    descriptor: {
      type: 'function',
      function: {
        name: 'browser',
        description: '驱动系统 Chrome 搜索/阅读/操作网页：search/read/navigate/click/fill/screenshot/tabs 等。优先结构化动作而非 evaluate。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string' }, url: { type: 'string' }, query: { type: 'string' },
            label: { type: 'string' }, selector: { type: 'string' }, value: { type: 'string' }, limit: { type: 'number' },
          },
          required: ['action'],
        },
      },
    },
    async invoke({ args, run, call, signal, host }) {
      const r = await host.callEndpoint('/api/browser/dispatch', { ...args, sessionId: run.sessionId, callId: call.id }, signal);
      const j = r.json ?? {};
      const ok = r.ok && (j.ok !== false);
      const feedback = ok ? `[浏览器操作完成] ${JSON.stringify(j).slice(0, FEEDBACK_CAP)}` : `[浏览器操作失败] ${j.error ?? `HTTP ${r.status}`}`;
      return { ok, stdout: ok ? feedback : '', stderr: ok ? '' : feedback };
    },
  });
}
