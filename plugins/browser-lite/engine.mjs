/**
 * engine.mjs —— browser-lite 浏览器引擎核（纯逻辑，零 import，puppeteer 与常量全注入）
 *
 * 移植自 Polaris-plugin 仓 browser-desk/service/engine.js（986 行，真机 E2E 验证版），
 * 按 docs/browser-lite-plan.md §2/§4/§5 做 lite 适配：
 *   - ESM + 零依赖（arch 测试要求插件非 server.mjs 文件零外部依赖；
 *     本文件被 server.mjs 与单测共同消费，靠注入保持纯逻辑）；
 *   - 显式 tabId 也做归属校验（比 browser-desk 更严——需求核心：A 会话不得操作
 *     B 会话的标签。校验在 resolveTabSync，对所有带 agentKey 的调用生效）；
 *   - 导航围栏钩子（guardUrl 注入；私有/环回地址拒绝在 server.mjs 实现）；
 *   - 增加 tabs action（全部标签 + 归属会话摘要，需求「看当前有哪些打开的浏览器」）；
 *   - watch 长轮询改为 3s 短窗（原 25s 在 connect 中间件里占连接，见 plan §12）。
 *
 * 会话绑定语义（plan §4）：
 *   agentKey := chat-lite sessionId（loop 已在每个工具调用注入，模型无感）；
 *   agentBinds 表 + 30min TTL；所有操作先 resolveTab({agentKey}) 路由到本会话标签。
 */
'use strict';

const DEFAULTS = {
  agentBindTtlMs: 30 * 60 * 1000,   // 绑定 TTL：无活动 30min 解绑（标签保留，只解除归属）
  eventRingCapacity: 200,           // 每 tab 事件环容量
  defaultWaitTimeoutMs: 15 * 1000,  // wait 默认超时
  screenshotQuality: 60,
  screenshotMaxWidth: 1280,
  watchWindowMs: 3000,              // watch 短窗轮询（有增量立即返回，无增量 3s 返回空）
};

