/**
 * SlotLayout：核心四槽布局壳 + auth 门禁。
 * 视觉仅持有壳层；业务控件与业务样式仍由各插件提供。
 */
import { useEffect, useState } from 'react';
import { SlotOutlet } from './SlotOutlet';
import { useAuthGate } from './useAuthGate';

export type LayoutDrawer = 'none' | 'sidebar' | 'panel';

const layoutListeners = new Set<(d: LayoutDrawer) => void>();
let currentDrawer: LayoutDrawer = 'none';

export function setDrawer(d: LayoutDrawer): void {
  currentDrawer = d;
  layoutListeners.forEach((fn) => fn(d));
}

export function useDrawer(): LayoutDrawer {
  const [d, setD] = useState<LayoutDrawer>(currentDrawer);
  useEffect(() => {
    layoutListeners.add(setD);
    return () => { layoutListeners.delete(setD); };
  }, []);
  return d;
}

function BrandMark({ className = 'brand-mark' }: { className?: string }) {
  return (
    <span className={className} aria-hidden="true">
      <svg viewBox="0 0 32 32" fill="none">
        <path d="M16 2.5 18.8 13.2 29.5 16 18.8 18.8 16 29.5 13.2 18.8 2.5 16 13.2 13.2 16 2.5Z" stroke="currentColor" strokeWidth="1.15" />
        <path d="M16 9.5 17.35 14.65 22.5 16 17.35 17.35 16 22.5 14.65 17.35 9.5 16 14.65 14.65 16 9.5Z" fill="currentColor" fillOpacity="0.22" />
      </svg>
    </span>
  );
}

function Brand() {
  return (
    <div className="shell-brand">
      <BrandMark />
      <span className="brand-copy">
        <span className="brand-name">Polaris</span>
        <span className="brand-edition">Lite · Private Intelligence</span>
      </span>
    </div>
  );
}

function MenuIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 7h16M4 12h11M4 17h16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function PanelIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 4v16M12 4v16M19 4v16M3 8h4M10 15h4M17 10h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function Splash() {
  return (
    <div className="shell-splash">
      <Brand />
      <div className="splash-dots" aria-label="正在载入"><span /><span /><span /></div>
    </div>
  );
}

export function SlotLayout() {
  const drawer = useDrawer();
  const gate = useAuthGate();
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches,
  );

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const onChange = (e: MediaQueryListEvent) => {
      setNarrow(e.matches);
      if (!e.matches) setDrawer('none');
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    if (drawer === 'none') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawer('none');
    };
    window.addEventListener('keydown', onKey);
    if (narrow) document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [drawer, narrow]);

  if (gate.state === 'pending') return <Splash />;
  if (gate.state === 'unauthenticated') {
    return <main className="shell-gate"><SlotOutlet slot="auth" /></main>;
  }

  return (
    <div
      className={`polaris-lite-shell ${drawer !== 'none' ? 'drawer-open' : ''}`}
      data-layout="four-slot"
      data-drawer={drawer}
    >
      <header className="shell-topbar">
        <button
          className={`topbar-btn ${drawer === 'sidebar' ? 'active' : ''}`}
          aria-label="会话列表"
          aria-expanded={drawer === 'sidebar'}
          onClick={() => setDrawer(drawer === 'sidebar' ? 'none' : 'sidebar')}
        >
          <MenuIcon />
        </button>
        <span className="topbar-title">Polaris Lite</span>
        <button
          className={`topbar-btn ${drawer === 'panel' ? 'active' : ''}`}
          aria-label="能力面板"
          aria-expanded={drawer === 'panel'}
          onClick={() => setDrawer(drawer === 'panel' ? 'none' : 'panel')}
        >
          <PanelIcon />
        </button>
      </header>

      <aside
        className={`shell-sidebar ${drawer === 'sidebar' ? 'open' : ''}`}
        aria-hidden={narrow && drawer !== 'sidebar' ? true : undefined}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('.chat-session-item, .chat-session-new')) setDrawer('none');
        }}
      >
        <Brand />
        <SlotOutlet slot="sidebar" />
      </aside>

      <main className="shell-main">
        <div className="shell-stream"><SlotOutlet slot="stream" /></div>
        <div className="shell-input"><SlotOutlet slot="input" /></div>
      </main>

      <aside
        className={`shell-panel ${drawer === 'panel' ? 'open' : ''}`}
        aria-hidden={narrow && drawer !== 'panel' ? true : undefined}
      >
        <SlotOutlet slot="panel" />
      </aside>

      {drawer !== 'none' && <div className="drawer-mask" onClick={() => setDrawer('none')} />}
    </div>
  );
}
