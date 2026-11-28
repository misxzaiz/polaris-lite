/**
 * video-gen 插件：AI 文生视频，视频卡片直接出现在对话里。
 * - 工具 video(prompt, duration?, quality?) → 提交异步任务 → 轮询到完成 → mp4 落盘 → media-push 视频卡
 * - 上游可配置（按优先级）：
 *   1) env PLITE_VIDEO_GEN_URL + PLITE_VIDEO_GEN_KEY + PLITE_VIDEO_GEN_MODEL
 *   2) <dataDir>/video-gen/config.json { baseUrl, apiKey, model }
 * - 兼容智谱 cogvideox 异步任务 API（POST /videos 提交 → GET /async-result/{id} 轮询）。
 *   若上游是 OpenAI 兼容 videos API（同步/异步），也按同款结构适配。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Agent, fetch as undiciFetch } from 'undici';
import { registerVideoTool } from './tool.mjs';

const UPSTREAM_TIMEOUT_MS = 60 * 1000;
const upstreamAgent = new Agent({ headersTimeout: UPSTREAM_TIMEOUT_MS, bodyTimeout: UPSTREAM_TIMEOUT_MS });
const POLL_INTERVAL_MS = 5 * 1000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000; // 视频生成 10 分钟上限

export function createServerPart(options = {}) {
  const getSession = options.getSession;
  // 登录门禁：会话 cookie 或本地回环 Bearer 二选一（agent-runner 服务端编排
  // loopback 调用走 Bearer，与 agent-bash/fs/preview/media-push 同一纪律）。
  const verifyTempToken = options.verifyTempToken ?? (() => false);
  const policy = options.policy;
  const logger = options.logger;
  const dataDir = resolve(options.dataDir ?? '.polaris-lite');
  const configFile = join(dataDir, 'video-gen', 'config.json');

  if (options.registry) registerVideoTool(options.registry);

  function loadConfig() {
    const envUrl = (process.env.PLITE_VIDEO_GEN_URL ?? '').trim();
    const envKey = (process.env.PLITE_VIDEO_GEN_KEY ?? '').trim();
    const envModel = (process.env.PLITE_VIDEO_GEN_MODEL ?? '').trim();
    if (envUrl && envKey) return { baseUrl: envUrl, apiKey: envKey, model: envModel || 'cogvideox-3' };
    try {
      if (existsSync(configFile)) {
        const j = JSON.parse(readFileSync(configFile, 'utf8'));
        if (j.baseUrl && j.apiKey) {
          return {
            baseUrl: String(j.baseUrl).trim().replace(/\/+$/, ''),
            apiKey: String(j.apiKey),
            model: String(j.model ?? 'cogvideox-3'),
          };
        }
      }
    } catch { /* 坏文件视为未配置 */ }
    return null;
  }

  /** 提交任务：返回 { taskId }（智谱风格 id；OpenAI 风格也统一映射成这个字段） */
  async function submitTask(cfg, { prompt, duration, quality }) {
    const upstreamUrl = `${cfg.baseUrl.replace(/\/+$/, '')}/videos`;
    try { policy?.assertAllowedUrl?.(upstreamUrl); } catch (e) { throw new Error(`上游地址被策略拒绝：${e?.message ?? e}`); }
    const body = { model: cfg.model, prompt };
    if (duration) body.duration = duration;
    if (quality) body.quality = quality;
    const resp = await undiciFetch(upstreamUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
      dispatcher: upstreamAgent,
    });
    const raw = await resp.text();
    if (resp.status !== 200) {
      let msg = `HTTP ${resp.status}`;
      try { const j = JSON.parse(raw); msg += `: ${j.error?.message ?? j.message ?? raw.slice(0, 200)}`; } catch { if (raw) msg += `: ${raw.slice(0, 200)}`; }
      throw new Error(`视频任务提交失败 ${msg}`);
    }
    const j = JSON.parse(raw);
    const taskId = j.id ?? j.task_id ?? j.taskId;
    if (!taskId) throw new Error('上游未返回任务 id');
    return { taskId };
  }

  /** 轮询任务：SUCCESS → { url }；FAIL/超时 → throw */
  async function pollTask(cfg, taskId) {
    const base = cfg.baseUrl.replace(/\/+$/, '');
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    for (;;) {
      if (Date.now() > deadline) throw new Error('视频生成超时（10 分钟）');
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      let url = `${base}/async-result/${taskId}`;
      try { policy?.assertAllowedUrl?.(url); } catch (e) { throw new Error(`上游地址被策略拒绝：${e?.message ?? e}`); }
      const resp = await undiciFetch(url, {
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
        dispatcher: upstreamAgent,
      });
      if (resp.status !== 200) continue; // 偶发错误继续轮询
      const j = await resp.json().catch(() => null);
      if (!j) continue;
      const status = String(j.task_status ?? j.status ?? '').toUpperCase();
      if (status === 'SUCCESS') {
        const vurl = j.video_result?.[0]?.url ?? j.url ?? j.output?.url;
        if (!vurl) throw new Error('任务成功但未返回视频地址');
        return { url: vurl };
      }
      if (status === 'FAIL') throw new Error(`视频生成失败：${JSON.stringify(j).slice(0, 200)}`);
      // PROCESSING / 其它状态继续等
    }
  }

  return async function videoGenApi(req, res, next) {
    const [pathname] = (req.url ?? '').split('?');
    if (!pathname.startsWith('/api/video-gen/')) return next?.();

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

    // POST /api/video-gen/video { prompt, duration?, quality? } —— 同步等待完成（工具调用本身可能几分钟）
    if (pathname === '/api/video-gen/video' && req.method === 'POST') {
      let body;
      try { body = JSON.parse((await readBody()) || '{}'); } catch { return sendJson(400, { error: 'bad json', code: 'BAD_REQUEST' }); }
      const prompt = String(body.prompt ?? '').trim();
      if (!prompt) return sendJson(400, { error: '缺少 prompt', code: 'PROMPT_REQUIRED' });
      const cfg = loadConfig();
      if (!cfg) {
        return sendJson(500, {
          ok: false,
          error: '未配置视频生成上游：设 PLITE_VIDEO_GEN_URL/PLITE_VIDEO_GEN_KEY/PLITE_VIDEO_GEN_MODEL 环境变量，或写 <数据目录>/video-gen/config.json（如智谱 https://open.bigmodel.cn/api/paas/v4 + cogvideox-3）。',
          code: 'NOT_CONFIGURED',
        });
      }
      const outDir = join(dataDir, 'video-gen');
      mkdirSync(outDir, { recursive: true });
      try {
        const { taskId } = await submitTask(cfg, {
          prompt,
          duration: body.duration ? Number(body.duration) : null,
          quality: body.quality ? String(body.quality) : '',
        });
        logger?.info?.('[video-gen] submitted', { taskId, model: cfg.model });
        const { url } = await pollTask(cfg, taskId);
        const resp = await undiciFetch(url, { dispatcher: new Agent({ headersTimeout: POLL_TIMEOUT_MS, bodyTimeout: POLL_TIMEOUT_MS }) });
        if (!resp.ok) throw new Error(`下载生成视频失败 HTTP ${resp.status}`);
        const buf = Buffer.from(await resp.arrayBuffer());
        const outFile = join(outDir, `${Date.now()}.mp4`);
        writeFileSync(outFile, buf);
        logger?.info?.('[video-gen] done', { taskId, bytes: buf.length });
        return sendJson(200, { ok: true, outFile, bytes: buf.length, model: cfg.model });
      } catch (e) {
        logger?.warn?.('[video-gen] failed', { err: String(e?.message ?? e).slice(0, 200) });
        return sendJson(502, { ok: false, error: String(e?.message ?? e) });
      }
    }
    return next?.();
  };
}
