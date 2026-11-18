/**
 * SlotOutlet：按槽位注册表渲染插件组件（锚点内部的默认内容来源）。
 *
 * 设计要点：
 * - **激活态用稳定 key（pluginId:component），不用数组下标**。用下标时，一旦插件增删
 *   或 order 变化，激活的面板会漂到另一个插件上，用户看到的是「点 A 打开了 B」。
 * - 激活项持久化到 `plite.slot.active.<slot>`，刷新后回到同一个面板。
 * - 懒挂载 + 保活：首次激活才挂载，之后隐藏不卸载，切走再切回不丢滚动位置与草稿。
 * - a11y 补齐：role=tablist/tab/tabpanel、aria-controls、roving tabindex、
 *   ←→/Home/End、Enter/Space 激活。旧实现只有 aria-selected，键盘用户必须按 N 次 Tab
 *   才能穿过 tab 条。
 *
 * 组件来自运行时插件注册表（外部插件动态加载后登记），宿主源码零插件引用。
 */
import { useEffect, useRef, useState } from 'react';
import type { SlotId } from './types';
import { host } from './hostRuntime';
import { getRuntimeComponent } from './externalPlugins';

const ACTIVE_KEY_PREFIX = 'plite.slot.active.';

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
  const [mounted, setMounted] = useState<Set<string>>(() => new Set());
  const [focusIdx, setFocusIdx] = useState(0);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // 多面板槽：Tab 切换（tab 名 = SlotDescriptor.title ?? 插件 manifest.name）
  const useTabs = slot === 'panel' && entries.length > 1;

  // 找不到历史激活项（插件被下线/改名）时回落到第一个，而不是留一个空白面板
  const foundIdx = entries.findIndex((e) => entryKey(e.pluginId, e.component) === activeKey);
  const activeIdx = foundIdx >= 0 ? foundIdx : 0;

  useEffect(() => {
    const active = entries[activeIdx];
    if (!active) return;
    const key = entryKey(active.pluginId, active.component);
    setMounted((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
  }, [entries, activeIdx]);

  useEffect(() => {
    if (useTabs) setFocusIdx(activeIdx);
  }, [useTabs, activeIdx]);

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

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const last = entries.length - 1;
    let next = focusIdx;
    if (e.key === 'ArrowRight') next = focusIdx >= last ? 0 : focusIdx + 1;
    else if (e.key === 'ArrowLeft') next = focusIdx <= 0 ? last : focusIdx - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    else if (e.key === 'Enter' || e.key === ' ') {
      const target = entries[focusIdx];
      if (target) {
        e.preventDefault();
        select(entryKey(target.pluginId, target.component));
      }
      return;
    } else return;
    e.preventDefault();
    setFocusIdx(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <div className="slot-tabs" data-slot={slot}>
      <div className="slot-tabbar" role="tablist" aria-orientation="horizontal" aria-label="面板" onKeyDown={onKeyDown}>
        {entries.map((e, i) => {
          // 优先级：槽位贡献自报的 title（描述「这块 UI 是什么」）> 插件名 > 插件 id
          const name = e.title ?? host.getManifest(e.pluginId)?.name ?? e.pluginId;
          const key = entryKey(e.pluginId, e.component);
          const selected = i === activeIdx;
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
              className={`slot-tab ${selected ? 'active' : ''}`}
              // tab 等分宽度，长名会被 ellipsis 截断；原生 title 兜底全名
              title={name}
              onClick={() => select(key)}
            >
              {name}
            </button>
          );
        })}
      </div>
      <div className="slot-tabbody">
        {entries.map((e, i) => {
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
