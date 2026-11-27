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
// v3 起函数体含多行比较器（内部就有 "  }"），且泛型签名 <T extends {...}> 内含 "{"：
// 先跳过泛型段（剥到函数体开括号），再闭括号配平提取完整函数体。
const fnSrc = (() => {
  if (fnStart < 0) return null;
  const genericEnd = storeSrc.indexOf('>(sessions', fnStart);
  if (genericEnd < 0) return null;
  let depth = 0;
  for (let i = genericEnd; i < storeSrc.length; i++) {
    if (storeSrc[i] === '{') depth++;
    else if (storeSrc[i] === '}') { depth--; if (depth === 0) return storeSrc.slice(fnStart, i + 1); }
  }
  return null;
})();
assert.ok(fnSrc, 'store.ts 必须导出 sortSessions');
// new Function 不吃 TS 泛型参数——剥掉 <T extends ...> 再求值（仅本测试的运行时自证）
// v3 签名 <T extends { createdAt: number; pinned?: boolean }> 含内层 ">"，
// 简单的 [^>]* 剥不干净——用大括号配平找到 extends {...} 的结束再剥。
const jsFn = (() => {
  let s = fnSrc.replace(/^export function/, 'function');
  const m = s.match(/<T extends /);
  if (m) {
    const gStart = s.indexOf('{', m.index);
    let depth = 0;
    for (let i = gStart; i < s.length; i++) {
      if (s[i] === '{') depth++;
      else if (s[i] === '}') { depth--; if (depth === 0) { s = s.slice(0, m.index) + s.slice(i + 1); break; } }
    }
  }
  // 剥掉泛型段后残留的孤立 ">"（签名 <T extends {...}> 的收尖括号）一并清除
  s = s.replace(/^function\s+sortSessions>*/, 'function sortSessions');
  return s.replace(/\(sessions: T\[\]\)/, '(sessions)').replace(/\)\s*:\s*T\[\]\s*\{/, ') {');
})();
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

test('sortSessions v3：置顶组常驻最前，组内仍按 createdAt 倒序；非置顶保持原有顺序', () => {
  const list = [
    { id: 'old-pin', createdAt: 100, pinned: true },
    { id: 'new', createdAt: 500 },
    { id: 'new-pin', createdAt: 400, pinned: true },
    { id: 'mid', createdAt: 300 },
  ];
  const sorted = sortSessions(list);
  assert.deepEqual(sorted.map((s) => s.id), ['new-pin', 'old-pin', 'new', 'mid']);
});

// ---- 服务端快照合并不得污染排序（回归：拉取导致的列表颠倒） ----
// 成因：applyServerSnapshot 曾对每条拉回的快照 touch()——拉取按索引（新→旧）逐条
// 进行，晚拉到的旧会话反而拿到更大的本地时间戳，列表整体颠倒（最新沉底）。
// 修复后：合并保留服务端权威 lastActiveAt。此处断言源码不再含 touch 合并。
test('applyServerSnapshot：合并保留服务端 lastActiveAt，不做本地 touch（排序不颠倒回归）', () => {
  const snapStart = storeSrc.indexOf('function applyServerSnapshot');
  assert.ok(snapStart >= 0, 'store.ts 必须含 applyServerSnapshot');
  // 边界查找 CRLF/LF 兼容（与上方 sortSessions 提取同一修法）：
const snapEnd = (() => {
  const crlf = storeSrc.indexOf("\r\n}\r\n", snapStart);
  if (crlf > snapStart) return crlf + 2;
  return storeSrc.indexOf("\n}\n", snapStart);
})();
  const snapSrc = storeSrc.slice(snapStart, snapEnd);
  assert.ok(!/\btouch\s*\(/.test(snapSrc),
    'applyServerSnapshot 不得调用 touch()——拉取逐条进行，touch 会把后拉的旧会话排到最前（bug：最新会话沉底）');
});
