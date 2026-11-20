/**
 * browser-lite 插件的服务端半边（/api/browser/*）：AI 网页操作的引擎与围栏。
 *
 * 这是「插件双入口」的服务端那一半：UI 半边在浏览器（index.ts 注册 cap.tool.browser，
 * Panel.tsx 面板），本文件提供 Node 侧实现——spawn 系统 Chrome（CDP）驱动网页、
 * tab 池、会话绑定路由、导航围栏与审计。由 plugins/server-registry.mjs 登记、
 * server/host.mjs 统一装配。宿主不认识 /api/browser/* 的任何语义；
 * 本文件被删除时宿主照常启动，只是浏览器能力 404（删除即降级试金石）。
 *
 * 设计（spec: docs/browser-lite-plan.md §2/§3.3/§5）：
 * - 引擎核在 ./engine.mjs（零 import 纯逻辑，注入 puppeteer；被本文件与单测共同消费）；
 * - 与 agent-bash 同先例：浏览器引擎属「浏览器沙箱物理边界之外」的能力，但
 *   业务裁决（围栏/审计/绑定）是 browser-lite 的领域决策，实现跟插件走；
 * - agentKey := chat-lite sessionId（UI 半边 dispatch 时携带），模型无感。
 *
 * 安全设计（plan §5）：
 * - 会话 cookie 硬门禁 + 临时 Bearer（本地回环）二选一（与 file-browser 同款）；
 * - PLITE_BROWSER=0 一键整体禁用（公网穿透形态建议默认关）；
 * - 导航围栏：AI 导航动作拒私有/环回/链路本地地址与非 http(s) scheme
 *   （BROWSER_LITE_ALLOW_LOOPBACK=1 仅供本机联调）；面板手动打开不受围栏限制但留审计；
 * - 全量审计落 <dataDir>/browser-audit.log（ts/sessionId/action/url/verdict/耗时）；
 * - Chrome 用独立 user-data-dir（<dataDir>/browser-lite-profile），AI 的 cookie/登录态
 *   与用户日常 Chrome 隔离；
 * - 截图落盘 <dataDir>/browser-shots/<uuid>.jpg，配额 50 张 mtime 淘汰，只回引用。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, appendFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createEngine } from './engine.mjs';

const SHOT_LIMIT = 50;
const SHOT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/i;

/** AI 导航围栏：拒私有/环回/链路本地地址与非 http(s) scheme（plan §5.2） */
export function createUrlGuard({ allowLoopback = false } = {}) {
  const isPrivateHost = (hostname) => {
    const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
    // IPv4 私有段（v4-mapped IPv6 先剥前缀）
    const v4 = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    const ip = v4 ? v4[1] : (h.match(/^\d+\.\d+\.\d+\.\d+$/) ? h : null);
    if (ip) {
      const a = ip.split('.').map(Number);
      if (a[0] === 127 || a[0] === 10) return true;                    // loopback / 10/8
      if (a[0] === 172 && a[1] >= 16 && a[1] <= 31) return true;     // 172.16/12
      if (a[0] === 192 && a[1] === 168) return true;                  // 192.168/16
      if (a[0] === 169 && a[1] === 254) return true;                  // link-local（云元数据）
      if (a[0] === 0 || a[0] >= 224) return true;                     // 0/8 与组播及以上
    }
    if (h === '::1' || h === 'fe80::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
    return false;
  };

  return function guardUrl(rawUrl) {
    let u;
    try { u = new URL(rawUrl); } catch { throw new Error(`非法 URL: ${rawUrl}`); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error(`仅支持 http/https 导航（拒绝 ${u.protocol}）`);
    }
    if (!allowLoopback && isPrivateHost(u.hostname)) {
      throw new Error(`导航围栏：拒绝私有/环回地址 ${u.hostname}（本机联调可设 BROWSER_LITE_ALLOW_LOOPBACK=1）`);
    }
  };
}

/** Chrome 可执行文件定位顺序（plan：BROWSER_LITE_CHROME → CHROME_PATH → 常见路径） */
export function findChromePath() {
  const candidates = [
    process.env.BROWSER_LITE_CHROME,
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env['ProgramFiles(x86)']
      ? `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`
      : '',
    process.env.LOCALAPPDATA
      ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`
      : '',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (existsSync(p)) return p;
    } catch (_) { /* ignore */ }
  }
  return null;
}

/** puppeteer-core 装载：插件目录 node_modules（缺失时报错给指引，不自动安装——plan §11） */
export function loadPuppeteerCore() {
  const req = createRequire(import.meta.url);
  try {
    return req('puppeteer-core');
  } catch {
    throw new Error(
      'puppeteer-core 未安装：请在 plugins/browser-lite/ 目录执行 npm install --no-save puppeteer-core@25',
    );
  }
}

/** 截图配额淘汰：超限按 mtime 淘汰最旧 */
export function pruneShots(shotsDir) {
  try {
    const files = readdirSync(shotsDir)
      .filter((f) => SHOT_UUID_RE.test(f))
      .map((f) => ({ f, m: statSync(join(shotsDir, f)).mtimeMs }))
      .sort((a, b) => a.m - b.m);
    for (let i = 0; i < files.length - SHOT_LIMIT; i += 1) {
      try { unlinkSync(join(shotsDir, files[i].f)); } catch (_) { /* best-effort */ }
    }
  } catch { /* 目录不存在等：忽略 */ }
}

export function createServerPart(options = {}) {
  const getSession = options.getSession;
  const verifyTempToken = options.verifyTempToken ?? (() => false);
  const dataDir = resolve(options.dataDir ?? '.polaris-lite');
  const shotsDir = resolve(dataDir, 'browser-shots');
  const profileDir = resolve(dataDir, 'browser-lite-profile');
  const auditFile = resolve(dataDir, 'browser-audit.log');
  const hardOff = process.env.PLITE_BROWSER === '0';
  const allowLoopback = process.env.BROWSER_LITE_ALLOW_LOOPBACK === '1';

  const log = {
    info: (m) => console.info(`[browser-lite] ${m}`),
    warn: (m) => console.warn(`[browser-lite] ${m}`),
    error: (m) => console.error(`[browser-lite] ${m}`),
    debug: () => {},
  };

  const engine = createEngine({
    loadPuppeteer: loadPuppeteerCore,
    chromePath: findChromePath(),
    guardUrl: createUrlGuard({ allowLoopback }),
    log,
    launchArgs: { userDataDir: profileDir },
  });

  /** 全量审计：每次 AI/面板动作一行（追加分块缓冲，浏览器动作频率低无需批量） */
  function audit(entry) {
    try {
      mkdirSync(dataDir, { recursive: true });
      appendFileSync(auditFile, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch { /* 审计失败不阻断操作（磁盘满等），但日志留痕 */ log.warn('审计落盘失败'); }
  }

  /** 截图落盘并返回引用（plan §6：走 artifact 通道，不塞 shadow transcript） */
  async function persistShot(base64, { tabId, pageUrl } = {}) {
    mkdirSync(shotsDir, { recursive: true });
    const shotId = `${randomUUID()}.jpg`;
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(shotsDir, shotId), Buffer.from(base64, 'base64'));
    pruneShots(shotsDir);
    return { shotId: shotId.replace(/\.jpg$/, ''), url: `/api/browser/shot/${shotId}`, tabId, pageUrl };
  }

  const readBody = (req, maxBytes = 1024 * 1024) => new Promise((r) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > maxBytes) req.destroy(); });
    req.on('end', () => r(b));
  });

  const sendJson = (res, code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  };

  return async function browserApi(req, res, next) {
    if (hardOff) return next?.();
    const [pathname] = (req.url ?? '').split('?');
    if (!pathname.startsWith('/api/browser/')) return next?.();

    // ---- 门禁：会话 cookie 或本地回环 Bearer 二选一（截图帧 GET 也带同源 cookie，不破渲染） ----
    const authHeader = String(req.headers.authorization ?? '');
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const session = getSession?.(req);
    const bearerValid = !!(bearerToken && verifyTempToken(bearerToken));
    if (!session && !bearerValid) {
      sendJson(res, 401, { error: 'unauthorized', code: 'SESSION_REQUIRED' });
      return;
    }

    // ---- 静态截图：GET /api/browser/shot/:uuid.jpg（sha 命名 + 正则校验防穿越） ----
    const shotMatch = /^\/api\/browser\/shot\/([0-9a-f-]+\.jpg)$/.exec(pathname);
    if (shotMatch) {
      const file = shotMatch[1];
      if (!SHOT_UUID_RE.test(file)) { res.writeHead(400); return res.end(); }
      const p = join(shotsDir, file);
      if (!existsSync(p)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600' });
      const { createReadStream } = await import('node:fs');
      createReadStream(p).pipe(res);
      return;
    }

    // ---- GET /api/browser/status：引擎状态 + 全部标签（面板 3s 轮询） ----
    if (pathname === '/api/browser/status' && req.method === 'GET') {
      try { sendJson(res, 200, await engine.status()); } catch (e) { sendJson(res, 500, { error: e.message }); }
      return;
    }

    // ---- GET /api/browser/screencast/:tabId：最新帧（面板内嵌视图 250ms 轮询） ----
    const scMatch = /^\/api\/browser\/screencast\/([A-Za-z0-9_-]+)$/.exec(pathname);
    if (scMatch && req.method === 'GET') {
      try {
        const sinceSeq = Number(new URL(req.url, 'http://x').searchParams.get('sinceSeq') ?? 0) || 0;
        const r = await engine.screencastFrame({ tabId: scMatch[1], sinceSeq });
        sendJson(res, 200, r);
      } catch (e) { sendJson(res, 500, { error: e.message }); }
      return;
    }

    // ---- POST /api/browser/dispatch：AI 通道（cap handler 转发）与面板动作 ----
    if (pathname === '/api/browser/dispatch' && req.method === 'POST') {
      let body;
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return sendJson(res, 400, { error: 'invalid json' }); }
      const action = String(body.action ?? '');
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : 'unknown';
      // AI 动作（带 sessionId）必经围栏+审计；面板手动动作（panel:*）无 sessionId，仅审计
      const startedAt = Date.now();
      let verdict = 'ok';
      try {
        const result = await dispatchAction(engine, body, { persistShot });
        audit({ at: startedAt, sessionId, action, url: String(body.url ?? body.query ?? ''), tabId: result?.tabId ?? body.tabId ?? null, verdict, tookMs: Date.now() - startedAt });
        sendJson(res, 200, { ok: true, result });
      } catch (e) {
        verdict = 'denylist';
        audit({ at: startedAt, sessionId, action, url: String(body.url ?? body.query ?? ''), verdict: 'error', error: e.message, tookMs: Date.now() - startedAt });
        sendJson(res, 200, { ok: false, error: e.message });
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  };
}

/**
 * 动作路由（server.mjs 与单测共用；AI 与面板同一入口）。
 * AI 语义动作直接映射引擎操作面；panel:* 是面板专用动作（手动 navigate 不走围栏、全量关闭）。
 */
export async function dispatchAction(engine, body, { persistShot } = {}) {
  const action = String(body.action ?? '');
  const sid = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : undefined;
  const scoped = { ...body, agentKey: sid }; // AI 动作带 sessionId → 引擎按会话绑定路由
  switch (action) {
    // ---- AI 工具动作（plan §3.1 action 枚举）----
    case 'acquire':
      return engine.acquire({ ...scoped, url: body.url, title: body.title, mode: body.mode, newWindow: body.newWindow });
    case 'navigate':
      return engine.navigate({ ...scoped, url: body.url, query: body.query, tabId: body.tabId });
    case 'search':
      return engine.search({ ...scoped, query: body.query, engine: body.engine, limit: body.limit, tabId: body.tabId });
    case 'read':
      return engine.read({ ...scoped, url: body.url, tabId: body.tabId });
    case 'click':
      return engine.click({ ...scoped, label: body.label, index: body.index, text: body.text, selector: body.selector, tabId: body.tabId });
    case 'fill':
      return engine.fill({ ...scoped, label: body.label, selector: body.selector, value: body.value, tabId: body.tabId });
    case 'press_key':
      return engine.pressKey({ ...scoped, keys: body.keys, tabId: body.tabId });
    case 'scroll':
      return engine.scroll({ ...scoped, amount: body.amount, direction: body.direction, tabId: body.tabId });
    case 'find':
      return engine.find({ ...scoped, query: body.query, tabId: body.tabId });
    case 'screenshot': {
      const r = await engine.screenshot({ ...scoped, fullPage: body.fullPage, quality: body.quality, maxWidth: body.maxWidth, tabId: body.tabId });
      // 落盘 + 只回引用（plan §6：base64 不进 shadow transcript）
      return persistShot(r.base64, { tabId: r.tabId, pageUrl: null });
    }
    case 'evaluate':
      return engine.evaluate({ ...scoped, script: body.script, tabId: body.tabId });
    case 'wait':
      return engine.wait({
        ...scoped, tabId: body.tabId,
        selector: body.selector_wait ?? body.selector, urlPattern: body.urlPattern,
        downloadComplete: body.downloadComplete, dialog: body.dialog, timeoutMs: body.timeoutMs,
      });
    case 'watch':
      return engine.watch({ ...scoped, tabId: body.tabId, kinds: body.kinds, sinceSeq: body.sinceSeq });
    case 'tabs':
      return { tabs: engine.tabs() }; // 只读全局视图（需求核心：看当前有哪些打开的浏览器）
    case 'close':
      return engine.closeTab({ tabId: body.tabId, agentKey: sid, closeAll: body.closeAll });
    case 'history':
      return engine.history({ ...scoped, tabId: body.tabId, action: body.historyAction });
    // ---- 面板专用动作（无 agentKey = 不做会话归属；手动导航不走围栏但审计留痕） ----
    case 'panel:navigate': {
      // 面板手动打开：用户自己可见可关，围栏只约束 AI 动作（plan §5.2 如实声明）
      const r = await engine.acquire({ url: body.url, mode: body.tabId ? 'reuse' : 'create' });
      if (body.tabId) await engine.navigate({ tabId: body.tabId, url: body.url });
      void r;
      return { ok: true };
    }
    case 'panel:closeTab':
      return engine.closeTab({ tabId: body.tabId }); // 无 agentKey = 归属校验跳过，人可关任何标签
    case 'panel:closeAll':
      return engine.closeTab({ closeAll: true });
    case 'panel:screencastStart':
      return engine.screencastStart({ tabId: body.tabId, quality: body.quality, maxWidth: body.maxWidth });
    case 'panel:screencastStop':
      return engine.screencastStop({ tabId: body.tabId });
    case 'panel:inputMouse':
      return engine.inputMouse({ tabId: body.tabId, type: body.type, x: body.x, y: body.y, button: body.button, clickCount: body.clickCount, deltaX: body.deltaX, deltaY: body.deltaY });
    case 'panel:inputKey':
      return engine.inputKey({ tabId: body.tabId, type: body.type, key: body.key, text: body.text });
    default:
      throw new Error(`unknown action: ${action}`);
  }
}
