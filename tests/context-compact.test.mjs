/**
 * 上下文压缩纯逻辑回归测试（plugins/shared/context-compact.ts）。
 *
 * 对齐 simple_ai/compact.rs 已验证语义（spec：docs/context-insight-plan.md §6）：
 * - 压缩范围按工具配对边界回退（不切断 assistant.tool_calls ↔ tool）；
 * - 区间过小跳过；分段只在 user 边界切；序列化保头保尾；
 * - 压缩失败/空摘要回滚（非破坏），绝不丢历史。
 *
 * 纯函数、无 React、无 DOM、无 fetch（complete 由测试注入），直接跑 TS 源码。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UsageAccumulator,
  selectCompactRange,
  segmentRange,
  serializeMessage,
  estimateTokens,
  compactShadow,
  COMPACT_INSTRUCTION,
  COMPACT_ROLLING_INSTRUCTION,
} from '../plugins/shared/context-compact.ts';

/** 快捷造消息 */
const sys = (t) => ({ role: 'system', content: t });
const user = (t) => ({ role: 'user', content: t });
const asst = (t, toolCalls) => ({ role: 'assistant', content: t, ...(toolCalls ? { tool_calls: toolCalls } : {}) });
const tool = (id, t) => ({ role: 'tool', content: t, tool_call_id: id, name: 'bash' });

test('selectCompactRange：起点跳过 system，终点按 keepRecent 留尾', () => {
  const msgs = [sys('s'), user('u1'), asst('a1'), user('u2'), asst('a2'), user('u3'), asst('a3')];
  const r = selectCompactRange(msgs, 2);
  assert.ok(r, '足够长时应给出区间');
  assert.equal(r.start, 1);
  assert.equal(r.end, msgs.length - 2);
});

test('selectCompactRange：保留区首条是孤儿 tool → 整组回退（不切断配对）', () => {
  const tc = (id) => [{ id, type: 'function', function: { name: 'bash', arguments: '{}' } }];
  // end 落在 tool 上：u1,a1(tc),tool 占 2-4；u2,a2 占 5-6；末尾接 tool
  const msgs2 = [
    sys('s'), user('u1'), asst('a1', tc('c1')), tool('c1', 'out1'),
    user('u2'), asst('a2'), tool('c9', 'late-tool'),
  ];
  const r2 = selectCompactRange(msgs2, 1); // end=6 → messages[6] 是 tool → 回退到 5（user u2）
  assert.ok(r2, '应给出区间');
  assert.equal(r2.end, 5, '孤儿 tool 应整组回退出压缩区');
  assert.notEqual(msgs2[r2.end]?.role, 'tool', '回退后保留区首条不得是 tool');
  // 配对完整性：压缩区间内每个 assistant(tool_calls) 的 tool 结果也在区间内
  const r3 = selectCompactRange([sys('s'), user('u1'), asst('a1', tc('c1')), tool('c1', 'x'), user('u2'), asst('a2'), user('u3'), asst('a3')], 3);
  assert.ok(r3, '常规形态应有区间');
  assert.notEqual(msgs2[r3.end]?.role, 'tool');
});

test('selectCompactRange：区间尾是孤儿 assistant(tool_calls) → 回退到它之前', () => {
  // 构造 end-1 恰指向 assistant(tool_calls)：len=8, keepRecent=1 → end=7，下标 6 是 assistant(tool_calls)
  const tcMsg = asst('a4', [{ id: 'c2', type: 'function', function: { name: 'bash', arguments: '{}' } }]);
  const msgs = [sys('s'), user('u1'), asst('a1'), user('u2'), asst('a2'), user('u3'), tcMsg, user('u5')];
  const r = selectCompactRange(msgs, 1); // end=7 → messages[6] 是 assistant(tool_calls) → 回退到 6
  assert.ok(r);
  assert.equal(r.end, 6, '摘要区间尾不能是孤儿 assistant(tool_calls)：应回退到它之前');
  const lastInRange = msgs[r.end - 1];
  assert.ok(!(lastInRange?.role === 'assistant' && lastInRange?.tool_calls), '回退后区间尾不是 assistant(tool_calls)');
});

test('selectCompactRange：区间过小返回 null（跳过压缩）', () => {
  const msgs = [sys('s'), user('u1'), asst('a1'), user('u2'), asst('a2')];
  assert.equal(selectCompactRange(msgs, 6), null, 'keepRecent 大于可压区间时跳过');
  const tiny = [sys('s'), user('u1'), asst('a1'), user('u2')];
  assert.equal(selectCompactRange(tiny, 2), null, '区间 < 4 条跳过');
});

