/**
 * pocket-ledger 插件：日常记账（自 Polaris-plugin/pocket-ledger v0.3.0 迁移，纯插件实现）。
 *
 * 职责：
 * - cap.tool.ledger：AI 记账工具（describe 协议进 agent-loop；add/query/stats/delete/
 *   update/categories 六动作，参数与原 MCP 工具一一对应）；
 * - panel 槽：四 Tab 面板（记账/明细/统计/设置）；
 * - 存储与计算：store.ts（cap.config 存取）+ ledger-core.cjs（单一权威，原件原样 vendor）。
 *
 * 原 stdio MCP server 不迁——lite 的 AI 工具走 tool cap（agent-loop describe 协议）。
 */
import type { CapabilityHandler, LitePlugin, SlotHostApi } from '@sdk';
import * as core from './core';
import { LedgerPanel } from './Panel';
import {
  setLedgerApi, loadSettings, saveSettings, loadMonth, loadDayBills,
  addBill, deleteBillById, updateBillById, statsFor, notifyChanged,
} from './store';
import './panel.css';

// ── AI 工具描述（describe 协议，对齐 agent-bash/file-browser）────────────
const DESCRIPTOR = {
  cap: 'cap.tool.ledger',
  name: 'ledger',
  description:
    '日常记账。用户说「午饭 35」「打车 48」这类消费/收入时调用 add 记账：amount=金额（正数），' +
    'type 缺省 expense（收入才传 income），category 从对话语境选（餐饮/交通/购物/居住/娱乐/医疗/学习/人情/其他；' +
    '收入用 工资/理财/红包/退款/其他收入），note 写简短备注（含菜品/事由，会用于时段推导），' +
    '时间不明就传 date（today/yesterday/YYYY-MM-DD），不传 time/timeOfDay（按备注触发词或当前时刻就近归档）。' +
    '用户问「花了多少/这个月怎么样」用 stats/query；改账先 query 拿 id 再 update/delete。入账响应自带预算提醒。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'add | query | stats | delete | update | categories', enum: ['add', 'query', 'stats', 'delete', 'update', 'categories'] },
      amount: { type: 'number', description: '金额（正数；add 必填）' },
      type: { type: 'string', description: 'expense（默认）| income' },
      category: { type: 'string', description: '分类；不传由 AI 按语境选，未知分类先 categories add' },
      note: { type: 'string', description: '备注（简短；含食物/事由可辅助时段推导）' },
      date: { type: 'string', description: 'today | yesterday | YYYY-MM-DD（补记）' },
      time: { type: 'string', description: 'HH:MM（24h，明确时刻）' },
      timeOfDay: { type: 'string', description: '时段档位：early_morning/morning/noon/afternoon/evening/night 或中文（凌晨/早上/中午/下午/傍晚/晚上）' },
      id: { type: 'string', description: '账单 id（delete/update 必填；从 query 结果取）' },
      month: { type: 'string', description: 'this | last | YYYY-MM（query/stats）' },
      keyword: { type: 'string', description: '备注/分类关键词（query 过滤）' },
      limit: { type: 'number', description: 'query 返回条数上限（默认 20，最大 100）' },
      op: { type: 'string', description: 'categories 动作：list | add | remove' },
      name: { type: 'string', description: 'categories add/remove 的分类名' },
      kind: { type: 'string', description: 'categories 分类性质：expense | income' },
      patch: { type: 'object', description: 'update 的字段 { amount?, category?, note?, date?, time?, timeOfDay? }' },
    },
    required: ['action'],
  },
  danger: 'write' as const,
};

/** 查账单：月/日 + 过滤（AI 视角；返回精简字段） */
async function queryBills(p: { month?: string; date?: string; category?: string; type?: string; keyword?: string; limit?: number }) {
  let bills;
  if (p.date) {
    const day = p.date === 'yesterday' || p.date === '昨天'
      ? core.dayKeyOf(Date.now() - 24 * 3600 * 1000)
      : p.date === 'today' || p.date === '今天' ? core.dayKeyOf(Date.now()) : p.date;
    bills = await loadDayBills(`ledger.day.${day}`);
  } else {
    const month = !p.month || p.month === 'this' ? core.currentMonth() : p.month === 'last' ? core.shiftMonth(core.currentMonth(), -1) : p.month;
    bills = (await loadMonth(month)).bills;
  }
  const filtered = core.filterBills(bills, {
    category: p.category,
    type: p.type === 'income' || p.type === 'expense' ? p.type : undefined,
    keyword: p.keyword,
  });
  const sorted = filtered.slice().sort((a, b) => b.ts - a.ts);
  const limited = sorted.slice(0, Math.min(Math.max(1, p.limit ?? 20), 100));
  return {
    ok: true,
    count: filtered.length,
    bills: limited.map((b) => ({
      id: b.id, ts: b.ts, time: new Date(b.ts).toLocaleString('zh-CN', { hour12: false }),
      type: b.type, amount: b.amount, category: b.category, note: b.note, source: b.source,
    })),
  };
}

