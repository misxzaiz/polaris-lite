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

test('契约：agent-files 策略住 server 半边、注入 tool.mjs（node:fs 豁免边界）', () => {
  assert.match(filesToolSrc, /async needsApproval\(\{ args, run \}\)/, '适配器必须暴露 needsApproval 钩子');
  assert.match(filesToolSrc, /policy\.needsWriteApproval/, '判定必须走注入的策略（tool.mjs 不 import node:fs）');
  assert.match(filesServerSrc, /registerFilesWriteTool\(options\.registry, \{ needsWriteApproval \}\)/);
  assert.match(filesServerSrc, /function inGitRepo/, '.git 自动识别住 server 半边');
});

test('契约：bash DENYLIST 硬规则——release/checkout/push/pm2 变更（yolo 不豁免）', () => {
  assert.match(bashSrc, /\(checkout\|switch\|restore\)\(\?\!\[\\w-\]\)/, '缺 checkout/switch/restore 规则（含文件名防误伤环视）');
  assert.match(bashSrc, /--hard\\b/, '缺 reset --hard 规则');
  assert.match(bashSrc, /push\(\?\!\[\\w-\]\)/, '缺 git push 规则');
  assert.match(bashSrc, /\(release\|deploy\(:9826\)\?\|soft:9826\)/, '缺发版脚本规则');
  assert.match(bashSrc, /\(kill\|delete\|restart/, '缺 pm2 变更规则');
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

test('files_write 适配器：needsApproval 透传策略判定（含异常兜底与缺省关闭）', async () => {
  const reg = mockRegistry();
  registerFilesWriteTool(reg, { needsWriteApproval: (rootId, path) => rootId === 'r-repo' && path === 'x.mjs' });
  const a = reg.adapters[0];
  assert.equal(a.name, 'files_write');
  assert.equal(typeof a.needsApproval, 'function');
  assert.equal(await a.needsApproval({ args: { action: 'write', path: 'x.mjs', rootId: 'r-repo' }, run: {} }), true,
    '仓库根内的写 → 要求审批');
  assert.equal(await a.needsApproval({ args: { action: 'write', path: 'x.mjs', rootId: 'r-ws' }, run: {} }), false,
    '非仓库根不拦');
  assert.equal(await a.needsApproval({ args: { action: 'write', path: 'other.mjs', rootId: 'r-repo' }, run: {} }), false,
    '路径不符不拦');
  // run.boundRootId 兜底
  assert.equal(await a.needsApproval({ args: { action: 'edit' }, run: { boundRootId: 'r-repo' } }), false,
    '无 path 时策略方按解析失败不拦');
});

test('files_write 适配器：无 policy 缺省关闭（向后兼容），策略抛错不拦', async () => {
  const reg1 = mockRegistry();
  registerFilesWriteTool(reg1);
  assert.equal(await reg1.adapters[0].needsApproval({ args: { path: 'x' }, run: {} }), false,
    '未注入策略 → 不拦（兼容旧装配）');
  const reg2 = mockRegistry();
  registerFilesWriteTool(reg2, { needsWriteApproval: () => { throw new Error('boom'); } });
  assert.equal(await reg2.adapters[0].needsApproval({ args: { path: 'x' }, run: {} }), false,
    '策略抛错按不拦处理（执行期给确切错误）');
});
