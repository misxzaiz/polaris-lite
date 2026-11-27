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

  /* --- 加载函数 --- */

  const loadAll = useCallback(async (m: string) => {
    const totals = await loadTotals();
    setGrandIn(totals.grand.in);
    setGrandOut(totals.grand.out);
    setGrandCached(totals.grand.cached);
    setGrandTurns(totals.grand.turns);
    setGrandEst(totals.grand.est);
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
                <small>{grandIn ? ` ${Math.round((grandCached / (grandIn ?? 1)) * 100)}%` : ''}</small>
              </div>
              <div className="tlg-sub">估算轮次 {grandEst}（供应商未回 usage）</div>
            </div>
          </div>

          {/* 当月小计 */}
          <div className="tlg-month-sum">
            <span><b>{month}</b> 小计</span>
            <span>输入 {fmtTokens(mStats.inT)}</span>
            <span>输出 {fmtTokens(mStats.outT)}</span>
            <span>{mStats.turns} 轮{mStats.estPct > 0 ? ` · 估 ${mStats.estPct}%` : ''}</span>
          </div>

          {/* 当月每日柱状图 */}
          <div className="tlg-chart">
            {days.length === 0 ? (
              <div className="tlg-chart-empty">本月当前筛选下没有记录</div>
            ) : (
              days.map((d) => (
                <button
                  key={d.t}
                  type="button"
                  className="tlg-col"
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
                      <td className="tlg-ta-r">{r.cachedTokens != null ? fmtFull(r.cachedTokens) : '—'}</td>
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
      )}

      {note && <div className="tlg-note">{note}</div>}
      <div className="tlg-privacy">
        台账经 cap.kv 保存在实例数据目录（服务端 sqlite），换浏览器/清缓存数据仍在；明细保留最近 24 个月。
      </div>
    </div>
  );
}
