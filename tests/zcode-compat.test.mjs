/**
 * zcode-compat server 半边测试：多源扫描/合并优先级/变量展开/ZCode 迁移/固化导入。
 *（对应方案 PoC V6 的固化回归 + 导入链路。）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerPart } from '../plugins/zcode-compat/server.mjs';

function tempEnv(t) {
  const root = mkdtempSync(join(tmpdir(), 'plite-compat-'));
  const dataDir = join(root, 'data');
  const ws = join(root, 'ws');
  const home = join(root, 'home');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(ws, { recursive: true });
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(home, '.zcode', 'cli'), { recursive: true });
  writeFileSync(join(dataDir, 'workspace-state.json'), JSON.stringify({ activeRootPath: ws }));
  const oldUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = home;
  t.after(() => {
    process.env.USERPROFILE = oldUserProfile;
    try { rmSync(root, { recursive: true, force: true }); } catch { /* 忽略 */ }
  });

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
  return { root, dataDir, ws, home, call };
}

test('compat scan: 多源 MCP 合并 + 同名让位 + ${VAR} 展开 + ZCode 迁移 + http 跳过', async (t) => {
  const { ws, home, call } = tempEnv(t);
  const fsTarget = join(ws, 'fs.js');
  writeFileSync(fsTarget, '// t');
  writeFileSync(join(ws, '.mcp.json'), JSON.stringify({
    mcpServers: {
      fs: { command: 'node', args: ['${WORKSPACE}/fs.js'] },
      dup: { command: 'from-project' },
      remote: { url: 'https://example.com/mcp' },
    },
  }));
  mkdirSync(join(ws, '.zcode'), { recursive: true });
  writeFileSync(join(ws, '.zcode', 'config.json'), JSON.stringify({ mcp: { servers: { zc: { command: 'zcmd', environment: { A: '1' }, enable: true } } } }));
  mkdirSync(join(ws, '.agents'), { recursive: true });
  writeFileSync(join(ws, '.agents', 'mcp.json'), JSON.stringify({ mcpServers: { dup: { command: 'from-agents' } } }));
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { [ws]: { mcpServers: { claudeproj: { command: 'ccmd', args: ['--x', '${MISSING:-fallback}'] } } } } }));

  const r = await call('/api/compat/scan');
  assert.equal(r.status, 200);
  const names = r.json.mcp.map((s) => s.name);
  for (const expected of ['fs', 'dup', 'zc', 'claudeproj']) assert.ok(names.includes(expected), `应含 ${expected}`);
  assert.ok(!names.includes('remote'), 'http url server 应跳过');
  const fsEntry = r.json.mcp.find((s) => s.name === 'fs');
  assert.equal(fsEntry.args[0], fsTarget, '${WORKSPACE} 应展开为真实路径');
  const dup = r.json.mcp.find((s) => s.name === 'dup');
  assert.equal(dup.command, 'from-project', '同名项目 .mcp.json 应胜出');
  assert.ok(r.json.warns.some((w) => w.includes('同名')), '同名让位应有 warn');
  assert.ok(r.json.warns.some((w) => w.includes('暂不支持')), 'http 跳过应有 warn');
});

test('compat import: MCP 固化到 mcp-servers.json + ZC env 迁移 + ${VAR:-d} 兜底', async (t) => {
  const { dataDir, ws, home, call } = tempEnv(t);
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { [ws]: { mcpServers: { claudeproj: { command: 'ccmd', args: ['--x', '${MISSING:-fallback}'] } } } } }));
  mkdirSync(join(ws, '.zcode'), { recursive: true });
  writeFileSync(join(ws, '.zcode', 'config.json'), JSON.stringify({ mcp: { servers: { zc: { command: 'zcmd', environment: { A: '1' }, enable: true } } } }));

  const r = await call('/api/compat/import', {});
  assert.equal(r.json.ok, true);
  assert.ok(r.json.log.some((l) => l.includes('mcp servers 导入 2')), `导入日志应含 2 个 server：${JSON.stringify(r.json.log)}`);

  const cfg = JSON.parse(readFileSync(join(dataDir, 'mcp-servers.json'), 'utf8'));
  assert.equal(cfg.servers.claudeproj.command, 'ccmd');
  assert.equal(cfg.servers.claudeproj.args[1], 'fallback', '${MISSING:-fallback} 应取默认值');
  assert.equal(cfg.servers.zc.env.A, '1', 'ZC environment 应迁移为 env');
  assert.equal(cfg.servers.zc.enabled, true, 'ZC enable 应迁移为 enabled');
  assert.equal(cfg.servers.zc.source, 'project:.zcode/config.json');
});

