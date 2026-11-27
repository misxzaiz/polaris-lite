/**
 * token-ledger 插件：Token 总用量台账 v2（电脑存储版）。
 *
 * v2 变化：权威存储从浏览器 IndexedDB 改为 cap.kv（服务端 sqlite，
 * <dataDir>/stores/kv-store.db）——换浏览器/清缓存数据仍在，多端同一份账。
 * 明细按天分桶、按月分页；大数走 totals 聚合键；旧 IndexedDB 首次启动自动迁移。
 *
 * 去重说明：agent-loop 会把引擎事件转发一份（messageId = assistantId），
 * runner 原始事件的 messageId 是 `${assistantId}::t${turn}`——两者 sessionId
 * 相同但 messageId 不同，会记两条。因此以 messageId 含 `::t` 判定 runner 原始
 * 通道并跳过，优先记 agent-loop 转发的那份（与 ai-events 同一约定）。
 */
import type { LitePlugin, SlotHostApi } from '@sdk';
import { recordUsage, setLedgerApi, backfillFromRequests, backfillFromAgentRuns, flush } from './ledgerStore';
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
    version: '0.3.0',
    capabilities: ['cap.kv'],
    provides: [],
    // listen 是 fail-closed：事件名须同时出现在 manifest 与 grants.json
    events: ['cap.ai.chat:event', 'cap.ai.chat.runner:event'],
    contributes: {
      // panel 槽位 order 43（1-33 已被占用）；title ≤4 字防 tab 截断
      slots: [{ slot: 'panel', component: 'LedgerPanel', order: 43, title: '台账' }],
    },
  },
  setup(api: SlotHostApi) {
    setLedgerApi(api);
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
    // 丢账修复（v0.3.0）：backfillVer < 3 的账本只记了每消息第一轮，
    // 服务端 agent-runs 有全量逐轮原件——升级后自动重导一次，幂等可重试。
    void (async () => {
      const n1 = await backfillFromRequests();
      const n2 = await backfillFromAgentRuns();
      if (n1 + n2 > 0) await flush();
    })();

    api.listen('cap.ai.chat.runner:event', (raw) => {
      const wrap = raw as { payload?: unknown };
      onEvent((wrap.payload ?? raw) as Record<string, unknown>);
    });
  },
};

export { LedgerPanel };

export default tokenLedgerPlugin;
