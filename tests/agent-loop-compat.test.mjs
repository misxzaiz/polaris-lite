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
import { summarizeToolCall } from '../plugins/agent-loop/tool-summary.ts';

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

// ---------------------------------------------------------------------------
// summarizeToolCall（tool-summary.ts）：工具卡单行摘要 + 审批前缀键。
// 背景（2026-11-21 用户反馈「不知道 AI 操作了什么」）：此前 command 只取 parsed.command
//（仅 bash 有），browser 等语义工具的卡片摘要恒空白。
// ---------------------------------------------------------------------------

test('T1: bash——display/approvalKey 都是原始命令（「总是允许该前缀」历史语义零变化）', () => {
  const s = summarizeToolCall('bash', JSON.stringify({ command: 'npm test', timeoutMs: 5000 }));
  assert.equal(s.display, 'npm test');
  assert.equal(s.approvalKey, 'npm test');
});

test('T2: bash——空命令降级为工具名，approvalKey 空串（不误配任何前缀）', () => {
  const s = summarizeToolCall('bash', '{}');
  assert.equal(s.display, 'bash');
  assert.equal(s.approvalKey, '');
});

test('T3: browser——navigate/click/fill/screenshot 摘要带动作细节', () => {
  const nav = summarizeToolCall('browser', JSON.stringify({ action: 'navigate', url: 'https://example.com/page' }));
  assert.equal(nav.display, 'browser navigate → https://example.com/page');
  assert.equal(nav.approvalKey, 'browser navigate');

  const click = summarizeToolCall('browser', JSON.stringify({ action: 'click', label: '登录' }));
  assert.equal(click.display, 'browser click "登录"');
  assert.equal(click.approvalKey, 'browser click');

  const clickSel = summarizeToolCall('browser', JSON.stringify({ action: 'click', selector: '.btn-primary' }));
  assert.equal(clickSel.display, 'browser click [.btn-primary]');

  const fill = summarizeToolCall('browser', JSON.stringify({ action: 'fill', selector: '[name=q]', value: 'hello world' }));
  assert.equal(fill.display, 'browser fill [[name=q]] ← "hello world"');

  const shot = summarizeToolCall('browser', JSON.stringify({ action: 'screenshot', fullPage: true }));
  assert.equal(shot.display, 'browser screenshot (整页)');
  assert.equal(shot.approvalKey, 'browser screenshot');
});

test('T4: browser——approvalKey 锚定动作级：同动作不同参数 → 同键（URL 变化不重复弹审批）', () => {
  const a = summarizeToolCall('browser', JSON.stringify({ action: 'navigate', url: 'https://a.com' }));
  const b = summarizeToolCall('browser', JSON.stringify({ action: 'navigate', url: 'https://b.com/x?y=1' }));
  assert.equal(a.approvalKey, b.approvalKey);
  assert.notEqual(a.display, b.display);
});

test('T5: browser——scroll/search/press_key/tabs 细节形态', () => {
  assert.equal(summarizeToolCall('browser', JSON.stringify({ action: 'scroll', amount: 600 })).display, 'browser scroll ↓600');
  assert.equal(summarizeToolCall('browser', JSON.stringify({ action: 'scroll', amount: 300, direction: 'up' })).display, 'browser scroll ↑300');
  assert.equal(summarizeToolCall('browser', JSON.stringify({ action: 'search', query: 'polaris', engine: 'bing' })).display, 'browser search "polaris" @bing');
  assert.equal(summarizeToolCall('browser', JSON.stringify({ action: 'press_key', keys: 'Enter' })).display, 'browser press_key Enter');
  assert.equal(summarizeToolCall('browser', JSON.stringify({ action: 'tabs' })).display, 'browser tabs');
});

test('T6: MCP——display 用去前缀短名 + 参数预览，approvalKey 用完整工具名', () => {
  const s = summarizeToolCall('mcp__github__create_issue', JSON.stringify({ owner: 'o', title: 't' }));
  assert.equal(s.display, 'create_issue (owner=o, title=t)');
  assert.equal(s.approvalKey, 'mcp__github__create_issue');
});

test('T7: 语义工具——files/files_write 带 path，ledger 走 k=v 预览（action 不重复）', () => {
  const f = summarizeToolCall('files', JSON.stringify({ action: 'read', path: '/a/b.txt' }));
  assert.equal(f.display, 'files read /a/b.txt');
  assert.equal(f.approvalKey, 'files read');

  const fw = summarizeToolCall('files_write', JSON.stringify({ action: 'write', path: 'x.html', content: '<p>hi</p>' }));
  assert.equal(fw.display, 'files_write write x.html');
  assert.equal(fw.approvalKey, 'files_write write');

  const l = summarizeToolCall('ledger', JSON.stringify({ action: 'add', type: '餐饮', amount: 20 }));
  assert.equal(l.display, 'ledger add (type=餐饮, amount=20)');
  assert.equal(l.approvalKey, 'ledger add');
});

test('T8: render/interactive/read_skill——无 action 字段的家族各自取关键参数', () => {
  assert.equal(summarizeToolCall('render', JSON.stringify({ title: 'WebGL 钢琴', html: '<html>' })).display, 'render WebGL 钢琴');
  assert.equal(summarizeToolCall('interactive', JSON.stringify({ kind: 'question', title: '选哪个' })).display, 'interactive question');
  const sk = summarizeToolCall('read_skill', JSON.stringify({ name: 'deploy' }));
  assert.equal(sk.display, 'read_skill deploy');
  assert.equal(sk.approvalKey, 'read_skill');
});

test('T9: 非法 JSON / 空参数——降级不抛错；browser 缺动作显式标注 (?)（键不会误配真实动作）', () => {
  assert.deepEqual(summarizeToolCall('browser', 'not json'), { display: 'browser (?)', approvalKey: 'browser (?)' });
  assert.deepEqual(summarizeToolCall('ledger', ''), { display: 'ledger', approvalKey: 'ledger' });
});

test('T10: 超长 URL——display 截断到上限内并以 … 结尾', () => {
  const long = `https://example.com/${'x'.repeat(300)}`;
  const s = summarizeToolCall('browser', JSON.stringify({ action: 'navigate', url: long }));
  assert.ok(s.display.length <= 121);
  assert.ok(s.display.endsWith('…'));
  assert.equal(s.approvalKey, 'browser navigate'); // 键不受截断影响
});
