/**
 * mcp-bridge server 半边测试：配置仓库 CRUD / 工具聚合 / 真子进程 MCP 调用 / 门控 / CLI 透传数据。
 *
 * 用一个真实 node 子进程扮演 MCP server（NDJSON JSON-RPC 2.0，协议 2024-11-05）——
 * 对应方案 PoC V3 的固化回归。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerPart } from '../plugins/mcp-bridge/server.mjs';

const FAKE_SERVER = `
let buf = '';
const NL = '\\n';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf(NL)) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.method === 'initialize') {
      send({ id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0' } } });
    } else if (m.method === 'notifications/initialized') {
      // no reply
    } else if (m.method === 'tools/list') {
      send({ id: m.id, result: { tools: [
        { name: 'echo', description: '回声工具', inputSchema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] } },
        { name: 'fail', description: '总是失败', inputSchema: { type: 'object', properties: {} } },
      ] } });
    } else if (m.method === 'tools/call') {
      if (m.params.name === 'fail') send({ id: m.id, result: { content: [{ type: 'text', text: '故意的错误' }], isError: true } });
      else send({ id: m.id, result: { content: [{ type: 'text', text: 'ECHO:' + ((m.params.arguments || {}).msg ?? '') }] } });
    } else if (m.id !== undefined) {
      send({ id: m.id, error: { code: -32601, message: 'nope' } });
    }
  }
});
function send(o) { process.stdout.write(JSON.stringify(o) + NL); }
`;

function tempEnv(t) {
  const root = mkdtempSync(join(tmpdir(), 'plite-mcp-'));
  const dataDir = join(root, 'data');
  const ws = join(root, 'ws');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(dataDir, 'workspace-state.json'), JSON.stringify({ activeRootPath: ws }));
  const serverPath = join(root, 'fake-mcp-server.cjs');
  writeFileSync(serverPath, FAKE_SERVER);
  t.after(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* 忽略 */ } });

  const mw = createServerPart({ getSession: () => ({ user: { name: 'tester' } }), dataDir });
  const call = async (path, body) => {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
    const res = {
      code: 0, body: '',
      writeHead(c) { this.code = c; return this; },
      end(b) { this.body = b ?? ''; },
    };
    await mw(
      {
        url: path, method: body === undefined ? 'GET' : 'POST', headers: {},
        on(ev, cb) { if (ev === 'data' && chunks.length) cb(chunks.shift()); if (ev === 'end') cb(); return this; },
      },
      res,
      () => {},
    );
    let json = null;
    try { json = JSON.parse(res.body); } catch { /* 非 JSON */ }
    return { status: res.code, json };
  };
  const addedServers = [];
  const callTracked = async (path, body) => {
    if (path === '/api/mcp/servers' && body && body.name) addedServers.push(body.name);
    return call(path, body);
  };
  // 测试结束时移除 server（会 kill 掉 MCP 子进程），否则子进程存活导致 node:test 挂起
  t.after(async () => {
    for (const name of addedServers) {
      try { await call('/api/mcp/servers/remove', { name }); } catch { /* 忽略 */ }
    }
  });
  return { root, dataDir, ws, serverPath, call: callTracked };
}

test('mcp: 配置 CRUD + 真子进程 tools 聚合（mcp__server__tool 命名）', async (t) => {
  const { dataDir, serverPath, call } = tempEnv(t);
  const add = await call('/api/mcp/servers', { name: 'fake', command: process.execPath, args: [serverPath] });
  assert.equal(add.json.ok, true);
  assert.ok(existsSync(join(dataDir, 'mcp-servers.json')), '原生配置应落盘');

  const tools = await call('/api/mcp/tools');
  assert.equal(tools.status, 200);
  const names = tools.json.tools.map((x) => x.name);
  assert.deepEqual(names, ['mcp__fake__echo', 'mcp__fake__fail']);
  assert.equal(tools.json.tools[0].cap, 'cap.tool.mcp');
  assert.equal(tools.json.tools[0].danger, 'execute');
  assert.deepEqual(tools.json.tools[0].parameters.required, ['msg'], 'inputSchema 应原样透传');
});

test('mcp: 真子进程 tools/call 往返（含中文）+ isError 传导', async (t) => {
  const { serverPath, call } = tempEnv(t);
  await call('/api/mcp/servers', { name: 'fake', command: process.execPath, args: [serverPath] });

  const ok = await call('/api/mcp/call', { name: 'mcp__fake__echo', arguments: { msg: '你好 mcp' } });
  assert.equal(ok.json.ok, true);
  assert.equal(ok.json.stdout, 'ECHO:你好 mcp');

  const bad = await call('/api/mcp/call', { name: 'mcp__fake__fail', arguments: {} });
  assert.equal(bad.json.ok, false);
  assert.match(String(bad.json.error), /故意的错误/);
});

test('mcp: per-tool 门控 + active 端点（CLI 引擎透传形态）', async (t) => {
  const { serverPath, call, dataDir } = tempEnv(t);
  await call('/api/mcp/servers', { name: 'fake', command: process.execPath, args: [serverPath] });

  await call('/api/mcp/gate', { tool: 'mcp__fake__fail', enabled: false });
  const tools = await call('/api/mcp/tools');
  const names = tools.json.tools.map((x) => x.name);
  assert.ok(!names.includes('mcp__fake__fail'), '被门控工具不应出现');
  assert.ok(names.includes('mcp__fake__echo'));

  const active = await call('/api/mcp/active');
  assert.deepEqual(active.json.mcpServers, [{ server_name: 'fake', command: process.execPath, args: [serverPath] }]);

  // 非法名拒绝
  const badName = await call('/api/mcp/servers', { name: 'bad name!', command: 'node' });
  assert.equal(badName.status, 400);
  assert.ok(existsSync(join(dataDir, 'mcp-audit.log')), '审计应落盘');
});

test('mcp: PLITE_MCP=0 整体旁路', async (t) => {
  process.env.PLITE_MCP = '0';
  try {
    const mw = createServerPart({ getSession: () => ({ user: { name: 't' } }), dataDir: join(tmpdir(), 'mcp-off') });
    const res = { code: 0, body: '', writeHead(c) { this.code = c; return this; }, end(b) { this.body = b ?? ''; } };
    let nextCalled = false;
    await mw({ url: '/api/mcp/servers', method: 'GET', headers: {}, on() { return this; } }, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true, '禁用时应 next() 旁路');
  } finally {
    delete process.env.PLITE_MCP;
  }
});
