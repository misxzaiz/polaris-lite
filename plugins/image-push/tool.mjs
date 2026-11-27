/**
 * image-push 在服务端执行域的工具声明（push_image）。
 * 执行走本插件自己的 /api/img/push（魔数嗅探/尺寸闸/落盘都在那里）；
 * 产物事件 rendererType=image（chat-lite 按 rendererType 查表渲染，不认识工具名）。
 */
export function registerPushImageTool(registry) {
  registry.registerTool({
    name: 'push_image',
    descriptor: {
      type: 'function',
      function: {
        name: 'push_image',
        description:
          '把电脑上的图片文件发给用户查看：对话中出现可点开、可双指放大缩小的图片卡。' +
          '适用：ego-browser/浏览器截图、工作区图片、生成的图表产物等。' +
          '入参=文件路径（相对路径按当前工作区解析）。' +
          '严禁传 base64/dataURI/URL——大内容过参数会卡死流式通道，一律先落盘再传路径。' +
          '给用户看浏览器内容时：先截图到文件，再调用本工具。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '图片文件路径（绝对路径，或相对当前工作区）' },
            title: { type: 'string', description: '图片标题（给用户看，可省略）' },
          },
          required: ['path'],
        },
      },
    },
    // 只读源文件+落盘副本，无破坏面：免审批（与 plugin-market 同档）
    noApproval: true,
    async invoke({ args, run, call, signal, host }) {
      const r = await host.callEndpoint('/api/img/push', {
        path: String(args.path ?? ''),
        cwd: run.execCwd ?? '',
        title: args.title ? String(args.title) : '',
        sessionId: run.sessionId,
      }, signal);
      const j = r.json ?? {};
      const ok = r.ok && j.ok !== false;
      if (ok) {
        host.emit(run, 'artifact.created', {
          sessionId: run.sessionId, messageId: run.assistantId, callId: call.id,
          rendererType: 'image', title: String(j.title ?? args.title ?? '图片'),
          data: { url: j.url, bytes: j.bytes, mime: j.mime },
        });
        return {
          ok: true,
          stdout: `[图片已发送] ${j.title}（${Math.round((j.bytes ?? 0) / 1024)}KB，${j.mime}）。用户对话中已出现图片卡，可点开放大查看。`,
          stderr: '',
        };
      }
      return { ok: false, stdout: '', stderr: `[图片发送失败] ${j.error ?? `HTTP ${r.status}`}` };
    },
  });
}
