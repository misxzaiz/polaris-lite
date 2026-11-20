/**
 * 会话相邻切换纯函数回归（chat-input-session-nav-plan §5.2）。
 * 纯函数零依赖，直接 node:test 跑 TS 源。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { neighbors, sessionLabel } from '../plugins/chat-lite/session-nav.ts';

const mk = (id, title, opts = {}) => ({
  id, title, createdAt: 0, messages: opts.messages ?? [],
  ...(opts.streaming ? { streamingMsg: true } : {}),
});
// sessions[0] 是最新（createSession 头插），[n] 最旧
const fixture = [
  mk('s-new', '新会话', { messages: [{ content: '最新的一条提问' }] }),
  mk('s-mid', '中间会话'),
  mk('s-old', '新会话', { messages: [{ content: '最早会话的首条消息内容很长会被截断' }] }),
];

test('相邻切换：next 更新 / prev 更旧，方向与下标口径一致', () => {
  const nav = neighbors(fixture, 's-mid');
  assert.equal(nav.next, 's-new');
  assert.equal(nav.prev, 's-old');
  assert.ok(nav.canNext && nav.canPrev);
});

test('到头即停：最新会话没有 next，最旧会话没有 prev（不循环）', () => {
  const newest = neighbors(fixture, 's-new');
  assert.equal(newest.next, null);
  assert.equal(newest.prev, 's-mid');
  assert.ok(!newest.canNext && newest.canPrev);
  const oldest = neighbors(fixture, 's-old');
  assert.equal(oldest.prev, null);
  assert.equal(oldest.next, 's-mid');
  assert.ok(!oldest.canPrev && oldest.canNext);
});

test('空列表 / 未知 activeId：返回空导航不抛错', () => {
  assert.deepEqual(neighbors([], 'x'), { prev: null, next: null, canPrev: false, canNext: false, label: '', streaming: false });
  assert.equal(neighbors(fixture, 'not-exist').label, '');
});

test('标题口径与侧栏一致：默认标题取首条消息前 18 字', () => {
  assert.equal(sessionLabel(fixture[0]), '最新的一条提问');
  assert.equal(sessionLabel(fixture[1]), '中间会话');
  const long = neighbors(fixture, 's-old');
  assert.equal(long.label, '最早会话的首条消息内容很长会被截断'.slice(0, 18));
});

test('streaming 标记：当前会话任一消息在流式即 true', () => {
  const withStreaming = [
    mk('a', 'A', { messages: [{ content: 'q' }, { content: '...', streaming: true }] }),
    mk('b', 'B'),
  ];
  assert.equal(neighbors(withStreaming, 'a').streaming, true);
  assert.equal(neighbors(withStreaming, 'b').streaming, false);
  assert.equal(neighbors(fixture, 's-mid').streaming, false);
});
