/**
 * AI 引擎注册化回归测试。
 *
 * 固化三条不变量：
 * 1. 核心只提供通用注册表 + 分派器，不认识任何具体引擎 id / 厂商；
 * 2. 消费方只调 cap.ai.chat，分派器按 payload.engineId 路由到 namespaced cap；
 * 3. 引擎形态（适配应用 / 自带 / 混合 / 其它协议）由 manifest 声明，消费方零改动。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CapBus } from '../src/core/bus.ts';
import { installAiEngineInfrastructure } from '../src/core/aiEngine.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function makeBus() {
  const bus = new CapBus();
  const manifests = [
    {
      id: 'real-engine',
      aiEngine: {
        id: 'real', displayName: '应用模型', modelSource: 'hybrid', default: true,
        features: { supportsTools: true, slashSkills: true },
      },
    },
    {
      id: 'cli-engine',
      aiEngine: {
        id: 'cli', displayName: 'CLI', modelSource: 'builtin',
        features: { supportsTools: false, slashSkills: false },
      },
    },
  ];
  installAiEngineInfrastructure(bus, () => manifests);

  bus.registerStreaming('cap.ai.chat.real', async (req, emit) => {
    emit({ kind: 'message.delta', payload: { text: 'REAL', echoed: req.payload.engineId } });
    emit({ kind: 'message.done', payload: {} });
  }, 'real-engine');
  bus.registerStreaming('cap.ai.chat.cli', async (req, emit) => {
    emit({ kind: 'message.delta', payload: { text: 'CLI', echoed: req.payload.engineId } });
    emit({ kind: 'message.done', payload: {} });
  }, 'cli-engine');
  bus.register('cap.ai.chat.real.interrupt', () => ({ found: false }), 'real-engine');
  bus.register('cap.ai.chat.cli.interrupt', () => ({ found: true }), 'cli-engine');
  bus.register('cap.ai.chat.cli.models', async () => ({ available: true, models: [{ id: 'm-1' }] }), 'cli-engine');
  return bus;
}

/** 模拟宿主把流式事件交给消费方，返回全部事件 */
function start(bus, payload) {
  return new Promise((resolveDone, reject) => {
    const got = [];
    const timer = setTimeout(() => reject(new Error('stream did not settle')), 2000);
    bus.dispatchStream(
      'chat-lite',
      ['cap.ai.chat'],
      { target: 'cap.ai.chat', action: 'start', payload },
      (ev) => {
        got.push(ev);
        if (ev.kind === 'message.done' || ev.kind === 'stream.error') {
          clearTimeout(timer);
          resolveDone(got);
        }
      },
    );
  });
}

test('核心注册了通用 cap + namespaced cap 保持单注册语义', () => {
  const bus = makeBus();
  const caps = bus.listCapabilities();
  for (const cap of ['cap.ai.engine', 'cap.ai.chat', 'cap.ai.chat.interrupt',
    'cap.ai.chat.real', 'cap.ai.chat.real.interrupt', 'cap.ai.chat.cli', 'cap.ai.chat.cli.interrupt']) {
    assert.ok(caps.includes(cap), `缺少 ${cap}`);
  }
  assert.throws(() => bus.register('cap.ai.chat', () => undefined), /already registered/);
});

test('cap.ai.engine.list 来自 manifest 声明并合并动态目录', async () => {
  const bus = makeBus();
  const res = await bus.dispatch('chat-lite', ['cap.ai.engine'], { target: 'cap.ai.engine', action: 'list' });
  assert.equal(res.ok, true);
  const { engines, defaultEngineId } = res.data;
  assert.equal(defaultEngineId, 'real');
  assert.equal(engines.length, 2);
  const cli = engines.find((e) => e.id === 'cli');
  assert.equal(cli.modelSource, 'builtin');
  assert.equal(cli.features.supportsTools, false);
  assert.equal(cli.available, true);
  assert.deepEqual(cli.models, [{ id: 'm-1' }]); // 动态 cap 覆盖静态声明
});

test('按 engineId 路由到对应引擎，事件注入 engineId，缺省走 default 引擎', async () => {
  const bus = makeBus();
  const toCli = await start(bus, { engineId: 'cli', prompt: 'hi' });
  assert.equal(toCli.find((e) => e.kind === 'message.delta').payload.text, 'CLI');
  assert.equal(toCli.find((e) => e.kind === 'message.delta').payload.engineId, 'cli');
  assert.equal(toCli.find((e) => e.kind === 'message.delta').payload.echoed, 'cli');

  const toDefault = await start(bus, { prompt: 'hi' });
  assert.equal(toDefault.find((e) => e.kind === 'message.delta').payload.text, 'REAL');
  assert.equal(toDefault.find((e) => e.kind === 'message.delta').payload.engineId, 'real');
});

test('未注册的 engineId 明确报错，不静默回落', async () => {
  const bus = makeBus();
  const events = await start(bus, { engineId: 'ghost', prompt: 'hi' });
  const err = events.find((e) => e.kind === 'stream.error');
  assert.ok(err, '应发出 stream.error');
  assert.match(err.payload.message, /未注册/);
});

test('中断：指定 engineId 单点；缺省扇出到所有引擎', async () => {
  const bus = makeBus();
  const single = await bus.dispatch('chat-lite', ['cap.ai.chat.interrupt'], {
    target: 'cap.ai.chat.interrupt', action: 'interrupt', payload: { engineId: 'cli' },
  });
  assert.deepEqual(single.data, { ok: true, found: true });

  const fanout = await bus.dispatch('chat-lite', ['cap.ai.chat.interrupt'], {
    target: 'cap.ai.chat.interrupt', action: 'interrupt', payload: {},
  });
  assert.equal(fanout.data.found, true); // 两个引擎里至少一个有在途流
});

test('核心与服务端不得出现具体引擎 id / 厂商写死', () => {
  const forbidden = ['codebuddy', 'real-engine', 'mock-engine', 'api.anthropic.com', 'api.openai.com', 'api.deepseek.com'];
  /** 剥离注释：注释里提到某引擎/厂商属正常文档，不算实现违规（与 server-boundary 同口径） */
  const stripComments = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const scan = (dir) => readdirSync(resolve(root, dir))
    .filter((f) => /\.(ts|tsx|mjs)$/.test(f))
    .flatMap((f) => {
      const path = resolve(root, dir, f);
      return stripComments(readFileSync(path, 'utf8')).split('\n').map((line, i) => ({ where: `${dir}/${f}:${i + 1}`, line }));
    });
  // server/ 是「核心零业务」的服务端一侧：引擎/厂商知识也必须在插件里，故一并纳入扫描。
  const hits = [...scan('src/core'), ...scan('plugins/chat-lite'), ...scan('server')].filter(({ line }) =>
    forbidden.some((word) => line.toLowerCase().includes(word.toLowerCase())),
  );
  assert.deepEqual(hits.map((h) => h.where), [], `发现写死的具体引擎/厂商：\n  ${hits.map((h) => `${h.where} ${h.line.trim()}`).join('\n  ')}`);
});
