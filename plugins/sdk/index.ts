/**
 * 插件 SDK —— 插件与宿主之间**唯一**的公共契约面。
 *
 * 原则：
 * - 插件只能 import 本模块（`@sdk`），不得直接 import 宿主 `src/` 下的任何实现
 *   （store / bus / hostRuntime …）。构建时 `@` 别名在插件侧已移除，
 *   一旦误引宿主内部实现会**构建失败**，而不是悄悄形成构建期耦合。
 * - 这里只放「类型与常量」这类零运行时依赖的契约；宿主实现（注册表、总线、布局）
 *   一律经运行时的 SlotHostApi 注入，插件拿不到也不需要。
 *
 * 新增公共契约时：先改 src/core/types.ts，再在此重导出，并同步 grants.json 的权限语义。
 */
export type {
  SlotId,
  AuthStatus,
  AuthUser,
  AuthStatusResult,
  AuthLoginPayload,
  AuthCheckPayload,
  AuthCheckResult,
  AuthLogoutResult,
  SlotDescriptor,
  LiteManifest,
  CapRequest,
  CapResponse,
  StreamEvent,
  ChatMessage,
  ChatSession,
  CapabilityRegistrar,
  SlotHostApi,
  LitePlugin,
  CapabilityHandler,
  StreamCapabilityHandler,
} from '../../src/core/types';

// 说明：这里**只做类型重导出**，不导出运行时常量。
// 目的：插件 bundle 与宿主源码零运行时依赖，所有能力都在运行时经 SlotHostApi 注入。
// 若将来确有共享常量的需要，应在 sdk 内就地定义字面量，而不是从宿主 src 里取值。
