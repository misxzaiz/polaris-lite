/**
 * cap 总线（核心唯一后端通道，对齐 Polaris RouterBus 思想）
 *
 * lite 版是进程内总线：权限 gate（按插件声明放行）→ 审计 → 转发给 capability 处理器。
 * 插件不得绕过总线直连其他插件的实现。
 *
 * 安全边界（验收 C 报告修复）：
 * - 注册侧收口：register/registerStreaming 仅可经 registerCapability 受控 API 调用，
 *   且宿主在 registerPlugin 时校验 manifest.provides 声明；裸 register* 为 internal。
 * - 流式事件定向投递：streamKey 纳入调用维度（callSeq），同 cap 并发流互不串扰；
 *   事件不再全量广播，消费者按需经 dispatchStream 的 onEvent 接收。
 */
import type { CapRequest, CapResponse, StreamEvent } from './types';

export type CapabilityHandler = (req: CapRequest) => Promise<unknown> | unknown;
export type StreamCapabilityHandler = (
  req: CapRequest,
  emit: (ev: Omit<StreamEvent, 'seq'>) => void,
) => Promise<void> | void;

interface Registered {
  handler: CapabilityHandler;
  streaming?: StreamCapabilityHandler;
  /** 提供方插件 id（由宿主在注册时注入，供事件来源溯源） */
  providerId?: string;
}

export interface AuditEntry {
  time: number;
  target: string;
  action: string;
  ok: boolean;
  pluginId: string;
  error?: string;
}

/** 接口级鉴权钩子（总线级 UserGuard）：每次受保护 dispatch 前调用，返回是否放行。
 *  由权限插件（cap.auth 提供方）经 hostRuntime.setAuthGuard 注册；
 *  未注册 = 不拦截（保持无 auth 插件时的可用性）。 */
export type AuthGuard = (req: CapRequest) => Promise<boolean> | boolean;

export class CapBus {
  private caps = new Map<string, Registered>();
  private audit: AuditEntry[] = [];
  private streamSubs = new Map<string, Set<(ev: StreamEvent) => void>>();
  private seq = 0;
  private callSeq = 0;
  private authGuard: AuthGuard | null = null;

  /** 注册接口级鉴权钩子（由 cap.auth 提供方经 hostRuntime.setAuthGuard 设置） */
  setAuthGuard(guard: AuthGuard): void {
    this.authGuard = guard;
  }

  /**
   * 免登录能力（严格最小集）：cap.auth（认证自身）、cap.meta（能力自省，无敏感数据）。
   * cap.config 不豁免——未登录读写任意命名空间属于 V2 漏洞（评审确认）。
   */
  private isPublicCap(target: string): boolean {
    return target === 'cap.auth' || target === 'cap.auth.interrupt' || target === 'cap.meta';
  }

  /**
   * [内部] 注册非流式能力。仅供宿主装配（registerCapability 包装）使用；
   * 插件必须经 SlotHostApi.registerCapability（受 manifest.provides 约束）。
   */
  register(target: string, handler: CapabilityHandler, providerId?: string): void {
    if (this.caps.has(target)) throw new Error(`cap ${target} already registered`);
    this.caps.set(target, { handler, providerId });
  }

  /**
   * [内部] 注册流式能力。同上，仅供宿主装配使用。
   */
  registerStreaming(target: string, handler: StreamCapabilityHandler, providerId?: string): void {
    if (this.caps.has(target)) throw new Error(`cap ${target} already registered`);
    this.caps.set(target, { handler: () => undefined, streaming: handler, providerId });
  }

  /** 该 cap 的提供方插件 id（事件来源溯源用：来源由宿主判定，插件无法伪造） */
  providerOf(target: string): string | undefined {
    return this.caps.get(target)?.providerId;
  }

  has(target: string): boolean {
    return this.caps.has(target);
  }

  /** 该 cap 是否注册为流式能力 */
  isStreaming(target: string): boolean {
    return this.caps.get(target)?.streaming !== undefined;
  }

  listCapabilities(): string[] {
    return [...this.caps.keys()].sort();
  }

  /** 权限 gate：插件声明的 capabilities 之外一律拒绝（默认拒绝） */
  assertAllowed(pluginId: string, declared: string[] | undefined, target: string): void {
    const allowed = declared ?? [];
    if (!allowed.includes(target)) {
      throw new Error(`plugin ${pluginId} is not granted ${target}`);
    }
  }

