/**
 * starter-suggestions 插件：开场建议池（AI 可实时增改）。
 *
 * 职责：
 * - cap.tool.suggestions：AI 工具（describe 协议进 agent-loop；list/add/update/remove/
 *   stats 五动作），用户在对话里说「加一条开场建议」即实时入池；
 * - panel 槽：管理面板（列表/启停/增删改/AI 生成/重置内置）；
 * - 存储：cap.kv（namespace='starter-suggestions'，服务端 sqlite），chat-lite 空态页
 *   异步读同一键空间合并展示；读取失败自动回退 chat-lite 内置池。
 *
 * 数据协议（key='pool'）：{ version: 1, items: StarterSuggestion[] }
 * - 内置 30 条（chat-lite/suggestions.ts 的 SUGGESTIONS）首次初始化为 source:'builtin'；
 * - 校验白名单：label ≤40 字、prompt ≤500 字、category 枚举；池上限 MAX_ITEMS=200；
 * - 渲染纯文本，无 HTML 注入面。
 */
import type { CapabilityHandler, LitePlugin, SlotHostApi } from '@sdk';
import { SUGGESTIONS } from '../shared/suggestion-types';
import type { CategoryId, StarterSuggestion, SuggestionPool } from '../shared/suggestion-types';
import { StarterSuggestionsPanel } from './Panel';
import './panel.css';

export type { StarterSuggestion, SuggestionPool };

export const NS = 'starter-suggestions';
export const POOL_KEY = 'pool';
const MAX_ITEMS = 200;
const MAX_LABEL = 40;
const MAX_PROMPT = 500;
const VALID_CATEGORIES: CategoryId[] = ['explore', 'tools', 'code', 'write', 'think', 'play'];

let api: SlotHostApi | null = null;

// ── kv 存取 ─────────────────────────────────────────────────────────────

async function poolGet(): Promise<SuggestionPool | null> {
  if (!api) return null;
  const res = await api.dispatch<{ value?: SuggestionPool | null }>({
    target: 'cap.kv', action: 'get', payload: { namespace: NS, key: POOL_KEY },
  });
  return res.ok ? (res.data?.value ?? null) : null;
}

async function poolSet(pool: SuggestionPool): Promise<void> {
  await api?.dispatch({ target: 'cap.kv', action: 'set', payload: { namespace: NS, key: POOL_KEY, value: pool } });
}

/** 读池；空/坏数据时用内置种子初始化（幂等：并发只写一次同一份） */
export async function loadPool(): Promise<SuggestionPool> {
  const existing = await poolGet();
  if (existing && Array.isArray(existing.items)) return existing;
  const seed: SuggestionPool = {
    version: 1,
    items: SUGGESTIONS.map((s, i) => ({
      id: `b-${String(i + 1).padStart(3, '0')}`,
      label: s.label,
      prompt: s.prompt,
      category: s.category,
      enabled: true,
      source: 'builtin' as const,
      createdAt: new Date().toISOString(),
    })),
  };
  await poolSet(seed);
  return seed;
}

export async function savePool(items: StarterSuggestion[]): Promise<SuggestionPool> {
  const pool: SuggestionPool = { version: 1, items };
  await poolSet(pool);
  // 变更通知：宿主事件总线 + 同页 DOM 事件双通道（面板即时刷新，对齐 pocket-ledger）
  api?.emit('suggestions-changed', { count: items.length });
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('suggestions-changed'));
  return pool;
}

// ── 校验（白名单 + 长度 + 枚举） ────────────────────────────────────────

function normalizeCategory(v: unknown): CategoryId {
  return VALID_CATEGORIES.includes(v as CategoryId) ? (v as CategoryId) : 'explore';
}

function validateItem(input: { label?: unknown; prompt?: unknown; category?: unknown }):
  { label: string; prompt: string; category: CategoryId } | { error: string } {
  const label = typeof input.label === 'string' ? input.label.trim() : '';
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (!label) return { error: 'label 不能为空' };
  if (!prompt) return { error: 'prompt 不能为空' };
  if (label.length > MAX_LABEL) return { error: `label 超过 ${MAX_LABEL} 字` };
  if (prompt.length > MAX_PROMPT) return { error: `prompt 超过 ${MAX_PROMPT} 字` };
  return { label, prompt, category: normalizeCategory(input.category) };
}

