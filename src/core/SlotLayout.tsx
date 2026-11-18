/**
 * SlotLayout：核心壳层（topbar + 工作区树 + 移动端抽屉）+ auth 门禁。
 *
 * 与改造前的区别：四个固定槽位不再写死在 JSX 里，而是由 `workspaceStore` 里的
 * **工作区树**渲染（`./workspace/WorkspaceTree`）。默认树与旧的四槽布局逐节点等价，
 * 所以既有插件与样式零改动；插件/用户在运行时改树即可重排界面。
 *
 * 壳层自己只管四件事：顶栏与抽屉、断点、布局落盘时机、门禁。布局数据不在这里。
 */
import { useEffect, useSyncExternalStore } from 'react';
import { WorkspaceTree, LayoutNotice } from './workspace/WorkspaceTree';
import { workspaceStore } from './workspace/hostStore';
import { useAuthGate } from './useAuthGate';
import { Brand } from './Brand';
import { SlotOutlet } from './SlotOutlet';
import {
  dismissNotice,
  getDrawer,
  getIsNarrow,
  getNotices,
  setDrawer,
  subscribeDrawer,
  subscribeNarrow,
  subscribeNotices,
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
      <div className="splash-dots" aria-label="正在载入">
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}

/**
 * 启动告警条：壳层第一行，占位而非浮层。
 * 以前是 fixed 覆盖层，会把侧栏品牌和面板 tab 条压掉——出问题时更需要看清界面。
 */
function BootNotices() {
  const notices = useSyncExternalStore(subscribeNotices, getNotices, getNotices);
  if (notices.length === 0) return null;
  return (
    <div className="plite-boot-notices">
      {notices.map((n) => (
        <div className="plite-load-warning" key={n.id} role="alert">
          <span className="plite-load-warning-text">
            {n.title}：{n.lines.join('；')}
          </span>
          <button type="button" className="plite-load-warning-close" aria-label="关闭提示" onClick={() => dismissNotice(n.id)}>
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      ))}
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
  const snapshot = useSyncExternalStore(workspaceStore.subscribe, workspaceStore.getSnapshot, workspaceStore.getSnapshot);

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

  // 页面隐藏 / 关闭前把布局落盘：移动端不一定触发 pagehide，两个事件都听
  useEffect(() => {
    const flush = () => workspaceStore.flush();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
      flush();
    };
  }, []);

  if (gate.state === 'pending') return <Splash />;
  if (gate.state === 'unauthenticated') {
    // 门禁是树的**外部**路径：auth 不是锚点，未登录时壳层骨架一律不渲染。
    // 但启动告警仍要显示——「插件没装成功」和「进不去」经常同时发生，
    // 把告警藏在登录墙后面等于让人在无信息状态下排查。
    return (
      <div className="shell-gate-wrap">
        <BootNotices />
        <main className="shell-gate">
          <SlotOutlet slot="auth" />
        </main>
      </div>
    );
  }

  return (
    <div
      className={`polaris-lite-shell ${drawer !== 'none' ? 'drawer-open' : ''}`}
      data-layout="workspace-tree"
      data-drawer={drawer}
    >
      <BootNotices />

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

      <div className="shell-body">
        <WorkspaceTree node={snapshot.tree} />
      </div>

      <LayoutNotice />
      {drawer !== 'none' && <div className="drawer-mask" onClick={() => setDrawer('none')} />}
    </div>
  );
}
