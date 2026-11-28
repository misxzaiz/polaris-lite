import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServerPart as createVision } from '../plugins/vision/server.mjs';

/** 最小 req/res mock（参考 media-push 测试） */
function mockReq(url, { method = 'POST', body = '' } = {}) {
  return { url, method, on: (ev, fn) => {
    if (ev === 'data') setImmediate(() => fn(Buffer.from(body)));
    if (ev === 'end') setImmediate(() => fn());
    if (ev === 'error') {}
  } };
}
function mockRes() {
  const r = { statusCode: 0, body: '', writeHead(c) { this.statusCode = c; }, end(s) { this.body = s; } };
  return r;
}

test('vision: 非图片路径 → NOT_IMAGE（魔数说了算）', async () => {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync('.test-tmp', { recursive: true });
  // 一个「伪装成 png 的文本文件」
  writeFileSync('.test-tmp/fake.png', 'hello not an image');
  const mw = createVision({ getSession: () => ({}), dataDir: '.polaris-lite-dev' });
  const res = mockRes();
  await mw(mockReq('/api/vision/look', { body: JSON.stringify({ path: '.test-tmp/fake.png' }) }), res, () => {});
  const j = JSON.parse(res.body);
  assert.equal(j.code, 'NOT_IMAGE');
});

test('vision: 文件不存在 → NOT_FOUND', async () => {
  const mw = createVision({ getSession: () => ({}), dataDir: '.polaris-lite-dev' });
  const res = mockRes();
  await mw(mockReq('/api/vision/look', { body: JSON.stringify({ path: '.test-tmp/nope.png' }) }), res, () => {});
  const j = JSON.parse(res.body);
  assert.equal(j.code, 'NOT_FOUND');
});

test('vision: 未登录 → 401', async () => {
  const mw = createVision({ getSession: () => null, dataDir: '.polaris-lite-dev' });
  const res = mockRes();
  await mw(mockReq('/api/vision/look', { body: '{}' }), res, () => {});
  assert.equal(res.statusCode, 401);
});

// ---- voice-tts：不实际调上游，只测参数校验 ----
test('voice-tts: 空文本 → TEXT_REQUIRED', async () => {
  const { createServerPart } = await import('../plugins/voice-tts/server.mjs');
  const mw = createServerPart({ getSession: () => ({}), dataDir: '.polaris-lite-dev' });
  const res = mockRes();
  await mw(mockReq('/api/voice-tts/speak', { body: JSON.stringify({ text: '' }) }), res, () => {});
  assert.equal(JSON.parse(res.body).code, 'TEXT_REQUIRED');
});

test('voice-tts: 未知音色 → BAD_VOICE', async () => {
  const { createServerPart } = await import('../plugins/voice-tts/server.mjs');
  const mw = createServerPart({ getSession: () => ({}), dataDir: '.polaris-lite-dev' });
  const res = mockRes();
  await mw(mockReq('/api/voice-tts/speak', { body: JSON.stringify({ text: '你好', voice: '不存在的音色' }) }), res, () => {});
  assert.equal(JSON.parse(res.body).code, 'BAD_VOICE');
});

test('voice-tts: 超长文本 → TOO_LONG', async () => {
  const { createServerPart } = await import('../plugins/voice-tts/server.mjs');
  const mw = createServerPart({ getSession: () => ({}), dataDir: '.polaris-lite-dev' });
  const res = mockRes();
  await mw(mockReq('/api/voice-tts/speak', { body: JSON.stringify({ text: 'a'.repeat(2001) }) }), res, () => {});
  assert.equal(JSON.parse(res.body).code, 'TOO_LONG');
});

test('voice-tts: 音色列表端点可用', async () => {
  const { createServerPart } = await import('../plugins/voice-tts/server.mjs');
  const mw = createServerPart({ getSession: () => ({}), dataDir: '.polaris-lite-dev' });
  const res = mockRes();
  await mw(mockReq('/api/voice-tts/voices', { method: 'GET' }), res, () => {});
  const j = JSON.parse(res.body);
  assert.equal(j.ok, true);
  assert.ok(j.voices.some((v) => v.voiceId === 'mimo_default'));
});
