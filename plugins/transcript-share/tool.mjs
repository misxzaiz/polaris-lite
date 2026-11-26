/**
 * transcript-share 在服务端执行域的工具声明（transcript）。
 * 分享/转录仍走本插件自己的 /api/share/*（token/TTL/只读围栏原样生效）。
 */
const FEEDBACK_CAP = 8 * 1024;

export function registerTranscriptTool(registry) {
  registry.registerTool({
    name: 'transcript',
    descriptor: {
      type: 'function',
      function: {
        name: 'transcript',
        description:
          '对话过程分享与转录读取（只读）。动作：share=为指定会话生成只读分享链接（sessionId 必填；ttlMs 1h~30d 默认 24h；live 默认 true），返回 { url, token, expiresAt }，把 url 告诉用户即可；' +
          'transcript=读取会话结构化转录（sessionId 必填），含每条消息与全部工具调用，供复盘；list=列出活动分享；revoke=吊销分享（token 必填）。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['share', 'transcript', 'list', 'revoke'] },
            sessionId: { type: 'string' }, ttlMs: { type: 'number' }, live: { type: 'boolean' },
            token: { type: 'string' },
          },
          required: ['action'],
        },
      },
    },
    async invoke({ args, signal, host }) {
      const action = String(args.action ?? '');
      if (action === 'share' || action === 'transcript') {
        const sid = String(args.sessionId ?? '').trim();
        if (!sid) return { ok: false, stdout: '', stderr: 'sessionId required' };
        const r = await host.callEndpoint('/api/share/create', {
          sessionId: sid,
          ...(action === 'share' && args.ttlMs !== undefined ? { ttlMs: Number(args.ttlMs) } : {}),
          ...(action === 'share' ? { live: args.live !== false } : { ttlMs: 3600_000, live: false }),
        }, signal);
        const j = r.json ?? {};
        if (!r.ok || !j.ok) return { ok: false, stdout: '', stderr: String(j.error ?? `HTTP ${r.status}`) };
        if (action === 'share') return { ok: true, stdout: JSON.stringify({ url: j.url, token: j.token, expiresAt: j.expiresAt, live: j.live }), stderr: '' };
        const r2 = await host.callEndpoint(`/share/${j.token}/json`, {}, signal);
        const t = r2.json;
        if (!r2.ok || !t) return { ok: false, stdout: '', stderr: `transcript fetch failed: HTTP ${r2.status}` };
        return { ok: true, stdout: JSON.stringify(t).slice(0, FEEDBACK_CAP), stderr: '' };
      }
      if (action === 'list') {
        const r = await host.callEndpoint('/api/share/list', {}, signal);
        return { ok: r.ok, stdout: JSON.stringify(r.json ?? {}).slice(0, FEEDBACK_CAP), stderr: r.ok ? '' : `HTTP ${r.status}` };
      }
      if (action === 'revoke') {
        const token = String(args.token ?? '').trim();
        if (!token) return { ok: false, stdout: '', stderr: 'token required' };
        const r = await host.callEndpoint('/api/share/revoke', { token }, signal);
        const j = r.json ?? {};
        return { ok: r.ok && j.ok !== false, stdout: JSON.stringify(j).slice(0, 2000), stderr: r.ok ? '' : String(j.error ?? `HTTP ${r.status}`) };
      }
      return { ok: false, stdout: '', stderr: `unknown action: ${action}（可用：share/transcript/list/revoke）` };
    },
  });
}
