/**
 * runnerTypes：runnerBridge 与 chat-lite 共用的流事件形状。
 *
 * 与 cap.agent.loop:event 的信封完全一致（spec：docs/agent-loop-plan.md §2.2）——
 * 服务端 agent-runner 产出的 SSE 事件直接以此形状消费，渲染层零改动。
 */

export interface StreamEnvelope {
  kind: string;
  payload?: {
    sessionId?: string;
    messageId?: string;
    delta?: string;
    message?: string;
    interrupted?: boolean;
    finishReason?: string;
    // 工具卡事件
    callId?: string;
    name?: string;
    command?: string;
    argsJson?: string;
    status?: 'done' | 'error' | 'denied';
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    durationMs?: number;
    truncated?: boolean;
    decision?: 'once' | 'always' | 'trust' | 'deny';
    autoRejected?: boolean;
    turns?: number;
    // 交互卡
    kind?: string;
    title?: string;
    options?: string[];
    fields?: unknown[];
    answer?: Record<string, unknown>;
    // 重试/续写
    attempt?: number;
    maxAttempts?: number;
    max?: number;
    chars?: number;
    reason?: string;
    /** 截断提示文本（message.truncated） */
    text?: string;
    /** message.done（length 截断）：聚合中被截断的半截工具调用数 */
    partialToolCalls?: number;
    // 上下文水位
    usedTokens?: number;
    window?: number;
    percent?: number;
    messages?: number;
    compacted?: boolean;
    exhausted?: boolean;
  };
  source?: string;
}
