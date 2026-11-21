/**
 * transcript-share 插件前端：AI 对话全过程只读分享（needs #069）。
 *
 * 职责：
 * - cap.tool.transcript：AI 分享工具（describe 协议进 agent-loop）。AI 在对话中可
 *   调 share 动作为当前会话生成分享链接、调 transcript 动作读取结构化转录
 *   （AI 用 MCP 看的通道，与分享页同源同数据）；
 * - panel 槽：分享管理面板（会话选择 / 生成链接 / 续期 / 吊销 / 打开复制）。
 *
 * 数据面：同源 fetch 本插件 server 半边（/api/share/*），会话 cookie 鉴权。
 */
import type { CapabilityHandler, LitePlugin, SlotHostApi } from '@sdk';
import { SharePanel } from './Panel';
import './share.css';

const DESCRIPTOR = {
  cap: 'cap.tool.transcript',
  name: 'transcript',
  description:
    '对话过程分享与转录读取（只读）。动作：' +
    'share=为指定会话生成只读分享链接（参数 sessionId 必填；ttlMs 有效期毫秒 1h~30d 默认 24h；live=true 页面近实时刷新），' +
    '返回 { url, token, expiresAt }，把 url 告诉用户即可；' +
    'transcript=读取会话结构化转录（sessionId 必填），返回含每条消息与全部工具调用（command/stdout/stderr/耗时/exit code），' +
    '供你复盘对话中工具使用的问题；' +
    'list=列出活动分享；revoke=吊销分享（token 必填）。内容已脱敏，只读无写路径。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'share | transcript | list | revoke', enum: ['share', 'transcript', 'list', 'revoke'] },
      sessionId: { type: 'string', description: '会话 id（share/transcript 必填）' },
      ttlMs: { type: 'number', description: 'share 有效期（毫秒，1h~30d，默认 24h）' },
      live: { type: 'boolean', description: 'share 是否近实时刷新（默认 true）' },
      token: { type: 'string', description: 'revoke 的分享 token' },
    },
    required: ['action'],
  },
  danger: 'read' as const,
};

function createTranscriptHandler(): CapabilityHandler {
  return async (req) => {
    const p = (req.payload ?? {}) as Record<string, unknown>;
    const action = String(p.action ?? '');
    try {
      if (action === 'describe') {
        return { descriptor: DESCRIPTOR };
      }
      if (action === 'share') {
        const sessionId = String(p.sessionId ?? '').trim();
        if (!sessionId) return { ok: false, error: 'sessionId required' };
        const r = await fetch('/api/share/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            sessionId,
            ...(p.ttlMs !== undefined ? { ttlMs: Number(p.ttlMs) } : {}),
            ...(p.live !== undefined ? { live: p.live !== false } : {}),
          }),
        });
        const j = await r.json().catch(() => null);
        if (!r.ok) return { ok: false, error: j?.error ?? `HTTP ${r.status}` };
        return { ok: true, url: j.url, token: j.token, expiresAt: j.expiresAt, live: j.live };
      }
      if (action === 'transcript') {
        const sessionId = String(p.sessionId ?? '').trim();
        if (!sessionId) return { ok: false, error: 'sessionId required' };
        // AI 读转录 = 创建一个短时分享 + 拉 /share/:token/json（同源同数据，已脱敏）
        const r = await fetch('/api/share/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ sessionId, ttlMs: 60 * 60 * 1000, live: false }),
        });
        const j = await r.json().catch(() => null);
        if (!r.ok || !j?.ok) return { ok: false, error: j?.error ?? `HTTP ${r.status}` };
        const r2 = await fetch(`/share/${j.token}/json`, { credentials: 'omit' });
        const t = await r2.json().catch(() => null);
        if (!r2.ok || !t) return { ok: false, error: `transcript fetch failed: HTTP ${r2.status}` };
        return { ok: true, transcript: t };
      }
      if (action === 'list') {
        const r = await fetch('/api/share/list', { credentials: 'include' });
        const j = await r.json().catch(() => null);
        if (!r.ok) return { ok: false, error: j?.error ?? `HTTP ${r.status}` };
        return { ok: true, items: j.items ?? [] };
      }
      if (action === 'revoke') {
        const token = String(p.token ?? '').trim();
        if (!token) return { ok: false, error: 'token required' };
        const r = await fetch('/api/share/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ token }),
        });
        const j = await r.json().catch(() => null);
        if (!r.ok) return { ok: false, error: j?.error ?? `HTTP ${r.status}` };
        return { ok: true, revoked: !!j.revoked };
      }
      return { ok: false, error: `unknown action: ${action}` };
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message ?? e) };
    }
  };
}

export const transcriptSharePlugin: LitePlugin = {
  manifest: {
    id: 'transcript-share',
    name: '对话分享',
    version: '0.1.0',
    capabilities: [],
    provides: ['cap.tool.transcript'],
    events: ['tool-registered'],
    contributes: {
      slots: [{ slot: 'panel', component: 'SharePanel', order: 25, title: '分享' }],
    },
  },
  setup(api: SlotHostApi) {
    api.registerCapability.register('cap.tool.transcript', createTranscriptHandler());
    // 迟到广播兜底（loop 晚于本插件装配时也能发现工具）
    api.emit('tool-registered', { cap: 'cap.tool.transcript', name: 'transcript' });
  },
};

export { SharePanel };
export default transcriptSharePlugin;
