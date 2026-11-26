/**
 * translate 在服务端执行域的工具声明（translate）。
 * 翻译仍走本插件自己的 /api/translate/translate（签名/错误码/LRU 缓存原样生效）。
 */
const FEEDBACK_CAP = 8 * 1024;

export function registerTranslateTool(registry) {
  registry.registerTool({
    name: 'translate',
    descriptor: {
      type: 'function',
      function: {
        name: 'translate',
        description: '把文本翻译成目标语言。to 从 zh/en/jp/kor/fra/de/ru/spa/wyw 选；不传时含中文译英语、否则译中文。文本 ≤6000 字。',
        parameters: { type: 'object', properties: { text: { type: 'string' }, to: { type: 'string' } }, required: ['text'] },
      },
    },
    async invoke({ args, signal, host }) {
      const text = String(args.text ?? '').trim();
      if (!text) return { ok: false, stdout: '', stderr: 'text 不能为空' };
      const to = args.to ? String(args.to) : (/[\u4e00-\u9fff]/.test(text) ? 'en' : 'zh');
      const r = await host.callEndpoint('/api/translate/translate', { text, to }, signal);
      const j = r.json ?? {};
      const ok = r.ok && j.ok !== false;
      return { ok, stdout: ok ? String(j.text ?? j.translated ?? JSON.stringify(j).slice(0, 2000)).slice(0, FEEDBACK_CAP) : '', stderr: ok ? '' : String(j.error ?? `HTTP ${r.status}`) };
    },
  });
}
