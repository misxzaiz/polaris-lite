/**
 * 宿主运行时：装配总线、槽位表、插件生命周期，并产出 SlotHostApi。
 * 这是「核心」的单一权威——业务插件只与本文件提供的 API 交互。
 *
 * 安全边界（验收 C 报告修复）：
 * - registerCapability 仅放行 manifest.provides 声明过的 cap（P0：注册侧 gate）；
 * - listen 仅放行 manifest.events 声明过的事件名（P1：事件旁听收口）；
 * - emit 自动附加来源插件 id（P2：事件来源可校验）；
 * - 流式 dispatch 拒绝时返回 {ok:false}，与非流式语义一致（P1：C-2）。
 */
import { CapBus } from './bus';
import type { CapabilityHandler, StreamCapabilityHandler } from './bus';
import { SlotRegistry } from './slotRegistry';
import type { CapResponse, LiteManifest, LitePlugin, SlotHostApi, WorkspaceApi } from './types';
import { resolvePolicy, type EffectivePolicy } from './policy';
import { setDrawer } from './shellState';
import { t as translate } from './i18n';
import { THEME_COLORS } from './theme';
import { CAP_UI_LAYOUT, viewRegistry } from './workspace/contract';

interface RegisteredPlugin {
  manifest: LiteManifest;
  instance: LitePlugin;
  /** 宿主侧授权的有效权限（manifest ∩ grants.json），否则插件可自签能力 */
  policy: EffectivePolicy;
}

export class HostRuntime {
  readonly bus = new CapBus();
  readonly slots = new SlotRegistry();
  private plugins = new Map<string, RegisteredPlugin>();
  private listeners = new Map<string, Set<(payload: unknown) => void>>();
  /** 主题：启动时从 localStorage 恢复（默认浅色蓝白），并同步到 <html data-theme>，
   *  在 main.tsx 首帧渲染前完成，避免主题闪变 */
  themeMode: 'light' | 'dark' = HostRuntime.restoreTheme();
  private themeSubs = new Set<(mode: 'light' | 'dark') => void>();

  /** 读取持久化主题并应用到 DOM；非法值/无值均回退 'light'（白色为主） */
  private static restoreTheme(): 'light' | 'dark' {
    if (typeof document === 'undefined') return 'light';
    let mode: 'light' | 'dark' = 'light';
    try {
      const saved = window.localStorage.getItem(HostRuntime.THEME_KEY);
      if (saved === 'dark') mode = 'dark';
    } catch {
      /* localStorage 不可用（隐私模式等）→ 用默认主题 */
    }
    HostRuntime.applyTheme(mode);
    return mode;
  }

  /** 主题落地到 DOM：data-theme + 浏览器 UI 主题色（移动端地址栏跟随） */
  private static applyTheme(mode: 'light' | 'dark'): void {
    document.documentElement.dataset.theme = mode;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', THEME_COLORS[mode]);
  }

  private static readonly THEME_KEY = 'plite.theme';

  /** 视图声明被拒的记录（启动时由调用方展示，避免「插件没生效但没人知道」） */
  private viewWarnings: string[] = [];
  /** 插件装配健康位（false = 有插件加载失败;布局插件据此跳过孤儿视图折叠,P2-2） */
  private pluginLoadHealthy = true;

  /** 注册插件（构建期静态 import，或运行时动态注册均可）；重复注册幂等跳过。
   *  policy 缺省时按 manifest 自声明解析（unlisted 语义），由调用方负责告警。 */
  async registerPlugin(plugin: LitePlugin, policy?: EffectivePolicy): Promise<void> {
    const id = plugin.manifest.id;
    if (this.plugins.has(id)) return; // 幂等
    const effective = policy ?? resolvePolicy(plugin.manifest, null);
    this.plugins.set(id, { manifest: plugin.manifest, instance: plugin, policy: effective });
    this.slots.register(id, plugin.manifest.contributes?.slots ?? []);
    // 容器贡献（tab 条 chrome 等）走同一注册表;SlotOutlet 查用,无注册回退内置简版
    this.slots.registerContainers(id, plugin.manifest.contributes?.containers ?? []);

    // 视图声明走独立注册表（布局树只能引用注册过的 viewType）。
    // 注册失败必须可见：视图没登记时，插件声明的工作区会静默变成空壳。
    const views = viewRegistry.registerFromManifest(id, plugin.manifest.contributes?.views);
    for (const r of views.rejected) {
      this.viewWarnings.push(`插件 ${id} 的视图 ${r.viewType} 未被接受：${r.reason}`);
    }

    const api = this.createApi(plugin.manifest, effective);
    await plugin.setup?.(api);
  }

