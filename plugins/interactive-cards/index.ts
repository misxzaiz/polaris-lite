/**
 * interactive-cards 插件：结构化交互卡（对齐 Polaris ask_user_question / form / confirm）。
 *
 * 职责：
 * - cap.interactive.ask：AI 发起结构化交互（question 多选 / form 表单 / confirm 确认）；
 * - cap.interactive.respond：用户作答后回填，agent-loop 继续下一轮；
 * - cap.interactive.describe：向 agent-loop 提供工具描述（与 agent-bash 同一发现约定，
 *   只是不用 cap.tool.* 前缀——interactive 是低敏交互能力，硬蹭 execute 前缀语义反而错位）；
 * - 广播 interactive.created / interactive.answered 事件（chat-lite 渲染交互卡）。
 *
 * 事件契约：ask 的 payload 若带 sessionId/messageId（agent-loop 透传），created/answered
 * 事件原样携带——chat-lite 按「会话+消息」双重过滤，与流式事件同一防串台纪律。
 *
 * 纯插件：无服务端半边（状态存模块内存 + cap.config 持久化偏好）。
 */
import { CHANNEL_INTERACTIVE_RESPOND, type CapabilityHandler, type LitePlugin, type SlotHostApi } from '@sdk';

/** 交互卡等待上限：与 agent-loop 审批同量级（超时返回 __timeout，模型自行改口） */
const ASK_TIMEOUT_MS = 180_000;

let hostApi: SlotHostApi | null = null;
/** 待应答的交互卡（callId → 描述）；用户作答后删除 */
const pending = new Map<string, { kind: string; title: string; payload: Record<string, unknown>; replyCtx?: { sessionId?: string; messageId?: string } }>();
/** 待回填的作答 resolver（callId → resolve） */
const pendingAnswers = new Map<string, (a: Record<string, unknown>) => void>();

/** 工具描述（agent-loop discoverTools 经 describe 拉取） */
const DESCRIPTOR = {
  cap: 'cap.interactive',
  name: 'interactive',
  description:
    '向用户发起结构化交互并等待作答。当你缺少必要信息（偏好、参数、确认）时用本工具直接问，' +
    '不要靠开放式文本猜。三种 kind：question（title + options 选项列表，用户单选或自定义输入）、' +
    'form（title + fields 字段数组，每项 {name,label}，收集多字段）、confirm（title，是/否确认）。' +
    '用户可以跳过作答（跳过或超时都会以提示返回，请基于已有信息继续，不要空等或重复提问）。' +
    '作答以 JSON 返回（如 {"selected":"...","customInput":"..."} 或 {"confirmed":true}），' +
    `用户 ${ASK_TIMEOUT_MS / 1000}s 未作答则返回 {"__timeout":true}——此时应改用已有信息继续或明确说明等待。`,
  parameters: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['question', 'form', 'confirm'], description: '交互形态' },
      title: { type: 'string', description: '问题/表单/确认的标题（给用户看的一句话）' },
      options: { type: 'array', items: { type: 'string' }, description: 'question 的候选选项' },
      fields: {
        type: 'array',
        items: { type: 'object', properties: { name: { type: 'string' }, label: { type: 'string' } } },
        description: 'form 的字段列表',
      },
    },
    required: ['kind', 'title'],
  },
  danger: 'read' as const,
};

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
    api.emit('tool-registered', { cap: 'cap.interactive', name: DESCRIPTOR.name });
    // 供 chat-lite 的 InteractiveCard 调用（跨插件解耦桥）
    (window as unknown as Record<string, unknown>)[CHANNEL_INTERACTIVE_RESPOND] = respondInteractive;
  },
};

function createHandler(): CapabilityHandler {
  return async (req) => {
    const payload = (req.payload ?? {}) as Record<string, unknown>;
    switch (req.action) {
      case 'describe':
        return { descriptor: DESCRIPTOR };
      case 'ask': {
        // AI 发起交互卡：question（多选）/ form（表单）/ confirm（确认）
        const kind = String(payload.kind ?? 'question');
        const title = String(payload.title ?? '请确认');
        const callId = `ia-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        // sessionId/messageId 透传：chat-lite 按会话+消息双重过滤落块（防并发串台）
        const replyCtx = {
          ...(payload.sessionId ? { sessionId: String(payload.sessionId) } : {}),
          ...(payload.messageId ? { messageId: String(payload.messageId) } : {}),
        };
        pending.set(callId, { kind, title, payload, replyCtx });
        hostApi?.emit('interactive.created', { callId, kind, title, payload, ...replyCtx });
        // 等待用户作答（chat-lite 渲染交互卡后经 window 桥调 respondInteractive）
        const answer = await new Promise<Record<string, unknown>>((resolve) => {
          pendingAnswers.set(callId, resolve);
          setTimeout(() => {
            if (pendingAnswers.has(callId)) {
              pendingAnswers.delete(callId);
              // 超时也补 answered 回执：否则分享转录/取证里这张卡永远 status=awaiting，
              // 复盘「AI 为什么自问自答」时看不到用户侧超时这一事实。
              const desc = pending.get(callId);
              hostApi?.emit('interactive.answered', {
                callId,
                answer: { __timeout: true },
                ...(desc ? { kind: desc.kind, title: desc.title, ...desc.replyCtx } : {}),
              });
              resolve({ __timeout: true });
            }
          }, ASK_TIMEOUT_MS);
        });
        pending.delete(callId);
        // answered 事件在 respondInteractive 出口统一 emit（单一出口，防双发）
        return { ok: true, answer };
      }
      default:
        return { ok: false, error: `unknown action: ${req.action}` };
    }
  };
}

/** 用户作答回填（chat-lite 渲染交互卡后调用）——answered 事件的唯一出口 */
export function respondInteractive(callId: string, answer: Record<string, unknown>): void {
  const resolve = pendingAnswers.get(callId);
  if (!resolve) return;
  const desc = pending.get(callId);
  pendingAnswers.delete(callId);
  pending.delete(callId);
  resolve(answer);
  hostApi?.emit('interactive.answered', {
    callId,
    answer,
    ...(desc ? { kind: desc.kind, title: desc.title, ...desc.replyCtx } : {}),
  });
}

export default interactiveCardsPlugin;