function createLedgerHandler(): CapabilityHandler {
  return async (req) => {
    const p = (req.payload ?? {}) as Record<string, unknown>;
    switch (req.action) {
      case 'describe':
        return { descriptor: DESCRIPTOR };
      case 'add':
        return addBill({
          amount: Number(p.amount),
          type: p.type === 'income' ? 'income' : 'expense',
          category: p.category !== undefined ? String(p.category) : undefined,
          note: p.note !== undefined ? String(p.note) : undefined,
          date: p.date !== undefined ? String(p.date) : undefined,
          time: p.time !== undefined ? String(p.time) : undefined,
          timeOfDay: p.timeOfDay !== undefined ? String(p.timeOfDay) : undefined,
        }, 'ai');
      case 'query':
        return queryBills({
          month: p.month !== undefined ? String(p.month) : undefined,
          date: p.date !== undefined ? String(p.date) : undefined,
          category: p.category !== undefined ? String(p.category) : undefined,
          type: p.type !== undefined ? String(p.type) : undefined,
          keyword: p.keyword !== undefined ? String(p.keyword) : undefined,
          limit: p.limit !== undefined ? Number(p.limit) : undefined,
        });
      case 'stats':
        return statsFor(p.month !== undefined ? String(p.month) : undefined);
      case 'delete': {
        const ok = await deleteBillById(String(p.id ?? ''));
        return ok ? { ok: true } : { ok: false, error: `未找到账单 ${p.id}（先用 query 拿 id）` };
      }
      case 'update': {
        const patch = (p.patch ?? {}) as Record<string, unknown>;
        // date/time/timeOfDay 先解析成 ts（跨日迁移由 updateBillById 处理）
        let ts: number | undefined;
        if (patch.ts !== undefined) ts = Number(patch.ts);
        else if (patch.date !== undefined || patch.time !== undefined || patch.timeOfDay !== undefined) {
          const resolved = core.resolveBillTime({
            date: patch.date !== undefined ? String(patch.date) : undefined,
            time: patch.time !== undefined ? String(patch.time) : undefined,
            timeOfDay: patch.timeOfDay !== undefined ? String(patch.timeOfDay) : undefined,
            hint: patch.note !== undefined ? String(patch.note) : undefined,
          }, Date.now());
          if (resolved.error) return { ok: false, error: resolved.error };
          ts = resolved.ts;
        }
        const next: Record<string, unknown> = {};
        if (patch.amount !== undefined) next.amount = Number(patch.amount);
        if (patch.category !== undefined) next.category = String(patch.category);
        if (patch.note !== undefined) next.note = String(patch.note);
        if (patch.type === 'income' || patch.type === 'expense') next.type = patch.type;
        if (ts !== undefined) next.ts = ts;
        return updateBillById(String(p.id ?? ''), next);
      }
      case 'categories': {
        const settings = await loadSettings();
        const op = String(p.op ?? 'list');
        const name = String(p.name ?? '').trim();
        const kind = p.kind === 'income' ? 'incomeCategories' : 'categories';
        if (op === 'list') {
          return { ok: true, categories: settings.categories, incomeCategories: settings.incomeCategories, budgets: settings.budgets, monthlyTotalBudget: settings.monthlyTotalBudget };
        }
        if (op === 'add') {
          if (!name) return { ok: false, error: 'name required' };
          if (settings.categories.includes(name) || settings.incomeCategories.includes(name)) return { ok: true, already: true };
          (settings[kind] as string[]).push(name);
          await saveSettings(settings);
          notifyChanged();
          return { ok: true, categories: settings[kind] };
        }
        if (op === 'remove') {
          if (!name) return { ok: false, error: 'name required' };
          const before = (settings[kind] as string[]).length;
          (settings[kind] as string[]) = (settings[kind] as string[]).filter((c) => c !== name);
          if ((settings[kind] as string[]).length === before) return { ok: true, removed: false };
          delete settings.budgets[name];
          await saveSettings(settings);
          notifyChanged();
          return { ok: true, removed: true };
        }
        return { ok: false, error: `unknown op: ${op}` };
      }
      default:
        return { ok: false, error: `unknown action: ${req.action}` };
    }
  };
}

export const pocketLedgerPlugin: LitePlugin = {
  manifest: {
    id: 'pocket-ledger',
    name: '日常记账',
    version: '0.1.0',
    capabilities: ['cap.config'],
    provides: ['cap.tool.ledger'],
    events: ['tool-registered', 'ledger-changed'],
    contributes: {
      // title ≤4 字：panel tab 等分宽约 74px，长名会截断
      slots: [{ slot: 'panel', component: 'LedgerPanel', order: 8, title: '记账' }],
    },
  },
  setup(api: SlotHostApi) {
    setLedgerApi(api);
    api.registerCapability.register('cap.tool.ledger', createLedgerHandler());
    // 迟到广播兜底（loop 晚于本插件装配时也能发现工具）
    api.emit('tool-registered', { cap: 'cap.tool.ledger', name: 'ledger' });
  },
};

export { LedgerPanel };
export default pocketLedgerPlugin;
