/**
 * vision 插件（图片识别）：AI 用视觉模型看图。
 * - 工具 look(path, prompt?)：读本地图片 → base64 → 视觉模型（providers.json 中带 vision 能力的模型）
 *   → 返回描述文本。图片只进 vision API，不进对话流/不落 artifact。
 * - 不自带 UI：识别结果是纯文本，直接回模型。
 * 上游解析：providers.json 里逐 provider 找 models[].capabilities.vision === true 的，
 * 优先 active 模型带 vision 的 provider；env PLITE_VISION_MODEL 可强制指定（providerId/modelId）。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { Agent, fetch as undiciFetch } from 'undici';
import { registerLookTool } from './tool.mjs';

const UPSTREAM_TIMEOUT_MS = 120 * 1000;
const upstreamAgent = new Agent({ headersTimeout: UPSTREAM_TIMEOUT_MS, bodyTimeout: UPSTREAM_TIMEOUT_MS });
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

/** 图片魔数 → mime（vision API 的 image_url dataUrl 用） */
function sniffImageMime(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  return null;
}

export function createServerPart(options = {}) {
  const providersFile = resolve(options.dataDir ?? '.polaris-lite', 'providers.json');
  const policy = options.policy;
  const logger = options.logger;

  /** 从 providers.json 选一个带 vision 能力的模型（env 强制 > active provider 的 vision 模型 > 全表扫） */
  function resolveVisionModels() {
    let list = [];
    try {
      const j = JSON.parse(readFileSync(providersFile, 'utf8'));
      list = Array.isArray(j) ? j : (j.providers ?? j.list ?? []);
    } catch { /* 读不到表就空 */ }
    const forced = (process.env.PLITE_VISION_MODEL ?? '').trim();
    if (forced) {
      const [pid, mid] = forced.split('/');
      const p = list.find((c) => c.id === pid || c.name === pid);
      if (p && p.apiKey) return [{ baseURL: p.baseURL, apiKey: p.apiKey, model: mid || p.activeModel }];
    }
    // 候选集：active 模型带 vision 的 provider 优先，再补其它 vision 模型（调用失败自动换下一个）
    const actives = [];
    const rest = [];
    for (const p of list) {
      if (p.enabled === false || !p.apiKey) continue;
      const activeCaps = (p.models ?? []).find((m) => m.id === (p.activeModel ?? ''))?.capabilities;
      if (activeCaps?.vision) actives.push({ baseURL: p.baseURL, apiKey: p.apiKey, model: p.activeModel });
      for (const m of (p.models ?? [])) {
        if (m.capabilities?.vision && m.id !== p.activeModel) rest.push({ baseURL: p.baseURL, apiKey: p.apiKey, model: m.id });
      }
    }
    return actives.length ? actives.concat(rest) : (rest.length ? rest : null);
  }

  /** 调视觉模型：messages 带 image_url dataUrl，返回纯文本回答 */
  async function runVision({ mime, b64, prompt, modelInfo, signal }) {
    const body = JSON.stringify({
      model: modelInfo.model,
      stream: false,
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
          { type: 'text', text: prompt || '请详细描述这张图片的内容。' },
        ],
      }],
    });
    const upstreamUrl = `${modelInfo.baseURL.replace(/\/+$/, '')}/chat/completions`;
    try { policy?.assertAllowedUrl?.(upstreamUrl); } catch (e) { throw new Error(`上游地址被策略拒绝：${e?.message ?? e}`); }
    const resp = await undiciFetch(upstreamUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${modelInfo.apiKey}` },
      body,
      signal,
      dispatcher: upstreamAgent,
    });
    const raw = await resp.text();
    if (resp.status !== 200) {
      let msg = `HTTP ${resp.status}`;
      try { const j = JSON.parse(raw); msg += `: ${j.error?.message ?? j.message ?? raw.slice(0, 200)}`; } catch { if (raw) msg += `: ${raw.slice(0, 200)}`; }
      throw new Error(`视觉模型调用失败 ${msg}`);
    }
    let j;
    try { j = JSON.parse(raw); } catch { throw new Error('视觉模型响应非 JSON'); }
    return String(j.choices?.[0]?.message?.content ?? '').trim();
  }

  if (options.registry) registerLookTool(options.registry);

  return async function visionApi(req, res, next) {
    const [pathname] = (req.url ?? '').split('?');
    if (!pathname.startsWith('/api/vision/')) return next?.();

    // 登录门禁：会话 cookie 或本地回环 Bearer 二选一（agent-runner 服务端编排
    // loopback 调用走 Bearer，与 agent-bash/fs/preview/media-push 同一纪律）。
    const authHeader = String(req.headers?.authorization ?? '');
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const bearerValid = !!(bearerToken && (options.verifyTempToken ?? (() => false))(bearerToken));
    const session = options.getSession?.(req);
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

    // POST /api/vision/look { path, cwd?, prompt? }
    if (pathname === '/api/vision/look' && req.method === 'POST') {
      let body;
      try { body = JSON.parse((await readBody()) || '{}'); } catch { return sendJson(400, { error: 'bad json', code: 'BAD_REQUEST' }); }
      const rawPath = String(body.path ?? '').trim();
      if (!rawPath) return sendJson(400, { error: '缺少 path', code: 'PATH_REQUIRED' });
      const cwd = body.cwd ? String(body.cwd) : '';
      const real = resolve(cwd || process.cwd(), rawPath);
      let st;
      try { st = statSync(real); } catch { return sendJson(400, { error: `文件不存在：${real}`, code: 'NOT_FOUND' }); }
      if (!st.isFile()) return sendJson(400, { error: '不是常规文件', code: 'NOT_FILE' });
      if (st.size > MAX_IMAGE_BYTES) return sendJson(400, { error: `图片过大（${Math.round(st.size / 1024 / 1024)}MB > 25MB）`, code: 'TOO_LARGE' });
      const buf = readFileSync(real);
      const mime = sniffImageMime(buf);
      if (!mime) return sendJson(400, { error: '不是可识别的图片格式（PNG/JPEG/WebP/GIF/BMP）', code: 'NOT_IMAGE' });
      const candidates = resolveVisionModels();
      if (!candidates || !candidates.length) return sendJson(500, { error: '没有可用的视觉模型：providers.json 中未找到 capabilities.vision 的模型', code: 'NO_VISION_MODEL' });
      const b64 = buf.toString('base64');
      const prompt = body.prompt ? String(body.prompt) : '';
      let lastErr = null;
      for (const modelInfo of candidates) {
        try {
          const text = await runVision({ mime, b64, prompt, modelInfo });
          logger?.info?.('[vision] ok', { file: real.slice(-80), model: modelInfo.model, outLen: text.length });
          return sendJson(200, { ok: true, text, model: modelInfo.model, bytes: st.size });
        } catch (e) {
          lastErr = e;
          logger?.warn?.('[vision] model failed, trying next', { model: modelInfo.model, err: String(e?.message ?? e).slice(0, 120) });
        }
      }
      return sendJson(502, { ok: false, error: String(lastErr?.message ?? lastErr) });
    }
    return next?.();
  };
}

export const __internal = { sniffImageMime, resolveVisionModel: null };
