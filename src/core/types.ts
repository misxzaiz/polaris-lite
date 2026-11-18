/**
 * polaris-lite 核心契约（S3 插槽容器）
 *
 * 核心只提供：四槽布局（sidebar/stream/input/panel）+ cap 总线 + 插件注册。
 * 所有业务（对话 UI、面板、AI 引擎）都是插件，经本契约挂载。
 * 契约对齐 Polaris：cap dispatch + 事件订阅 + 槽位贡献。
 */

/** 四个业务布局槽位 + auth 门禁槽（对应 Polaris 会话侧栏/消息流/输入区/面板区；auth 为登录门禁视图） */
export type SlotId = 'sidebar' | 'stream' | 'input' | 'panel' | 'auth';

export const SLOT_IDS: readonly SlotId[] = ['sidebar', 'stream', 'input', 'panel'];

/** cap.auth 契约常量（壳层只认这三个契约串，不认任何插件实现） */
export const CAP_AUTH = 'cap.auth';
export const SLOT_AUTH = 'auth';
export const EVENT_AUTH_CHANGED = 'auth-changed';

/** 登录态 */
export type AuthStatus = 'authenticated' | 'unauthenticated';

/** 登录用户信息（脱敏视图，token 全文永不进壳层） */
export interface AuthUser {
  id: string;
  name: string;
  /** 角色标识，供 check(permission) 使用；具体语义由权限插件定义 */
  roles: string[];
}

/** status / login 成功后的统一返回 */
export interface AuthStatusResult {
  status: AuthStatus;
  user: AuthUser | null;
  /** token 摘要（如 'ab12…cd34'），仅用于展示，不可反推原文 */
  tokenDigest?: string;
  /** 凭据过期时间戳（ms）；缺省 = 会话期有效 */
  expiresAt?: number;
}

/** login 请求载荷：凭据形态由插件自定义（账号密码 / OAuth code / SSO ticket…） */
export interface AuthLoginPayload {
  /** 约定字段：登录方式，缺省 'password'；SSO 插件可用 'sso' | 'oauth' 等 */
  method?: string;
  /** 其余字段自由扩展；mock-auth 使用 { username, password } */
  [field: string]: unknown;
}

/** check 请求/响应 */
export interface AuthCheckPayload {
  /** 权限点，如 'panel.model-admin' | 'chat.send'；语义由权限插件定义 */
  permission: string;
  /** 可选上下文（如目标资源 id），插件按需解释 */
  context?: Record<string, unknown>;
}
export interface AuthCheckResult {
  allowed: boolean;
  /** 拒绝原因（审计/提示用），允许时可省略 */
  reason?: string;
}

/** logout 响应 */
export interface AuthLogoutResult {
  ok: true;
}

/** 槽位贡献描述：插件声明自己要填哪个槽 */
export interface SlotDescriptor {
  slot: SlotId;
  /** 插件内组件导出名（插件模块需导出该名称的 React 组件） */
  component: string;
  order?: number;
  /**
   * 该块 UI 的**用户可见名**（多面板槽的 tab 文本），缺省回退 manifest.name。
   *
   * 为什么要与插件名分开：manifest.name 回答「插件是谁」，title 回答「这块 UI 是什么」，
   * 二者并不总是同一个东西——同一个插件可以向多个槽贡献语义不同的界面
   * （mock-auth 既提供登录页，也提供登录后的账号面板），单一插件名无法同时命名它们。
   */
  title?: string;
}

/**
 * 视图贡献描述：插件声明「我有哪些可被摆放的界面」。
 *
 * 与 `SlotDescriptor` 的区别：槽位贡献回答「填哪个固定位置」，视图贡献回答
 * 「可以被摆到任意位置」。工作区树里的叶子只引用 `viewType`，由宿主的视图注册表
 * 解析成组件——宿主因此不需要认识任何具体插件。
 */
export interface ViewDescriptor {
  /** 全局唯一，必须形如 `<manifest.id>.<local>` */
  viewType: string;
  /** 插件模块里的组件导出名 */
  component: string;
  /** 用户可见名（必填：无标题的控件无法拥有可访问名） */
  title: string;
  /** 打开时的默认落位锚点，缺省 'panel' */
  defaultAnchor?: AnchorId;
}

/** 插件 manifest（Polaris manifest 的瘦身版） */
export interface LiteManifest {
  id: string;
  name: string;
  version: string;
  /** 需要的 cap 权限（调用方声明），总线按此放行 dispatch */
  capabilities?: string[];
  /** 提供的 cap（提供方声明），registerCapability 时宿主校验提供资格 */
  provides?: string[];
  /** 声明要订阅/发射的宿主事件（如 'chat-event'），listen/emit 时校验 */
  events?: string[];
  /** 依赖的能力（如 'cap.model.admin'）：宿主据此决定插件装配顺序，缺失时告警 */
  requires?: string[];
  contributes?: {
    slots?: SlotDescriptor[];
    /** 可被工作区树摆放的视图（新契约；与 slots 并存，二者都由宿主统一渲染） */
    views?: ViewDescriptor[];
  };
}

