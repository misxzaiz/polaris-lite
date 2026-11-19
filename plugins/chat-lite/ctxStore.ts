/**
 * 上下文透视状态（chat-lite 私有，spec：docs/context-insight-plan.md §5.3）。
 *
 * 单写者：全部由引擎/编排事件驱动（ai.usage / context.snapshot / context.compact*），
 * UI 只读。**不进持久化消息流**（localStorage 容量敏感；刷新后由下一轮流恢复）。
 */
import { create } from 'zustand';

/** 最近一轮用量样本（速率展示） */
export interface UsageRecord {
  at: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  tps: number; // outputTokens / durationMs * 1000
  estimated?: boolean;
  model?: string;
}

/** 压缩记录（详情面板回看） */
export interface CompactRecord {
  at: number;
  removedMessages: number;
  tokensBefore: number;
  tokensAfter: number;
  summary: string;
}

/** 会话级上下文策略（chat-lite 持有，发送时透传给 agent-loop） */
export interface CtxPolicy {
  autoCompact: boolean;
  threshold: number;
  keepRecent: number;
}

export const DEFAULT_CTX_POLICY: CtxPolicy = { autoCompact: true, threshold: 0.75, keepRecent: 6 };
/** 策略持久化键（与会话同库，但独立命名空间） */
const POLICY_KEY = 'chat-lite.ctx-policies.v1';

