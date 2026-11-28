/**
 * media-push 在服务端执行域的工具声明（push_media）。
 * 执行走本插件自己的 /api/media/push（魔数嗅探/尺寸闸/落盘都在那里）；
 * 产物事件 rendererType=media（chat-lite 按 rendererType 查表渲染，kind 在 data 里）。
 *
 * 支持单文件（path）与批量（paths，一次产出多个 artifact 块）。
 */
export function registerPushMediaTool(registry) {
  registry.registerTool({
    name: 'push_media',
    descriptor: {
      type: 'function',
      function: {
        name: 'push_media',
        description:
          '把电脑上的任意文件发给用户查看：图片/视频/音频/Excel(csv/xlsx)/PDF/文本代码/压缩包等，' +
          '对话中出现对应卡片（图片可缩放、表格可翻页排序、视频可播放、支持全屏）。' +
          '入参=文件路径（相对路径按当前工作区解析）。类型按文件内容自动识别（魔数），不靠扩展名。' +
          '严禁传 base64/dataURI——大内容过参数会卡死流式通道，一律先落盘再传路径。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '文件路径（绝对路径，或相对当前工作区）。单文件推送用这个' },
            paths: { type: 'array', items: { type: 'string' }, description: '多文件批量推送（可选）；与 path 二选一' },
            title: { type: 'string', description: '卡片标题（给用户看，可省略）' },
          },
        },
      },
    },
    // 只读源文件+落盘副本，无破坏面：免审批（与 image-push 同档）
    noApproval: true,
    async invoke({ args, run, call, signal, host }) {
      const items = [];
      if (Array.isArray(args.paths) && args.paths.length) {
        for (const p of args.paths.slice(0, 20)) items.push(String(p ?? ''));
      } else if (args.path) {
        items.push(String(args.path));
      }
      if (!items.length) return { ok: false, stdout: '', stderr: '[推送失败] 缺少 path 或 paths 参数' };

      const results = [];
      const errors = [];
      for (const item of items) {
        const r = await host.callEndpoint('/api/media/push', {
          path: item,
          cwd: run.execCwd ?? '',
          title: args.title ? String(args.title) : '',
          sessionId: run.sessionId,
        }, signal);
        const j = r.json ?? {};
        const ok = r.ok && j.ok !== false;
        if (!ok) { errors.push(`${item}: ${j.error ?? `HTTP ${r.status}`}`); continue; }
        results.push(j);
        host.emit(run, 'artifact.created', {
          sessionId: run.sessionId, messageId: run.assistantId, callId: call.id,
          rendererType: 'media', title: String(j.title ?? item),
          data: { url: j.url, id: j.id, kind: j.kind, ext: j.ext, mime: j.mime, bytes: j.bytes },
        });
      }
      if (results.length) {
        const summary = results.map((j) => `${j.title}（${j.kind}，${Math.round((j.bytes ?? 0) / 1024)}KB）`).join('、');
        const errNote = errors.length ? `；失败 ${errors.length} 个：${errors.join('；')}` : '';
        return {
          ok: errors.length === 0,
          stdout: `[文件已发送] ${summary}。用户对话中已出现对应卡片，可点开查看/交互。${errNote}`,
          stderr: errors.length ? errors.join('\n') : '',
        };
      }
      return { ok: false, stdout: '', stderr: `[推送失败] ${errors.join('；')}` };
    },
  });
}
