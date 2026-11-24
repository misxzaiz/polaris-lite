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
  ViewDescriptor,
  TabChromeProps,
  ContainerDescriptor,
  LayoutRootProps,
  LiteManifest,
  CapRequest,
  CapResponse,
  StreamEvent,
  ChatMessage,
  ChatSession,
  ToolCardStatus,
  ToolCardData,
  ToolCardMessage,
  InteractiveCardData,
  ArtifactCardData,
  AsstBlock,
  AssistantBlocks,
  AssistantBlockMessage,
  SessionStoreMessage,
  CapabilityRegistrar,
  SlotHostApi,
  LitePlugin,
  CapabilityHandler,
  StreamCapabilityHandler,
} from '../../src/core/types';

// 说明：这里**只做类型重导出**，不导出宿主运行时常量。
// 目的：插件 bundle 与宿主源码零运行时依赖，所有能力都在运行时经 SlotHostApi 注入。
// 若将来确有共享常量的需要，应在 sdk 内就地定义字面量，而不是从宿主 src 里取值。

/**
 * 跨插件共享契约常量（2026-11-21 暗通道收编，docs/host-slimming-report-2026-11-21.md §2/§4 P0-1）。
 *
 * 背景：此前跨插件集成靠各自硬编码的 window 全局名 / storage 键（"暗通道"），
 * 不在任何 manifest/grants 里可见——替换一方会静默打断另一方。收编原则：
 * - 字面量只在此处定义一次，两侧插件一律 `import { ... } from '@sdk'`；
 * - 构建期（build-plugins 校验）禁止插件源码再出现裸 `__XXX__` 字面量（见该脚本 A 段）；
 * - 新增共享通道必须先在这里登记，否则构建失败。
 */

/** file-browser「发到对话」→ chat-lite 输入框草稿注入（跨插件输入合成通道） */
export const CHANNEL_FILE_BROWSER_COMPOSE = '__PLITE_FILE_BROWSER_COMPOSE__';

/** interactive-cards 应答桥：交互卡 UI 点击 → interactive-cards 应答分发 */
export const CHANNEL_INTERACTIVE_RESPOND = '__PLITE_INTERACTIVE_RESPOND__';

/** 产物渲染器注册表：产物插件登记 rendererType → 组件，chat-lite BlockGroup 查表渲染 */
export const CHANNEL_ARTIFACT_RENDERERS = '__PLITE_ARTIFACT_RENDERERS__';

/** 布局容器 wiring 通道：核心壳层把 viewRegistry 查表能力注入 workspace-layout 插件 */
export const CHANNEL_LAYOUT_WIRE = '__PLITE_LAYOUT_WIRE__';

/** 抽屉状态镜像通道：宿主 shellState.setDrawer 发布,workspace-layout 只读消费 */
export const CHANNEL_DRAWER_STATE = '__PLITE_DRAWER_STATE__';

/** 抽屉变更事件（CustomEvent 名）：宿主/插件任一侧变更都派发,对侧监听同步。
 *  防环纪律:监听方同步自身状态时**不得**再派发(派发只发生在 setDrawer 入口)。 */
export const CHANNEL_DRAWER_EVENT = 'plite-drawer-changed';

/** 面板直达意图事件（CustomEvent 名）：插件请求把某槽位的激活面板切到指定 title。
 *  detail: { slot: SlotId, title: string }。消费方是宿主 SlotOutlet（按 title 匹配
 *  tab 并切换激活），派发方通常同时经 CHANNEL_DRAWER_STATE/EVENT 打开对应抽屉。 */
export const CHANNEL_PANEL_INTENT = 'plite-panel-intent';

/** real-engine 独立档直连配置操作桥：standalone-mode 面板调用（读/存/清除直连配置） */
export const CHANNEL_REAL_ENGINE_DIRECT = '__PLITE_REAL_ENGINE_DIRECT__';

/** 会话镜像存储键：chat-lite 独立档本地会话 ↔ mock-auth 会话状态共享（sessionStorage） */
export const KEY_MOCK_AUTH_SESSION = 'mock-auth.session.v1';

