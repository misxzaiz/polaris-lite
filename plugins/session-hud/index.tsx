/**
 * session-hud 插件：移动端顶栏会话标题（topbar 容器贡献，纯插件）。
 *
 * 职责：接管宿主 topbar 容器，标题行显示当前会话名
 * （旁听 chat-lite 的 'session.title:changed'；未命名时取首条消息前 18 字）。
 *
 * 悬浮摘要卡（HUD）曾在此实现，因长标题越界与遮挡侧边抽屉已移除；
 * TODO / 改动文件等摘要类需求后续另起方案（如顶栏副行或独立面板）。
 */
import { useEffect as useReactEffect, useReducer as useReactReducer } from 'react';
import type { LitePlugin, SlotHostApi, TopbarChromeProps } from '@sdk';
import { getState, subscribe, displayTitle, setTitle, type HudState } from './store';
import './hud.css';

// ── React hooks 薄封装（与 notification-center 同款，规避 hooks 规则的构建期噪音）──
function useForce(): [number, () => void] {
  const [n, inc] = useReactReducer((x: number) => x + 1, 0);
  return [n, inc as () => void];
}
function useSub<T>(get: () => T): T {
  const [, force] = useForce();
  useReactEffect(() => subscribe(force), [force]);
  return get();
}

// ── 图标（统一 SVG 细线，禁 emoji 门禁）──
function MenuIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 7h16M4 12h11M4 17h16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
function PanelIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 4v16M12 4v16M19 4v16M3 8h4M10 15h4M17 10h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

// ── 移动端顶栏 chrome（topbar 容器贡献：标题行显示当前会话名）──

function TopbarChrome({ drawer, onToggleSidebar, onTogglePanel, t }: TopbarChromeProps): JSX.Element {
  const st: HudState = useSub(getState);
  const title = displayTitle(st);
  return (
    <>
      <button
        className={`hud-topbar-btn ${drawer === 'sidebar' ? 'active' : ''}`}
        aria-label={t('shell.sessionList')}
        aria-expanded={drawer === 'sidebar'}
        onClick={onToggleSidebar}
      >
        <MenuIcon />
      </button>
      <span className="hud-topbar-title" title={title}>{title}</span>
      <button
        className={`hud-topbar-btn ${drawer === 'panel' ? 'active' : ''}`}
        aria-label={t('shell.capabilityPanel')}
        aria-expanded={drawer === 'panel'}
        onClick={onTogglePanel}
      >
        <PanelIcon />
      </button>
    </>
  );
}

// ── 事件旁听 → store ────────────────────────────────────────────────

function watchEvents(api: SlotHostApi): void {
  // 会话标题（chat-lite 广播；envelope 形态 { source, payload }）
  api.listen('session.title:changed', (raw) => {
    const ev = (raw ?? {}) as { payload?: Record<string, unknown> };
    const p = (ev.payload ?? raw) as { sessionId?: unknown; title?: unknown; firstMessage?: unknown };
    setTitle(
      typeof p.sessionId === 'string' ? p.sessionId : null,
      typeof p.title === 'string' ? p.title : null,
      typeof p.firstMessage === 'string' ? p.firstMessage : null,
    );
  });
}

// ── 插件声明 ─────────────────────────────────────────────────────────

export const sessionHudPlugin: LitePlugin = {
  manifest: {
    id: 'session-hud',
    name: '顶栏会话标题',
    version: '0.2.0',
    capabilities: [],
    provides: [],
    events: ['session.title:changed'],
    contributes: {
      containers: [{ container: 'topbar', component: 'TopbarChrome', order: 1 }],
    },
  },
  setup(api: SlotHostApi) {
    watchEvents(api);
  },
};

export { TopbarChrome };
export default sessionHudPlugin;
