/**
 * AI 引擎基础设施：能力注册表 + 通用分派器（核心零业务的「协议层」）。
 *
 * 这里只认识三件事：
 * 1. `cap.ai.chat.<engineId>` 这种命名约定；
 * 2. payload 里的 `engineId` 字段；
 * 3. manifest 里声明的 `aiEngine` 元数据形状。
 *
 * 它**不认识任何具体引擎、厂商、模型或协议**——引擎之间的差异（适配应用供应商 /
 * 自带凭据 / 混合 / CLI 等其它协议）全部留在引擎插件内部。因此新增一个引擎 =
 * 新增一个插件 + 声明元数据 + 注册自己的 namespaced cap，宿主与消费方零改动。
 *
 * 为什么分派器在核心而不是插件：总线对同名 cap 是单注册位（bus.register 重复即抛），
 * 且 assertAllowed 是精确匹配。让核心持有唯一的 `cap.ai.chat` 并按 id 转发，
 * 既保持单注册语义不被撕开，又不必给消费方开放 `cap.ai.chat.*` 通配授权。
 */
import type { CapBus } from './bus';
import type { CapResponse } from './types';
import type { AiEngineInfo, AiEngineMetadata, AiEngineModel, LiteManifest } from './types';

export const CAP_AI_ENGINE = 'cap.ai.engine';
export const CAP_AI_CHAT = 'cap.ai.chat';
export const CAP_AI_CHAT_INTERRUPT = 'cap.ai.chat.interrupt';

const CHAT_PREFIX = 'cap.ai.chat.';
const MODELS_SUFFIX = '.models';
const INTERRUPT_SUFFIX = '.interrupt';
/** 核心作为调用方时使用的身份；仅用于内部 dispatch 的审计记录 */
const CORE_CALLER = 'core';

export function chatCap(engineId: string): string {
  return CHAT_PREFIX + engineId;
}
export function interruptCap(engineId: string): string {
  return chatCap(engineId) + INTERRUPT_SUFFIX;
}
export function modelsCap(engineId: string): string {
  return chatCap(engineId) + MODELS_SUFFIX;
}

/**
 * 安装引擎基础设施。必须在插件装配前调用（与 installMetaCapability 同位置）。
 * getManifests 延迟求值：插件 setup 完成后才能看到引擎声明，故不能在调用时快照。
 */
export function installAiEngineInfrastructure(
  bus: CapBus,
  getManifests: () => (LiteManifest | undefined)[],
): void {
  let routerSeq = 0;

  /** 核心内部调用：枚举当前所有已注册 cap 作为授权集合（动态，新增引擎无需改这里） */
  const coreCall = <T,>(req: { target: string; action: string; payload?: unknown }): Promise<CapResponse<T>> =>
    bus.dispatch(CORE_CALLER, bus.listCapabilities(), req) as Promise<CapResponse<T>>;

  const configs = (): AiEngineMetadata[] =>
    getManifests()
      .map((m) => m?.aiEngine)
      .filter((m): m is AiEngineMetadata => !!m);

  /** 元数据 + 动态目录自省。动态 cap（`cap.ai.chat.<id>.models`）由引擎自己实现，
   *  例如 CLI 引擎的模型清单随版本变化；没有该 cap 时用 manifest 静态声明。 */
  const resolveInfo = async (meta: AiEngineMetadata): Promise<AiEngineInfo> => {
    let models: AiEngineModel[] = meta.models ?? [];
    let available = true;
    const mc = modelsCap(meta.id);
    if (bus.has(mc)) {
      const res = await coreCall<{ models?: AiEngineModel[]; available?: boolean }>({ target: mc, action: 'list' });
      if (res.ok && res.data) {
        models = Array.isArray(res.data.models) ? res.data.models : [];
        available = res.data.available !== false;
      } else {
        available = false;
      }
    }
    return { ...meta, models, available };
  };

  // ---- cap.ai.engine：只读自省（list / describe / models）----
  bus.register(
    CAP_AI_ENGINE,
    async (req) => {
      if (req.action === 'list') {
        const engines: AiEngineInfo[] = [];
        for (const meta of configs()) engines.push(await resolveInfo(meta));
        return { engines, defaultEngineId: configs().find((m) => m.default)?.id ?? configs()[0]?.id };
      }
      const engineId = (req.payload as { engineId?: string } | undefined)?.engineId;
      const meta = configs().find((m) => m.id === engineId);
      if (!meta) return req.action === 'models' ? { models: [], available: false } : { engine: null };
      const info = await resolveInfo(meta);
      return req.action === 'models'
        ? { models: info.models, available: info.available }
        : { engine: info };
    },
    CORE_CALLER,
  );

  /** engineId 选择：显式 > manifest 标 default > 第一个注册引擎。核心不认识具体 id。 */
  const pickEngineId = (payload: unknown): string | undefined => {
    const explicit = (payload as { engineId?: string } | undefined)?.engineId;
    if (typeof explicit === 'string' && explicit) return explicit;
    const all = configs();
    return all.find((m) => m.default)?.id ?? all[0]?.id;
  };

  // ---- cap.ai.chat：唯一的流式公共通道，按 engineId 转发到 namespaced cap ----
  bus.registerStreaming(
    CAP_AI_CHAT,
    async (req, emit) => {
      const engineId = pickEngineId(req.payload);
      if (!engineId) {
        emit({ kind: 'stream.error', payload: { message: '没有可用的 AI 引擎插件' } });
        return;
      }
      const target = chatCap(engineId);
      if (!bus.isStreaming(target)) {
        emit({ kind: 'stream.error', payload: { message: `AI 引擎 ${engineId} 未注册（缺少 ${target}）`, engineId } });
        return;
      }
      const payload: Record<string, unknown> = {
        ...((req.payload as Record<string, unknown> | undefined) ?? {}),
        engineId,
      };
      // 并发隔离：不覆盖调用方自带的 streamId（它可能有对账语义），缺省补唯一值
      routerSeq += 1;
      if (!payload.streamId) payload.streamId = `router-${routerSeq}`;
      await bus.dispatchStream(
        CORE_CALLER,
        bus.listCapabilities(),
        { target, action: req.action, payload },
        (ev) => {
          emit({
            kind: ev.kind,
            // 把 engineId 注入事件载荷，旁听方无需认识目标 cap 即可标注来源
            payload: { ...((ev.payload as Record<string, unknown> | undefined) ?? {}), engineId },
          });
        },
      );
    },
    CORE_CALLER,
  );

  // ---- cap.ai.chat.interrupt：指定 engineId 则单点中断；缺省扇出到所有引擎 ----
  // 扇出是安全的：每个引擎的 interrupt 都按 sessionId 查自己的 running 表，无流即 found=false。
  bus.register(
    CAP_AI_CHAT_INTERRUPT,
    async (req) => {
      const payload = (req.payload ?? {}) as { engineId?: string };
      const ids = typeof payload.engineId === 'string' && payload.engineId
        ? [payload.engineId]
        : configs().map((m) => m.id);
      let found = false;
      for (const id of ids) {
        const target = interruptCap(id);
        if (!bus.has(target)) continue;
        const res = await coreCall<{ found?: boolean }>({ target, action: req.action, payload });
        if (res.ok && res.data?.found) found = true;
      }
      return { ok: true, found };
    },
    CORE_CALLER,
  );
}
