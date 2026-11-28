/**
 * video-gen 插件的工具声明（video）：文生视频。
 * 异步任务型：提交 → 轮询（每 5s，上限 10 分钟）→ mp4 落盘 → media-push 视频卡。
 */
export function registerVideoTool(registry) {
  registry.registerTool({
    name: 'video',
    descriptor: {
      type: 'function',
      function: {
        name: 'video',
        description:
          '文生视频：按文字描述生成短视频，视频卡片直接出现在对话里（可播放/下载/全屏）。' +
          '生成耗时约 1-5 分钟（工具调用会同步等待）。prompt 描述画面内容与镜头运动。',
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: '画面描述（内容/风格/镜头）' },
            duration: { type: 'number', description: '时长秒数（可选，取决于上游支持）' },
            quality: { type: 'string', description: '画质档位（可选，如 quality/Speed）' },
          },
        },
        required: ['prompt'],
      },
    },
    // 生成会花钱：默认需要审批确认（区别于其它媒体工具的 noApproval）
    noApproval: false,
    async invoke({ args, run, call, signal, host }) {
      const prompt = String(args.prompt ?? '').trim();
      if (!prompt) return { ok: false, stdout: '', stderr: '[生成失败] 缺少 prompt 参数' };
      const r = await host.callEndpoint('/api/video-gen/video', {
        prompt,
        duration: args.duration ? Number(args.duration) : null,
        quality: args.quality ? String(args.quality) : '',
      }, signal);
      const j = r.json ?? {};
      if (!r.ok || j.ok === false) {
        return { ok: false, stdout: '', stderr: `[生成失败] ${j.error ?? `HTTP ${r.status}`}` };
      }
      const m = await host.callEndpoint('/api/media/push', {
        path: j.outFile,
        title: prompt.slice(0, 24) + (prompt.length > 24 ? '…' : ''),
        sessionId: run.sessionId,
      }, signal);
      const mj = m.json ?? {};
      if (!m.ok || mj.ok === false) {
        return { ok: false, stdout: '', stderr: `[生成成功但推送失败] ${mj.error ?? `HTTP ${m.status}`}` };
      }
      host.emit(run, 'artifact.created', {
        sessionId: run.sessionId, messageId: run.assistantId, callId: call.id,
        rendererType: 'media', title: String(mj.title ?? '视频'),
        data: { url: mj.url, id: mj.id, kind: mj.kind, ext: mj.ext, mime: mj.mime, bytes: mj.bytes },
      });
      return {
        ok: true,
        stdout: `[视频已生成] ${Math.round((j.bytes ?? 0) / 1024 / 1024)}MB（${j.model}），用户对话中已出现视频卡片，可直接播放。`,
        stderr: '',
      };
    },
  });
}
