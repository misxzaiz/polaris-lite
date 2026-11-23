/**
 * voice-radio 插件的服务端半边（/api/voice-radio/*）。
 *
 * 自 Polaris「语音播报 Radio Broadcast」移植（纯插件实现，needs：无限播报+方向+手机后台播放）。
 * 职责（对齐 Polaris voice_capability.rs 的「合成」半边；音色库/内容库裁剪）：
 *  - POST /api/voice-radio/synthesize → 小米 MiMo TTS 合成（base64 dataUrl 直返，免本地托管端口）
 *  - POST /api/voice-radio/probe     → 开播预检（欢迎语现场合成；未配 Key 明确报错）
 *  - GET  /api/voice-radio/voices    → 预置音色表
 *  - GET  /api/voice-radio/config    → { configured: boolean }（面板提示是否已配 Key）
 *
 * API Key 管理（与 Polaris 同语义，但落在 lite 自己的数据目录）：
 *  - 环境变量 PLITE_MIMO_TTS_KEY 优先；否则读 <dataDir>/voice-radio/config.json 的 apiKey；
 *  - Key 永不出服务端（config 端点只回 configured 布尔）；写入走 POST /api/voice-radio/config。
 *
 * 安全模型（对齐全仓 server 半边惯例）：
 *  - 会话 cookie 硬门禁（未登录 401）；PLITE_VOICE_RADIO=0 一键禁用；
 *  - 文本长度上限 2000 字/句（MiMo 单次合成合理上限；超长请前端切句）；
 *  - 合成串行互斥（单飞）：MiMo 免费档并发吃紧 + 避免排队超时，同 Polaris「单进程串行」语义；
 *  - 音频缓存：句级磁盘缓存 <dataDir>/voice-radio/cache/<hash>.wav（fnv1a key，同 Polaris），
 *    重听/重开同方向零 API 成本；LRU 配额 500MB；
 *  - 上游地址固定 https://api.xiaomimimo.com/v1（允许 config.baseUrl 覆盖；过 policy.assertAllowedUrl）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, statSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Agent, fetch as undiciFetch } from 'undici';

const UPSTREAM_TIMEOUT_MS = 90 * 1000; // 与 Polaris mimo-tts 同：合成 90s 上限
const upstreamAgent = new Agent({ headersTimeout: UPSTREAM_TIMEOUT_MS, bodyTimeout: UPSTREAM_TIMEOUT_MS });

const MAX_TEXT_LEN = 2000;
const CACHE_DIR_NAME = 'cache';
const CACHE_MAX_BYTES = 500 * 1024 * 1024;
const DEFAULT_BASE_URL = 'https://api.xiaomimimo.com/v1';

/** 预置音色（与 Polaris mimo-tts 插件 PRESET_VOICES 一致；MiMo-默认 的 API id 是 mimo_default） */
const PRESET_VOICES = [
  { name: 'MiMo-默认', voiceId: 'mimo_default', language: '中/英', gender: '自动' },
  { name: '冰糖', voiceId: '冰糖', language: '中文', gender: '女' },
  { name: '茉莉', voiceId: '茉莉', language: '中文', gender: '女' },
  { name: '苏打', voiceId: '苏打', language: '中文', gender: '男' },
  { name: '白桦', voiceId: '白桦', language: '中文', gender: '男' },
  { name: 'Mia', voiceId: 'Mia', language: '英文', gender: '女' },
  { name: 'Chloe', voiceId: 'Chloe', language: '英文', gender: '女' },
  { name: 'Milo', voiceId: 'Milo', language: '英文', gender: '男' },
  { name: 'Dean', voiceId: 'Dean', language: '英文', gender: '男' },
];

