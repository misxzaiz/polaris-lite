/**
 * interactive-cards 插件：结构化交互卡（对齐 Polaris ask_user_question / form / confirm）。
 *
 * 职责：
 * - cap.interactive.ask：AI 发起结构化交互（question 多选 / form 表单 / confirm 确认）；
 * - cap.interactive.respond：用户作答后回填，agent-loop 继续下一轮；
 * - 广播 interactive.created / interactive.answered 事件（chat-lite 渲染交互卡）。
 *
 * 纯插件：无服务端半边（状态存模块内存 + cap.config 持久化偏好）。
 */
import type { CapabilityHandler, LitePlugin, SlotHostApi } from '@sdk';

let hostApi: SlotHostApi | null = null;
/** 待应答的交互卡（callId → 描述）；用户作答后删除 */
const pending = new Map<string, { kind: string; title: string; payload: Record<string, unknown> }>();
/** 待回填的作答 resolver（callId → resolve） */
const pendingAnswers = new Map<string, (a: Record<string, unknown>) => void>();

export const interactiveCardsPlugin: LitePlugin = {
  manifest: {
    id: 'interactive-cards',
    name: '交互卡片',
    version: '0.1.0',
    capabilities: ['cap.config'],
    provides: ['cap.interactive'],
    events: ['tool-registered', 'interactive.created', 'interactive.answered'],
    contributes: { slots: [] },
  },
  setup(api: SlotHostApi) {
    hostApi = api;
    api.registerCapability.register('cap.interactive', createHandler());
    api.emit('tool-registered', { cap: 'cap.interactive', name: 'interactive' });
    // 供 chat-lite 的 InteractiveCard 调用（跨插件解耦桥）
    (window as unknown as Record<string, unknown>).__INTERACTIVE_RESPOND__ = respondInteractive;
  },
};

function createHandler(): CapabilityHandler {
  return async (req) => {
    const payload = (req.payload ?? {}) as Record<string, unknown>;
    switch (req.action) {
      case 'ask': {
        // AI 发起交互卡：question（多选）/ form（表单）/ confirm
        const kind = String(payload.kind ?? 'question');
        const title = String(payload.title ?? '请确认');
        const callId = `ia-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        pending.set(callId, { kind, title, payload });
        hostApi?.emit('interactive.created', { callId, kind, title, payload });
        // 等待用户作答（chat-lite 渲染交互卡后调 cap.interactive.respond）
        const answer = await new Promise<Record<string, unknown>>((resolve) => {
          pendingAnswers.set(callId, resolve);
          setTimeout(() => {
            if (pendingAnswers.has(callId)) {
              pendingAnswers.delete(callId);
              resolve({ __timeout: true });
            }
          }, 180_000);
        });
        pending.delete(callId);
        hostApi?.emit('interactive.answered', { callId, answer });
        return { ok: true, answer };
      }
      default:
        return { ok: false, error: `unknown action: ${req.action}` };
    }
  };
}

/** 用户作答回填（chat-lite 渲染交互卡后调用） */
export function respondInteractive(callId: string, answer: Record<string, unknown>): void {
  const resolve = pendingAnswers.get(callId);
  if (resolve) {
    pendingAnswers.delete(callId);
    resolve(answer);
    hostApi?.emit('interactive.answered', { callId, answer });
  }
}
