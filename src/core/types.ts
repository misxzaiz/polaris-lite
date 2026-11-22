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

/**
 * Tab 条 chrome 贡献描述（host-slimming-report §7.2 契约扩展 / §4 P1-2）。
 *
 * 背景：多面板 tab 条（置顶/＋n 收纳/搜索/⟳ 刷新/roving 焦点）是「面板管理」的
 * 产品语义而非容器本职，此前长在核心 SlotOutlet 里（约 300 行 + 215 行 CSS）。
 * 经本贡献类型外移为插件组件：宿主保留激活态/置顶/刷新序号的**状态权威**
 * （防双头），把 tab 条的渲染权交给插件；无插件注册时回退内置简版 tab 条
 * （裸 tab 按钮，无 chrome——禁用 chrome 插件不破可用性）。
 *
 * 组件 props 契约（TabChromeProps）：宿主注入全部状态与回调，组件零自持状态。
 */
export interface TabChromeProps {
  /** 有序条目（已按用户顺序+置顶排好） */
  tabs: { key: string; title: string; pinned: boolean }[];
  /** 激活条目 key */
  activeKey: string;
  /** 选择（点击/键盘/菜单统一入口） */
  onSelect(key: string): void;
  /** 切换置顶 */
  onTogglePin(key: string): void;
  /** 刷新当前面板（宿主自持重挂载序号） */
  onRefresh(): void;
  /** 槽位 id（a11y 命名空间用） */
  slot: SlotId;
  /** tab body 的渲染由宿主完成；chrome 组件只渲染 tab 条本身 */
}

/**
 * 工作区布局树根容器契约（P2-2 workspace 抽出）：布局插件贡献 'layout-root' 容器组件,
 * 宿主壳层(SlotLayout)把「工作区主体区域」的渲染委托给它。props 由宿主注入:
 * - renderAnchor:宿主提供——布局树叶子遇到 host.slot.<anchor> 保留视图时,
 *   经此回调渲染该锚点的槽位内容(内部即 <SlotOutlet slot=anchor/>;布局插件不认识 SlotOutlet)。
 * 布局插件自持树/持久化/layoutCap 注册(grants 授权 cap.ui.layout)。
 * 无插件注册时宿主回退内置固定四槽(WorkspaceTree 时代之前的形态)。
 */
export interface LayoutRootProps {
  /** 渲染指定锚点的槽位内容(host.slot.* 保留视图的落地回调) */
  renderAnchor(anchor: AnchorId): ReactNode;
  /** 视图叶子解析:viewType → 插件组件(宿主 viewRegistry+externalPlugins 查表;查不到 undefined) */
  resolveView(viewType: string): React.ComponentType | undefined;
}

/**
 * 容器贡献描述：插件声明「我来渲染某类宿主 chrome」。
 * 当前支持的容器：'slot-tabs'（多面板 tab 条）。
 * 宿主按注册表查用；多个插件贡献同一容器时取 order 最小者（稳定可预期）。
 */
export interface ContainerDescriptor {
  /** 容器种类（受控枚举，按需扩展；layout-root = 工作区布局树宿主容器,P2-2） */
  container: 'slot-tabs' | 'layout-root';
  /** 插件内组件导出名（组件签名 = TabChromeProps） */
  component: string;
  /** 同类容器的优先级，小者优先 */
  order?: number;
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
    /** 宿主 chrome 容器（tab 条等;host-slimming-report §7.2） */
    containers?: ContainerDescriptor[];
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

import type { ReactNode } from 'react';

/** 会话消息（对话插件与引擎间的最小协议） */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: number;
  streaming?: boolean;
  /** 本轮回复收敛时刻（message.done / stream.error / 用户停止三路统一，由 settle() 落）。
   *  可选字段：旧快照无此值（UI 显示降级），durationMs = endedAt - createdAt。
   *  被中断的流同样有值（语义 = 「跑了多久被停」）。服务端/IndexedDB 均整对象透传。 */
  endedAt?: number;
}

