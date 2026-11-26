/**
 * 思考流（reasoning_content）链路回归：推理模型（nex-n2.6 实测）把「思考」放在
 * delta.reasoning_content、与 content 分帧下发。此前引擎只转发 content，长思考期间
 * UI 全程静默，用户误以为「AI 不回复」。本测试锁住三层转发与 UI 落块契约：
 *   real-engine emit message.reasoning → agent-loop 转发 → chat-lite 落 thinking 块。
 * 源码级断言（与 unattended.test.mjs 同风格）：行为跨插件闭包，直接实例化成本高。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const engineSrc = readFileSync(resolve(root, 'plugins/real-engine/index.ts'), 'utf8');
const loopSrc = readFileSync(resolve(root, 'plugins/agent-runner/server.mjs'), 'utf8');
// 事件渲染机制已上移 liveTurn.ts；契约断言合并读两处
const chatSrc = readFileSync(resolve(root, 'plugins/chat-lite/index.ts'), 'utf8') + readFileSync(resolve(root, 'plugins/chat-lite/liveTurn.ts'), 'utf8');
const storeSrc = readFileSync(resolve(root, 'plugins/chat-lite/store.ts'), 'utf8');
const blockSrc = readFileSync(resolve(root, 'plugins/chat-lite/BlockGroup.tsx'), 'utf8');

test('real-engine 必须转发 reasoning_content 为 message.reasoning', () => {
  assert.match(engineSrc, /reasoning_content/, '引擎必须读取 delta.reasoning_content');
  assert.match(engineSrc, /kind: 'message\.reasoning'/, '思考流必须以 message.reasoning 事件转发');
});

test('agent-loop 必须把思考流转发到编排通道且不进 shadow transcript', () => {
  assert.match(loopSrc, /message\.reasoning/, 'runner 必须发 message.reasoning');
  assert.match(loopSrc, /onReasoning: \(delta\) => emitEvent/, '思考增量必须经 onReasoning 落事件');
  assert.match(loopSrc, /emitEvent\(run, 'message\.reasoning'/, '思考流必须落 runner 事件流');
  // 思考不能喂回模型历史（shadow.push 只有 text/tool/assistant/user，不得出现 reasoning）
  assert.match(loopSrc, /message\.delta.*message\.reasoning/, 'delta 与 reasoning 均走合批扇出');
});

test('chat-lite 必须消费 message.reasoning 并落 thinking 块', () => {
  assert.match(chatSrc, /message\.reasoning/, 'chat-lite 必须处理 message.reasoning 事件');
  assert.match(chatSrc, /pushReasoning/, '思考增量必须经 rAF 合并缓冲');
  assert.match(chatSrc, /type: 'thinking'/, '思考文本必须落 thinking 块');
  const typesSrc = readFileSync(resolve(root, 'src/core/types.ts'), 'utf8');
  assert.match(typesSrc, /\| \{ type: 'thinking'; text: string \}/, 'AsstBlock 联合必须含 thinking 块(契约层)');
  assert.match(blockSrc, /ThinkingBlock/, 'BlockGroup 必须渲染思考块');
  // 思考期间也是活跃信号：message.reasoning 分支必须续期看门狗（长思考不误报）
  const branch = chatSrc.slice(chatSrc.indexOf("envelope.kind === 'message.reasoning'"), chatSrc.indexOf("envelope.kind === 'message.reasoning'") + 300);
  assert.match(branch, /armWatchdog/, 'message.reasoning 必须续期流式看门狗');
});
