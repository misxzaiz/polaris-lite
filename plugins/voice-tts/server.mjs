import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Agent, fetch as undiciFetch } from 'undici';
import { registerSpeakTool } from './tool.mjs';

const UPSTREAM_TIMEOUT_MS = 90 * 1000;
const upstreamAgent = new Agent({ headersTimeout: UPSTREAM_TIMEOUT_MS, bodyTimeout: UPSTREAM_TIMEOUT_MS });
const DEFAULT_BASE_URL = 'https://api.xiaomimimo.com/v1';
const MAX_TEXT_LEN = 2000;

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
  // 登录门禁：会话 cookie 或本地回环 Bearer 二选一（agent-runner 服务端编排
  // loopback 调用走 Bearer，与 agent-bash/fs/preview/media-push 同一纪律）。
  const verifyTempToken = options.verifyTempToken ?? (() => false);
  const policy = options.policy;
  const logger = options.logger;
  const dataDir = resolve(options.dataDir ?? '.polaris-lite');
  const configFile = join(dataDir, 'voice-radio', 'config.json');

  if (options.registry) registerSpeakTool(options.registry);

  function loadConfig() {
    const envKey = process.env.PLITE_MIMO_TTS_KEY ?? '';
    try {
      if (existsSync(configFile)) {
        const j = JSON.parse(readFileSync(configFile, 'utf8'));
        return {
          apiKey: envKey || String(j.apiKey ?? ''),
          baseUrl: String(j.baseUrl ?? DEFAULT_BASE_URL).trim().replace(/[/]+$/g, '') || DEFAULT_BASE_URL,
        };
      }
    } catch { /* 坏文件走 env */ }
    return { apiKey: envKey, baseUrl: DEFAULT_BASE_URL };
  }

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
    const upstreamUrl = cfg.baseUrl + '/chat/completions';
    try { policy?.assertAllowedUrl?.(upstreamUrl); } catch (e) { throw new Error('上游地址被策略拒绝：' + (e?.message ?? e)); }
    const resp = await undiciFetch(upstreamUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
      body,
      dispatcher: upstreamAgent,
    });
    const raw = await resp.text();
    if (resp.status !== 200) {
      let msg = 'HTTP ' + resp.status;
      try { const j = JSON.parse(raw); msg += ': ' + (j.error?.message ?? JSON.stringify(j.error)); } catch { if (raw) msg += ': ' + raw.slice(0, 200); }
      throw new Error('MiMo TTS 调用失败 ' + msg);
    }
    const j = JSON.parse(raw);
    const audio = j.choices?.[0]?.message?.audio;
    if (!audio?.data) throw new Error('MiMo 响应缺少 audio.data');
    return { audioBuf: Buffer.from(audio.data, 'base64'), transcript: j.choices[0].message.transcript || '' };
  }

  return async function voiceTtsApi(req, res, next) {
    const [pathname] = (req.url ?? '').split('?');
    if (!pathname.startsWith('/api/voice-tts/')) return next?.();

    // 登录门禁：会话 cookie 或本地回环 Bearer 二选一（agent-runner 服务端编排
    // loopback 调用走 Bearer，与 agent-bash/fs/preview/media-push 同一纪律）。
    const authHeader = String(req.headers?.authorization ?? '');
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const bearerValid = !!(bearerToken && verifyTempToken(bearerToken));
    const session = getSession?.(req);
    if (!session && !bearerValid) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'unauthorized', code: 'SESSION_REQUIRED' }));
    }
    const sendJson = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(obj));
    };
    const readBody = (maxBytes = 1024 * 1024) => new Promise((r) => {
      let size = 0; const chunks = [];
      req.on('data', (c) => { size += c.length; if (size <= maxBytes) chunks.push(c); });
      req.on('end', () => r(Buffer.concat(chunks).toString('utf8')));
      req.on('error', () => r(''));
    });

    if (pathname === '/api/voice-tts/speak' && req.method === 'POST') {
      let body;
      try { body = JSON.parse((await readBody()) || '{}'); } catch { return sendJson(400, { error: 'bad json', code: 'BAD_REQUEST' }); }
      const text = String(body.text ?? '').trim();
      if (!text) return sendJson(400, { error: '缺少 text', code: 'TEXT_REQUIRED' });
      if (text.length > MAX_TEXT_LEN) return sendJson(400, { error: '文本过长（' + text.length + ' > ' + MAX_TEXT_LEN + ' 字）', code: 'TOO_LONG' });
      const voice = String(body.voice ?? 'mimo_default').trim() || 'mimo_default';
      if (!PRESET_VOICES.some((v) => v.voiceId === voice)) {
        return sendJson(400, { error: '未知音色 ' + voice, code: 'BAD_VOICE' });
      }
      const style = body.style ? String(body.style).slice(0, 500) : '';
      const cfg = loadConfig();
      if (!cfg.apiKey) {
        return sendJson(500, { error: '未配置 MiMo API Key：请先在「电台」面板的「语音服务」填入 Key（两边共用同一份配置）', code: 'NO_API_KEY' });
      }
      const outDir = join(dataDir, 'voice-tts');
      mkdirSync(outDir, { recursive: true });
      try {
        const { audioBuf, transcript } = await callMimo(cfg, { text, voice, style });
        const fname = Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.wav';
        const outFile = join(outDir, fname);
        writeFileSync(outFile, audioBuf);
        logger?.info?.('[voice-tts] synthesized', { voice, bytes: audioBuf.length });
        return sendJson(200, { ok: true, outFile, bytes: audioBuf.length, transcript, voice });
      } catch (e) {
        logger?.warn?.('[voice-tts] failed', { err: String(e?.message ?? e).slice(0, 200) });
        return sendJson(502, { ok: false, error: String(e?.message ?? e) });
      }
    }

    if (pathname === '/api/voice-tts/voices' && req.method === 'GET') {
      return sendJson(200, { ok: true, voices: PRESET_VOICES });
    }
    return next?.();
  };
}
