#!/usr/bin/env node
/**
 * extquad 随包 MCP server（stdio JSON-RPC，最小 echo 实现）。
 * 仅用于验证外部插件 → mcp-servers.json 登记 → AI 工具面出现的全链路。
 * 协议：JSON-RPC 2.0 over stdio（initialize / tools/list / tools/call / notifications/initialized）。
 */
process.stdin.setEncoding('utf8');

const tools = [
  {
    name: 'echo',
    description: 'echo 回显输入文本（extquad 外部插件验证工具）',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '要回显的文本' } },
      required: ['text'],
    },
  },
];

let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'extquad-echo', version: '0.1.0' } } });
    return;
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools } });
    return;
  }
  if (method === 'tools/call') {
    const text = String(params?.arguments?.text ?? '');
    send({
      jsonrpc: '2.0', id,
      result: { content: [{ type: 'text', text: `[extquad-echo] ${text}` }] },
    });
    return;
  }
  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

process.on('exit', () => process.stdout.write(''));
