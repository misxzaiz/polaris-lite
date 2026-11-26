/**
 * 服务端适配器注册表：「引擎」与「工具」在服务端执行域的通用装配点。
 *
 * 这是宿主侧的**机制**（零业务）：只做「按 id 注册 / 按 id 查找」，
 * **不认识任何具体引擎名、工具名、厂商或端点**。引擎/工具插件在各自
 * server 半边的 createServerPart 里把适配器注册进来；agent-runner 只按
 * engineId / toolName 查表调用，自身零业务知识。
 *
 * 与前端 src/core/aiEngine.ts（cap.ai.chat.<id> 分派）对称——机制在宿主，
 * 行为在插件。宿主经 options.registry 注入所有 server 半边；适配器工厂在
 * createServerPart 调用期同步注册（同步、fail-fast，重复 id 直接抛）。
 */
export function createServerAdapterRegistry() {
  const engines = new Map();
  const tools = new Map();
  const toolPrefixes = new Map();
  const services = new Map();

  return {
    /**
     * 服务接口注册（跨插件读写的唯一合法通道，替代「直读别人的文件/sqlite」）。
     *
     * 与工具/引擎同一模式：机制在宿主，行为在插件。存储类插件（chat-store / kv-store）
     * 在自己的 server 半边把**领域操作**注册进来，消费方（agent-runner / transcript-share）
     * 按 id 取用，不认识对方的存储布局。换实现（文件→sqlite→远端）时消费方零改动。
     */
    registerService(id, impl) {
      if (typeof id !== 'string' || !id) throw new Error('service 必须有非空 id');
      if (!impl || typeof impl !== 'object') throw new Error(`service ${id} 必须提供实现对象`);
      if (services.has(id)) throw new Error(`重复的 service: ${id}`);
      services.set(id, impl);
    },
    getService(id) {
      return services.get(id) ?? null;
    },
    listServices() {
      return [...services.keys()];
    },

    registerEngine(adapter) {
      if (!adapter || typeof adapter.id !== 'string' || !adapter.id) {
        throw new Error('engine adapter 必须有非空 id');
      }
      if (engines.has(adapter.id)) throw new Error(`重复的 engine adapter: ${adapter.id}`);
      if (typeof adapter.runTurn !== 'function') {
        throw new Error(`engine adapter ${adapter.id} 缺少 runTurn()`);
      }
      engines.set(adapter.id, adapter);
    },
    getEngine(id) {
      return engines.get(id) ?? null;
    },
    defaultEngineId() {
      for (const [id, a] of engines) if (a.default) return id;
      return engines.keys().next().value ?? null;
    },
    listEngines() {
      return [...engines.entries()].map(([id, a]) => ({ id, kind: a.kind ?? 'chat', default: !!a.default }));
    },

    registerTool(adapter) {
      if (!adapter || typeof adapter.name !== 'string' || !adapter.name) {
        throw new Error('tool adapter 必须有非空 name');
      }
      if (tools.has(adapter.name)) throw new Error(`重复的 tool adapter: ${adapter.name}`);
      if (!adapter.descriptor?.function?.name || typeof adapter.invoke !== 'function') {
        throw new Error(`tool adapter ${adapter.name} 缺少 descriptor / invoke()`);
      }
      tools.set(adapter.name, adapter);
    },
    getTool(name) {
      if (tools.has(name)) return tools.get(name);
      // 前缀工具（如动态 MCP 工具 mcp__*）：仅精确名未命中时按最长前缀回落
      let best = null;
      let bestLen = -1;
      for (const [prefix, adapter] of toolPrefixes) {
        if (name.startsWith(prefix) && prefix.length > bestLen) { best = adapter; bestLen = prefix.length; }
      }
      return best;
    },
    registerToolPrefix(prefix, adapter) {
      if (typeof prefix !== 'string' || !prefix || typeof adapter?.invoke !== 'function') {
        throw new Error('registerToolPrefix 需要非空 prefix 与 invoke()');
      }
      toolPrefixes.set(prefix, adapter);
    },
    listTools() {
      return [...tools.values()];
    },
  };
}
