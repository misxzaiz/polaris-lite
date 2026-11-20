/**
 * pocket-ledger 存取层（面板与 AI 工具层共用；计算在 ledger-core.cjs 单一权威）。
 *
 * 存储经 cap.kv（namespace='pocket-ledger'，服务端 sqlite 持久化，见 kv-store 插件）：
 *   key = 'day.<YYYY-MM-DD>' → Bill[]（原 cap.kv ledger.day.* 一一对应）
 *   key = 'settings'         → LedgerSettings
 * 写入协议：读日键 → appendBills 按 id 幂等去重 → 写回（重试/双端并发安全）。
 *
 * 为什么面板不经总线 dispatch cap.tool.ledger：总线按「调用方权限」放行，
 * 面板不具备工具 cap（也不该有）；直接读写同一键空间即与 AI 层天然同账，
 * 双方变更经 ledger-changed 事件互达；多端打开同一份账（数据在服务端，不在浏览器）。
 */
import type { SlotHostApi } from '@sdk';
import * as core from './core';
import type { Bill, CoreBill, LedgerSettings } from './model-types';

export const NS = 'pocket-ledger';
export const DEFAULT_SETTINGS = core.DEFAULT_SETTINGS as LedgerSettings;

let api: SlotHostApi | null = null;
export function setLedgerApi(a: SlotHostApi | null): void { api = a; }

async function cfgGet<T>(key: string): Promise<T | null> {
  if (!api) return null;
  const res = await api.dispatch<{ value?: T }>({ target: 'cap.kv', action: 'get', payload: { namespace: NS, key } });
  return res.ok ? (res.data?.value ?? null) : null;
}

async function cfgSet(key: string, value: unknown): Promise<void> {
  await api?.dispatch({ target: 'cap.kv', action: 'set', payload: { namespace: NS, key, value } });
}

export async function cfgKeys(): Promise<string[]> {
  if (!api) return [];
  const res = await api.dispatch<{ keys?: string[] }>({ target: 'cap.kv', action: 'list', payload: { namespace: NS } });
  return (res.data?.keys ?? []).filter((k) => typeof k === 'string' && k.startsWith('ledger.day.')).sort();
}

export async function loadSettings(): Promise<LedgerSettings> {
  const s = await cfgGet<Partial<LedgerSettings>>('settings');
  return { ...DEFAULT_SETTINGS, ...(s && typeof s === 'object' ? s : {}) };
}

export async function saveSettings(s: LedgerSettings): Promise<void> {
  await cfgSet('settings', s);
}

export async function loadMonth(month: string): Promise<{ bills: Bill[]; dayKeys: string[] }> {
  const all = await cfgKeys();
  const prefix = `ledger.day.${month}-`;
  const dayKeys = all.filter((k) => k.startsWith(prefix));
  const bills: Bill[] = [];
  for (const dk of dayKeys) {
    const arr = await cfgGet<Bill[]>(dk);
    if (Array.isArray(arr)) for (const b of arr) if (b && typeof b.amount === 'number') bills.push(b);
  }
  bills.sort((a, b) => a.ts - b.ts);
  return { bills, dayKeys };
}

export async function loadDayBills(dayKey: string): Promise<Bill[]> {
  const arr = await cfgGet<Bill[]>(dayKey);
  return Array.isArray(arr) ? arr : [];
}

export interface AddBillInput {
  amount: number;
  type: 'expense' | 'income';
  category?: string;
  note?: string;
  ts?: number;
  date?: string;
  timeOfDay?: string;
  time?: string;
}

export interface AddBillResult {
  ok: boolean;
  error?: string;
  bill?: Bill;
  todayExpense?: number;
  todayIncome?: number;
  hint?: string;
}

/** 记一笔（面板/AI 共用）：档位解析 → 归一化 → 日键幂等追加 → 预算提醒 */
export async function addBill(input: AddBillInput, source: 'panel' | 'ai'): Promise<AddBillResult> {
  const settings = await loadSettings();
  const valid = [...new Set([...(settings.categories ?? []), ...(settings.incomeCategories ?? [])])];
  let ts = Number.isFinite(Number(input.ts)) && Number(input.ts) > 0 ? Number(input.ts) : undefined;
  if (ts === undefined) {
    const resolved = core.resolveBillTime({ date: input.date, time: input.time, timeOfDay: input.timeOfDay, hint: input.note }, Date.now());
    if (resolved.error) return { ok: false, error: resolved.error };
    ts = resolved.ts as number;
  }
  const norm = core.normalizeBill({ ...input, ts, source }, valid);
  if (norm.error || !norm.bill) return { ok: false, error: norm.error ?? '账单不合法' };
  const bill = norm.bill as Bill;
  const dk = core.K.day(core.dayKeyOf(bill.ts));
  const existing = await loadDayBills(dk);
  const merged = core.appendBills(existing, [bill]);
  await cfgSet(dk, merged);
  notifyChanged();
  const todayExpense = merged.filter((b) => b.type === 'expense').reduce((s, b) => s + b.amount, 0);
  const todayIncome = merged.filter((b) => b.type === 'income').reduce((s, b) => s + b.amount, 0);
  const month = core.monthOf(bill.ts);
  const { bills } = await loadMonth(month);
  const stats = core.computeStats(bills as CoreBill[], settings, month);
  const hint = core.budgetHint(stats);
  return { ok: true, bill, todayExpense, todayIncome, ...(hint ? { hint } : {}) };
}

/** 删除一笔（全 ledger.day.* 键查找） */
export async function deleteBillById(id: string): Promise<boolean> {
  for (const dk of await cfgKeys()) {
    const arr = await loadDayBills(dk);
    const { arr: next, removed } = core.removeBill(arr, id);
    if (removed) {
      await cfgSet(dk, next);
      notifyChanged();
      return true;
    }
  }
  return false;
}

/** 修改一笔（跨日自动迁移） */
export async function updateBillById(id: string, patch: { amount?: number; category?: string; note?: string; type?: 'expense' | 'income'; ts?: number }): Promise<{ ok: boolean; error?: string; bill?: Bill; moved?: string | null }> {
  for (const dk of await cfgKeys()) {
    const arr = await loadDayBills(dk);
    const r = core.updateBill(arr, id, patch);
    if (!r.found) continue;
    if (r.moved) {
      await cfgSet(dk, r.arr);
      const targetArr = await loadDayBills(core.K.day(r.moved));
      await cfgSet(core.K.day(r.moved), core.appendBills(targetArr, [r.bill as Bill]));
    } else {
      await cfgSet(dk, r.arr);
    }
    notifyChanged();
    return { ok: true, bill: r.bill as Bill, moved: r.moved };
  }
  return { ok: false, error: `未找到账单 ${id}` };
}

/** 月度统计（AI stats 与面板统计页同源） */
export async function statsFor(month?: string): Promise<{ ok: boolean; stats?: ReturnType<typeof core.computeStats>; hint?: string }> {
  const m = !month || month === 'this' ? core.currentMonth() : month === 'last' ? core.shiftMonth(core.currentMonth(), -1) : month;
  const settings = await loadSettings();
  const { bills } = await loadMonth(m);
  const stats = core.computeStats(bills as CoreBill[], settings, m);
  return { ok: true, stats, hint: core.budgetHint(stats) };
}

/** 变更通知：宿主事件总线 + 同页 DOM 事件双通道（面板即时刷新） */
export function notifyChanged(): void {
  api?.emit('ledger-changed', { at: Date.now() });
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('ledger-changed'));
}
