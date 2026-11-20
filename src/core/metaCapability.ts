/**
 * cap.meta 能力：向插件暴露总线能力清单、有效权限表与审计尾部（panel 插件的数据源）。
 * 只读自省接口：不入审计链（避免面板轮询淹没真实调用记录）。
 *
 * `views` 来自运行时视图注册表（viewType/title/pluginId）。布局能力（cap.ui.layout）
 * 的 listViews 需要授权且登录后才可调；这里提供同源数据的只读通道，
 * 供插件管理面板等自省型面板枚举「装了哪些视图」。
 */
import type { CapBus } from '@/core/bus';
import type { EffectivePolicy } from '@/core/policy';
import type { ViewRegistry } from '@/core/workspace/viewRegistry';

export function installMetaCapability(
  bus: CapBus,
  policyTable: () => EffectivePolicy[] = () => [],
  viewRegistry?: ViewRegistry,
): void {
  bus.register('cap.meta', () => ({
    capabilities: bus.listCapabilities(),
    audit: bus.tailAudit(20),
    policies: policyTable(),
    views: viewRegistry
      ? viewRegistry.list().map((v) => ({ viewType: v.viewType, title: v.title, pluginId: v.pluginId }))
      : [],
  }));
}
