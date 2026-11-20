/**
 * 服务端探针集成测试：/api/providers/probe v2（outputLimit 揭示 / tools / thinking 特性）
 * + note-probe 自愈回填。模板：tests/server.test.mjs（createProdServer + 回环 mock 上游
 * + policyOptions.allowPrivate 放行环回）。PLITE_MODELSDEV=0 跳过外网目录拉取。
 *
 * mock 上游按请求体特征分类应答（与 MOSI 实测行为同构）：
 * - max_tokens=999999999 → 400 "output token limit must be between 1 and 12345"（揭示）
 * - tools+tool_choice=required → 200 tool_calls（工具支持）
 * - thinking.type=disabled → 400 "does not support disabling thinking"（思考不可关）
 * - max_tokens=64 → 200 finish=length 且 reasoning_tokens=64、正文空（思考吃预算）
 * - max_tokens=1 + reasoning_effort=low → 200（effort 参数接受）
 * - 图片 content → 200（vision 支持）
 */
process.env.PLITE_MODELSDEV = '0';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProdServer } from '../server/prod-server.mjs';
import { mergeModelCaps } from '../plugins/model-admin/detect.ts';

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'plite-probe-'));
  const dist = join(root, 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>shell</title>');
  return { root, dist, dataDir: join(root, 'data') };
}

async function startHost(t, env) {
  const server = createProdServer({ dist: env.dist, dataDir: env.dataDir, policyOptions: { allowPrivate: true } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const { port } = server.address();
  let cookie = '';
  const send = async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const pair = c.split(';')[0];
      if (pair.startsWith('plite.sid=')) cookie = pair;
    }
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  };
  return { send };
}

/** MOSI 同构 mock 上游：按请求体特征分类应答 */
async function startMockUpstream(t) {
  const server = createServer((req, res) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(buf || '{}'); } catch { /* ignore */ }
      const json = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.method === 'GET' && req.url === '/models') {
        json(200, { data: [{ id: 'nex-test', object: 'model', owned_by: 'MOSS' }] });
        return;
      }
      const mt = Number(body.max_tokens ?? 0);
      if (mt >= 999_999_999) {
        json(400, { error: { message: 'Nex request rejected: output token limit must be between 1 and 12345', type: 'invalid_request_error', code: 'invalid_field_value' } });
        return;
      }
      if (body.thinking?.type === 'disabled') {
        json(400, { error: { message: 'Nex request rejected: Nex does not support disabling thinking', code: 'invalid_field_value' } });
        return;
      }
      const content = Array.isArray(body.messages?.[0]?.content) ? body.messages[0].content : null;
      if (Array.isArray(body.tools) && body.tools.length > 0) {
        json(200, { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 12, total_tokens: 22, completion_tokens_details: { reasoning_tokens: 0 } } });
        return;
      }
      if (mt === 64) {
        json(200, { choices: [{ message: { role: 'assistant', content: '', reasoning_content: '……' }, finish_reason: 'length' }], usage: { prompt_tokens: 20, completion_tokens: 64, total_tokens: 84, completion_tokens_details: { reasoning_tokens: 64 } } });
        return;
      }
      if (mt === 1 && body.reasoning_effort === 'low') {
        json(200, { choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'length' }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } });
        return;
      }
      if (content && content.some((p) => p?.type === 'image_url')) {
        json(200, { choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 } });
        return;
      }
      json(200, { choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test('probe v2：限值揭示/工具/思考特性/视觉 全信号 + 结论写回存储', async (t) => {
  const env = tempRoot();
  const h = await startHost(t, env);
  const c = h;
  await c.send('/api/auth/login', { method: 'POST', body: { username: 'boss', password: 'secret123' } });

  const upUrl = await startMockUpstream(t);
  mkdirSync(env.dataDir, { recursive: true });
  writeFileSync(join(env.dataDir, 'providers.json'), JSON.stringify({
    providers: [{
      id: 'mock', name: 'mock', baseURL: upUrl, apiKey: 'k', enabled: true, isDefault: true,
      activeModel: 'nex-test',
      models: [{ id: 'nex-test', capabilities: { maxInputTokens: 0, maxOutputTokens: 0, effort: null, vision: false } }],
    }],
  }));

  const probe = await c.send('/api/providers/probe', { method: 'POST', body: { id: 'mock' } });
  assert.equal(probe.status, 200);
  assert.ok(probe.json?.ok);
  assert.deepEqual(probe.json.catalogIds, ['nex-test']);
  const p = probe.json.probes['nex-test'];
  assert.deepEqual(p.outputLimit, { kind: 'revealed', limit: 12345 }, '超限报错必须揭示网关真实输出上限');
  assert.equal(p.tools, true);
  assert.deepEqual(p.thinking, { eatsBudget: true, canDisable: false });
  assert.equal(p.vision, true);
  assert.equal(p.effort, 'low', 'effort 参数被接受记 low（生效性留给深度差分）');

  // 结论写回走插件侧合并（runProbeFlow 的 merge→save 链路）：测试里显式复现，
  // 同时验证 provider-store normalize 对新字段（tools/thinking/detectedAt）的透传
  const list0 = await c.send('/api/providers/list');
  const target = list0.json.configs[0];
  const merged = target.models.map((m) => mergeModelCaps(m, probe.json).model);
  const saved = await c.send('/api/providers/save', { method: 'POST', body: { config: { ...target, models: merged } } });
  assert.equal(saved.status, 200);

  const list = await c.send('/api/providers/list');
  const m = list.json.configs[0].models[0];
  assert.equal(m.capabilities.maxOutputTokens, 12345);
  assert.equal(m.capabilities.detected, 'reveal');
  assert.equal(typeof m.capabilities.detectedAt, 'number');
  assert.equal(m.capabilities.tools, true);
  assert.equal(m.capabilities.reasoningEatsBudget, true);
  assert.equal(m.capabilities.canDisableThinking, false);
});

test('note-probe：运行时自愈回填（覆盖旧值 + 标 probe）', async (t) => {
  const env = tempRoot();
  const h = await startHost(t, env);
  const c = h;
  await c.send('/api/auth/login', { method: 'POST', body: { username: 'boss', password: 'secret123' } });

  mkdirSync(env.dataDir, { recursive: true });
  writeFileSync(join(env.dataDir, 'providers.json'), JSON.stringify({
    providers: [{
      id: 'mock', name: 'mock', baseURL: 'https://api.example.com/v1', apiKey: 'k', enabled: true,
      activeModel: 'm1',
      models: [{ id: 'm1', capabilities: { maxInputTokens: 128000, maxOutputTokens: 4096, effort: null, vision: false } }],
    }],
  }));

  const r = await c.send('/api/providers/note-probe', {
    method: 'POST',
    body: { id: 'mock', modelId: 'm1', patch: { maxOutputTokens: 131072, maxInputTokens: 300000 } },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.changed, true);
  const m = r.json.models[0];
  assert.equal(m.capabilities.maxOutputTokens, 131072);
  assert.equal(m.capabilities.maxInputTokens, 300000);
  assert.equal(m.capabilities.detected, 'probe');
});
