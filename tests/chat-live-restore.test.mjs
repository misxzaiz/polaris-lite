/**
 * 「重开/切回执行中的会话」实时渲染契约（源码守卫）。
 *
 * 事故（2026-11-26）：页面关闭重开后，工具卡要等下一段正文落盘才一起出现，
 * 输入框显示「已结束」而非「停止」。根因是刷新恢复只重建了 SSE 订阅，
 * 没有消费者接事件，也没有把 assistant 消息复位成 streaming。
 *
 * 后续改动若把这几条拆掉（例如恢复时又从 0 重放、或先订阅后挂渲染器），
 * 症状会原样回来，故在此守住：
 * 1. 服务端 /state 必须给出 syncedSeq（已落档游标），恢复从它起放；
 * 2. 恢复流程必须先挂渲染器再订阅（重放会立刻投递）；
 * 3. 挂载时把消息复位 streaming:true，并按 runnerOwned 跳过本端推送；
 * 4. 收敛后解除占用并补一次对账。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');

test('agent-runner /state 暴露 syncedSeq（重开放从已落档位置起）', () => {
  const src = read('plugins/agent-runner/server.mjs');
  const stateBlock = src.slice(src.indexOf("pathname === '/api/agent/state'"), src.indexOf("pathname === '/api/agent/state'") + 900);
  assert.match(stateBlock, /running: !run\.finished/, '状态端点仍需返回 running');
  assert.match(stateBlock, /syncedSeq: run\.syncedSeq \?\? 0/, '/state 必须带 syncedSeq：前台重放若从 0 起会把已落档正文再追加一遍');
  assert.match(stateBlock, /assistantId: run\.assistantId/, '/state 必须带 assistantId（恢复时定位消息）');
});

test('runnerBridge：恢复从 syncedSeq 起放，并交给上层挂渲染器', () => {
  const src = read('plugins/chat-lite/runnerBridge.ts');
  assert.match(src, /lastSeq: Number\(data\.syncedSeq\) \|\| 0/, 'Attach 的 lastSeq 必须取服务端 syncedSeq');
  assert.match(src, /setRunnerRestoreHandler/, '恢复必须经上层注册的处理器（否则订阅了也没人渲染）');
  const fn = src.slice(src.indexOf('export async function restoreRunnerRuns'), src.indexOf('export function closeRunnerSession'));
  assert.match(fn, /if \(!handler\) return/, '未注册处理器时不得静默订阅');
  assert.match(fn, /if \(!handler\(att\)\) missing\.push/, '挂载失败要记下来重试（会话还没拉到本地）');
});

test('liveTurn：先挂渲染器再订阅，且恢复时复位 streaming', () => {
  const src = read('plugins/chat-lite/liveTurn.ts');
  const attach = src.slice(src.indexOf('export function attachRunnerLive'), src.indexOf('export function attachRunnerLive') + 2200);
  assert.match(attach, /streaming: true/, '恢复必须把 assistant 消息复位成 streaming（否则输入框显示「已结束」）');
  assert.match(attach, /markRunnerOwned\(sid\)/, 'runner 直写的会话本端不参与推送');
  const createAt = attach.indexOf('createLiveTurn(');
  const subscribeAt = attach.indexOf('subscribeRunner(att)');
  assert.ok(createAt > 0 && subscribeAt > 0, '挂载必须同时创建渲染器与订阅');
  assert.ok(createAt < subscribeAt, '必须「先渲染器、后订阅」：订阅会立刻重放，反过来首批事件（常是 tool.card）会被丢掉');
});

test('liveTurn：收敛只认权威信号，并解除占用 + 补对账', () => {
  const src = read('plugins/chat-lite/liveTurn.ts');
  assert.match(src, /unmarkRunnerOwned\(sid\)/, '收敛后必须解除 runnerOwned（否则不再对账）');
  assert.match(src, /setRunnerEndedHook\(\(sid\) => \{ liveTurns\.get\(sid\)\?\.settle\(\); \}\)/, 'run-ended 必须兜底收敛（done 丢失时不会永久 streaming）');
  assert.match(src, /setTimeout\(\(\) => \{ void pullNow\(\); \}, 800\)/, '收敛后补一次对账拿服务端最终版');
  // 看门狗绝不可收敛（后台长编排会被误杀）
  const wd = src.slice(src.indexOf('const showIdleHint'), src.indexOf('const handleEnvelope'));
  assert.doesNotMatch(wd, /\n\s*settle\(\);/, '看门狗超时只软提示，不得 settle');
});

test('chat-lite：发送/续写/恢复共用同一渲染器（不允许第二份实现）', () => {
  const src = read('plugins/chat-lite/index.ts');
  assert.match(src, /createLiveTurn\(\{/, '发送路径必须用 liveTurn 渲染器');
  assert.match(src, /attachRunnerLive\(att, restoredHooks\(\)\)/, '刷新恢复必须挂同一渲染器');
  assert.match(src, /setRunnerAttach\(/, '切进执行中的会话也要接实时流');
  const byId = src.indexOf('export function resumeTruncated');
  const resume = src.slice(byId, byId + 1200);
  assert.match(resume, /createLiveTurn\(/, '续写路径必须复用同一渲染器（旧实现另挂 consumer 会顶掉全局消费者）');
  assert.doesNotMatch(src, /setRunnerConsumer\(/, '不允许再直接改 runner 消费者：由 liveTurn 统一按 sessionId 路由');
});
