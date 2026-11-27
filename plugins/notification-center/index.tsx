/**
 * notification-center 插件：全局通知中心（纯插件形态）。
 *
 * 职责：
 * 1. cap.ui.notify 能力：任何声明了该 cap 的插件都可 dispatch 推送通知——
 *    payload: { title, body?, level?('info'|'success'|'warn'|'error'), ttl?, dedupeKey? }
 *    - 常驻 toast（portal 到宿主 #plite-overlay-root，禁 fixed 的构建门禁不受影响）；
 *    - 同时落 inbox（cap.kv 持久化），面板可回看；
 *    - error 级常驻需手动关闭，其余 TOAST_TTL_MS 自动消退；
 *    - AI 流式回复进行中挂起（不遮挡生成中内容），message.done/error 后补弹
 *      （对齐 app-updater 的流式保护模式）。
 * 2. panel 槽「通知」Tab：历史列表 / 全部已读 / 清空。
 * 3. 宿主启动告警（2026-11-27 用户禁令：禁止放壳层顶部）：监听核心派发的
 *    PLITE_BOOT_NOTICE DOM 事件（插件加载失败/权限收紧等），转成 toast + inbox。
 * 4. 面板直达深链：监听 @sdk CHANNEL_PANEL_INTENT 事件，收到 { slot, title } 意图时
 *    写 plite.slot.active.<slot>（SlotOutlet 的激活持久化键）——宿主零改动实现
 *    「会话设置点通知 → 右栏直接停在通知面板」。
 *
 * 为什么 toast 不用槽位：槽位系统只有 sidebar/stream/input/panel/auth，没有浮层槽；
 * 而插件 CSS 禁 fixed，所以复用宿主 #plite-overlay-root（app-updater 同款范式）。
 */
import { createPortal } from 'react-dom';
import type { CapabilityHandler, LitePlugin, SlotHostApi } from '@sdk';
import { CHANNEL_PANEL_INTENT, CHANNEL_DRAWER_STATE, CHANNEL_DRAWER_EVENT, CHANNEL_SESSION_ACTIVE, CHANNEL_SESSION_INTENT } from '@sdk';
import { NotificationPanel } from './Panel';
import {
  MAX_VISIBLE, TOAST_TTL_MS, loadInbox, loadPrefs, getPrefs, pushNotice, setNotifyApi,
  subscribe, type NotifyItem, type NotifyLevel,
} from './store';
import './panel.css';

// ── 通知 → toast 队列（展示态，内存即可） ─────────────────────────────

interface Toast extends NotifyItem {
  ttl: number; // 0 = 常驻（error / 询问等待）
  /** 关联会话：点击 toast 主体跳转过去（CHANNEL_SESSION_INTENT） */
  sessionId?: string;
}

let toasts: Toast[] = [];
let hiddenCount = 0;
const toastSubs = new Set<() => void>();

function notifyToasts(): void {
  toastSubs.forEach((fn) => fn());
}

function pushToast(t: Toast): void {
  if (toasts.some((x) => x.id === t.id)) return; // 同一通知不重复弹
  toasts = [t, ...toasts];
  if (toasts.length > MAX_VISIBLE) {
    hiddenCount += toasts.length - MAX_VISIBLE;
    toasts = toasts.slice(0, MAX_VISIBLE);
  }
  notifyToasts();
  if (t.ttl > 0) {
    window.setTimeout(() => dismissToast(t.id, false), t.ttl);
  }
}

function dismissToast(id: string, collapseReset = true): void {
  const idx = toasts.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const el = document.querySelector(`[data-toast-id="${id}"]`);
  if (el) {
    el.classList.add('leaving');
    window.setTimeout(() => {
      toasts = toasts.filter((t) => t.id !== id);
      if (collapseReset && toasts.length < MAX_VISIBLE && hiddenCount > 0) {
        const back = Math.min(hiddenCount, MAX_VISIBLE - toasts.length);
        hiddenCount -= back;
      }
      notifyToasts();
    }, 200);
    return;
  }
  toasts = toasts.filter((t) => t.id !== id);
  notifyToasts();
}

function clearToasts(): void {
  toasts = [];
  hiddenCount = 0;
  notifyToasts();
}

// ── ToastHost：常驻 React 组件（portal 到 overlay root） ─────────────

