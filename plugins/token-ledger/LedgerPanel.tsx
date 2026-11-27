/**
 * Token 台账面板 v2：电脑存储（cap.kv）+ 按月分页。
 *
 * 数据流：大数/柱状图 ← totals 聚合键；流水明细 ← 按月翻页（内存中只有一个月）。
 * 面板 320px（内容约 296px）单列布局，数字 tabular-nums 对齐。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  backfillFromRequests,
  buildLedgerExport,
  clearLedger,
  currentMonthKey,
  listMonths,
  loadMonthRows,
  loadTotals,
  migrateFromIndexedDb,
  shiftMonth,
  subscribeLedger,
  type Totals,
  type UsageRecord,
} from './ledgerStore';
import './token-ledger.css';

/* ---------------- 格式化 ---------------- */

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function fmtFull(n: number): string {
  return n.toLocaleString('en-US');
}

function fmtClock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtDay(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function sessionTail(id: string): string {
  return id.length > 12 ? `…${id.slice(-8)}` : id;
}

function isToday(ts: number): boolean {
  return new Date(ts).toDateString() === new Date().toDateString();
}

/* ---------------- 面板 ---------------- */

export function LedgerPanel() {
  // 聚合态（totals 键，轻量）
  const [grandIn, setGrandIn] = useState<number | null>(null);
  const [grandOut, setGrandOut] = useState(0);
  const [grandCached, setGrandCached] = useState(0);
  const [grandRealIn, setGrandRealIn] = useState(0);
  const [grandTurns, setGrandTurns] = useState(0);
  const [grandEst, setGrandEst] = useState(0);

  // 当月态
  const [month, setMonth] = useState<string>(currentMonthKey());
  const [rows, setRows] = useState<UsageRecord[]>([]);
  const [months, setMonths] = useState<string[]>([]);

  // 筛选
  const [pickModel, setPickModel] = useState('');
  const [pickSession, setPickSession] = useState('');
  const [showEstimated, setShowEstimated] = useState(true);

  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const bootRef = useRef(false);

  // 视图切换：flow=流水明细 stats=统计
  const [view, setView] = useState<'flow' | 'stats'>('flow');
  // 完整聚合（统计视图数据源；月键值对象很小，常驻无压力）
  const [totals, setTotals] = useState<Totals | null>(null);

  /* --- 加载函数 --- */

  const loadAll = useCallback(async (m: string) => {
    const t = await loadTotals();
    setTotals(t);
    setGrandIn(t.grand.in);
    setGrandOut(t.grand.out);
    setGrandCached(t.grand.cached);
    setGrandRealIn(t.grand.realIn ?? t.grand.in);
    setGrandTurns(t.grand.turns);
    setGrandEst(t.grand.est);
    const ms = await listMonths();
    setMonths(ms);
    setRows(await loadMonthRows(m));
  }, []);

  /* --- 挂载：迁移/回填 → 首载（api 已由插件 setup 注入 store） --- */
  useEffect(() => {
    if (bootRef.current) return;
    bootRef.current = true;
    let alive = true;
    void (async () => {
      const mig = await migrateFromIndexedDb();
      const bf = await backfillFromRequests();
      if (!alive) return;
      const parts: string[] = [];
      if (mig > 0) parts.push(`已迁移本机旧台账 ${mig} 条`);
      if (bf > 0) parts.push(`已从网络取证回填 ${bf} 条`);
      if (parts.length > 0) setNote(parts.join('；'));
      await loadAll(currentMonthKey());
    })();
    const off = subscribeLedger(() => {
      void loadAll(monthRef.current);
    });
    return () => {
      alive = false;
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const monthRef = useRef(month);
  useEffect(() => {
    monthRef.current = month;
  }, [month]);

  /* --- 翻月 --- */
  const gotoMonth = useCallback(
    (m: string) => {
      setMonth(m);
      setPickModel('');
      setPickSession('');
      void loadMonthRows(m).then(setRows);
    },
    [],
  );

  const shift = useCallback(
    (delta: number) => {
      const next = shiftMonth(month, delta);
      gotoMonth(next);
    },
    [month, gotoMonth],
  );

  /* --- 当前视图派生 --- */

  const models = useMemo(() => [...new Set(rows.map((r) => r.model ?? ''))].filter(Boolean).sort(), [rows]);
  const sessions = useMemo(() => [...new Set(rows.map((r) => r.sessionId))].sort(), [rows]);

  const visible = useMemo(
    () =>
      rows.filter(
        (r) =>
          (!pickModel || r.model === pickModel) &&
          (!pickSession || r.sessionId === pickSession) &&
          (showEstimated || !r.estimated),
      ),
    [rows, pickModel, pickSession, showEstimated],
  );

  /** 当月按天聚合（柱状图） */
  const days = useMemo(() => {
    const map = new Map<string, { t: number; paidIn: number; cached: number; out: number; turns: number }>();
    for (const r of visible) {
      const d = new Date(r.at);
      d.setHours(0, 0, 0, 0);
      const k = String(d.getTime());
      const b = map.get(k) ?? { t: d.getTime(), paidIn: 0, cached: 0, out: 0, turns: 0 };
      b.paidIn += Math.max(0, r.inputTokens - (r.cachedTokens ?? 0));
      b.cached += r.cachedTokens ?? 0;
      b.out += r.outputTokens;
      b.turns += 1;
      map.set(k, b);
    }
    return [...map.values()].sort((a, b) => a.t - b.t);
  }, [visible]);

  const mStats = useMemo(() => {
    const inT = visible.reduce((s, r) => s + r.inputTokens, 0);
    const outT = visible.reduce((s, r) => s + r.outputTokens, 0);
    const caT = visible.reduce((s, r) => s + (r.cachedTokens ?? 0), 0);
    const dur = visible.reduce((s, r) => s + (r.durationMs ?? 0), 0);
    const estC = visible.filter((r) => r.estimated).length;
    return {
      inT,
      outT,
      caT,
      tps: outT / Math.max(0.001, dur / 1000),
      turns: visible.length,
      estC,
      estPct: visible.length ? Math.round((estC / visible.length) * 100) : 0,
      cachePct: inT ? Math.round((caT / inT) * 100) : 0,
    };
  }, [visible]);

  const maxDay = Math.max(1, ...days.map((d) => d.paidIn + d.cached + d.out));

  /* --- 统计视图派生：全部来自 totals 聚合（轻量，不翻明细） --- */

  /** 今日：当前月 totals 的今天键；月份不在当月时为空 */
  const todayAgg = useMemo(() => {
    if (!totals) return null;
    const now = new Date();
    const mk = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const dd = String(now.getDate()).padStart(2, '0');
    return totals.months[mk]?.[dd] ?? null;
  }, [totals]);

  /** 近 7 天（含今日，按天倒序）：从 totals 直接取，跨月自动拼接 */
  const last7 = useMemo(() => {
    if (!totals) return [];
    const out: { date: string; t: number; agg: NonNullable<Totals['months'][string][string]> }[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const mk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const dd = String(d.getDate()).padStart(2, '0');
      const agg = totals.months[mk]?.[dd];
      if (agg) out.push({ date: `${mk}-${dd}`, t: d.getTime(), agg });
    }
    return out;
  }, [totals]);

  /** 选中月的逐日统计行（升序，供统计表） */
  const monthDayRows = useMemo(() => {
    if (!totals) return [];
    const dm = totals.months[month] ?? {};
    return Object.entries(dm)
      .map(([dd, a]) => ({ dd, ...a }))
      .sort((a, b) => a.dd.localeCompare(b.dd));
  }, [totals, month]);

  /** 模型分布（当月明细聚合，按总 token 降序） */
  const modelStats = useMemo(() => {
    const map = new Map<string, { in: number; out: number; cached: number; turns: number }>();
    for (const r of rows) {
      const key = r.model || '未知';
      const b = map.get(key) ?? { in: 0, out: 0, cached: 0, turns: 0 };
      b.in += r.inputTokens;
      b.out += r.outputTokens;
      b.cached += r.cachedTokens ?? 0;
      b.turns += 1;
      map.set(key, b);
    }
    return [...map.entries()]
      .map(([model, v]) => ({ model, ...v, total: v.in + v.out }))
      .sort((a, b) => b.total - a.total);
  }, [rows]);


  /* --- 明细分页：每页 50 条，独立于月翻页 --- */
  const PAGE_SIZE = 50;
  const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const pageNum = Math.min(page, totalPages);
  const pageStart = (pageNum - 1) * PAGE_SIZE;
  const shownRows = visible.slice(pageStart, pageStart + PAGE_SIZE);
  // 筛选/翻月后页码越界自动收敛
  useEffect(() => {
    if (page > totalPages) setPage(1);
  }, [page, totalPages]);
  useEffect(() => {
    setPage(1);
  }, [pickModel, pickSession, showEstimated, month]);

  const onExport = () => {
    if (visible.length === 0) return;
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '');
    const blob = new Blob([buildLedgerExport(visible, `month:${month}`)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `token-ledger-${month}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1200);
    void stamp;
  };

  const onClear = async () => {
    if (busy) return;
    if (!window.confirm('清空保存在服务端的全部 token 台账？该操作不可撤销。')) return;
    setBusy(true);
    await clearLedger();
    setBusy(false);
    setPickModel('');
    setPickSession('');
    setMonth(currentMonthKey());
    await loadAll(currentMonthKey());
  };

  const hasData = grandIn !== null && (grandTurns > 0 || rows.length > 0);

  return (
    <div className="tlg-root">
      {/* 时间范围 → 月翻页 */}
      <div className="tlg-bar">
        <div className="tlg-seg" role="group" aria-label="月份">
          <button type="button" className="tlg-seg-btn" onClick={() => shift(-1)} aria-label="上一月">‹</button>
          <select
            className="tlg-select tlg-month-sel"
            value={month}
            onChange={(e) => gotoMonth(e.target.value)}
            aria-label="选择月份"
          >
            {(months.length > 0 ? months : [month]).map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          <button
            type="button"
            className="tlg-seg-btn"
            onClick={() => shift(1)}
            aria-label="下一月"
            disabled={month >= currentMonthKey()}
          >
            ›
          </button>
        </div>
        <div className="tlg-seg" role="group" aria-label="视图">
          <button
            type="button"
            className={`tlg-seg-btn${view === 'flow' ? ' is-on' : ''}`}
            onClick={() => setView('flow')}
          >
            流水
          </button>
          <button
            type="button"
            className={`tlg-seg-btn${view === 'stats' ? ' is-on' : ''}`}
            onClick={() => setView('stats')}
          >
            统计
          </button>
        </div>
        <div className="tlg-actions">
          <button type="button" className="tlg-btn" onClick={onExport} disabled={visible.length === 0}>
            导出
          </button>
          <button
            type="button"
            className="tlg-btn tlg-btn-ghost"
            onClick={() => void onClear()}
            disabled={!hasData || busy}
          >
            清空
          </button>
        </div>
      </div>

      {!hasData ? (
        <div className="tlg-empty">
          <strong>还没有用量记录</strong>
          <p>
            发一轮对话后，引擎在流末发出 ai.usage，这里会逐轮记账。台账保存在实例数据目录（服务端
            sqlite），换浏览器或清缓存数据仍在。
          </p>
        </div>
      ) : (
        <>
          {/* 大数：结转累计（跨月总账） */}
          <div className="tlg-hero">
            <div className="tlg-cell tlg-cell-main">
              <div className="tlg-k">累计总 token</div>
              <div className="tlg-v">
                {fmtTokens((grandIn ?? 0) + grandOut)} <small>tok</small>
              </div>
              <div className="tlg-sub">
                输入 {fmtTokens(grandIn ?? 0)} + 输出 {fmtTokens(grandOut)} · {grandTurns} 轮
              </div>
            </div>
            <div className="tlg-cell">
              <div className="tlg-k">
                <i className="tlg-dot tlg-d-in" aria-hidden="true" />缓存命中
              </div>
              <div className="tlg-v tlg-c-in">
                {fmtTokens(grandCached)}
                <small>{grandRealIn ? ` ${Math.round((grandCached / grandRealIn) * 100)}%` : ''}</small>
              </div>
              <div className="tlg-sub">估算轮次 {grandEst}（供应商未回 usage）</div>
            </div>
          </div>

          {view === 'flow' ? (<>
          {/* 当月小计 */}
          <div className="tlg-month-sum">
            <span><b>{month}</b> 小计</span>
            <span>输入 {fmtTokens(mStats.inT)}</span>
            <span>输出 {fmtTokens(mStats.outT)}</span>
            <span>{mStats.turns} 轮{mStats.estPct > 0 ? ` · 估 ${mStats.estPct}%` : ''}</span>
          </div>

          {/* 当月每日柱状图（每月 31 列，柱内三段堆叠） */}
          <div className="tlg-chart">
            <div className="tlg-chart-head">
              <span>每日用量</span>
              <span className="tlg-chart-hint">{month}</span>
            </div>
            <div className="tlg-bars">
              {days.length === 0 ? (
                <div className="tlg-chart-empty" style={{ width: '100%' }}>本月当前筛选下没有记录</div>
              ) : (
                days.map((d) => (
                  <button
                    key={d.t}
                    type="button"
                    className="tlg-bcol"
                    title={`${fmtDay(d.t)}：输入 ${fmtFull(d.paidIn + d.cached)}（缓存 ${fmtFull(d.cached)}）· 输出 ${fmtFull(d.out)} · ${d.turns} 轮${isToday(d.t) ? '（今天）' : ''}`}
                    onClick={() => setPickSession('')}
                  >
                    <i className="tlg-seg tlg-s-out" style={{ height: `${(d.out / maxDay) * 100}%` }} />
                    <i className="tlg-seg tlg-s-cache" style={{ height: `${(d.cached / maxDay) * 100}%` }} />
                    <i className="tlg-seg tlg-s-in" style={{ height: `${(d.paidIn / maxDay) * 100}%` }} />
                  </button>
                ))
              )}
            </div>
            {days.length > 0 && (
              <div className="tlg-axis">
                {days.map((d) => (
                  <span key={d.t}>{fmtDay(d.t)}</span>
                ))}
              </div>
            )}
          </div>
          <div className="tlg-legend">
            <i><b className="tlg-dot tlg-d-in" />付费输入</i>
            <i><b className="tlg-dot tlg-d-cache" />缓存命中</i>
            <i><b className="tlg-dot tlg-d-out" />输出</i>
          </div>

          {/* 流水筛选 */}
          <div className="tlg-filter">
            <select className="tlg-select" value={pickModel} onChange={(e) => setPickModel(e.target.value)} aria-label="按模型筛选">
              <option value="">全部模型</option>
              {models.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
            <select className="tlg-select" value={pickSession} onChange={(e) => setPickSession(e.target.value)} aria-label="按会话筛选">
              <option value="">全部会话</option>
              {sessions.map((s) => (
                <option key={s} value={s}>{sessionTail(s)}</option>
              ))}
            </select>
            <label className="tlg-check">
              <input type="checkbox" checked={showEstimated} onChange={(e) => setShowEstimated(e.target.checked)} />
              含估算
            </label>
          </div>

          {/* 流水表：本月明细 */}
          <div className="tlg-table-wrap">
            <table className="tlg-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>会话</th>
                  <th className="tlg-ta-r">输入</th>
                  <th className="tlg-ta-r">缓存</th>
                  <th className="tlg-ta-r">输出</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shownRows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="tlg-table-empty">
                      当前筛选下没有记录
                    </td>
                  </tr>
                ) : (
                  shownRows.map((r) => (
                    <tr key={r.id}>
                      <td className="tlg-mut">{fmtClock(r.at)}</td>
                      <td className="tlg-sess" title={r.sessionId}>{sessionTail(r.sessionId)}</td>
                      <td className="tlg-ta-r tlg-c-in">{fmtFull(r.inputTokens)}</td>
                      <td className="tlg-ta-r" title="N/A：供应商未回传缓存字段，非 0">
                        {r.cachedTokens != null ? fmtFull(r.cachedTokens) : 'N/A'}
                      </td>
                      <td className="tlg-ta-r tlg-c-out">{fmtFull(r.outputTokens)}</td>
                      <td className="tlg-ta-r">
                        {r.estimated ? (
                          <span className="tlg-badge tlg-b-est" title="供应商未回 usage，按字符÷4 估算">估</span>
                        ) : (
                          <span className="tlg-badge tlg-b-real" title="来自供应商真实 usage">实</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={2}>筛选合计（{visible.length} 轮）</td>
                  <td className="tlg-ta-r tlg-c-in">{fmtTokens(mStats.inT)}</td>
                  <td className="tlg-ta-r">{fmtTokens(mStats.caT)}</td>
                  <td className="tlg-ta-r tlg-c-out">{fmtTokens(mStats.outT)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
          {totalPages > 1 && (
            <div className="tlg-pager">
              <button
                type="button"
                className="tlg-btn"
                disabled={pageNum <= 1}
                onClick={() => setPage(pageNum - 1)}
                aria-label="上一页"
              >
                ‹
              </button>
              <span className="tlg-pager-info">
                第 {pageNum} / {totalPages} 页
                <small>共 {visible.length} 条</small>
              </span>
              <button
                type="button"
                className="tlg-btn"
                disabled={pageNum >= totalPages}
                onClick={() => setPage(pageNum + 1)}
                aria-label="下一页"
              >
                ›
              </button>
            </div>
          )}
          </>
          ) : (
          <div className="tlg-stats">
            {/* 今日卡片 */}
            <div className="tlg-today">
              <div className="tlg-today-cell">
                <div className="tlg-k">今日总 token</div>
                <div className="tlg-v tlg-v-sm">
                  {todayAgg ? fmtTokens(todayAgg.in + todayAgg.out) : '0'}
                </div>
                <div className="tlg-sub">
                  {todayAgg
                    ? `输入 ${fmtTokens(todayAgg.in)} + 输出 ${fmtTokens(todayAgg.out)} · ${todayAgg.turns} 轮`
                    : '今天还没有对话'}
                </div>
              </div>
              <div className="tlg-today-cell">
                <div className="tlg-k">
                  <i className="tlg-dot tlg-d-cache" aria-hidden="true" />今日缓存命中
                </div>
                <div className="tlg-v tlg-v-sm">
                  {fmtTokens(todayAgg?.cached ?? 0)}
                  {todayAgg?.realIn ? <small> {Math.round((todayAgg.cached / todayAgg.realIn) * 100)}%</small> : null}
                </div>
                <div className="tlg-sub">{todayAgg ? `真实轮 ${todayAgg.turns - todayAgg.est} / 估算轮 ${todayAgg.est}` : '—'}</div>
              </div>
            </div>

            {/* 近 7 天迷你条 */}
            <div className="tlg-week">
              <div className="tlg-chart-head">
                <span>近 7 天</span>
                <span className="tlg-chart-hint">点击流水视图可看每日明细</span>
              </div>
              <div className="tlg-bars">
                {last7.length === 0 ? (
                  <div className="tlg-chart-empty" style={{ width: '100%' }}>近 7 天暂无记录</div>
                ) : (
                  (() => {
                    const mw = Math.max(1, ...last7.map((d) => d.agg.in + d.agg.out));
                    return last7.map((d) => {
                      const total = d.agg.in + d.agg.out;
                      const cachePct = total ? (d.agg.cached / total) * 100 : 0;
                      return (
                        <button
                          key={d.date}
                          type="button"
                          className="tlg-bcol"
                          title={`${d.date}：输入 ${fmtFull(d.agg.in)}（缓存 ${fmtFull(d.agg.cached)}）· 输出 ${fmtFull(d.agg.out)} · ${d.agg.turns} 轮`}
                        >
                          <i className="tlg-seg tlg-s-out" style={{ height: `${(d.agg.out / mw) * 100}%` }} />
                          <i className="tlg-seg tlg-s-cache" style={{ height: `${(cachePct * d.agg.in / mw) || 0}%` }} />
                          <i className="tlg-seg tlg-s-in" style={{ height: `${((d.agg.in - d.agg.cached) / mw) * 100}%` }} />
                        </button>
                      );
                    });
                  })()
                )}
              </div>
              <div className="tlg-axis">
                {last7.map((d) => {
                  const dd = new Date(d.date + 'T00:00:00');
                  return <span key={d.date}>{`${dd.getMonth() + 1}/${dd.getDate()}`}</span>;
                })}
              </div>
            </div>

            {/* 选中月逐日统计表 */}
            <div className="tlg-daily-wrap">
              <div className="tlg-chart-head">
                <span>{month} 逐日</span>
                <span className="tlg-chart-hint">来自天级聚合，非明细</span>
              </div>
              <table className="tlg-table tlg-daily">
                <thead>
                  <tr>
                    <th>日期</th>
                    <th className="tlg-ta-r">轮次</th>
                    <th className="tlg-ta-r">输入</th>
                    <th className="tlg-ta-r">缓存</th>
                    <th className="tlg-ta-r">命中%</th>
                    <th className="tlg-ta-r">输出</th>
                  </tr>
                </thead>
                <tbody>
                  {monthDayRows.length === 0 ? (
                    <tr><td colSpan={6} className="tlg-table-empty">本月暂无记录</td></tr>
                  ) : (
                    monthDayRows.map((r) => (
                      <tr key={r.dd}>
                        <td className="tlg-mut">{r.dd}</td>
                        <td className="tlg-ta-r">{r.turns}</td>
                        <td className="tlg-ta-r tlg-c-in">{fmtTokens(r.in)}</td>
                        <td className="tlg-ta-r">{fmtTokens(r.cached)}</td>
                        <td className="tlg-ta-r">{r.realIn ? `${Math.round((r.cached / r.realIn) * 100)}%` : '—'}</td>
                        <td className="tlg-ta-r tlg-c-out">{fmtTokens(r.out)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
                {monthDayRows.length > 0 && (
                  <tfoot>
                    <tr>
                      <td>合计</td>
                      <td className="tlg-ta-r">{monthDayRows.reduce((s, r) => s + r.turns, 0)}</td>
                      <td className="tlg-ta-r tlg-c-in">{fmtTokens(monthDayRows.reduce((s, r) => s + r.in, 0))}</td>
                      <td className="tlg-ta-r">{fmtTokens(monthDayRows.reduce((s, r) => s + r.cached, 0))}</td>
                      <td className="tlg-ta-r">—</td>
                      <td className="tlg-ta-r tlg-c-out">{fmtTokens(monthDayRows.reduce((s, r) => s + r.out, 0))}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>

            {/* 模型分布 */}
            <div className="tlg-models">
              <div className="tlg-chart-head">
                <span>模型分布（{month}）</span>
                <span className="tlg-chart-hint">按总 token 降序</span>
              </div>
              {modelStats.length === 0 ? (
                <div className="tlg-chart-empty">本月暂无记录</div>
              ) : (
                modelStats.map((m) => {
                  const max = modelStats[0].total;
                  return (
                    <div key={m.model} className="tlg-model-row" title={`${m.model}：输入 ${fmtFull(m.in)} · 输出 ${fmtFull(m.out)} · ${m.turns} 轮`}>
                      <div className="tlg-model-name">{m.model}</div>
                      <div className="tlg-model-bar">
                        <i className="tlg-model-fill tlg-s-in" style={{ width: `${(m.in / max) * 100}%` }} />
                        <i className="tlg-model-fill tlg-s-cache" style={{ width: `${(m.cached / max) * 100}%` }} />
                        <i className="tlg-model-fill tlg-s-out" style={{ width: `${(m.out / max) * 100}%` }} />
                      </div>
                      <div className="tlg-model-num">{fmtTokens(m.total)}</div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
          )}
        </>
      )}

      {note && <div className="tlg-note">{note}</div>}
      <div className="tlg-privacy">
        台账经 cap.kv 保存在实例数据目录（服务端 sqlite），换浏览器/清缓存数据仍在；明细保留最近 24 个月。
      </div>
    </div>
  );
}
