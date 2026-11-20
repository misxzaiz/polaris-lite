/**
 * hook-bridge server 半边测试：CC/ZC hooks 配置归一 + 进程执行 + 退出码/JSON 协议。
 *（协议语义经真子进程验证——对应方案 PoC V5 的固化回归。）
 *
 * 直接调用 createServerPart；workspace 定位走 <dataDir>/workspace-state.json。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerPart } from '../plugins/hook-bridge/server.mjs';

function tempEnv(t, hooksSettings) {
  const root = mkdtempSync(join(tmpdir(), 'plite-hooks-'));
  const dataDir = join(root, 'data');
  const ws = join(root, 'ws');
  const home = join(root, 'home');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(ws, { recursive: true });
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(dataDir, 'workspace-state.json'), JSON.stringify({ activeRootPath: ws }));
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(hooksSettings));
  t.after(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* 忽略 */ } });

  // 让 workspaceDir()/homedir() 都落到临时区：hook-bridge 用 os.homedir()，
  // 这里通过 process.env.USERPROFILE 覆盖（Windows 下 homedir 读它）。
  const oldUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = home;
  t.after(() => { process.env.USERPROFILE = oldUserProfile; });

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
  return { root, ws, home, call };
}

/** 写一个 node 钩子脚本：stdin 收 JSON，按 code 指定退出码，可选输出 JSON 文本 */
function writeHook(dir, name, behavior) {
  const p = join(dir, name);
  const script = `
let b='';process.stdin.on('data',d=>b+=d);process.stdin.on('end',()=>{
  ${behavior.emit ? `process.stdout.write(JSON.stringify(${behavior.emit}));` : ''}
  process.exit(${behavior.code ?? 0});
});`;
  writeFileSync(p, script);
  try { chmodSync(p, 0o755); } catch { /* Windows 无关 */ }
  return p;
}

test('hooks: PreToolUse deny（stdout JSON permissionDecision）', async (t) => {
  const hookPath = writeHook(t ? tmpdir() : tmpdir(), `hb-deny-${Date.now()}.cjs`, {
    emit: `{hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'rm 被策略禁止'}}`,
    code: 0,
  });
  const { call } = tempEnv(t, {
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `node "${hookPath}"`, timeout: 10 }] }] },
  });
  const r = await call('/api/hooks/pre-tool-use', { sessionId: 's1', toolName: 'bash', toolInput: { command: 'rm -rf x' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.decision, 'deny');
  assert.match(String(r.json.reason), /rm 被策略禁止/);
});

test('hooks: matcher 不命中时放行；PostToolUse additionalContext 返回', async (t) => {
  const hookPath = writeHook(t ? tmpdir() : tmpdir(), `hb-ctx-${Date.now()}.cjs`, {
    emit: `{hookSpecificOutput:{hookEventName:'PostToolUse',additionalContext:'[hook] 已审计'}}`,
    code: 0,
  });
  const { call } = tempEnv(t, {
    hooks: {
      PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'node "' + hookPath + '"' }] }], // 只匹配 Write，不匹配 bash
      PostToolUse: [{ hooks: [{ type: 'command', command: `node "${hookPath}"` }] }],
    },
  });
  const pre = await call('/api/hooks/pre-tool-use', { sessionId: 's1', toolName: 'bash', toolInput: { command: 'echo hi' } });
  assert.equal(pre.json.decision, 'allow', 'matcher 不命中应放行');

  const post = await call('/api/hooks/post-tool-use', { sessionId: 's1', toolName: 'bash', toolInput: { command: 'echo hi' }, success: true });
  assert.equal(post.status, 200);
  assert.match(String(post.json.additionalContext ?? ''), /已审计/);
});

test('hooks: 退出码 2 语义 = 阻断（ZCode/Claude 通用）', async (t) => {
  const hookPath = writeHook(t ? tmpdir() : tmpdir(), `hb-exit2-${Date.now()}.cjs`, { code: 2 });
  const { call } = tempEnv(t, {
    hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: `node "${hookPath}"` }] }] },
  });
  const r = await call('/api/hooks/pre-tool-use', { sessionId: 's1', toolName: 'bash', toolInput: { command: 'anything' } });
  assert.equal(r.json.decision, 'deny', '退出码 2 应判为 deny');
});

test('hooks: UserPromptSubmit 拒绝；坏 JSON 输出容错；不支持事件忽略+warn', async (t) => {
  const blockPath = writeHook(t ? tmpdir() : tmpdir(), `hb-block-${Date.now()}.cjs`, {
    emit: `{decision:'block',reason:'敏感词'}`,
    code: 0,
  });
  const badPath = writeHook(t ? tmpdir() : tmpdir(), `hb-bad-${Date.now()}.cjs`, { code: 0 }); // 无输出
  const { ws, call } = tempEnv(t, {
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: `node "${blockPath}"` }] }],
      PreToolUse: [{ hooks: [{ type: 'command', command: `node "${badPath}"` }] }],
      PreCompact: [{ hooks: [{ type: 'command', command: 'node -e 1' }] }], // Claude 独有：应忽略并 warn
    },
  });
  assert.ok(ws, 'workspace 就绪');

  const pr = await call('/api/hooks/prompt-submit', { sessionId: 's1', prompt: '包含敏感词的话' });
  assert.equal(pr.json.decision, 'deny');
  assert.match(String(pr.json.reason), /敏感词/);

  const pre = await call('/api/hooks/pre-tool-use', { sessionId: 's1', toolName: 'bash', toolInput: {} });
  assert.equal(pre.json.decision, 'allow', 'hook 无输出且退出码 0 应放行（坏 JSON 容错）');
  assert.ok(Array.isArray(pre.json.warns), 'warns 应返回');
  assert.ok(pre.json.warns.some((w) => w.includes('不支持的事件')), '不支持事件应汇总 warn');
});

test('hooks: PLITE_HOOKS=0 整体旁路', async (t) => {
  process.env.PLITE_HOOKS = '0';
  try {
    const mw = createServerPart({ getSession: () => ({ user: { name: 't' } }), dataDir: join(tmpdir(), 'hb-off') });
    const res = { code: 0, body: '', writeHead(c) { this.code = c; return this; }, end(b) { this.body = b ?? ''; } };
    let nextCalled = false;
    await mw(
      { url: '/api/hooks/pre-tool-use', method: 'POST', headers: {}, on(ev, cb) { if (ev === 'end') cb(); return this; } },
      res,
      () => { nextCalled = true; },
    );
    assert.equal(nextCalled, true, '禁用时应 next() 旁路');
  } finally {
    delete process.env.PLITE_HOOKS;
  }
});
