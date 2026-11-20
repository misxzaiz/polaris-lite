/**
 * 能力合并层纯函数测试（detect.ts mergeModelCaps）。
 * 模板：tests/context-compact.test.mjs（--experimental-strip-types 直跑插件 TS）。
 * 核心契约（2026-11-21 MOSI 实测定稿）：
 * - manual 永不被覆盖；
 * - builtin → catalog 只填未知 → probe 覆盖 → reveal（网关限值）最高优先；
 * - 目录值只作初值（实测目录限值输出/输入两个方向都会错）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeModelCaps } from '../plugins/model-admin/detect.ts';

const NOW = 1_700_000_000_000;

const model = (caps = {}, id = 'nex-n2.6') => ({
  id,
  capabilities: { maxInputTokens: 0, maxOutputTokens: 0, effort: null, vision: false, ...caps },
});

test('manual 值永不被识别覆盖', () => {
  const m = model({ maxOutputTokens: 131072, detected: 'manual', detectedAt: 1 });
  const r = mergeModelCaps(m, {
    catalogIds: ['nex-n2.6'],
    catalogEntries: { 'nex-n2.6': { providerId: 'kilo', id: 'nex-agi/nex-n2.6', maxInputTokens: 262144, maxOutputTokens: 235929, toolCall: true, reasoning: true, vision: true, effortValues: ['medium', 'high'] } },
    notes: [],
    probes: { 'nex-n2.6': { vision: false, effort: 'low', outputLimit: { kind: 'revealed', limit: 999 }, tools: false, thinking: { eatsBudget: false, canDisable: true } } },
  }, NOW);
  assert.equal(r.model.capabilities.maxOutputTokens, 131072);
  assert.equal(r.model.capabilities.detected, 'manual');
  assert.equal(r.model.capabilities.detectedAt, 1);
  assert.ok(r.notes.some((n) => n.includes('人工编辑值')));
});

test('builtin 兜底 + catalog 只填未知（0/null），不改已有值', () => {
  const r = mergeModelCaps(model(), {
    catalogIds: ['nex-n2.6'],
    catalogEntries: { 'nex-n2.6': { providerId: 'kilo', id: 'nex-agi/nex-n2.6', maxInputTokens: 262144, maxOutputTokens: 235929, toolCall: true, reasoning: true, vision: true, effortValues: ['medium', 'high'] } },
    notes: [],
    probes: {},
  }, NOW);
  // 内置表 nex* 是 0/0「不猜」，目录把输入/输出/工具/视觉补成初值
  assert.equal(r.model.capabilities.maxInputTokens, 262144);
  assert.equal(r.model.capabilities.maxOutputTokens, 235929);
  assert.equal(r.model.capabilities.tools, true);
  assert.equal(r.model.capabilities.vision, true);
  assert.equal(r.model.capabilities.detected, 'catalog');
  assert.equal(r.model.capabilities.detectedAt, NOW);
  assert.ok(r.notes.some((n) => n.includes('目录思考档位：medium/high')));
});

test('reveal（网关限值揭示）覆盖 catalog 输出上限，标记取最高来源', () => {
  const r = mergeModelCaps(model(), {
    catalogIds: null,
    catalogEntries: { 'nex-n2.6': { providerId: 'kilo', id: 'nex-agi/nex-n2.6', maxInputTokens: 262144, maxOutputTokens: 235929, toolCall: true, reasoning: true, vision: null, effortValues: null } },
    notes: [],
    probes: { 'nex-n2.6': { vision: true, effort: 'low', outputLimit: { kind: 'revealed', limit: 131072 }, tools: true, thinking: { eatsBudget: true, canDisable: false } } },
  }, NOW);
  // 目录说 235929，网关揭示 131072——以网关为准（实测 MOSI 行为）
  assert.equal(r.model.capabilities.maxOutputTokens, 131072);
  assert.equal(r.model.capabilities.tools, true);
  assert.equal(r.model.capabilities.reasoningEatsBudget, true);
  assert.equal(r.model.capabilities.canDisableThinking, false);
  assert.equal(r.model.capabilities.vision, true);
  assert.equal(r.model.capabilities.detected, 'reveal');
  assert.ok(r.notes.some((n) => n.includes('网关限值报错揭示')));
  assert.ok(r.notes.some((n) => n.includes('思考可关：否')));
  assert.ok(r.notes.some((n) => n.includes('思考吃输出预算：是')));
});

test('effort 参数被接受则写入（保留旧行为），宽松网关忽略无害', () => {
  const r = mergeModelCaps(model({}, 'gpt-4o'), {
    catalogIds: null, notes: [],
    probes: { 'gpt-4o': { vision: true, effort: 'low', outputLimit: { kind: 'lenient', limit: null }, tools: null, thinking: null } },
  }, NOW);
  assert.equal(r.model.capabilities.effort, 'low');
  assert.ok(r.notes.some((n) => n.includes('参数被接受（low）')));
  assert.ok(r.notes.some((n) => n.includes('网关不校验输出上限')));
});

test('probe 失败 ≠ 能力为无：null 全部保留原值', () => {
  // id='x'：不命中内置表（nex-n2.6 会命中 nex* 0/0 行）
  const m = model({ maxInputTokens: 128000, maxOutputTokens: 4096, vision: true, tools: true }, 'x');
  const r = mergeModelCaps(m, {
    catalogIds: null, notes: [],
    probes: { 'x': { vision: null, effort: 'unknown', outputLimit: { kind: 'unknown', limit: null }, tools: null, thinking: { eatsBudget: null, canDisable: null } } },
  }, NOW);
  assert.equal(r.model.capabilities.maxInputTokens, 128000);
  assert.equal(r.model.capabilities.maxOutputTokens, 4096);
  assert.equal(r.model.capabilities.vision, true);
  assert.equal(r.model.capabilities.tools, true);
  assert.ok(r.notes.some((n) => n.includes('图片输入：无法判定')));
  assert.ok(r.notes.some((n) => n.includes('工具调用：无法判定')));
});

test('deep 差分结论进 notes（生效性/旋钮）', () => {
  const r = mergeModelCaps(model(), {
    catalogIds: null, notes: [],
    probes: { 'nex-n2.6': { vision: null, effort: 'low', outputLimit: null, tools: null, thinking: null, deep: { effortAccepted: true, effortHonored: false, budgetKnob: 'budget_tokens' } } },
  }, NOW);
  assert.ok(r.notes.some((n) => n.includes('被接受但不生效')));
  assert.ok(r.notes.some((n) => n.includes('思考旋钮：budget_tokens')));
});
