/**
 * token-ledger 插件：Token 总用量台账。
 *
 * 定位（plans 内对应原型讨论的方案 A）：
 * - 纯前端插件，零宿主改动、零 server 半边——卸载即消失，数据自持于
 *   IndexedDB（plite-token-ledger），重装后数据仍在，可被任何实现继续读取。
 * - 事件只读旁听：ai.usage 流末记账，不干扰对话主链路；chat-lite 的
 *   ContextMeter 是「当前会话内存态 16 条」，本插件是「全量持久台账」，
 *   两者数据同源（cap.ai.chat:event / runner 通道），互不依赖。
 * - 历史回填：ai-events 的 requests 表存有原始 SSE usage 帧，首次启动导入。
 *
 * 去重说明：agent-loop 会把引擎事件转发一份（messageId = assistantId），
 * runner 原始事件的 messageId 是 `${assistantId}::t${turn}`——两者 sessionId
 * 相同但 messageId 不同，会记两条。因此以 messageId 含 `::t` 判定 runner 原始
 * 通道并跳过，优先记 agent-loop 转发的那份（与 ai-events 同一约定）。
 */
import type { LitePlugin } from '@sdk';
import { recordUsage } from './ledgerStore';
import { LedgerPanel } from './LedgerPanel';
import './token-ledger.css';

interface UsageEventPayload {
  sessionId?: string;
  messageId?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  cacheCreationTokens?: number;
  durationMs?: number;
  estimated?: boolean;
  model?: string;
}

export const tokenLedgerPlugin: LitePlugin = {
  manifest: {
    id: 'token-ledger',
    name: 'Token 台账',
    version: '0.1.0',
    capabilities: [],
    provides: [],
    // listen 是 fail-closed：事件名须同时出现在 manifest 与 grants.json
    events: ['cap.ai.chat:event', 'cap.ai.chat.runner:event'],
    contributes: {
      // panel 槽位 order 1-33 已占用（最大 33=voice-radio），43 起避开全部；title ≤4 字防 tab 截断
      slots: [{ slot: 'panel', component: 'LedgerPanel', order: 43, title: '台账' }],
    },
  },
  setup(api) {
    const onEvent = (raw: unknown): void => {
      const ev = raw as { kind?: string; payload?: Record<string, unknown> };
      if ((ev.kind ?? '') !== 'ai.usage') return;
      const p = (ev.payload ?? {}) as unknown as UsageEventPayload;
      if (!p.sessionId || !p.messageId) return;
      // runner 原始通道的 messageId 带 ::t 尾标（agent-loop 会转发去尾标版本）；
      // 跳过原始版，避免同一轮记两条账（与 ai-events 的双通道去重约定一致）
      if (p.messageId.includes('::t')) return;
      recordUsage({ ...p, sessionId: p.sessionId, messageId: p.messageId });
    };
    // cap 总线通道（chat-lite 同款事件源）
    api.listen('cap.ai.chat:event', onEvent);
    // runner 通道的 envelope 是 {source, payload}（无 kind），流式事件是 {source, kind, payload}；
      // 与 cap 通道统一交给 onEvent（读 kind === 'ai.usage'）
      api.listen('cap.ai.chat.runner:event', (raw) => {
        const wrap = raw as { payload?: unknown };
        onEvent((wrap.payload ?? raw) as Record<string, unknown>);
      });
  },
};

export { LedgerPanel };

export default tokenLedgerPlugin;
