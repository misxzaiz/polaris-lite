/**
 * app-updater 插件前端半边：「版本」统一面板（更新 + 部署合并）。
 *
 * 面板把版本链路画成一张图：
 *   origin/master ──(build+发版)——>  服务器版本 ──(reload)——>  本页运行
 *         └──(deploy:9826)——>  9826 分析实例 clone
 *
 * - app-updater 原「更新」职责（docs/app-updater-plan.md）：
 *   1. 手动检查入口 + 24h 惰性检查（visibilitychange 门控，无常驻 timer）；
 *   2. 流式保护：cap.ai.chat:event 的 delta 进行中挂起更新 toast，done 补弹；
 *   3. 更新提示：纯 DOM toast 挂宿主 overlay root（插件 CSS 禁 position:fixed）。
 * - deploy-panel 原「部署」职责（panel 半边并入此处，server 端点不动）：
 *   9826 一键部署（detached worker），面板只做展示与投递；/api/deploy/* 404
 *   （9825 生产 / dev 未开）时静默隐藏部署分支，面板退化为纯更新视图。
 *
 * 客户端当前版本来源：宿主 index.html 的 <meta name="plite-build-sha">（vite
 * 构建期由 injectBuildSha 注入；dev 下无注入 → meta 不存在 → 显示「开发环境」，
 * 比对逻辑跳过——dev 由 HMR 管新鲜度，不需要本插件）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CapabilityHandler, LitePlugin, SlotHostApi } from '@sdk';
import './panel.css';

const LAST_CHECK_KEY = 'app-updater.last-check.v1';
const AUTO_CHECK_KEY = 'app-updater.auto-check.v1';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

interface ServerVersion {
  sha: string | null;
  subject: string | null;
  time: string | null;
}

// ============================================================================
// deploy-panel 状态模型（/api/deploy/status 的契约，与 server.mjs 对齐）
// ============================================================================

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

/** 读当前运行的构建版本（index.html meta；dev 无注入返回 null） */
function clientSha(): string | null {
  if (typeof document === 'undefined') return null;
  const meta = document.querySelector('meta[name="plite-build-sha"]');
  const v = meta?.getAttribute('content')?.trim();
  return v || null;
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
}

function fmtAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