  getViewWarnings(): string[] {
    return [...this.viewWarnings];
  }

  getPluginIds(): string[] {
    return [...this.plugins.keys()];
  }

  getManifest(id: string): LiteManifest | undefined {
    return this.plugins.get(id)?.manifest;
  }

  /** 有效权限表（cap.meta 自省用：面板可以看到「申请了但被收紧」的项） */
  /** 装配健康位写入（main.tsx 在 loadExternalPlugins 后调用） */
  setPluginLoadHealth(ok: boolean): void {
    this.pluginLoadHealthy = ok;
  }

  get isPluginLoadHealthy(): boolean {
    return this.pluginLoadHealthy;
  }

  policyTable(): EffectivePolicy[] {
    return [...this.plugins.values()].map((p) => p.policy);
  }

  createApi(manifest: LiteManifest, policy: EffectivePolicy = resolvePolicy(manifest, null)): SlotHostApi {
    const runtime = this;
    const api: SlotHostApi = {
      dispatch: <T,>(req: Parameters<SlotHostApi['dispatch']>[0]): Promise<CapResponse<T>> => {
        // 流式能力：动作命中已注册的 streaming cap 时，走 dispatchStream 定向投递，
        // 事件同时镜像到宿主事件总线供 UI 层消费。
        // 事件名按「能力」命名（<target>:event，如 cap.ai.chat:event），来源由宿主取该 cap
        // 的提供方插件 id——插件无法伪造来源（此前硬编码 source:'engine'，任何流式插件都能冒充引擎）。
        if (runtime.bus.isStreaming(req.target)) {
          return new Promise((resolve) => {
            runtime.bus.dispatchStream(
              manifest.id,
              policy.capabilities,
              req,
              () => undefined, // 消费者走广播通道；此处保持订阅以维持生命周期
              (ev) => runtime.broadcastStream(`${req.target}:event`, {
                ...ev,
                source: runtime.bus.providerOf(req.target) ?? manifest.id,
                target: req.target,
              }),
            );
            // 流式调用的同步应答：立即返回 ok，结果经事件流送达
            resolve({ ok: true, data: undefined } as CapResponse<T>);
          });
        }
        return runtime.bus.dispatch(manifest.id, policy.capabilities, req) as Promise<CapResponse<T>>;
      },
      listen: (event, handler) => {
        // 事件订阅 gate：仅放行被授权的（manifest ∩ grants）事件名，默认拒绝
        const declared = policy.events;
        if (!declared.includes(event)) {
          throw new Error(`plugin ${manifest.id} is not granted event ${event}`);
        }
        if (!runtime.listeners.has(event)) runtime.listeners.set(event, new Set());
        runtime.listeners.get(event)!.add(handler);
        return () => {
          runtime.listeners.get(event)?.delete(handler);
        };
      },
      emit: (event, payload) => {
        // 发射侧同样收口：只允许 grants 授权的事件名（防止插件伪造不属于它的事件），
        // 并自动附加来源插件 id，消费者可校验来源。
        const declared = policy.events;
        if (!declared.includes(event)) {
          throw new Error(`plugin ${manifest.id} is not granted to emit event ${event}`);
        }
        runtime.listeners.get(event)?.forEach((fn) => fn({ source: manifest.id, payload }));
      },
      registerCapability: {
        register: (target: string, handler: CapabilityHandler) => {
          runtime.assertProvides(policy, target);
          runtime.bus.register(target, handler, policy.pluginId);
        },
        registerStreaming: (target: string, handler: StreamCapabilityHandler) => {
          runtime.assertProvides(policy, target);
          runtime.bus.registerStreaming(target, handler, policy.pluginId);
        },
      },
      registerAuthGuard: (guard) => {
        // 只有被授权提供 cap.auth 的插件才有资格安装接口级鉴权钩子（谁能认证，谁才能把门）
        runtime.assertProvides(policy, 'cap.auth');
        runtime.setAuthGuard(guard);
      },
      theme: {
        get mode() {
          return runtime.themeMode;
        },
        setMode: (mode) => {
          runtime.themeMode = mode;
          HostRuntime.applyTheme(mode);
          try {
            window.localStorage.setItem(HostRuntime.THEME_KEY, mode);
          } catch {
            /* 持久化失败不阻断切换（会话内仍生效） */
          }
          runtime.notifyTheme(mode);
        },
      },
      t: (key) => translate(key),
      layout: {
        get isMobile() {
          return typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches;
        },
        openDrawer: (which) => {
          setDrawer(which);
        },
      },
      overlay: {
        root: () => document.getElementById('plite-overlay-root'),
      },
    };

    // 布局能力 fail-closed：没有 cap.ui.layout 授权时该字段**不存在**（不是存在但报错）。
    // 「存在但报错」会让插件以为自己有权限，写出依赖 getTree() 的代码后在别处崩掉。
    if (policy.capabilities.includes(CAP_UI_LAYOUT)) {
      api.workspace = this.createWorkspaceApi(manifest.id, policy);
    }
    return api;
  }

