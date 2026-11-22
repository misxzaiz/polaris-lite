/**
 * mcp-bridge 插件：MCP（Model Context Protocol）server 接入。
 *
 * 职责（plans/extension-capability-pure-plugin-plan.md §2.1）：
 * 1. cap.tool.mcp（聚合工具 cap）：describe 返回 {descriptors:[...]}（全部 MCP 工具，
 *    命名 mcp__<server>__<tool>）；exec 按 name 路由到对应 server 的 tools/call。
 *    agent-loop A1 已兼容聚合数组形态。
 * 2. cap.tool.mcp-ops（AI 自建通道，runtime-extensions-and-market-final.md P1.1）：
 *    describe 同样返回聚合数组（mcp_server_add/remove/list 三个管理工具，danger='execute'
 *    走 agent-loop 审批链）——AI 可在会话里登记/移除 MCP server；写完广播 tool-registered，
 *    agent-loop 与 MCP 面板即时跟进（本轮消息的工具集不变，下一条消息可用）。
 * 3. cap.mcp.admin：管理面（list/add/remove/gate），供面板/设置使用。
 * 4. server 半边：MCP client 池（stdio NDJSON JSON-RPC 2.0，协议 2024-11-05）+
 *    配置仓库（<dataDir>/mcp-servers.json 原生格式，唯一写目标）+ /api/mcp/* 管理端点。
 *
 * 配置来源：原生 <dataDir>/mcp-servers.json 为权威；外部格式（.mcp.json 等）由
 * zcode-compat 插件负责发现并「固化导入」到原生文件——本插件只吃原生格式。
 *
 * 安全模型：PLITE_MCP=0 一键禁用；server 启动/调用全量审计（mcp-audit.log）；
 * per-tool 门控存 cap.kv（namespace 'mcp-bridge'）；mcp_server_add/remove 是危险操作，
 * exec 内部复用 /api/mcp/servers 的服务端校验（name 合法性/command 字符串/绝对路径存在性）。
 */
import type { CapabilityHandler, LitePlugin, SlotHostApi } from '@sdk';
import { McpPanel, setMcpPanelApi } from './Panel';
import './panel.css';

interface McpToolDescriptor {
  cap: string;
  name: string;
  description: string;
  parameters: unknown;
  danger: 'read' | 'write' | 'execute';
}

const MCP_OPS_DESCRIPTORS: McpToolDescriptor[] = [
  {
    cap: 'cap.tool.mcp-ops',
    name: 'mcp_server_add',
    description:
      '登记一个 MCP server（stdio）。写入后立即生效：下一轮对话其工具（mcp__<server>__<tool>）即可用。' +
      '危险操作需用户审批。command 须为可执行命令（如 node），args 为字符串数组。' +
      '调用示例：{"name":"my-server","command":"node","args":["D:/path/to/server.cjs"]}——name 必填且只能字母数字_-；args 必须含脚本绝对路径。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'server 名（仅字母数字_-，将出现在工具名 mcp__<name>__* 中）' },
        command: { type: 'string', description: '启动命令（如 node / npx）' },
        args: { type: 'array', items: { type: 'string' }, description: '命令参数数组' },
      },
      required: ['name', 'command'],
    },
    danger: 'execute',
  },
  {
    cap: 'cap.tool.mcp-ops',
    name: 'mcp_server_remove',
    description: '移除一个已登记的 MCP server（其工具随下轮对话消失）。危险操作需用户审批。',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: '要移除的 server 名' } },
      required: ['name'],
    },
    danger: 'execute',
  },
  {
    cap: 'cap.tool.mcp-ops',
    name: 'mcp_server_list',
    description: '列出当前已登记的 MCP server（名称/命令/启用状态/来源）。',
    parameters: { type: 'object', properties: {} },
    danger: 'read',
  },
];

/** 变更后广播 tool-registered：agent-loop 立即重扫工具表，MCP 面板开着也即时跟进。
 *  emit 失败（权限/总线异常）绝不能让已成功的写入动作被误报为失败。 */
function emitToolsChanged(api: SlotHostApi, name: string, op: 'add' | 'remove' | 'gate'): void {
  try {
    api.emit('tool-registered', { cap: 'cap.tool.mcp', name, op });
  } catch { /* 事件未授权/总线异常：写入已落盘，忽略广播失败 */ }
}

