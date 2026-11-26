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
 * - **tab 条 chrome 可由插件渲染**（host-slimming-report §7.2/§4 P1-2）：
 *   置顶/＋n 收纳/搜索/⟳ 刷新是「面板管理」的产品语义，经 contributes.containers
 *   契约外移（shell-chrome 插件）。宿主保留**状态权威**——激活态/置顶/懒挂载/刷新
 *   序号全在本组件，插件组件经 TabChromeProps 收到全部状态与回调（零自持状态，
 *   防双头）。无插件注册时回退内置简版 tab 条（裸按钮，无 chrome——禁用插件不破可用）。
 *
 * 组件来自运行时插件注册表（外部插件动态加载后登记），宿主源码零插件引用。
 */
import { useEffect, useState } from 'react';
import type { SlotId } from './types';
import { host } from './hostRuntime';
import { getRuntimeComponent } from './externalPlugins';
import type { TabChromeProps } from './types';
import { orderEntriesByUserOrder, orderEntriesWithPins, slotSupportsTabs } from './slotRegistry';

const ACTIVE_KEY_PREFIX = 'plite.slot.active.';
/** 面板直达意图事件名（与 @sdk CHANNEL_PANEL_INTENT 值对齐；核心不 import 插件，就地字面量） */
const PANEL_INTENT_EVENT = 'plite-panel-intent';
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

/** 读取置顶清单（兼容历史数据，仅用于置顶排序）；坏数据一律回空 */
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

export function SlotOutlet({ slot }: { slot: SlotId }) {
  const entries = host.slots.list(slot);
  const [activeKey, setActiveKey] = useState<string | null>(() => readActiveKey(slot));
  // 置顶清单仅读作排序（兼容历史收藏数据）；收藏入口已移除，不再写入
  const [pins] = useState<string[]>(() => readPinKeys(slot));
  // 用户自定义顺序（插件管理面板写入 localStorage；本组件经 storage 事件跨实例同步）
  const [userOrder, setUserOrder] = useState<string[]>(() => readUserOrder(slot));
  const [mounted, setMounted] = useState<Set<string>>(() => new Set());
  // 每面板独立的重挂载计数：⟳ 刷新 = 对当前面板 key 追加序号，React 换 key 即卸载重装
  // （mount effect 重跑 → 数据重新拉取），其他面板的 keep-alive 状态不受影响。
  const [reloadSeq, setReloadSeq] = useState<Record<string, number>>({});

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

  // 面板直达深链（@sdk CHANNEL_PANEL_INTENT）：插件派发 { slot, title } 意图，
  // 本组件按 title 匹配 tab 并切换激活（匹配不到静默忽略，不抢默认面板）。
  // 通道名就地字面量对齐（arch 门禁：核心不 import 插件 SDK）。
  useEffect(() => {
    if (slot !== 'panel') return; // 深链目前只服务 panel 槽（通知中心等管理面板）
    const onIntent = (e: Event): void => {
      const detail = (e as CustomEvent<{ slot?: string; title?: string }>).detail;
      if (!detail || detail.slot !== slot || typeof detail.title !== 'string') return;
      const hit = ordered.find((en) => nameOf(en) === detail.title);
      if (hit) select(entryKey(hit.pluginId, hit.component));
    };
    window.addEventListener(PANEL_INTENT_EVENT, onIntent);
    return () => window.removeEventListener(PANEL_INTENT_EVENT, onIntent);
  });

  // 多面板槽：Tab 切换（tab 名 = SlotDescriptor.title ?? 插件 manifest.name）。
  // chrome（tab 条形态）由容器贡献决定：插件注册了 slot-tabs 容器 → 用插件组件；
  // 否则回退内置简版（裸 tab 按钮）。状态权威恒在宿主（本组件）。
  const useTabs = slotSupportsTabs(slot) && entries.length > 1;
  const container = useTabs ? host.slots.resolveContainer('slot-tabs') : undefined;
  const ChromeComp = container
    ? (getRuntimeComponent(container.pluginId, container.component) as
        ((props: TabChromeProps) => React.ReactNode) | undefined)
    : undefined;

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

  /** ⟳ 刷新当前面板：只重挂载激活项（换 key），其余面板的保活状态原样保留。
   *  面板的数据加载都发生在 mount effect，重挂载即等价于「面板自己的刷新按钮」——
   *  宿主统一提供，任何插件面板（含将来新增的）零改动获得该能力。 */
  const refreshActive = (): void => {
    const active = ordered[activeIdx];
    if (!active) return;
    const key = entryKey(active.pluginId, active.component);
    setReloadSeq((prev) => ({ ...prev, [key]: (prev[key] ?? 0) + 1 }));
  };

  // ---- TabChromeProps：宿主是唯一状态权威，chrome 组件零自持状态 ----
  const chromeProps: TabChromeProps = {
    slot,
    tabs: ordered.map((e) => ({
      key: entryKey(e.pluginId, e.component),
      title: nameOf(e),
      pinned: pins.includes(entryKey(e.pluginId, e.component)),
    })),
    activeKey: entryKey(ordered[activeIdx].pluginId, ordered[activeIdx].component),
    onSelect: select,
    onRefresh: refreshActive,
  };

  const activeKeyNow = entryKey(ordered[activeIdx].pluginId, ordered[activeIdx].component);

  return (
    <div className="slot-tabs" data-slot={slot}>
      {ChromeComp ? (
        <ChromeComp {...chromeProps} />
      ) : (
        // 内置回退：裸 tab 条（无 chrome）。类名与完整版共用基础样式（.slot-tabbar/.slot-tab），
        // 置顶/收纳/搜索/⟳ 由 shell-chrome 插件提供；禁用该插件不破可用性。
        <div className="slot-tabbar slot-tabbar-plain" role="tablist" aria-orientation="horizontal" aria-label="面板">
          {ordered.map((e, i) => {
            const name = nameOf(e);
            const key = entryKey(e.pluginId, e.component);
            return (
              <button
                key={key}
                type="button"
                role="tab"
                id={`slot-tab-${slot}-${i}`}
                aria-controls={`slot-pane-${slot}-${i}`}
                aria-selected={key === activeKeyNow}
                className={`slot-tab ${key === activeKeyNow ? 'active' : ''}`}
                title={name}
                onClick={() => select(key)}
              >
                {name}
              </button>
            );
          })}
        </div>
      )}
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
              {/* 首个激活项立即渲染，其余在首次激活后才挂载（避免开机就初始化 4 个面板）。
                  key 追加重挂载序号：⟳ 只重装当前面板，序号未变的兄弟面板保持保活 */}
              {selected || mounted.has(key) ? (
                <SlotEntryView
                  key={`${key}#${reloadSeq[key] ?? 0}`}
                  pluginId={e.pluginId}
                  component={e.component}
                  slot={slot}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
