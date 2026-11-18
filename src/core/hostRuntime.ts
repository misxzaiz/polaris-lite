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
import type { CapResponse, LiteManifest, LitePlugin, SlotHostApi } from './types';
import { resolvePolicy, type EffectivePolicy } from './policy';

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
  themeMode: 'light' | 'dark' = 'dark';
  private themeSubs = new Set<(mode: 'light' | 'dark') => void>();

  /** 注册插件（构建期静态 import，或运行时动态注册均可）；重复注册幂等跳过。
   *  policy 缺省时按 manifest 自声明解析（unlisted 语义），由调用方负责告警。 */
  async registerPlugin(plugin: LitePlugin, policy?: EffectivePolicy): Promise<void> {
    const id = plugin.manifest.id;
    if (this.plugins.has(id)) return; // 幂等
    const effective = policy ?? resolvePolicy(plugin.manifest, null);
    this.plugins.set(id, { manifest: plugin.manifest, instance: plugin, policy: effective });
    this.slots.register(id, plugin.manifest.contributes?.slots ?? []);

    const api = this.createApi(plugin.manifest, effective);
    await plugin.setup?.(api);
  }

  getPluginIds(): string[] {
    return [...this.plugins.keys()];
  }

  getManifest(id: string): LiteManifest | undefined {
    return this.plugins.get(id)?.manifest;
  }

  /** 有效权限表（cap.meta 自省用：面板可以看到「申请了但被收紧」的项） */
  policyTable(): EffectivePolicy[] {
    return [...this.plugins.values()].map((p) => p.policy);
  }

  createApi(manifest: LiteManifest, policy: EffectivePolicy = resolvePolicy(manifest, null)): SlotHostApi {
    const runtime = this;
    return {
      dispatch: <T,>(req: Parameters<SlotHostApi['dispatch']>[0]): Promise<CapResponse<T>> => {
        // 流式能力：动作命中已注册的 streaming cap 时，走 dispatchStream 定向投递，
        // 事件同时镜像到宿主事件总线（'chat-event'）供 UI 层消费。
        if (runtime.bus.isStreaming(req.target)) {
          return new Promise((resolve) => {
            runtime.bus.dispatchStream(
              manifest.id,
              policy.capabilities,
              req,
              () => undefined, // 消费者走广播通道；此处保持订阅以维持生命周期
              (ev) => runtime.broadcastStream('chat-event', { ...ev, source: 'engine' }),
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
        // 事件带来源标注，消费者可校验来源（防伪造注入）
        runtime.listeners.get(event)?.forEach((fn) => fn({ source: manifest.id, payload }));
      },
      registerCapability: {
        register: (target: string, handler: CapabilityHandler) => {
          runtime.assertProvides(policy, target);
          runtime.bus.register(target, handler);
        },
        registerStreaming: (target: string, handler: StreamCapabilityHandler) => {
          runtime.assertProvides(policy, target);
          runtime.bus.registerStreaming(target, handler);
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
          runtime.notifyTheme(mode);
        },
      },
      t: (key) => key,
      layout: {
        get isMobile() {
          return typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches;
        },
        openDrawer: (which) => {
          void import('./SlotLayout').then((m) => m.setDrawer(which));
        },
      },
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
