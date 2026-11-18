/**
 * mock-engine 插件：AI 引擎插件（cap.ai.chat 的流式实现）。
 *
 * 验收修复：
 * - [P0 C-1] 能力注册改经 setup(api.registerCapability)，manifest 声明 provides:['cap.ai.chat']，
 *   宿主校验提供资格；main.tsx 不再代为注册。
 * - [P0 B-5] running map key 改为 sessionId::messageId，中断不再误伤同会话并发流。
 */
import type { CapabilityHandler, LitePlugin, SlotHostApi, StreamCapabilityHandler } from '@/core/types';

const running = new Map<string, () => void>(); // `${sessionId}::${messageId}` -> cancel

function makeReply(prompt: string): string {
  return `这是 polaris-lite 的流式回复（mock 引擎）。\n\n你刚才说：「${prompt}」。\n\n当前架构：核心只提供四槽布局与 cap 总线，对话 UI 由 chat-lite 插件提供，本回复由 mock-engine 插件经 cap.ai.chat 流式产生。真实引擎插件实现相同契约即可替换本插件。`;
}

export const mockEnginePlugin: LitePlugin = {
  manifest: {
    id: 'mock-engine',
    name: 'Mock AI 引擎',
    version: '0.1.0',
    capabilities: [],
    provides: ['cap.ai.chat', 'cap.ai.chat.interrupt'],
    contributes: { slots: [] },
  },
  setup(api: SlotHostApi) {    const streamHandler: StreamCapabilityHandler = async (req, emit) => {
      const payload = (req.payload ?? {}) as {
        sessionId?: string;
        messageId?: string;
        prompt?: string;
      };
      const sessionId = payload.sessionId ?? 'unknown';
      const messageId = payload.messageId ?? 'unknown';
      const prompt = payload.prompt ?? '';
      const streamKey = `${sessionId}::${messageId}`;

      const text = makeReply(prompt);
      let cancelled = false;
      running.set(streamKey, () => {
        cancelled = true;
      });

      try {
        // 模拟流式：按批推送（每批 8 字符、间隔 120ms）。
        // 后台标签页 setTimeout 会被浏览器节流，逐字符定时会拖长，故用批次。
        const chunk = 8;
        for (let i = 0; i < text.length; i += chunk) {
          if (cancelled) {
            emit({ kind: 'message.done', payload: { sessionId, messageId, interrupted: true } });
            return;
          }
          emit({
            kind: 'message.delta',
            payload: { sessionId, messageId, delta: text.slice(i, i + chunk) },
          });
          await new Promise((r) => setTimeout(r, 120));
        }
        emit({ kind: 'message.done', payload: { sessionId, messageId } });
      } finally {
        // 只清理自己的流：interrupt/自然完成/异常退出都保证 cancel 条目被移除
        running.delete(streamKey);
      }
    };

    const interruptHandler: CapabilityHandler = (req) => {
      const payload = (req.payload ?? {}) as { sessionId?: string; messageId?: string };
      if (payload.sessionId && payload.messageId) {
        // 精确中断：只停指定流
        running.get(`${payload.sessionId}::${payload.messageId}`)?.();
        return { ok: true, found: running.has(`${payload.sessionId}::${payload.messageId}`) };
      }
      if (payload.sessionId) {
        // 会话级中断：停该会话所有在途流
        let found = false;
        for (const key of [...running.keys()]) {
          if (key.startsWith(`${payload.sessionId}::`)) {
            running.get(key)?.();
            found = true;
          }
        }
        return { ok: true, found };
      }
      return { ok: false, found: false };
    };

    api.registerCapability.registerStreaming('cap.ai.chat', streamHandler);
    api.registerCapability.register('cap.ai.chat.interrupt', interruptHandler);
  },
};

export default mockEnginePlugin;
