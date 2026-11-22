/**
 * sse：SSE 流读取循环 + tool_calls 分片聚合。
 *
 * 抽取自 real-engine 中继路径（codebuddy-engine 曾手抄同构代码 30 行，其注释自认）。
 * 纯逻辑：不持 reader（调用方喂 chunk），无 fetch，无引擎决策。
 */

/** 中继注入的上游断流错误帧（relay-core 对 text/event-stream 追加）：进入重试，不装正常结束 */
export function isUpstreamDisconnectFrame(json: unknown): boolean {
  return (
    typeof json === 'object' && json !== null &&
    'error' in json &&
    typeof (json as { error?: unknown }).error === 'object' && (json as { error?: unknown }).error !== null &&
    (json as { error?: { code?: unknown } }).error?.code === 'UPSTREAM_DISCONNECTED'
  );
}

/** 创建 SSE 读取器：管理半行缓冲与 [DONE] 标记；调用方逐 chunk 喂入 */
export function createSseReader(): {
  push(chunk: string): { data: string | null; done: boolean }[];
  sawDone: boolean;
  markDone(): void;
} {
  let buf = '';
  const state = { sawDone: false };
  return {
    sawDone: false,
    markDone() {
      state.sawDone = true;
      this.sawDone = true;
    },
    push(chunk: string) {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      const out: { data: string | null; done: boolean }[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (!data) continue;
        if (data === '[DONE]') {
          state.sawDone = true;
          this.sawDone = true;
          out.push({ data: null, done: true });
          continue;
        }
        out.push({ data, done: false });
      }
      return out;
    },
  };
}

/**
 * tool_calls 分片聚合：OpenAI 规范 delta.tool_calls 可能分片（index 维度拼接
 * id / function.name / function.arguments），也可能整块一次到齐（MOSI 实测）。
 * 每次尝试独立聚合——断流尝试的半截 tool_calls 不跨尝试拼接（协议不成对）。
 */
export function aggregateToolCallDelta(
  acc: Map<number, import('./types').ToolCallAgg>,
  toolCalls: unknown,
): void {
  if (!Array.isArray(toolCalls)) return;
  for (const tc of toolCalls as { index?: unknown; id?: unknown; function?: { name?: unknown; arguments?: unknown } }[]) {
    const idx = Number(tc?.index ?? 0);
    const slot = acc.get(idx) ?? { id: '', name: '', arguments: '' };
    if (tc.id) slot.id = slot.id || String(tc.id);
    if (tc.function?.name) slot.name += String(tc.function.name);
    if (tc.function?.arguments) slot.arguments += String(tc.function.arguments);
    acc.set(idx, slot);
  }
}