function createMcpOpsHandler(api: SlotHostApi): CapabilityHandler {
  return async (req) => {
    const payload = (req.payload ?? {}) as Record<string, unknown>;
    try {
      if (req.action === 'describe') {
        try { localStorage.setItem('mcp-debug-ops-describe', new Date().toISOString()); } catch { /* 忽略 */ }
        return { descriptors: MCP_OPS_DESCRIPTORS };
      }
      if (req.action === 'exec') {
        // agent-loop 通用 exec 会把被调工具名放进 __tool（聚合 cap 的分发标记）。
        // 模型按各工具的 parameters 传参：add/remove 的 name 是 server 名。
        const op = String(payload.__tool ?? '');
        if (op === 'mcp_server_add') {
          const resp = await fetch('/api/mcp/servers', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: payload.name,
              command: payload.command,
              args: payload.args,
              enabled: true,
            }),
          });
          const j = (await resp.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
          if (!resp.ok || !j?.ok) return { ok: false, error: j?.error ?? `HTTP ${resp.status}` };
          emitToolsChanged(api, String(payload.name ?? ''), 'add');
          return { ok: true, stdout: `[已登记 MCP server ${String(payload.name)}] 其工具将在下一轮对话中可用。`, exitCode: 0 };
        }
        if (op === 'mcp_server_remove') {
          const resp = await fetch('/api/mcp/servers/remove', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: payload.name }),
          });
          const j = (await resp.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
          if (!resp.ok || !j?.ok) return { ok: false, error: j?.error ?? `HTTP ${resp.status}` };
          emitToolsChanged(api, String(payload.name ?? ''), 'remove');
          return { ok: true, stdout: `[已移除 MCP server ${String(payload.name)}]`, exitCode: 0 };
        }
        if (op === 'mcp_server_list') {
          const resp = await fetch('/api/mcp/active', { credentials: 'include' });
          const j = (await resp.json().catch(() => null)) as { mcpServers?: { server_name: string; command: string; args: string[] }[] } | null;
          const lines = (j?.mcpServers ?? []).map((s) => `- ${s.server_name}: ${s.command} ${s.args.join(' ')}`);
          return { ok: true, stdout: lines.length ? lines.join('\n') : '（无已启用的 MCP server）', exitCode: 0 };
        }
        return { ok: false, error: `未知操作: ${op || '(缺 __tool)'}` };
      }
      return { ok: false, error: `unknown action: ${req.action}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };
}

function createMcpToolHandler(): CapabilityHandler {
  return async (req) => {
    if (req.action === 'describe') {
      try {
        const resp = await fetch('/api/mcp/tools', { credentials: 'include' });
        const j = (await resp.json().catch(() => null)) as { tools?: McpToolDescriptor[] } | null;
        // 临时诊断：定位 mcp__ 工具未进模型工具表的问题（验证后移除）
        try { localStorage.setItem('mcp-debug-describe', JSON.stringify({ at: new Date().toISOString(), status: resp.status, names: (j?.tools ?? []).map(t => t.name) })); } catch { /* 忽略 */ }
        return { descriptors: j?.tools ?? [] };
      } catch (e) {
        try { localStorage.setItem('mcp-debug-describe', JSON.stringify({ at: new Date().toISOString(), failed: e instanceof Error ? e.message : String(e) })); } catch { /* 忽略 */ }
        return { descriptors: [] };
      }
    }
    if (req.action === 'exec') {
      const payload = (req.payload ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      const name = String(payload.name ?? '');
      if (!name.startsWith('mcp__')) return { ok: false, error: `非法 MCP 工具名: ${name}` };
      try {
        const resp = await fetch('/api/mcp/call', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, arguments: payload.arguments ?? {} }),
        });
        const j = (await resp.json().catch(() => null)) as { ok?: boolean; stdout?: string; stderr?: string; error?: string } | null;
        if (!resp.ok || !j?.ok) return { ok: false, error: j?.error ?? j?.stderr ?? `HTTP ${resp.status}` };
        return { ok: true, stdout: j.stdout ?? '', exitCode: 0 };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    return { ok: false, error: `unknown action: ${req.action}` };
  };
}

function createMcpAdminHandler(api: SlotHostApi): CapabilityHandler {
  return async (req) => {
    try {
      if (req.action === 'list') {
        const resp = await fetch('/api/mcp/servers', { credentials: 'include' });
        return { ok: true, ...(await resp.json()) };
      }
      if (req.action === 'add') {
        const payload = (req.payload ?? {}) as { name?: string; command?: string; args?: string[]; env?: Record<string, string>; enabled?: boolean };
        const resp = await fetch('/api/mcp/servers', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const j = (await resp.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!resp.ok || !j?.ok) return { ok: false, error: j?.error ?? `HTTP ${resp.status}` };
        emitToolsChanged(api, String(payload.name ?? ''), 'add');
        return { ok: true };
      }
      if (req.action === 'remove') {
        const payload = (req.payload ?? {}) as { name?: string };
        const resp = await fetch('/api/mcp/servers/remove', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const j = (await resp.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!resp.ok || !j?.ok) return { ok: false, error: j?.error ?? `HTTP ${resp.status}` };
        emitToolsChanged(api, String(payload.name ?? ''), 'remove');
        return { ok: true };
      }
      if (req.action === 'gate') {
        const payload = (req.payload ?? {}) as { tool?: string; enabled?: boolean };
        const resp = await fetch('/api/mcp/gate', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (resp.ok) emitToolsChanged(api, String(payload.tool ?? ''), 'gate');
        return { ok: resp.ok };
      }
      return { ok: false, error: `unknown action: ${req.action}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };
}

export const mcpBridgePlugin: LitePlugin = {
  manifest: {
    id: 'mcp-bridge',
    name: 'MCP 桥',
    version: '0.2.0',
    capabilities: ['cap.meta', 'cap.mcp.admin'],
    provides: ['cap.tool.mcp', 'cap.tool.mcp-ops', 'cap.mcp.admin'],
    events: ['tool-registered'],
    contributes: {
      slots: [{ slot: 'panel', component: 'McpPanel', order: 21, title: 'MCP' }],
    },
  },
  setup(api: SlotHostApi) {
    setMcpPanelApi(api);
    api.registerCapability.register('cap.tool.mcp', createMcpToolHandler());
    api.registerCapability.register('cap.tool.mcp-ops', createMcpOpsHandler(api));
    api.registerCapability.register('cap.mcp.admin', createMcpAdminHandler(api));
    api.emit('tool-registered', { cap: 'cap.tool.mcp', name: 'mcp' });
  },
};

export { McpPanel };
export default mcpBridgePlugin;
