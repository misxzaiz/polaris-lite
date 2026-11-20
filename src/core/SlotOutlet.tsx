/**
 * SlotOutlet：按槽位注册表渲染插件组件（锚点内部的默认内容来源）。
 *
 * 设计要点：
 * - **激活态用稳定 key（pluginId:component），不用数组下标**。用下标时，一旦插件增删
 *   或 order 变化，激活的面板会漂到另一个插件上，用户看到的是「点 A 打开了 B」。
 * - 激活项持久化到 `plite.slot.active.<slot>`，刷新后回到同一个面板。
 * - 懒挂载 + 保活：首次激活才挂载，之后隐藏不卸载，切走再切回不丢滚动位置与草稿。
 * - a11y 补齐：role=tablist/tab/tabpanel、aria-controls、roving tabindex、
 *   ←→/Home/End、Enter/Space 激活。
 * - **tab 条横向滚动 + 溢出收纳**（panel-tabs-schemes 方案 C）：tab 改自然宽度
 *   （短名省空间、长名不截断），横向滚动消化数量；容纳不下的进「＋n」收纳菜单，
 *   菜单内可搜索、可置顶——置顶项排到滚动区最前，高频面板不随数量增长沉底。
 *   激活/聚焦项自动滚入视口，任何路径（点击/键盘/菜单）切换后激活 tab 不停在视口外。
 *
 * 组件来自运行时插件注册表（外部插件动态加载后登记），宿主源码零插件引用。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SlotId } from './types';
import { host } from './hostRuntime';
import { getRuntimeComponent } from './externalPlugins';
import { orderEntriesByUserOrder, orderEntriesWithPins } from './slotRegistry';
import { getIsNarrow, subscribeNarrow } from './shellState';

const ACTIVE_KEY_PREFIX = 'plite.slot.active.';
const PIN_KEY_PREFIX = 'plite.slot.pins.';
const USER_ORDER_KEY_PREFIX = 'plite.slot.order.';

function entryKey(pluginId: string, component: string): string {
  return `${pluginId}:${component}`;
}

function readActiveKey(slot: SlotId): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(ACTIVE_KEY_PREFIX + slot);
  } catch {
    return null;
  }
}

function writeActiveKey(slot: SlotId, key: string): void {
  try {
    window.localStorage.setItem(ACTIVE_KEY_PREFIX + slot, key);
  } catch {
    /* 持久化失败不阻断切换（会话内仍生效） */
  }
}

/** 读取置顶清单；坏数据（非字符串数组）一律回空，脏 localStorage 不应炸掉面板 */
function readPinKeys(slot: SlotId): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(PIN_KEY_PREFIX + slot);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((k): k is string => typeof k === 'string');
  } catch {
    return [];
  }
}

function writePinKeys(slot: SlotId, keys: string[]): void {
  try {
    window.localStorage.setItem(PIN_KEY_PREFIX + slot, JSON.stringify(keys));
  } catch {
    /* 同 active key：持久化失败不阻断（会话内仍生效） */
  }
}

/** 读取用户自定义面板顺序（插件管理面板写入）；坏数据回空 */
function readUserOrder(slot: SlotId): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(USER_ORDER_KEY_PREFIX + slot);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((k): k is string => typeof k === 'string');
  } catch {
    return [];
  }
}