test('segmentRange：只在 user 消息前切（永不切断工具配对）', () => {
  // 每条 ~3000 字符 → ~750 token；预算 800 → 每 turn 自成一段
  const msgs = [
    sys('s'),
    user(`u1${'一'.repeat(3000)}`), asst('a1', [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{}' } }]), tool('c1', 'x'.repeat(3000)),
    user(`u2${'二'.repeat(3000)}`), asst('a2', [{ id: 'c2', type: 'function', function: { name: 'bash', arguments: '{}' } }]), tool('c2', 'y'.repeat(3000)),
    user('u3'), asst('a3'),
  ];
  const segs = segmentRange(msgs, 1, msgs.length, 800);
  assert.ok(segs.length >= 2, `超预算应切段，实际 ${segs.length} 段`);
  for (const s of segs) {
    // 每段首条不能是 tool（否则其 assistant(tool_calls) 被切到前段）
    assert.notEqual(msgs[s.start].role, 'tool', `段首不能是孤儿 tool：${JSON.stringify(s)}`);
    // 段内不能以 assistant(tool_calls) 结尾（其 tool 结果在下一段）
    const last = msgs[s.end - 1];
    assert.ok(!(last.role === 'assistant' && last.tool_calls), `段尾不能是孤儿 assistant(tool_calls)：${JSON.stringify(s)}`);
  }
  // 段并起来完整覆盖
  const covered = segs.reduce((n, s) => n + (s.end - s.start), 0);
  assert.equal(covered, msgs.length - 1);
});

test('segmentRange：段数封顶，余下并入最后一段', () => {
  const msgs = [sys('s')];
  for (let i = 0; i < 30; i += 1) {
    msgs.push(user(`u${i}`), asst(`a${i}`, [{ id: `c${i}`, type: 'function', function: { name: 'bash', arguments: '{}' } }]), tool(`c${i}`, 'z'.repeat(3000)));
  }
  const segs = segmentRange(msgs, 1, msgs.length, 1000);
  assert.ok(segs.length <= 12, `段数应封顶 12，实际 ${segs.length}`);
  // 段并起来应完整覆盖区间
  const covered = segs.reduce((n, s) => n + (s.end - s.start), 0);
  assert.equal(covered, msgs.length - 1);
});

test('serializeMessage：tool 结果保头保尾；args 截断', () => {
  const long = `${'H'.repeat(900)}${'T'.repeat(900)}`;
  const m = tool('c1', long);
  const s = serializeMessage(m);
  assert.ok(s.includes('H'.repeat(600).slice(0, 50)), '应保留头部');
  assert.ok(s.includes('…[truncated'), '应有截断标记');
  assert.ok(s.endsWith(long.slice(-400)), '应保留尾部');
  const m2 = asst('', [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: 'A'.repeat(500) } }]);
  const s2 = serializeMessage(m2);
  assert.ok(s2.includes('调用工具 bash('));
  assert.ok(s2.length < 400, 'args 应截断到 200 字符量级');
});

test('estimateTokens：字符 ÷4（含 tool_calls JSON）', () => {
  const msgs = [sys('abcd'), user('efgh'), asst('ijkl', [{ id: 'c', type: 'function', function: { name: 'n', arguments: '{}' } }])];
  const t = estimateTokens(msgs);
  const chars = 4 * 3 + JSON.stringify(msgs[2].tool_calls).length;
  assert.equal(t, Math.ceil(chars / 4));
});

test('UsageAccumulator：lastInput 驱动触发；resetLast 后冷却；压缩无效熔断', () => {
  const msgs = [sys('s'), user('u')];
  const acc = new UsageAccumulator();
  assert.equal(acc.shouldCompact(1000, 0.75, msgs), false, '无 usage 且消息极短不触发');
  acc.add(800);
  assert.equal(acc.shouldCompact(1000, 0.75, msgs), true, 'lastInput 800 ≥ 750 触发');
  acc.resetLast();
  assert.equal(acc.shouldCompact(1000, 0.75, msgs), false, '压缩后冷却不触发');
  acc.notePostCompactRound(true);
  assert.equal(acc.exhausted, true, '压缩后仍超阈 → 熔断');
  assert.equal(acc.shouldCompact(1000, 0.75, msgs), false, '熔断后不再触发');
});

