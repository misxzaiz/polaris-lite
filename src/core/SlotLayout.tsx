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

  // 手机端：打开任一抽屉时锁正文滚动（body 级）
  useEffect(() => {
    document.body.style.overflow = drawer !== 'none' ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [drawer]);

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

      <aside className={`shell-panel ${drawer === 'panel' ? 'open' : ''}`}>
        <SlotOutlet slot="panel" />
      </aside>

      {drawer !== 'none' && (
        <div className="drawer-mask" onClick={() => setDrawer('none')} />
      )}
    </div>
  );
}
