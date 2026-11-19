/**
 * 对话事件面板：按轮次列出「模型跳数 / 工具调用 / 输出 / 耗时」，点开看细节。
 *
 * 面板默认 320px（内容约 296px），所以是单列折叠列表而不是三栏：
 * 卡片头一行给出「时间 · 工具数 · 总耗时 · 结果」，展开才显示步骤与输出。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { NetPanel } from './NetPanel';
import { buildExport, clearAll, loadRecent, subscribe } from './turnStore';
import type { ToolCallRecord, TurnRecord } from './turnStore';

type Filter = 'all' | 'tools' | 'error';

function fmtClock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtDur(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

/** 0 不是"很快"，是"没有可测的生成"（模型直接发 tool_calls 时不产出文本） */
function fmtGen(ms: number): string {
  return ms > 0 ? fmtDur(ms) : '—';
}

/**
 * 一轮的整体耗时。取「事件跨度」与「工具耗时之和」的较大者：
 * 前者是首事件到结束，后者是服务端实测的执行时间；取大避免出现
 * 「工具 160ms，总时长 155ms」这种自相矛盾的展示。
 */
function turnSpan(turn: TurnRecord): number {
  const span = turn.endedAt - turn.startedAt;
  const toolMs = turn.tools.reduce((sum, t) => sum + (t.ms ?? 0), 0);
  return Math.max(span, toolMs);
}

function genMs(turn: TurnRecord): number {
  return turn.steps.reduce((sum, s) => sum + s.ms, 0);
}

function sessionTail(id: string): string {
  return id.length > 8 ? `…${id.slice(-6)}` : id;
}

function toolSummary(tool: ToolCallRecord): string {
  if (tool.exitCode !== undefined) return `exit ${tool.exitCode}`;
  if (tool.status === 'denied') return '已拒绝';
  if (tool.status === 'error') return '失败';
  return tool.status ?? '未完成';
}

function outcomeLabel(turn: TurnRecord): string {
  if (turn.outcome === 'done') return '完成';
  if (turn.outcome === 'aborted') return '中断';
  return '错误';
}

