/**
 * ledger-core 包装层：给 CJS vendor 一个带类型的 ESM 门面（vite 打包进 bundle）。
 * 计算实现全在 ledger-core.js（原样 vendor，勿改逻辑）；这里只做类型收口。
 */
// @ts-expect-error CJS vendor 无类型；类型面见 ledger-core.d.ts 的 '*ledger-core.js' 声明（供别处参照）
import * as coreNs from './ledger-core.cjs';

export const K = coreNs.K as {
  day: (date: string) => string;
  dayPrefix: string;
  dayPrefixOf: (month: string) => string;
  settings: string;
};
export const DEFAULT_SETTINGS = coreNs.DEFAULT_SETTINGS as {
  schemaVersion: number; currency: string; currencySymbol: string;
  categories: string[]; incomeCategories: string[];
  budgets: Record<string, number>; monthlyTotalBudget: number | null; excludeFromStats: string[];
};
export const DEFAULT_CATEGORIES = coreNs.DEFAULT_CATEGORIES as string[];
export const INCOME_CATEGORIES = coreNs.INCOME_CATEGORIES as string[];
export const dayKeyOf = coreNs.dayKeyOf as (ts: number) => string;
export const monthOf = coreNs.monthOf as (input: string | Date | number) => string;
export const shiftMonth = coreNs.shiftMonth as (month: string, delta: number) => string;
export const currentMonth = coreNs.currentMonth as (now?: number) => string;
export const makeId = coreNs.makeId as (now: number) => string;
export const normalizeBill = coreNs.normalizeBill as (raw: Record<string, unknown>, valid?: string[]) => { error?: string; bill?: import('./model-types').CoreBill };
export const appendBills = coreNs.appendBills as (existing: import('./model-types').CoreBill[], bills: import('./model-types').CoreBill[]) => import('./model-types').CoreBill[];
export const removeBill = coreNs.removeBill as (existing: import('./model-types').CoreBill[], id: string) => { arr: import('./model-types').CoreBill[]; removed: boolean };
export const updateBill = coreNs.updateBill as (existing: import('./model-types').CoreBill[], id: string, patch: Record<string, unknown>) => { arr: import('./model-types').CoreBill[]; found: boolean; moved: string | null; bill: import('./model-types').CoreBill | null };
export const filterBills = coreNs.filterBills as (bills: import('./model-types').CoreBill[], f?: { category?: string; type?: 'expense' | 'income'; keyword?: string }) => import('./model-types').CoreBill[];
export const computeStats = coreNs.computeStats as (bills: import('./model-types').CoreBill[], settings: import('./model-types').CoreSettings, month: string) => import('./model-types').CoreStats;
export const budgetHint = coreNs.budgetHint as (stats: import('./model-types').CoreStats) => string;
export const toCsv = coreNs.toCsv as (bills: import('./model-types').CoreBill[], symbol?: string) => string;
export const fmtMoney = coreNs.fmtMoney as (n: number, symbol?: string) => string;
export const resolveBillTime = coreNs.resolveBillTime as (raw: { date?: string; time?: string; timeOfDay?: string; hint?: string }, now?: number) => { error?: string; ts?: number };