function SlotEntryView({ pluginId, component, slot }: { pluginId: string; component: string; slot: SlotId }) {
  const Comp = getRuntimeComponent(pluginId, component);
  if (!Comp) {
    return (
      <div className={`slot slot-error slot-${slot}`} data-plugin={pluginId}>
        <span>插件 {pluginId} 未导出组件 {component}</span>
      </div>
    );
  }
  return (
    <div className={`slot slot-${slot}`} data-slot={slot} data-plugin={pluginId}>
      <Comp />
    </div>
  );
}

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} aria-hidden="true">
      <path
        d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function SlotOutlet({ slot }: { slot: SlotId }) {
  const entries = host.slots.list(slot);
  const [activeKey, setActiveKey] = useState<string | null>(() => readActiveKey(slot));
  const [pins, setPins] = useState<string[]>(() => readPinKeys(slot));
  // 用户自定义顺序（插件管理面板写入 localStorage；本组件经 storage 事件跨实例同步）
  const [userOrder, setUserOrder] = useState<string[]>(() => readUserOrder(slot));
  const [mounted, setMounted] = useState<Set<string>>(() => new Set());
  const [focusIdx, setFocusIdx] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [geo, setGeo] = useState({ hidden: 0, canLeft: false, canRight: false });
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const barRef = useRef<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  // 断点翻转后 tab 条从 display:contents 变 flex，几何剧变，溢出计数必须重测；
  // ResizeObserver 在部分 WebView 后台被 rAF 冻结不可依赖，断点订阅是确定性的补测时机
  const [narrow, setNarrow] = useState(getIsNarrow);
  useEffect(() => subscribeNarrow(setNarrow), []);

  // 面板排序由插件管理面板写 localStorage（本组件挂载在 panel 槽，同页不同实例）；
  // storage 事件只在**其他**文档触发，同文档写不上——用自定义事件兜底（写侧 dispatch）。
  useEffect(() => {
    const onStorage = (e: StorageEvent): void => {
      if (e.key === USER_ORDER_KEY_PREFIX + slot) setUserOrder(readUserOrder(slot));
    };
    const onLocal = (e: Event): void => {
      if ((e as CustomEvent<string>).detail === USER_ORDER_KEY_PREFIX + slot) setUserOrder(readUserOrder(slot));
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('plite-slot-order-changed', onLocal);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('plite-slot-order-changed', onLocal);
    };
  }, [slot]);

  // 多面板槽：Tab 切换（tab 名 = SlotDescriptor.title ?? 插件 manifest.name）
  const useTabs = slot === 'panel' && entries.length > 1;

  // 用户自定义顺序优先（插件管理面板「面板排序」写入），再做置顶提升；
  // 两者都是稳定 key 操作，未覆盖的条目保持 order 顺序。无自定义时零开销直通。
  const ordered = orderEntriesWithPins(orderEntriesByUserOrder(entries, userOrder), pins);
  const nameOf = (e: (typeof entries)[number]): string =>
    e.title ?? host.getManifest(e.pluginId)?.name ?? e.pluginId;

  // 找不到历史激活项（插件被下线/改名）时回落到第一个，而不是留一个空白面板
  const foundIdx = ordered.findIndex((e) => entryKey(e.pluginId, e.component) === activeKey);
  const activeIdx = foundIdx >= 0 ? foundIdx : 0;

  useEffect(() => {
    const active = ordered[activeIdx];
    if (!active) return;
    const key = entryKey(active.pluginId, active.component);
    setMounted((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
  }, [ordered, activeIdx]);

  useEffect(() => {
    if (useTabs) setFocusIdx(activeIdx);
  }, [useTabs, activeIdx]);

  // ---------- 滚动几何：溢出计数 + 左右可滚提示 ----------
  // offsetLeft 是布局位置（不随 scrollLeft 变化），因此 hidden 在滚动过程中保持稳定，
  // 语义固定为「不滚动就看不到的面板数」——「＋n」的 n。
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
    if (!useTabs) return;
    measure();
    // entries 每次渲染都是新数组，不能进依赖；数量、置顶与断点变化才是需要重测的时机
  }, [useTabs, ordered.length, pins, narrow]);

  useEffect(() => {
    const el = barRef.current;
    if (!el || !useTabs) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => ro.disconnect();
  }, [useTabs]);

  // 激活项滚入视口：任何路径（点击/键盘/收纳菜单）切换后，激活 tab 不停在视口外。
  // behavior 'instant'：smooth 依赖 rAF，在 WebView2 的隐藏 tab 里 rAF 被冻结 → smooth
  // 滚动永不前进（实测 IAB 后台 scrollLeft 赋值被拦截），激活项停留在视口外。
  // 依赖含 geo.hidden：溢出时 wrap 写 data-more → CSS 给 tab 条补右 padding 让位 ＋n 按钮，
  // 对齐必须在这之后重跑一次，否则首屏按 12px padding 的旧几何滚，末位 tab 被 ＋n 盖住半截
  useLayoutEffect(() => {
    if (!useTabs) return;
    tabRefs.current[activeIdx]?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  }, [useTabs, activeIdx, geo.hidden]);

  // 纵向滚轮转横向：tab 条唯一的滚动轴是 x，滚轮/触控板的 deltaY 直接喂给 scrollLeft。
  // 手动挂非 passive 监听（React 的 onWheel 是 passive，preventDefault 无效）
  useEffect(() => {
    const el = barRef.current;
    if (!el || !useTabs) return;
    const onWheel = (e: WheelEvent): void => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [useTabs]);

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

  if (entries.length === 0) {
    const emptyText =
      slot === 'auth'
        ? '未找到登录插件（registry.json 未启用 cap.auth 提供方）'
        : `槽位 ${slot} 暂无插件`;
    return (
      <div className={`slot slot-empty slot-${slot}`} data-slot={slot}>
        <span>{emptyText}</span>
        {slot === 'auth' && (
          <button className="gate-retry" onClick={() => window.location.reload()}>
            重试
          </button>
        )}
      </div>
    );
  }

  if (!useTabs) {
    return (
      <>
        {entries.map((e) => (
          <SlotEntryView key={entryKey(e.pluginId, e.component)} pluginId={e.pluginId} component={e.component} slot={slot} />
        ))}
      </>
    );
  }

  const select = (key: string): void => {
    setActiveKey(key);
    writeActiveKey(slot, key);
  };

  const togglePin = (key: string): void => {
    const next = pins.includes(key) ? pins.filter((k) => k !== key) : [...pins, key];
    setPins(next);
    writePinKeys(slot, next);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const last = ordered.length - 1;
    let next = focusIdx;
    if (e.key === 'ArrowRight') next = focusIdx >= last ? 0 : focusIdx + 1;
    else if (e.key === 'ArrowLeft') next = focusIdx <= 0 ? last : focusIdx - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    else if (e.key === 'Enter' || e.key === ' ') {
      const target = ordered[focusIdx];
      if (target) {
        e.preventDefault();
        select(entryKey(target.pluginId, target.component));
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
  const menuItems = q ? ordered.filter((e) => nameOf(e).toLowerCase().includes(q)) : ordered;

  return (
    <div className="slot-tabs" data-slot={slot}>
      <div
        className="slot-tabbar-wrap"
        ref={wrapRef}
        data-can-left={geo.canLeft ? 'true' : undefined}
        data-can-right={geo.canRight ? 'true' : undefined}
        data-more={geo.hidden > 0 ? 'true' : undefined}
      >
        <div
          className="slot-tabbar"
          role="tablist"
          aria-orientation="horizontal"
          aria-label="面板"
          ref={barRef}
          onScroll={measure}
          onKeyDown={onKeyDown}
        >
          {ordered.map((e, i) => {
            const name = nameOf(e);
            const key = entryKey(e.pluginId, e.component);
            const selected = i === activeIdx;
            const pinned = pins.includes(key);
            return (
              <button
                key={key}
                ref={(el) => {
                  tabRefs.current[i] = el;
                }}
                type="button"
                role="tab"
                id={`slot-tab-${slot}-${i}`}
                aria-controls={`slot-pane-${slot}-${i}`}
                aria-selected={selected}
                tabIndex={i === focusIdx ? 0 : -1}
                className={`slot-tab ${selected ? 'active' : ''} ${pinned ? 'pinned' : ''}`}
                title={name}
                onClick={() => select(key)}
              >
                {name}
              </button>
            );
          })}
        </div>
        {geo.hidden > 0 && (
          <button
            type="button"
            className="slot-tab-more"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`更多面板（${geo.hidden} 个未显示）`}
            title={`更多面板（${geo.hidden} 个未显示）`}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <span aria-hidden="true">＋{geo.hidden}</span>
          </button>
        )}
        {menuOpen && (
          <div className="slot-tabmenu" role="menu" aria-label="全部面板">
            {ordered.length > 8 && (
              <input
                className="slot-tabmenu-search"
                type="search"
                placeholder="搜索面板"
                aria-label="搜索面板"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            )}
            {menuItems.length === 0 && <div className="slot-tabmenu-empty">无匹配面板</div>}
            {menuItems.map((e) => {
              const key = entryKey(e.pluginId, e.component);
              const name = nameOf(e);
              const pinned = pins.includes(key);
              const isActive = key === entryKey(ordered[activeIdx].pluginId, ordered[activeIdx].component);
              return (
                <div className={`slot-tabmenu-row ${isActive ? 'active' : ''}`} key={key}>
                  <button
                    type="button"
                    role="menuitem"
                    className="slot-tabmenu-item"
                    onClick={() => {
                      select(key);
                      setMenuOpen(false);
                      setQuery('');
                    }}
                  >
                    {name}
                  </button>
                  <button
                    type="button"
                    className={`slot-tabmenu-pin ${pinned ? 'pinned' : ''}`}
                    aria-pressed={pinned}
                    aria-label={pinned ? `取消置顶${name}` : `置顶${name}`}
                    title={pinned ? '取消置顶' : '置顶'}
                    onClick={() => togglePin(key)}
                  >
                    <StarIcon filled={pinned} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className="slot-tabbody">
        {ordered.map((e, i) => {
          const key = entryKey(e.pluginId, e.component);
          const selected = i === activeIdx;
          return (
            <div
              key={key}
              role="tabpanel"
              id={`slot-pane-${slot}-${i}`}
              aria-labelledby={`slot-tab-${slot}-${i}`}
              tabIndex={0}
              className="slot-tabpanel"
              style={selected ? undefined : { display: 'none' }}
            >
              {/* 首个激活项立即渲染，其余在首次激活后才挂载（避免开机就初始化 4 个面板） */}
              {selected || mounted.has(key) ? (
                <SlotEntryView pluginId={e.pluginId} component={e.component} slot={slot} />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
