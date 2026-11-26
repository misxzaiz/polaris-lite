/**
 * 无人值守（用户长期不看）执行链路回归测试。
 *
 * 守护三条曾在会话期间反复回退的不变量：
 *  1. 审批卡超时 = 自动拒绝，但必须喂回 AI「可执行的继续指令」，而不是笼统的"用户拒绝"；
 *  2. 交互卡超时（__timeout）必须告诉 AI 用已有信息继续，不要空等；
 *  3. chat-lite 看门狗：流式短看门狗与工具阶段长看门狗必须独立，工具阶段超时
 *     不得 settle/unbind（否则后台编排继续跑、UI 却停止监听 → 结果丢失 + 串台）。
 *
 * 采用源码级断言（与 arch/server-boundary 测试同风格）：这些行为跨插件闭包，
 * 直接实例化成本高，但「文案策略 + timer 生命周期」是最易被无意改坏的契约。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const loopSrc = readFileSync(resolve(root, 'plugins/agent-runner/server.mjs'), 'utf8');
const chatSrc = readFileSync(resolve(root, 'plugins/chat-lite/index.ts'), 'utf8');
const askSrc = readFileSync(resolve(root, 'plugins/interactive-cards/index.ts'), 'utf8');

test('审批超时与用户主动拒绝分离：resolve timeout，且 emit 携带 autoRejected', () => {
  assert.match(loopSrc, /resolveDecision\('timeout'\)/, '超时分支必须 resolve timeout');
  assert.match(loopSrc, /autoRejected: true/, '超时分支必须置 autoRejected 标志');
  assert.match(loopSrc, /decision: 'deny', autoRejected: true/, '超时必须映射为 deny+autoRejected（UI 据此区分）');
  assert.match(loopSrc, /tool\.approval\.resolved'[\s\S]{0,180}autoRejected/, 'resolved 事件必须带 autoRejected 供 UI 区分');
});

test('超时拒绝喂回 AI 的文案必须是可执行的继续指令', () => {
  assert.match(loopSrc, /verdict === 'timeout'[\s\S]{0,400}无人值守/, 'timeout 文案应标注无人值守');
  assert.match(loopSrc, /verdict === 'timeout'[\s\S]{0,400}改用/, 'timeout 文案应提示改用安全方式');
  assert.match(loopSrc, /verdict === 'timeout'[\s\S]{0,400}不要停下等待/, 'timeout 文案应明确不要停下等待');
  assert.match(loopSrc, /verdict === 'timeout'[\s\S]{0,400}不要原样重试/, 'timeout 文案应禁止原样重试被拒命令');
});

test('交互卡超时返回 __timeout，且喂回 AI 提示用已有信息继续', () => {
  assert.match(askSrc, /resolve\(\{ __timeout: true \}\)/, '交互卡超时必须返回 __timeout');
  assert.match(loopSrc, /__timeout/, 'runner 必须识别 __timeout');
  assert.match(loopSrc, /不要原样重试/, '被拒工具应提示不要原样重试');
  assert.match(loopSrc, /改用不需要危险权限的安全方式/, '被拒工具应提示改用安全方式');
});

test('看门狗短/长 timer 独立，且两条都不误收敛', () => {
  assert.match(chatSrc, /let streamWatchdog/, '必须存在独立的流式看门狗变量');
  assert.match(chatSrc, /let phaseWatchdog/, '必须存在独立的工具阶段看门狗变量');
  assert.match(chatSrc, /armWatchdog = [^}]*if \(phaseWatchdog\) return/, '流式看门狗在进入工具阶段后必须让位');
  // 两条看门狗的超时分支都只走 showIdleHint，绝不调用 settle（settle 会 unbind → 后台结果丢失）
  assert.match(chatSrc, /const showIdleHint/, '必须存在统一的软提示函数');
  assert.match(chatSrc, /绝不 settle \/ unbind/, '软提示函数须声明不收敛');
  for (const markerName of ['streamWatchdog = setTimeout', 'phaseWatchdog = setTimeout']) {
    const marker = chatSrc.indexOf(markerName);
    assert.ok(marker > 0, `应存在 ${markerName}`);
    const branch = chatSrc.slice(marker, marker + 400);
    assert.match(branch, /showIdleHint/, `${markerName} 超时必须走软提示`);
    assert.doesNotMatch(branch, /\n\s*settle\(\);/, `${markerName} 超时不得调用 settle（会 unbind 导致后台结果丢失）`);
  }
  // 收敛只由后端权威信号触发：message.done / stream.error 两处 settle 仍在
  assert.match(chatSrc, /message\.delta[\s\S]{0,300}message\.done[\s\S]{0,60}settle\(\)/, 'message.done 仍须收敛');
});

test('超时阈值关系自洽：审批与交互卡上限均小于工具阶段看门狗兜底', () => {
  const approvalMs = Number(loopSrc.match(/APPROVAL_TIMEOUT_MS = (\d+)/)?.[1]);
  const askMs = Number(askSrc.match(/ASK_TIMEOUT_MS = (\d+)/)?.[1]);
  const phaseMs = Number(chatSrc.match(/TOOL_PHASE_TIMEOUT_MS = ([\d_]+)/)?.[1]?.replace(/_/g, ''));
  const streamMs = Number(chatSrc.match(/STREAM_IDLE_TIMEOUT_MS = ([\d_]+)/)?.[1]?.replace(/_/g, ''));
  assert.ok(approvalMs > 0 && askMs > 0 && phaseMs > 0 && streamMs > 0, '所有超时常量必须可解析');
  assert.ok(streamMs < phaseMs, '流式看门狗必须短于工具阶段看门狗');
  assert.ok(streamMs >= 60_000, `流式阈值 ${streamMs}ms 太短，reasoning 模型长思考会被误判（用户已遇到 30s 误杀）`);
  assert.ok(approvalMs < phaseMs, `审批上限 ${approvalMs} 必须小于工具阶段兜底 ${phaseMs}，否则单轮审批就触发误判`);
  assert.ok(askMs < phaseMs, `交互卡上限 ${askMs} 必须小于工具阶段兜底 ${phaseMs}`);
});
