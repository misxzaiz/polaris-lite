/**
 * voice-tts 插件的工具声明（speak）：文字转语音。
 * 合成在服务端（MiMo TTS），产物 wav 落盘后经 media-push 出音频卡。
 */
export function registerSpeakTool(registry) {
  registry.registerTool({
    name: 'speak',
    descriptor: {
      type: 'function',
      function: {
        name: 'speak',
        description:
          '把一段文字转成语音，音频卡片直接出现在对话里（可播放/下载/全屏）。' +
          '音色可选：mimo_default（默认）、冰糖/茉莉（中文女）、苏打/白桦（中文男）、' +
          'Mia/Chloe（英文女）、Milo/Dean（英文男）。单次最多 2000 字。',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '要朗读的文本' },
            voice: { type: 'string', description: '音色 voiceId（可选，默认 mimo_default）' },
            style: { type: 'string', description: '朗读风格指令（可选，如「温柔轻快」）' },
          },
        },
        required: ['text'],
      },
    },
    // 合成只落盘副本，无破坏面：免审批（同 media-push 档）
    noApproval: true,
    async invoke({ args, run, call, signal, host }) {
      const text = String(args.text ?? '').trim();
      if (!text) return { ok: false, stdout: '', stderr: '[合成失败] 缺少 text 参数' };
      const r = await host.callEndpoint('/api/voice-tts/speak', {
        text,
        voice: args.voice ? String(args.voice) : 'mimo_default',
        style: args.style ? String(args.style) : '',
      }, signal);
      const j = r.json ?? {};
      if (!r.ok || j.ok === false) {
        return { ok: false, stdout: '', stderr: `[合成失败] ${j.error ?? `HTTP ${r.status}`}` };
      }
      // 合成完成 → 交给 media-push 出音频卡（callEndpoint 同进程 loopback）
      const m = await host.callEndpoint('/api/media/push', {
        path: j.outFile,
        title: text.slice(0, 24) + (text.length > 24 ? '…' : ''),
        sessionId: run.sessionId,
      }, signal);
      const mj = m.json ?? {};
      if (!m.ok || mj.ok === false) {
        return { ok: false, stdout: '', stderr: `[合成成功但推送失败] ${mj.error ?? `HTTP ${m.status}`}` };
      }
      host.emit(run, 'artifact.created', {
        sessionId: run.sessionId, messageId: run.assistantId, callId: call.id,
        rendererType: 'media', title: String(mj.title ?? '语音'),
        data: { url: mj.url, id: mj.id, kind: mj.kind, ext: mj.ext, mime: mj.mime, bytes: mj.bytes },
      });
      return {
        ok: true,
        stdout: `[语音已生成] ${Math.round((j.bytes ?? 0) / 1024)}KB（${j.voice}），用户对话中已出现音频卡片，可直接播放。`,
        stderr: '',
      };
    },
  });
}
