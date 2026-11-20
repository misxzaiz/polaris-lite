/**
 * Token 数量解析回归测试（供应商「输入 tokens」字段适配 1m/200k 等写法）。
 *
 * 背景：面板旧实现 `replace(/\D/g,'')` 把「1m」剥成「1」存成 1 个 token，
 * 上下文窗口永远回落默认 200k——用户改 1m 不生效。修复后双半边各有实现：
 * - 前端 plugins/model-admin/tokens.ts（输入框即时解析 + 徽标格式化）
 * - 服务端 server/provider-store.mjs（normalize 第二道防线，防旧客户端写坏值）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviderStore, parseTokenCount as serverParse } from '../server/provider-store.mjs';
import { parseTokenCount, formatTokenCount } from '../plugins/model-admin/tokens.ts';

test('parseTokenCount：k/M 后缀、千分位、纯数字、清空语义', () => {
  for (const fn of [parseTokenCount, serverParse]) {
    assert.equal(fn('1m'), 1_000_000);
    assert.equal(fn('1M'), 1_000_000);
    assert.equal(fn('200k'), 200_000);
    assert.equal(fn('200K'), 200_000);
    assert.equal(fn('1.5m'), 1_500_000);
    assert.equal(fn('128,000'), 128_000);
    assert.equal(fn(' 128000 '), 128_000);
    assert.equal(fn(128000), 128000);
    assert.equal(fn('0'), 0);
    assert.equal(fn(''), 0, '清空 = 未知');
    assert.equal(fn('abc'), null, '非法字面量返回 null');
    assert.equal(fn('1x'), null);
    assert.equal(fn(-5), null);
  }
});

test('formatTokenCount：人读显示（1M / 200k / 65.5k）', () => {
  assert.equal(formatTokenCount(1_000_000), '1M');
  assert.equal(formatTokenCount(2_000_000), '2M');
  assert.equal(formatTokenCount(200_000), '200k');
  assert.equal(formatTokenCount(65_536), '65.5k');
  assert.equal(formatTokenCount(8192), '8.2k');
  assert.equal(formatTokenCount(0), '—');
});

test('provider-store：保存 "1m" 字符串被归一为 1000000（服务端防线）', () => {
  const store = createProviderStore({ dataDir: 'nonexistent-dir-for-test' });
  store.save({
    id: 'prov-test',
    name: '测试',
    baseURL: 'https://api.example.com/v1',
    apiKey: 'sk-x',
    models: [
      { id: 'm-1m', capabilities: { maxInputTokens: '1m', maxOutputTokens: '64k', effort: null, vision: false } },
      { id: 'm-bad', capabilities: { maxInputTokens: '1m!!', maxOutputTokens: 8192, effort: null, vision: false } },
    ],
    activeModel: 'm-1m',
    enabled: true,
    isDefault: true,
  });
  const list = store.listPublic();
  const good = list.find((p) => p.id === 'prov-test')?.models.find((m) => m.id === 'm-1m');
  const bad = list.find((p) => p.id === 'prov-test')?.models.find((m) => m.id === 'm-bad');
  assert.equal(good.capabilities.maxInputTokens, 1_000_000, '"1m" 必须落到 1000000');
  assert.equal(good.capabilities.maxOutputTokens, 64_000, '"64k" 同样解析');
  assert.equal(bad.capabilities.maxInputTokens, 0, '非法字面量归 0（未知），绝不吞成错误值');
});
