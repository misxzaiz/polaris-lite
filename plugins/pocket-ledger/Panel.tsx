/**
 * LedgerPanel：日常记账面板（四 Tab：记账/明细/统计/设置）。
 * 数据经 store.ts（cap.config 持久化，与 AI 工具层同键空间同口径），计算走 core 单一权威。
 * 交互对齐原件 pocket-ledger：金额大输入框 + 分类 chips + 时段档位 + 月度翻页 + 预算进度。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import * as core from './core';
import { cfgKeys, loadSettings, saveSettings as persistSettings, loadDayBills, addBill as addBillStore, deleteBillById } from './store';
import type { Bill, CoreStats, LedgerSettings } from './model-types';

const fmt = (n: number, symbol: string): string => core.fmtMoney(n, symbol);

type Tab = 'quick' | 'list' | 'stats' | 'settings';
const TABS: { key: Tab; label: string }[] = [
  { key: 'quick', label: '记账' },
  { key: 'list', label: '明细' },
  { key: 'stats', label: '统计' },
  { key: 'settings', label: '设置' },
];

export function LedgerPanel() {
  const [tab, setTab] = useState<Tab>('quick');
  const [settings, setSettings] = useState<LedgerSettings>(core.DEFAULT_SETTINGS as LedgerSettings);
  const [month, setMonth] = useState<string>(() => core.currentMonth());
  const [bills, setBills] = useState<Bill[]>([]);
  const [stats, setStats] = useState<CoreStats | null>(null);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(async () => {
    const s = await loadSettings();
    setSettings(s);
    const keys = (await cfgKeys()).filter((k) => k.startsWith(`ledger.day.${month}-`)).sort();
    const all: Bill[] = [];
    for (const dk of keys) {
      const arr = await loadDayBills(dk);
      if (Array.isArray(arr)) all.push(...arr.filter((b) => b && typeof b.amount === 'number'));
    }
    all.sort((a, b) => a.ts - b.ts);
    setBills(all);
    setStats(core.computeStats(all, settings, month) as CoreStats);
  }, [month, tick]);

  useEffect(() => { void refresh(); }, [refresh]);

  // 记账/工具入账后：ledger-changed → 即时刷新（index.ts emit 时同步派发 DOM 事件）
  useEffect(() => {
    const fn = () => setTick((t) => t + 1);
    window.addEventListener('ledger-changed', fn);
    return () => window.removeEventListener('ledger-changed', fn);
  }, []);

  const saveSettingsAndRefresh = useCallback(async (s: LedgerSettings) => {
    setSettings(s);
    await persistSettings(s);
    setTick((t) => t + 1);
  }, []);

  return (
    <div className="pl-ledger" data-testid="pocket-ledger">
      <div className="pl-ledger-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key}
            className={`pl-ledger-tab ${tab === t.key ? 'active' : ''}`}
            onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </div>
      <div className="pl-ledger-body">
        {tab === 'quick' && <QuickTab settings={settings} refresh={refresh} />}
        {tab === 'list' && <ListTab month={month} setMonth={setMonth} bills={bills} settings={settings} refresh={refresh} />}
        {tab === 'stats' && (stats ? <StatsTab stats={stats} settings={settings} /> : null)}
        {tab === 'settings' && <SettingsTab settings={settings} save={saveSettingsAndRefresh} />}
      </div>
    </div>
  );
}

// ── 记账 Tab ────────────────────────────────────────────────────────────────
function QuickTab({ settings, refresh }: { settings: LedgerSettings; refresh: () => Promise<void> }) {
  const [text, setText] = useState('');
  const [type, setType] = useState<'expense' | 'income'>('expense');
  const [category, setCategory] = useState<string>('');
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState('');
  const [today, setToday] = useState<Bill[]>([]);

  const loadToday = useCallback(async () => {
    const arr = await loadDayBills(`ledger.day.${core.dayKeyOf(Date.now())}`);
    setToday(Array.isArray(arr) ? arr : []);
  }, []);
  useEffect(() => { void loadToday(); }, [loadToday]);

  const cats = type === 'expense' ? settings.categories : settings.incomeCategories;

  const submit = async () => {
    const amount = Number(text.trim());
    if (!Number.isFinite(amount) || amount <= 0) { setMsg('请输入正数金额'); return; }
    const r = await addBillStore({ amount, type, category: category || undefined, note: note.trim() || undefined }, 'panel');
    setMsg(r.ok ? (r.hint ? `已入账；${r.hint}` : '已入账') : (r.error ?? '记账失败'));
    if (r.ok) { setText(''); setNote(''); }
    await Promise.all([loadToday(), refresh()]);
  };

  const removeOne = async (id: string) => {
    await deleteBillById(id);
    await Promise.all([loadToday(), refresh()]);
  };

  return (
    <div className="pl-quick">
      <div className="pl-quick-type">
        <button className={type === 'expense' ? 'active' : ''} onClick={() => { setType('expense'); setCategory(''); }}>支出</button>
        <button className={type === 'income' ? 'active' : ''} onClick={() => { setType('income'); setCategory(''); }}>收入</button>
      </div>
      <input
        className="pl-quick-amount" inputMode="decimal" placeholder="0.00"
        value={text} onChange={(e) => setText(e.target.value.replace(/[^\d.]/g, ''))}
        onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
      />
      <div className="pl-quick-cats">
        {cats.map((c) => (
          <button key={c} className={`pl-cat-chip ${category === c ? 'active' : ''}`} onClick={() => setCategory(c)}>{c}</button>
        ))}
      </div>
      <input className="pl-quick-note" placeholder="备注（可选）" value={note} onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }} />
      <button className="pl-quick-submit" onClick={() => void submit()}>记一笔</button>
      {msg && <div className="pl-quick-msg">{msg}</div>}
      {today.length > 0 && (
        <div className="pl-quick-today">
          <div className="pl-section-title">今日（{today.length} 笔）</div>
          {today.slice().reverse().map((b) => (
            <div key={b.id} className="pl-bill-row">
              <span className={`pl-bill-amount ${b.type}`}>{b.type === 'income' ? '+' : '-'}{fmt(b.amount, settings.currencySymbol)}</span>
              <span className="pl-bill-cat">{b.category}</span>
              <span className="pl-bill-note">{b.note}</span>
              <button className="pl-bill-del" aria-label="删除" onClick={() => void removeOne(b.id)}>×</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── 明细 Tab ────────────────────────────────────────────────────────────────
function ListTab({ month, setMonth, bills, settings, refresh }: {
  month: string; setMonth: (m: string) => void; bills: Bill[]; settings: LedgerSettings; refresh: () => Promise<void>;
}) {
  const [filterCat, setFilterCat] = useState('');
  const [filterType, setFilterType] = useState<'' | 'expense' | 'income'>('');
  const [keyword, setKeyword] = useState('');
  const [copied, setCopied] = useState(false);

  const filtered = useMemo(() => core.filterBills(bills, {
    category: filterCat || undefined,
    type: filterType || undefined,
    keyword: keyword.trim() || undefined,
  }).slice().reverse(), [bills, filterCat, filterType, keyword]);

  const byDay = useMemo(() => {
    const m = new Map<string, Bill[]>();
    for (const b of filtered) {
      const d = core.dayKeyOf(b.ts);
      if (!m.has(d)) m.set(d, []);
      m.get(d)!.push(b);
    }
    // 时间倒序：日组最新在前（filtered 已倒序，组间天然倒序；显式排序兜底）
    return [...m.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [filtered]);

  const del = async (id: string) => { await deleteBillById(id); await refresh(); };

  const exportCsv = async () => {
    const csv = core.toCsv(filtered, settings.currencySymbol);
    try { await navigator.clipboard.writeText(csv); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* 剪贴板不可用静默 */ }
  };

  return (
    <div className="pl-list">
      <div className="pl-list-head">
        <button className="pl-month-btn" onClick={() => setMonth(core.shiftMonth(month, -1))} aria-label="上月">‹</button>
        <span className="pl-month">{month}</span>
        <button className="pl-month-btn" onClick={() => setMonth(core.shiftMonth(month, 1))} aria-label="下月">›</button>
        <button className="pl-export" onClick={() => void exportCsv()}>{copied ? '已复制' : '导出 CSV'}</button>
      </div>
      <div className="pl-list-filters">
        <select value={filterType} onChange={(e) => setFilterType(e.target.value as '' | 'expense' | 'income')}>
          <option value="">全部类型</option>
          <option value="expense">支出</option>
          <option value="income">收入</option>
        </select>
        <select value={filterCat} onChange={(e) => setFilterCat(e.target.value)}>
          <option value="">全部分类</option>
          {[...settings.categories, ...settings.incomeCategories].map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <input placeholder="关键词" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
      </div>
      {byDay.length === 0 && <div className="pl-empty">本月暂无账单</div>}
      {byDay.map(([day, list]) => {
        const net = list.reduce((s, b) => s + (b.type === 'income' ? b.amount : -b.amount), 0);
        return (
          <div key={day} className="pl-day-group">
            <div className="pl-day-head">
              <span>{day}</span>
              <span className={net >= 0 ? 'income' : 'expense'}>{net >= 0 ? '+' : ''}{fmt(net, settings.currencySymbol)}</span>
            </div>
            {list.slice().reverse().map((b) => (
              <div key={b.id} className="pl-bill-row">
                <span className={`pl-bill-amount ${b.type}`}>{b.type === 'income' ? '+' : '-'}{fmt(b.amount, settings.currencySymbol)}</span>
                <span className="pl-bill-cat">{b.category}</span>
                <span className="pl-bill-note">{b.note}</span>
                <span className="pl-bill-time">{new Date(b.ts).toTimeString().slice(0, 5)}</span>
                <button className="pl-bill-del" aria-label="删除" onClick={() => void del(b.id)}>×</button>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

// ── 统计 Tab ────────────────────────────────────────────────────────────────
function StatsTab({ stats }: { stats: CoreStats; settings: LedgerSettings }) {
  const maxDay = Math.max(...stats.byDay.map((d) => d.expense), 1);
  return (
    <div className="pl-stats">
      <div className="pl-stat-cards">
        <div className="pl-stat-card"><span>支出</span><strong>{fmt(stats.expense, stats.currencySymbol)}</strong></div>
        <div className="pl-stat-card"><span>收入</span><strong>{fmt(stats.income, stats.currencySymbol)}</strong></div>
        <div className="pl-stat-card"><span>结余</span><strong>{fmt(stats.balance, stats.currencySymbol)}</strong></div>
      </div>
      {stats.totalBudget != null && (
        <div className="pl-budget">
          <div className="pl-section-title">月预算 {fmt(stats.totalBudget, stats.currencySymbol)}</div>
          <div className="pl-budget-track">
            <div className="pl-budget-fill"
              style={{ width: `${Math.min(100, Math.round((stats.totalBudgetUsed ?? 0) * 100))}%`, background: (stats.totalBudgetUsed ?? 0) >= 1 ? 'var(--plite-danger)' : (stats.totalBudgetUsed ?? 0) >= 0.9 ? 'var(--plite-warning)' : 'var(--accent)' }} />
          </div>
          <span className="pl-budget-pct">{Math.round((stats.totalBudgetUsed ?? 0) * 100)}%</span>
        </div>
      )}
      <div className="pl-section-title">分类排行{stats.excludedSum > 0 ? `（另有 ${fmt(stats.excludedSum, stats.currencySymbol)} 不计入）` : ''}</div>
      <div className="pl-cat-rank">
        {stats.byCategory.map((c) => (
          <div key={c.category} className="pl-cat-row">
            <span className="pl-cat-name">{c.category}{c.excluded ? '（不计入）' : ''}</span>
            <span className="pl-cat-sum">{fmt(c.sum, stats.currencySymbol)}</span>
            {c.budget != null && c.budget > 0 && (
              <span className={`pl-cat-budget ${(c.sum / c.budget) >= 1 ? 'over' : (c.sum / c.budget) >= 0.9 ? 'warn' : ''}`}>
                {Math.round((c.sum / c.budget) * 100)}%
              </span>
            )}
          </div>
        ))}
      </div>
      <div className="pl-section-title">逐日支出</div>
      <div className="pl-bars">
        {stats.byDay.map((d) => (
          <div key={d.date} className="pl-bar-col" title={`${d.date}：${fmt(d.expense, stats.currencySymbol)}`}>
            <div className="pl-bar" style={{ height: `${Math.round((d.expense / maxDay) * 100)}%` }} />
            <span className="pl-bar-label">{Number(d.date.slice(-2))}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── 设置 Tab ────────────────────────────────────────────────────────────────
function SettingsTab({ settings, save }: { settings: LedgerSettings; save: (s: LedgerSettings) => Promise<void> }) {
  const [newCat, setNewCat] = useState('');
  const [budgetText, setBudgetText] = useState('');
  const [totalBudgetText, setTotalBudgetText] = useState(settings.monthlyTotalBudget != null ? String(settings.monthlyTotalBudget) : '');

  const addCat = async () => {
    const name = newCat.trim();
    if (!name || settings.categories.includes(name) || settings.incomeCategories.includes(name)) return;
    await save({ ...settings, categories: [...settings.categories, name] });
    setNewCat('');
  };
  const removeCat = async (name: string) => {
    await save({
      ...settings,
      categories: settings.categories.filter((c) => c !== name),
      incomeCategories: settings.incomeCategories.filter((c) => c !== name),
      budgets: Object.fromEntries(Object.entries(settings.budgets).filter(([k]) => k !== name)),
    });
  };
  const setBudget = async (cat: string, raw: string) => {
    const n = Number(raw.replace(/[^\d.]/g, ''));
    const budgets = { ...settings.budgets };
    if (Number.isFinite(n) && n > 0) budgets[cat] = n;
    else delete budgets[cat];
    await save({ ...settings, budgets });
  };

  return (
    <div className="pl-settings">
      <div className="pl-section-title">支出分类（点击 × 删除）</div>
      <div className="pl-settings-cats">
        {settings.categories.map((c) => (
          <span key={c} className="pl-cat-chip">{c}<button className="pl-cat-del" aria-label={`删除 ${c}`} onClick={() => void removeCat(c)}>×</button></span>
        ))}
      </div>
      <div className="pl-settings-row">
        <input placeholder="新分类名" value={newCat} onChange={(e) => setNewCat(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void addCat(); }} />
        <button onClick={() => void addCat()}>添加</button>
      </div>
      <div className="pl-section-title">分类月预算</div>
      {settings.categories.map((c) => (
        <div key={c} className="pl-settings-row">
          <span className="pl-budget-cat">{c}</span>
          <input placeholder="不限" defaultValue={settings.budgets[c] != null ? String(settings.budgets[c]) : ''}
            onBlur={(e) => void setBudget(c, e.target.value)} />
        </div>
      ))}
      <div className="pl-section-title">月度总预算</div>
      <div className="pl-settings-row">
        <input placeholder="不限（如 5000）" value={budgetText.length ? budgetText : (totalBudgetText ?? '')}
          onChange={(e) => setBudgetText(e.target.value)}
          onBlur={() => {
            const n = Number(budgetText.replace(/[^\d.]/g, ''));
            const next = Number.isFinite(n) && n > 0 ? n : null;
            setTotalBudgetText(next != null ? String(next) : '');
            if (next !== settings.monthlyTotalBudget) void save({ ...settings, monthlyTotalBudget: next });
          }} />
      </div>
      <div className="pl-settings-note">数据保存在服务端键值库（cap.kv，kv-store 插件）；换浏览器/多端打开看到同一份账。需要带走请「导出 CSV」。</div>
    </div>
  );
}
