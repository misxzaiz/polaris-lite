/**
 * browser-lite 引擎回归测试（stub 注入，零宿主依赖零 Chrome）。
 *
 * 覆盖 plan §10 验收 2 的引擎不变量：
 *   - acquire 的 reuse/create/require_new 语义；
 *   - agentKey 绑定路由（会话隔离核心）；
 *   - **跨会话 tabId 归属校验拒绝**（比 browser-desk 更严的新语义）；
 *   - TTL 解绑；
 *   - 事件环容量与 watch 增量；
 *   - wait 超时；
 *   - 导航围栏（guardUrl 注入后 AI 导航动作被拦）；
 *   - tabs 全局视图；
 *   - 服务端围栏纯函数（createUrlGuard 私有段/scheme 拒绝）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = resolve(root, 'plugins', 'browser-lite');

/** 动态 import 引擎（server.mjs 依赖宿主注入，引擎本身零依赖可直接导入） */
const { createEngine } = await import(pathToFileURL(resolve(pluginDir, 'engine.mjs')).href);
/** 服务端围栏纯函数：单独 import 会拉起引擎核（无副作用，createServerPart 才有副作用）——
 *  server.mjs 顶层只有 import 声明与函数定义，import 无副作用，安全 */
const serverMod = await import(pathToFileURL(resolve(pluginDir, 'server.mjs')).href);

// ── stub puppeteer（对齐 browser-desk test/unit.mjs 的注入式手法）──────────
function makeStubPuppeteer() {
  const state = { launches: 0, pages: [] };
  class StubPage {
    constructor(id) {
      this._id = id;
      this.urlValue = 'about:blank';
      this.keyboard = { press: async () => {} };
      this.cdp = null;
      this.listeners = new Map();
      this.closed = false;
    }
    target() { return { _targetId: this._id, type: () => 'page', page: async () => this }; }
    url() { return this.urlValue; }
    on(ev, fn) { this.listeners.set(ev, fn); }
    async goto(u) { this.urlValue = u; }
    async title() { return 'stub title'; }
    async evaluate(fn, ...args) {
      if (typeof fn === 'string') return null;
      return fn(...args);
    }
    async evaluateHandle(fn, ...args) {
      const el = await fn(...args);
      return {
        asElement: () => el ? {
          scrollIntoViewIfNeeded: async () => {},
          click: async () => {},
          evaluate: async () => 'input',
          select: async () => {},
        } : null,
      };
    }
    async $() { return null; }
    async $$() { return []; }
    async setViewport() {}
    async screenshot() { return 'c3R1Yg=='; } // base64 "stub"
    async waitForNetworkIdle() {}
    async createCDPSession() {
      return { send: async () => {}, on: () => {} };
    }
    async close() { this.closed = true; }
  }
  const browser = {
    connected: true,
    targets: async () => [],
    target: () => ({
      createCDPSession: async () => ({ send: async () => {}, on: () => {} }),
    }),
    newPage: async (opts) => {
      const p = new StubPage(`t${state.pages.length + 1}`);
      p._windowOpts = opts;
      state.pages.push(p);
      return p;
    },
    on() {},
    close: async () => { browser.connected = false; },
  };
  const puppeteer = {
    launch: async (opts) => {
      state.launches += 1;
      state.launchOpts = opts;
      return browser;
    },
  };
  return { puppeteer, state, browser };
}

function makeEngine(overrides = {}) {
  const { puppeteer, state } = makeStubPuppeteer();
  const guardCalls = [];
  const engine = createEngine({
    loadPuppeteer: async () => puppeteer,
    chromePath: 'C:\\stub\\chrome.exe',
    guardUrl: overrides.guardUrl ?? ((u) => { guardCalls.push(u); }),
    log: { info() {}, warn() {}, error() {}, debug() {} },
    ...(overrides.launchArgs ? { launchArgs: overrides.launchArgs } : {}),
  });
  return { engine, state, guardCalls };
}

test('acquire: create 模式新建标签并绑定 agentKey', async () => {
  const { engine } = makeEngine();
  const info = await engine.acquire({ url: 'https://example.com', mode: 'create', agentKey: 'a1' });
  assert.equal(info.url, 'https://example.com');
  assert.ok(info.tabId);
  const st = await engine.status();
  assert.equal(st.tabs.length, 1);
  assert.equal(st.tabs[0].agentKey, 'a1');
});