function TurnPanel() {
  const [turns, setTurns] = useState<TurnRecord[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 首次加载自动展开最新一轮：进面板就能看到最近发生了什么，而不是一排折叠条 */
  const autoOpened = useRef(false);

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      void loadRecent(300).then((list) => {
        if (!alive) return;
        setTurns(list);
        if (!autoOpened.current && list.length > 0) {
          autoOpened.current = true;
          setOpenId(list[0].turnId);
        }
      });
    };
    refresh();
    const off = subscribe(refresh);
    return () => {
      alive = false;
      off();
    };
  }, []);

  const shown = useMemo(() => {
    if (filter === 'all') return turns;
    if (filter === 'tools') return turns.filter((t) => t.tools.length > 0);
    return turns.filter((t) => t.outcome !== 'done');
  }, [turns, filter]);

  const stats = useMemo(() => {
    // 数字必须和筛选结果一致，否则「有工具 2」点进去只有 1 条会被当成 bug
    const abnormal = turns.filter((t) => t.outcome !== 'done').length;
    const withTools = turns.filter((t) => t.tools.length > 0).length;
    return { abnormal, withTools };
  }, [turns]);

  const onExport = () => {
    if (shown.length === 0) return;
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '');
    const text = buildExport(shown, `${filter}:${shown.length}`);
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ai-turns-${stamp}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1200);
  };

  const onClear = async () => {
    if (busy) return;
    if (!window.confirm('清空本机保存的全部轮次记录？该操作不可撤销。')) return;
    setBusy(true);
    await clearAll();
    setBusy(false);
    setOpenId(null);
  };

  return (
    <div className="aie-root">
      <div className="aie-bar">
        <div className="aie-seg" role="group" aria-label="筛选轮次">
          <button
            type="button"
            className={`aie-seg-btn${filter === 'all' ? ' is-on' : ''}`}
            aria-pressed={filter === 'all'}
            onClick={() => setFilter('all')}
          >
            全部 <span className="aie-num">{turns.length}</span>
          </button>
          <button
            type="button"
            className={`aie-seg-btn${filter === 'tools' ? ' is-on' : ''}`}
            aria-pressed={filter === 'tools'}
            onClick={() => setFilter('tools')}
          >
            有工具 <span className="aie-num">{stats.withTools}</span>
          </button>
          <button
            type="button"
            className={`aie-seg-btn${filter === 'error' ? ' is-on' : ''}`}
            aria-pressed={filter === 'error'}
            onClick={() => setFilter('error')}
          >
            异常 <span className="aie-num">{stats.abnormal}</span>
          </button>
        </div>
        <div className="aie-actions">
          <button type="button" className="aie-btn" onClick={onExport} disabled={shown.length === 0}>
            导出
          </button>
          <button type="button" className="aie-btn aie-btn-ghost" onClick={() => void onClear()} disabled={turns.length === 0 || busy}>
            清空
          </button>
        </div>
      </div>

      {shown.length === 0 ? (
        <div className="aie-empty">
          <strong>{turns.length === 0 ? '还没有轮次记录' : '当前筛选下没有记录'}</strong>
          <p>
            发一条对话后，这里会按轮次列出：用户输入原文、模型跳了几次、调了哪些工具、参数与输出、每一步花了多久。
            记录只留在本机。
          </p>
        </div>
      ) : (
        <ul className="aie-list">
          {shown.map((turn) => {
            const isOpen = openId === turn.turnId;
            const total = turnSpan(turn);
            return (
              <li key={turn.turnId} className={`aie-card${isOpen ? ' is-open' : ''}`}>
                <button
                  type="button"
                  className="aie-head"
                  aria-expanded={isOpen}
                  onClick={() => setOpenId(isOpen ? null : turn.turnId)}
                >
                  <span className={`aie-dot aie-dot-${turn.outcome}`} aria-hidden="true" />
                  <span className="aie-time">{fmtClock(turn.startedAt)}</span>
                  <span className="aie-meta">
                    {turn.tools.length > 0 ? `${turn.tools.length} 工具` : '无工具'}
                    <span className="aie-sep"> · </span>
                    {fmtGen(total)}
                  </span>
                  <span className={`aie-tag aie-tag-${turn.outcome}`}>{outcomeLabel(turn)}</span>
                </button>

                {isOpen && (
                  <div className="aie-body">
                    {turn.prompt !== undefined && (
                      <div className="aie-prompt">
                        <span className="aie-out-label">用户输入</span>
                        <pre className="aie-code">{turn.prompt || '（空）'}</pre>
                        {turn.attachments && turn.attachments.length > 0 && (
                          <div className="aie-prompt-att">附件：{turn.attachments.join('、')}</div>
                        )}
                      </div>
                    )}
                    <div className="aie-sub">
                      会话 {sessionTail(turn.sessionId)}
                      {turn.steps.length > 0 && (
                        <>
                          <span className="aie-sep"> · </span>
                          {turn.steps.length} 跳
                        </>
                      )}
                      {genMs(turn) > 0 && (
                        <>
                          <span className="aie-sep"> · </span>
                          生成 {fmtDur(genMs(turn))}
                        </>
                      )}
                      {turn.textLen > 0 && (
                        <>
                          <span className="aie-sep"> · </span>
                          {turn.textLen} 字
                        </>
                      )}
                    </div>

                    {turn.error && <div className="aie-err">{turn.error}</div>}

                    {turn.steps.length > 0 && (
                      <ol className="aie-steps">
                        {turn.steps.map((step) => (
                          <li key={step.index} className="aie-step">
                            <span className="aie-step-idx">第 {step.index + 1} 跳</span>
                            <span className="aie-step-meta">
                              {step.finishReason || '—'} · {fmtGen(step.ms)} · {step.textLen} 字
                            </span>
                          </li>
                        ))}
                      </ol>
                    )}

                    {turn.tools.length > 0 && (
                      <div className="aie-tools">
                        {turn.tools.map((tool) => (
                          <div key={tool.callId} className="aie-tool">
                            <div className="aie-tool-head">
                              <span className="aie-tool-name">{tool.name}</span>
                              <span className={`aie-tool-status${tool.exitCode !== undefined && tool.exitCode !== 0 ? ' is-bad' : ''}`}>
                                {toolSummary(tool)}
                              </span>
                              {tool.ms !== undefined && <span className="aie-tool-ms">{fmtDur(tool.ms)}</span>}
                              {tool.decision && (
                                <span className="aie-tool-approve">
                                  {tool.decision}
                                  {tool.approvalWaitedMs !== undefined ? ` ${fmtDur(tool.approvalWaitedMs)}` : ''}
                                </span>
                              )}
                            </div>
                            {tool.command && <pre className="aie-code aie-cmd">{tool.command}</pre>}
                            {tool.stdout !== undefined && tool.stdout !== '' && (
                              <div className="aie-out">
                                <span className="aie-out-label">stdout{tool.truncated ? '（已截断）' : ''}</span>
                                <pre className="aie-code">{tool.stdout}</pre>
                              </div>
                            )}
                            {tool.stderr !== undefined && tool.stderr !== '' && (
                              <div className="aie-out">
                                <span className="aie-out-label aie-out-bad">stderr</span>
                                <pre className="aie-code aie-code-bad">{tool.stderr}</pre>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

type View = 'turn' | 'net';

/**
 * 两个视图的分工是刻意的：
 * - 轮次回答「这一轮发生了什么」（对话语义，工具/审批/耗时）
 * - 请求回答「模型到底收到了什么、回了什么」（协议层，可复制 curl 复现）
 * 放同一个页签里切换，避免为同一份数据开两个 tab 占右栏。
 */
export function TimelinePanel() {
  const [view, setView] = useState<View>('turn');
  return (
    <div className="aie-shell">
      <div className="aie-viewtabs" role="tablist" aria-label="事件视图">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'turn'}
          className={`aie-viewtab${view === 'turn' ? ' is-on' : ''}`}
          onClick={() => setView('turn')}
        >
          轮次
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'net'}
          className={`aie-viewtab${view === 'net' ? ' is-on' : ''}`}
          onClick={() => setView('net')}
        >
          请求
        </button>
      </div>
      {view === 'turn' ? <TurnPanel /> : <NetPanel />}
    </div>
  );
}