function duration(start?: string | null, end?: string | null): string {
  if (!start) return '';
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  const sec = Math.max(0, Math.round((e - s) / 1000));
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}s`;
}

/** 后台自动检查开关（面板里可关；关掉 = 不再弹更新 toast） */
function autoCheckEnabled(): boolean {
  if (typeof localStorage === 'undefined') return true;
  try {
    return localStorage.getItem(AUTO_CHECK_KEY) !== '0';
  } catch {
    return true;
  }
}

async function fetchServerVersion(): Promise<ServerVersion | null> {
  try {
    const res = await fetch('/api/app-updater/version', { cache: 'no-store' });
    if (!res.ok) return null; // 401/405/5xx → 静默降级，下次窗口再试
    const data = (await res.json()) as ServerVersion;
    return data;
  } catch {
    return null; // 网络断（服务器重启中）→ 静默，绝不降级成 reload 或报警
  }
}

// ============================================================================
// 更新提示 toast（纯 DOM，挂宿主 overlay root）
// ============================================================================

interface UpdateInfo {
  server: ServerVersion;
  from: string;
}

let toastEl: HTMLElement | null = null;

function showToastUpdate(info: UpdateInfo, onReload: () => void, onDismiss: () => void): void {
  if (typeof document === 'undefined') return;
  hideToast();
  const root = document.getElementById('plite-overlay-root') ?? document.body;
  toastEl = document.createElement('div');
  toastEl.className = 'au-toast';
  toastEl.setAttribute('data-testid', 'au-update-toast');

  const text = document.createElement('div');
  text.className = 'au-toast-text';
  const title = document.createElement('div');
  title.className = 'au-toast-title';
  const subject = info.server.subject ? `「${info.server.subject}」` : '';
  title.textContent = `新版本 ${shortSha(info.server.sha ?? '')} 可用 ${subject}`;
  const sub = document.createElement('div');
  sub.className = 'au-toast-sub';
  sub.textContent = `当前 ${shortSha(info.from)} · 更新会刷新页面（对话已保存）`;
  text.append(title, sub);

  const reload = document.createElement('button');
  reload.className = 'au-toast-btn';
  reload.textContent = '立即更新';
  reload.addEventListener('click', onReload);

  const later = document.createElement('button');
  later.className = 'au-toast-ghost';
  later.textContent = '稍后';
  later.addEventListener('click', onDismiss);

  toastEl.append(text, reload, later);
  root.appendChild(toastEl);
}

function hideToast(): void {
  toastEl?.remove();
  toastEl = null;
}

// ============================================================================
// panel 槽主面板：「版本」Tab（更新 + 部署 版本链路图）
// ============================================================================

interface PanelState {
  checking: boolean;
  server: ServerVersion | null;
  lastCheck: number | null;
  result: '' | 'latest' | 'update' | 'unavailable';
}

/** 链路节点：一行「● 名称 sha · 说明」 */
function ChainNode({ dot, name, sha, meta }: { dot: 'ok' | 'warn' | 'err'; name: string; sha: string; meta?: string }): JSX.Element {
  return (
    <div className="au-node">
      <span className={`au-dot au-dot-${dot}`} />
      <div className="au-node-info">
        <div className="au-node-head">
          <span className="au-node-name">{name}</span>
          <span className="au-mono au-node-sha">{sha}</span>
        </div>
        {meta && <div className="au-node-meta">{meta}</div>}
      </div>
    </div>
  );
}

export function VersionPanel(): JSX.Element {
  // ── 更新半边（原 AppUpdaterPanel 状态）──
  const [us, setUs] = useState<PanelState>({
    checking: false,
    server: null,
    lastCheck: (() => {
      const v = typeof localStorage !== 'undefined' ? localStorage.getItem(LAST_CHECK_KEY) : null;
      return v ? Number(v) : null;
    })(),
    result: '',
  });
  const [autoCheck, setAutoCheck] = useState<boolean>(() => autoCheckEnabled());
  const mine = clientSha();

  // ── 部署半边（原 DeployPanel 状态）──
  const [st, setSt] = useState<DeployStatus | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const confirmTimer = useRef<number | null>(null);
  // 404 = 本实例没有部署端点（9825 生产 / dev 未开）。轮询到此为止：
  // 不要每 2.5s 打一发必然 404 的请求。静默隐藏部署分支，不渲染死提示。
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

  const check = async (): Promise<void> => {
    setUs((s) => ({ ...s, checking: true }));
    const server = await fetchServerVersion();
    const now = Date.now();
    try { localStorage.setItem(LAST_CHECK_KEY, String(now)); } catch { /* 隐私模式 */ }
    setUs((s) => ({
      ...s,
      checking: false,
      server,
      lastCheck: now,
      result: !server || !server.sha ? 'unavailable' : !mine ? 'latest' : server.sha !== mine ? 'update' : 'latest',
    }));
  };

  const reload = (): void => { window.location.reload(); };

  const toggleAutoCheck = (): void => {
    const next = !autoCheck;
    setAutoCheck(next);
    try { localStorage.setItem(AUTO_CHECK_KEY, next ? '1' : '0'); } catch { /* 隐私模式 */ }
  };

  // ── 部署动作（原 DeployPanel 逻辑原样保留）──
  const running = st?.job != null && (st.job.status === 'running' || st.job.status === 'queued');
  const upToDate = st?.behind === 0;
  // 上次失败时即使 behind===0 也允许重发：deploy-9826 失败前已经把 clone reset 到目标
  // commit，此时「已是最新」但实际没跑起来 —— 不给重试按钮就把用户卡死了。
  const failedLast = st?.lastRun != null && st.lastRun.ok === false;
  const canDeploy = !running && (upToDate !== true || failedLast);
  const deployBehind = st != null && st.behind != null && st.behind > 0;
  const pageBehind = us.result === 'update';

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

  // ── 链路顶端：master 的展示 ──
  // 9826（deploy 端点可用）上直接给 origin/master 的 target；其他实例退化为
  // 服务器版本（app-updater 版本戳），语义等价：都是「应该运行在什么版本」。
  const masterSha = st?.target.sha ?? us.server?.sha ?? null;
  const masterMeta = st?.target.subject ?? us.server?.subject ?? (us.server?.time ? fmtTime(us.server.time) : null);

  // ── 主按钮状态机（链路驱动）──
  let mainBtn: { text: string; cls: string; disabled: boolean; onClick?: () => void };
  if (running) {
    mainBtn = { text: `部署中…（${st?.job?.phase ?? '进行中'}）`, cls: '', disabled: true };
  } else if (failedLast) {
    mainBtn = { text: '重新部署', cls: 'dp-btn-danger', disabled: !canDeploy, onClick: arm };
  } else if (deployBehind) {
    mainBtn = { text: '一键部署到 9826', cls: '', disabled: !canDeploy, onClick: arm };
  } else if (pageBehind) {
    mainBtn = { text: '立即更新（刷新）', cls: '', disabled: false, onClick: reload };
  } else {
    mainBtn = { text: '全部最新（一致）', cls: '', disabled: true };
  }
  // 次按钮：页面壳也落后时给一个并列的刷新入口（主按钮优先管部署）
  const showRefreshBtn = !running && pageBehind && (deployBehind || failedLast);

  return (
    <div className="au-panel" data-testid="au-panel">
      <h3>版本状态</h3>

      <div className="au-chain">
        <ChainNode dot="ok" name="origin/master" sha={short(masterSha)} meta={masterMeta ?? undefined} />
        <div className="au-branch">
          <span className="au-branch-line" />
          <div className="au-branch-body">
            <div className={`au-gap ${pageBehind ? '' : 'au-gap-ok'}`}>
              {us.result === 'unavailable' ? '版本信息不可用（dev 或未写版本戳）'
                : !mine ? '开发环境（HMR 管新鲜度）'
                : pageBehind ? '页面壳落后（刷新即得）' : '一致 · 本页运行最新'}
            </div>
            <ChainNode
              dot={pageBehind ? 'warn' : 'ok'}
              name="本页运行"
              sha={mine ? shortSha(mine) : 'dev'}
              meta={us.lastCheck != null ? `上次检查 · ${fmtAgo(us.lastCheck)}` : undefined}
            />
            {!disabled && (
              <>
                <div className={`au-gap ${deployBehind || failedLast ? '' : 'au-gap-ok'}`}>
                  {st?.behind == null ? '差距未知'
                    : failedLast ? '上次部署失败'
                    : deployBehind ? `落后 ${st.behind} 个 commit`
                    : '一致 · 9826 已是最新'}
                </div>
                <ChainNode
                  dot={failedLast ? 'err' : running || deployBehind ? 'warn' : 'ok'}
                  name="9826 分析实例"
                  sha={short(st?.current.sha)}
                  meta={st?.current.time ? fmtTime(st.current.time) : undefined}
                />
              </>
            )}
          </div>
        </div>
      </div>

      {st?.dirty != null && st.dirty.count > 0 && (
        <div className="dp-warn">
          仓库本体有 {st.dirty.count} 处未提交改动，<b>不会</b>被发布（发布的是 commit）。
          {st.dirty.sample.length > 0 && <div className="dp-dim">{st.dirty.sample.join(' · ')}</div>}
        </div>
      )}

      {/* ── 行动区 ── */}
      <div className="dp-actions">
        {confirming ? (
          <>
            <button className={`dp-btn ${failedLast ? 'dp-btn-danger' : ''}`} onClick={() => void deploy()} disabled={submitting}>
              确认部署 {short(st?.target.sha)}
            </button>
            <button className="dp-btn dp-btn-ghost" onClick={() => setConfirming(false)} disabled={submitting}>取消</button>
          </>
        ) : (
          <>
            {!disabled && (
              <button className={`dp-btn ${mainBtn.cls}`} onClick={mainBtn.onClick} disabled={mainBtn.disabled}>
                {mainBtn.text}
              </button>
            )}
            {showRefreshBtn && (
              <button className="dp-btn dp-btn-ghost" onClick={reload}>刷新页面</button>
            )}
          </>
        )}
      </div>

      {error && <div className="dp-error">{error}</div>}

      {/* ── 部署半边：进行中 / 上次运行 ── */}
      {st?.job != null && (running || st.job.status === 'stale') && (
        <div className="dp-block">
          <div className="dp-block-head">
            <span>{running ? '进行中' : '已中断'} · {st.job.phase ?? st.job.status}</span>
            <span className="dp-dim">{duration(st.job.startedAt, st.job.endedAt)}</span>
          </div>
          {st.job.error && <div className="dp-error">{st.job.error}</div>}
          {st.job.logTail && <pre className="dp-log">{st.job.logTail}</pre>}
        </div>
      )}

      {st?.lastRun != null && !running && (
        <div className="dp-block">
          <div className="dp-block-head">
            <span className={st.lastRun.ok ? 'dp-ok' : 'dp-bad'}>
              上次{st.lastRun.ok ? '成功' : '失败'} · {short(st.lastRun.sha)}
            </span>
            <span className="dp-dim">{fmtTime(st.lastRun.endedAt)}</span>
          </div>
          {st.lastRun.error && <div className="dp-error">{st.lastRun.error}</div>}
        </div>
      )}

      {/* ── 更新半边：手动检查 ── */}
      <button
        className="au-btn au-btn-check"
        disabled={us.checking}
        onClick={() => void check()}
        data-testid="au-check-btn"
      >
        {us.checking ? '检查中…' : '检查更新'}
      </button>
      <label className="au-toggle">
        <input type="checkbox" checked={autoCheck} onChange={toggleAutoCheck} />
        <span>后台自动检查（每 24h，弹更新提示）</span>
      </label>

      {!disabled && (
        <div className="au-hint">
          发布成功会自动重启 9826；本页会自动重连，刷新后即跑在新版本上。
          发布目标固定为 origin/master；会 <b>reset --hard</b> 9826 的 clone（里面未提交的实验改动会被覆盖）。
        </div>
      )}
      <div className="au-hint">
        安装到手机的 App 没有刷新入口：更新提示出现在对话空闲时（流式回复中不打扰）；也可以随时在这里手动检查。
      </div>
    </div>
  );
}

// ============================================================================
// 惰性检查 + 流式保护 + toast（setup 时挂载，与 panel 无状态耦合）
// ============================================================================

function startBackgroundWatcher(api: SlotHostApi): void {
  if (typeof window === 'undefined') return;
  if (!clientSha()) return; // dev 无构建版本 → 整个后台检查关闭（HMR 管新鲜度）

  let streaming = false; // 流式回复进行中（由事件驱动置位/复位）
  let pendingToast: UpdateInfo | null = null;
  let inFlight = false;

  const fireToast = (info: UpdateInfo): void => {
    showToastUpdate(
      info,
      () => window.location.reload(),
      () => hideToast(),
    );
  };

  const maybeToast = (info: UpdateInfo): void => {
    if (streaming) {
      pendingToast = info; // 流式保护：等 message.done 补弹
    } else {
      fireToast(info);
    }
  };

  const checkOnce = async (): Promise<void> => {
    if (inFlight) return;
    if (!autoCheckEnabled()) return; // 用户在面板里关掉了自动检查
    inFlight = true;
    try {
      const server = await fetchServerVersion();
      try { localStorage.setItem(LAST_CHECK_KEY, String(Date.now())); } catch { /* 隐私模式 */ }
      if (!server?.sha) return; // 版本信息不可用 → 静默
      const mine = clientSha();
      if (mine && server.sha !== mine) maybeToast({ server, from: mine });
    } finally {
      inFlight = false;
    }
  };

  // 24h 惰性门控：只在切回前台时判断，不设常驻 timer（App 挂后台 timer 会被节流失真）
  const onVisible = (): void => {
    if (document.visibilityState !== 'visible') return;
    const last = (() => {
      try { return Number(localStorage.getItem(LAST_CHECK_KEY) ?? '0'); } catch { return 0; }
    })();
    if (Date.now() - last < CHECK_INTERVAL_MS) return;
    void checkOnce();
  };
  document.addEventListener('visibilitychange', onVisible);

  // 流式状态监听：delta 置位，done/error 复位并补弹挂起的提示。
  // envelope: { source, kind, payload }（与 chat-lite 的处理约定一致；无 source 不认）
  api.listen('cap.ai.chat:event', (raw) => {
    const env = raw as { source?: string; kind?: string };
    if (!env?.source || !env?.kind) return;
    if (env.kind === 'message.delta') {
      streaming = true;
    } else if (env.kind === 'message.done' || env.kind === 'stream.error') {
      streaming = false;
      if (pendingToast) {
        const t = pendingToast;
        pendingToast = null;
        fireToast(t);
      }
    }
  });
}

function createUpdaterHandler(): CapabilityHandler {
  return () => ({ ok: true });
}

export const appUpdaterPlugin: LitePlugin = {
  manifest: {
    id: 'app-updater',
    name: '版本',
    version: '0.2.0',
    capabilities: [],
    provides: ['cap.app.updater'],
    events: ['cap.ai.chat:event'],
    contributes: {
      slots: [{ slot: 'panel', component: 'VersionPanel', order: 15, title: '版本' }],
    },
  },
  setup(api: SlotHostApi) {
    startBackgroundWatcher(api);
    api.registerCapability.register('cap.app.updater', createUpdaterHandler());
  },
};

export default appUpdaterPlugin;
