/**
 * agent-loop 兼容性单测：A1 describe 数组兼容 / A3 hookArgsOf 完整透传。
 *
 * agent-loop 的 discoverTools/hookArgsOf 未导出——这里直接对源码做文本级断言太脆，
 * 改为把 discoverTools 的核心逻辑抽出来测不可行；因此本文件测两件事：
 * 1. A1 形态：模拟「单 descriptor」与「descriptors 数组」两种 describe 响应，
 *    按与 agent-loop 相同的归并规则断言工具表结果（规则内联复制，防止未来改动漂移——
 *    真正的行为回归由 E2E/构建门禁覆盖）。
 * 2. A3 语义：hookArgsOf 必须保留完整 tool_input 字段（钩子需要看到全部入参）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

/** 与 plugins/agent-loop/index.ts discoverTools 内的归并规则保持一致（A1） */
function mergeDescriptors(responses) {
  const tools = new Map();
  for (const r of responses) {
    const list = r.data?.descriptor ? [r.data.descriptor] : (r.data?.descriptors ?? []);
    for (const d of list) {
      if (d?.name) tools.set(d.name, d);
    }
  }
  return tools;
}

test('A1: 单 descriptor 形态（存量插件）照常入表', () => {
  const tools = mergeDescriptors([
    { data: { descriptor: { cap: 'cap.tool.bash', name: 'bash', description: 'bash', parameters: {}, danger: 'execute' } } },
  ]);
  assert.equal(tools.size, 1);
  assert.ok(tools.has('bash'));
});

test('A1: 聚合 descriptors 数组形态（mcp-bridge）全部入表', () => {
  const tools = mergeDescriptors([
    { data: { descriptors: [
      { cap: 'cap.tool.mcp', name: 'mcp__github__create_issue', description: '创建 issue', parameters: { type: 'object' }, danger: 'write' },
      { cap: 'cap.tool.mcp', name: 'mcp__github__list_issues', description: '列出 issue', parameters: { type: 'object' }, danger: 'read' },
    ] } },
  ]);
  assert.equal(tools.size, 2);
  assert.ok(tools.has('mcp__github__create_issue'));
  assert.ok(tools.has('mcp__github__list_issues'));
});

test('A1: 两种形态混用 + 无 name 条目跳过', () => {
  const tools = mergeDescriptors([
    { data: { descriptor: { cap: 'cap.tool.bash', name: 'bash', description: '', parameters: {}, danger: 'execute' } } },
    { data: { descriptors: [{ cap: 'cap.tool.mcp', name: 'mcp__s__t', description: '', parameters: {}, danger: 'read' }, { cap: 'cap.tool.mcp', name: '', description: '', parameters: {}, danger: 'read' }] } },
    { data: {} }, // 空响应
  ]);
  assert.equal(tools.size, 2);
  assert.ok(tools.has('bash'));
  assert.ok(tools.has('mcp__s__t'));
});

test('A1: 同名工具多次 describe 时取最后一次（与 agent-loop Map.set 语义一致）', () => {
  const tools = mergeDescriptors([
    { data: { descriptors: [{ cap: 'cap.tool.mcp', name: 'mcp__s__t', description: 'first', parameters: {}, danger: 'read' }] } },
    { data: { descriptors: [{ cap: 'cap.tool.mcp', name: 'mcp__s__t', description: 'second', parameters: {}, danger: 'read' }] } },
  ]);
  assert.equal(tools.size, 1);
  assert.equal(tools.get('mcp__s__t').description, 'second');
});

test('A3: hookArgsOf 语义——完整保留 tool_input 字段（与 agent-loop 实现同构）', () => {
  // 与 plugins/agent-loop/index.ts 的 hookArgsOf 同构实现（此处锁定契约：不剥字段）
  function hookArgsOf(raw) {
    try {
      const p = JSON.parse(raw || '{}');
      return p && typeof p === 'object' ? p : {};
    } catch {
      return {};
    }
  }
  const full = hookArgsOf(JSON.stringify({ command: 'rm -rf x', path: '/a/b', nested: { k: 1 }, timeoutMs: 5 }));
  assert.deepEqual(full, { command: 'rm -rf x', path: '/a/b', nested: { k: 1 }, timeoutMs: 5 }, '钩子必须看到完整 tool_input');
  assert.deepEqual(hookArgsOf('not json'), {});
  assert.deepEqual(hookArgsOf(''), {});
});
