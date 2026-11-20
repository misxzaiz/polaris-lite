/**
 * 会话相邻切换纯函数回归（chat-input-session-nav-plan §5.2）。
 * 纯函数零依赖，直接 node:test 跑 TS 源。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { neighbors, sessionLabel } from '../plugins/chat-lite/session-nav.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

// ---- 会话列表排序（多设备共享 spec：按最后活跃时间新→旧） ----
// sortSessions 是纯函数，但 store.ts 依赖无扩展名相对导入（node 解析不了），
// 这里从源码提取函数体自证（与 reasoning.test.mjs 的源码级断言同风格）。
const storeSrc = readFileSync(resolve(root, 'plugins/chat-lite/store.ts'), 'utf8');
const fnStart = storeSrc.indexOf('export function sortSessions');
const fnEnd = storeSrc.indexOf(String.fromCharCode(10) + '}' + String.fromCharCode(10), fnStart);
const fnSrc = fnStart >= 0 && fnEnd > fnStart ? storeSrc.slice(fnStart, fnEnd + 2) : null;
assert.ok(fnSrc, 'store.ts 必须导出 sortSessions');
// new Function 不吃 TS 泛型参数——剥掉 <T extends ...> 再求值（仅本测试的运行时自证）
const jsFn = fnSrc.replace(/^export function/, 'function').replace(/<T extends[^>]*>/, '').replace(/\(sessions: T\[\]\)/, '(sessions)').replace(/\)\s*:\s*T\[\]\s*\{/, ') {');
const sortSessions = new Function(`return (${jsFn})`)();

test('sortSessions：按 lastActiveAt 倒序，缺省回退 createdAt', () => {
  const list = [
    { id: 'old', createdAt: 100, lastActiveAt: 100 },
    { id: 'new', createdAt: 300, lastActiveAt: 300 },
    { id: 'mid', createdAt: 200, lastActiveAt: 200 },
    { id: 'legacy', createdAt: 250 },
  ];
  const sorted = sortSessions(list);
  assert.deepEqual(sorted.map((s) => s.id), ['new', 'legacy', 'mid', 'old']);
});

test('sortSessions：不修改入参数组（纯函数）', () => {
  const list = [{ id: 'a', createdAt: 1 }, { id: 'b', createdAt: 2 }];
  const copy = [...list];
  sortSessions(list);
  assert.deepEqual(list, copy);
});