/** URL 识别与规范化（移植自 browser-desk shared/core.js，零依赖就地实现） */
function looksLikeUrl(s) {
  if (!s) return false;
  const t = String(s).trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return true;
  if (/^localhost(:\d+)?(\/|$)/i.test(t)) return true;
  return !/\s/.test(t) && /^[^\s]+\.[a-z]{2,}([/?#].*)?$/i.test(t);
}

function normalizeUrl(s) {
  const t = String(s || '').trim();
  if (!t) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return t;
  return `https://${t}`;
}

const SEARCH_ENGINES = {
  bing: 'https://www.bing.com/search?q={query}',
  baidu: 'https://www.baidu.com/s?wd={query}',
  duckduckgo: 'https://duckduckgo.com/?q={query}',
  google: 'https://www.google.com/search?q={query}',
};

function buildSearchUrl(query, engine, engines = SEARCH_ENGINES) {
  const tpl = engines[engine] || engines.bing;
  return tpl.replace('{query}', encodeURIComponent(String(query || '').trim()));
}

/** 事件类型白名单（watch kinds 参数合法值） */
const EVENT_KINDS = ['console', 'network', 'dialog', 'download', 'navigation', 'error'];

let seq = 0;
function nextSeq() {
  seq += 1;
  return seq;
}

/**
 * 创建引擎实例。
 * @param {object} opts
 * @param {Function} opts.loadPuppeteer  异步返回 puppeteer-core 模块（测试可注入 stub）
 * @param {string}  [opts.chromePath]   Chrome 可执行文件路径（server.mjs 定位后注入）
 * @param {Function} [opts.guardUrl]    导航围栏 (url) => void（违规抛错）；AI 导航动作必经
 * @param {object}   [opts.log]          日志器 {info,warn,error,debug}
 * @param {object}   [opts.launchArgs]   附加 launch 参数（如 userDataDir）
 */
export function createEngine({ loadPuppeteer, chromePath, guardUrl, log, launchArgs } = {}) {
  const logger = log || { info() {}, warn() {}, error() {}, debug() {} };
  const guard = typeof guardUrl === 'function' ? guardUrl : () => {};

  /** @type {{ connected: boolean } | null}  puppeteer Browser（结构子集） */
  let browser = null;
  let startingPromise = null;
  let closing = false;

  /** tab 池：tabId → 记录 */
  const tabs = new Map();
  /** agentKey → tabId 绑定表 */
  const agentBinds = new Map(); // agentKey -> { tabId, lastUsedAt }
  /** 每 tab 事件环：tabId → array（定长） */
  const eventRings = new Map();
  /** 每 tab 等待器：tabId → [{id, test, resolve, timer}] */
  const waiters = new Map();
  /** 每 tab 操作互斥队列 */
  const tabLocks = new Map();
  /** 下载跟踪：guid → {url, filename, state, receivedBytes, totalBytes, tabId} */
  const downloads = new Map();
  /** 每 tab 最新 screencast 帧：tabId → { data(base64), seq, ts, deviceWidth, deviceHeight } */
  const latestFrames = new Map();
  let frameSeq = 0;

  // ── 工具 ────────────────────────────────────────────────────────────────
  let clockOffset = 0;
  function now() { return Date.now() + clockOffset; }

  function ringFor(tabId) {
    let r = eventRings.get(tabId);
    if (!r) { r = []; eventRings.set(tabId, r); }
    return r;
  }

  function pushEvent(tabId, kind, data) {
    const ring = ringFor(tabId);
    const item = { seq: nextSeq(), ts: now(), kind, ...data };
    ring.push(item);
    if (ring.length > DEFAULTS.eventRingCapacity) ring.splice(0, ring.length - DEFAULTS.eventRingCapacity);
    // 唤醒等待器
    const ws = waiters.get(tabId);
    if (ws && ws.length) {
      const remaining = [];
      for (const w of ws) {
        try {
          if (w.test(item)) { clearTimeout(w.timer); w.resolve(item); }
          else remaining.push(w);
        } catch (_) { remaining.push(w); }
      }
      waiters.set(tabId, remaining);
    }
    return item;
  }

  /** 同一 tab 的操作串行化（CDP 并发调用同页易错） */
  function withTabLock(tabId, fn) {
    const prev = tabLocks.get(tabId) || Promise.resolve();
    const next = prev.then(fn, fn);
    tabLocks.set(tabId, next.catch(() => {}));
    return next;
  }

  function touchAgent(agentKey, tabId) {
    if (!agentKey) return;
    agentBinds.set(agentKey, { tabId, lastUsedAt: now() });
  }

  function pruneAgentBinds() {
    const cutoff = now() - DEFAULTS.agentBindTtlMs;
    for (const [k, v] of agentBinds) {
      if (v.lastUsedAt < cutoff) {
        agentBinds.delete(k);
        logger.debug(`agentKey 绑定过期解绑: ${k}`);
      }
    }
  }

  // ── Chrome 启动与自愈 ──────────────────────────────────────────────────
  /**
   * launch 带 profile 锁自愈：userDataDir 被上一个 Chrome 实例占用时
   * （进程退出后句柄释放有秒级延迟，Windows 实测），先按计划 profile 重试，
   * 仍失败则降级到一次性临时 profile（隔离性略降但可用性优先，并告警）。
   */
  async function launchWithProfileHealing(puppeteer) {
    const baseOpts = {
      executablePath: chromePath,
      headless: false,
      defaultViewport: null, // 网页开独立 Chrome 窗口（plan §2 裁定）
      protocolTimeout: 0,
      args: [
        '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--restore-last-session=false',
        ...(launchArgs?.args ?? []),
      ],
    };
    const attempts = launchArgs?.userDataDir
      ? [{ userDataDir: launchArgs.userDataDir }, { userDataDir: launchArgs.userDataDir }, {}]
      : [{}];
    let lastErr = null;
    for (let i = 0; i < attempts.length; i += 1) {
      try {
        return await puppeteer.launch({ ...baseOpts, ...attempts[i] });
      } catch (e) {
        lastErr = e;
        const locked = /already running|userDataDir|ProcessSingleton/i.test(String(e.message));
        if (!locked || i === attempts.length - 1) throw e;
        logger.warn(`Chrome 启动失败(profile 锁，重试 ${i + 1}/${attempts.length - 1}): ${e.message}`);
        await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
      }
    }
    throw lastErr;
  }

  async function ensureBrowser() {
    if (browser && browser.connected) return browser;
    if (startingPromise) return startingPromise;
    startingPromise = (async () => {
      const puppeteer = await loadPuppeteer();
      if (!chromePath) {
        throw new Error('未找到 Chrome/Edge：请设置 BROWSER_LITE_CHROME 环境变量指向 chrome.exe');
      }
      logger.info(`launch Chrome: ${chromePath}`);
      browser = await launchWithProfileHealing(puppeteer);
      browser.on('disconnected', () => {
        logger.warn('Chrome 断连');
        browser = null;
        tabs.clear();
        for (const k of agentBinds.keys()) agentBinds.delete(k);
      });
      // 下载事件（Browser domain，Chrome 117+）
      const cdp = await browser.target().createCDPSession();
      cdp.on('Browser.downloadWillBegin', (p) => {
        downloads.set(p.guid, {
          guid: p.guid, url: p.url, filename: p.suggestedFilename,
          state: 'inProgress', receivedBytes: 0, totalBytes: 0,
          tabId: p.targetInfo && p.targetInfo.targetId, startedAt: now(),
        });
        if (p.targetInfo && p.targetInfo.targetId) {
          pushEvent(p.targetInfo.targetId, 'download', {
            guid: p.guid, url: p.url, filename: p.suggestedFilename, state: 'inProgress',
          });
        }
      });
      cdp.on('Browser.downloadProgress', (p) => {
        const d = downloads.get(p.guid);
        if (d) {
          d.state = p.state; d.receivedBytes = p.receivedBytes; d.totalBytes = p.totalBytes;
        }
        if (p.state !== 'inProgress') {
          const rec = downloads.get(p.guid);
          if (rec && rec.tabId) {
            pushEvent(rec.tabId, 'download', { guid: p.guid, filename: rec.filename, state: p.state });
          }
          // 保留 5 分钟后清理
          setTimeout(() => downloads.delete(p.guid), 5 * 60 * 1000).unref?.();
        }
      });
      // 附加既有标签（宿主重启后 Chrome 若还活着，标签全量重新建档——plan §4.2）
      for (const t of await browser.targets()) {
        if (t.type() === 'page') attachTarget(t).catch(() => {});
      }
      browser.on('targetcreated', (t) => { if (t.type() === 'page') attachTarget(t).catch(() => {}); });
      browser.on('targetdestroyed', (t) => {
        if (t.type() !== 'page') return;
        const tabId = t._targetId;
        tabs.delete(tabId);
        eventRings.delete(tabId);
        waiters.delete(tabId);
        tabLocks.delete(tabId);
        for (const [k, v] of agentBinds) if (v.tabId === tabId) agentBinds.delete(k);
        logger.info(`tab 关闭: ${tabId}`);
      });
      logger.info('Chrome 引擎就绪');
      return browser;
    })();
    try {
      return await startingPromise;
    } finally {
      startingPromise = null;
    }
  }

  /** 接入一个 page target：订阅事件。返回 tab 记录（或 null=非页面 target） */
  async function attachTarget(target) {
    const tabId = target._targetId;
    if (tabs.has(tabId)) return tabs.get(tabId);
    let page;
    try { page = await target.page(); } catch (_) { return null; }
    if (!page) return null;
    const rec = {
      tabId,
      page,
      url: page.url(),
      title: '',
      agentKey: null,
      createdAt: now(),
      lastUsedAt: now(),
      windowId: null,
      cdp: null,
      screencastOn: false,
    };
    tabs.set(tabId, rec);
    ringFor(tabId); // 初始化事件环
    try {
      page.on('console', (m) => {
        pushEvent(tabId, 'console', { level: m.type(), text: String(m.text() || '').slice(0, 2000) });
      });
      page.on('pageerror', (e) => pushEvent(tabId, 'error', { message: String(e.message).slice(0, 2000) }));
      page.on('dialog', (d) => {
        pushEvent(tabId, 'dialog', { type: d.type(), message: String(d.message()).slice(0, 500) });
      });
      page.on('framenavigated', (f) => {
        if (f === page.mainFrame()) {
          rec.url = f.url();
          pushEvent(tabId, 'navigation', { url: f.url() });
        }
      });
      page.on('request', (r) => {
        pushEvent(tabId, 'network', { phase: 'request', url: r.url().slice(0, 500), method: r.method() });
      });
      page.on('response', (r) => {
        pushEvent(tabId, 'network', {
          phase: 'response', url: r.url().slice(0, 500), status: r.status(),
        });
      });
      const title = await page.title().catch(() => '');
      rec.title = title;
    } catch (e) {
      logger.warn(`attachTarget 事件订阅部分失败: ${e.message}`);
    }
    return rec;
  }

  async function close() {
    closing = true;
    if (browser) {
      try { await browser.close(); } catch (_) { /* ignore */ }
      browser = null;
    }
  }

  // ── tab 解析（隔离核心，plan §4.1）────────────────────────────────────
  /**
   * 解析目标 tab。规则（比 browser-desk 更严——显式 tabId 也做归属校验）：
   *   1. 带 agentKey（AI 调用必带）：
   *      a. 显式 tabId：必须是本 agentKey 绑定的标签，否则拒绝（防 A 操作 B 的标签）；
   *      b. 无显式 tabId：取 agentKey 绑定标签；未绑定返回 null（由调用方决定 acquire 或报错）。
   *   2. 无 agentKey（面板/status 等人用只读场景）：显式 tabId > 最近活跃。
   */
  function resolveTabSync({ tabId, agentKey } = {}) {
    pruneAgentBinds();
    if (agentKey) {
      const bind = agentBinds.get(agentKey);
      if (tabId) {
        if (!bind || bind.tabId !== tabId) {
          throw new Error(`标签 ${tabId} 不属于当前会话（归属校验拒绝）`);
        }
      }
      if (bind && tabs.has(bind.tabId)) {
        const rec = tabs.get(bind.tabId);
        rec.lastUsedAt = now();
        bind.lastUsedAt = now();
        return rec;
      }
      return null; // 未绑定：调用方决定 acquire（resolveOrCreate）或报错（resolveTab）
    }
    if (tabId) {
      const rec = tabs.get(tabId);
      if (!rec) throw new Error(`标签不存在: ${tabId}`);
      rec.lastUsedAt = now();
      return rec;
    }
    let best = null;
    for (const rec of tabs.values()) {
      if (!best || rec.lastUsedAt > best.lastUsedAt) best = rec;
    }
    if (best) best.lastUsedAt = now();
    return best;
  }

  function resolveTab(params = {}) {
    const rec = resolveTabSync(params);
    if (!rec) throw new Error('当前会话尚未绑定标签，请先调用 browser 工具的 acquire 动作');
    return rec;
  }

  /** 浏览类操作专用：无可用标签时自动开一个并绑定（开箱即用语义） */
  async function resolveOrCreate(params = {}) {
    const existing = resolveTabSync(params);
    if (existing) return existing;
    await ensureBrowser();
    return openNewTab({ agentKey: params.agentKey });
  }

  // ── 操作面 ─────────────────────────────────────────────────────────────
  /** 导航目标 URL 规范化 + 围栏校验（AI 导航动作必经 guardUrl，plan §5.2） */
  function toNavigableUrl(target) {
    const url = looksLikeUrl(target) ? normalizeUrl(target) : buildSearchUrl(target);
    guard(url);
    return url;
  }

  /**
   * 开/取标签。
   * mode: create=总是新建；reuse=优先 agentKey 绑定，无则新建；require_new=强制新窗口标签
   */
  async function acquire({ url, title, mode = 'reuse', newWindow = false, agentKey } = {}) {
    await ensureBrowser();
    pruneAgentBinds();
    const wantUrl = url ? toNavigableUrl(url) : 'about:blank';

    if (mode !== 'create' && mode !== 'require_new' && agentKey) {
      const bind = agentBinds.get(agentKey);
      if (bind && tabs.has(bind.tabId)) {
        const rec = tabs.get(bind.tabId);
        rec.lastUsedAt = now();
        bind.lastUsedAt = now();
        if (wantUrl !== 'about:blank') await navigateTab(rec, wantUrl);
        return tabInfo(rec);
      }
    }

    const rec = await openNewTab({ agentKey, url: wantUrl, title, newWindow: newWindow || mode === 'require_new' });
    return tabInfo(rec);
  }

  /** 新建一个 tab 并建档（acquire 与 resolveOrCreate 共用的核心） */
  async function openNewTab({ agentKey, url = 'about:blank', title, newWindow = false } = {}) {
    const page = await browser.newPage(newWindow ? { type: 'window' } : undefined);
    const tabId = page.target()._targetId;
    let rec = await attachTarget(page.target());
    if (!rec) {
      // target.page() 失败的兜底：直接以 page 建档
      rec = {
        tabId, page, url: page.url(), title: '', agentKey: null,
        createdAt: now(), lastUsedAt: now(), windowId: null, cdp: null, screencastOn: false,
      };
      tabs.set(tabId, rec);
      ringFor(tabId);
    }
    rec.url = page.url();
    if (title) rec.title = title;
    touchAgent(agentKey, tabId);
    if (url && url !== 'about:blank') {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => {
        logger.warn(`openNewTab goto 失败(继续): ${e.message}`);
      });
      rec.url = page.url();
      rec.title = await page.title().catch(() => rec.title);
    }
    pushEvent(tabId, 'navigation', { url: rec.url, reason: 'acquire' });
    return rec;
  }

  /**
   * 等待搜索结果渲染就绪：结果条目出现或正文充实即提前返回（上限 timeoutMs）。
   * 相比固定 waitForSelector：正常页 1-2s 返回；CF 挑战/慢页不拖满超时。
   */
  async function waitForResultsReady(page, timeoutMs = 6000) {
    const deadline = now() + timeoutMs;
    let lastLen = -1;
    while (now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      const st = await page.evaluate(() => ({
        items: document.querySelectorAll('#b_results > li.b_algo, #b_results h2 a, #rso h3, article, .result__snippet').length,
        len: (document.body && document.body.innerText) ? document.body.innerText.length : 0,
      })).catch(() => null);
      if (st) {
        if (st.items > 0) return true;
        if (st.len > 800) return true;
        if (st.len === lastLen && st.len === 0) return false;
        lastLen = st.len;
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 300));
    }
    return false;
  }

  async function navigateTab(rec, url) {
    const finalUrl = toNavigableUrl(url);
    await withTabLock(rec.tabId, async () => {
      await rec.page.goto(finalUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      rec.url = rec.page.url();
      rec.title = await rec.page.title().catch(() => rec.title);
      rec.lastUsedAt = now();
    });
    return { tabId: rec.tabId, url: rec.url, title: rec.title };
  }

  async function navigate({ url, query, tabId, agentKey } = {}) {
    const target = url || query;
    if (!target) throw new Error('navigate 需要 url 或 query');
    const rec = await resolveOrCreate({ tabId, agentKey });
    return navigateTab(rec, target);
  }

  async function search({ query, engine, limit = 8, tabId, agentKey, engines } = {}) {
    if (!query) throw new Error('search 需要 query');
    const rec = await resolveOrCreate({ tabId, agentKey });
    const searchUrl = buildSearchUrl(query, engine, engines);
    // 导航重试：搜索引擎偶发连接重置，Chrome 对同域名连接复用被 reset 时一次重试即可恢复
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await navigateTab(rec, searchUrl);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        if (!/ERR_CONNECTION|ERR_NETWORK|ERR_EMPTY_RESPONSE|ERR_TIMED_OUT/i.test(e.message)) throw e;
        logger.warn(`search 导航失败(重试 ${attempt + 1}/2): ${e.message}`);
        await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
      }
    }
    if (lastErr) throw lastErr;
    const page = rec.page;
    await waitForResultsReady(page, 6000);
    // 首轮渲染未就绪（正文 <400 字符视为未就绪——搜索页正常 >1000）→ 再等一轮
    const early = await page.evaluate(() => (document.body ? document.body.innerText.length : 0)).catch(() => 0);
    if (early < 400) await waitForResultsReady(page, 4000);
    const results = await page.evaluate((max) => {
      const pick = (sel) => Array.from(document.querySelectorAll(sel));
      // bing
      let items = pick('#b_results > li.b_algo').map((li) => {
        const a = li.querySelector('h2 a');
        return a ? { title: a.textContent.trim(), url: a.href, snippet: (li.querySelector('.b_caption p, .b_lineclamp2') || {}).textContent?.trim() || '' } : null;
      });
      if (!items.length) {
        // bing 兜底：结果容器变体（cf 盾放行后的延迟渲染 / 国际版布局差异）
        items = pick('#b_results h2 a').map((a) => {
          const li = a.closest('li');
          return {
            title: a.textContent.trim(),
            url: a.href,
            snippet: li ? ((li.querySelector('.b_caption p, .b_lineclamp2, p') || {}).textContent?.trim() || '') : '',
          };
        });
      }
      if (!items.length) {
        // google
        items = pick('#rso div.g, #rso > div').map((d) => {
          const a = d.querySelector('a[href^="http"]');
          const t = d.querySelector('h3');
          const s = d.querySelector('div[data-snhf], .VwiC3b, span.aCOpRe');
          return a && t ? { title: t.textContent.trim(), url: a.href, snippet: (s || {}).textContent?.trim() || '' } : null;
        });
      }
      if (!items.length) {
        // baidu
        items = pick('#content_left .result, #content_left .c-container').map((d) => {
          const a = d.querySelector('h3 a, .t a');
          const s = d.querySelector('.c-abstract, [class*=content-right], .c-span-last');
          return a ? { title: a.textContent.trim(), url: a.href, snippet: (s || {}).textContent?.trim() || '' } : null;
        });
      }
      if (!items.length) {
        // duckduckgo 新版（<article> data-testid 结构）
        items = Array.from(document.querySelectorAll('article')).map((art) => {
          const a = art.querySelector('a[data-testid="result-title-a"], h2 a, a[href^="http"]');
          if (!a) return null;
          const s = art.querySelector('[data-result="snippet"], .result__snippet');
          return {
            title: (art.querySelector('h2') || a).textContent.trim(),
            url: a.href,
            snippet: s ? s.textContent.trim().slice(0, 300) : '',
          };
        });
      }
      if (!items.length) {
        // duckduckgo html 旧版
        items = pick('#links .result, #links .web-result').map((d) => {
          const a = d.querySelector('a.result__a, h2 a');
          const s = d.querySelector('.result__snippet');
          return a ? { title: a.textContent.trim(), url: a.href, snippet: (s || {}).textContent?.trim() || '' } : null;
        });
      }
      return items.filter(Boolean).slice(0, max);
    }, limit);
    return { tabId: rec.tabId, url: rec.url, query, engine: engine || 'bing', results };
  }

  /** 正文抽取（打分容器算法，浏览器内执行） */
  const READ_SCRIPT = () => {
    const rm = (sel) => { document.querySelectorAll(sel).forEach((n) => n.remove()); };
    rm('script,style,noscript,nav,footer,header,aside,form,iframe,[role=navigation],[role=banner],[role=complementary]');
    const cands = Array.from(document.querySelectorAll('article,main,[role=main],.article,.content,.post,#content,.entry-content'));
    let best = null; let bestScore = -1;
    const pool = cands.length ? cands : [document.body];
    for (const el of pool) {
      let score = 0;
      const text = el.innerText || '';
      score += Math.min(text.length / 100, 50);
      score += el.querySelectorAll('p').length * 2;
      if (text.length > 2000) score += 20;
      if (score > bestScore) { bestScore = score; best = el; }
    }
    if (!best) return { title: document.title, text: '', url: location.href };
    const paras = Array.from(best.querySelectorAll('p,h1,h2,h3,li,blockquote,pre'))
      .map((p) => p.innerText.trim())
      .filter((t) => t.length > 0);
    // 降级链保证 read 永不空手而归（空文本=引擎健康下的语义失败）
    let text = paras.length ? paras.join('\n\n') : (best.innerText || '').trim();
    if (!text.trim()) {
      text = (best.textContent || '').trim().replace(/\s{3,}/g, '\n');
    }
    if (!text.trim()) {
      text = (document.body ? document.body.innerText : '') || '';
    }
    text = text.slice(0, 50000);
    return { title: document.title, url: location.href, text, textLength: text.length };
  };

  async function read({ tabId, agentKey, url, mode = 'article' } = {}) {
    let rec;
    if (url && (!tabId && !agentKey)) {
      // 读取指定 URL：在当前活跃 tab 导航后读取（无 tab 则自动开一个）
      rec = await resolveOrCreate({});
      await navigateTab(rec, url);
    } else {
      rec = await resolveOrCreate({ tabId, agentKey });
    }
    const result = await withTabLock(rec.tabId, () => rec.page.evaluate(READ_SCRIPT));
    void mode; // article/text 两模式当前同输出（保留参数兼容）
    return { tabId: rec.tabId, url: result.url, title: result.title, text: result.text, textLength: result.textLength };
  }

  /** 候选元素收集与打分（浏览器内执行） */
  const COLLECT_SCRIPT = () => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return false;
      const st = getComputedStyle(el);
      return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.05;
    };
    const els = Array.from(document.querySelectorAll('a,button,input,select,textarea,[role=button],[onclick],summary')).filter(visible);
    return els.slice(0, 120).map((el, i) => {
      const r = el.getBoundingClientRect();
      const text = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || '').trim().slice(0, 120);
      return {
        index: i,
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || '',
        text,
        href: el.tagName === 'A' ? el.href : undefined,
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      };
    });
  };

  async function click({ tabId, agentKey, label, index, text, selector } = {}) {
    const rec = await resolveOrCreate({ tabId, agentKey });
    return withTabLock(rec.tabId, async () => {
      let handle = null;
      if (selector) {
        handle = await rec.page.$(selector);
      } else {
        const items = await rec.page.evaluate(COLLECT_SCRIPT);
        let target = null;
        if (typeof index === 'number') {
          target = items[index];
        } else {
          const needle = String(label || text || '').toLowerCase();
          if (!needle) throw new Error('click 需要 label/text/index/selector 之一');
          // 精确包含匹配，取文本最长者（信息量最大）
          let bestLen = -1;
          for (const it of items) {
            if (it.text && it.text.toLowerCase().includes(needle) && it.text.length > bestLen) {
              target = it; bestLen = it.text.length;
            }
          }
        }
        if (!target) throw new Error(`未找到匹配元素: ${label || text || index}`);
        const all = await rec.page.evaluate(COLLECT_SCRIPT);
        const meta = all[target.index];
        handle = await rec.page.evaluateHandle((m) => {
          const visible = (el) => {
            const r = el.getBoundingClientRect();
            if (r.width < 4 || r.height < 4) return false;
            const st = getComputedStyle(el);
            return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.05;
          };
          const els = Array.from(document.querySelectorAll('a,button,input,select,textarea,[role=button],[onclick],summary')).filter(visible);
          return els[m.index] || null;
        }, meta);
        handle = handle.asElement();
      }
      if (!handle) throw new Error('元素定位失败');
      await handle.scrollIntoViewIfNeeded().catch(() => {});
      await handle.click({ delay: 30 }).catch(async () => {
        // 某些元素不可 click()（如 div[onclick]），降级派发事件
        await rec.page.evaluate((el) => el.click(), handle);
      });
      rec.lastUsedAt = now();
      // 点击后等网络空闲：最多 1.2s、空闲 250ms 即返回
      await rec.page.waitForNetworkIdle({ idleTime: 250, timeout: 1200 }).catch(() => {});
      return { tabId: rec.tabId, url: rec.page.url(), clicked: true };
    });
  }

  async function fill({ tabId, agentKey, label, selector, value } = {}) {
    if (value === undefined) throw new Error('fill 需要 value');
    const rec = await resolveOrCreate({ tabId, agentKey });
    return withTabLock(rec.tabId, async () => {
      let handle = null;
      if (selector) {
        handle = await rec.page.$(selector);
      } else {
        const needle = String(label || '').toLowerCase();
        if (!needle) throw new Error('fill 需要 label 或 selector');
        const items = await rec.page.evaluate(COLLECT_SCRIPT);
        const it = items.find((x) => x.text.toLowerCase().includes(needle) && ['input', 'textarea', 'select'].includes(x.tag));
        if (!it) throw new Error(`未找到表单元素: ${label}`);
        handle = await rec.page.$$('input,textarea,select').then((els) => els[Math.min(it.index, els.length - 1)]).catch(() => null);
        if (!handle) throw new Error(`表单元素定位失败: ${label}`);
      }
      if (!handle) throw new Error('元素定位失败');
      await handle.scrollIntoViewIfNeeded().catch(() => {});
      const tag = (await handle.evaluate((el) => el.tagName.toLowerCase())).trim();
      if (tag === 'select') {
        await handle.select(String(value));
      } else {
        await handle.evaluate((el, v) => {
          el.focus();
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
          setter.call(el, v);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, String(value));
      }
      return { tabId: rec.tabId, filled: true };
    });
  }

  async function pressKey({ keys, tabId, agentKey } = {}) {
    if (!keys) throw new Error('press_key 需要 keys');
    const rec = await resolveOrCreate({ tabId, agentKey });
    return withTabLock(rec.tabId, async () => {
      await rec.page.keyboard.press(String(keys));
      return { tabId: rec.tabId, pressed: keys };
    });
  }

  async function scroll({ amount, direction = 'down', tabId, agentKey } = {}) {
    const rec = await resolveOrCreate({ tabId, agentKey });
    return withTabLock(rec.tabId, async () => {
      const delta = Math.abs(Number(amount) || 600) * (direction === 'up' ? -1 : 1);
      await rec.page.evaluate((d) => { window.scrollBy(0, d); }, delta);
      return { tabId: rec.tabId, scrolled: delta };
    });
  }

  async function find({ query, tabId, agentKey } = {}) {
    if (!query) throw new Error('find 需要 query');
    const rec = await resolveOrCreate({ tabId, agentKey });
    return withTabLock(rec.tabId, async () => {
      const r = await rec.page.evaluate((q) => {
        const needle = q.toLowerCase();
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const hits = [];
        let node;
        while ((node = walker.nextNode()) && hits.length < 50) {
          const t = node.textContent || '';
          const i = t.toLowerCase().indexOf(needle);
          if (i >= 0) {
            hits.push(t.slice(Math.max(0, i - 40), i + q.length + 40).trim());
          }
        }
        return { count: hits.length, contexts: hits.slice(0, 10) };
      }, String(query));
      return { tabId: rec.tabId, ...r };
    });
  }

  async function screenshot({ tabId, agentKey, fullPage = false, quality, maxWidth } = {}) {
    const rec = await resolveOrCreate({ tabId, agentKey });
    const q = Math.min(100, Math.max(10, Number(quality) || DEFAULTS.screenshotQuality));
    const mw = Math.max(320, Number(maxWidth) || DEFAULTS.screenshotMaxWidth);
    return withTabLock(rec.tabId, async () => {
      await rec.page.setViewport({ width: Math.min(mw, 1600), height: 900 }).catch(() => {});
      const buf = await rec.page.screenshot({
        type: 'jpeg', quality: q, fullPage: !!fullPage, encoding: 'base64',
      });
      return { tabId: rec.tabId, mime: 'image/jpeg', base64: buf };
    });
  }

  async function evaluate({ script, tabId, agentKey } = {}) {
    if (!script) throw new Error('evaluate 需要 script');
    const rec = await resolveOrCreate({ tabId, agentKey });
    return withTabLock(rec.tabId, async () => {
      const r = await rec.page.evaluate(script);
      return { tabId: rec.tabId, result: r === undefined ? null : r };
    });
  }

  async function history({ tabId, agentKey, action = 'list' } = {}) {
    const rec = await resolveOrCreate({ tabId, agentKey });
    if (action === 'back' || action === 'forward') {
      await withTabLock(rec.tabId, async () => {
        if (action === 'back') await rec.page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        else await rec.page.goForward({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        rec.url = rec.page.url();
        rec.title = await rec.page.title().catch(() => rec.title);
      });
      return { tabId: rec.tabId, url: rec.url, action };
    }
    const entries = await withTabLock(rec.tabId, () => rec.page.evaluate(() => {
      return { length: history.length, current: location.href };
    }));
    return { tabId: rec.tabId, ...entries };
  }

  /**
   * 关标签。带 agentKey 时只能关自己绑定的标签（归属校验在 resolveTabSync）；
   * closeAll 只关本会话标签（AI 不应全量关闭——面板的全量关闭走无 agentKey 的面板通道）。
   */
  async function closeTab({ tabId, agentKey, closeAll } = {}) {
    await ensureBrowser();
    if (closeAll === true || closeAll === 'all') {
      if (agentKey) {
        // AI 的 closeAll 只关自己的标签（隔离语义）
        const bind = agentBinds.get(agentKey);
        const rec = bind ? tabs.get(bind.tabId) : null;
        if (!rec) return { closed: 0 };
        await rec.page.close().catch(() => {});
        return { closed: 1, tabId: rec.tabId };
      }
      const ids = [...tabs.keys()];
      for (const id of ids) {
        const rec = tabs.get(id);
        await rec.page.close().catch(() => {});
      }
      return { closed: ids.length };
    }
    const rec = resolveTab({ tabId, agentKey });
    await rec.page.close().catch(() => {});
    return { closed: 1, tabId: rec.tabId };
  }

  // ── 事件与等待 ─────────────────────────────────────────────────────────
  async function watch({ tabId, agentKey, kinds, sinceSeq = 0 } = {}) {
    const rec = resolveTab({ tabId, agentKey });
    const ring = ringFor(rec.tabId);
    const kindSet = Array.isArray(kinds) && kinds.length ? new Set(kinds) : null;
    // 短窗轮询（3s，plan §12 中间件挂起上限）：有增量立即返回；无增量返回空 + timeout 标记。
    // AI 侧循环调用即为流式感知，长轮询在 connect 中间件里会占住连接。
    const deadline = now() + DEFAULTS.watchWindowMs;
    for (;;) {
      const items = ring.filter((e) => e.seq > sinceSeq && (!kindSet || kindSet.has(e.kind)));
      if (items.length > 0) {
        return { tabId: rec.tabId, events: items, lastSeq: items[items.length - 1].seq };
      }
      if (now() >= deadline) {
        return { tabId: rec.tabId, events: [], lastSeq: sinceSeq, timeout: true };
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  async function wait({ tabId, agentKey, selector, urlPattern, downloadComplete, dialog, timeoutMs } = {}) {
    const rec = resolveTab({ tabId, agentKey });
    const timeout = Math.min(60000, Math.max(500, Number(timeoutMs) || DEFAULTS.defaultWaitTimeoutMs));
    const test = (event) => {
      if (selector && event.kind === 'navigation') return false; // selector 走 DOM 轮询
      if (urlPattern && event.kind === 'navigation' && new RegExp(urlPattern).test(event.url || '')) return true;
      if (downloadComplete && event.kind === 'download' && (event.state === 'completed' || event.state === 'canceled')) return true;
      if (dialog && event.kind === 'dialog') return true;
      return false;
    };
    if (urlPattern || downloadComplete || dialog) {
      const ring = ringFor(rec.tabId);
      const existing = ring.find(test);
      if (existing) return { tabId: rec.tabId, matched: existing };
      const p = new Promise((resolve) => {
        const w = { test, resolve, timer: null };
        w.timer = setTimeout(() => {
          const ws = waiters.get(rec.tabId) || [];
          const i = ws.indexOf(w);
          if (i >= 0) ws.splice(i, 1);
          resolve(null);
        }, timeout);
        if (!waiters.has(rec.tabId)) waiters.set(rec.tabId, []);
        waiters.get(rec.tabId).push(w);
      });
      const matched = await p;
      if (!matched) throw new Error(`等待超时(${timeout}ms): ${urlPattern || downloadComplete || dialog}`);
      return { tabId: rec.tabId, matched };
    }
    if (selector) {
      const deadlineSel = now() + timeout;
      while (now() < deadlineSel) {
        // eslint-disable-next-line no-await-in-loop
        const found = await rec.page.$(selector).catch(() => null);
        if (found) return { tabId: rec.tabId, matched: { kind: 'selector', selector } };
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error(`等待超时(${timeout}ms): selector ${selector}`);
    }
    throw new Error('wait 需要 selector_wait/urlPattern/downloadComplete/dialog 之一');
  }

  // ── Screencast 内嵌视图（面板实时画面 + 交互回传）─────────────────────
  async function ensureTabCdp(rec) {
    if (rec.cdp) return rec.cdp;
    const cdp = await rec.page.createCDPSession();
    rec.cdp = cdp;
    cdp.on('Page.screencastFrame', (p) => {
      frameSeq += 1;
      latestFrames.set(rec.tabId, {
        data: p.data,
        seq: frameSeq,
        ts: now(),
        deviceWidth: p.metadata ? p.metadata.deviceWidth : 0,
        deviceHeight: p.metadata ? p.metadata.deviceHeight : 0,
      });
      // ack 上限保护：不 ack Chrome 会停止推帧
      cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
    });
    return cdp;
  }

  async function screencastStart({ tabId, agentKey, quality = 50, maxWidth = 1280, everyNth = 1 } = {}) {
    const rec = await resolveOrCreate({ tabId, agentKey });
    const cdp = await ensureTabCdp(rec);
    if (!rec.screencastOn) {
      await cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: Math.min(90, Math.max(20, Number(quality) || 50)),
        maxWidth: Math.min(1920, Math.max(320, Number(maxWidth) || 1280)),
        everyNthFrame: Math.max(1, Number(everyNth) || 1),
      }).catch((e) => { throw new Error(`screencast 启动失败: ${e.message}`); });
      rec.screencastOn = true;
    }
    const f = latestFrames.get(rec.tabId);
    return { tabId: rec.tabId, streaming: true, hasFrame: !!f, seq: f ? f.seq : 0 };
  }

  async function screencastFrame({ tabId, agentKey, sinceSeq = 0 } = {}) {
    const rec = resolveTab({ tabId, agentKey });
    const f = latestFrames.get(rec.tabId);
    if (!f) return { tabId: rec.tabId, frame: null, seq: 0 };
    if (f.seq <= sinceSeq) return { tabId: rec.tabId, frame: null, seq: f.seq };
    return { tabId: rec.tabId, frame: { data: f.data, deviceWidth: f.deviceWidth, deviceHeight: f.deviceHeight }, seq: f.seq, ts: f.ts };
  }

  async function screencastStop({ tabId, agentKey } = {}) {
    const rec = resolveTab({ tabId, agentKey });
    if (rec.cdp && rec.screencastOn) {
      await rec.cdp.send('Page.stopScreencast').catch(() => {});
      rec.screencastOn = false;
    }
    return { tabId: rec.tabId, streaming: false };
  }

  /** 交互回传：鼠标（面板内嵌视图用，无 agentKey——面板动作，非 AI 动作） */
  async function inputMouse({ tabId, type, x, y, button = 'left', clickCount = 1, deltaX = 0, deltaY = 0 } = {}) {
    const rec = resolveTab({ tabId });
    const cdp = await ensureTabCdp(rec);
    const allowed = ['mousePressed', 'mouseReleased', 'mouseMoved', 'mouseWheel'];
    if (!allowed.includes(type)) throw new Error(`inputMouse 不支持 type: ${type}`);
    const params = { type, x: Number(x) || 0, y: Number(y) || 0, button: ['left', 'middle', 'right'].includes(button) ? button : 'left', clickCount: Number(clickCount) || 1 };
    if (type === 'mouseWheel') { params.deltaX = Number(deltaX) || 0; params.deltaY = Number(deltaY) || -60; }
    await cdp.send('Input.dispatchMouseEvent', params);
    return { tabId: rec.tabId, dispatched: type };
  }

  async function inputKey({ tabId, type = 'keyDown', key, text } = {}) {
    const rec = resolveTab({ tabId });
    const cdp = await ensureTabCdp(rec);
    if (text) {
      await cdp.send('Input.insertText', { text: String(text) });
      return { tabId: rec.tabId, inserted: String(text) };
    }
    const allowed = ['keyDown', 'keyUp', 'char'];
    if (!allowed.includes(type)) throw new Error(`inputKey 不支持 type: ${type}`);
    // 常见键 → CDP windowsVirtualKeyCode/key 简化映射；未识别键交由 text 路径
    const KEY_MAP = {
      Enter: { key: 'Enter', keyCode: 13 }, Tab: { key: 'Tab', keyCode: 9 },
      Escape: { key: 'Escape', keyCode: 27 }, Backspace: { key: 'Backspace', keyCode: 8 },
      Delete: { key: 'Delete', keyCode: 46 }, ArrowUp: { key: 'ArrowUp', keyCode: 38 },
      ArrowDown: { key: 'ArrowDown', keyCode: 40 }, ArrowLeft: { key: 'ArrowLeft', keyCode: 37 },
      ArrowRight: { key: 'ArrowRight', keyCode: 39 }, Space: { key: ' ', keyCode: 32 },
    };
    const k = KEY_MAP[key];
    const params = k
      ? { type, key: k.key, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode }
      : { type, key: String(key || ''), text: String(key || '') };
    await cdp.send('Input.dispatchKeyEvent', params);
    return { tabId: rec.tabId, dispatched: type, key };
  }

  // ── 状态与 tabs（需求：看当前有哪些打开的浏览器）───────────────────────
  function tabInfo(rec) {
    return {
      tabId: rec.tabId,
      url: rec.url,
      title: rec.title,
      agentKey: rec.agentKey || [...agentBinds.entries()].find(([, v]) => v.tabId === rec.tabId)?.[0] || null,
      createdAt: rec.createdAt,
      lastUsedAt: rec.lastUsedAt,
    };
  }

  /** tabs action：只读列出全部标签 + 归属摘要（AI 与面板共用；无归属校验——这是需求要的全局视图） */
  function listTabs() {
    pruneAgentBinds();
    return [...tabs.values()].map(tabInfo).sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }

  async function status() {
    pruneAgentBinds();
    return {
      engine: browser && browser.connected ? 'ready' : (startingPromise ? 'starting' : 'stopped'),
      chromePath: chromePath ?? null,
      tabs: listTabs(),
      agentBinds: [...agentBinds.entries()].map(([k, v]) => ({ agentKey: k, tabId: v.tabId, lastUsedAt: v.lastUsedAt })),
      downloads: [...downloads.values()].filter((d) => d.state === 'inProgress'),
    };
  }

  return {
    ensureBrowser,
    close,
    acquire,
    navigate,
    search,
    read,
    click,
    fill,
    pressKey,
    scroll,
    find,
    screenshot,
    evaluate,
    history,
    closeTab,
    watch,
    wait,
    tabs: listTabs,
    status,
    resolveTab,
    screencastStart,
    screencastFrame,
    screencastStop,
    inputMouse,
    inputKey,
    // 测试钩子
    _internal: { tabs, agentBinds, eventRings, downloads, pushEvent, advanceClock: (ms) => { clockOffset += ms; } },
  };
}

export { looksLikeUrl, normalizeUrl, buildSearchUrl, EVENT_KINDS, DEFAULTS };
