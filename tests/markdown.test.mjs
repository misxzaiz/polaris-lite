/**
 * Markdown 解析器回归测试。
 *
 * 解析器是这类渲染器唯一容易出错的地方（正则边界），而且它的行为直接决定
 * 流式观感：AI 回复逐 token 到达时，未闭合的 ``` 必须把剩余内容当代码块，
 * 而不是先当正文渲染、收尾时整段跳成代码。这类行为没有测试兜底就只能靠肉眼验收。
 *
 * 纯函数、无 React、无 DOM，直接跑 TS 源码。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBlocks, parseInline, safeHref } from '../plugins/chat-lite/markdown-parse.ts';

/** 把 Inline[] 压成纯文本，便于断言 */
const flat = (nodes) =>
  nodes
    .map((n) => ('value' in n ? n.value : flat(n.children)))
    .join('');

test('行内：代码 / 加粗 / 斜体 / 删除线 / 链接各归其位', () => {
  const nodes = parseInline('含 `code`、**粗**、*斜*、~~删~~ 与 [链接](https://example.com)');
  const kinds = nodes.map((n) => n.type);
  // 注意 ** 必须先于 * 命中，否则会解析成「* + 斜体」；末尾无残留文本节点
  assert.deepEqual(kinds, ['text', 'code', 'text', 'strong', 'text', 'em', 'text', 'del', 'text', 'link']);
  assert.equal(flat(nodes), '含 code、粗、斜、删 与 链接');
});

test('行内：** 优先级高于 *（不能拆成两个斜体）', () => {
  const nodes = parseInline('a **b** c');
  const strong = nodes.find((n) => n.type === 'strong');
  assert.ok(strong, '应解析出 strong 而非 em');
  assert.equal(flat(strong.children), 'b');
});

test('行内：嵌套加粗内的行内代码', () => {
  const nodes = parseInline('**外 `内` 外**');
  const strong = nodes.find((n) => n.type === 'strong');
  assert.ok(strong);
  assert.ok(strong.children.some((c) => c.type === 'code' && c.value === '内'));
});

test('链接：javascript: 与 data: 一律不放行，按原文保留', () => {
  assert.equal(safeHref('javascript:alert(1)'), null);
  assert.equal(safeHref('data:text/html;base64,xx'), null);
  assert.equal(safeHref('https://ok.example.com'), 'https://ok.example.com');
  assert.equal(safeHref('mailto:a@b.com'), 'mailto:a@b.com');

  const nodes = parseInline('[坏](javascript:alert(1))');
  assert.equal(nodes.filter((n) => n.type === 'link').length, 0, '不得产出可点链接');
  assert.equal(flat(nodes), '[坏](javascript:alert(1))');
});

test('块级：未闭合围栏把剩余内容全部并入代码块（流式关键行为）', () => {
  // 模拟流式进行到一半：只有开围栏，没有闭合
  const blocks = parseBlocks('先说明一下\n\n```ts\nconst a = 1;\nconst b = 2;');
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, 'p');
  assert.deepEqual(blocks[1], { type: 'code', lang: 'ts', value: 'const a = 1;\nconst b = 2;' });
});

test('块级：闭合围栏后面还能继续解析正文', () => {
  const blocks = parseBlocks('```js\nx();\n```\n\n后续段落');
  assert.deepEqual(blocks.map((b) => b.type), ['code', 'p']);
  assert.equal(flat(blocks[1].children), '后续段落');
});

test('块级：标题 / 分割线 / 引用 / 列表各成一块', () => {
  const src = [
    '## 标题',
    '',
    '---',
    '',
    '> 引用一行',
    '',
    '- 甲',
    '- 乙',
    '',
    '1. 一',
    '2. 二',
  ].join('\n');
  const blocks = parseBlocks(src);
  assert.deepEqual(blocks.map((b) => b.type), ['heading', 'hr', 'quote', 'list', 'list']);
  assert.equal(blocks[0].level, 2);
  assert.equal(blocks[3].ordered, false);
  assert.equal(blocks[3].items.length, 2);
  assert.equal(blocks[4].ordered, true);
  assert.equal(blocks[4].items.length, 2);
});

test('块级：连续非空行合并为一个段落，空行分段', () => {
  const blocks = parseBlocks('第一行\n第二行\n\n第三段');
  assert.equal(blocks.length, 2);
  assert.equal(flat(blocks[0].children), '第一行\n第二行');
  assert.equal(flat(blocks[1].children), '第三段');
});

test('块级：列表不吞掉紧随其后的段落', () => {
  const blocks = parseBlocks('- 项一\n- 项二\n\n正文段落');
  assert.deepEqual(blocks.map((b) => b.type), ['list', 'p']);
});

test('块级：任何输入都不会死循环（含全空、纯空白、畸形围栏）', () => {
  for (const src of ['', '\n\n\n', '   ', '```', '```\n', '---', '# ', '>', '-']) {
    const blocks = parseBlocks(src);
    assert.ok(Array.isArray(blocks), `输入 ${JSON.stringify(src)} 应返回数组`);
  }
});