function newId(): string {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── AI 工具（describe 协议） ────────────────────────────────────────────

const DESCRIPTOR = {
  cap: 'cap.tool.suggestions',
  name: 'suggestions',
  description:
    '管理「新会话开场建议池」（用户首次打开对话页看到的推荐起点）。' +
    '当用户说「加一条开场建议/推荐」时调用 add：label 是短标题（≤40 字），prompt 是点击后填入输入框的完整提示词（≤500 字），' +
    'category 从 explore/tools/code/write/think/play 里按内容选。' +
    '用户要查看/删除/修改建议时用 list/remove/update；update/remove 用 id（先 list 拿）。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'list | add | update | remove | stats', enum: ['list', 'add', 'update', 'remove', 'stats'] },
      id: { type: 'string', description: '建议 id（update/remove 必填，从 list 结果取）' },
      label: { type: 'string', description: '短标题（≤40 字；add 必填，update 可选）' },
      prompt: { type: 'string', description: '完整提示词（≤500 字；add 必填，update 可选）' },
      category: { type: 'string', description: 'explore | tools | code | write | think | play' },
    },
    required: ['action'],
  },
  danger: 'write' as const,
};

function createSuggestionsHandler(): CapabilityHandler {
  return async (req) => {
    const p = (req.payload ?? {}) as Record<string, unknown>;
    try {
      switch (req.action) {
        case 'describe':
          return { descriptor: DESCRIPTOR };
        case 'list': {
          const pool = await loadPool();
          return { ok: true, count: pool.items.length, items: pool.items.map((s) => ({ id: s.id, label: s.label, category: s.category, enabled: s.enabled, source: s.source, prompt: s.prompt })) };
        }
        case 'add': {
          const v = validateItem(p);
          if ('error' in v) return { ok: false, error: v.error };
          const pool = await loadPool();
          if (pool.items.length >= MAX_ITEMS) return { ok: false, error: `建议池已达上限 ${MAX_ITEMS} 条，请先 remove` };
          if (pool.items.some((s) => s.prompt === v.prompt)) return { ok: false, error: '已存在相同 prompt 的建议' };
          const item: StarterSuggestion = {
            id: newId(), label: v.label, prompt: v.prompt, category: v.category,
            enabled: true, source: 'ai', createdAt: new Date().toISOString(), uses: 0,
          };
          await savePool([...pool.items, item]);
          return { ok: true, id: item.id };
        }
        case 'update': {
          const id = String(p.id ?? '');
          const pool = await loadPool();
          const idx = pool.items.findIndex((s) => s.id === id);
          if (idx < 0) return { ok: false, error: `未找到建议 ${id}（先用 list 拿 id）` };
          const cur = pool.items[idx];
          const v = validateItem({ label: p.label ?? cur.label, prompt: p.prompt ?? cur.prompt, category: p.category ?? cur.category });
          if ('error' in v) return { ok: false, error: v.error };
          const next = [...pool.items];
          next[idx] = { ...cur, label: v.label, prompt: v.prompt, category: v.category };
          await savePool(next);
          return { ok: true };
        }
        case 'remove': {
          const id = String(p.id ?? '');
          const pool = await loadPool();
          const next = pool.items.filter((s) => s.id !== id);
          if (next.length === pool.items.length) return { ok: false, error: `未找到建议 ${id}（先用 list 拿 id）` };
          await savePool(next);
          return { ok: true };
        }
        case 'stats': {
          const pool = await loadPool();
          const bySource = { builtin: 0, ai: 0, user: 0 } as Record<string, number>;
          for (const s of pool.items) bySource[s.source] = (bySource[s.source] ?? 0) + 1;
          return { ok: true, total: pool.items.length, bySource };
        }
        default:
          return { ok: false, error: `unknown action: ${req.action}` };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };
}

// ── 插件定义 ────────────────────────────────────────────────────────────

export const starterSuggestionsPlugin: LitePlugin = {
  manifest: {
    id: 'starter-suggestions',
    name: '开场建议',
    version: '0.1.0',
    capabilities: ['cap.kv'],
    provides: ['cap.tool.suggestions'],
    events: ['tool-registered', 'suggestions-changed'],
    contributes: {
      // title ≤4 字：panel tab 等分宽约 74px，长名会截断
      slots: [{ slot: 'panel', component: 'StarterSuggestionsPanel', order: 17, title: '开场白' }],
    },
  },
  setup(a: SlotHostApi) {
    api = a;
    a.registerCapability.register('cap.tool.suggestions', createSuggestionsHandler());
    // 迟到广播兜底（loop 晚于本插件装配时也能发现工具）
    a.emit('tool-registered', { cap: 'cap.tool.suggestions', name: 'suggestions' });
  },
};

export { StarterSuggestionsPanel };
export default starterSuggestionsPlugin;
