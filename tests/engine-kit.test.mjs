/**
 * engine-kit 单元测试（host-slimming-report §4 P0-2）。
 *
 * kit 是从 real-engine 抽取的纯函数共享模块——本测试固化其行为契约，
 * 防止后续改动破坏三引擎共同依赖的语义。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const kitRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../plugins/engine-kit');
const kit = await import(resolve(kitRoot, 'index.ts').replaceAll('\\', '/')).catch(() => null);

// engine-kit 是 TS 源码,Node 直跑需经 tsx/tsc;测试环境无 tsx 时降级为「源码契约检查」
// (与 reasoning/stream-retry 同模式:守卫关键实现细节的存在性)。
const sharedRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../plugins/shared');
const read = (f) => readFile(f === 'usage.ts' ? resolve(sharedRoot, f) : resolve(kitRoot, f), 'utf8');

test('sse reader:半行缓冲与 [DONE] 标记（源码契约）', async () => {
  const src = await read('sse.ts');
  assert.match(src, /data === '\[DONE\]'/, '必须识别 [DONE] 结束标记');
  assert.match(src, /buf\.split/, '必须处理跨 chunk 半行缓冲');
  assert.match(src, /slice\(5\)\.trim\(\)/, '必须剥 data: 前缀');
  assert.match(src, /code === 'UPSTREAM_DISCONNECTED'/, '必须识别中继断流错误帧');
});

test('toolcalls 聚合:index 维度拼接、整块两形态（源码契约）', async () => {
  const src = await read('sse.ts');
  assert.match(src, /slot\.id = slot\.id \|\| String\(tc\.id\)/, 'id 只取首个分片（后片不带 id）');
  assert.match(src, /slot\.name \+= /, 'name/arguments 必须跨分片累加');
});

test('usage:缓存字段方言链 + 估算兜底（源码契约）', async () => {
  const src = await read('usage.ts');
  assert.match(src, /prompt_tokens_details\?\.cached_tokens/, '标准 details 优先');
  assert.match(src, /prompt_cache_hit_tokens/, 'DeepSeek/GLM 变体兜底');
  assert.match(src, /estimated: true/, '无 wireUsage 时必须估算兜底且明示降级');
  assert.match(src, /Math\.ceil\(chars \/ 4\)/, '估算公式 Σ字符÷4');
});

test('limits:限值报错揭示（源码契约）', async () => {
  const src = await read('limits.ts');
  assert.match(src, /between\\s\+\\d\+\\s\+and\\s\+\(\\d\+\)/, 'between N and M 模式');
  assert.match(src, /output\|completion/, '输出上限分类');
  assert.match(src, /context\|prompt\|input/, '输入上下文分类');
});

test('interrupt:streamKey 会话前缀中断（源码契约）', async () => {
  const src = await read('interrupt.ts');
  assert.match(src, /startsWith\(prefix\)/, '必须支持按会话批量中断');
  assert.match(src, /\$\{sessionId\}::/, 'streamKey 约定 sessionId::messageId');
});

test('vocabulary:17+ kind 两层登记全量（结构契约）', async () => {
  const src = await read('vocabulary.ts');
  const kinds = [
    'message.delta', 'message.reasoning', 'message.done', 'message.continued',
    'message.truncated', 'tool.calls', 'ai.usage', 'stream.error', 'stream.retry',
    'engine.status', 'tool.card', 'tool.result', 'tool.approval.required',
    'tool.approval.resolved', 'context.snapshot', 'context.compacting',
    'context.compacted', 'context.compact-failed',
  ];
  for (const k of kinds) assert.match(src, new RegExp(`kind: '${k.replace('.', '\\.')}'`), `词汇表缺 ${k}`);
  assert.match(src, /layer: 'engine'/, '必须分层登记引擎层');
  assert.match(src, /layer: 'orchestrator'/, '必须分层登记编排层');
});

test('词汇表与 chat-lite 消费面一致（防契约漂移）', async () => {
  const vocab = await read('vocabulary.ts');
  const chat = await readFile(resolve(kitRoot, '../chat-lite/index.ts'), 'utf8');
  // chat-lite 消费的关键 kind 必须全部在词汇表里
  for (const k of ['tool.approval.required', 'message.truncated', 'message.continued', 'context.compact-failed']) {
    assert.ok(vocab.includes(`'${k}'`), `chat-lite 消费的 ${k} 未登记进词汇表`);
  }
  assert.ok(chat.includes('tool.approval.required'), '前置条件失效：chat-lite 消费面已变');
});

if (kit) {
  // 若运行环境能直接加载 TS(如 tsx),补行为测试
  test('行为:createSseReader 半行/分片/DONE', () => {
    const sse = kit.createSseReader();
    let out = sse.push('data: {"a":1}\ndata: {"b"');
    assert.equal(out.length, 1);
    assert.equal(out[0].data, '{"a":1}');
    out = sse.push(':2}\n\ndata: [DONE]\n');
    assert.equal(out.length, 1);
    assert.equal(out[0].data, '{"b":2}');
    assert.ok(out[0].done === false);
    out = sse.push('data: [DONE]\n');
    assert.ok(sse.sawDone);
  });
  test('行为:aggregateToolCallDelta 分片拼接', () => {
    const acc = new Map();
    kit.aggregateToolCallDelta(acc, [{ index: 0, id: 'c1', function: { name: 'foo', arguments: '{"x' } }]);
    kit.aggregateToolCallDelta(acc, [{ index: 0, function: { arguments: '":1}' } }]);
    assert.equal(acc.get(0).id, 'c1');
    assert.equal(acc.get(0).name, 'foo');
    assert.equal(acc.get(0).arguments, '{"x":1}');
  });
}
