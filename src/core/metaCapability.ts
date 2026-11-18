/**
 * cap.meta 能力：向插件暴露总线能力清单、有效权限表与审计尾部（panel 插件的数据源）。
 * 只读自省接口：不入审计链（避免面板轮询淹没真实调用记录）。
 */
import type { CapBus } from '@/core/bus';
import type { EffectivePolicy } from '@/core/policy';

export function installMetaCapability(bus: CapBus, policyTable: () => EffectivePolicy[] = () => []): void {
  bus.register('cap.meta', () => ({
    capabilities: bus.listCapabilities(),
    audit: bus.tailAudit(20),
    policies: policyTable(),
  }));
}
