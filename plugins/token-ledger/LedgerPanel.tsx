/**
 * Token 台账面板：总用量 + 每日趋势 + 逐轮流水。
 *
 * 面板 320px（内容约 296px）单列布局，原型中四栏大数压缩为 2×2 网格。
 * 数字全部 tabular-nums + 等宽，账目对齐优先。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  backfillFromRequests,
  buildLedgerExport,
  clearLedger,
  loadRecentUsage,
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

/* ---------------- 统计 ---------------- */

interface DayBucket {
  t: number;
  rows: UsageRecord[];
  paidIn: number;
  cached: number;
  out: number;
}

function bucketByDay(rows: UsageRecord[], days: number): DayBucket[] {
  const out: DayBucket[] = [];
  for (let d = days - 1; d >= 0; d--) {
    const t = new Date(Date.now() - d * 864e5);
    t.setHours(0, 0, 0, 0);
    const dayRows = rows.filter((r) => new Date(r.at).toDateString() === t.toDateString());
    out.push({
      t: t.getTime(),
      rows: dayRows,
      paidIn: dayRows.reduce((s, r) => s + Math.max(0, r.inputTokens - (r.cachedTokens ?? 0)), 0),
      cached: dayRows.reduce((s, r) => s + (r.cachedTokens ?? 0), 0),
      out: dayRows.reduce((s, r) => s + r.outputTokens, 0),
    });
  }
  return out;
}

/* ---------------- 面板 ---------------- */

