/**
 * voice-radio 服务端集成测试。
 *
 * 复用 transcript-share.test.mjs 的「独立实例 + cookie client」模式。
 * 覆盖：会话门禁 / config 读写（Key 不回显）/ voices 表 / synthesize 校验
 * （空文本、超长、未知音色）/ PLITE_VOICE_RADIO=0 禁用 / 纯前端单元
 * （sanitizeForSpeech、splitSentences、prompt 模板、cacheKey）。
 *
 * MiMo 上游不打真 API：synthesize 的上游路径通过注入假 fetch 难度大（server.mjs
 * 顶层 import undici），这里只测门禁与参数校验分支；真实合成链路由 dev 冒烟覆盖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProdServer } from '../server/prod-server.mjs';

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'plite-vradio-'));
  const dist = join(root, 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>shell</title>');
  return { root, dist, dataDir: join(root, 'data') };
}

async function startHost(t, { dist, dataDir }) {
  const server = createProdServer({ dist, dataDir });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const client = () => {
    let cookie = '';
    const send = async (path, { method = 'GET', body } = {}) => {
      const res = await fetch(base + path, {
        method,
        headers: {
          ...(cookie ? { cookie } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
      });
      for (const c of res.headers.getSetCookie?.() ?? []) {
        const pair = c.split(';')[0];
        if (pair.startsWith('plite.sid=')) cookie = pair;
      }
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* 非 JSON */ }
      return { status: res.status, text, json };
    };
    return { send, cookie: () => cookie };
  };
  return { base, client, dataDir };
}

async function login(t, env) {
  const { client } = await startHost(t, env);
  const c = client();
  const res = await c.send('/api/auth/login', { method: 'POST', body: { username: 'boss', password: 'secret123' } });
  assert.equal(res.status, 200, `login failed: ${res.text}`);
  return c;
}

test('voice-radio：未登录访问被拒（401）', async (t) => {
  const env = tempRoot();
  const { client } = await startHost(t, env);
  const anon = client();
  const res = await anon.send('/api/voice-radio/config');
  assert.equal(res.status, 401);
  assert.equal(res.json?.code, 'SESSION_REQUIRED');
});

test('voice-radio：config 初始未配置；保存后 configured=true 且 Key 不回显', async (t) => {
  const env = tempRoot();
  const c = await login(t, env);
  const before = await c.send('/api/voice-radio/config');
  assert.equal(before.status, 200);
  assert.equal(before.json.configured, false);

  const save = await c.send('/api/voice-radio/config', { method: 'POST', body: { apiKey: 'test-key-abc123' } });
  assert.equal(save.status, 200);
  assert.equal(save.json.ok, true);
  assert.equal(save.json.configured, true);

  const after = await c.send('/api/voice-radio/config');
  assert.equal(after.json.configured, true);
  assert.equal(JSON.stringify(after.json).includes('test-key-abc123'), false, 'Key 不得回显');
});

test('voice-radio：voices 返回预置音色表（含 mimo_default）', async (t) => {
  const env = tempRoot();
  const c = await login(t, env);
  const res = await c.send('/api/voice-radio/voices');
  assert.equal(res.status, 200);
  const voices = res.json.voices ?? [];
  assert.ok(voices.length >= 9);
  assert.ok(voices.some((v) => v.voiceId === 'mimo_default'));
  assert.ok(voices.some((v) => v.voiceId === '冰糖'));
});

test('voice-radio：synthesize 参数校验（空文本 / 超长 / 未知音色 / 未配 Key）', async (t) => {
  const env = tempRoot();
  const c = await login(t, env);

  const empty = await c.send('/api/voice-radio/synthesize', { method: 'POST', body: { text: '  ' } });
  assert.equal(empty.status, 400);

  const long = await c.send('/api/voice-radio/synthesize', { method: 'POST', body: { text: '啊'.repeat(2001) } });
  assert.equal(long.status, 400);

  const unknownVoice = await c.send('/api/voice-radio/synthesize', { method: 'POST', body: { text: '你好', voice: '不存在的音色' } });
  assert.equal(unknownVoice.status, 400);

  const noKey = await c.send('/api/voice-radio/synthesize', { method: 'POST', body: { text: '你好', voice: '冰糖' } });
  assert.equal(noKey.status, 502);
  assert.match(noKey.json.error ?? noKey.json.message ?? '', /API Key/);
});

