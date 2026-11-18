/**
 * SlotOutlet：按槽位注册表渲染插件组件（多实例槽）。
 * 同一槽位可被多个插件贡献（按 order 排序）。
 * - panel 槽（多面板）：条目 >1 时自动显示 Tab 头切换（Tab 名取插件 manifest.name）；
 * - 其余槽：按序全部渲染。
 * 组件来自运行时插件注册表（外部插件动态加载后登记），宿主源码零插件引用。
 */
import { useState } from 'react';
import type { SlotId } from './types';
import { host } from './hostRuntime';
import { getRuntimeComponent } from './externalPlugins';

function SlotEntryView({ pluginId, component, slot }: { pluginId: string; component: string; slot: SlotId }) {
  const Comp = getRuntimeComponent(pluginId, component);
  if (!Comp) {
    return (
      <div className={`slot slot-error slot-${slot}`}>
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
  const [activeIdx, setActiveIdx] = useState(0);

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

  // 多面板槽：Tab 切换（tab 名 = 插件 manifest.name）
  const useTabs = slot === 'panel' && entries.length > 1;
  if (useTabs) {
    const idx = Math.min(activeIdx, entries.length - 1);
    const active = entries[idx];
    return (
      <div className="slot-tabs" data-slot={slot}>
        <div className="slot-tabbar" role="tablist">
          {entries.map((e, i) => {
            const name = host.getManifest(e.pluginId)?.name ?? e.pluginId;
            return (
              <button
                key={`${e.pluginId}-${e.component}`}
                role="tab"
                aria-selected={i === idx}
                className={`slot-tab ${i === idx ? 'active' : ''}`}
                onClick={() => setActiveIdx(i)}
              >
                {name}
              </button>
            );
          })}
        </div>
        <div className="slot-tabbody">
          <SlotEntryView pluginId={active.pluginId} component={active.component} slot={slot} />
        </div>
      </div>
    );
  }

  return (
    <>
      {entries.map((e) => (
        <SlotEntryView key={`${e.pluginId}-${e.component}`} pluginId={e.pluginId} component={e.component} slot={slot} />
      ))}
    </>
  );
}
