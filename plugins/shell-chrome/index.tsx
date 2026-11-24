/**
 * shell-chrome 插件：多面板 tab 条 chrome 的插件化实现（host-slimming-report §7.2 / §4 P1-2）。
 *
 * 经 contributes.containers 契约贡献 'slot-tabs' 容器组件：宿主 SlotOutlet 保留
 * 状态权威（激活态/置顶/懒挂载/刷新序号），把 tab 条渲染权委托给本插件。
 * 组件按 TabChromeProps 收状态与回调，**零自持持久状态**（防双头）——
 * 会话内 UI 状态（收纳菜单开合/搜索词/焦点位置/滚动几何）除外，它们本来就是纯表现层。
 *
 * 承载的能力（此前长在核心 SlotOutlet，约 300 行 + 215 行 CSS）：
 * - tab 自然宽度横向滚动 + 溢出「＋n」收纳菜单（菜单内可搜索、可置顶）；
 * - 置顶标记（tab 前小圆点）与置顶排序（顺序仍由宿主算好传入）；
 * - ⟳ 刷新当前面板按钮（重挂载语义由宿主持有）；
 * - roving tabindex + ←→/Home/End/Enter/Space 键盘操作；
 * - 激活/聚焦项自动滚入视口；纵向滚轮转横向。
 *
 * 宿主禁用本插件时：SlotOutlet 回退内置简版 tab 条（裸按钮），不破可用性。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { LitePlugin, SlotHostApi, TabChromeProps } from '@sdk';
import { getIsNarrow, subscribeNarrow } from './narrowBridge';
import './chrome.css';

/** ⟳ 刷新图标（SVG 替代文本字形：390px 视口下字形渲染偏小且基线不稳） */
function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M20 12a8 8 0 1 1-2.34-5.66M20 4v4h-4"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** tab 条 chrome 主组件：签名严格对齐 @sdk 的 TabChromeProps */
export function SlotTabChrome({ slot, tabs, activeKey, onSelect, onRefresh }: TabChromeProps) {
  const [focusIdx, setFocusIdx] = useState(() => Math.max(0, tabs.findIndex((t) => t.key === activeKey)));
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [geo, setGeo] = useState({ hidden: 0, canLeft: false, canRight: false });
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const barRef = useRef<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  // 断点翻转后 tab 条几何剧变，溢出计数必须重测（宿主 shellState 的窄屏订阅桥接）
  const [narrow, setNarrow] = useState(getIsNarrow);
  useEffect(() => subscribeNarrow(setNarrow), []);

  const activeIdx = Math.max(0, tabs.findIndex((t) => t.key === activeKey));

  // 外部激活变化时同步 roving 焦点
  useEffect(() => {
    setFocusIdx(activeIdx);
  }, [activeIdx]);

  // ---- 窄屏 fit（P1-6 v2 / 方案 A，docs/proto/panel-switcher.html 已实测）----
  // tab 条不滚动：置顶优先（宿主 orderEntriesWithPins 已排好）实测收纳——前 N 个
  // 放得下就渲染 N 个，其余收进 ＋n 全宽菜单（贴 wrap 下缘展开，可搜索/可置顶）。
  const narrowStripRef = useRef<HTMLDivElement | null>(null);
  const [narrowVis, setNarrowVis] = useState(tabs.length);
  const narrowWidthsRef = useRef<Map<string, number>>(new Map());

  /** 实测收纳：读可见 tab 宽度入缓存（display:none 拿不到 offsetWidth，沿用旧值），
   *  按「strip 可用宽 − ＋n 预留(56px)」累计出能放几个；至少保留 1 个实体 tab。 */
  const measureNarrow = (): void => {
    const el = narrowStripRef.current;
    if (!el) return;
    [...el.children].forEach((kid, i) => {
      const w = (kid as HTMLElement).offsetWidth;
      if (w > 0 && tabs[i]) narrowWidthsRef.current.set(tabs[i].key, w);
    });
    const MORE_W = 56; // 与 chrome.css .sc-nmore 固定宽度一致
    let acc = 0;
    let count = 0;
    for (const t of tabs) {
      const w = narrowWidthsRef.current.get(t.key) ?? 0;
      if (count > 0 && acc + w > el.clientWidth - MORE_W) break;
      acc += w;
      count += 1;
    }
    setNarrowVis(Math.max(count, 1));
  };

  // tabs/激活项每次渲染都是新数组：布局效应逐轮实测，计数不变时 setState 原值
  // 退出（Object.is 相等不重渲染），实测收敛后自然稳定，无环。
  useLayoutEffect(() => {
    if (narrow) measureNarrow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });

  // 转屏/抽屉宽度/字体就绪 → 经 ref 调到最新一轮 measure（避免闭包过期）
  const measureNarrowRef = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    measureNarrowRef.current = measureNarrow;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });
  useEffect(() => {
    if (!narrow) return;
    const el = narrowStripRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => measureNarrowRef.current());
    ro.observe(el);
    void document.fonts?.ready.then(() => measureNarrowRef.current());
    return () => ro.disconnect();
  }, [narrow]);

  // ---------- 滚动几何：溢出计数 + 左右可滚提示 ----------
  const measure = (): void => {
    const el = barRef.current;
    if (!el) return;
    const hidden = [...el.children].filter(
      (c) => (c as HTMLElement).offsetLeft + (c as HTMLElement).offsetWidth > el.clientWidth + 1,
    ).length;
    const canLeft = el.scrollLeft > 4;
    const canRight = el.scrollLeft + el.clientWidth < el.scrollWidth - 4;
    setGeo((prev) =>
      prev.hidden === hidden && prev.canLeft === canLeft && prev.canRight === canRight ? prev : { hidden, canLeft, canRight },
    );
  };

  useLayoutEffect(() => {
    measure();
    // tabs 每次渲染都是新数组，不能进依赖；数量、置顶与断点变化才是需要重测的时机
  }, [tabs.length, narrow]);

  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 激活项滚入视口：任何路径（点击/键盘/收纳菜单）切换后，激活 tab 不停在视口外。
  // behavior 'instant'：smooth 依赖 rAF，WebView 后台 rAF 被冻结 → 滚动永不前进。
  useLayoutEffect(() => {
    tabRefs.current[activeIdx]?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  }, [activeIdx, geo.hidden]);

  // 纵向滚轮转横向：tab 条唯一的滚动轴是 x（React 的 onWheel 是 passive，手动挂非 passive）
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent): void => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // 收纳菜单：外部点击 / Escape 关闭
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [menuOpen]);

  /** roving tabindex 键盘导航；maxIdx 限定可达范围——窄屏只遍历实体 tab（收纳项走菜单） */
  const onTabKeyDown =
    (maxIdx: number) =>
    (e: React.KeyboardEvent<HTMLDivElement>): void => {
      const last = maxIdx;
      let next = focusIdx;
      if (e.key === 'ArrowRight') next = focusIdx >= last ? 0 : focusIdx + 1;
      else if (e.key === 'ArrowLeft') next = focusIdx <= 0 ? last : focusIdx - 1;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = last;
      else if (e.key === 'Enter' || e.key === ' ') {
        const target = tabs[focusIdx];
        if (target) {
          e.preventDefault();
          onSelect(target.key);
        }
        return;
      } else return;
      e.preventDefault();
      setFocusIdx(next);
      // 焦点移到哪，tab 就滚到哪：roving 焦点不应落在视口外的按钮上
      tabRefs.current[next]?.focus({ preventScroll: true });
      tabRefs.current[next]?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    };

  const q = query.trim().toLowerCase();
  const menuItems = q ? tabs.filter((t) => t.title.toLowerCase().includes(q)) : tabs;

  /** 收纳菜单 JSX：三列网格平铺全部面板（无收藏） */
  const renderMenu = (): React.ReactNode => (
    <div className="sc-menu" role="menu" aria-label="全部面板">
      {tabs.length > 8 && (
        <input
          className="sc-menu-search"
          type="search"
          placeholder="搜索面板"
          aria-label="搜索面板"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}
      {menuItems.length === 0 && <div className="sc-menu-empty">无匹配面板</div>}
      {menuItems.map((t) => (
        <button
          type="button"
          role="menuitem"
          className={`sc-menu-cell ${t.key === activeKey ? 'active' : ''}`}
          key={t.key}
          title={t.title}
          onClick={() => {
            onSelect(t.key);
            setMenuOpen(false);
            setQuery('');
          }}
        >
          {t.title}
        </button>
      ))}
    </div>
  );

  // ---- 窄屏（≤768px）：整条 tab 在 390px 视口放不下且横向滚动难点中。
  // 改为置顶优先实测收纳：放得下的面板以实体 tab 一步直达，其余收进 ＋n
  // 全宽菜单（贴 wrap 下缘展开，可搜索/可置顶）。桌面布局零变化。
  if (narrow) {
    const hidden = Math.max(0, tabs.length - narrowVis);
    return (
      <div className="sc-wrap sc-narrow" ref={wrapRef} data-refresh="true">
        <div
          className="slot-tabbar sc-bar"
          role="tablist"
          aria-orientation="horizontal"
          aria-label="面板"
          ref={narrowStripRef}
          onKeyDown={onTabKeyDown(Math.max(narrowVis - 1, 0))}
        >
          {tabs.map((t, i) => (
            <button
              key={t.key}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`slot-tab-${slot}-${i}`}
              aria-controls={`slot-pane-${slot}-${i}`}
              aria-selected={t.key === activeKey}
              tabIndex={i === focusIdx ? 0 : -1}
              className={`slot-tab sc-tab ${t.key === activeKey ? 'active' : ''} ${t.pinned ? 'sc-pinned' : ''}`}
              title={t.title}
              style={i >= narrowVis ? { display: 'none' } : undefined}
              onClick={() => onSelect(t.key)}
            >
              {t.title}
            </button>
          ))}
        </div>
        {hidden > 0 && (
          <button
            type="button"
            className="sc-nmore"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`更多面板（${hidden} 个未显示）`}
            title={`更多面板（${hidden} 个未显示）`}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <span aria-hidden="true">＋{hidden}</span>
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="sc-nmore-chev">
              <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        <button
          type="button"
          className="sc-refresh"
          aria-label="刷新当前面板"
          title="刷新当前面板（重新挂载并重新拉取该面板数据，不影响其他面板）"
          onClick={onRefresh}
        >
          <RefreshIcon />
        </button>
        {menuOpen && renderMenu()}
      </div>
    );
  }

  return (
    <div
      className="sc-wrap"
      ref={wrapRef}
      data-can-left={geo.canLeft ? 'true' : undefined}
      data-can-right={geo.canRight ? 'true' : undefined}
      data-more={geo.hidden > 0 ? 'true' : undefined}
      data-refresh="true"
    >
      <div
        className="slot-tabbar sc-bar"
        role="tablist"
        aria-orientation="horizontal"
        aria-label="面板"
        ref={barRef}
        onScroll={measure}
        onKeyDown={onTabKeyDown(tabs.length - 1)}
      >
        {tabs.map((t, i) => (
          <button
            key={t.key}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`slot-tab-${slot}-${i}`}
            aria-controls={`slot-pane-${slot}-${i}`}
            aria-selected={t.key === activeKey}
            tabIndex={i === focusIdx ? 0 : -1}
            className={`slot-tab sc-tab ${t.key === activeKey ? 'active' : ''} ${t.pinned ? 'sc-pinned' : ''}`}
            title={t.title}
            onClick={() => onSelect(t.key)}
          >
            {t.title}
          </button>
        ))}
      </div>
      {geo.hidden > 0 && (
        <button
          type="button"
          className="sc-more"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={`更多面板（${geo.hidden} 个未显示）`}
          title={`更多面板（${geo.hidden} 个未显示）`}
          onClick={() => setMenuOpen((v) => !v)}
        >
          <span aria-hidden="true">＋{geo.hidden}</span>
        </button>
      )}
      <button
        type="button"
        className="sc-refresh"
        aria-label="刷新当前面板"
        title="刷新当前面板（重新挂载并重新拉取该面板数据，不影响其他面板）"
          onClick={onRefresh}
        >
          <RefreshIcon />
        </button>
      {menuOpen && renderMenu()}
    </div>
  );
}

export const shellChromePlugin: LitePlugin = {
  manifest: {
    id: 'shell-chrome',
    name: 'Shell Chrome',
    version: '0.1.0',
    capabilities: [],
    provides: [],
    events: [],
    contributes: {
      slots: [],
      containers: [{ container: 'slot-tabs', component: 'SlotTabChrome', order: 1 }],
    },
  },
  setup(_api: SlotHostApi) {
    /* chrome 组件经 manifest containers 声明即可,无运行时 setup 逻辑 */
  },
};

export default shellChromePlugin;
