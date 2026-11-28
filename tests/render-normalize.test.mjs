/**
 * 渲染保底第 2/4 层测试：摄入归一（normalize.ts 纯函数直测）+ 归组打断谓词
 * 单一口径（源码契约——BlockGroup.tsx 无法在 node 下跑 JSX）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeMessages } from '../plugins/chat-lite/normalize.ts';

const bgSrc = readFileSync('plugins/chat-lite/BlockGroup.tsx', 'utf8');

// ── 摄入归一（normalizeMessages）─────────────────────────────────────────

test('归一：白名单外的块类型、缺 card 的 card 类块=毒，丢弃且留痕', () => {
  const msgs = [{
    id: 'a1', role: 'assistant', content: '', createdAt: 1,
    blocks: [
      { type: 'text', text: '正文' },
      { type: 'mystery-block', text: '未知类型' },        // 白名单外 → 丢
      { type: 'tool' },                                    // 无 card → 丢
      { type: 'interactive', card: null },                 // card 非对象 → 丢
      { type: 'tool', card: { callId: 'c1', name: 'bash', status: 'done' } }, // 合法
    ],
  }];
  const out = normalizeMessages(msgs);
  assert.equal(out.length, 1);
  const blocks = out[0].blocks;
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, 'text');
  assert.equal(blocks[1].type, 'tool');
});

test('归一：文本类块 text 非字符串兜底 String()，不丢块', () => {
  const msgs = [{ id: 'a', role: 'assistant', content: '', createdAt: 1, blocks: [{ type: 'text', text: 42 }, { type: 'thinking', text: null }] }];
  const out = normalizeMessages(msgs);
  assert.equal(out[0].blocks[0].text, '42');
  assert.equal(out[0].blocks[1].text, '');
});

test('归一：非数组 messages → []（坏会话隔离）；无 role 条目丢弃；旧形态透传', () => {
  assert.deepEqual(normalizeMessages('garbage'), []);
  assert.deepEqual(normalizeMessages(null), []);
  const mixed = [
    { noRole: true },                                       // 丢
    { id: 'u1', role: 'user', content: 'hi', createdAt: 1 }, // 透传
    { id: 'a2', role: 'assistant', content: '纯content旧形态', createdAt: 2 }, // 透传（无 blocks）
  ];
  const out = normalizeMessages(mixed);
  assert.equal(out.length, 2);
  assert.equal(out[0].role, 'user');
  assert.equal(out[1].content, '纯content旧形态');
});

test('归一：合法数据零损耗（块全字段保留、user/tool 原样）', () => {
  const card = { callId: 'c9', name: 'git', status: 'done', stdout: 'ok', extra: 'keep' };
  const msgs = [
    { id: 'u', role: 'user', content: 'q', createdAt: 1 },
    { id: 't', role: 'tool', content: '', createdAt: 2, tool: card },
    { id: 'a', role: 'assistant', content: '', createdAt: 3, blocks: [{ type: 'tool', card }], streaming: false },
  ];
  const out = normalizeMessages(msgs);
  assert.equal(out.length, 3);
  assert.equal(out[1].tool.extra, 'keep');
  assert.equal(out[2].blocks[0].card.extra, 'keep');
  assert.equal(out[2].blocks[0].card.callId, 'c9');
});

// ── 归组打断谓词单一口径（源码契约）─────────────────────────────────────

test('契约：identifyGroups 打断口径必须走 isGroupBreaker 单一谓词（不再手写）', () => {
  assert.match(bgSrc, /export function isGroupBreaker/, '谓词必须导出（可契约锁定）');
  assert.match(bgSrc, /if \(isGroupBreaker\(b\)\) flush\(\);/, 'identifyGroups 必须经谓词打断');
  // 谓词覆盖四类打断 + text 空串不打断的语义
  assert.match(bgSrc, /b\.type === 'text'\) return b\.text\.trim\(\)\.length > 0/);
  assert.match(bgSrc, /b\.type === 'interactive' \|\| b\.type === 'notice' \|\| b\.type === 'truncated'/);
  // 不再有旧的手写三连 flush 判定（口径分叉的根因）
  assert.doesNotMatch(bgSrc, /if \(b\.type === 'notice' \|\| b\.type === 'truncated'\) flush\(\)/);
});
