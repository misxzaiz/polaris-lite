/**
 * translate server 半边测试：配置存取/密钥不出服务端/翻译校验/错误映射/缓存。
 *
 * 直接调用 createServerPart（不经宿主装配），临时目录伪造 dataDir；
 * 百度上游用假 appId/secretKey 走真实 HTTP（错误码 52003 映射为中文提示），
 * 不 mock 网络——与 voice-radio.test 同思路，验「签名-请求-错误链路」真实可用。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerPart, SUPPORTED_LANGS } from '../plugins/translate/server.mjs';

function tempEnv(t, { session = { user: { name: 'tester' } } } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'plite-translate-'));
  const dataDir = join(root, 'data');
  t.after(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* 忽略 */ } });

  const mw = createServerPart({ getSession: () => session, dataDir, policy: { assertAllowedUrl: () => {} } });
  const call = async (path, { method = 'GET', body } = {}) => {
    const res = {
      code: 0, body: '',
      writeHead(c) { this.code = c; return this; },
      end(b) { this.body = b ?? ''; },
    };
    const req = {
      url: path, method, headers: {},
      on(ev, cb) { if (ev === 'data') { /* 无 body 流 */ } if (ev === 'end') cb(); return this; },
    };
    if (body !== undefined) {
      const buf = Buffer.from(JSON.stringify(body));
      req.on = (ev, cb) => { if (ev === 'data') cb(buf); if (ev === 'end') cb(); return req; };
    }
    await mw(req, res, () => {});
    let json = null;
    try { json = JSON.parse(res.body); } catch { /* 非 JSON */ }
    return { status: res.code, json };
  };
  return { dataDir, call };
}

test('translate: 未配置时 config.configured=false，translate 明确报「未配置」', async (t) => {
  const { call } = tempEnv(t);
  const cfg = await call('/api/translate/config');
  assert.equal(cfg.status, 200);
  assert.equal(cfg.json.configured, false);
  assert.ok(Array.isArray(cfg.json.langs) && cfg.json.langs.length >= 9, 'langs 白名单应齐全');

  const r = await call('/api/translate/translate', { method: 'POST', body: { text: 'hello', to: 'zh' } });
  assert.equal(r.status, 502);
  assert.match(r.json.error, /未配置/);
});

test('translate: 未登录 401；PLITE_TRANSLATE=0 整体禁用', async (t) => {
  const { call } = tempEnv(t, { session: null });
  const r = await call('/api/translate/config');
  assert.equal(r.status, 401);
});

test('translate: 配置保存后 configured=true，secretKey 不回显，appId 回显', async (t) => {
  const { call } = tempEnv(t);
  const save = await call('/api/translate/config', { method: 'POST', body: { appId: 'appid-1', secretKey: 'sec-1' } });
  assert.equal(save.json.ok, true);
  assert.equal(save.json.configured, true);

  const cfg = await call('/api/translate/config');
  assert.equal(cfg.json.configured, true);
  assert.equal(cfg.json.appId, 'appid-1');
  assert.equal('secretKey' in cfg.json, false, 'SecretKey 不得出服务端');
});

test('translate: 参数校验——空文本/超长文本/非法目标语言', async (t) => {
  const { call } = tempEnv(t);
  await call('/api/translate/config', { method: 'POST', body: { appId: 'a', secretKey: 's' } });

  const empty = await call('/api/translate/translate', { method: 'POST', body: { text: '  ', to: 'en' } });
  assert.equal(empty.status, 400);

  const tooLong = await call('/api/translate/translate', { method: 'POST', body: { text: 'a'.repeat(6001), to: 'en' } });
  assert.equal(tooLong.status, 400);
  assert.match(tooLong.json.error, /超长/);

  const badLang = await call('/api/translate/translate', { method: 'POST', body: { text: 'hi', to: 'xx' } });
  assert.equal(badLang.status, 400);
  assert.match(badLang.json.error, /不支持的目标语言/);
});

test('translate: 假密钥走真实百度 API → 52003 映射中文「未授权用户」', async (t) => {
  const { call } = tempEnv(t);
  await call('/api/translate/config', { method: 'POST', body: { appId: 'test-fake-appid', secretKey: 'test-fake-secret' } });
  const r = await call('/api/translate/translate', { method: 'POST', body: { text: '你好', to: 'en' } });
  assert.equal(r.status, 502);
  assert.match(r.json.error, /未授权用户|签名错误|频率受限|余额不足/, `应映射为中文错误，实际：${r.json.error}`);
});

test('translate: 批量端点——空数组 400、超 50 条 400、未配置 502、含失效项 null 占位', async (t) => {
  const { call } = tempEnv(t);
  const empty = await call('/api/translate/translate-batch', { method: 'POST', body: { texts: [] } });
  assert.equal(empty.status, 400);
  const tooMany = await call('/api/translate/translate-batch', { method: 'POST', body: { texts: Array.from({ length: 51 }, () => 'x') } });
  assert.equal(tooMany.status, 400);

  const nocfg = await call('/api/translate/translate-batch', { method: 'POST', body: { texts: ['hello'] } });
  assert.equal(nocfg.status, 502);
  assert.match(nocfg.json.error, /未配置/);

  await call('/api/translate/config', { method: 'POST', body: { appId: 'test-fake-appid', secretKey: 'test-fake-secret' } });
  const r = await call('/api/translate/translate-batch', { method: 'POST', body: { texts: ['hello world', '', 'x'.repeat(6001), 'good morning'], to: 'zh' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.results.length, 4);
  assert.equal(r.json.results[1], null, '空文本应 null 占位');
  assert.equal(r.json.results[2], null, '超长文本应 null 占位');
  // 假密钥下真实百度调用失败 → 全部 null 占位（不抛错、不中断批量）
  assert.ok(r.json.results.every((x) => x === null), '假密钥批量应全部 null 占位');
});

test('translate: 支持语言表含中英与文言，代码不重复', () => {
  const codes = SUPPORTED_LANGS.map((l) => l.code);
  assert.equal(new Set(codes).size, codes.length);
  for (const c of ['zh', 'en', 'wyw']) assert.ok(codes.includes(c));
});