test('acquire: reuse 复用 agentKey 绑定标签；不同 agentKey 不复用', async () => {
  const { engine } = makeEngine();
  const first = await engine.acquire({ url: 'https://a.com', mode: 'create', agentKey: 'k1' });
  const second = await engine.acquire({ agentKey: 'k1' }); // reuse
  assert.equal(second.tabId, first.tabId);
  const third = await engine.acquire({ agentKey: 'k2' });
  assert.notEqual(third.tabId, first.tabId);
});

test('resolveTab: agentKey 绑定路由（会话隔离核心）', async () => {
  const { engine } = makeEngine();
  const a = await engine.acquire({ agentKey: 'ka', mode: 'create' });
  engine._internal.advanceClock(10);
  const b = await engine.acquire({ agentKey: 'kb', mode: 'create' });
  const ra = engine.resolveTab({ agentKey: 'ka' });
  engine._internal.advanceClock(1);
  const rb = engine.resolveTab({ agentKey: 'kb' });
  assert.equal(ra.tabId, a.tabId);
  assert.equal(rb.tabId, b.tabId);
});

test('隔离核心：跨会话 tabId 归属校验拒绝（A 不能操作 B 的标签）', async () => {
  const { engine } = makeEngine();
  const a = await engine.acquire({ agentKey: 'sa', mode: 'create' });
  engine._internal.advanceClock(10);
  const b = await engine.acquire({ agentKey: 'sb', mode: 'create' });
  // sb 显式传 a 的 tabId → 拒绝
  assert.throws(() => engine.resolveTab({ agentKey: 'sb', tabId: a.tabId }), /不属于当前会话/);
  // sa 传自己的 tabId → 放行
  const ok = engine.resolveTab({ agentKey: 'sa', tabId: a.tabId });
  assert.equal(ok.tabId, a.tabId);
  // 无绑定会话传任何 tabId → 拒绝
  assert.throws(() => engine.resolveTab({ agentKey: 'sc', tabId: b.tabId }), /不属于当前会话/);
});

test('closeTab: AI 只能关自己绑定的标签；面板（无 agentKey）可关任何标签', async () => {
  const { engine } = makeEngine();
  const a = await engine.acquire({ agentKey: 'sa', mode: 'create' });
  engine._internal.advanceClock(10);
  const b = await engine.acquire({ agentKey: 'sb', mode: 'create' });
  // sb 关 sa 的标签 → 拒绝
  await assert.rejects(() => engine.closeTab({ agentKey: 'sb', tabId: a.tabId }), /不属于当前会话/);
  // sb 关自己的标签 → 成功
  const r = await engine.closeTab({ agentKey: 'sb', tabId: b.tabId });
  assert.equal(r.closed, 1);
  // 面板动作（无 agentKey）关 sa 的标签 → 成功
  const r2 = await engine.closeTab({ tabId: a.tabId });
  assert.equal(r2.closed, 1);
});

test('TTL 解绑：无活动 30min 后绑定消失（标签保留）', async () => {
  const { engine } = makeEngine();
  const a = await engine.acquire({ agentKey: 'k1', mode: 'create' });
  engine._internal.advanceClock(31 * 60 * 1000);
  engine._internal.advanceClock(1);
  const st = await engine.status(); // status 内部 pruneAgentBinds
  assert.equal(st.agentBinds.length, 0);
  assert.equal(st.tabs.length, 1); // 标签保留（无主）
  assert.equal(st.tabs[0].agentKey, null);
  void a;
});

test('事件环：容量上限裁剪 + watch 增量拉取', async () => {
  const { engine } = makeEngine();
  const rec = await engine.acquire({ agentKey: 'k', mode: 'create' });
  for (let i = 0; i < 250; i += 1) {
    engine._internal.pushEvent(rec.tabId, 'console', { text: `m${i}` });
  }
  const r = await engine.watch({ tabId: rec.tabId, sinceSeq: 0 });
  assert.equal(r.events.length, 200); // 容量 200
  const r2 = await engine.watch({ tabId: rec.tabId, sinceSeq: r.lastSeq - 5, kinds: ['console'] });
  assert.equal(r2.events.length, 5); // 增量
});