export function createServerPart(options = {}) {
  const getSession = options.getSession;
  const policy = options.policy;
  const dataDir = resolve(options.dataDir ?? '.polaris-lite');
  const pluginDir = resolve(dataDir, 'voice-radio');
  const configFile = join(pluginDir, 'config.json');
  const cacheDir = join(pluginDir, CACHE_DIR_NAME);
  const hardOff = process.env.PLITE_VOICE_RADIO === '0';

  /** 合成单飞锁：同一进程内串行化 MiMo 调用（并发会排队累积突破超时，Polaris 实测） */
  let synthChain = Promise.resolve();

  // ---- 配置读写（Key 只在服务端） ----

  function loadConfig() {
    const envKey = process.env.PLITE_MIMO_TTS_KEY ?? '';
    try {
      if (!existsSync(configFile)) return { apiKey: envKey, baseUrl: DEFAULT_BASE_URL };
      const j = JSON.parse(readFileSync(configFile, 'utf8'));
      return {
        apiKey: envKey || String(j.apiKey ?? ''),
        baseUrl: String(j.baseUrl ?? DEFAULT_BASE_URL).trim().replace(/\/+$/, '') || DEFAULT_BASE_URL,
      };
    } catch {
      return { apiKey: envKey, baseUrl: DEFAULT_BASE_URL };
    }
  }

  function saveConfig(patch) {
    mkdirSync(pluginDir, { recursive: true });
    const prev = loadConfig();
    const next = {
      apiKey: typeof patch.apiKey === 'string' ? patch.apiKey.trim() : prev.apiKey,
      baseUrl: typeof patch.baseUrl === 'string' && patch.baseUrl.trim() ? patch.baseUrl.trim().replace(/\/+$/, '') : prev.baseUrl,
    };
    const tmp = `${configFile}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(tmp, configFile);
    return { configured: !!next.apiKey };
  }

  // ---- 磁盘缓存（fnv1a key + LRU 配额，对齐 Polaris voice_capability） ----

  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  function cacheKeyOf({ text, voice, style, baseUrl }) {
    return fnv1a(`${baseUrl}|${voice}|${style ?? ''}|${text}`);
  }

  function cacheGet(key) {
    const f = join(cacheDir, `${key}.wav`);
    if (!existsSync(f)) return null;
    try {
      return readFileSync(f);
    } catch {
      return null;
    }
  }

  function cachePut(key, buf) {
    try {
      mkdirSync(cacheDir, { recursive: true });
      const f = join(cacheDir, `${key}.wav`);
      writeFileSync(f, buf);
      evictCache();
    } catch { /* 缓存失败不影响合成主链路 */ }
  }

  function evictCache() {
    try {
      const entries = readdirSync(cacheDir)
        .map((name) => {
          const f = join(cacheDir, name);
          const st = statSync(f);
          return { f, size: st.size, at: st.mtimeMs };
        })
        .filter((e) => e.f.endsWith('.wav'));
      let total = entries.reduce((s, e) => s + e.size, 0);
      if (total <= CACHE_MAX_BYTES) return;
      entries.sort((a, b) => a.at - b.at); // 最久未用先淘汰
      for (const e of entries) {
        if (total <= CACHE_MAX_BYTES) break;
        unlinkSync(e.f);
        total -= e.size;
      }
    } catch { /* 忽略 */ }
  }

  // ---- MiMo TTS 调用（对齐 Polaris mimo-tts mcp/server.js callTtsApi） ----

  /**
   * 调 MiMo /chat/completions TTS。合成文本放 assistant content，风格指令放 user content；
   * audio.format=wav 非流式返回 base64。返回 { audioBuf, transcript }。
   */
  async function callMimo(cfg, { text, voice, style }) {
    const messages = [];
    if (style) messages.push({ role: 'user', content: style });
    messages.push({ role: 'assistant', content: text });
    const body = JSON.stringify({
      model: 'mimo-v2.5-tts',
      messages,
      audio: { format: 'wav', voice },
      stream: false,
    });
    const upstreamUrl = `${cfg.baseUrl}/chat/completions`;
    try {
      policy?.assertAllowedUrl?.(upstreamUrl);
    } catch (e) {
      throw new Error(`上游地址被策略拒绝：${e?.message ?? e}`);
    }
    const resp = await undiciFetch(upstreamUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body,
      dispatcher: upstreamAgent,
    });
    const raw = await resp.text();
    if (resp.status !== 200) {
      let msg = `HTTP ${resp.status}`;
      try {
        const j = JSON.parse(raw);
        const err = j.error;
        if (err) {
          const m = typeof err === 'string' ? err : err.message || JSON.stringify(err);
          const param = err && typeof err.param === 'string' && err.param ? `（${err.param}）` : '';
          msg += `: ${m}${param}`;
        }
      } catch {
        if (raw) msg += `: ${raw.slice(0, 200)}`;
      }
      throw new Error(`MiMo API 调用失败: ${msg}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('解析 MiMo 响应失败：非 JSON');
    }
    const audio = parsed.choices?.[0]?.message?.audio;
    if (!audio?.data) throw new Error('MiMo API 响应缺少 audio.data');
    return { audioBuf: Buffer.from(audio.data, 'base64'), transcript: parsed.choices[0].message.transcript || '' };
  }

  /** 带磁盘缓存的合成入口（串行单飞） */
  function synthesizeCached(args) {
    const task = synthChain.then(async () => {
      const cfg = loadConfig();
      if (!cfg.apiKey) return { ok: false, error: '未配置 MiMo API Key：请在「电台」面板的「语音服务」中填入 Key（小米 MiMo 开放平台申请，限时免费）' };
      const key = cacheKeyOf(args);
      const hit = cacheGet(key);
      if (hit) {
        return { ok: true, dataUrl: `data:audio/wav;base64,${hit.toString('base64')}`, sizeBytes: hit.length, cached: true, format: 'wav' };
      }
      const { audioBuf } = await callMimo(cfg, args);
      cachePut(key, audioBuf);
      return { ok: true, dataUrl: `data:audio/wav;base64,${audioBuf.toString('base64')}`, sizeBytes: audioBuf.length, cached: false, format: 'wav' };
    });
    // 链式推进：失败也继续（下一条合成不背上一条的失败）
    synthChain = task.then(() => undefined, () => undefined);
    return task;
  }

  // ---- 中间件 ----

  return async function voiceRadioApi(req, res, next) {
    if (hardOff) return next?.();
    const [pathname] = (req.url ?? '').split('?');
    if (!pathname.startsWith('/api/voice-radio/')) return next?.();

    const session = getSession?.(req);
    if (!session) {
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
      // GET /api/voice-radio/config → { configured, baseUrl? }
      if (pathname === '/api/voice-radio/config' && req.method === 'GET') {
        const cfg = loadConfig();
        return sendJson(200, { configured: !!cfg.apiKey });
      }

      // POST /api/voice-radio/config { apiKey?, baseUrl? } → 保存（Key 不回显）
      if (pathname === '/api/voice-radio/config' && req.method === 'POST') {
        const body = JSON.parse((await readBody()) || '{}');
        const r = saveConfig(body);
        return sendJson(200, { ok: true, ...r });
      }

      // GET /api/voice-radio/voices → 预置音色表
      if (pathname === '/api/voice-radio/voices' && req.method === 'GET') {
        return sendJson(200, { ok: true, voices: PRESET_VOICES });
      }

      // POST /api/voice-radio/synthesize { text, voice?, style? } → { dataUrl, sizeBytes, cached }
      if (pathname === '/api/voice-radio/synthesize' && req.method === 'POST') {
        const body = JSON.parse((await readBody()) || '{}');
        const text = String(body.text ?? '').trim();
        if (!text) return sendJson(400, { ok: false, error: 'text 不能为空' });
        if (text.length > MAX_TEXT_LEN) return sendJson(400, { ok: false, error: `text 超长（${text.length} > ${MAX_TEXT_LEN}），请切句后合成` });
        const voice = String(body.voice ?? '冰糖');
        const known = PRESET_VOICES.some((v) => v.voiceId === voice);
        if (!known) return sendJson(400, { ok: false, error: `未知音色：${voice}（请从预置音色表选择）` });
        const style = body.style ? String(body.style).slice(0, 500) : undefined;
        const r = await synthesizeCached({ text, voice, style, baseUrl: loadConfig().baseUrl });
        return sendJson(r.ok ? 200 : 502, r);
      }

      // POST /api/voice-radio/probe { voice? } → 开播预检（欢迎语现场合成，不入缓存）
      if (pathname === '/api/voice-radio/probe' && req.method === 'POST') {
        let body = {};
        try { body = JSON.parse((await readBody()) || '{}'); } catch { body = {}; }
        const cfg = loadConfig();
        if (!cfg.apiKey) return sendJson(200, { ok: false, error: '未配置 MiMo API Key：请在「电台」面板的「语音服务」中填入 Key' });
        const voice = String(body.voice ?? '冰糖');
        try {
          const { audioBuf } = await callMimo(cfg, { text: '你好，欢迎收听电台。', voice, style: undefined });
          return sendJson(200, { ok: true, sizeBytes: audioBuf.length });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return sendJson(200, { ok: false, error: msg });
        }
      }

      return sendJson(404, { error: 'not found' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return sendJson(msg === 'BODY_TOO_LARGE' ? 413 : 500, { ok: false, error: msg });
    }
  };
}
