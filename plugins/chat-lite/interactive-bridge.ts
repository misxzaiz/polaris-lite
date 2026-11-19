/**
 * interactive-bridge：chat-lite 与 interactive-cards 插件之间的解耦桥。
 *
 * chat-lite 的交互卡（InteractiveCard）不能直接 import interactive-cards 插件
 * （插件间禁止直依赖），因此通过 window 桥解耦：
 * - interactive-cards setup 时把 respondInteractive 挂到 window.__INTERACTIVE_RESPOND__；
 * - 本模块从 window 读取并调用；未挂载时返回 false（交互卡保持等待态）。
 */
export function respondInteractive(callId: string, answer: Record<string, unknown>): void {
  const bridge = (window as unknown as Record<string, unknown>).__INTERACTIVE_RESPOND__ as
    | ((callId: string, answer: Record<string, unknown>) => void)
    | undefined;
  if (typeof bridge === 'function') bridge(callId, answer);
}
