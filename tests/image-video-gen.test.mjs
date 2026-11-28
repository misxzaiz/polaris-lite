import { test } from 'node:test';
import assert from 'node:assert/strict';

function mockReq(url, { method = 'POST', body = '' } = {}) {
  return { url, method, on: (ev, fn) => {
    if (ev === 'data') setImmediate(() => fn(Buffer.from(body)));
    if (ev === 'end') setImmediate(() => fn());
    if (ev === 'error') {}
  } };
}
function mockRes() {
  return { statusCode: 0, body: '', writeHead(c) { this.statusCode = c; }, end(s) { this.body = s; } };
}

test('image-gen: 未登录 → 401', async () => {
  const { createServerPart } = await import('../plugins/image-gen/server.mjs');
  const mw = createServerPart({ getSession: () => null, dataDir: '.polaris-lite-dev' });
  const res = mockRes();
  await mw(mockReq('/api/image-gen/draw', { body: '{}' }), res, () => {});
  assert.equal(res.statusCode, 401);
});

test('image-gen: 缺 prompt → PROMPT_REQUIRED', async () => {
  const { createServerPart } = await import('../plugins/image-gen/server.mjs');
  const mw = createServerPart({ getSession: () => ({}), dataDir: '.polaris-lite-dev' });
  const res = mockRes();
  await mw(mockReq('/api/image-gen/draw', { body: JSON.stringify({ prompt: '' }) }), res, () => {});
  assert.equal(JSON.parse(res.body).code, 'PROMPT_REQUIRED');
});

test('image-gen: 未配置上游 → NOT_CONFIGURED（不报崩溃）', async () => {
  const { createServerPart } = await import('../plugins/image-gen/server.mjs');
  // .polaris-lite-dev 无 image-gen/config.json，且无 env
  const saved = { u: process.env.PLITE_IMAGE_GEN_URL, k: process.env.PLITE_IMAGE_GEN_KEY };
  delete process.env.PLITE_IMAGE_GEN_URL;
  delete process.env.PLITE_IMAGE_GEN_KEY;
  const mw = createServerPart({ getSession: () => ({}), dataDir: '.polaris-lite-dev' });
  const res = mockRes();
  await mw(mockReq('/api/image-gen/draw', { body: JSON.stringify({ prompt: 'a cat' }) }), res, () => {});
  if (saved.u) process.env.PLITE_IMAGE_GEN_URL = saved.u;
  if (saved.k) process.env.PLITE_IMAGE_GEN_KEY = saved.k;
  assert.equal(JSON.parse(res.body).code, 'NOT_CONFIGURED');
});

test('video-gen: 缺 prompt → PROMPT_REQUIRED', async () => {
  const { createServerPart } = await import('../plugins/video-gen/server.mjs');
  const mw = createServerPart({ getSession: () => ({}), dataDir: '.polaris-lite-dev' });
  const res = mockRes();
  await mw(mockReq('/api/video-gen/video', { body: JSON.stringify({ prompt: '' }) }), res, () => {});
  assert.equal(JSON.parse(res.body).code, 'PROMPT_REQUIRED');
});

test('video-gen: 未配置上游 → NOT_CONFIGURED', async () => {
  const { createServerPart } = await import('../plugins/video-gen/server.mjs');
  const saved = { u: process.env.PLITE_VIDEO_GEN_URL, k: process.env.PLITE_VIDEO_GEN_KEY };
  delete process.env.PLITE_VIDEO_GEN_URL;
  delete process.env.PLITE_VIDEO_GEN_KEY;
  const mw = createServerPart({ getSession: () => ({}), dataDir: '.polaris-lite-dev' });
  const res = mockRes();
  await mw(mockReq('/api/video-gen/video', { body: JSON.stringify({ prompt: 'a cat running' }) }), res, () => {});
  if (saved.u) process.env.PLITE_VIDEO_GEN_URL = saved.u;
  if (saved.k) process.env.PLITE_VIDEO_GEN_KEY = saved.k;
  assert.equal(JSON.parse(res.body).code, 'NOT_CONFIGURED');
});

test('video-gen: 未登录 → 401', async () => {
  const { createServerPart } = await import('../plugins/video-gen/server.mjs');
  const mw = createServerPart({ getSession: () => null, dataDir: '.polaris-lite-dev' });
  const res = mockRes();
  await mw(mockReq('/api/video-gen/video', { body: '{}' }), res, () => {});
  assert.equal(res.statusCode, 401);
});
