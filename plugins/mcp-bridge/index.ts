/**
 * mcp-bridge 插件：MCP（Model Context Protocol）server 接入。
 *
 * 职责（plans/extension-capability-pure-plugin-plan.md §2.1）：
 * 1. cap.tool.mcp（聚合工具 cap）：describe 返回 {descriptors:[...]}（全部 MCP 工具，
 *    命名 mcp__<server>__<tool>）；exec 按 name 路由到对应 server 的 tools/call。
 *    agent-loop A1 已兼容聚合数组形态。
 * 2. cap.mcp.admin：管理面（list servers/tools、门控开关），供面板/设置使用。
 * 3. server 半边：MCP client 池（stdio NDJSON JSON-RPC 2.0，协议 2024-11-05）+
 *    配置仓库（<dataDir>/mcp-servers.json 原生格式，唯一写目标）+ /api/mcp/* 管理端点。
 *
 * 配置来源：原生 <dataDir>/mcp-servers.json 为权威；外部格式（.mcp.json 等）由
 * zcode-compat 插件负责发现并「固化导入」到原生文件——本插件只吃原生格式。
 *
 * 安全模型：PLITE_MCP=0 一键禁用；server 启动/调用全量审计（mcp-audit.log）；
 * per-tool 门控存 cap.kv（namespace 'mcp-bridge'）。
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

function createMcpToolHandler(): CapabilityHandler {
  return async (req) => {
    if (req.action === 'describe') {
      try {
        const resp = await fetch('/api/mcp/tools', { credentials: 'include' });
        const j = (await resp.json().catch(() => null)) as { tools?: McpToolDescriptor[] } | null;
        return { descriptors: j?.tools ?? [] };
      } catch {
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

function createMcpAdminHandler(): CapabilityHandler {
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
        return { ok: true };
      }
      if (req.action === 'remove') {
        const payload = (req.payload ?? {}) as { name?: string };
        const resp = await fetch('/api/mcp/servers/remove', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: payload.name }),
        });
        const j = (await resp.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!resp.ok || !j?.ok) return { ok: false, error: j?.error ?? `HTTP ${resp.status}` };
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
    capabilities: ['cap.meta'],
    provides: ['cap.tool.mcp', 'cap.mcp.admin'],
    events: ['tool-registered'],
    contributes: {
      slots: [{ slot: 'panel', component: 'McpPanel', order: 21, title: 'MCP' }],
    },
  },
  setup(api: SlotHostApi) {
    setMcpPanelApi(api);
    api.registerCapability.register('cap.tool.mcp', createMcpToolHandler());
    api.registerCapability.register('cap.mcp.admin', createMcpAdminHandler());
    api.emit('tool-registered', { cap: 'cap.tool.mcp', name: 'mcp' });
  },
};

export { McpPanel };
export default mcpBridgePlugin;
