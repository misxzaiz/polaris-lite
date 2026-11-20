/**
 * pocket-ledger core 计算回归测试（vendor 自 Polaris-plugin/pocket-ledger）。
 * 覆盖：日键/月份换算、账单归一化、幂等追加去重、删除/更新（含跨日迁移）、
 *       筛选、月度统计与预算、CSV 导出、时段档位解析。
 * 计算实现在 plugins/pocket-ledger/ledger-core.cjs（零依赖 CJS，与面板/工具同一权威）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const core = require('../plugins/pocket-ledger/ledger-core.cjs');

test('dayKeyOf/monthOf/shiftMonth：本地时区与跨月', () => {
  const ts = new Date(2026, 9, 27, 0, 30).getTime();
  assert.equal(core.dayKeyOf(ts), '2026-10-27');
  assert.equal(core.monthOf(ts), '2026-10');
  assert.equal(core.monthOf('2026-10-27'), '2026-10');
  assert.equal(core.shiftMonth('2026-10', -1), '2026-09');
  assert.equal(core.shiftMonth('2026-01', -1), '2025-12');
  assert.equal(core.shiftMonth('2026-12', 1), '2027-01');
  const last = new Date(2026, 9, 31, 23, 59).getTime();
  assert.equal(core.dayKeyOf(last + 2 * 60 * 1000), '2026-11-01');
});

test('normalizeBill：金额校验/类型/分类白名单/来源', () => {
  const cats = ['餐饮', '交通', '工资', '其他收入'];
  const r1 = core.normalizeBill({ amount: 35, type: 'expense', category: '餐饮', note: '午饭', source: 'ai', ts: 1000 }, cats);
  assert.equal(r1.error, undefined);
  assert.equal(r1.bill.amount, 35);
  assert.equal(r1.bill.source, 'ai');
  assert.equal(core.normalizeBill({ amount: -1 }, cats).error, '金额必须是正数（收到：-1）');
  assert.equal(core.normalizeBill({ amount: 'abc' }, cats).error, '金额必须是正数（收到：abc）');
  assert.equal(core.normalizeBill({ amount: 1e10 }, cats).error, '金额过大，疑似输入错误');
  assert.equal(core.normalizeBill({ amount: 10, category: '不存在' }, cats).error, '未知分类「不存在」，可用：餐饮/交通/工资/其他收入（可先在设置里添加自定义分类）');
  // 收入缺省分类「其他收入」需在白名单内才通过（调用方负责合并收入分类）
  const r2 = core.normalizeBill({ amount: 100, type: 'income' }, cats);
  assert.equal(r2.bill.category, '其他收入');
  assert.ok(core.normalizeBill({ amount: 100, type: 'income' }, ['餐饮']).error, '收入默认分类不在白名单应被拒');
});

test('appendBills：按 id 幂等去重 + ts 排序', () => {
  const a = { id: 'a', ts: 300, type: 'expense', amount: 1, category: '餐饮', note: '', source: 'panel' };
  const b = { id: 'b', ts: 100, type: 'expense', amount: 2, category: '交通', note: '', source: 'panel' };
  const merged = core.appendBills([a], [b, { ...a, amount: 999 }]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].id, 'b', '按 ts 升序');
  assert.equal(merged.find((x) => x.id === 'a').amount, 999, '同 id 后写覆盖（写入前先读保幂等：重复写同一笔结果一致）');
});

test('removeBill/updateBill：删除与跨日迁移', () => {
  const day1 = new Date(2026, 10, 20, 12).getTime();
  const day2 = new Date(2026, 10, 21, 12).getTime();
  const arr = [{ id: 'x', ts: day1, type: 'expense', amount: 10, category: '餐饮', note: '', source: 'panel' }];
  assert.equal(core.removeBill(arr, 'nope').removed, false);
  assert.equal(core.removeBill(arr, 'x').removed, true);

  const up = core.updateBill(arr, 'x', { amount: 20 });
  assert.equal(up.found, true);
  assert.equal(up.moved, null);
  assert.equal(up.bill.amount, 20);

  const moved = core.updateBill(arr, 'x', { ts: day2 });
  assert.equal(moved.moved, core.dayKeyOf(day2), '跨日返回目标日键');
  assert.equal(moved.arr.length, 0, '旧日键移除该笔');
  assert.equal(moved.bill.ts, day2);
  assert.equal(core.updateBill(arr, 'nope', {}).found, false);
});

test('resolveBillTime：优先级 time > timeOfDay > hint 触发词 > 就近归档', () => {
  const now = new Date(2026, 10, 20, 21, 16).getTime(); // 周五 21:16
  // 显式 time
  assert.equal(core.resolveBillTime({ time: '08:30' }, now).ts, new Date(2026, 10, 20, 8, 30).getTime());
  // timeOfDay 档位
  assert.equal(core.resolveBillTime({ timeOfDay: 'morning' }, now).ts, new Date(2026, 10, 20, 9, 0).getTime());
  // 中文档位
  assert.equal(core.resolveBillTime({ timeOfDay: '中午' }, now).ts, new Date(2026, 10, 20, 12, 0).getTime());
  // note 触发词（午饭 → 中午）
  assert.equal(core.resolveBillTime({ hint: '午饭 35' }, now).ts, new Date(2026, 10, 20, 12, 0).getTime());
  // 补记昨天
  assert.equal(core.resolveBillTime({ date: 'yesterday', time: '12:00' }, now).ts, new Date(2026, 10, 19, 12, 0).getTime());
  // 未知 timeOfDay 报错
  assert.ok(core.resolveBillTime({ timeOfDay: '下午三点' }, now).error);
  // 就近归档：21:16 → 晚上 20:00
  assert.equal(core.resolveBillTime({}, now).ts, new Date(2026, 10, 20, 20, 0).getTime());
});

test('computeStats + budgetHint：收支/结余/分类预算/总预算', () => {
  const settings = {
    schemaVersion: 2, currency: 'CNY', currencySymbol: '¥',
    categories: ['餐饮', '交通'], incomeCategories: ['工资'],
    budgets: { 餐饮: 100 }, monthlyTotalBudget: 500, excludeFromStats: [],
  };
  const mk = (id, ts, type, amount, category) => ({ id, ts, type, amount, category, note: '', source: 'panel' });
  const bills = [
    mk('a', new Date(2026, 10, 1, 9).getTime(), 'expense', 60, '餐饮'),
    mk('b', new Date(2026, 10, 2, 9).getTime(), 'expense', 50, '餐饮'),
    mk('c', new Date(2026, 10, 3, 9).getTime(), 'income', 3000, '工资'),
    mk('d', new Date(2026, 10, 4, 9).getTime(), 'expense', 200, '交通'),
  ];
  const stats = core.computeStats(bills, settings, '2026-11');
  assert.equal(stats.expense, 310);
  assert.equal(stats.income, 3000);
  assert.equal(stats.balance, 2690);
  const can = stats.byCategory.find((c) => c.category === '餐饮');
  assert.equal(can.budget, 100);
  assert.equal(stats.categoryBudgetUsed['餐饮'], 1.1, '餐饮 110/100 = 110% 超支');
  assert.equal(stats.totalBudgetUsed, 0.62);
  const hint = core.budgetHint(stats);
  assert.equal(hint, '', '总预算 62% 不触发提醒（分类超支不进 hint，原件语义）');
  // 总预算 90%+ 触发
  const s2 = core.computeStats(bills, { ...settings, monthlyTotalBudget: 330 }, '2026-11');
  assert.ok(core.budgetHint(s2).includes('94%'), '总预算 94% 触发提醒');
  const s3 = core.computeStats(bills, { ...settings, monthlyTotalBudget: 300 }, '2026-11');
  assert.ok(core.budgetHint(s3).includes('超支'), '总预算 103% 触发超支警告');
  // 排除汇总：工资不计入收入
  const ex = core.computeStats(bills, { ...settings, excludeFromStats: ['工资'] }, '2026-11');
  assert.equal(ex.income, 0);
  assert.equal(ex.excludedSum, 3000);
});

test('toCsv：转义与表头', () => {
  const csv = core.toCsv([{ id: 'a', ts: new Date(2026, 10, 20, 12).getTime(), type: 'expense', amount: 35, category: '餐饮', note: '含"引号"', source: 'ai' }]);
  assert.ok(csv.startsWith('日期时间,类型,分类,金额(¥),备注,来源,ID'));
  assert.ok(csv.includes('"含""引号"""'), '引号双写转义');
});