export function LedgerPanel() {
  const [rows, setRows] = useState<UsageRecord[]>([]);
  const [range, setRange] = useState<7 | 14 | 30>(14);
  const [pickDay, setPickDay] = useState<number | null>(null);
  const [pickModel, setPickModel] = useState('');
  const [pickSession, setPickSession] = useState('');
  const [showEstimated, setShowEstimated] = useState(true);
  const [busy, setBusy] = useState(false);
  const [backfillNote, setBackfillNote] = useState<string | null>(null);
  const autoBackfill = useRef(false);

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      void loadRecentUsage(5000).then((list) => {
        if (alive) setRows(list);
      });
    };
    refresh();
    const off = subscribeLedger(refresh);
    return () => {
      alive = false;
      off();
    };
  }, []);

  // 首次打开面板：从 ai-events 的 requests 表回填历史 usage（只跑一次）
  useEffect(() => {
    if (autoBackfill.current) return;
    autoBackfill.current = true;
    void backfillFromRequests().then((n) => {
      if (n > 0) setBackfillNote(`已从网络取证回填 ${n} 条历史用量`);
      void loadRecentUsage(5000).then((list) => setRows(list));
    });
  }, []);

  /* 全量（不含 range 筛选）用于过滤选项 */
  const models = useMemo(() => [...new Set(rows.map((r) => r.model ?? ''))].filter(Boolean).sort(), [rows]);
  const sessions = useMemo(() => [...new Set(rows.map((r) => r.sessionId))].sort(), [rows]);

  const visible = useMemo(() => {
    const from = Date.now() - range * 864e5;
    return rows.filter(
      (r) =>
        r.at >= from &&
        (!pickDay || new Date(r.at).toDateString() === new Date(pickDay).toDateString()) &&
        (!pickModel || r.model === pickModel) &&
        (!pickSession || r.sessionId === pickSession) &&
        (showEstimated || !r.estimated),
    );
  }, [rows, range, pickDay, pickModel, pickSession, showEstimated]);

  const days = useMemo(() => bucketByDay(visible, range), [visible, range]);

  const stats = useMemo(() => {
    const inT = visible.reduce((s, r) => s + r.inputTokens, 0);
    const outT = visible.reduce((s, r) => s + r.outputTokens, 0);
    const caT = visible.reduce((s, r) => s + (r.cachedTokens ?? 0), 0);
    const dur = visible.reduce((s, r) => s + (r.durationMs ?? 0), 0);
    const estC = visible.filter((r) => r.estimated).length;
    return {
      total: inT + outT,
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

  const shownRows = visible.slice(0, 300);

  const onExport = () => {
    if (visible.length === 0) return;
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '');
    const blob = new Blob([buildLedgerExport(visible, `range:${range}:${visible.length}`)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `token-ledger-${stamp}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1200);
  };

  const onClear = async () => {
    if (busy) return;
    if (!window.confirm('清空本机保存的全部 token 台账？该操作不可撤销。')) return;
    setBusy(true);
    await clearLedger();
    setBusy(false);
    setPickDay(null);
    setPickModel('');
    setPickSession('');
  };

  const hasData = rows.length > 0;

  return (
    <div className="tlg-root">
      {/* 时间范围 */}
      <div className="tlg-bar">
        <div className="tlg-seg" role="group" aria-label="时间范围">
          {([7, 14, 30] as const).map((d) => (
            <button
              key={d}
              type="button"
              className={`tlg-seg-btn${range === d ? ' is-on' : ''}`}
              aria-pressed={range === d}
              onClick={() => {
                setRange(d);
                setPickDay(null);
              }}
            >
              {d} 天
            </button>
          ))}
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
          <p>发一轮对话后，引擎在流末发出 ai.usage，这里会逐轮记账：输入、输出、缓存命中与速率。记录只留在本机。</p>
        </div>
      ) : (
        <>
          {/* 大数（2×2） */}
          <div className="tlg-hero">
            <div className="tlg-cell tlg-cell-main">
              <div className="tlg-k">累计总 token</div>
              <div className="tlg-v">
                {fmtTokens(stats.total)} <small>tok</small>
              </div>
              <div className="tlg-sub">
                输入 {fmtTokens(stats.inT)} + 输出 {fmtTokens(stats.outT)} · {stats.turns} 轮
              </div>
            </div>
            <div className="tlg-cell">
              <div className="tlg-k">
                <i className="tlg-dot tlg-d-in" aria-hidden="true" />付费输入
              </div>
              <div className="tlg-v tlg-c-in">{fmtTokens(stats.inT - stats.caT)}</div>
              <div className="tlg-sub">缓存命中 {fmtTokens(stats.caT)}（{stats.cachePct}%）</div>
            </div>
            <div className="tlg-cell">
              <div className="tlg-k">
                <i className="tlg-dot tlg-d-out" aria-hidden="true" />输出
              </div>
              <div className="tlg-v tlg-c-out">{fmtTokens(stats.outT)}</div>
              <div className="tlg-sub">均值 {stats.tps.toFixed(1)} tok/s</div>
            </div>
            <div className="tlg-cell">
              <div className="tlg-k">
                <i className="tlg-dot tlg-d-est" aria-hidden="true" />估算占比
              </div>
              <div className="tlg-v tlg-c-est">{stats.estPct}%</div>
              <div className="tlg-sub">{stats.estC}/{stats.turns} 轮为字符估算</div>
            </div>
          </div>

          {/* 每日趋势 */}
          <div className="tlg-chart">
            <div className="tlg-chart-head">
              每日用量
              <span className="tlg-chart-hint">{pickDay != null ? '再次点击当日柱子取消筛选' : '点击柱子筛当日流水'}</span>
            </div>
            <div className="tlg-bars">
              {days.map((d) => {
                const total = d.paidIn + d.cached + d.out;
                const off = pickDay != null && d.t !== pickDay && new Date(d.t).toDateString() !== (pickDay ? new Date(pickDay).toDateString() : '');
                const title =
                  total > 0
                    ? `${fmtDay(d.t)}：付费输入 ${fmtFull(d.paidIn)} · 缓存 ${fmtFull(d.cached)} · 输出 ${fmtFull(d.out)} · ${d.rows.length} 轮`
                    : `${fmtDay(d.t)}：无用量`;
                return (
                  <button
                    key={d.t}
                    type="button"
                    className={`tlg-bcol${off ? ' is-off' : ''}${pickDay === d.t ? ' is-pick' : ''}`}
                    title={title}
                    aria-label={title}
                    onClick={() => setPickDay(pickDay === d.t ? null : d.t)}
                  >
                    {total > 0 ? (
                      <>
                        {d.out > 0 && <i className="tlg-seg tlg-s-out" style={{ height: `${(d.out / maxDay) * 100}%` }} />}
                        {d.cached > 0 && <i className="tlg-seg tlg-s-cache" style={{ height: `${(d.cached / maxDay) * 100}%` }} />}
                        {d.paidIn > 0 && <i className="tlg-seg tlg-s-in" style={{ height: `${(d.paidIn / maxDay) * 100}%` }} />}
                      </>
                    ) : (
                      <i className="tlg-seg tlg-s-none" />
                    )}
                  </button>
                );
              })}
            </div>
            <div className="tlg-axis">
              {days.map((d) => (
                <span key={d.t}>{fmtDay(d.t)}</span>
              ))}
            </div>
            <div className="tlg-legend">
              <i><b className="tlg-dot tlg-d-in" />付费输入</i>
              <i><b className="tlg-dot tlg-d-cache" />缓存命中</i>
              <i><b className="tlg-dot tlg-d-out" />输出</i>
            </div>
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

          {/* 流水表 */}
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
                  <td className="tlg-ta-r tlg-c-in">{fmtTokens(stats.inT)}</td>
                  <td className="tlg-ta-r">{fmtTokens(stats.caT)}</td>
                  <td className="tlg-ta-r tlg-c-out">{fmtTokens(stats.outT)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
          {visible.length > shownRows.length && (
            <div className="tlg-more">展示最近 {shownRows.length} / {visible.length} 条</div>
          )}
        </>
      )}

      {backfillNote && <div className="tlg-note">{backfillNote}</div>}
      <div className="tlg-privacy">台账保存在本机 IndexedDB，不离开浏览器；卸载插件重装后数据仍在。</div>
    </div>
  );
}
