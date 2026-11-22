/**
 * 槽位注册表：插件声明填哪个槽，核心据此渲染四槽布局。
 */
import type { ContainerDescriptor, SlotDescriptor, SlotId } from './types';

export interface SlotEntry extends SlotDescriptor {
  pluginId: string;
}

/**
 * 置顶排序（纯函数，slot tab 条溢出方案用）：置顶项按置顶顺序排最前，
 * 其余保持 order 排序。key 形如 `pluginId:component`（与 SlotOutlet 的 entryKey 一致）。
 * 未知 key（面板已下线后残留的置顶）静默忽略——脏置顶不应炸掉渲染。
 */
export function orderEntriesWithPins(entries: SlotEntry[], pins: string[]): SlotEntry[] {
  if (pins.length === 0) return entries;
  const pinSet = new Set(pins);
  const keyOf = (e: SlotEntry): string => `${e.pluginId}:${e.component}`;
  const pinned: SlotEntry[] = [];
  const rest: SlotEntry[] = [];
  for (const e of entries) (pinSet.has(keyOf(e)) ? pinned : rest).push(e);
  // 置顶内部仍按 pin 声明顺序；两个都置顶的面板次序是用户操作出来的，不能被 order 洗掉
  pinned.sort((a, b) => pins.indexOf(keyOf(a)) - pins.indexOf(keyOf(b)));
  return [...pinned, ...rest];
}

/**
 * 用户自定义顺序覆盖（纯函数，插件管理面板「面板排序」用）：
 * `orderKey` 里的 key 按用户排列的顺序输出；未出现在表里的条目保持既有顺序追加在后。
 * 未知 key（面板下线后残留）静默忽略；表为空时原样返回（不制造多余渲染）。
 * 与 orderEntriesWithPins 组合使用：先按用户顺序重排，再做置顶提升。
 */
export function orderEntriesByUserOrder(entries: SlotEntry[], orderKey: string[]): SlotEntry[] {
  if (orderKey.length === 0) return entries;
  const rank = new Map(orderKey.map((k, i) => [k, i]));
  const keyed = entries.map((e) => ({ e, key: `${e.pluginId}:${e.component}` }));
  const inOrder = keyed.filter((x) => rank.has(x.key));
  const rest = keyed.filter((x) => !rank.has(x.key));
  if (inOrder.length === 0) return entries;
  inOrder.sort((a, b) => rank.get(a.key)! - rank.get(b.key)!);
  return [...inOrder.map((x) => x.e), ...rest.map((x) => x.e)];
}

export interface ContainerEntry extends ContainerDescriptor {
  pluginId: string;
}

export class SlotRegistry {
  private slots = new Map<SlotId, SlotEntry[]>();
  private containers = new Map<ContainerDescriptor['container'], ContainerEntry[]>();

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
    for (const [kind, list] of this.containers) {
      this.containers.set(kind, list.filter((e) => e.pluginId !== pluginId));
    }
  }

  /** 容器贡献登记（host-slimming-report §7.2：tab 条 chrome 可由插件渲染） */
  registerContainers(pluginId: string, descriptors: ContainerDescriptor[]): void {
    for (const d of descriptors) {
      const list = this.containers.get(d.container) ?? [];
      if (!list.some((e) => e.pluginId === pluginId && e.component === d.component)) {
        list.push({ ...d, pluginId });
      }
      this.containers.set(d.container, list);
    }
  }

  /** 取某类容器的最优贡献（order 最小者）；无插件贡献时 undefined → 宿主回退内置 */
  resolveContainer(kind: ContainerDescriptor['container']): ContainerEntry | undefined {
    const list = this.containers.get(kind) ?? [];
    if (list.length === 0) return undefined;
    return [...list].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0];
  }

  resolve(slot: SlotId): SlotEntry | undefined {
    const list = this.slots.get(slot) ?? [];
    return [...list].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0];
  }

  list(slot: SlotId): SlotEntry[] {
    // 必须按 order 排序：注册顺序取决于插件加载时序（registry 顺序 + 依赖拓扑序），
    // 不排序则 slot.tabbar 的 tab 顺序会随加载快慢漂移，order 声明形同虚设。
    return [...(this.slots.get(slot) ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }
}