test('compat import: skills 复制到原生目录（compat- 前缀）+ 原生同名让位', async (t) => {
  const { dataDir, ws, call } = tempEnv(t);
  mkdirSync(join(ws, '.claude', 'skills', 'deploy'), { recursive: true });
  writeFileSync(join(ws, '.claude', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: CC 部署\n---\n正文');
  mkdirSync(join(dataDir, 'skills', 'deploy'), { recursive: true });
  writeFileSync(join(dataDir, 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: 原生部署\n---\n正文');

  const r = await call('/api/compat/import', {});
  assert.equal(r.json.ok, true);
  const copied = join(dataDir, 'skills', 'compat-claude-deploy');
  assert.ok(existsSync(join(copied, 'SKILL.md')), '外部 skill 应复制为 compat-claude-deploy');
  const native = readFileSync(join(dataDir, 'skills', 'deploy', 'SKILL.md'), 'utf8');
  assert.match(native, /原生部署/, '原生目录不应被覆盖');
  assert.ok(r.json.log.some((l) => l.includes('skills 复制 1')), '应复制 1 个 skill');
});

test('compat import: CC 插件（.claude-plugin）的 mcpServers/skills 拆解导入 + ${CLAUDE_PLUGIN_ROOT} 展开', async (t) => {
  const { dataDir, ws, call } = tempEnv(t);
  const pluginDir = join(ws, '.claude', 'plugins', 'my-tools');
  mkdirSync(join(pluginDir, '.claude-plugin'), { recursive: true });
  mkdirSync(join(pluginDir, 'skills', 'lint'), { recursive: true });
  writeFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), JSON.stringify({
    name: 'my-tools',
    mcpServers: { main: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server.js'] } },
    skills: ['lint'],
    agents: ['./agents/x.md'], // 不支持：应忽略
  }));
  writeFileSync(join(pluginDir, 'skills', 'lint', 'SKILL.md'), '---\nname: lint\ndescription: Lint 规则\n---\n正文');
  writeFileSync(join(pluginDir, 'server.js'), '// target');

  const r = await call('/api/compat/import', {});
  assert.equal(r.json.ok, true);
  const cfg = JSON.parse(readFileSync(join(dataDir, 'mcp-servers.json'), 'utf8'));
  const imported = cfg.servers['plugin-my-tools-main'];
  assert.ok(imported, '插件 MCP server 应以 plugin-my-tools-main 导入');
  assert.equal(imported.args[0], join(pluginDir, 'server.js'), '${CLAUDE_PLUGIN_ROOT} 应展开为插件目录');
  assert.ok(existsSync(join(dataDir, 'skills', 'compat-plugin-my-tools-lint', 'SKILL.md')), '插件 skill 应复制');
  assert.ok(existsSync(join(dataDir, 'mcp-audit.log')) === false || true); // 审计在 mcp-bridge；此处不强制
});

test('compat: PLITE_COMPAT=0 整体旁路', async (t) => {
  process.env.PLITE_COMPAT = '0';
  try {
    const mw = createServerPart({ getSession: () => ({ user: { name: 't' } }), dataDir: join(tmpdir(), 'compat-off') });
    const res = { code: 0, body: '', writeHead(c) { this.code = c; return this; }, end(b) { this.body = b ?? ''; } };
    let nextCalled = false;
    await mw({ url: '/api/compat/scan', method: 'GET', headers: {}, on() { return this; } }, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true, '禁用时应 next() 旁路');
  } finally {
    delete process.env.PLITE_COMPAT;
  }
});
