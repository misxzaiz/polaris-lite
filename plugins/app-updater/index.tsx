/**
 * app-updater 插件前端半边：App 版本检查与刷新引导。
 *
 * 职责（docs/app-updater-plan.md）：
 * 1. 手动检查入口：panel 槽「更新」Tab——当前版本、服务器版本、「检查更新」按钮；
 * 2. 24h 惰性检查：不设常驻 timer，visibilitychange（App 切回前台）时看
 *    「距上次检查是否超 24h」，超了才请求一次 /api/app-updater/version；
 * 3. 流式保护：监听 cap.ai.chat:event 的 message.delta/message.done，流式回复
 *    进行中挂起更新提示，流结束补弹——不自动 reload，不打断正在生成的内容；
 * 4. 更新提示：纯 DOM toast 挂宿主 overlay root（fixed 锚定视口，插件 CSS 禁
 *    position:fixed——这是构建门禁规则），用户点「立即更新」才 location.reload()。
 *
 * 客户端当前版本来源：宿主 index.html 的 <meta name="plite-build-sha">（vite
 * 构建期由 injectBuildSha 注入；dev 下无注入 → meta 不存在 → 显示「开发环境」，
 * 比对逻辑跳过——dev 由 HMR 管新鲜度，不需要本插件）。
 *
 * reload 后新版本如何生效：SW 对 navigate 是 network-first（先给新鲜壳），
 * assets 是 hash 文件名 + SWR——reload 即干净切换，本插件不碰任何缓存逻辑。
 */
import { useState } from 'react';
import type { CapabilityHandler, LitePlugin, SlotHostApi } from '@sdk';
import './panel.css';

const LAST_CHECK_KEY = 'app-updater.last-check.v1';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

interface ServerVersion {
  sha: string | null;
  subject: string | null;
  time: string | null;
}

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
// panel 槽主面板：「更新」Tab
// ============================================================================

interface PanelState {
  checking: boolean;
  server: ServerVersion | null;
  lastCheck: number | null;
  result: '' | 'latest' | 'update' | 'unavailable';
}

export function AppUpdaterPanel() {
  const [st, setSt] = useState<PanelState>({
    checking: false,
    server: null,
    lastCheck: (() => {
      const v = typeof localStorage !== 'undefined' ? localStorage.getItem(LAST_CHECK_KEY) : null;
      return v ? Number(v) : null;
    })(),
    result: '',
  });
  const mine = clientSha();

  const check = async (): Promise<void> => {
    setSt((s) => ({ ...s, checking: true }));
    const server = await fetchServerVersion();
    const now = Date.now();
    try { localStorage.setItem(LAST_CHECK_KEY, String(now)); } catch { /* 隐私模式 */ }
    setSt((s) => ({
      ...s,
      checking: false,
      server,
      lastCheck: now,
      result: !server || !server.sha ? 'unavailable' : !mine ? 'latest' : server.sha !== mine ? 'update' : 'latest',
    }));
  };

  const reload = (): void => { window.location.reload(); };

  return (
    <div className="au-panel" data-testid="au-panel">
      <h3>应用更新</h3>
      <div className="au-row">
        <span className="au-k">当前运行</span>
        <span className="au-v au-mono" data-testid="au-client-sha">
          {mine ? shortSha(mine) : '开发环境'}
        </span>
      </div>
      <div className="au-row">
        <span className="au-k">服务器版本</span>
        <span className="au-v au-mono" data-testid="au-server-sha">
          {st.server?.sha ? shortSha(st.server.sha) : st.result === 'unavailable' ? '不可用' : '—'}
        </span>
      </div>
      {st.server?.time && (
        <div className="au-row">
          <span className="au-k">发布时间</span>
          <span className="au-v">{fmtTime(st.server.time)}</span>
        </div>
      )}
      {st.server?.subject && (
        <div className="au-row">
          <span className="au-k">提交说明</span>
          <span className="au-v">{st.server.subject}</span>
        </div>
      )}
      {st.result === 'update' && st.server?.sha && (
        <div className="au-update-box" data-testid="au-update-box">
          <span>有新版本可用（{shortSha(mine ?? '')} → {shortSha(st.server.sha)}）</span>
          <button className="au-btn" onClick={reload}>立即更新</button>
        </div>
      )}
      {st.result === 'latest' && <div className="au-hint">已是最新版本。</div>}
      {st.result === 'unavailable' && (
        <div className="au-hint">服务器未提供版本信息（dev 环境或部署未写版本文件）。</div>
      )}
      <button
        className="au-btn au-btn-check"
        disabled={st.checking}
        onClick={() => void check()}
        data-testid="au-check-btn"
      >
        {st.checking ? '检查中…' : '检查更新'}
      </button>
      {st.lastCheck != null && <div className="au-hint">上次检查：{fmtAgo(st.lastCheck)}</div>}
      <div className="au-hint">安装到手机的 App 没有刷新入口：更新提示出现在对话空闲时（流式回复中不打扰）；也可以随时在这里手动检查。</div>
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
    name: '应用更新',
    version: '0.1.0',
    capabilities: [],
    provides: ['cap.app.updater'],
    events: ['cap.ai.chat:event'],
    contributes: {
      slots: [{ slot: 'panel', component: 'AppUpdaterPanel', order: 15, title: '更新' }],
    },
  },
  setup(api: SlotHostApi) {
    startBackgroundWatcher(api);
    api.registerCapability.register('cap.app.updater', createUpdaterHandler());
  },
};

export default appUpdaterPlugin;
