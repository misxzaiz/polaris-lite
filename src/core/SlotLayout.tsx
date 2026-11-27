/**
 * SlotLayout：核心壳层（topbar + 布局主体 + 移动端抽屉）+ auth 门禁。
 *
 * 2026-11-21 P2-2（host-slimming-report §7.1）：工作区树已抽出为 workspace-layout
 * 插件（layout-root 容器）。本壳层把「主体区域」渲染委托给容器贡献组件——有插件
 * 注册时渲染布局树（renderAnchor 注入锚点内容、resolveView 注入视图组件解析）；
 * 无插件注册时回退**固定四槽**（WorkspaceTree 时代之前的形态,不破可用）。
 *
 * 壳层自己只管：顶栏与抽屉、断点、门禁、容器 wiring（viewRegistry 注入布局插件）。
 *
 * 2026-11-27：启动告警条（BootNotices）按用户禁令整体移除——提示改由核心
 * shellState.pushNotice 派发 PLITE_BOOT_NOTICE DOM 事件，notification-center
 * 插件接收后弹 toast + 落通知 inbox；壳层顶部不再渲染任何常驻告警。
 */
import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { useAuthGate } from './useAuthGate';
import { Brand } from './Brand';
import { SlotOutlet } from './SlotOutlet';
import { host } from './hostRuntime';
import { t } from './i18n';
import { getRuntimeComponent } from './externalPlugins';
import { viewRegistry } from './workspace/viewRegistry';
import type { LayoutRootProps, TopbarChromeProps } from './types';
import {
  getDrawer,
  getIsNarrow,
  setDrawer,
  subscribeDrawer,
  subscribeNarrow,
} from './shellState';

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
      <div className="splash-dots" aria-label={t('shell.loading')}>
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}

function useNarrow(): boolean {
  return useSyncExternalStore(subscribeNarrow, getIsNarrow, () => false);
}

function useDrawer(): ReturnType<typeof getDrawer> {
  return useSyncExternalStore(subscribeDrawer, getDrawer, getDrawer);
}