test('wait: selector 超时抛错（stub 无元素）', async () => {
  const { engine } = makeEngine();
  await engine.acquire({ agentKey: 'k', mode: 'create' });
  await assert.rejects(
    () => engine.wait({ agentKey: 'k', selector: '.never-exists', timeoutMs: 600 }),
    /等待超时/,
  );
});

test('导航围栏：guardUrl 在 acquire/navigate 的 URL 规范化后生效', async () => {
  let blocked = null;
  const { engine } = makeEngine({
    guardUrl: (u) => {
      if (String(u).includes('169.254')) throw new Error(`导航围栏：拒绝 ${u}`);
    },
  });
  // 搜索词（非 URL）不触发围栏路径外的拒绝
  await engine.acquire({ url: 'tauri framework', agentKey: 'k', mode: 'create' });
  // 显式 URL 经 guard → 拒绝
  await assert.rejects(
    () => engine.navigate({ url: 'http://169.254.169.254/latest/meta-data', agentKey: 'k' }),
    /导航围栏/,
  );
  void blocked;
});

test('tabs action：列出全部标签与归属摘要（全局只读视图）', async () => {
  const { engine } = makeEngine();
  await engine.acquire({ agentKey: 'sa', mode: 'create' });
  engine._internal.advanceClock(10);
  await engine.acquire({ agentKey: 'sb', mode: 'create' });
  const list = engine.tabs();
  assert.equal(list.length, 2);
  const keys = list.map((t) => t.agentKey).sort();
  assert.deepEqual(keys, ['sa', 'sb']);
});

test('createUrlGuard：私有/环回/链路本地地址与非 http(s) scheme 拒绝', () => {
  const guard = serverMod.createUrlGuard({ allowLoopback: false });
  const bad = [
    'http://127.0.0.1/x',
    'http://10.0.0.1/',
    'http://172.16.0.1/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data',
    'http://localhost:3000/',
    'http://[::1]/',
    'file:///C:/Windows/win.ini',
    'chrome://settings',
  ];
  for (const u of bad) assert.throws(() => guard(u), undefined, `应拒绝 ${u}`);
  // 公网地址放行
  guard('https://www.bing.com/search?q=x');
  guard('http://8.8.8.8/');
  // allowLoopback 开启时环回放行（本机联调档）
  const guardLoose = serverMod.createUrlGuard({ allowLoopback: true });
  guardLoose('http://127.0.0.1:9825/');
});

test('findChromePath / loadPuppeteerCore：导出形状可用', async () => {
  assert.equal(typeof serverMod.findChromePath, 'function');
  assert.equal(typeof serverMod.loadPuppeteerCore, 'function');
  assert.equal(typeof serverMod.pruneShots, 'function');
  assert.equal(typeof serverMod.createServerPart, 'function');
  assert.equal(typeof serverMod.dispatchAction, 'function');
});

test('dispatchAction：screenshot 动作经 persistShot 只回引用', async () => {
  const { engine } = makeEngine();
  const tmp = mkdtempSync(resolve(tmpdir(), 'bl-shot-'));
  try {
    let saved = null;
    const r = await serverMod.dispatchAction(engine, { action: 'screenshot', sessionId: 'sk' }, {
      persistShot: async (base64, meta) => {
        saved = { base64, meta };
        return { shotId: 'uuid-x', url: `/api/browser/shot/uuid-x.jpg`, tabId: meta.tabId };
      },
    });
    assert.ok(saved, 'persistShot 应被调用');
    assert.equal(saved.base64, 'c3R1Yg==');
    assert.equal(r.shotId, 'uuid-x');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('launchArgs：独立 user-data-dir 注入到 puppeteer.launch（AI 登录态隔离）', async () => {
  const { engine, state } = makeEngine({ launchArgs: { userDataDir: 'D:/tmp/profile' } });
  await engine.acquire({ agentKey: 'k', mode: 'create' });
  assert.equal(state.launchOpts.userDataDir, 'D:/tmp/profile');
});
