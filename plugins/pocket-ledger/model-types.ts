/** pocket-ledger 共享类型（core 包装层与面板/工具层共用） */

export interface CoreBill {
  id: string;
  ts: number;
  type: 'expense' | 'income';
  amount: number;
  category: string;
  note: string;
  source: 'panel' | 'ai' | 'import';
  attachmentId?: string;
}

export interface CoreSettings {
  schemaVersion: number;
  currency: string;
  currencySymbol: string;
  categories: string[];
  incomeCategories: string[];
  budgets: Record<string, number>;
  monthlyTotalBudget: number | null;
  excludeFromStats: string[];
}

export interface CoreStats {
  month: string;
  income: number;
  expense: number;
  balance: number;
  count: number;
  excludedSum: number;
  byCategory: { category: string; type: 'expense' | 'income'; sum: number; count: number; excluded: boolean; incomeSum?: number; expenseSum?: number; budget: number | null }[];
  byDay: { date: string; expense: number }[];
  totalBudget: number | null;
  totalBudgetUsed: number | null;
  categoryBudgetUsed: Record<string, number>;
  currencySymbol: string;
}

/** 面板用的账单（= core bill 的对外形态） */
export type Bill = CoreBill;
export type LedgerSettings = CoreSettings;