export function SlotLayout() {
  const drawer = useDrawer();
  const narrow = useNarrow();
  const gate = useAuthGate();

  // layout-root 容器解析 + 一次性 wiring（把核心 viewRegistry/组件解析注入布局插件）
  const container = host.slots.resolveContainer('layout-root');
  const LayoutComp = container
    ? (getRuntimeComponent(container.pluginId, container.component) as
        ((props: LayoutRootProps) => ReactNode) | undefined)
    : undefined;
  // topbar 容器解析（移动端顶栏 chrome 外移：插件可替换顶栏渲染，宿主保留抽屉状态权威）
  const topbarComp = host.slots.resolveContainer('topbar');
  const TopbarComp = topbarComp
    ? (getRuntimeComponent(topbarComp.pluginId, topbarComp.component) as
        ((props: TopbarChromeProps) => ReactNode) | undefined)
    : undefined;

  // wiring 已移至 main.tsx 装载完成后（必修包修4:渲染体不再做副作用;wire 缺失有 boot notice）

  useEffect(() => {
    if (drawer === 'none') return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setDrawer('none');
    };
    window.addEventListener('keydown', onKey);
    if (narrow) document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [drawer, narrow]);

  // ---- 手机端键盘让位（P2-9）：iOS Safari 不支持 interactive-widget=resizes-content，
  // 键盘弹出不缩视口，贴底的输入行会被键盘盖住。visualViewport 实测被遮高度写入 CSS 变量，
  // 消费见 styles.css .shell-input（仅窄屏 transform 抬升）；
  // Android 上 resizes-content 已缩视口 → overlap≈0，自动退化为 no-op。
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onVV = (): void => {
      const overlap = window.innerHeight - vv.height - vv.offsetTop;
      document.documentElement.style.setProperty('--plite-kb-lift', `${Math.max(0, Math.round(overlap))}px`);
    };
    vv.addEventListener('resize', onVV);
    vv.addEventListener('scroll', onVV);
    onVV();
    return () => {
      vv.removeEventListener('resize', onVV);
      vv.removeEventListener('scroll', onVV);
      document.documentElement.style.removeProperty('--plite-kb-lift');
    };
  }, []);

  // ---- 边缘滑动手势（P2-10）：左缘右滑开侧栏 / 右缘左滑开面板。
  // 仅手机端且无抽屉打开时生效；横向位移明显占优才触发，避免误伤纵向滚动。
  const drawerClosed = drawer === 'none';
  useEffect(() => {
    if (!narrow || !drawerClosed) return;
    const EDGE = 28;
    let sx = 0;
    let sy = 0;
    let edge: 'left' | 'right' | null = null;
    const onStart = (e: TouchEvent): void => {
      const t = e.touches[0];
      sx = t.clientX;
      sy = t.clientY;
      edge = t.clientX <= EDGE ? 'left' : t.clientX >= window.innerWidth - EDGE ? 'right' : null;
    };
    const onMove = (e: TouchEvent): void => {
      if (!edge) return;
      const t = e.touches[0];
      const dx = t.clientX - sx;
      const dy = t.clientY - sy;
      if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
      if (edge === 'left' && dx > 0) setDrawer('sidebar');
      else if (edge === 'right' && dx < 0) setDrawer('panel');
      edge = null;
    };
    const onEnd = (): void => {
      edge = null;
    };
    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchmove', onMove, { passive: true });
    document.addEventListener('touchend', onEnd, { passive: true });
    return () => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
    };
  }, [narrow, drawerClosed]);

  if (gate.state === 'pending') return <Splash />;
  if (gate.state === 'unauthenticated') {
    // 门禁是布局的**外部**路径：auth 不是锚点，未登录时壳层骨架一律不渲染。
    // 但启动告警仍要显示——「插件没装成功」和「进不去」经常同时发生，
    // 把告警藏在登录墙后面等于让人在无信息状态下排查。
    return (
      <div className="shell-gate-wrap">
        <main className="shell-gate">
          <SlotOutlet slot="auth" />
        </main>
      </div>
    );
  }

  return (
    <div
      className={`polaris-lite-shell ${drawer !== 'none' ? 'drawer-open' : ''}`}
      data-layout={LayoutComp ? 'workspace-tree' : 'fixed-slots'}
      data-drawer={drawer}
    >

      <header className="shell-topbar">
        {TopbarComp ? (
          <TopbarComp
            drawer={drawer}
            onToggleSidebar={() => setDrawer(drawer === 'sidebar' ? 'none' : 'sidebar')}
            onTogglePanel={() => setDrawer(drawer === 'panel' ? 'none' : 'panel')}
            t={t}
          />
        ) : (
          <>
            <button
              className={`topbar-btn ${drawer === 'sidebar' ? 'active' : ''}`}
              aria-label={t('shell.sessionList')}
              aria-expanded={drawer === 'sidebar'}
              onClick={() => setDrawer(drawer === 'sidebar' ? 'none' : 'sidebar')}
            >
              <MenuIcon />
            </button>
            <span className="topbar-title">{t('shell.appName')}</span>
            <button
              className={`topbar-btn ${drawer === 'panel' ? 'active' : ''}`}
              aria-label={t('shell.capabilityPanel')}
              aria-expanded={drawer === 'panel'}
              onClick={() => setDrawer(drawer === 'panel' ? 'none' : 'panel')}
            >
              <PanelIcon />
            </button>
          </>
        )}
      </header>

      <div className="shell-body">
        {LayoutComp ? (
          <LayoutComp
            renderAnchor={(anchor) => <SlotOutlet slot={anchor} />}
            resolveView={(viewType) => {
              const def = viewRegistry.get(viewType);
              return def ? getRuntimeComponent(def.pluginId, def.component) : undefined;
            }}
          />
        ) : (
          // 回退：固定四槽（workspace-layout 插件未注册/被禁用时不破可用）
          <div className="ws-fallback-grid" data-layout="fixed-slots">
            <SlotOutlet slot="sidebar" />
            <SlotOutlet slot="stream" />
            <SlotOutlet slot="input" />
            <SlotOutlet slot="panel" />
          </div>
        )}
      </div>

      {drawer !== 'none' && <div className="drawer-mask" onClick={() => setDrawer('none')} />}

      {/* 插件浮层根（cap.ui.overlay 的宿主实现，经 api.overlay.root() 取用）：
          fixed 锚定视口、脱离 .shell-panel 滚动容器——插件浮层在此 portal 渲染，
          移动端抽屉滚动时不再随内容漂移。空态 pointer-events:none 放行点击。 */}
      <div className="slot-overlay-root" id="plite-overlay-root" />
    </div>
  );
}
