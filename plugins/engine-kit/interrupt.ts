/**
 * interrupt：运行中流的中断注册表（Map<streamKey, abort> 模式的工厂）。
 *
 * 抽取自 real-engine / codebuddy-engine 各自手写一遍的 running map。
 * streamKey 约定：`<sessionId>::<messageId>`（与两引擎现状一致）。
 */

export function createInterruptMap() {
  const running = new Map<string, () => void>();
  return {
    set(key: string, abort: () => void) {
      running.set(key, abort);
    },
    get(key: string) {
      return running.get(key);
    },
    delete(key: string) {
      running.delete(key);
    },
    keys() {
      return [...running.keys()];
    },
    /** 按会话中断全部流（streamKey 前缀 `<sessionId>::`） */
    abortSession(sessionId: string) {
      const prefix = `${sessionId}::`;
      for (const key of [...running.keys()]) {
        if (key.startsWith(prefix)) running.get(key)?.();
      }
    },
  };
}
