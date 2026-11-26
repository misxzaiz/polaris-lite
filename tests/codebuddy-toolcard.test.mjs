/**
 * codebuddy 工具卡参数回填回归测试（源码契约）。
 *
 * codebuddy CLI 对同一 callId 连发两帧 tool_call_start：content_block_start 时
 * Anthropic 流协议的 input 恒为空（args={}），content_block_stop 后才带完整参数。
 * 首帧建卡、第二帧按 callId 幂等回填是宿主语义；若回填分支被误删，卡片折叠头
 * 与 ArgsBlock 会永远显示 "{}"。chat-lite 是 TS+zustand 插件，Node 无法直接 import，
 * 故沿用 engine-kit/reasoning 同模式做源码契约守卫。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFile(resolve(root, rel), 'utf8');
const slice = (src, start, end) => src.slice(src.indexOf(start), src.indexOf(end));

test('chat-lite: 已建卡分支回填 tool.card 第二帧（不吞完整参数）', async () => {
  const src = await read('plugins/chat-lite/index.ts');
  const branch = slice(
    src,
    "if (kind === 'tool.card' || kind === 'tool.approval.required')",
    "if (kind === 'tool.approval.resolved')",
  );
  assert.ok(branch.length > 0, '定位 tool.card / approval.required 联合分支');
  assert.match(branch, /if \(kind === 'tool\.card'\)/, '已建卡分支必须处理第二帧 tool.card');
  assert.match(branch, /patchCard\(callId/, '回填走 patchCard（同 callId 幂等）');
  assert.match(branch, /capArgs\(inner\.command\)/, 'command 回填必须裁剪（patchCard 不过 trimCard）');
  assert.match(branch, /capArgs\(inner\.argsJson\)/, 'argsJson 回填必须裁剪');
});

test('codebuddy-engine: tool_call_start 单独透传 argsJson', async () => {
  const src = await read('plugins/codebuddy-engine/server.mjs');
  const block = slice(src, "case 'tool_call_start':", "case 'tool_call_end':");
  assert.ok(block.length > 0, '定位 tool_call_start 翻译分支');
  assert.match(block, /argsJson: JSON\.stringify\(frame\.args\)/, '结构化参数需带 argsJson 供 ArgsBlock/悬浮岛/ai-events 消费');
});
