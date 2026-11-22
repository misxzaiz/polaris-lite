#!/usr/bin/env node
// 极简 MCP stdio server（零依赖）：newline-delimited JSON-RPC 2.0
// 工具：echo / now / add

import readline from 'node:readline';

const SERVER_INFO = { name: 'demo-mcp', version: '1.0.0' };
const PROTOCOL_VERSION = '2024-11-05';

const tools = [
  {
    name: 'echo',
    description: '原样返回传入的 message，用于连通性测试',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string', description: '要回显的文本' } },
      required: ['message'],
    },
  },
  {
    name: 'now',
    description: '返回服务器当前时间（ISO 8601）',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'add',
    description: '计算两个数之和',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
  },
];

function callTool(name, args) {
  switch (name) {
    case 'echo':
      return { content: [{ type: 'text', text: `echo: ${args?.message ?? ''}` }] };
    case 'now':
      return { content: [{ type: 'text', text: new Date().toISOString() }] };
    case 'add': {
      const sum = Number(args?.a ?? 0) + Number(args?.b ?? 0);
      return { content: [{ type: 'text', text: `${args?.a} + ${args?.b} = ${sum}` }] };
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

function respond(msg, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
}

function respondError(msg, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code, message } }) + '\n');
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }

  // 通知无需应答
  if (msg.id === undefined) return;

  try {
    switch (msg.method) {
      case 'initialize':
        respond(msg, {
          protocolVersion: msg.params?.protocolVersion ?? PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });
        break;
      case 'tools/list':
        respond(msg, { tools });
        break;
      case 'tools/call':
        respond(msg, callTool(msg.params?.name, msg.params?.arguments));
        break;
      case 'ping':
        respond(msg, {});
        break;
      default:
        respondError(msg, -32601, `method not found: ${msg.method}`);
    }
  } catch (err) {
    respondError(msg, -32603, String(err?.message ?? err));
  }
});
