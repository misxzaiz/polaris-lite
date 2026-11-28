/**
 * image-gen 插件：AI 文生图，图片卡片直接出现在对话里。
 * - 工具 draw(prompt, size?, n?, style?) → 上游 images API → png 落盘 → media-push 图片卡
 * - 上游可配置（按优先级）：
 *   1) env PLITE_IMAGE_GEN_URL + PLITE_IMAGE_GEN_KEY + PLITE_IMAGE_GEN_MODEL（完整指定）
 *   2) <dataDir>/image-gen/config.json { baseUrl, apiKey, model }（面板/env 均可配）
 *   3) 都没有 → 报「未配置」友好错误（本机 providers.json 的网关不支持 images 端点时走这里）
 * - 兼容 OpenAI images API（b64_json 或 url 两种返回）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Agent, fetch as undiciFetch } from 'undici';
import { registerDrawTool } from './tool.mjs';

const UPSTREAM_TIMEOUT_MS = 300 * 1000; // 文生图可能较慢
const upstreamAgent = new Agent({ headersTimeout: UPSTREAM_TIMEOUT_MS, bodyTimeout: UPSTREAM_TIMEOUT_MS });

export function createServerPart(options = {}) {
  const getSession = options.getSession;
  // 登录门禁：会话 cookie 或本地回环 Bearer 二选一（agent-runner 服务端编排
  // loopback 调用走 Bearer，与 agent-bash/fs/preview/media-push 同一纪律）。
  const verifyTempToken = options.verifyTempToken ?? (() => false);
  const policy = options.policy;
  const logger = options.logger;
  const dataDir = resolve(options.dataDir ?? '.polaris-lite');
  const configFile = join(dataDir, 'image-gen', 'config.json');

  if (options.registry) registerDrawTool(options.registry);

  function loadConfig() {
    const envUrl = (process.env.PLITE_IMAGE_GEN_URL ?? '').trim();
    const envKey = (process.env.PLITE_IMAGE_GEN_KEY ?? '').trim();
    const envModel = (process.env.PLITE_IMAGE_GEN_MODEL ?? '').trim();
    if (envUrl && envKey) return { baseUrl: envUrl, apiKey: envKey, model: envModel || 'cogview-4' };
    try {
      if (existsSync(configFile)) {
        const j = JSON.parse(readFileSync(configFile, 'utf8'));
        if (j.baseUrl && j.apiKey) {
          return {
            baseUrl: String(j.baseUrl).trim().replace(/\/+$/, ''),
            apiKey: String(j.apiKey),
            model: String(j.model ?? 'cogview-4'),
          };
        }
      }
    } catch { /* 坏文件视为未配置 */ }
    return null;
  }

  /** 调 images API；兼容 b64_json / url 两种返回。返回 { pngBuf } 数组 */
  async function generateImages(cfg, { prompt, size, n }) {
    const upstreamUrl = `${cfg.baseUrl.replace(/\/+$/, '')}/images/generations`;
    try { policy?.assertAllowedUrl?.(upstreamUrl); } catch (e) { throw new Error(`上游地址被策略拒绝：${e?.message ?? e}`); }
    const resp = await undiciFetch(upstreamUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model: cfg.model, prompt, ...(size ? { size } : {}), n }),
      dispatcher: upstreamAgent,
    });
    const raw = await resp.text();
    if (resp.status !== 200) {
      let msg = `HTTP ${resp.status}`;
      try { const j = JSON.parse(raw); msg += `: ${j.error?.message ?? j.message ?? raw.slice(0, 200)}`; } catch { if (raw) msg += `: ${raw.slice(0, 200)}`; }
      throw new Error(`图片生成失败 ${msg}`);
    }
    const j = JSON.parse(raw);
    const out = [];
    for (const item of (j.data ?? [])) {
      if (item.b64_json) out.push(Buffer.from(item.b64_json, 'base64'));
      else if (item.url) {
        const imgResp = await undiciFetch(item.url, { dispatcher: upstreamAgent });
        if (!imgResp.ok) throw new Error(`下载生成图片失败 HTTP ${imgResp.status}`);
        out.push(Buffer.from(await imgResp.arrayBuffer()));
      }
    }
    if (!out.length) throw new Error('上游未返回图片数据');
    return out;
  }

  return async function imageGenApi(req, res, next) {
    const [pathname] = (req.url ?? '').split('?');
    if (!pathname.startsWith('/api/image-gen/')) return next?.();

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

    // POST /api/image-gen/draw { prompt, size?, n? }
    if (pathname === '/api/image-gen/draw' && req.method === 'POST') {
      let body;
      try { body = JSON.parse((await readBody()) || '{}'); } catch { return sendJson(400, { error: 'bad json', code: 'BAD_REQUEST' }); }
      const prompt = String(body.prompt ?? '').trim();
      if (!prompt) return sendJson(400, { error: '缺少 prompt', code: 'PROMPT_REQUIRED' });
      const n = Math.max(1, Math.min(4, Number(body.n ?? 1) || 1));
      const size = body.size ? String(body.size) : '';
      const cfg = loadConfig();
      if (!cfg) {
        return sendJson(500, {
          ok: false,
          error: '未配置图片生成上游：设 PLITE_IMAGE_GEN_URL/PLITE_IMAGE_GEN_KEY/PLITE_IMAGE_GEN_MODEL 环境变量，或写 <数据目录>/image-gen/config.json。本机 providers.json 里的网关不支持 images 端点。',
          code: 'NOT_CONFIGURED',
        });
      }
      const outDir = join(dataDir, 'image-gen');
      mkdirSync(outDir, { recursive: true });
      try {
        const bufs = await generateImages(cfg, { prompt, size, n });
        const outFiles = [];
        for (let i = 0; i < bufs.length; i += 1) {
          const fname = `${Date.now()}-${i}.png`;
          const outFile = join(outDir, fname);
          writeFileSync(outFile, bufs[i]);
          outFiles.push(outFile);
        }
        logger?.info?.('[image-gen] generated', { model: cfg.model, n: bufs.length });
        return sendJson(200, { ok: true, outFiles, model: cfg.model });
      } catch (e) {
        logger?.warn?.('[image-gen] failed', { err: String(e?.message ?? e).slice(0, 200) });
        return sendJson(502, { ok: false, error: String(e?.message ?? e) });
      }
    }
    return next?.();
  };
}