  async dispatch(pluginId: string, declared: string[] | undefined, req: CapRequest): Promise<CapResponse> {
    // meta 自省（describe/list）不入审计链：面板轮询会淹没真实调用记录（验收 C-5）
    const audit = !isReadonlySelfInspection(req);
    const entry = audit ? this.auditEntry(pluginId, req) : null;
    try {
      // 接口级鉴权（总线级 UserGuard）：未登录访问受保护 cap 直接拒绝
      if (this.authGuard && !this.isPublicCap(req.target)) {
        const allowed = await this.authGuard(req);
        if (!allowed) {
          throw new Error('未登录或权限不足（cap.auth 校验未通过）');
        }
      }
      this.assertAllowed(pluginId, declared, req.target);
      const reg = this.caps.get(req.target);
      if (!reg) throw new Error(`unknown cap: ${req.target}`);
      const data = await reg.handler(req);
      if (entry) entry.ok = true;
      return { ok: true, data };
    } catch (err) {
      if (entry) {
        entry.ok = false;
        entry.error = err instanceof Error ? err.message : String(err);
      }
      return {
        ok: false,
        error: { code: 'CAP_ERROR', message: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  /**
   * 流式调用：返回取消函数。
   * 事件经 onEvent 定向投递（streamKey 含调用序号），并同步镜像到可选的广播器
   * （宿主可将引擎事件转成 chat-event 供 UI 层消费——但订阅隔离由总线保证）。
   */
  dispatchStream(
    pluginId: string,
    declared: string[] | undefined,
    req: CapRequest,
    onEvent: (ev: StreamEvent) => void,
    broadcast?: (ev: Omit<StreamEvent, 'seq'>) => void,
  ): () => void {
    const sub = (ev: StreamEvent) => onEvent(ev);
    const key = streamKey(pluginId, req, ++this.callSeq);
    if (!this.streamSubs.has(key)) this.streamSubs.set(key, new Set());
    this.streamSubs.get(key)!.add(sub);

    (async () => {
      const entry = this.auditEntry(pluginId, req);
      try {
        // 接口级鉴权（与 dispatch 一致）
        if (this.authGuard && !this.isPublicCap(req.target)) {
          const allowed = await this.authGuard(req);
          if (!allowed) {
            throw new Error('未登录或权限不足（cap.auth 校验未通过）');
          }
        }
        this.assertAllowed(pluginId, declared, req.target);
        const reg = this.caps.get(req.target);
        if (!reg?.streaming) throw new Error(`unknown streaming cap: ${req.target}`);
        await reg.streaming(req, (ev) => {
          this.pushStream(key, ev);
          broadcast?.(ev);
        });
        entry.ok = true;
      } catch (err) {
        entry.ok = false;
        entry.error = err instanceof Error ? err.message : String(err);
        this.pushStream(key, {
          kind: 'stream.error',
          payload: { message: err instanceof Error ? err.message : String(err) },
        });
        broadcast?.({ kind: 'stream.error', payload: { message: err instanceof Error ? err.message : String(err) } });
      } finally {
        // 流生命周期结束即回收订阅槽：此前只增不删，每条消息泄漏一个 Set + 闭包
        this.streamSubs.delete(key);
      }
    })();

    return () => {
      this.streamSubs.get(key)?.delete(sub);
    };
  }

  private pushStream(key: string, ev: Omit<StreamEvent, 'seq'>): void {
    const full: StreamEvent = { ...ev, seq: ++this.seq };
    this.streamSubs.get(key)?.forEach((fn) => fn(full));
  }

  private auditEntry(pluginId: string, req: CapRequest): AuditEntry {
    const entry: AuditEntry = { time: Date.now(), target: req.target, action: req.action, ok: false, pluginId };
    this.audit.push(entry);
    if (this.audit.length > 500) this.audit.shift();
    return entry;
  }

  tailAudit(n = 20): AuditEntry[] {
    return this.audit.slice(-n);
  }

  /** 当前在途流订阅数（可观测性：>0 表示有未收敛的流，泄漏时下不来） */
  activeStreams(): number {
    return this.streamSubs.size;
  }
}

function streamKey(pluginId: string, req: CapRequest, callSeq: number): string {
  // 调用维度隔离：同插件同 cap 的并发流互不串扰（验收 B-1/B-5 根因修复）
  const streamId = (req.payload as { streamId?: string } | undefined)?.streamId;
  return streamId
    ? `${pluginId}::${req.target}::${req.action}::${streamId}`
    : `${pluginId}::${req.target}::${req.action}::#${callSeq}`;
}

function isReadonlySelfInspection(req: CapRequest): boolean {
  return req.target === 'cap.meta' && (req.action === 'describe' || req.action === 'list');
}
