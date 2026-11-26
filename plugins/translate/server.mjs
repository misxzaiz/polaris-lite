/**
 * translate 插件的服务端半边（/api/translate/*）。
 *
 * 自 Polaris「翻译」移植（src-tauri/src/commands/translate.rs 的 Node 等价实现，纯插件形态）：
 *  - POST /api/translate/translate { text, to? } → 百度翻译通用翻译 API（from=auto 自动检测源语言）
 *  - GET  /api/translate/config  → { configured, appId? }（面板判断是否已配置；appId 可回显）
 *  - POST /api/translate/config  { appId, secretKey } → 保存配置
 *
 * 密钥管理（对齐 voice-radio 惯例）：
 *  - 环境变量 PLITE_BAIDU_TRANSLATE_APP_ID / PLITE_BAIDU_TRANSLATE_SECRET_KEY 优先；
 *  - 否则读 <dataDir>/translate/config.json；写入走 POST /api/translate/config；
 *  - SecretKey 永不出服务端（config 端点只回 appId 与 configured 布尔）。
 *
 * 签名算法（同 Polaris translate.rs）：sign = MD5(appid + q + salt + secretKey)，salt 为毫秒时间戳。
 * 错误码映射（同 Polaris）：52001 超时 / 52003 未授权 / 54001 签名错误 / 54003 频率受限 等。
 *
 * 安全模型（对齐全仓 server 半边惯例）：
 *  - 会话 cookie 硬门禁 401；PLITE_TRANSLATE=0 一键禁用；
 *  - 文本长度上限 6000 字节内（百度标准版单次请求 q ≤ 6000 字节，UTF-8；前端按段切分）；
 *  - 上游固定 https://fanyi-api.baidu.com（过 policy.assertAllowedUrl）；
 *  - 内存 LRU 缓存（同 text+to 直接命中，避免重复计费）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const BAIDU_API = 'https://fanyi-api.baidu.com/api/trans/vip/translate';
const UPSTREAM_TIMEOUT_MS = 30 * 1000;
const MAX_TEXT_LEN = 6000;
const CACHE_MAX = 200;

/** 含中文判断（server 侧自动方向用） */
function containsChinese(text) {
  return /[\u4e00-\u9fa5]/.test(text);
}

/** 百度错误码 → 中文提示（对齐 Polaris translate.rs L41-54） */
const ERROR_CODE_MAP = {
  52001: '请求超时，请重试',
  52002: '服务出错，请稍后重试',
  52003: '未授权用户：请检查 App ID 与密钥',
  54000: '参数错误',
  54001: '签名错误：请检查 App ID 与密钥是否匹配',
  54003: '请求频率受限，请稍后再试',
  54004: '账户余额不足',
  54005: '请求过于频繁，请稍后再试',
  58000: '客户端 IP 不在授权名单',
  58001: '译文语言方向不支持',
  58002: '服务当前不可用',
  58003: '服务响应超时',
};

/** 支持的目标语言（百度 API 语言代码；面板/AI 工具白名单） */
export const SUPPORTED_LANGS = [
  { code: 'zh', label: '中文' },
  { code: 'en', label: '英语' },
  { code: 'jp', label: '日语' },
  { code: 'kor', label: '韩语' },
  { code: 'fra', label: '法语' },
  { code: 'de', label: '德语' },
  { code: 'ru', label: '俄语' },
  { code: 'spa', label: '西班牙语' },
  { code: 'wyw', label: '文言文' },
];

import { registerTranslateTool } from './tool.mjs';

