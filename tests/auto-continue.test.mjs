/**
 * 输出越界闭环跨插件契约测试（源码级断言，模板：tests/stream-retry.test.mjs——
 * 引擎→编排→UI 的行为闭包跨插件实例化成本高，用源码契约锁定关键环）。
 *
 * 锁定契约（2026-11-21 方案定稿）：
 * - real-engine：stream_options 主动索取（方言拒绝拉黑）、max_tokens 兜底 8192、
 *   length 时半截 tool_calls 以 partialToolCalls 上报（不再静默丢弃）、
 *   400 限值自愈（输出上限回填重试 / 输入超限回填不重试）；
 * - agent-loop：length 自动续写 burst≤3（tool-truncated / text-truncated /
 *   reasoning-exhausted 三路径）、resume 动作（无 prompt、直通模式拒入）；
 * - chat-lite：truncated 块带「继续」按钮、message.continued 落轻提示、
 *   resumeTruncated 不注入 prompt。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(p, 'utf8');
const loopSrc = read('plugins/agent-runner/server.mjs');
const engineSrc = read('plugins/real-engine/index.ts');
// 事件渲染机制已上移 liveTurn.ts（发起端与重开恢复共用），契约断言合并读两处
const chatSrc = read('plugins/chat-lite/index.ts') + read('plugins/chat-lite/liveTurn.ts');
const blockSrc = read('plugins/chat-lite/BlockGroup.tsx');
const storeSrc = read('plugins/chat-lite/store.ts');
// 消息模型已上移契约层(host-slimming-report P1-3):块类型的事实源在 src/core/types.ts,经 @sdk 暴露
const typesSrc = read('src/core/types.ts');

test('real-engine：usage 帧主动索取 + 方言拉黑守卫', () => {
  assert.match(engineSrc, /include_usage: true/, '请求体必须带 stream_options.include_usage（被动校准依赖）');
  assert.match(engineSrc, /streamOptionsBlocked\.add\(provider\.id\)/, '400 提到 stream_options 时拉黑该供应商并重试');
});

test('real-engine：max_tokens 兜底 8192（不再裸奔上游默认值）', () => {
  assert.match(engineSrc, /DEFAULT_MAX_OUTPUT_TOKENS = 8192/);
  assert.doesNotMatch(engineSrc, /caps\.maxOutputTokens > 0 \? \{ max_tokens/, '旧的条件发送形态必须移除');
});

test('real-engine：length 截断时半截 tool_calls 以 partialToolCalls 上报', () => {
  assert.match(engineSrc, /partialToolCalls/);
  assert.match(engineSrc, /finishReason && finishReason !== 'tool_calls' \? toolAcc\.size : 0/, 'length 路径必须携带半截工具调用数');
});

test('real-engine：400 限值自愈（输出回填重试 / 输入回填不重试）', () => {
  assert.match(engineSrc, /classifyLimitError/);
  assert.match(engineSrc, /noteProbeLimits/);
  assert.match(engineSrc, /上下文超限（输入超过该模型上限/, '输入超限必须给可读错误（不盲目重试）');
});

test('agent-runner（服务端编排）：自动续写 burst 限次 + 三路径 nudge', () => {
  assert.match(loopSrc, /autoContinueLeft = 3/);
  assert.match(loopSrc, /message\.continued/, '每次自动续写必须发进度事件');
  assert.match(loopSrc, /个工具调用时被单次输出上限截断/, '半截工具调用必须引导重新调用');
  assert.match(loopSrc, /reasoning-exhausted/);
  assert.match(loopSrc, /把单次输出预算耗在思考上/, '空正文（思考吃光预算）必须引导直出结论');
  assert.match(loopSrc, /message\.truncated/, 'burst 耗尽后仍落可见截断块（兜底 UI 的数据源）');
});

test('agent-runner：resume 端点（无 prompt 直续 shadow + 并发单飞）', () => {
  assert.match(loopSrc, /\/api\/agent\/resume/, '服务端必须提供 resume 端点');
  assert.match(loopSrc, /shadow: \[\.\.\.snap\.shadow\]/, 'resume 复用上一 run 的 shadow 直接接续');
  assert.match(loopSrc, /resumableRuns/, 'resume 快照需有界缓存');
});

test('chat-lite：truncated 块 + 「继续」按钮 + resumed 无 prompt', () => {
  assert.match(typesSrc, /\{ type: 'truncated'; text: string \}/, '块类型联合必须含 truncated(契约层)');
  assert.match(blockSrc, /tc-resume-btn/);
  assert.match(chatSrc, /resumeTruncated/);
  // resume 经服务端端点：只带 sessionId/messageId，不注入 prompt（prefill 续写语义）
  assert.match(chatSrc, /resumeRunnerRun/, 'chat-lite 必须经服务端 resume');
  assert.match(chatSrc, /resumeTruncated/, 'chat-lite 必须有续写入口');
});

test('chat-lite：message.continued 落轻提示块', () => {
  assert.match(typesSrc, /\{ type: 'notice'; text: string \}/);
  assert.match(chatSrc, /message\.continued/, '编排事件必须有对应处理分支');
});
