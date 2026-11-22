/**
 * 总线类型的最小声明(P2-2):布局能力注册经 api.registerCapability(宿主注入),
 * 处理器签名需 CapBus/CapContext 类型——插件不 import 宿主 bus 实现,只取类型面。
 * 与 @sdk 的 CapabilityHandler 同源;CapContext 字段按布局能力实际消费面收敛。
 */
import type { CapabilityHandler } from '@sdk';

export interface CapContext {
  /** 调用方插件 id(宿主注入,不可伪造) */
  pluginId: string;
  /** 调用方被授权的能力清单(含二级静态授权判定用) */
  capabilities: string[];
}

export interface CapBus {
  /** 注册能力处理器(registerCapability 门面内部走它;此处仅类型面) */
  register(target: string, handler: CapabilityHandler, providerId?: string): void;
}