export function createServerPart(options = {}) {
  // 工具声明随插件：启用本插件即注册 translate 工具；禁用即消失。
  if (options.registry) registerTranslateTool(options.registry);
  const getSession = options.getSession;
  const verifyTempToken = options.verifyTempToken ?? ((token) => false);
  const policy = options.policy;
  const dataDir = resolve(options.dataDir ?? '.polaris-lite');
  const pluginDir = resolve(dataDir, 'translate');
  const configFile = join(pluginDir, 'config.json');
  const hardOff = process.env.PLITE_TRANSLATE === '0';

  // ---- 配置读写（SecretKey 只在服务端） ----

  function loadConfig() {
    const envAppId = process.env.PLITE_BAIDU_TRANSLATE_APP_ID ?? '';
    const envSecret = process.env.PLITE_BAIDU_TRANSLATE_SECRET_KEY ?? '';
    try {
      if (!existsSync(configFile)) return { appId: envAppId, secretKey: envSecret };
      const j = JSON.parse(readFileSync(configFile, 'utf8'));
      return {
        appId: envAppId || String(j.appId ?? ''),
        secretKey: envSecret || String(j.secretKey ?? ''),
      };
    } catch {
      return { appId: envAppId, secretKey: envSecret };
    }
  }

  function saveConfig(patch) {
    mkdirSync(pluginDir, { recursive: true });
    const prev = loadConfig();
    const next = {
      appId: typeof patch.appId === 'string' ? patch.appId.trim() : prev.appId,
      secretKey: typeof patch.secretKey === 'string' ? patch.secretKey.trim() : prev.secretKey,
    };
    const tmp = `${configFile}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(tmp, configFile);
    return { configured: !!(next.appId && next.secretKey) };
  }

  // ---- 内存 LRU 缓存（key = `${to}|${text}`） ----

  const cache = new Map();
  function cacheGet(key) {
    if (!cache.has(key)) return null;
    const v = cache.get(key);
    cache.delete(key);
    cache.set(key, v); // 重插到队尾（LRU）
    return v;
  }
  function cachePut(key, value) {
    if (cache.has(key)) cache.delete(key);
    cache.set(key, value);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }

  // ---- 百度翻译调用 ----

  async function callBaidu(cfg, text, to) {
    const salt = String(Date.now());
    const sign = createHash('md5').update(cfg.appId + text + salt + cfg.secretKey).digest('hex');
    const params = new URLSearchParams({ q: text, from: 'auto', to, appid: cfg.appId, salt, sign });
    try {
      policy?.assertAllowedUrl?.(BAIDU_API);
    } catch (e) {
      throw new Error(`上游地址被策略拒绝：${e?.message ?? e}`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    let resp;
    try {
      resp = await fetch(BAIDU_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const raw = await resp.text();
    if (resp.status !== 200) throw new Error(`百度 API HTTP ${resp.status}: ${raw.slice(0, 200)}`);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('解析百度响应失败：非 JSON');
    }
    if (parsed.error_code) {
      const msg = ERROR_CODE_MAP[parsed.error_code] ?? `百度错误码 ${parsed.error_code}`;
      throw new Error(msg);
    }
    if (!Array.isArray(parsed.trans_result)) throw new Error('百度响应缺少 trans_result');
    // 多段结果逐项取 dst 后以 \n join（同 Polaris translate.rs L62-67）
    const result = parsed.trans_result.map((r) => String(r.dst ?? '')).filter(Boolean).join('\n');
    const src = parsed.trans_result.map((r) => String(r.src ?? '')).filter(Boolean).join('\n');
    return { result, src };
  }

  /** 带缓存的翻译入口（业务失败以 ok:false 返回而非抛错，保证 502 而非 500） */
  async function translateCached(text, to) {
    const cfg = loadConfig();
    if (!cfg.appId || !cfg.secretKey) {
      return { ok: false, error: '未配置百度翻译密钥：请在「翻译」面板填入 App ID 与密钥（百度翻译开放平台申请，个人版免费）' };
    }
    const key = `${to}|${text}`;
    const hit = cacheGet(key);
    if (hit) return { ok: true, result: hit.result, src: hit.src, to, cached: true };
    try {
      const r = await callBaidu(cfg, text, to);
      cachePut(key, r);
      return { ok: true, result: r.result, src: r.src, to, cached: false };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  // ---- 中间件 ----

  return async function translateApi(req, res, next) {
    if (hardOff) return next?.();
    const [pathname] = (req.url ?? '').split('?');
    if (!pathname.startsWith('/api/translate/')) return next?.();

    // 登录门禁：会话 cookie 或本地回环 Bearer（agent-runner 服务端编排 loopback 调用
    // 走 Bearer，与 agent-bash/fs/preview 同一纪律）二选一。
    const authHeader = String(req.headers?.authorization ?? '');
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const bearerValid = !!(bearerToken && verifyTempToken(bearerToken));
    const session = getSession?.(req);
    if (!session && !bearerValid) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'unauthorized', code: 'SESSION_REQUIRED' }));
    }

    const sendJson = (code, obj) => {
      if (res.headersSent || res.writableEnded) return;
      const body = JSON.stringify(obj);
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    };
    const readBody = () => new Promise((resolveBody, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > 256 * 1024) { req.destroy(); reject(new Error('BODY_TOO_LARGE')); return; }
        chunks.push(c);
      });
      req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });

    try {
      // GET /api/translate/config → { configured, appId?, langs }
      if (pathname === '/api/translate/config' && req.method === 'GET') {
        const cfg = loadConfig();
        return sendJson(200, { configured: !!(cfg.appId && cfg.secretKey), appId: cfg.appId || undefined, langs: SUPPORTED_LANGS });
      }

      // POST /api/translate/config { appId, secretKey } → 保存（SecretKey 不回显）
      if (pathname === '/api/translate/config' && req.method === 'POST') {
        const body = JSON.parse((await readBody()) || '{}');
        const r = saveConfig(body);
        return sendJson(200, { ok: true, ...r });
      }

      // POST /api/translate/translate { text, to? } → { result, src, to, cached? }
      if (pathname === '/api/translate/translate' && req.method === 'POST') {
        const body = JSON.parse((await readBody()) || '{}');
        const text = String(body.text ?? '').trim();
        if (!text) return sendJson(400, { ok: false, error: 'text 不能为空' });
        if (text.length > MAX_TEXT_LEN) return sendJson(400, { ok: false, error: `text 超长（${text.length} 字 > ${MAX_TEXT_LEN}），请分段翻译` });
        const to = String(body.to ?? 'en');
        if (!SUPPORTED_LANGS.some((l) => l.code === to)) return sendJson(400, { ok: false, error: `不支持的目标语言：${to}` });
        const r = await translateCached(text, to);
        return sendJson(r.ok ? 200 : 502, r);
      }

      // POST /api/translate/translate-batch { texts[], to? } → { results: (string|null)[] }（面板/插件批量接入）
      if (pathname === '/api/translate/translate-batch' && req.method === 'POST') {
        const body = JSON.parse((await readBody()) || '{}');
        const texts = Array.isArray(body.texts) ? body.texts : [];
        if (!texts.length) return sendJson(400, { ok: false, error: 'texts 不能为空' });
        if (texts.length > 50) return sendJson(400, { ok: false, error: 'texts 一次最多 50 条' });
        const to = body.to ? String(body.to) : '';
        if (to && !SUPPORTED_LANGS.some((l) => l.code === to)) return sendJson(400, { ok: false, error: `不支持的目标语言：${to}` });
        const cfg = loadConfig();
        if (!cfg.appId || !cfg.secretKey) return sendJson(502, { ok: false, error: '未配置百度翻译密钥：请在「翻译」面板填入 App ID 与密钥' });
        const results = [];
        for (const raw of texts) {
          const text = String(raw ?? '').trim();
          if (!text || text.length > MAX_TEXT_LEN) { results.push(null); continue; }
          const target = to || (containsChinese(text) ? 'en' : 'zh');
          try {
            const r = await translateCached(text, target);
            results.push(r.ok ? (r.result ?? null) : null);
          } catch { results.push(null); }
        }
        return sendJson(200, { ok: true, results });
      }

      return sendJson(404, { error: 'not found' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return sendJson(msg === 'BODY_TOO_LARGE' ? 413 : 500, { ok: false, error: msg });
    }
  };
}

/** 供测试使用（未导出到 runtime 面） */
export const _internals = { ERROR_CODE_MAP, randomId: randomUUID };
