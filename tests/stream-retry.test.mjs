/**
 * 断流自动重试链路回归（2026-11-20「对话突然中断」修复）：
 *   中继注入 UPSTREAM_DISCONNECTED 错误帧 → real-engine 识别并自动重试（≤10 次，
 *   carry 正文续写）→ agent-loop 转发 stream.retry → chat-lite 渲染「正在重试 N/10」。
 * 此前链路每一环都吞错/装正常：中继 catch{} 正常 end()、引擎把断尾当正常 done、
 * loop 不透传、UI 静默收敛——用户只看到「说到一半突然停、零报错」。
 * 源码级断言（与 reasoning.test.mjs 同风格）：行为跨插件闭包，直接实例化成本高。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const relaySrc = readFileSync(resolve(root, 'server/relay-core.mjs'), 'utf8');
const engineSrc = readFileSync(resolve(root, 'plugins/real-engine/index.ts'), 'utf8');
const loopSrc = readFileSync(resolve(root, 'plugins/agent-runner/server.mjs'), 'utf8');
const chatSrc = readFileSync(resolve(root, 'plugins/chat-lite/index.ts'), 'utf8');
const streamSrc = readFileSync(resolve(root, 'plugins/chat-lite/MessageStream.tsx'), 'utf8');
const cssSrc = readFileSync(resolve(root, 'plugins/chat-lite/chat.css'), 'utf8');

test('中继：上游 SSE 中途断流必须注入结构化错误帧 + 服务端日志留痕', () => {
  assert.match(relaySrc, /UPSTREAM_DISCONNECTED/, '中继必须向上游断流的 SSE 追加结构化错误帧');
  assert.match(relaySrc, /console\.error\('\[relay\] 上游中断/, '断流必须在服务端日志留痕（此前 catch{} 无从查证）');
  // 不得再出现裸吞：pump 循环的 catch 必须区分「客户端断开（abort）」与「上游中断」
  assert.match(relaySrc, /upstreamBroke/, '上游中断必须被记录并穿透，不得静默吞掉');
});

test('real-engine：断流必须自动重试且上限 10 次，重试时 carry 已生成正文续写', () => {
  assert.match(engineSrc, /MAX_STREAM_RETRIES = 10/, '自动重试上限必须为 10');
  assert.match(engineSrc, /kind: 'stream\.retry'/, '每次重试必须发 stream.retry 事件（页面提示数据源）');
  assert.match(engineSrc, /role: 'assistant' as const, content: carriedText/, '重试必须把已生成正文作为尾随 assistant 消息喂回（续写不重复）');
  // 上游断流错误帧必须进重试流程，不得直接报错收敛
  // （engine-kit 接线后识别逻辑上移共享模块：断言 kit 判定函数 + 引擎调用点）
  const kitSrc = readFileSync(resolve(root, 'plugins/engine-kit/sse.ts'), 'utf8');
  assert.match(kitSrc, /code === 'UPSTREAM_DISCONNECTED'/, 'kit 必须识别中继注入的断流错误帧');
  assert.match(engineSrc, /isUpstreamDisconnectFrame\(json\)/, 'real-engine 必须经 kit 判定断流帧');
  // 达上限才报错
  assert.match(engineSrc, /上游连接反复中断/, '重试耗尽必须如实报错');
  // 不得再把「无结束标记的 EOF」当正常结束
  assert.match(engineSrc, /if \(!sawDoneMarker\) broke = true/, '无 [DONE]/finish_reason 的 EOF 必须按断流处理');
});

test('agent-loop：必须把 stream.retry 转发到编排通道（loop 会话 UI 才可见）', () => {
  assert.match(loopSrc, /'stream\.retry'/, 'runner 必须发 stream.retry');
  assert.match(loopSrc, /onRetry: \(attempt, maxAttempts\) => emitEvent/, 'stream.retry 必须经 onRetry 落事件');
  assert.match(loopSrc, /message\.truncated/, 'finish_reason=length 必须发可见截断提示');
});

test('chat-lite：stream.retry 必须渲染为页面可见的重试提示（瞬态，不污染历史）', () => {
  assert.match(chatSrc, /envelope\.kind === 'stream\.retry'/, 'chat-lite 必须消费 stream.retry');
  assert.match(chatSrc, /notifyStreamRetry/, '重试提示必须经瞬态通道通知 UI');
  assert.match(chatSrc, /export function onStreamRetry/, '必须导出 onStreamRetry 订阅通道');
  assert.match(streamSrc, /stream-retry-banner/, 'MessageStream 必须渲染重试浮层');
  assert.match(streamSrc, /正在自动重试/, '浮层文案必须包含「正在自动重试」');
  assert.match(cssSrc, /\.stream-retry-banner/, '重试浮层必须有样式');
  // 提示不得写进消息历史（appendAssistantBlock 会持久化；重试是瞬态过程）
  const retryBranch = chatSrc.slice(chatSrc.indexOf("envelope.kind === 'stream.retry'"), chatSrc.indexOf("envelope.kind === 'message.truncated'"));
  assert.doesNotMatch(retryBranch, /appendAssistantBlock/, '重试提示严禁写进消息块（污染历史）');
});