/** cap 请求信封（对齐 Polaris router_dispatch） */
export interface CapRequest {
  target: string; // cap id，如 'cap.ai.chat'
  action: string; // 动作名，如 'start'
  payload?: unknown;
}

export interface CapResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

/** 流式事件（对齐 Polaris chat-event） */export interface StreamEvent {
  kind: string; // 'message.delta' | 'message.done' | 'status' | 'error' ...
  payload: unknown;
  seq: number;
  /** 事件来源插件 id（宿主注入），消费者可校验 */
  source?: string;
}

/** 会话消息（对话插件与引擎间的最小协议） */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: number;
  streaming?: boolean;
}

export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  // 注：待发队列（流式预输入）属于对话 UI 的实现细节，不放核心契约，
  // 由 chat-lite 自己的 store 持有（见 plugins/chat-lite/store.ts）。
}

import type { CapabilityHandler, StreamCapabilityHandler } from './bus';
import type { AnchorId, WorkspaceNode } from './workspace/schema';

export type { CapabilityHandler, StreamCapabilityHandler };

/** 视图落位方式：进已有 tab 组 / 向右拆 / 向下拆 */
export type LayoutPlacement = 'tab' | 'split-right' | 'split-bottom';

/**
 * 工作区布局能力（插件侧门面）。
 *
 * 所有方法都只是 `dispatch({ target: 'cap.ui.layout', ... })` 的薄包装——**权限校验、
 * 归属校验与审计都发生在总线里**，不在门面里。这是刻意设计：如果门面自己判断权限，
 * 就会出现第二条无审计的写入通道，这类「第二个入口」最终一定会绕过治理。
 *
 * 未获得 `cap.ui.layout` 授权时，`api.workspace` **整个字段不存在**（fail-closed）。
 * 不做「存在但调用报错」——插件会以为自己有布局权，写出依赖 getTree() 的代码后
 * 在别处崩掉，排查成本极高。
 */
export interface WorkspaceApi {
  open(
    viewType: string,
    opts?: { where?: LayoutPlacement; anchor?: AnchorId; allowMultiple?: boolean },
  ): Promise<CapResponse<{ id?: string }>>;
  close(nodeId: string): Promise<CapResponse>;
  split(nodeId: string, dir: 'row' | 'col', viewType: string): Promise<CapResponse<{ id?: string }>>;
  move(nodeId: string, tabsId: string, index: number): Promise<CapResponse>;
  /** 只读快照（深拷贝），插件拿不到内部引用 */
  getTree(): Promise<CapResponse<WorkspaceNode>>;
  listViews(): Promise<CapResponse<{ viewType: string; title: string; pluginId: string }[]>>;
  /** 整体替换布局（预设/透视）。需要 cap.ui.layout.global 授权 */
  applyTree(tree: WorkspaceNode): Promise<CapResponse>;
  /** 恢复默认布局。需要 cap.ui.layout.global 授权 */
  reset(): Promise<CapResponse>;
}

/** 受控能力注册器：插件只能在 setup 内经它注册 manifest.provides 声明过的能力 */
export type CapabilityRegistrar = {
  register(target: string, handler: CapabilityHandler): void;
  registerStreaming(target: string, handler: StreamCapabilityHandler): void;
};

/** 插件拿到宿主能力（替代 Polaris appCoreBridge 的 21-store 泄漏，只给最小门面） */
export interface SlotHostApi {
  /** cap 总线调用 */
  dispatch<T = unknown>(req: CapRequest): Promise<CapResponse<T>>;
  /** 订阅宿主事件总线（仅限 manifest.events 声明的事件名） */
  listen(event: string, handler: (payload: unknown) => void): () => void;
  /** 发射宿主事件（自动附加来源插件 id） */
  emit(event: string, payload: unknown): void;
  /** [提供方] 注册本插件提供的能力（仅限 manifest.provides 声明；仅 setup 内可用） */
  registerCapability: CapabilityRegistrar;
  /** [提供方] 注册总线级接口鉴权钩子（仅 manifest.provides 含 'cap.auth' 的插件可调用）。
   *  由宿主在 setup 期间同步接收，因此不存在「全局变量还没挂载」的时序窗口。 */
  registerAuthGuard?(guard: (req: CapRequest) => boolean | Promise<boolean>): void;
  /** 主题（预留） */
  theme: { mode: 'light' | 'dark'; setMode(mode: 'light' | 'dark'): void };
  /** i18n（预留，当前直返 key） */
  t(key: string): string;
  /** 布局能力：是否移动端（≤768px）与抽屉开关（手机端侧栏/面板抽屉化） */
  layout: {
    readonly isMobile: boolean;
    openDrawer(which: 'sidebar' | 'panel' | 'none'): void;
  };
  /** 工作区布局能力（需 cap.ui.layout 授权；未授权时该字段不存在） */
  workspace?: WorkspaceApi;
}

/** 插件模块导出形态 */
export interface LitePlugin {
  manifest: LiteManifest;
  /** 可选：插件启动钩子 */
  setup?(api: SlotHostApi): void | Promise<void>;
}
