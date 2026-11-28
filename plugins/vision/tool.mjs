/**
 * vision 插件的工具声明（look）：让 AI 看一张本地图片。
 * 图片经服务端转 base64 直进视觉模型，不过对话流。
 */
export function registerLookTool(registry) {
  registry.registerTool({
    name: 'look',
    descriptor: {
      type: 'function',
      function: {
        name: 'look',
        description:
          '用视觉模型看一张本地图片并返回文字描述：识别图中文字/物体/场景/图表内容皆可。' +
          '入参=图片路径（相对路径按当前工作区解析）+ 可选 prompt（想重点了解什么）。' +
          '图片不会出现在对话里；如需给用户展示图片，另用 push_media 推送。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '图片文件路径（绝对路径，或相对当前工作区）' },
            prompt: { type: 'string', description: '想问图什么/想重点识别什么（可选，缺省=详细描述全图）' },
          },
          required: ['path'],
        },
      },
    },
    // 只读源文件；图片只进 vision API 不进对话流
    noApproval: true,
    async invoke({ args, run, call, signal, host }) {
      const path = String(args.path ?? '').trim();
      if (!path) return { ok: false, stdout: '', stderr: '[看图失败] 缺少 path 参数' };
      const r = await host.callEndpoint('/api/vision/look', {
        path,
        cwd: run.execCwd ?? '',
        prompt: args.prompt ? String(args.prompt) : '',
      }, signal);
      const j = r.json ?? {};
      if (!r.ok || j.ok === false) {
        return { ok: false, stdout: '', stderr: `[看图失败] ${j.error ?? `HTTP ${r.status}`}` };
      }
      return {
        ok: true,
        stdout: `[图片识别结果]（模型 ${j.model}）\n${j.text}`,
        stderr: '',
      };
    },
  });
}