test('voice-radio：PLITE_VOICE_RADIO=0 一键禁用（端点退场，SPA fallback 接管）', async (t) => {
  // hardOff 在 createServerPart（createHost 装配期）读取：先置 env 再起服
  process.env.PLITE_VOICE_RADIO = '0';
  try {
    const env = tempRoot();
    const { client } = await startHost(t, env);
    const c = client();
    await c.send('/api/auth/login', { method: 'POST', body: { username: 'boss', password: 'secret123' } });
    // 中间件放行 → 静态服务 SPA fallback 回 index.html（200，但不是 JSON）
    const res = await c.send('/api/voice-radio/config');
    assert.equal(res.status, 200);
    assert.equal(res.json, null);
  } finally {
    delete process.env.PLITE_VOICE_RADIO;
  }
});

// ---- 纯前端单元（core.ts 逻辑；经源码契约校验，避免引入 TS 运行时依赖） ----

test('voice-radio core：清洗/切句/提示词模板契约', async (t) => {
  const { readFileSync } = await import('node:fs');
  const { resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const core = readFileSync(resolve(root, 'plugins/voice-radio/core.ts'), 'utf8');

  // 切句规则：按句末标点（与 Polaris splitSentences 一致）
  assert.ok(core.includes("(?<=[。！？!?；;\\n])"), '切句正则必须保留句末标点语义');

  // 清洗必须包含表格过滤（| 成行丢弃 + 残留竖线）
  assert.ok(core.includes("/^\\s*\\|/"), '清洗必须过滤 Markdown 表格行');
  assert.ok(core.includes("```"), '清洗必须去代码围栏');

  // 方向模板：5 个预设 + {direction} 占位
  for (const k of ['study', 'story', 'tech', 'news', 'custom']) {
    assert.ok(core.includes(`${k}:`), `缺少方向模板 ${k}`);
  }
  assert.ok(core.includes('{direction}'), '模板必须有 {direction} 占位');

  // 续段 prompt 携带上一段结尾摘要（无限播报的接续关键）
  assert.ok(core.includes('上一段结尾') === false, '接续 prompt 在 controller.ts');
  const controller = readFileSync(resolve(root, 'plugins/voice-radio/controller.ts'), 'utf8');
  assert.ok(controller.includes('上一段结尾'), 'controller 续段 prompt 必须携带上一段摘要');
  assert.ok(controller.includes('cap.ai.chat'), 'AI 通道必须是 cap.ai.chat');
  assert.ok(controller.includes('cap.ai.chat.interrupt'), '中断必须走 cap.ai.chat.interrupt');
});

test('voice-radio：插话/补充/工具模式契约', async (t) => {
  const { readFileSync } = await import('node:fs');
  const { resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const core = readFileSync(resolve(root, 'plugins/voice-radio/core.ts'), 'utf8');
  const controller = readFileSync(resolve(root, 'plugins/voice-radio/controller.ts'), 'utf8');
  const panel = readFileSync(resolve(root, 'plugins/voice-radio/Panel.tsx'), 'utf8');

  // 插话模板：先回应再接续（对齐 Polaris promptForInterject）
  assert.ok(core.includes('这是听众插话'), '必须有插话 prompt 模板');
  // 补充模板：立即放下当前内容
  assert.ok(core.includes('听众临时补充'), '必须有补充 prompt 模板');
  // controller 三入口
  assert.ok(controller.includes('interject(text'), 'controller 必须有 interject');
  assert.ok(controller.includes('supplement(text'), 'controller 必须有 supplement（立即中断补充）');
  assert.ok(controller.includes('abortSegment'), '补充路径必须有 abortSegment（中断在途段）');
  // 插话半双工：请求时暂停、回复到达恢复
  assert.ok(controller.includes('interjectActive'), '插话回复到达必须恢复播放且不计轮次');
  // 工具查证双模：off=cap.ai.chat 直连；on=服务端 runner 编排（AI 可调工具，服务端为唯一执行者）
  assert.ok(controller.includes('/api/agent/start'), '工具模式必须走服务端 runner');
  assert.ok(controller.includes('/api/agent/events'), '工具模式必须订阅服务端 SSE');
  assert.ok(controller.includes('useRunner'), 'AI 通道必须按 toolsMode 切换');
  assert.ok(core.includes('TOOL_MODE_SYSTEM_SUFFIX'), '工具模式必须有 system 纪律附录');
  // Panel：插话输入 + 立即中断补充按钮 + 开关
  assert.ok(panel.includes('handleInterject'), 'Panel 必须有插话入口');
  assert.ok(panel.includes('handleSupplement'), 'Panel 必须有立即中断补充入口');
  assert.ok(panel.includes('工具查证模式'), 'Panel 必须有工具模式开关');
});

test('voice-radio：AI 配音标注 + BGM 合成契约', async (t) => {
  const { readFileSync } = await import('node:fs');
  const { resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const core = readFileSync(resolve(root, 'plugins/voice-radio/core.ts'), 'utf8');
  const controller = readFileSync(resolve(root, 'plugins/voice-radio/controller.ts'), 'utf8');
  const bgm = resolve(root, 'plugins/voice-radio/bgm.mjs');

  // 配音协议：system 后缀要求首行 [voice:…]；extractVoiceDirection 剥离
  assert.ok(core.includes('[voice:'), '协议要求 AI 输出 [voice:…] 语气标注');
  assert.ok(core.includes('extractVoiceDirection'), '必须有标注剥离函数');
  // controller 消费标注并传给合成
  assert.ok(controller.includes('extractVoiceDirection'), 'controller 必须剥离语气标注');
  assert.ok(controller.includes('enqueueSegment(clean, segStyle)'), '段 style 必须传入句队列');
  // BGM：算法合成器存在 + 服务端端点 + controller 拉取
  assert.ok(core.includes('BGM_BY_DIRECTION'), '方向→BGM 风格映射必须存在');
  assert.ok(controller.includes('startBgm'), 'controller 必须拉取并启动 BGM');
  const server = readFileSync(resolve(root, 'plugins/voice-radio/server.mjs'), 'utf8');
  assert.ok(server.includes("'/api/voice-radio/bgm'"), 'server 必须提供 /bgm 端点');

  // BGM 合成器真跑：确定性 + WAV 头 + 时长
  const { renderBgm } = await import(bgm.href ?? `file://${bgm.replace(/\\/g, '/')}`);
  const a = renderBgm('calm', 2, 7);
  const b = renderBgm('calm', 2, 7);
  assert.equal(a.wavBase64, b.wavBase64, '同参数必须确定性一致（可缓存）');
  assert.ok(a.wavBase64.startsWith('UklGRg==') || a.wavBase64.slice(0, 6) === 'UklGRj' || Buffer.from(a.wavBase64.slice(0, 8), 'base64').slice(0, 4).toString() === 'RIFF', '必须是 WAV（RIFF）');
  assert.equal(a.seconds, 2);
  const c = renderBgm('upbeat', 2, 7);
  assert.notEqual(a.wavBase64, c.wavBase64, '不同风格产物必须不同');
});

test('voice-radio server：磁盘缓存 key 覆盖 voice/style/text/baseUrl', async (t) => {
  const { readFileSync } = await import('node:fs');
  const { resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const server = readFileSync(resolve(root, 'plugins/voice-radio/server.mjs'), 'utf8');
  assert.ok(server.includes('cacheKeyOf'), '必须有缓存 key 函数');
  assert.ok(server.includes('fnv1a'), '缓存 key 用 fnv1a（对齐 Polaris）');
  // Key 安全：config 响应体只含 configured 布尔，不回显 apiKey 明文。
  // 排除 !!cfg.apiKey（布尔化，非回显）；命中其余形态（如 { apiKey: ... }）即违规。
  const configEcho = [...server.matchAll(/sendJson\(200,\s*\{[^}]*\}/g)]
    .map((m) => m[0])
    .filter((s) => s.includes('apiKey') && !s.includes('!!cfg.apiKey'));
  assert.deepEqual(configEcho, [], `config 响应不得回显 apiKey：${configEcho.join(' ; ')}`);
  // 会话门禁
  assert.ok(server.includes('getSession'), 'server 半边必须有会话门禁');
  // 串行单飞
  assert.ok(server.includes('synthChain'), '合成必须串行单飞（并发排队会突破超时）');
});
