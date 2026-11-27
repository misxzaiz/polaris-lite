/**
 * session-hud 插件：会话悬浮摘要卡（纯插件，零核心改动）。
 *
 * 职责：在屏幕角落常驻一张可收起的小卡片，实时显示——
 * - 当前会话标题（旁听 chat-lite 的 'session.title:changed'）；
 * - 本轮对话中 AI 改动过的文件清单（旁听 'cap.ai.chat.runner:event' 的
 *   tool.card / tool.result，按路径去重、最近 24 条）；
 * - 忙碌指示（正在执行的工具数 >0 时高亮）。
 *
 * 挂载方式抄 notification-center 范式：React root 直挂 body，内容 portal 到
 * 宿主 #plite-overlay-root（插件 CSS 禁 fixed 的门禁不受影响，锚定由宿主持有）。
 *
 * 后续扩展位（TODO / 产物列表）：store.ts 的 noteToolCard 已按工具名分流，
 * 新增摘要类别只需扩 HudState + 对应 note* 函数，不动事件订阅层。
 */
import { useEffect as useReactEffect, useReducer as useReactReducer, useState as useReactState } from 'react';
import { createPortal } from 'react-dom';
import type { LitePlugin, SlotHostApi, TopbarChromeProps } from '@sdk';
import { getState, subscribe, displayTitle, noteToolCard, noteToolResult, noteToolStart, setTitle, type HudState } from './store';
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
function FileIco(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M13.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5L13.5 3z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M13.5 3v5.5H19" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}
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
function SpinIco(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 3a9 9 0 1 0 9 9" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}
function ChevronIco({ open }: { open: boolean }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }}>
      <path d="m6 14 6-6 6 6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
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


// ── HUD 卡片本体 ────────────────────────────────────────────────────

function HudCard(): JSX.Element {
  const st: HudState = useSub(getState);
  const [open, setOpen] = useReactState(true);
  const files = st.files;
  const title = displayTitle(st);
  const busy = st.running > 0;

  return (
    <div className="hud-card" data-open={open ? 'true' : 'false'} data-busy={busy ? 'true' : 'false'} role="complementary" aria-label="会话摘要">
      <button type="button" className="hud-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        {busy ? (
          <span className="hud-spin"><SpinIco /></span>
        ) : (
          <span className="hud-dot" data-count={files.length > 0 ? 'true' : 'false'} />
        )}
        <span className="hud-title" title={title}>{title}</span>
        <span className="hud-count">{files.length > 0 ? files.length : ''}</span>
        <span className="hud-chev"><ChevronIco open={open} /></span>
      </button>
      {open && (
        <div className="hud-body">
          {files.length === 0 ? (
            <div className="hud-empty">本轮暂无文件改动</div>
          ) : (
            <ul className="hud-files">
              {files.map((f) => (
                <li key={f.path} className="hud-file" data-op={f.op}>
                  <span className="hud-file-ico"><FileIco /></span>
                  <span className="hud-file-path" title={f.path}>{f.path}</span>
                  <span className="hud-file-op">{f.op}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ── 常驻宿主（portal 到 overlay root，直挂 body 的 React root 渲染）──

function HudHost(): JSX.Element | null {
  const [root, setRoot] = useReactState<HTMLElement | null>(null);
  useReactEffect(() => {
    const find = (): void => setRoot(document.getElementById('plite-overlay-root'));
    find();
    // overlay root 在壳层首帧后才存在；插件 setup 早于渲染，轮询到为止
    const iv = window.setInterval(() => {
      find();
      if (document.getElementById('plite-overlay-root')) window.clearInterval(iv);
    }, 300);
    return () => window.clearInterval(iv);
  }, []);
  if (!root) return null;
  return createPortal(
    <div className="hud-region" role="region" aria-label="会话悬浮摘要">
      <HudCard />
    </div>,
    root,
  );
}

// ── 事件旁听 → store ────────────────────────────────────────────────

function pickStr(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  return typeof v === 'string' ? v : undefined;
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'object' && raw !== null) return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const j = JSON.parse(raw);
      return typeof j === 'object' && j !== null ? (j as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
}

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

  // 流式工具事件（与 ai-events 同款旁听：envelope 顶层或 payload 里的 kind）
  api.listen('cap.ai.chat.runner:event', (raw) => {
    const ev = (raw ?? {}) as { payload?: Record<string, unknown>; kind?: string };
    const inner = (ev.payload ?? {}) as Record<string, unknown>;
    const kind = pickStr({ kind: ev.kind ?? inner.kind }, 'kind');
    if (!kind) return;
    const name = pickStr(inner, 'name') ?? 'tool';
    if (kind === 'tool.card') {
      noteToolCard(name, parseArgs(inner.args ?? inner.argsJson));
      noteToolStart();
    } else if (kind === 'tool.result') {
      noteToolResult();
    }
  });
}

// ── 插件声明 ─────────────────────────────────────────────────────────

export const sessionHudPlugin: LitePlugin = {
  manifest: {
    id: 'session-hud',
    name: '会话悬浮摘要',
    version: '0.1.0',
    capabilities: [],
    provides: [],
    events: ['session.title:changed', 'cap.ai.chat.runner:event'],
    contributes: {
      containers: [{ container: 'topbar', component: 'TopbarChrome', order: 1 }],
    },
  },
  setup(api: SlotHostApi) {
    watchEvents(api);
    mountHudHost();
  },
};

let hostMounted = false;
function mountHudHost(): void {
  if (hostMounted || typeof document === 'undefined') return;
  hostMounted = true;
  const el = document.createElement('div');
  el.id = 'session-hud-host';
  document.body.appendChild(el);
  // React 18 createRoot（与宿主同一 react-dom 实例；import map 经 esm-shim re-export）
  void import('react-dom/client')
    .then((m) => {
      const mod = m as unknown as { createRoot?: (c: Element) => { render(n: unknown): void }; default?: { createRoot?: (c: Element) => { render(n: unknown): void } } };
      const createRoot = mod.createRoot ?? mod.default?.createRoot;
      if (!createRoot) throw new Error('react-dom/client createRoot unavailable via esm-shim');
      createRoot(el).render(<HudHost />);
    })
    .catch((err) => {
      console.warn('[session-hud] host mount failed:', err);
    });
}

export { TopbarChrome };
export default sessionHudPlugin;
