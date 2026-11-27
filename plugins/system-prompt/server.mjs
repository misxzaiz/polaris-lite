/**
 * system-prompt 插件的服务端半边。
 *
 * 职责：把「按 sessionId 读自定义提示词」注册进 adapter-registry 的 service 表
 * （id='system-prompt'），供 agent-runner 的 seedShadow 消费（追加进 system prompt）。
 *
 * 存储复用 kv-store 的 service（id='kv-store'）——与 agent-runner 的 ledger 适配器
 * 同款模式：不自建 sqlite、不复制表结构，存储布局唯一权威在 kv-store 插件。
 * kv 键约定（与 UI 半边一致）：
 *   namespace='system-prompt'，key='global'（全局基底）、key=`session.<sessionId>`
 *   （会话覆盖段），value=字符串提示词。
 *
 * 组合策略：get(sessionId) 返回「全局段 + 会话段」的拼接结果（任一为空则只返回
 * 另一段；均空返回 null）——组合逻辑收敛在插件内，宿主（agent-runner）只消费
 * 单一字符串，不感知层级。
 *
 * 无自有 HTTP 路由：UI 半边经 cap.kv（kv-store 的 /api/kv/*）读写；本半边只提供
 * server 进程内的同步读取。删除本文件时宿主照常启动，只是提示词注入失效（UI 仍可存取）。
 */
export function createServerPart(options = {}) {
  const registry = options.registry;

  if (registry?.registerService && !registry.getService?.('system-prompt')) {
    registry.registerService('system-prompt', {
      /**
       * 读组合提示词（全局基底 + 会话段），两者皆未设置返回 null（调用方静默跳过）。
       * 拼接顺序：全局在前、会话在后——会话段是全局段的细化/覆盖语境。
       * 同步接口：seedShadow 在异步段调用，但 kv 是进程内 sqlite，微秒级，
       * 不构成阻塞点（与 agent-runner readKvSync 同款判断）。
       */
      get(sessionId) {
        try {
          const kv = registry.getService('kv-store');
          const read = (key) => {
            const v = kv?.get?.('system-prompt', key) ?? null;
            return typeof v === 'string' && v.trim() ? v.trim() : null;
          };
          const global = read('global');
          const session = read(`session.${String(sessionId ?? '')}`);
          const parts = [global, session].filter(Boolean);
          return parts.length > 0 ? parts.join('\n\n') : null;
        } catch {
          return null;
        }
      },
    });
  }

  return function systemPromptServer(_req, _res, next) {
    return next?.();
  };
}
