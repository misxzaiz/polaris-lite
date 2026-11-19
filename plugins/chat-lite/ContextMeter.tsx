/**
 * ContextMeter：上下文水位 + token 速率状态条（spec §5.3）。
 *
 * 位置：输入区上方（ChatInput 顶部）。一条细横条展示水位/速率，点击展开详情抽屉
 * （会话策略设置、最近用量、压缩记录）。数据全部来自 ctxStore（事件驱动，UI 只读）。
 */
import { useState } from 'react';
import { useCtxStore, type CtxState, type CtxPolicy } from './ctxStore';
import { useSessionStore } from './store';

function fmtTokens(n: number | undefined): string {
  if (n === undefined || n === null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(n));
}

function fmtPct(p: number | undefined): string {
  if (p === undefined) return '—';
  return `${Math.round(p * 100)}%`;
}

/** 水位颜色：>90% 危险，>阈值 警告，正常强调色 */
function barColor(percent: number | undefined, threshold: number): string {
  if (percent === undefined) return 'var(--border-strong)';
  if (percent >= 0.9) return 'var(--plite-danger)';
  if (percent >= threshold) return 'var(--plite-warning)';
  return 'var(--accent)';
}

function MeterRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="ctx-detail-row">
      <span className="ctx-detail-label">{label}</span>
      <span className="ctx-detail-value">{value}</span>
    </div>
  );
}

