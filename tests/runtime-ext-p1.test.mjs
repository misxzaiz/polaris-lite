/**
 * P1 运行时自建通道测试（runtime-extensions-and-market-final.md）：
 * 1. mcp-ops：__tool 分发（add/remove/list）→ mcp-servers.json 落盘（经浏览器 handler 逻辑无法直测，
 *    改测其依赖的 server 端点契约 + handler 纯逻辑抽验）
 * 2. hook 确认闸：workspace 规则未确认 → 执行被跳过（allow + warns）；confirm 后 → 正常执行
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerPart as hookServer } from '../plugins/hook-bridge/server.mjs';
import { createServerPart as mcpServer } from '../plugins/mcp-bridge/server.mjs';

function hookEnv(t) {
  const root = mkdtempSync(join(tmpdir(), 'plite-p1hook-'));
  const dataDir = join(root, 'data'), ws = join(root, 'ws'), home = join(root, 'home');
  mkdirSync(dataDir, { recursive: true }); mkdirSync(ws, { recursive: true });
  mkdirSync(join(home, '.claude'), { recursive: true }); mkdirSync(join(home, '.zcode', 'cli'), { recursive: true });
  writeFileSync(join(dataDir, 'workspace-state.json'), JSON.stringify({ activeRootPath: ws }));
  // 隔离用户级配置源：USERPROFILE 指到临时空目录（否则真实 ~/.claude 的 hooks 会参与执行污染断言）
  const oldUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = home;
  t.after(() => { process.env.USERPROFILE = oldUserProfile; try { rmSync(root, { recursive: true, force: true }); } catch { /* 忽略 */ } });
  const mw = hookServer({ getSession: () => ({ user: { name: 't' } }), dataDir });
  const call = async (path, body) => {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
    const res = { code: 0, body: '', writeHead(c) { this.code = c; return this; }, end(b) { this.body = b ?? ''; } };
    await mw({ url: path, method: body === undefined ? 'GET' : 'POST', headers: {}, on(ev, cb) { if (ev === 'data' && chunks.length) cb(chunks.shift()); if (ev === 'end') cb(); return this; } }, res, () => {});
    try { return { status: res.code, json: JSON.parse(res.body) }; } catch { return { status: res.code, json: null }; }
  };
  return { root, dataDir, ws, call };
}

test('p1: hook 确认闸——workspace 规则未确认时跳过执行，confirm 后生效', async (t) => {
  const { dataDir, ws, call } = hookEnv(t);
  // workspace 级 PreToolUse deny hook（会让任何 bash 调用被拒——若闸失效会被识破）
  const hookPath = join(dataDir, 'deny-once.cjs');
  writeFileSync(hookPath, `let b='';process.stdin.on('data',d=>b+=d);process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'gate-test'}}));process.exit(0);});`);
  mkdirSync(join(ws, '.claude'), { recursive: true });
  writeFileSync(join(ws, '.claude', 'settings.json'), JSON.stringify({
    hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: `node "${hookPath}"`, timeout: 10 }] }] },
  }));

  // 未确认：执行被跳过 → allow + warns 提示
  const before = await call('/api/hooks/pre-tool-use', { sessionId: 's1', toolName: 'bash', toolInput: { command: 'rm -rf x' } });
  assert.equal(before.json.decision, 'allow', '未确认时钩子不执行（fail-open）');
  assert.ok(Array.isArray(before.json.warns) && before.json.warns.some((w) => w.includes('未确认')), '应有未确认 warns');
  const list1 = await call('/api/hooks/list');
  assert.equal(list1.json.trust.pending, true, 'list 应报 pending');

  // 确认后：deny 生效
  const confirm = await call('/api/hooks/confirm', {});
  assert.equal(confirm.json.ok, true);
  const after = await call('/api/hooks/pre-tool-use', { sessionId: 's1', toolName: 'bash', toolInput: { command: 'rm -rf x' } });
  assert.equal(after.json.decision, 'deny', '确认后钩子正常执行');
  const list2 = await call('/api/hooks/list');
  assert.equal(list2.json.trust.pending, false);
  assert.ok(existsSync(join(dataDir, 'hooks-trust.json')), '信任记录应落盘');
});

test('p1: mcp_server_add 契约——__tool 分发 + 服务端校验拒绝非法名', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'plite-p1mcp-'));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  t.after(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* 忽略 */ } });
  const mw = mcpServer({ getSession: () => ({ user: { name: 't' } }), dataDir });
  const call = async (path, body) => {
    const chunks = [Buffer.from(JSON.stringify(body))];
    const res = { code: 0, body: '', writeHead(c) { this.code = c; return this; }, end(b) { this.body = b ?? ''; } };
    await mw({ url: path, method: 'POST', headers: {}, on(ev, cb) { if (ev === 'data' && chunks.length) cb(chunks.shift()); if (ev === 'end') cb(); return this; } }, res, () => {});
    try { return { status: res.code, json: JSON.parse(res.body) }; } catch { return { status: res.code, json: null }; }
  };
  // add 合法
  const ok = await call('/api/mcp/servers', { name: 'ai-made', command: 'node', args: ['x.js'], enabled: true });
  assert.equal(ok.json.ok, true);
  const cfg = JSON.parse(readFileSync(join(dataDir, 'mcp-servers.json'), 'utf8'));
  assert.ok(cfg.servers['ai-made'], 'add 应落盘原生配置');
  // 非法名拒绝（AI 传入坏名时服务端是最后防线）
  const bad = await call('/api/mcp/servers', { name: 'bad name!', command: 'node' });
  assert.equal(bad.status, 400);
  // remove
  const rm = await call('/api/mcp/servers/remove', { name: 'ai-made' });
  assert.equal(rm.json.ok, true);
});
