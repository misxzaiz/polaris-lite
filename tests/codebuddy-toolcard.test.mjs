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

test('codebuddy-engine: runTurn 逐帧实时上报工具事件（工具卡不得堆到正文末尾）', async () => {
  const src = await read('plugins/codebuddy-engine/server.mjs');
  // 契约：runTurn 签名必须接受 onToolCall / onToolResult
  const sig = slice(src, 'async runTurn({ model, messages, signal', '})\n');
  assert.ok(sig.length > 0, '定位 runTurn 签名');
  assert.match(sig, /onToolCall/, 'runTurn 必须接受 onToolCall 回调');
  assert.match(sig, /onToolResult/, 'runTurn 必须接受 onToolResult 回调');
  // 契约：stdout 帧循环里 start/end 帧要立即回调，而不是只攒进 toolCalls 聚合
  const startBlock = slice(src, "} else if (t === 'tool_call_start') {", "} else if (t === 'tool_call_end') {");
  assert.match(startBlock, /onToolCall\?\.\(/, 'tool_call_start 帧需立即上报（CLI 自持工具循环，等 turn 收敛会全堆到末尾）');
  const endBlock = slice(src, "} else if (t === 'tool_call_end') {", "} else if (t === 'usage') {");
  assert.match(endBlock, /onToolResult\?\.\(/, 'tool_call_end 帧需立即上报结果');
});

test('agent-runner: 工具卡/结果按 callId 去重，引擎已实时发过的不再回放', async () => {
  const src = await read('plugins/agent-runner/server.mjs');
  // 回调透传给引擎
  assert.match(src, /onToolCall,\s*\n\s*onToolResult,/, 'engineTurn 需透传 onToolCall / onToolResult');
  // 回放段去重
  const emitCard = slice(src, 'const display = summarizeCall(call);', 'const adapter = registry?.getTool?.(call.name);');
  assert.match(emitCard, /streamedCards\.has\(callId\)/, 'replay 段的 tool.card 需按 streamedCards 去重');
  assert.match(src, /streamedResults\.has\(pr\.resultEvent\.callId\)/, 'replay 段的 tool.result 需按 streamedResults 去重');
  // 会话档落块同 callId 幂等（首帧 args 为空、收尾帧回填，不得建两个块）
  const cardBranch = slice(src, "} else if (ev.kind === 'tool.card') {", "} else if (ev.kind === 'tool.result') {");
  assert.match(cardBranch, /blocks\.find\(/, '落档的 tool.card 需先按 callId 查已有块');
  assert.match(cardBranch, /exist\.card\.argsJson = p\.argsJson/, '已有块需回填完整参数而不是新建');
});
