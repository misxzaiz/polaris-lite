/**
 * skill-loader server 半边测试：SKILL.md 发现/同名遮蔽/frontmatter 容错/附录构建。
 *
 * 直接调用 createServerPart（不经宿主装配），用临时目录伪造 dataDir + workspace；
 * workspace 定位走 <dataDir>/workspace-state.json 的 activeRootPath（与生产同源）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerPart } from '../plugins/skill-loader/server.mjs';

function tempEnv(t) {
  const root = mkdtempSync(join(tmpdir(), 'plite-skills-'));
  const dataDir = join(root, 'data');
  const ws = join(root, 'ws');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(dataDir, 'workspace-state.json'), JSON.stringify({ activeRootPath: ws }));
  t.after(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* 忽略 */ } });

  const mw = createServerPart({ getSession: () => ({ user: { name: 'tester' } }), dataDir });
  const call = async (path) => {
    const res = {
      code: 0, body: '',
      writeHead(c) { this.code = c; return this; },
      end(b) { this.body = b ?? ''; },
    };
    await mw({ url: path, method: 'GET', headers: {}, on() { return this; } }, res, () => {});
    let json = null;
    try { json = JSON.parse(res.body); } catch { /* 非 JSON */ }
    return { status: res.code, json };
  };
  return { root, dataDir, ws, call };
}

const mkSkill = (base, dir, name, content) => {
  mkdirSync(join(base, dir, name), { recursive: true });
  writeFileSync(join(base, dir, name, 'SKILL.md'), content);
};

test('skills: 多目录发现 + 同名先到先得 + frontmatter 解析', async (t) => {
  const { dataDir, ws, call } = tempEnv(t);
  // 原生目录（最高优先）
  mkSkill(dataDir, 'skills', 'deploy', '---\nname: deploy\ndescription: 原生部署技能\n---\n原生正文');
  // workspace claude 目录（同名，应被遮蔽）
  mkSkill(ws, '.claude/skills', 'deploy', '---\nname: deploy\ndescription: Claude 项目级部署\n---\nCC 正文');
  // workspace zcode 目录（不同名）
  mkSkill(ws, '.zcode/skills', 'zskill', '---\nname: zskill\ndescription: ZCode 技能\nwhen_to_use: 需要 Z 时\n---\nZ 正文');
  // 无 frontmatter（name 回退目录名）
  mkSkill(ws, '.agents/skills', 'nofm', '# 裸正文技能\n没有 frontmatter');
  // 超长 description（截断不丢弃）
  mkSkill(ws, '.claude/skills', 'longdesc', '---\nname: longdesc\ndescription: ' + 'x'.repeat(1100) + '\n---\nbody');

  const r = await call('/api/skills/list');
  assert.equal(r.status, 200);
  const names = r.json.skills.map((s) => s.name);
  assert.ok(names.includes('deploy'), 'deploy 应被发现');
  assert.ok(names.includes('zskill'), 'zskill 应被发现');
  assert.ok(names.includes('nofm'), '无 frontmatter 技能应被发现（name 回退目录名）');
  assert.ok(names.includes('longdesc'), '超长 desc 技能应被发现');

  const deploy = r.json.skills.find((s) => s.name === 'deploy');
  assert.equal(deploy.description, '原生部署技能', '同名时原生目录应胜出（先到先得）');
  assert.equal(deploy.source, 'native');

  const nofm = r.json.skills.find((s) => s.name === 'nofm');
  assert.equal(nofm.name, 'nofm');
  assert.equal(nofm.description, '');

  const long = r.json.skills.find((s) => s.name === 'longdesc');
  assert.ok(long.description.length <= 1025, `超长 description 应被截断（实际 ${long.description.length}）`);
});

test('skills: read 返回全文且超长截断；appendix 含索引与 AGENTS.md', async (t) => {
  const { dataDir, ws, call } = tempEnv(t);
  mkSkill(dataDir, 'skills', 'demo', '---\nname: demo\ndescription: 演示\n---\nSKILL 正文内容');
  mkdirSync(join(dataDir, 'skills', 'big'), { recursive: true });
  writeFileSync(join(dataDir, 'skills', 'big', 'SKILL.md'), '---\nname: big\ndescription: 大技能\n---\n' + 'B'.repeat(20 * 1024));
  writeFileSync(join(ws, 'AGENTS.md'), '# 工作区约定\n不要提交 dist。');

  const rd = await call('/api/skills/read?name=demo');
  assert.equal(rd.status, 200);
  assert.equal(rd.json.ok, true);
  assert.ok(rd.json.content.includes('SKILL 正文内容'));

  const big = await call('/api/skills/read?name=big');
  assert.equal(big.json.ok, true);
  assert.ok(Buffer.byteLength(big.json.content, 'utf8') <= 16 * 1024 + 64, '全文应被 16KB 截断');

  const missing = await call('/api/skills/read?name=不存在');
  assert.equal(missing.status, 404);

  const ap = await call('/api/skills/appendix');
  assert.equal(ap.status, 200);
  assert.ok(ap.json.text.includes('# Available skills'), '附录应含技能索引头');
  assert.ok(ap.json.text.includes('- demo'), '附录应含 demo 条目');
  assert.ok(ap.json.text.includes('read_skill'), '附录应指示用 read_skill');
  assert.ok(ap.json.text.includes('# Project instructions'), '附录应含项目指令段');
  assert.ok(ap.json.text.includes('不要提交 dist'), 'AGENTS.md 正文应被注入');
});

test('skills: PLITE_SKILLS=0 时端点整体旁路（next 调用）', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'plite-skills-off-'));
  t.after(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* 忽略 */ } });
  process.env.PLITE_SKILLS = '0';
  try {
    const mw = createServerPart({ getSession: () => ({ user: { name: 't' } }), dataDir: join(root, 'd') });
    const res = { code: 0, body: '', writeHead(c) { this.code = c; return this; }, end(b) { this.body = b ?? ''; } };
    let nextCalled = false;
    await mw({ url: '/api/skills/list', method: 'GET', headers: {}, on() { return this; } }, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true, '禁用时应 next() 旁路');
  } finally {
    delete process.env.PLITE_SKILLS;
  }
});
