/**
 * SlotLayout：核心的四槽布局壳（对应 Polaris 对话四段式）+ auth 门禁（P1 壳层拦截）。
 *
 * 桌面（>768px）：左 sidebar | 中 stream+input | 右 panel 三栏 grid。
 * 手机（≤768px）：单栏，sidebar/panel 变抽屉，经顶栏按钮开关。
 *
 * 门禁（cap.auth 契约，宿主零插件引用）：
 * - pending → Splash；
 * - unauthenticated → 只渲染 auth 槽（登录视图，由权限插件贡献）；
 * - authenticated / open-no-provider → 四槽业务布局。
 */
import { useEffect, useState } from 'react';
import { SlotOutlet } from './SlotOutlet';
import { useAuthGate } from './useAuthGate';

export type LayoutDrawer = 'none' | 'sidebar' | 'panel';

/** 核心·布局状态（手机端抽屉开关） */
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
    return () => {
      layoutListeners.delete(setD);
    };
  }, []);
  return d;
}

function Splash() {
  return (
    <div className="shell-splash">
      <div className="shell-brand">
        <span className="brand-dot" />
        <span className="brand-name">Polaris Lite</span>
      </div>
      <div className="splash-dots">
        <span /><span /><span />
      </div>
    </div>
  );
}

export function SlotLayout() {
  const drawer = useDrawer();
  const gate = useAuthGate();
  /** 是否窄屏（抽屉形态）。桌面端不该有任何抽屉语义——包括滚动锁 */
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches,
  );

  // 视口变化跟随：变宽时强制收起抽屉。
  // 少了这一步，手机上开着抽屉再转横屏/拉宽窗口，body 的 overflow:hidden 会一直留着，
  // 桌面布局看起来「卡住不能滚」。
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const onChange = (e: MediaQueryListEvent) => {
      setNarrow(e.matches);
      if (!e.matches) setDrawer('none');
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // 抽屉打开时：ESC 关闭 + 锁正文滚动（仅窄屏）
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

  // ===== 门禁三段式 =====
  if (gate.state === 'pending') {
    return <Splash />;
  }
  if (gate.state === 'unauthenticated') {
    return (
      <main className="shell-gate">
        <SlotOutlet slot="auth" />
      </main>
    );
  }
  // authenticated / open-no-provider → 四槽业务布局

  return (
    <div
      className={`polaris-lite-shell ${drawer !== 'none' ? 'drawer-open' : ''}`}
      data-layout="four-slot"
      data-drawer={drawer}
    >
      {/* 手机端顶栏（桌面隐藏） */}
      <header className="shell-topbar">
        <button
          className="topbar-btn"
          aria-label="会话列表"
          aria-expanded={drawer === 'sidebar'}
          onClick={() => setDrawer(drawer === 'sidebar' ? 'none' : 'sidebar')}
        >
          ☰
        </button>
        <span className="topbar-title">Polaris Lite</span>
        <button
          className={`topbar-btn ${drawer === 'panel' ? 'active' : ''}`}
          aria-label="能力面板"
          aria-expanded={drawer === 'panel'}
          onClick={() => setDrawer(drawer === 'panel' ? 'none' : 'panel')}
        >
          ⚙
        </button>
      </header>

      <aside
        className={`shell-sidebar ${drawer === 'sidebar' ? 'open' : ''}`}
        // 窄屏且未打开：对辅助技术隐藏（视觉上已移出屏幕，但仍在无障碍树里）
        aria-hidden={narrow && drawer !== 'sidebar' ? true : undefined}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('.chat-session-item, .chat-session-new')) {
            setDrawer('none');
          }
        }}
      >
        <div className="shell-brand">
          <span className="brand-dot" />
          <span className="brand-name">Polaris Lite</span>
        </div>
        <SlotOutlet slot="sidebar" />
      </aside>

      <main className="shell-main">
        <div className="shell-stream">
          <SlotOutlet slot="stream" />
        </div>
        <div className="shell-input">
          <SlotOutlet slot="input" />
        </div>
      </main>

      <aside
        className={`shell-panel ${drawer === 'panel' ? 'open' : ''}`}
        aria-hidden={narrow && drawer !== 'panel' ? true : undefined}
      >
        <SlotOutlet slot="panel" />
      </aside>

      {drawer !== 'none' && (
        <div className="drawer-mask" onClick={() => setDrawer('none')} />
      )}
    </div>
  );
}
