/**
 * cap.meta 能力：向插件暴露总线能力清单与审计尾部（panel 插件的数据源）。
 */
import type { CapBus } from '@/core/bus';

export function installMetaCapability(bus: CapBus): void {
  bus.register('cap.meta', () => ({
    capabilities: bus.listCapabilities(),
    audit: bus.tailAudit(20),
  }));
}