function loadPolicies(): Record<string, CtxPolicy> {
  try {
    const raw = localStorage.getItem(POLICY_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, Partial<CtxPolicy>>;
    const out: Record<string, CtxPolicy> = {};
    for (const [k, v] of Object.entries(parsed)) {
      out[k] = {
        autoCompact: v.autoCompact !== false,
        threshold: clampThreshold(v.threshold),
        keepRecent: clampKeepRecent(v.keepRecent),
      };
    }
    return out;
  } catch {
    return {};
  }
}

function savePolicies(p: Record<string, CtxPolicy>): void {
  try {
    localStorage.setItem(POLICY_KEY, JSON.stringify(p));
  } catch { /* 隐私模式静默 */ }
}

function clampThreshold(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_CTX_POLICY.threshold;
  return Math.min(0.95, Math.max(0.5, n));
}

function clampKeepRecent(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_CTX_POLICY.keepRecent;
  return Math.min(20, Math.max(2, Math.floor(n)));
}

/** 单会话上下文状态 */
export interface CtxState {
  usedTokens?: number;
  window?: number;
  percent?: number;
  messages?: number;
  compacted?: boolean;
  exhausted?: boolean;
  compacting?: boolean;
  lastUsage?: UsageRecord;
  history: UsageRecord[];
  compacts: CompactRecord[];
  compactFailed?: string;
}

interface CtxStore {
  ctx: Record<string, CtxState>;
  policies: Record<string, CtxPolicy>;
  /** ai.usage（real-engine 流末发出） */
  applyUsage: (p: { sessionId: string; inputTokens?: number; outputTokens?: number; durationMs?: number; estimated?: boolean; model?: string; contextWindow?: number }) => void;
  /** context.snapshot（agent-loop 每轮结束） */
  applySnapshot: (p: { sessionId: string; usedTokens?: number; window?: number; percent?: number; messages?: number; compacted?: boolean; exhausted?: boolean }) => void;
  applyCompacting: (sessionId: string) => void;
  applyCompacted: (p: { sessionId: string; summary?: string; removedMessages?: number; tokensBefore?: number; tokensAfter?: number; at?: number }) => void;
  applyCompactFailed: (sessionId: string, reason: string) => void;
  /** 策略读写（UI 设置面板用） */
  setPolicy: (sessionId: string, patch: Partial<CtxPolicy>) => void;
  getPolicy: (sessionId: string) => CtxPolicy;
  /** 会话删除时清理（防 Map 无界增长） */
  dropSession: (sessionId: string) => void;
}

function emptyCtx(): CtxState {
  return { history: [], compacts: [] };
}

export const useCtxStore = create<CtxStore>((set, get) => ({
  ctx: {},
  policies: loadPolicies(),

  applyUsage: (p) => {
    if (!p.sessionId) return;
    const rec: UsageRecord = {
      at: Date.now(),
      inputTokens: Math.max(0, Number(p.inputTokens ?? 0)),
      outputTokens: Math.max(0, Number(p.outputTokens ?? 0)),
      durationMs: Math.max(1, Number(p.durationMs ?? 1)),
      tps: p.outputTokens ? (Number(p.outputTokens) / Math.max(1, Number(p.durationMs ?? 1))) * 1000 : 0,
      ...(p.estimated ? { estimated: true } : {}),
      ...(p.model ? { model: p.model } : {}),
    };
    set((st) => {
      const cur = st.ctx[p.sessionId] ?? emptyCtx();
      return {
        ctx: {
          ...st.ctx,
          [p.sessionId]: {
            ...cur,
            lastUsage: rec,
            history: [...cur.history, rec].slice(-16),
            ...(p.contextWindow && p.contextWindow > 0 ? { window: p.contextWindow } : {}),
            // 真实 usage 优先刷新水位（估算值不覆盖真实值）
            ...(!p.estimated && rec.inputTokens > 0 ? { usedTokens: rec.inputTokens } : {}),
          },
        },
      };
    });
  },

  applySnapshot: (p) => {
    if (!p.sessionId) return;
    set((st) => {
      const cur = st.ctx[p.sessionId] ?? emptyCtx();
      return {
        ctx: {
          ...st.ctx,
          [p.sessionId]: {
            ...cur,
            ...(p.usedTokens !== undefined ? { usedTokens: p.usedTokens } : {}),
            ...(p.window !== undefined ? { window: p.window } : {}),
            ...(p.percent !== undefined ? { percent: p.percent } : {}),
            ...(p.messages !== undefined ? { messages: p.messages } : {}),
            ...(p.compacted !== undefined ? { compacted: p.compacted } : {}),
            ...(p.exhausted !== undefined ? { exhausted: p.exhausted } : {}),
          },
        },
      };
    });
  },

  applyCompacting: (sessionId) => {
    set((st) => {
      const cur = st.ctx[sessionId] ?? emptyCtx();
      return { ctx: { ...st.ctx, [sessionId]: { ...cur, compacting: true, compactFailed: undefined } } };
    });
  },

  applyCompacted: (p) => {
    if (!p.sessionId) return;
    set((st) => {
      const cur = st.ctx[p.sessionId] ?? emptyCtx();
      const rec: CompactRecord = {
        at: p.at ?? Date.now(),
        removedMessages: p.removedMessages ?? 0,
        tokensBefore: p.tokensBefore ?? 0,
        tokensAfter: p.tokensAfter ?? 0,
        summary: p.summary ?? '',
      };
      return {
        ctx: {
          ...st.ctx,
          [p.sessionId]: {
            ...cur,
            compacting: false,
            compacted: true,
            compactFailed: undefined,
            compacts: [...cur.compacts, rec].slice(-8),
            ...(p.tokensAfter !== undefined ? { usedTokens: p.tokensAfter } : {}),
          },
        },
      };
    });
  },

  applyCompactFailed: (sessionId, reason) => {
    set((st) => {
      const cur = st.ctx[sessionId] ?? emptyCtx();
      return { ctx: { ...st.ctx, [sessionId]: { ...cur, compacting: false, compactFailed: reason } } };
    });
  },

  setPolicy: (sessionId, patch) => {
    set((st) => {
      const cur = st.policies[sessionId] ?? DEFAULT_CTX_POLICY;
      const next: CtxPolicy = {
        autoCompact: patch.autoCompact ?? cur.autoCompact,
        threshold: patch.threshold !== undefined ? clampThreshold(patch.threshold) : cur.threshold,
        keepRecent: patch.keepRecent !== undefined ? clampKeepRecent(patch.keepRecent) : cur.keepRecent,
      };
      const policies = { ...st.policies, [sessionId]: next };
      savePolicies(policies);
      return { policies };
    });
  },

  getPolicy: (sessionId) => get().policies[sessionId] ?? DEFAULT_CTX_POLICY,

  dropSession: (sessionId) => {
    set((st) => {
      if (!st.ctx[sessionId] && !st.policies[sessionId]) return st;
      const ctx = { ...st.ctx };
      delete ctx[sessionId];
      const policies = { ...st.policies };
      delete policies[sessionId];
      savePolicies(policies);
      return { ctx, policies };
    });
  },
}));

/** 便捷读取（非 React 上下文用） */
export function ctxPolicyOf(sessionId: string): CtxPolicy {
  return useCtxStore.getState().policies[sessionId] ?? DEFAULT_CTX_POLICY;
}
