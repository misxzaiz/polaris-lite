/**
 * HTTP 取证面板：按请求列出「发了什么 / 回了什么」，可复制 curl 直接复现。
 *
 * 与轮次视图的分工：
 * - 轮次：这一轮调了几次工具、谁批准、结果如何（对话语义）
 * - 请求：模型收到的原始 messages/tools/参数、上游返回的 SSE 帧（协议层，可复现）
 */
import { copyText } from '../shared/copyText';

import { useEffect, useMemo, useState } from 'react';
import { buildNetExport, clearNet, loadRecentNet, subscribeNet } from './netStore';
import type { HttpKind, HttpRecord } from './netStore';

type KindFilter = 'all' | 'model' | 'tool' | 'other';

const KIND_LABEL: Record<HttpKind, string> = {
  model: 'AI',
  tool: '工具',
  fs: '文件',
  auth: '登录',
  app: '应用',
};

function fmtClock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtDur(ms: number): string {
  if (!ms) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

function fmtBytes(n: number): string {
  if (!n) return '0';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/** JSON 美化；非 JSON 原样返回（SSE 原文、纯文本错误页都走这里） */
function pretty(text: string | null): string {
  if (!text) return '';
  const t = text.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return text;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return text;
  }
}

function statusClass(rec: HttpRecord): string {
  if (rec.error) return 'is-bad';
  if (rec.status === 0) return 'is-live';
  if (rec.status >= 400) return 'is-bad';
  return 'is-ok';
}

export function NetPanel() {
  const [recs, setRecs] = useState<HttpRecord[]>([]);
  const [filter, setFilter] = useState<KindFilter>('all');
  const [openId, setOpenId] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      void loadRecentNet(200).then((list) => {
        if (alive) setRecs(list);
      });
    };
    refresh();
    const off = subscribeNet(refresh);
    return () => {
      alive = false;
      off();
    };
  }, []);

  const shown = useMemo(() => {
    if (filter === 'all') return recs;
    if (filter === 'model') return recs.filter((r) => r.kind === 'model');
    if (filter === 'tool') return recs.filter((r) => r.kind === 'tool');
    return recs.filter((r) => r.kind !== 'model' && r.kind !== 'tool');
  }, [recs, filter]);

  const counts = useMemo(
    () => ({
      model: recs.filter((r) => r.kind === 'model').length,
      tool: recs.filter((r) => r.kind === 'tool').length,
    }),
    [recs],
  );

  const doCopy = async (key: string, text: string) => {
    const ok = await copyText(text);
    setCopied(ok ? key : `${key}:fail`);
    setTimeout(() => setCopied((cur) => (cur === key || cur === `${key}:fail` ? null : cur)), 1400);
  };

  const onExport = () => {
    if (shown.length === 0) return;
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '');
    const blob = new Blob([buildNetExport(shown, `${filter}:${shown.length}`)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ai-http-${stamp}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1200);
  };

  const onClear = async () => {
    if (!window.confirm('清空本机保存的全部请求记录？该操作不可撤销。')) return;
    await clearNet();
    setOpenId(null);
  };

  return (
    <div className="aie-net">
      <div className="aie-bar">
        <div className="aie-seg" role="group" aria-label="筛选请求">
          <button
            type="button"
            className={`aie-seg-btn${filter === 'all' ? ' is-on' : ''}`}
            aria-pressed={filter === 'all'}
            onClick={() => setFilter('all')}
          >
            全部 <span className="aie-num">{recs.length}</span>
          </button>
          <button
            type="button"
            className={`aie-seg-btn${filter === 'model' ? ' is-on' : ''}`}
            aria-pressed={filter === 'model'}
            onClick={() => setFilter('model')}
          >
            AI <span className="aie-num">{counts.model}</span>
          </button>
          <button
            type="button"
            className={`aie-seg-btn${filter === 'tool' ? ' is-on' : ''}`}
            aria-pressed={filter === 'tool'}
            onClick={() => setFilter('tool')}
          >
            工具 <span className="aie-num">{counts.tool}</span>
          </button>
          <button
            type="button"
            className={`aie-seg-btn${filter === 'other' ? ' is-on' : ''}`}
            aria-pressed={filter === 'other'}
            onClick={() => setFilter('other')}
          >
            其它
          </button>
        </div>
        <div className="aie-actions">
          <button type="button" className="aie-btn" onClick={onExport} disabled={shown.length === 0}>
            导出
          </button>
          <button type="button" className="aie-btn aie-btn-ghost" onClick={() => void onClear()} disabled={recs.length === 0}>
            清空
          </button>
        </div>
      </div>

      <div className="aie-privacy">仅存本机 · 密钥/口令类字段与 sk-/Bearer/JWT 形态已脱敏 · 登录请求不留存正文</div>

      {shown.length === 0 ? (
        <div className="aie-empty">
          <strong>还没有请求记录</strong>
          <p>
            从下一次请求开始记录：模型收到的 messages / tools / 参数、上游返回的 SSE 帧与
            usage、工具执行、文件访问都会逐条落到这里，可复制 curl 复现（敏感值已脱敏，需自行补回）。
          </p>
        </div>
      ) : (
        <ul className="aie-list">
          {shown.map((rec) => {
            const isOpen = openId === rec.id;
            const curlKey = `curl:${rec.id}`;
            const upKey = `up:${rec.id}`;
            return (
              <li key={rec.id} className={`aie-card aie-net-card${isOpen ? ' is-open' : ''}`}>
                <button
                  type="button"
                  className="aie-head"
                  aria-expanded={isOpen}
                  onClick={() => setOpenId(isOpen ? null : rec.id)}
                >
                  <span className={`aie-dot ${statusClass(rec)}`} aria-hidden="true" />
                  <span className="aie-time">{fmtClock(rec.at)}</span>
                  <span className={`aie-kind aie-kind-${rec.kind}`}>{KIND_LABEL[rec.kind]}</span>
                  <span className="aie-path" title={rec.path}>
                    {rec.path}
                  </span>
                  <span className="aie-net-sub">
                    <span className={`aie-status ${statusClass(rec)}`}>
                      {rec.live && rec.status === 0 ? '···' : rec.status || 'ERR'}
                    </span>
                    <span className="aie-meta">
                      {rec.live ? '进行中' : fmtDur(rec.durMs)}
                      {rec.resBytes > 0 && (
                        <>
                          <span className="aie-sep"> · </span>
                          {fmtBytes(rec.resBytes)}
                        </>
                      )}
                    </span>
                  </span>
                </button>

                {isOpen && (
                  <div className="aie-body">
                    <div className="aie-net-meta">
                      {rec.method} {rec.path}
                      {rec.stream && <span className="aie-pill">SSE</span>}
                      {rec.truncated && <span className="aie-pill aie-pill-warn">已截断</span>}
                    </div>

                    {rec.error && <div className="aie-err">{rec.error}</div>}

                    <div className="aie-net-actions">
                      <button
                        type="button"
                        className="aie-btn aie-btn-sm"
                        disabled={!rec.curl}
                        onClick={() => void doCopy(curlKey, rec.curl || '')}
                      >
                        {copied === curlKey ? '已复制' : copied === `${curlKey}:fail` ? '复制失败' : '复制 curl'}
                      </button>
                      {rec.upstream && (
                        <button
                          type="button"
                          className="aie-btn aie-btn-sm"
                          onClick={() => void doCopy(upKey, rec.upstream!.curl)}
                        >
                          {copied === upKey ? '已复制' : copied === `${upKey}:fail` ? '复制失败' : '复制上游 curl'}
                        </button>
                      )}
                    </div>

                    {rec.sse && (
                      <div className="aie-sse">
                        <div className="aie-sse-row">
                          <span className="aie-kv">
                            <b>{rec.sse.frames}</b> 帧
                          </span>
                          {rec.sse.finishReason && (
                            <span className="aie-kv">
                              finish <b>{rec.sse.finishReason}</b>
                            </span>
                          )}
                          {rec.sse.textLen > 0 && (
                            <span className="aie-kv">
                              <b>{rec.sse.textLen}</b> 字
                            </span>
                          )}
                        </div>
                        {rec.sse.usage !== undefined && (
                          <pre className="aie-code aie-code-tight">{pretty(JSON.stringify(rec.sse.usage))}</pre>
                        )}
                        {rec.sse.toolCalls.length > 0 && (
                          <div className="aie-sse-tools">
                            {rec.sse.toolCalls.map((t, i) => (
                              <div key={i} className="aie-sse-tool">
                                <span className="aie-tool-name">{t.name || '(未命名)'}</span>
                                <pre className="aie-code aie-code-tight">{pretty(t.args)}</pre>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {rec.reqBody && (
                      <details className="aie-fold" open={rec.kind === 'model'}>
                        <summary>
                          请求体 <span className="aie-dim">{fmtBytes(rec.reqBytes)}</span>
                        </summary>
                        <pre className="aie-code">{pretty(rec.reqBody)}</pre>
                      </details>
                    )}

                    {(rec.resBody || rec.sse) && (
                      <details className="aie-fold">
                        <summary>
                          响应原文 <span className="aie-dim">{fmtBytes(rec.resBytes)}</span>
                        </summary>
                        {rec.sse ? (
                          <>
                            <div className="aie-out-label">开头</div>
                            <pre className="aie-code aie-code-tight">{rec.sse.first.join('\n')}</pre>
                            <div className="aie-out-label">结尾</div>
                            <pre className="aie-code aie-code-tight">{rec.sse.last.join('\n')}</pre>
                          </>
                        ) : (
                          <pre className="aie-code">{pretty(rec.resBody)}</pre>
                        )}
                      </details>
                    )}

                    <details className="aie-fold">
                      <summary>
                        请求头 <span className="aie-dim">{rec.reqHeaders.length}</span>
                      </summary>
                      <pre className="aie-code aie-code-tight">
                        {rec.reqHeaders.map(([k, v]) => `${k}: ${v}`).join('\n')}
                      </pre>
                    </details>

                    {rec.upstream && (
                      <div className="aie-up">
                        上游地址 <code>{rec.upstream.url}</code>
                        <div className="aie-dim">上游 key 只在服务端，curl 里用 $API_KEY 占位</div>
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
