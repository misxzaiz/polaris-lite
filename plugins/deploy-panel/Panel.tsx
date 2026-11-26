/**
 * deploy-panel 面板：把「更新 9826 分析实例」变成一次点击。
 *
 * 只做展示与投递，不做任何构建逻辑——进度、结果、通知全部来自
 * /api/deploy/status，发布动作由服务端 detached worker 执行。
 * 所以关掉页面 / 断开对话都不影响发布。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

interface DeployJob {
  id: string;
  status: string;
  phase: string | null;
  startedAt: string | null;
  endedAt: string | null;
  targetSha: string | null;
  error: string | null;
  logTail: string;
}

interface DeployLastRun {
  id: string;
  ok: boolean;
  sha: string | null;
  startedAt: string | null;
  endedAt: string | null;
  error: string | null;
  notified: boolean;
}

interface DeployStatus {
  enabled: boolean;
  instance: { port: string | null; dataDir: string };
  current: { sha: string | null; subject: string | null; time: string | null };
  target: { sha: string | null; subject: string | null };
  behind: number | null;
  dirty: { count: number; sample: string[] } | null;
  job: DeployJob | null;
  lastRun: DeployLastRun | null;
  notice: unknown;
}

const short = (sha?: string | null): string => (sha ? sha.slice(0, 7) : '—');

function fmt(iso?: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
}

function duration(start?: string | null, end?: string | null): string {
  if (!start) return '';
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  const sec = Math.max(0, Math.round((e - s) / 1000));
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}s`;
}

export function DeployPanel(): JSX.Element {
  const [st, setSt] = useState<DeployStatus | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const confirmTimer = useRef<number | null>(null);
  // 404 = 本实例没有部署端点（9825 生产）。轮询到此为止：不要每 2.5s 打一发必然 404 的请求。
  const stopped = useRef(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch('/api/deploy/status', { cache: 'no-store' });
      if (res.status === 404) {
        stopped.current = true;
        setDisabled(true);
        return;
      }
      if (!res.ok) {
        setError(`读取状态失败（HTTP ${res.status}）`);
        return;
      }
      setDisabled(false);
      setError(null);
      setSt((await res.json()) as DeployStatus);
    } catch {
      // 9826 正在重启：静默，下一轮再说
    }
  }, []);

  useEffect(() => {
    void load();
    const iv = window.setInterval(() => {
      if (stopped.current) return;
      if (document.visibilityState === 'visible') void load();
    }, 2500);
    return () => window.clearInterval(iv);
  }, [load]);

  useEffect(() => () => {
    if (confirmTimer.current) window.clearTimeout(confirmTimer.current);
  }, []);

  const running = st?.job != null && (st.job.status === 'running' || st.job.status === 'queued');
  const upToDate = st?.behind === 0;
  // 上次失败时即使 behind===0 也允许重发：deploy-9826 失败前已经把 clone reset 到目标
  // commit，此时「已是最新」但实际没跑起来 —— 不给重试按钮就把用户卡死了。
  const failedLast = st?.lastRun != null && st.lastRun.ok === false;
  const canDeploy = !running && (upToDate !== true || failedLast);

  const arm = (): void => {
    setConfirming(true);
    if (confirmTimer.current) window.clearTimeout(confirmTimer.current);
    confirmTimer.current = window.setTimeout(() => setConfirming(false), 6000);
  };

  const deploy = async (): Promise<void> => {
    setSubmitting(true);
    setConfirming(false);
    try {
      const res = await fetch('/api/deploy/run', { method: 'POST' });
      if (res.status === 409) {
        setError('已有一个部署在进行，等它结束');
      } else if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? `投递失败（HTTP ${res.status}）`);
      } else {
        setError(null);
      }
      await load();
    } catch {
      setError('投递失败：网络异常');
    } finally {
      setSubmitting(false);
    }
  };

  if (disabled) {
    return (
      <div className="dp-panel">
        <h3>部署到 9826</h3>
        <div className="dp-note">本实例未启用部署面板（只有 9826 分析实例可用）。</div>
      </div>
    );
  }

  return (
    <div className="dp-panel">
      <h3>部署到 9826</h3>

      {!st ? (
        <div className="dp-note">{error ?? '读取状态中…'}</div>
      ) : (
        <>
          <div className="dp-row"><span className="dp-k">分析实例</span><span className="dp-v">{short(st.current.sha)}</span></div>
          <div className="dp-row"><span className="dp-k">目标版本</span><span className="dp-v">{short(st.target.sha)}{st.target.subject ? ` · ${st.target.subject}` : ''}</span></div>
          <div className="dp-row">
            <span className="dp-k">差距</span>
            <span className="dp-v">
              {st.behind == null ? '未知' : st.behind === 0 ? '已是最新' : `落后 ${st.behind} 个 commit`}
            </span>
          </div>

          {st.dirty && st.dirty.count > 0 && (
            <div className="dp-warn">
              仓库本体有 {st.dirty.count} 处未提交改动，<b>不会</b>被发布（发布的是 commit）。
            </div>
          )}

          <div className="dp-actions">
            {running ? (
              <button className="dp-btn" disabled>部署中…（{st.job?.phase ?? '进行中'}）</button>
            ) : confirming ? (
              <>
                <button className="dp-btn dp-btn-danger" onClick={() => void deploy()} disabled={submitting}>
                  确认部署 {short(st.target.sha)}
                </button>
                <button className="dp-btn dp-btn-ghost" onClick={() => setConfirming(false)} disabled={submitting}>取消</button>
              </>
            ) : (
              <button className="dp-btn" onClick={arm} disabled={submitting || !canDeploy}>
                {failedLast ? '重新部署' : upToDate ? '已是最新' : '一键部署'}
              </button>
            )}
          </div>

          {error && <div className="dp-error">{error}</div>}

          {st.job && (running || st.job.status === 'stale') && (
            <div className="dp-block">
              <div className="dp-block-head">
                <span>
                  {running ? '进行中' : '已中断'} · {st.job.phase ?? st.job.status}
                </span>
                <span className="dp-dim">{duration(st.job.startedAt, st.job.endedAt)}</span>
              </div>
              {st.job.error && <div className="dp-error">{st.job.error}</div>}
              {st.job.logTail && <pre className="dp-log">{st.job.logTail}</pre>}
            </div>
          )}

          {st.lastRun && !running && (
            <div className="dp-block">
              <div className="dp-block-head">
                <span className={st.lastRun.ok ? 'dp-ok' : 'dp-bad'}>
                  上次{st.lastRun.ok ? '成功' : '失败'} · {short(st.lastRun.sha)}
                </span>
                <span className="dp-dim">{fmt(st.lastRun.endedAt)}</span>
              </div>
              {st.lastRun.error && <div className="dp-error">{st.lastRun.error}</div>}
              <div className="dp-hint">
                发布成功会自动重启 9826；本页会自动重连，刷新后即跑在新版本上。
              </div>
            </div>
          )}

          <div className="dp-hint">
            发布目标固定为 origin/master；会 <b>reset --hard</b> 9826 的 clone（里面未提交的实验改动会被覆盖）。
          </div>
        </>
      )}
    </div>
  );
}

export default DeployPanel;