function CloseX(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function ToastHost(): JSX.Element | null {
  const [, force] = useForce();
  const [root, setRoot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const off = subscribe(force);
    const find = (): void => setRoot(document.getElementById('plite-overlay-root'));
    find();
    // overlay root 在壳层首帧后才存在；插件 setup 早于渲染，轮询到为止
    const iv = window.setInterval(() => {
      find();
      if (document.getElementById('plite-overlay-root')) window.clearInterval(iv);
    }, 300);
    return () => {
      off();
      window.clearInterval(iv);
    };
  }, [force]);
  if (!root) return null;
  return createPortal(
    <div className="nc-region" role="region" aria-label="通知">
      {toasts.map((t) => (
        <div key={t.id} className={`nc-toast ${t.sessionId ? 'jumpable' : ''}`} data-level={t.level} data-toast-id={t.id} role="alert"
          onClick={() => { if (t.sessionId) jumpToSession(t.sessionId); }}>
          <span className="ncp-ico">
            <PanelIco level={t.level} />
          </span>
          <span className="ncp-main">
            <span className="ncp-t">{t.title}</span>
            {t.body && <span className="ncp-d">{t.body}</span>}
          </span>
          <button type="button" className="nc-close" aria-label="关闭" onClick={(e) => { e.stopPropagation(); dismissToast(t.id); }}>
            <CloseX />
          </button>
          {t.ttl > 0 && <span className="nc-life" style={{ animationDuration: `${t.ttl}ms` }} />}
        </div>
      ))}
      {hiddenCount > 0 && (
        <button type="button" className="nc-more">+{hiddenCount} 条通知</button>
      )}
    </div>,
    root,
  );
}

// 小工具：forceUpdate（React 18 无类组件，这里用 useReducer 最轻）
import { useEffect as useReactEffect, useReducer as useReactReducer, useState as useReactState } from 'react';
function useForce(): [number, () => void] {
  const [n, inc] = useReactReducer((x: number) => x + 1, 0);
  return [n, inc as () => void];
}
function useState<T>(init: T | (() => T)): [T, (v: T | ((p: T) => T)) => void] {
  return useReactState(init);
}
function useEffect(fn: () => void | (() => void), deps: unknown[]): void {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useReactEffect(fn, deps as never);
}
function PanelIco({ level }: { level: NotifyLevel }): JSX.Element {
  const common = { viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true as const };
  if (level === 'success') {
    return <svg {...common}><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" /><path d="m8.5 12.2 2.4 2.4 4.6-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  }
  if (level === 'warn' || level === 'error') {
    return <svg {...common}><path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  }
  return <svg {...common}><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" /><path d="M12 11v5m0-8h.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>;
}

// ── cap.ui.notify handler ───────────────────────────────────────────

const LEVELS: NotifyLevel[] = ['info', 'success', 'warn', 'error'];