// ---------- 对话消息模型（2026-11-21 自 chat-lite/store.ts 上移,host-slimming-report §2.6/P1-3） ----------
// 这是「引擎 → 编排层 → 对话 UI」之间的事实消息协议：此前只在 chat-lite 私有 store 里,
// 任何想替换对话 UI 的插件都必须抄这批类型。上移契约层后,替换 UI = 按公开契约编程。
// chat-lite 经 @sdk 引用同名类型(store.ts 保留 re-export 保持文件内引用兼容)。

/** 工具调用卡（参考 Polaris ToolCallBlock 的收敛版） */
export type ToolCardStatus = 'running' | 'done' | 'error' | 'denied' | 'awaiting' | 'resolved';

export interface ToolCardData {
  callId: string;
  name: string;
  command?: string;
  /** 模型给的原始参数 JSON（tool.card 透传）：ArgsBlock 折叠展示用 */
  argsJson?: string;
  status: ToolCardStatus;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  durationMs?: number;
  truncated?: boolean;
  decision?: 'once' | 'always' | 'trust' | 'deny';
}

/** role:'tool' 的消息形态（旧数据兼容；新编排输出改为 assistant.blocks 内嵌块） */
export interface ToolCardMessage {
  id: string;
  role: 'tool';
  content: string;
  createdAt: number;
  streaming?: boolean;
  tool: ToolCardData;
}

/** 交互卡数据（AI 发起 question/form/confirm，用户作答后回填） */
export interface InteractiveCardData {
  callId: string;
  kind: 'question' | 'form' | 'confirm';
  title: string;
  payload: Record<string, unknown>;
  answer?: Record<string, unknown>;
  status: 'awaiting' | 'answered';
}

/**
 * 通用产物块（第二个可视化插件起不再动对话 UI）：渲染器由产物插件经
 * CHANNEL_ARTIFACT_RENDERERS(@sdk) 登记（rendererType → 组件）。
 * data 是渲染器私有载荷（html-preview 存 previewId/url 等）。一次性落块，无回填流。
 */
export interface ArtifactCardData {
  callId: string;
  rendererType: string;
  title: string;
  status: 'ready' | 'error';
  data: Record<string, unknown>;
}

/** assistant 消息的内容块（Polaris ContentBlock 收敛版）：按事件到达序追加，保序交错 */
export type AsstBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool'; card: ToolCardData }
  | { type: 'interactive'; card: InteractiveCardData }
  | { type: 'artifact'; card: ArtifactCardData }
  /** 轻提示（自动续写进度等）：小字弱化样式，不参与正文镜像 */
  | { type: 'notice'; text: string }
  /** length 截断提示：带「继续」按钮（点击续开同一 assistant 消息，不新增用户消息） */
  | { type: 'truncated'; text: string };

export interface AssistantBlocks {
  blocks: AsstBlock[];
}

/**
 * 带 blocks 的 assistant 消息：核心 ChatMessage 的对话插件扩展。
 * 不能写成 `ChatMessage & AssistantBlocks` 去做类型守卫——role 联合不含 'tool'，
 * 与 ToolCardMessage 交叉会把 role 推断成 never。
 */
export type AssistantBlockMessage = ChatMessage & AssistantBlocks;

/** 会话消息统一形态（协议消息[可携 blocks] + 旧版独立工具卡） */
export type SessionStoreMessage = ChatMessage | ToolCardMessage | AssistantBlockMessage;

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
export type { AnchorId, WorkspaceNode, SplitNode, TabsNode, ViewLeaf, AnchorNode } from './workspace/schema';

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
  /** 浮层根容器（cap.ui.overlay 概念的宿主实现；构建门禁禁插件 CSS 用 position:fixed，
   *  宿主代为提供 fixed 锚点）。插件用 react-dom 的 createPortal(content, root) 渲染
   *  弹层/抽屉/toast——浮层锚定**视口**而非面板内容，移动端抽屉滚动时不再漂移。
   *  返回 null 表示根容器未就绪（调用方降级为原位渲染）。 */
  overlay: {
    root(): HTMLElement | null;
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
