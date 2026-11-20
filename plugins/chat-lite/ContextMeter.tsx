/**
 * ContextMeter：上下文进度圆圈 + 详情抽屉（spec §5.3 v2，2026-11-20 按用户反馈改造）。
 *
 * v1 的全宽状态条占掉输入区一整行（用户反馈「占用空间过多」）；v2 收敛为一个
 * 24px 进度圆圈（SVG 环 + 内部百分比），嵌入输入区按钮行（放在下面），点击后
 * 详情抽屉在**上方**展开。
 *
 * 抽屉必须 portal 到 body：宿主 .shell-input 有 overflow:hidden + 42dvh 上限，
 * 内联抽屉会被裁掉（与工作目录浮层同一条教训）。用 absolute 而非 fixed——
 * 插件 CSS 门禁禁止 fixed；宿主满屏布局下 body 定位等价贴底。
 *
 * 数据全部来自 ctxStore（事件驱动，UI 只读）；窗口分母优先真实 usage 携带的
 * contextWindow（供应商「输入 tokens」字段），agent-loop 首轮还会主动
 * resolveActive 预解析——改 1m 即全局生效，不再停在默认 200k。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useCtxStore, type CtxState, type CtxPolicy } from './ctxStore';
import { useSessionStore } from './store';

function fmtTokens(n: number | undefined): string {
  if (n === undefined || n === null) return '—';
  if (n >= 1_000_000) return `${(Math.round(n / 100_000) / 10).toString().replace(/\.0$/, '')}M`;
  if (n >= 1_000) {
    const v = Math.round(n / 100) / 10;
    return `${v.toString().replace(/\.0$/, '')}k`;
  }
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
        <MeterRow label="窗口来源" value={ctx.window ? '供应商输入 tokens' : '默认 200k（未配置）'} />
        <MeterRow label="消息数（含工具）" value={ctx.messages !== undefined ? String(ctx.messages) : '—'} />
        <MeterRow label="最近输出速率" value={ctx.lastUsage ? `${ctx.lastUsage.tps.toFixed(1)} tok/s` : '—'} />
        {ctx.lastUsage?.model && <MeterRow label="响应模型" value={ctx.lastUsage.model} />}
        {ctx.lastUsage?.estimated && <MeterRow label="口径" value="估算（供应商未回 usage）" />}
        {ctx.cacheTotal && ctx.cacheTotal.rounds > 0 && (() => {
          const { cached, creation, inputWithCache } = ctx.cacheTotal;
          // 累计命中占比 = 缓存读取 /（未命中输入 + 缓存读取），对齐 main 仓 usage_db 成本口径 B
          const denom = inputWithCache + cached;
          const pct = denom > 0 ? cached / denom : 0;
          // 单轮命中率 = 最近一轮 cached / prompt_tokens（业界口径；前缀增长趋近 100%）
          const lastPct = ctx.lastCacheHitRate;
          return (
            <>
              {lastPct !== undefined && (
                <MeterRow label="缓存命中率（最近轮）" value={`${Math.round(lastPct * 100)}%`} />
              )}
              <MeterRow label="缓存命中" value={`${fmtTokens(cached)} tokens（${Math.round(pct * 100)}%）`} />
              {creation > 0 && <MeterRow label="缓存写入" value={`${fmtTokens(creation)} tokens`} />}
              <div className="ctx-cache-bar" aria-hidden="true">
                <span className="ctx-cache-fill" style={{ width: `${Math.min(100, (lastPct ?? pct) * 100)}%` }} />
              </div>
              <div className="ctx-detail-note">
                {lastPct !== undefined && <>单轮命中率 = 命中 / 本轮 prompt tokens；前缀随对话增长，命中率应趋近 100%（短对话因最新问题不命中而偏低）。</>}
                {' '}累计：最近 {ctx.cacheTotal.rounds} 轮有缓存数据的请求，{fmtTokens(cached)} / {fmtTokens(denom)} 输入 tokens 命中缓存（更低价计费）。
              </div>
            </>
          );
        })()}
        {ctx.exhausted && <MeterRow label="自动压缩" value="已熔断（压缩无效，本会话不再自动压缩）" />}
      </div>

      {history.length > 0 && (
        <div className="ctx-detail-section">
          <div className="ctx-detail-heading">最近轮次</div>
          <table className="ctx-usage-table">
            <thead>
              <tr><th>输入</th><th>缓存</th><th>输出</th><th>速率</th></tr>
            </thead>
            <tbody>
              {history.map((h, i) => (
                <tr key={`${h.at}-${i}`}>
                  <td>{fmtTokens(h.inputTokens)}{h.estimated ? '*' : ''}</td>
                  <td>{h.cachedTokens ? fmtTokens(h.cachedTokens) : '—'}</td>
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

/** 环半径与周长（SVG viewBox 24：r=10，C=2πr≈62.8） */
const RING_R = 10;
const RING_C = 2 * Math.PI * RING_R;