function DetailDrawer({ sid, ctx, policy, onClose }: {
  sid: string;
  ctx: CtxState;
  policy: CtxPolicy;
  onClose: () => void;
}) {
  const setPolicy = useCtxStore((s) => s.setPolicy);
  const history = [...ctx.history].reverse().slice(0, 8);
  return (
    <div className="ctx-detail" role="dialog" aria-label="上下文详情">
      <div className="ctx-detail-head">
        <span className="ctx-detail-title">上下文详情</span>
        <button type="button" className="ctx-detail-close" aria-label="关闭" onClick={onClose}>
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        </button>
      </div>

      <div className="ctx-detail-section">
        <MeterRow label="上下文窗口" value={`${fmtTokens(ctx.usedTokens)} / ${fmtTokens(ctx.window)}（${fmtPct(ctx.percent)}）`} />
        <MeterRow label="消息数（含工具）" value={ctx.messages !== undefined ? String(ctx.messages) : '—'} />
        <MeterRow label="最近输出速率" value={ctx.lastUsage ? `${ctx.lastUsage.tps.toFixed(1)} tok/s` : '—'} />
        {ctx.lastUsage?.model && <MeterRow label="响应模型" value={ctx.lastUsage.model} />}
        {ctx.lastUsage?.estimated && <MeterRow label="口径" value="估算（供应商未回 usage）" />}
        {ctx.exhausted && <MeterRow label="自动压缩" value="已熔断（压缩无效，本会话不再自动压缩）" />}
      </div>

      {history.length > 0 && (
        <div className="ctx-detail-section">
          <div className="ctx-detail-heading">最近轮次</div>
          <table className="ctx-usage-table">
            <thead>
              <tr><th>输入</th><th>输出</th><th>速率</th></tr>
            </thead>
            <tbody>
              {history.map((h, i) => (
                <tr key={`${h.at}-${i}`}>
                  <td>{fmtTokens(h.inputTokens)}{h.estimated ? '*' : ''}</td>
                  <td>{fmtTokens(h.outputTokens)}</td>
                  <td>{h.outputTokens > 0 ? `${h.tps.toFixed(1)} tok/s` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {history.some((h) => h.estimated) && <div className="ctx-detail-note">* 为字符估算值</div>}
        </div>
      )}

      {ctx.compacts.length > 0 && (
        <div className="ctx-detail-section">
          <div className="ctx-detail-heading">压缩记录</div>
          {ctx.compacts.map((c, i) => (
            <details className="ctx-compact-record" key={`${c.at}-${i}`}>
              <summary>
                {new Date(c.at).toLocaleTimeString()} · 压缩 {c.removedMessages} 条消息（{fmtTokens(c.tokensBefore)} → {fmtTokens(c.tokensAfter)} tokens）
              </summary>
              <pre className="ctx-compact-summary">{c.summary}</pre>
            </details>
          ))}
        </div>
      )}

      {ctx.compactFailed && (
        <div className="ctx-detail-section ctx-compact-error">上次压缩失败：{ctx.compactFailed}（历史已完整保留）</div>
      )}

      <div className="ctx-detail-section">
        <div className="ctx-detail-heading">压缩策略</div>
        <label className="ctx-policy-row">
          <input
            type="checkbox"
            checked={policy.autoCompact}
            onChange={(e) => setPolicy(sid, { autoCompact: e.target.checked })}
          />
          <span>自动压缩（达到阈值时摘要替换历史）</span>
        </label>
        <label className="ctx-policy-row">
          <span>触发阈值</span>
          <input
            type="range" min={50} max={95} step={5}
            value={Math.round(policy.threshold * 100)}
            disabled={!policy.autoCompact}
            onChange={(e) => setPolicy(sid, { threshold: Number(e.target.value) / 100 })}
          />
          <span className="ctx-policy-val">{Math.round(policy.threshold * 100)}%</span>
        </label>
        <label className="ctx-policy-row">
          <span>保留最近消息</span>
          <input
            type="range" min={2} max={20} step={1}
            value={policy.keepRecent}
            disabled={!policy.autoCompact}
            onChange={(e) => setPolicy(sid, { keepRecent: Number(e.target.value) })}
          />
          <span className="ctx-policy-val">{policy.keepRecent} 条</span>
        </label>
      </div>
    </div>
  );
}

export function ContextMeter() {
  const activeId = useSessionStore((s) => s.activeId);
  const ctxMap = useCtxStore((s) => s.ctx);
  const policies = useCtxStore((s) => s.policies);
  const [open, setOpen] = useState(false);

  if (!activeId) return null;
  const ctx = ctxMap[activeId];
  const policy = policies[activeId] ?? { autoCompact: true, threshold: 0.75, keepRecent: 6 };
  // 无任何数据（首轮流未结束）不渲染，避免空条噪音
  if (!ctx || (ctx.usedTokens === undefined && !ctx.lastUsage && !ctx.compacting)) return null;

  const percent = ctx.percent;
  const color = barColor(percent, policy.threshold);
  const tps = ctx.lastUsage?.tps;

  return (
    <div className="ctx-meter" data-testid="context-meter">
      <button
        type="button"
        className="ctx-meter-bar"
        aria-expanded={open}
        aria-label="上下文详情"
        onClick={() => setOpen((v) => !v)}
      >
        {ctx.compacting ? (
          <span className="ctx-meter-status compacting">正在压缩上下文…</span>
        ) : (
          <>
            <span className="ctx-meter-label">上下文</span>
            <span className="ctx-meter-track" aria-hidden="true">
              <span className="ctx-meter-fill" style={{ width: `${Math.min(100, (percent ?? 0) * 100)}%`, background: color }} />
            </span>
            <span className="ctx-meter-value" style={{ color }}>
              {fmtPct(percent)} · {fmtTokens(ctx.usedTokens)}/{fmtTokens(ctx.window)}
            </span>
            {ctx.exhausted && <span className="ctx-meter-flag danger">压缩熔断</span>}
            {!ctx.exhausted && ctx.compacted && <span className="ctx-meter-flag">已压缩</span>}
            {tps !== undefined && tps > 0 && <span className="ctx-meter-rate">{tps.toFixed(1)} tok/s</span>}
          </>
        )}
      </button>
      {open && <DetailDrawer sid={activeId} ctx={ctx} policy={policy} onClose={() => setOpen(false)} />}
    </div>
  );
}