function createNotifyHandler(): CapabilityHandler {
  return async (req, ctx) => {
    const p = (req.payload ?? {}) as {
      title?: unknown; body?: unknown; level?: unknown; ttl?: unknown; dedupeKey?: unknown; source?: unknown;
    };
    const title = typeof p.title === 'string' ? p.title.trim() : '';
    if (!title) return { ok: false, error: 'notify 需要 title' };
    const level = (LEVELS.includes(p.level as NotifyLevel) ? p.level : 'info') as NotifyLevel;
    const body = typeof p.body === 'string' ? p.body : undefined;
    const id = typeof p.dedupeKey === 'string' && p.dedupeKey ? `k:${p.dedupeKey}` : `n:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const source = typeof p.source === 'string' ? p.source : ctx?.pluginId;
    const item: NotifyItem = { id, level, title, body, source, at: Date.now(), read: false };
    await pushNotice(item);
    const ttl = level === 'error' ? 0 : (typeof p.ttl === 'number' && p.ttl > 0 ? Math.min(p.ttl, 60_000) : TOAST_TTL_MS);
    enqueueToast({ ...item, ttl });
    return { ok: true, id };
  };
}

// ── 流式保护：AI 回复进行中挂起 toast，done/error 后补弹 ────────────────

let streaming = false;
const pendingQueue: Toast[] = [];

function enqueueToast(t: Toast): void {
  if (streaming) {
    if (!pendingQueue.some((x) => x.id === t.id)) pendingQueue.push(t);
    return;
  }
  pushToast(t);
}

/** 当前活跃会话（只读桥：chat-lite 写入 { sessionId, title }） */
function activeSessionInfo(): { sessionId: string | null; title: string | null } {
  const v = (window as unknown as Record<string, unknown>)[CHANNEL_SESSION_ACTIVE] as
    | { sessionId?: string | null; title?: string | null }
    | undefined;
  return {
    sessionId: typeof v?.sessionId === 'string' ? v.sessionId : null,
    title: typeof v?.title === 'string' ? v.title : null,
  };
}

/** 会话显示名：有标题用标题，否则用 sessionId 前 8 位 */
function sessionLabel(sessionId: string | undefined): string {
  if (!sessionId) return '未知会话';
  const info = activeSessionInfo();
  if (info.sessionId === sessionId && info.title) return info.title;
  return sessionId.slice(0, 8);
}

/** 是否有 runner 编排在跑（runner 事件出现即视为有；用于 message.done 兜底去重） */
let runnerActive = false;

/** 点击跳转：派发会话跳转意图（chat-lite 消费切到该会话），并撤掉询问等待 toast */
function jumpToSession(sessionId: string): void {
  window.dispatchEvent(new CustomEvent(CHANNEL_SESSION_INTENT, { detail: { sessionId } }));
  void markToastGone(`ia:${sessionId}`);
}

/** 已作答/超时后撤掉指定前缀的 toast（去 inbox 找同前缀条目映射到展示态） */
async function markToastGone(idPrefix: string): Promise<void> {
  const list = await loadInbox();
  const hit = list.find((n) => n.id.startsWith(idPrefix));
  if (hit) dismissToast(hit.id);
}

function watchSessionEvents(api: SlotHostApi): void {
  // envelope: { source, kind, payload }（与 chat-lite / app-updater 的处理约定一致）

  // ── runner 通道（工具编排模式）：整轮结束口径 = loop.done ──────────────
  // 此前监听 cap.ai.chat:event 的 message.done 会把「引擎层每轮回复结束」当完成——
  // 工具链中途每转一轮弹一次，通知早且没用。runner 模式下正确的终信号是 loop.done
  // （含 guardLimit：达到轮次上限被安全阀收尾，也算整轮结束）。
  api.listen('cap.ai.chat.runner:event', (raw) => {
    const env = raw as { source?: string; kind?: string; payload?: { sessionId?: string; turns?: number; interrupted?: boolean; message?: string; kind2?: string } };
    if (!env?.source || !env?.kind) return;
    runnerActive = true;
    const sid = typeof env.payload?.sessionId === 'string' ? env.payload.sessionId : null;

    // 询问等待通知：runner 模式的 interactive.required（带 callId/title）。
    // 非当前会话才提醒——正盯着的会话 AI 提问，卡片就在眼前，通知反而打扰。
    if (env.kind === 'interactive.required') {
      streaming = true; // 询问挂起期间同样挂起普通 toast，避免遮挡生成中内容
      void (async () => {
        await loadPrefs();
        if (!getPrefs().notifyOnInteractive) return;
        if (!sid || sid === activeSessionInfo().sessionId) return;
        const item: NotifyItem = {
          id: `ia:${sid}`,
          level: 'warn',
          title: '会话在等你作答',
          body: `「${sessionLabel(sid)}」：${String((env.payload as Record<string, unknown> | undefined)?.title ?? '') || 'AI 发起了交互'}，点击通知跳转作答`,
          at: Date.now(),
          read: false,
          source: 'notification-center',
        };
        await pushNotice(item);
        enqueueToast({ ...item, ttl: 0, sessionId: sid }); // 常驻：作答/超时前一直在
      })();
      return;
    }
    // 询问收敛（作答/超时/中断都会走）：撤掉该会话的询问等待 toast
    if (env.kind === 'interactive.resolved') {
      void markToastGone(`ia:${sid ?? ''}`);
      return;
    }
    if (env.kind === 'message.delta') {
      streaming = true;
      return;
    }
    if (env.kind !== 'loop.done' && env.kind !== 'stream.error') return;
    streaming = false;
    // 整轮完成通知（可开关）。普通完成只提醒非当前会话——正开着的会话结果就在
    // 屏幕上，再弹通知是噪音；失败/中断无论哪个会话都提醒（错过重试就是坑）。
    void (async () => {
      await loadPrefs();
      if (!getPrefs().notifyOnDone) return;
      const failed = env.kind === 'stream.error';
      const interrupted = env.payload?.interrupted === true;
      const isCurrent = sid === activeSessionInfo().sessionId;
      if (!failed && !interrupted && isCurrent) return;
      const level: NotifyLevel = failed ? 'error' : interrupted ? 'warn' : 'success';
      const title = failed ? '回复失败' : interrupted ? '回复已中断' : '任务完成';
      const body = failed
        ? (env.payload?.message ?? '生成出错，可重试')
        : `「${sessionLabel(sid ?? undefined)}」整轮结束（${env.payload?.turns ?? '?'} 轮）`;
      const id = `done:${sid ?? 'x'}:${Date.now()}`;
      const item: NotifyItem = { id, level, title, body, at: Date.now(), read: false, source: 'notification-center', sessionId: sid ?? undefined };
      await pushNotice(item);
      enqueueToast({ ...item, ttl: failed ? 0 : TOAST_TTL_MS, sessionId: sid ?? undefined });
    })();
    while (pendingQueue.length) {
      const t = pendingQueue.shift();
      if (t) pushToast(t);
    }
  });

  // ── 引擎直达通道（无工具编排的纯聊天）：message.done 仍作完成口径 ──────────
  // 但 runner 活动期间忽略——runner 模式的每轮 message.done 不是终信号（见上）。
  api.listen('cap.ai.chat:event', (raw) => {
    const env = raw as { source?: string; kind?: string; payload?: { sessionId?: string; interrupted?: boolean; message?: string } };
    if (!env?.source || !env?.kind) return;
    if (env.kind === 'message.delta') {
      streaming = true;
      return;
    }
    if (env.kind !== 'message.done' && env.kind !== 'stream.error') return;
    streaming = false;
    // runner 编排在跑：done 由 loop.done 通道负责，此处只做流式保护队列收敛
    if (runnerActive) {
      runnerActive = false;
      while (pendingQueue.length) {
        const t = pendingQueue.shift();
        if (t) pushToast(t);
      }
      return;
    }
    const sid = typeof env.payload?.sessionId === 'string' ? env.payload.sessionId : null;
    void (async () => {
      await loadPrefs();
      if (!getPrefs().notifyOnDone) return;
      const failed = env.kind === 'stream.error';
      const interrupted = env.payload?.interrupted === true;
      const isCurrent = sid === activeSessionInfo().sessionId;
      if (!failed && !interrupted && isCurrent) return;
      const level: NotifyLevel = failed ? 'error' : interrupted ? 'warn' : 'success';
      const title = failed ? '回复失败' : interrupted ? '回复已中断' : '回复完成';
      const body = failed
        ? (env.payload?.message ?? '生成出错，可重试')
        : `「${sessionLabel(sid ?? undefined)}」一轮回复结束`;
      const id = `done:${sid ?? 'x'}:${Date.now()}`;
      const item: NotifyItem = { id, level, title, body, at: Date.now(), read: false, source: 'notification-center', sessionId: sid ?? undefined };
      await pushNotice(item);
      enqueueToast({ ...item, ttl: failed ? 0 : TOAST_TTL_MS, sessionId: sid ?? undefined });
    })();
    while (pendingQueue.length) {
      const t = pendingQueue.shift();
      if (t) pushToast(t);
    }
  });

  // ── 客户端编排路径（interactive-cards 直发，无 runner）：询问等待通知 ──────
  api.listen('interactive.created', (raw) => {
    const env = raw as { payload?: Record<string, unknown> };
    const p = (env?.payload ?? {}) as { sessionId?: string; title?: string; kind?: string };
    const sid = typeof p.sessionId === 'string' ? p.sessionId : null;
    void (async () => {
      await loadPrefs();
      if (!getPrefs().notifyOnInteractive) return;
      if (!sid || sid === activeSessionInfo().sessionId) return;
      const item: NotifyItem = {
        id: `ia:${sid}`,
        level: 'warn',
        title: '会话在等你作答',
        body: `「${sessionLabel(sid)}」：${String(p.title ?? '') || 'AI 发起了交互'}，点击通知跳转作答`,
        at: Date.now(),
        read: false,
        source: 'notification-center',
      };
      await pushNotice(item);
      enqueueToast({ ...item, ttl: 0, sessionId: sid });
    })();
  });
  api.listen('interactive.answered', (raw) => {
    const env = raw as { payload?: { sessionId?: string } };
    const sid = typeof env?.payload?.sessionId === 'string' ? env.payload.sessionId : null;
    void markToastGone(`ia:${sid ?? ''}`);
  });
}

// ── 面板直达深链：panel intent → SlotOutlet 切换激活面板 ────────────────

/**
 * 面板直达：派发 @sdk CHANNEL_PANEL_INTENT 意图事件。
 * 消费方是宿主 SlotOutlet（按 title 匹配 tab 并切换激活），本插件不硬编码面板清单——
 * 面板增删/改名时零维护。抽屉开启经既有 CHANNEL_DRAWER_STATE/EVENT 通道。
 */
/** 供其他插件（chat-lite 会话设置等）复用的面板直达入口 */
export function requestPanel(title: string): void {
  const w = window as unknown as Record<string, unknown>;
  w[CHANNEL_DRAWER_STATE] = 'panel';
  window.dispatchEvent(new CustomEvent(CHANNEL_DRAWER_EVENT, { detail: 'panel' }));
  window.dispatchEvent(new CustomEvent(CHANNEL_PANEL_INTENT, { detail: { slot: 'panel', title } }));
}

// ── 插件装配 ────────────────────────────────────────────────────────

export const notificationCenterPlugin: LitePlugin = {
  manifest: {
    id: 'notification-center',
    name: '通知中心',
    version: '0.1.0',
    capabilities: ['cap.kv'],
    provides: ['cap.ui.notify'],
    events: ['cap.ai.chat:event', 'cap.ai.chat.runner:event', 'interactive.created', 'interactive.answered', 'notifications-changed'],
    contributes: {
      slots: [{ slot: 'panel', component: 'NotificationPanel', order: 34, title: '通知' }],
    },
  },
  setup(api: SlotHostApi) {
    setNotifyApi(api);
    void loadInbox();
    void loadPrefs();
    api.registerCapability.register('cap.ui.notify', createNotifyHandler());
    watchSessionEvents(api);
    listenBootNotices();
    // ToastHost 不经槽位：直接挂 body（面板卸载不影响 toast 常驻）
    mountToastHost();
  },
};

/**
 * 宿主启动告警接入（2026-11-27 用户禁令：禁止把启动提示放壳层顶部常驻条）。
 * 核心只在 window 上派发 PLITE_BOOT_NOTICE DOM 事件（事件名就地字面量对齐：
 * arch 门禁——核心不 import 插件，插件不 import 核心）——这里接收并转成
 * toast + inbox 通知；本插件被禁用时核心退化为 console.warn，不会静默。
 */
let bootNoticesBound = false;
function listenBootNotices(): void {
  if (bootNoticesBound || typeof window === 'undefined') return;
  bootNoticesBound = true;
  window.addEventListener('plite-boot-notice', (e) => {
    const detail = (e as CustomEvent<{ title?: unknown; lines?: unknown }>).detail;
    const title = typeof detail?.title === 'string' ? detail.title : '启动告警';
    const lines = Array.isArray(detail?.lines) ? detail.lines.filter((x): x is string => typeof x === 'string') : [];
    if (lines.length === 0) return;
    const body = lines.join('；');
    void notifyHostBoot({ title, body });
  });
}

/** 经本插件的 cap.ui.notify 通道发通知（与外部 dispatch 同一条路：toast + inbox） */
async function notifyHostBoot(item: { title: string; body: string }): Promise<void> {
  const handler = createNotifyHandler();
  await handler(
    { target: 'cap.ui.notify', action: 'push', payload: { ...item, level: 'warn', dedupeKey: `boot:${item.title}:${item.body}` } },
    { pluginId: 'notification-center', capabilities: ['cap.kv'] },
  );
}

let hostMounted = false;
function mountToastHost(): void {
  if (hostMounted || typeof document === 'undefined') return;
  hostMounted = true;
  const el = document.createElement('div');
  el.id = 'nc-toast-host';
  document.body.appendChild(el);
  // React 18 createRoot（与宿主同一 react-dom 实例）。注意：import map 把
  // 'react-dom/client' 也指到 esm-shim，shim 已 re-export createRoot；
  // 命名导出缺失时回退 default（vite 预打包 CJS 形态）。
  void import('react-dom/client').then((m) => {
    const mod = m as unknown as { createRoot?: (c: Element) => { render(n: unknown): void }; default?: { createRoot?: (c: Element) => { render(n: unknown): void } } };
    const createRoot = mod.createRoot ?? mod.default?.createRoot;
    if (!createRoot) throw new Error('react-dom/client createRoot unavailable via esm-shim');
    createRoot(el).render(<ToastHost />);
  }).catch((err) => {
    console.warn('[notification-center] toast host mount failed:', err);
  });
}

export { NotificationPanel, clearToasts, dismissToast };
export default notificationCenterPlugin;