function Orb({ ctx, policy, compacting, onOpen, orbRef }: {
  ctx: CtxState;
  policy: CtxPolicy;
  compacting: boolean;
  onOpen: () => void;
  /** ContextMeter 持有的 ref：打开抽屉时要用圆圈的实际位置做 portal 定位 */
  orbRef: RefObject<HTMLButtonElement>;
}) {
  const percent = ctx.percent ?? 0;
  const color = barColor(ctx.percent, policy.threshold);
  const shown = Math.min(100, Math.max(0, Math.round(percent * 100)));
  const tps = ctx.lastUsage?.tps;
  const title = [
    ctx.compacting
      ? '正在压缩上下文…'
      : `上下文 ${fmtPct(ctx.percent)} · ${fmtTokens(ctx.usedTokens)}/${fmtTokens(ctx.window)}`,
    ...(tps !== undefined && tps > 0 ? [`${tps.toFixed(1)} tok/s`] : []),
    ...(ctx.exhausted ? ['自动压缩已熔断'] : []),
    '点击查看详情',
  ].join('\n');
  return (
    <button
      ref={orbRef}
      type="button"
      className={`ctx-orb ${compacting ? 'compacting' : ''}`}
      onClick={onOpen}
      title={title}
      aria-label={`上下文 ${fmtPct(ctx.percent)}，点击查看详情`}
      data-testid="context-meter"
    >
      <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
        {/* 底环 */}
        <circle cx="12" cy="12" r={RING_R} fill="none" stroke="var(--bg-hover)" strokeWidth="2.5" />
        {/* 进度环：dashoffset 随 percent 收放 */}
        <circle
          cx="12" cy="12" r={RING_R} fill="none"
          stroke={color}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={RING_C}
          strokeDashoffset={RING_C * (1 - percent)}
          transform="rotate(-90 12 12)"
        />
        {/* 压缩中：外圈旋转点 */}
        {compacting && (
          <circle
            cx="12" cy="12" r={RING_R} fill="none"
            stroke="var(--plite-warning)" strokeWidth="1.5"
            strokeDasharray={`${RING_C * 0.18} ${RING_C * 0.82}`}
            strokeLinecap="round"
            className="ctx-orb-spin"
            transform="rotate(-90 12 12)"
          />
        )}
      </svg>
      <span className="ctx-orb-text" style={{ color }}>{shown}</span>
    </button>
  );
}

export function ContextMeter() {
  const activeId = useSessionStore((s) => s.activeId);
  const ctxMap = useCtxStore((s) => s.ctx);
  const policies = useCtxStore((s) => s.policies);
  const orbRef = useRef<HTMLButtonElement>(null);
  /** 抽屉定位（portal 到 body）：bottom 贴住圆圈上方，高度由内容决定 */
  const [drawerPos, setDrawerPos] = useState<{ left: number; bottom: number; width: number; maxHeight: number } | null>(null);

  const ctx = activeId ? ctxMap[activeId] : undefined;
  const policy = (activeId ? policies[activeId] : undefined) ?? { autoCompact: true, threshold: 0.75, keepRecent: 6 };
  const hasData = !!(ctx && (ctx.usedTokens !== undefined || ctx.lastUsage || ctx.compacting));

  // 注意 hooks 顺序：全部挂在早退 return 之前（Rules of Hooks——数据从无到有不能改变 hook 数量）
  const computePos = useCallback(() => {
    const el = orbRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const gap = 8;
    const width = Math.min(600, Math.max(320, window.innerWidth - 24));
    return {
      // 抽屉底边贴在圆圈顶上方 8px；左对齐圆圈但不越出视口
      left: Math.max(12, Math.min(r.left - 4, window.innerWidth - width - 12)),
      bottom: Math.max(gap, window.innerHeight - r.top + gap),
      width,
      maxHeight: Math.max(200, Math.min(460, r.top - gap * 2)),
    };
  }, []);

  const openDrawer = useCallback(() => setDrawerPos(computePos()), [computePos]);
  const closeDrawer = useCallback(() => setDrawerPos(null), []);

  // 抽屉开着时：视口变化/滚动重新定位，ESC 关闭
  useEffect(() => {
    if (!drawerPos) return;
    const update = () => {
      const next = computePos();
      if (next) setDrawerPos(next);
    };
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeDrawer();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [drawerPos, computePos, closeDrawer]);

  // 无任何数据（首轮流未结束）不渲染圆圈，避免噪音
  if (!activeId || !ctx || !hasData) return null;

  const compacting = ctx.compacting === true;

  return (
    <>
      <Orb ctx={ctx} policy={policy} compacting={compacting} onOpen={openDrawer} orbRef={orbRef} />
      {drawerPos && createPortal(
        <>
          {/* 透明点击幕：点抽屉外任意处关闭（absolute inset 0 在 body 下覆盖首屏） */}
          <div className="ctx-detail-mask" onClick={closeDrawer} aria-hidden="true" />
          <div
            className="ctx-detail-float"
            role="dialog"
            aria-label="上下文详情"
            style={{ left: drawerPos.left, bottom: drawerPos.bottom, width: drawerPos.width, maxHeight: drawerPos.maxHeight }}
          >
            <DetailDrawer sid={activeId} ctx={ctx} policy={policy} onClose={closeDrawer} />
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