  /** 布局门面：只做参数整形，权限/归属/审计全在总线的 cap.ui.layout 处理器里 */
  private createWorkspaceApi(pluginId: string, policy: EffectivePolicy): WorkspaceApi {
    const call = <T,>(action: string, payload?: unknown): Promise<CapResponse<T>> =>
      this.bus.dispatch(pluginId, policy.capabilities, { target: CAP_UI_LAYOUT, action, payload }) as Promise<
        CapResponse<T>
      >;

    return {
      open: (viewType, opts) => call('open', { viewType, ...opts }),
      close: (nodeId) => call('close', { nodeId }),
      split: (nodeId, dir, viewType) => call('split', { nodeId, dir, viewType }),
      move: (nodeId, tabsId, index) => call('move', { nodeId, tabsId, index }),
      getTree: () => call('getTree'),
      listViews: () => call('listViews'),
      applyTree: (tree) => call('applyTree', { tree }),
      reset: () => call('reset'),
    };
  }

  /** 提供方校验：插件只能注册被授权 provides 的 cap（manifest ∩ grants） */
  private assertProvides(policy: EffectivePolicy, target: string): void {
    if (!policy.provides.includes(target)) {
      throw new Error(`plugin ${policy.pluginId} is not declared to provide ${target}`);
    }
  }

  onThemeChange(fn: (mode: 'light' | 'dark') => void): () => void {
    this.themeSubs.add(fn);
    return () => {
      this.themeSubs.delete(fn);
    };
  }

  notifyTheme(mode: 'light' | 'dark'): void {
    this.themeSubs.forEach((fn) => fn(mode));
  }

  /** 流事件广播给所有订阅者（引擎插件 → 对话插件经总线中转） */
  broadcastStream(event: string, payload: unknown): void {
    this.listeners.get(event)?.forEach((fn) => fn(payload));
  }

  /** 核心内部订阅通道（不经 manifest.events 校验；调用方是核心自身，非插件） */
  subscribe(event: string, fn: (payload: unknown) => void): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn);
    return () => {
      this.listeners.get(event)?.delete(fn);
    };
  }

  /** 接口级鉴权钩子注册（由 cap.auth 提供方在 setup 内调用；总线每次受保护 dispatch 前回调） */
  setAuthGuard(guard: Parameters<CapBus['setAuthGuard']>[0]): void {
    this.bus.setAuthGuard(guard);
  }
}

/** 全局单例宿主 */
export const host = new HostRuntime();
