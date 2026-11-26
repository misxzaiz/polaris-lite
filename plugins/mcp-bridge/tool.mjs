/**
 * mcp-bridge 在服务端执行域的工具声明（mcp_ 前缀适配器 + 管理三连）。
 * 调用仍走本插件自己的 /api/mcp/*（stdio JSON-RPC 客户端池/门控原样生效）。
 */
const FEEDBACK_CAP = 8 * 1024;

export function registerMcpTools(registry) {
  registry.registerToolPrefix('mcp_', {
    descriptor: null, // 动态工具，描述由 runner 的 ensureMcpTools 注入
    async invoke({ name, args, signal, host }) {
      if (name === 'mcp_server_list') {
        const r = await host.get('/api/mcp/servers', signal);
        return { ok: r.ok, stdout: JSON.stringify(r.json ?? {}).slice(0, FEEDBACK_CAP), stderr: r.ok ? '' : `HTTP ${r.status}` };
      }
      if (name === 'mcp_server_add' || name === 'mcp_server_remove') {
        const r = await host.callEndpoint(name === 'mcp_server_add' ? '/api/mcp/servers' : '/api/mcp/servers/remove', args, signal);
        return { ok: r.ok, stdout: JSON.stringify(r.json ?? {}).slice(0, FEEDBACK_CAP), stderr: r.ok ? '' : `HTTP ${r.status}` };
      }
      const r = await host.callEndpoint('/api/mcp/call', { name, arguments: args }, signal);
      const j = r.json ?? {};
      const ok = r.ok && j.ok !== false;
      return { ok, stdout: ok ? String(j.stdout ?? JSON.stringify(j).slice(0, FEEDBACK_CAP)) : '', stderr: ok ? '' : String(j.error ?? `HTTP ${r.status}`) };
    },
  });
}
