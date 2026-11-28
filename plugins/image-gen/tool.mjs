/**
 * image-gen 插件的工具声明（draw）：文生图。
 * 上游在服务端调用（images API），产物 png 落盘后经 media-push 出图片卡。
 */
export function registerDrawTool(registry) {
  registry.registerTool({
    name: 'draw',
    descriptor: {
      type: 'function',
      function: {
        name: 'draw',
        description:
          '文生图：按文字描述生成图片，图片卡片直接出现在对话里（可缩放/下载/全屏）。' +
          'prompt 用中文或英文描述画面内容与风格均可。默认 1 张，最多 4 张。',
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: '画面描述（内容/风格/构图）' },
            size: { type: 'string', description: '尺寸（可选，如 1024x1024；具体支持值取决于上游）' },
            n: { type: 'number', description: '生成张数（可选，1-4，默认 1）' },
          },
        },
        required: ['prompt'],
      },
    },
    // 只调上游生成 + 落盘副本，无破坏面：免审批
    noApproval: true,
    async invoke({ args, run, call, signal, host }) {
      const prompt = String(args.prompt ?? '').trim();
      if (!prompt) return { ok: false, stdout: '', stderr: '[生成失败] 缺少 prompt 参数' };
      const r = await host.callEndpoint('/api/image-gen/draw', {
        prompt,
        size: args.size ? String(args.size) : '',
        n: Number(args.n ?? 1) || 1,
      }, signal);
      const j = r.json ?? {};
      if (!r.ok || j.ok === false) {
        return { ok: false, stdout: '', stderr: `[生成失败] ${j.error ?? `HTTP ${r.status}`}` };
      }
      const results = [];
      for (const f of (j.outFiles ?? [])) {
        const m = await host.callEndpoint('/api/media/push', {
          path: f,
          title: prompt.slice(0, 24) + (prompt.length > 24 ? '…' : ''),
          sessionId: run.sessionId,
        }, signal);
        const mj = m.json ?? {};
        if (m.ok && mj.ok !== false) {
          results.push(mj);
          host.emit(run, 'artifact.created', {
            sessionId: run.sessionId, messageId: run.assistantId, callId: call.id,
            rendererType: 'media', title: String(mj.title ?? '图片'),
            data: { url: mj.url, id: mj.id, kind: mj.kind, ext: mj.ext, mime: mj.mime, bytes: mj.bytes },
          });
        }
      }
      if (!results.length) return { ok: false, stdout: '', stderr: '[生成成功但推送失败]' };
      return {
        ok: true,
        stdout: `[图片已生成] ${results.length} 张（${j.model}），用户对话中已出现图片卡片。`,
        stderr: '',
      };
    },
  });
}
