/**
 * 槽位注册表：插件声明填哪个槽，核心据此渲染四槽布局。
 */
import type { SlotDescriptor, SlotId } from './types';

export interface SlotEntry extends SlotDescriptor {
  pluginId: string;
}

export class SlotRegistry {
  private slots = new Map<SlotId, SlotEntry[]>();

  register(pluginId: string, descriptors: SlotDescriptor[]): void {
    for (const d of descriptors) {
      const list = this.slots.get(d.slot) ?? [];
      if (!list.some((e) => e.pluginId === pluginId && e.component === d.component)) {
        list.push({ ...d, pluginId });
      }
      this.slots.set(d.slot, list);
    }
  }

  unregisterPlugin(pluginId: string): void {
    for (const [slot, list] of this.slots) {
      this.slots.set(slot, list.filter((e) => e.pluginId !== pluginId));
    }
  }

  resolve(slot: SlotId): SlotEntry | undefined {
    const list = this.slots.get(slot) ?? [];
    return [...list].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0];
  }

  list(slot: SlotId): SlotEntry[] {
    return [...(this.slots.get(slot) ?? [])];
  }
}
