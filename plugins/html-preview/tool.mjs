/**
 * html-preview 在服务端执行域的工具声明（render 产物工具）。
 * 预览创建仍走本插件自己的 /api/preview/render；产物事件由本插件声明
 * rendererType=html-preview（chat-lite 按 rendererType 查表渲染，不认识工具名）。
 */
export function registerRenderTool(registry) {
  registry.registerTool({
    name: 'render',
    descriptor: {
      type: 'function',
      function: {
        name: 'render',
        description: '生成自包含 HTML 交互面板（小游戏/原型/图表/教具）。HTML 必须自包含：内联 CSS/JS、不引 CDN、不 fetch；改动旧面板传 basePreviewId。',
        parameters: {
          type: 'object',
          properties: { html: { type: 'string' }, title: { type: 'string' }, basePreviewId: { type: 'string' } },
          required: ['html'],
        },
      },
    },
    async invoke({ args, run, call, signal, host }) {
      const r = await host.callEndpoint('/api/preview/render', { html: args.html, title: args.title, basePreviewId: args.basePreviewId, sessionId: run.sessionId }, signal);
      const j = r.json ?? {};
      const ok = r.ok && j.ok !== false;
      const feedback = ok
        ? `[预览已生成] previewId=${j.previewId} 版本=${j.versionLabel ?? '?'} 标题=${j.title ?? '?'}。用户可在对话卡片与「预览」面板中查看运行。`
        : `[预览生成失败] ${j.error ?? `HTTP ${r.status}`}`;
      if (ok) {
        host.emit(run, 'artifact.created', {
          sessionId: run.sessionId, messageId: run.assistantId, callId: call.id,
          rendererType: 'html-preview', title: String(j.title ?? args.title ?? '交互面板'),
          data: { previewId: j.previewId, url: j.url, versionLabel: j.versionLabel },
        });
      }
      return { ok, stdout: ok ? feedback : '', stderr: ok ? '' : feedback };
    },
  });
}
