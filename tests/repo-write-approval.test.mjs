/**
 * 仓库写入审批卡 + runner 强制审批钩子测试（安全闸门 2026-11-28）。
 *
 * 两层：① 源码契约断言（runner 钩子机制 / agent-files 策略注入的接线，模板
 * tests/auto-continue.test.mjs——跨插件行为闭包实例化成本高，用源码锁定）；
 * ② 功能用例：inGitRepo 识别与 files_write 适配器 needsApproval 钩子的实际返回。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { inGitRepo } from '../plugins/agent-files/server.mjs';
import { registerFilesWriteTool } from '../plugins/agent-files/tool.mjs';

const read = (p) => readFileSync(p, 'utf8');
const runnerSrc = read('plugins/agent-runner/server.mjs');
const filesToolSrc = read('plugins/agent-files/tool.mjs');
const filesServerSrc = read('plugins/agent-files/server.mjs');
const bashSrc = read('plugins/agent-bash/server.mjs');

// ── ① 源码契约 ───────────────────────────────────────────────────────────

test('契约：runner 审批裁决必须先问适配器 needsApproval（机制在宿主）', () => {
  assert.match(runnerSrc, /typeof p\.adapter\?\.needsApproval === 'function'/,
    '串行审批段必须调用适配器的 needsApproval 钩子');
  assert.match(runnerSrc, /const needApproval = forcedApproval\s*\|\|/,
    '强制审批必须短路 yolo/会话白名单（一律审批）');
});

test('契约：agent-files 策略住 server 半边、注入 tool.mjs（node:fs 豁免边界）——2026-11-28 晚停用：钩子保留但恒不拦', () => {
  assert.match(filesToolSrc, /async needsApproval\(\{ args, run \}\)/, '适配器必须暴露 needsApproval 钩子');
  assert.match(filesServerSrc, /function inGitRepo/, '.git 自动识别住 server 半边');
});

test('契约：bash DENYLIST 仓库/发布闸门已停用（2026-11-28 晚用户决策：信任模式=任意操作），核心破坏类规则保留', () => {
  assert.match(bashSrc, /repo\/publish gate removed 2026-11-28/, '闸门移除标记必须在场（防止误恢复或误删历史）');
  assert.doesNotMatch(bashSrc, /\(checkout\|switch\|restore\)\(\?\!\[\\w-\]\)/, 'checkout/switch/restore 规则应已移除');
  assert.doesNotMatch(bashSrc, /pm2\s+\(kill/, 'pm2 变更规则应已移除');
  // 真正的破坏类（全盘/数据/提权）仍在 denylist
  assert.match(bashSrc, /mkfs|diskpart/, '全盘破坏规则必须保留');
  assert.match(bashSrc, /providers\|auth-owner/, '核心数据文件写保护必须保留');
});

// ── ② 功能用例 ───────────────────────────────────────────────────────────

test('inGitRepo：.git 自动识别（含深层文件向上找根；普通目录 false）', () => {
  const repo = mkdtempSync(join(tmpdir(), 'gwrepo-'));
  mkdirSync(join(repo, '.git'), { recursive: true });
  const deep = join(repo, 'a', 'b', 'c', 'd');
  mkdirSync(deep, { recursive: true });
  const file = join(deep, 'x.mjs');
  writeFileSync(file, 'x');
  assert.equal(inGitRepo(file), true, '深层文件应向上找到 .git');
  const plain = mkdtempSync(join(tmpdir(), 'gwplain-'));
  const plainFile = join(plain, 'y.txt');
  writeFileSync(plainFile, 'y');
  assert.equal(inGitRepo(plainFile), false, '非仓库目录不应误判');
});

function mockRegistry() {
  const adapters = [];
  return { adapters, registerTool(a) { adapters.push(a); } };
}

test('files_write 适配器：needsApproval 恒不拦（2026-11-28 晚停用仓库审批闸门）', async () => {
  const reg = mockRegistry();
  registerFilesWriteTool(reg, { needsWriteApproval: (rootId, path) => rootId === 'r-repo' && path === 'x.mjs' });
  const a = reg.adapters[0];
  assert.equal(a.name, 'files_write');
  assert.equal(typeof a.needsApproval, 'function');
  assert.equal(await a.needsApproval({ args: { action: 'write', path: 'x.mjs', rootId: 'r-repo' }, run: {} }), false,
    '策略已断开注入，仓库内写也不再强制审批');
  // run.boundRootId 兜底路径同样不拦
  assert.equal(await a.needsApproval({ args: { action: 'edit' }, run: { boundRootId: 'r-repo' } }), false);
});

test('files_write 适配器：无 policy 缺省关闭（向后兼容）', async () => {
  const reg1 = mockRegistry();
  registerFilesWriteTool(reg1);
  assert.equal(await reg1.adapters[0].needsApproval({ args: { path: 'x' }, run: {} }), false,
    '未注入策略 → 不拦（兼容旧装配）');
});
