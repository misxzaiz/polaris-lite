/**
 * 回归契约测试（2026-11-27 故障锁定）：
 * 9c95019 重构 engineTurn 时误删 `model: run.model`，real-engine 的 runTurn
 * 收到 model=undefined，第一行 `model.activeModel` 直接抛
 * "Cannot read properties of undefined (reading 'activeModel')"——
 * 所有走 real 引擎的会话第一帧就 stream.error（codebuddy 引擎因
 * `model?.activeModel ?? 默认值` 的可选链侥幸存活，故障看起来"时有时无"）。
 *
 * 契约：agent-runner 的 engineTurn 必须把 run.model 显式透传给引擎适配器。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(p, 'utf8');
const loopSrc = read('plugins/agent-runner/server.mjs');
const engineSrc = read('plugins/real-engine/server.mjs');

test('agent-runner：engineTurn 必须向引擎适配器透传 model（run.model）', () => {
  // runTurn 调用必须以 model: run.model 开头（args 里没有 model，不传即 undefined）
  assert.match(
    loopSrc,
    /run\.engine\.runTurn\(\{\s*\n?\s*model: run\.model,/,
    'engineTurn 必须显式传 model: run.model（缺失会让 real-engine 收到 undefined）',
  );
});

test('real-engine：runTurn 的 model 消费方保持无防御（契约依赖 runner 传参）', () => {
  // 引擎侧按契约直接读 model.activeModel（不做可选链兜底）：错误必须 fail-fast
  // 在 runner 的传参契约上，而不是被 `model?.activeModel ?? ''` 掩盖成空模型请求。
  assert.match(engineSrc, /model: model\.activeModel/, 'runTurn 请求体必须直接读 model.activeModel');
});