test('compactShadow：成功替换区间为 [compacted summary]', async () => {
  const shadow = [
    sys('s'), user('u1'), asst('a1'), user('u2'), asst('a2'), user('u3'), asst('a3'),
  ];
  const complete = async ({ system, user: u }) => {
    assert.equal(system, COMPACT_INSTRUCTION);
    assert.ok(u.includes('[user]: u1'), '摘要输入应含待压消息');
    return { text: '  这是摘要。  ', truncated: false };
  };
  const outcome = await compactShadow(shadow, 200_000, 2, complete);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.removedMessages, 4);
  assert.equal(shadow.length, 4); // system + summary + u3 + a3
  assert.equal(shadow[1].role, 'user');
  assert.ok(shadow[1].content.startsWith('[compacted summary]'));
  assert.ok(shadow[1].content.includes('这是摘要'));
});

test('compactShadow：摘要请求失败 → 回滚原历史（非破坏）', async () => {
  const shadow = [sys('s'), user('u1'), asst('a1'), user('u2'), asst('a2'), user('u3'), asst('a3')];
  const before = JSON.stringify(shadow);
  const complete = async () => { throw new Error('HTTP 502'); };
  const outcome = await compactShadow(shadow, 200_000, 2, complete);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error, 'HTTP 502');
  assert.equal(JSON.stringify(shadow), before, '失败必须回滚，历史一条不丢');
});

test('compactShadow：空摘要 → 回滚；区间过小 → range-too-small', async () => {
  const shadow = [sys('s'), user('u1'), asst('a1'), user('u2'), asst('a2'), user('u3'), asst('a3')];
  const before = JSON.stringify(shadow);
  const empty = await compactShadow(shadow, 200_000, 2, async () => ({ text: '   ', truncated: false }));
  assert.equal(empty.ok, false);
  assert.equal(empty.error, 'empty-summary');
  assert.equal(JSON.stringify(shadow), before, '空摘要也回滚');
  const small = await compactShadow([sys('s'), user('u1'), asst('a1'), user('u2')], 200_000, 6, async () => ({ text: 'x', truncated: false }));
  assert.equal(small.error, 'range-too-small');
});

test('compactShadow：截断后加大预算重试一次', async () => {
  const shadow = [sys('s'), user('u1'), asst('a1'), user('u2'), asst('a2'), user('u3'), asst('a3')];
  const budgets = [];
  const instructions = [];
  let call = 0;
  const complete = async ({ system, maxTokens }) => {
    budgets.push(maxTokens);
    instructions.push(system);
    call += 1;
    if (call === 1) return { text: '', truncated: true }; // 第一次截断（content 空 + reasoning 存在的表现形态由上层归一）
    return { text: '重试后的完整摘要', truncated: false };
  };
  const outcome = await compactShadow(shadow, 200_000, 2, complete);
  assert.equal(outcome.ok, true);
  assert.deepEqual(budgets, [2048, 4096], '第一次 2048，重试 4096');
  assert.equal(instructions[1], `${COMPACT_INSTRUCTION}\nOutput the summary directly. Do NOT show any thinking or reasoning process.`);
  assert.ok(outcome.summary.includes('重试后的完整摘要'));
});

test('compactShadow：超预算区间走滚动分段（首段普通摘要，后续带 existing_summary 合并）', async () => {
  const shadow = [sys('s')];
  for (let i = 0; i < 8; i += 1) shadow.push(user(`任务${i}：${'细节'.repeat(1500)}`), asst(`结论${i}：${'分析'.repeat(1500)}`));
  const calls = [];
  const complete = async ({ system, user: u }) => {
    calls.push({ system, len: u.length, hasExisting: u.includes('<existing_summary>') });
    return { text: `摘要${calls.length}`, truncated: false };
  };
  // 窗口 8000：每段预算 4000 token，而区间估算 ~12000 token → 必切多段
  const outcome = await compactShadow(shadow, 8000, 2, complete);
  assert.equal(outcome.ok, true);
  assert.ok(calls.length >= 2, `超预算应多段摘要，实际 ${calls.length} 次`);
  assert.equal(calls[0].system, COMPACT_INSTRUCTION);
  for (let i = 1; i < calls.length; i += 1) {
    assert.equal(calls[i].system, COMPACT_ROLLING_INSTRUCTION, '后续段用滚动合并指令');
    assert.equal(calls[i].hasExisting, true, '后续段应携带已有摘要');
  }
  // 最终 shadow 只剩 system + summary + 尾部保留
  const summaryMsg = shadow.find((m) => m.role === 'user' && m.content.startsWith('[compacted summary]'));
  assert.ok(summaryMsg, '应存在压缩摘要消息');
});
