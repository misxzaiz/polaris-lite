/**
 * transcript-share 插件的服务端半边：AI 对话全过程只读分享（needs #069）。
 *
 * 三个只读出口（同源同数据，服务端即时快照，非预生成文件）：
 *   GET /share/:token           → 自包含 HTML 转录页（免登录；数据+渲染 JS 全内联）
 *   GET /share/:token/json      → 结构化 JSON（AI 可直接消费）
 *   GET /share/:token/markdown → Markdown 转录（可直接贴给另一个 AI 会话）
 *
 * 实时：分享页内联 JS 对 ./json 轻量轮询（3s），快照源自 chat-store 落盘文件
 * （发起端 chat-lite 800ms 防抖 PUT），近实时。不桥接 chat-store 的 live SSE——那是
 * 它进程内私有扇出表，跨插件桥接需动核心；轮询落盘快照是全插件方案的零改动通道。
 *
 * 管理面（会话 cookie 硬门禁）：
 *   POST /api/share/create  { sessionId, ttlMs?, live? } → { token, url, expiresAt, live }
 *   GET  /api/share/list    → 活动分享列表（token 脱敏摘要）
 *   POST /api/share/revoke  { token }                    → 吊销
 *   POST /api/share/refresh { token, ttlMs? }            → 续期
 *
 * 数据源：chat-store 的持久化格式是跨插件公开约定（<dataDir>/chat-store/<id>.json =
 * { version, updatedAt, session }）。本插件直接读该文件取"含工具卡的最全快照"：
 * 工具卡 stdout/stderr 为 16KB/卡截断版、args 为 command 摘要——这是当前持久化形态
 * 的上限，超出部分需先动 chat-lite/agent-loop（明确不在本插件边界内）。
 *
 * 安全模型（对齐全仓 server 半边惯例）：
 * - 管理面未登录 401；PLITE_SHARE=0 一键禁用；
 * - /share/* 免鉴权但 token 即门禁（48 字节随机 hex = 384 bit 熵，不可猜）；
 * - 只读：无任何路径回写 chat-store；吊销/过期即刻失效；
 * - 脱敏 redact.mjs（字段名 + 密钥形态正则）对全部出口硬执行；
 * - token 落盘 <dataDir>/transcript-share/tokens.json（原子写；读取时惰性清理过期项）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync, statSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { redactJson } from './redact.mjs';
import { renderShareHtml, renderHumanMarkdown, renderHumanHtml, buildAiAnalysis, errorPage } from './render.mjs';

// ---- 采集面存储（inline：arch 门禁只豁免 server.mjs 的 node:* 依赖） ----
// 形态：每会话一个 JSONL <dataDir>/transcript-share/<dirName>/<sessionId>.jsonl，追加写天然原子。
// 护栏按面分别设置（createTraceStore 参数）。

function createTraceStore(dataDir, { dirName, lineCap = 512 * 1024, fileCap = 16 * 1024 * 1024, maxPerSession = 200 } = {}) {
  const dir = resolve(dataDir, 'transcript-share', dirName);
  const fileOf = (sessionId) => join(dir, `${sessionId}.jsonl`);

  function append(sessionId, rec) {
    if (!ID_RE.test(sessionId) || sessionId === 'unknown') return false;
    const line = JSON.stringify(rec);
    if (!line || line.length > lineCap) return false;
    try {
      const f = fileOf(sessionId);
      if (existsSync(f) && statSync(f).size > fileCap) return false;
      mkdirSync(dir, { recursive: true });
      appendFileSync(f, `${line}\n`, 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  function readAll(sessionId) {
    if (!ID_RE.test(sessionId)) return [];
    const f = fileOf(sessionId);
    if (!existsSync(f)) return [];
    let lines;
    try {
      lines = readFileSync(f, 'utf8').split('\n');
    } catch {
      return [];
    }
    const out = [];
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try {
        const j = JSON.parse(t);
        if (j && typeof j === 'object') out.push(j);
      } catch { /* 损坏行跳过 */ }
    }
    if (out.length > maxPerSession) return out.slice(out.length - maxPerSession);
    return out.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  }

  return { append, readAll, dir };
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,192}$/;
const TTL_MIN_MS = 60 * 60 * 1000;             // 1h
const TTL_MAX_MS = 30 * 24 * 60 * 60 * 1000;   // 30d
const TTL_DEFAULT_MS = 24 * 60 * 60 * 1000;    // 24h
/** 分享输出中单条 stdout/stderr 的展示上限（兜底；正常快照已被 16KB 卡上限约束） */
const OUT_CAP = 16 * 1024;
/** tokens.json 体积护栏（防失控膨胀） */
const TOKENS_FILE_CAP = 4 * 1024 * 1024;

export function createServerPart(options = {}) {
  const getSession = options.getSession;
  const dataDir = resolve(options.dataDir ?? '.polaris-lite');
  const chatStoreDir = resolve(dataDir, 'chat-store');
  const shareDir = resolve(dataDir, 'transcript-share');
  const tokensFile = join(shareDir, 'tokens.json');
  // 三个采集面：模型 API 轨迹 / 编排事件时间线（live-event 镜像）/ 逐跳轮次（ai-events TurnRecord）
  const traces = createTraceStore(dataDir, { dirName: 'traces' });
  const events = createTraceStore(dataDir, { dirName: 'events', lineCap: 256 * 1024, fileCap: 8 * 1024 * 1024, maxPerSession: 2000 });
  const turns = createTraceStore(dataDir, { dirName: 'turns', lineCap: 256 * 1024, fileCap: 8 * 1024 * 1024, maxPerSession: 500 });
  const hardOff = process.env.PLITE_SHARE === '0';

  // ---------------- token 存取 ----------------

  function loadTokens() {
    try {
      if (!existsSync(tokensFile)) return {};
      const j = JSON.parse(readFileSync(tokensFile, 'utf8'));
      return j && typeof j === 'object' ? j : {};
    } catch {
      return {}; // 损坏按空表（不 brick）
    }
  }

  function saveTokens(map) {
    mkdirSync(shareDir, { recursive: true });
    const json = JSON.stringify(map);
    if (json.length > TOKENS_FILE_CAP) throw new Error('tokens 文件超护栏体积');
    const tmp = `${tokensFile}.tmp`;
    writeFileSync(tmp, json, 'utf8');
    renameSync(tmp, tokensFile); // 原子写
  }

  /** 读取 + 惰性清理：过期/畸形项即删，有清理则回写 */
  function loadAndSweep() {
    const map = loadTokens();
    const before = Object.keys(map).length;
    const now = Date.now();
    for (const [tok, e] of Object.entries(map)) {
      if (!e || typeof e !== 'object' || !TOKEN_RE.test(tok) || (e.expiresAt ?? 0) < now) delete map[tok];
    }
    if (Object.keys(map).length !== before) saveTokens(map);
    return map;
  }

  // ---------------- 会话快照（读 chat-store 持久化文件） ----------------

  function readChatRecord(sessionId) {
    if (!ID_RE.test(sessionId)) return null;
    const file = join(chatStoreDir, `${sessionId}.json`);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }

  /**
   * 分享标题自动推导：会话标题若还是默认「新会话」（chat-lite 只有手动重命名），
   * 从首条用户消息取前 40 字做标题——分享页/链接要有可辨识的名字。
   */
  function deriveTitle(session, messages) {
    const raw = typeof session.title === 'string' ? session.title.trim() : '';
    if (raw && raw !== '新会话') return raw;
    const firstUser = messages.find((m) => m?.role === 'user' && typeof m.content === 'string' && m.content.trim());
    if (firstUser) {
      const t = firstUser.content.replace(/\s+/g, ' ').trim().slice(0, 40);
      if (t) return t;
    }
    return raw || '未命名会话';
  }

  /** 工具卡 → 分享条目（白名单字段，遮蔽未预期字段） */
  function toolEntry(c) {
    const e = {
      callId: String(c.callId ?? ''),
      name: String(c.name ?? ''),
      status: String(c.status ?? ''),
      truncated: !!c.truncated,
    };
    if (c.command !== undefined) e.command = String(c.command);
    if (c.exitCode !== undefined) e.exitCode = Number(c.exitCode);
    if (c.durationMs !== undefined) e.durationMs = Number(c.durationMs);
    if (c.decision !== undefined) e.decision = String(c.decision);
    if (c.stdout !== undefined) e.stdout = String(c.stdout).slice(0, OUT_CAP);
    if (c.stderr !== undefined) e.stderr = String(c.stderr).slice(0, OUT_CAP);
    return e;
  }

  /** 会话 JSON → 结构化转录（服务端解释 blocks；分享面只读不回写） */
  function buildTranscript(record, { apiCalls = [], events = [], turns = [] } = {}) {
    const session = record?.session ?? {};
    const messages = Array.isArray(session.messages) ? session.messages : [];
    return {
      title: deriveTitle(session, messages),
      sessionId: String(session.id ?? ''),
      createdAt: Number(session.createdAt) || 0,
      lastActiveAt: Number(session.lastActiveAt) || Number(session.createdAt) || 0,
      version: Number(record?.version) || 0,
      capturedAt: Date.now(),
      apiCalls,
      /** 编排事件时间线（live-event 镜像捕获；delta/reasoning 噪声已在前端过滤） */
      events,
      /** 逐跳轮次（ai-events TurnRecord：steps/approvalWaitedMs/outcome） */
      turns,
      messages: messages.map((m, i) => {
        const role = String(m?.role ?? '');
        const item = {
          index: i,
          id: String(m?.id ?? ''),
          role,
          createdAt: Number(m?.createdAt) || 0,
          content: typeof m?.content === 'string' ? m.content : '',
        };
        if (Array.isArray(m?.blocks)) {
          item.blocks = m.blocks.map((b) => {
            if (b?.type === 'tool') return { type: 'tool', tool: toolEntry(b.card ?? {}) };
            if (b?.type === 'thinking') return { type: 'thinking', text: String(b.text ?? '') };
            if (b?.type === 'interactive') {
              const c = b.card ?? {};
              return {
                type: 'interactive',
                kind: String(c.kind ?? ''),
                title: String(c.title ?? ''),
                payload: c.payload ?? {},
                answer: c.answer !== undefined ? c.answer : undefined,
                status: String(c.status ?? ''),
              };
            }
            if (b?.type === 'artifact') {
              const c = b.card ?? {};
              return {
                type: 'artifact',
                rendererType: String(c.rendererType ?? ''),
                title: String(c.title ?? ''),
                status: String(c.status ?? ''),
                data: c.data ?? {},
              };
            }
            if (b?.type === 'notice' || b?.type === 'truncated') return { type: b.type, text: String(b.text ?? '') };
            return { type: 'text', text: String(b?.text ?? '') };
          });
        }
        if (role === 'tool' && m?.tool && typeof m.tool === 'object') {
          item.tool = toolEntry(m.tool);
        }
        return item;
      }),
    };
  }

  // ---------------- 中间件 ----------------

  return async function transcriptShareApi(req, res, next) {
    if (hardOff) return next?.();
    const [pathname] = (req.url ?? '').split('?');
    if (!pathname.startsWith('/api/share/') && !pathname.startsWith('/share/')) return next?.();

    const sendJson = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(obj));
    };
    const readBody = () => new Promise((r) => {
      let b = '';
      let torn = false;
      req.on('data', (c) => {
        if (torn) return;
        b += c;
        if (b.length > 32 * 1024) { torn = true; b = ''; }
      });
      req.on('end', () => r({ tooLarge: torn, body: b }));
    });
    const sendHtml = (code, html) => {
      res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
    };

    try {
      // ---- 管理面 /api/share/*（会话门禁） ----
      if (pathname.startsWith('/api/share/')) {
        const session = getSession?.(req);
        if (!session) return sendJson(401, { error: 'unauthorized', code: 'SESSION_REQUIRED' });

        // ---- API 调用轨迹批量上报（前端 traceTap；每会话 JSONL 追加） ----
        if (pathname === '/api/share/trace' && req.method === 'POST') {
          const { tooLarge, body: raw } = await readBody();
          if (tooLarge) return sendJson(413, { error: 'payload too large', code: 'PAYLOAD_TOO_LARGE' });
          let body;
          try { body = JSON.parse(raw || '{}'); } catch { return sendJson(400, { error: 'bad json', code: 'BAD_REQUEST' }); }
          const list = Array.isArray(body?.traces) ? body.traces : [];
          if (list.length === 0 || list.length > 64) {
            return sendJson(400, { error: 'traces must be 1~64 items', code: 'BAD_REQUEST' });
          }
          let stored = 0;
          for (const item of list) {
            if (!item || typeof item !== 'object') continue;
            const sid = String(item.sessionId ?? '');
            if (!sid) continue;
            // 白名单字段（遮蔽未预期字段；脱敏在出口统一做，这里保原便于出口裁剪）
            const rec = {
              id: String(item.id ?? '').slice(0, 64),
              sessionId: sid,
              at: Number(item.at) || Date.now(),
              durMs: Number(item.durMs) || 0,
              status: Number(item.status) || 0,
              ...(item.model !== undefined ? { model: String(item.model).slice(0, 128) } : {}),
              ...(item.providerId !== undefined ? { providerId: String(item.providerId).slice(0, 64) } : {}),
              ...(item.reqBody !== undefined && item.reqBody !== null ? { reqBody: String(item.reqBody).slice(0, 512 * 1024) } : {}),
              ...(item.reqTruncated ? { reqTruncated: true } : {}),
              ...(item.sse && typeof item.sse === 'object' ? {
                sse: {
                  frames: Number(item.sse.frames) || 0,
                  textLen: Number(item.sse.textLen) || 0,
                  ...(item.sse.finishReason !== undefined ? { finishReason: String(item.sse.finishReason).slice(0, 32) } : {}),
                  ...(item.sse.usage !== undefined ? { usage: item.sse.usage } : {}),
                  ...(item.sse.responseModel !== undefined ? { responseModel: String(item.sse.responseModel).slice(0, 128) } : {}),
                  ...(Array.isArray(item.sse.errors) ? { errors: item.sse.errors.slice(0, 4).map((s) => String(s).slice(0, 320)) } : {}),
                  ...(item.sse.estimated === true ? { estimated: true } : {}),
                  toolCalls: Array.isArray(item.sse.toolCalls)
                    ? item.sse.toolCalls.slice(0, 16).map((t) => ({ name: String(t?.name ?? '').slice(0, 128), args: String(t?.args ?? '').slice(0, 2000) }))
                    : [],
                  first: Array.isArray(item.sse.first) ? item.sse.first.slice(0, 6).map((s) => String(s).slice(0, 320)) : [],
                  last: Array.isArray(item.sse.last) ? item.sse.last.slice(0, 4).map((s) => String(s).slice(0, 320)) : [],
                },
              } : {}),
              ...(item.resHeaders && typeof item.resHeaders === 'object' ? {
                resHeaders: Object.fromEntries(Object.entries(item.resHeaders).slice(0, 16).map(([k, v]) => [String(k).slice(0, 64), String(v).slice(0, 256)])),
              } : {}),
              ...(item.resBody !== undefined && item.resBody !== null ? { resBody: String(item.resBody).slice(0, 48 * 1024) } : {}),
              ...(item.error !== undefined ? { error: String(item.error).slice(0, 500) } : {}),
            };
            if (traces.append(sid, rec)) stored += 1;
          }
          return sendJson(200, { ok: true, stored });
        }

        // ---- 编排事件时间线上报（traceTap 从 live-event 镜像捕获；delta 噪声前端已滤） ----
        if (pathname === '/api/share/events' && req.method === 'POST') {
          const { tooLarge, body: raw } = await readBody();
          if (tooLarge) return sendJson(413, { error: 'payload too large', code: 'PAYLOAD_TOO_LARGE' });
          let body;
          try { body = JSON.parse(raw || '{}'); } catch { return sendJson(400, { error: 'bad json', code: 'BAD_REQUEST' }); }
          const sessionId = String(body?.sessionId ?? '');
          const list = Array.isArray(body?.events) ? body.events : [];
          if (!sessionId) return sendJson(400, { error: 'sessionId required', code: 'BAD_REQUEST' });
          if (list.length === 0 || list.length > 256) {
            return sendJson(400, { error: 'events must be 1~256 items', code: 'BAD_REQUEST' });
          }
          let stored = 0;
          for (const e of list) {
            if (!e || typeof e.kind !== 'string') continue;
            const rec = {
              kind: e.kind.slice(0, 64),
              payload: e.payload ?? {},
              at: Number(e.at) || Date.now(),
            };
            if (events.append(sessionId, rec)) stored += 1;
          }
          return sendJson(200, { ok: true, stored });
        }

        // ---- 逐跳轮次上报（ai-events TurnRecord，浏览器 IndexedDB → 服务端） ----
        if (pathname === '/api/share/turns' && req.method === 'POST') {
          const { tooLarge, body: raw } = await readBody();
          if (tooLarge) return sendJson(413, { error: 'payload too large', code: 'PAYLOAD_TOO_LARGE' });
          let body;
          try { body = JSON.parse(raw || '{}'); } catch { return sendJson(400, { error: 'bad json', code: 'BAD_REQUEST' }); }
          const sessionId = String(body?.sessionId ?? '');
          const list = Array.isArray(body?.turns) ? body.turns : [];
          if (!sessionId) return sendJson(400, { error: 'sessionId required', code: 'BAD_REQUEST' });
          if (list.length === 0 || list.length > 64) {
            return sendJson(400, { error: 'turns must be 1~64 items', code: 'BAD_REQUEST' });
          }
          let stored = 0;
          for (const turn of list) {
            if (!turn || typeof turn !== 'object') continue;
            const rec = { kind: 'turn', turnId: String(turn.turnId ?? '').slice(0, 80), payload: turn, at: Number(turn.startedAt) || Date.now() };
            if (turns.append(sessionId, rec)) stored += 1;
          }
          return sendJson(200, { ok: true, stored });
        }

        // ---- 本地导出（不创建分享链接；会话门禁）----
        if (pathname === '/api/share/export' && req.method === 'GET') {
          const url = new URL(req.url, 'http://x');
          const sessionId = String(url.searchParams.get('sessionId') ?? '');
          const format = String(url.searchParams.get('format') ?? 'human');
          // 白名单校验：未知名一律 400，绝不静默回落——否则"新格式在生产旧进程上
          // 验证返回 200"是假阳性（旧进程回落 human md 也 200），验证失去意义
          if (!['human', 'ai', 'human-html', 'html'].includes(format)) {
            return sendJson(400, { error: `unknown format: ${format.slice(0, 32)}`, code: 'BAD_REQUEST' });
          }
          if (!ID_RE.test(sessionId)) return sendJson(400, { error: 'invalid sessionId', code: 'BAD_REQUEST' });
          const rec = readChatRecord(sessionId);
          if (!rec || rec.deletedAt) return sendJson(404, { error: 'session not found', code: 'SESSION_NOT_FOUND' });
          const transcript = redactJson(buildTranscript(rec, {
            apiCalls: traces.readAll(sessionId),
            events: events.readAll(sessionId),
            turns: turns.readAll(sessionId).map((t) => t.payload ?? t),
          }));
          if (format === 'ai') {
            return sendJson(200, buildAiAnalysis(transcript));
          }
          // human-html = 个人版渲染预览：点开即见排版效果（.md 原文对人不友好），
          // 工具栏内含「下载 .md / AI 分析版」——下载意图与预览意图分离
          if (format === 'human-html') {
            return sendHtml(200, renderHumanHtml(transcript));
          }
          // html = 分享前预览：与正式分享页同一渲染器（静态快照，无 live 轮询），
          // 会话门禁、不创建 token、不落任何状态——看到什么分享出去就是什么
          if (format === 'html') {
            return sendHtml(200, renderShareHtml(transcript, { live: false }));
          }
          res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
          return res.end(renderHumanMarkdown(transcript));
        }

        if (pathname === '/api/share/create' && req.method === 'POST') {
          const { tooLarge, body: raw } = await readBody();
          if (tooLarge) return sendJson(413, { error: 'payload too large', code: 'PAYLOAD_TOO_LARGE' });
          let body;
          try { body = JSON.parse(raw || '{}'); } catch { return sendJson(400, { error: 'bad json', code: 'BAD_REQUEST' }); }
          const sessionId = String(body.sessionId ?? '').trim();
          if (!ID_RE.test(sessionId)) return sendJson(400, { error: 'invalid sessionId', code: 'BAD_REQUEST' });
          const rec = readChatRecord(sessionId);
          if (!rec || rec.deletedAt) return sendJson(404, { error: 'session not found', code: 'SESSION_NOT_FOUND' });
          const ttlMs = body.ttlMs === undefined ? TTL_DEFAULT_MS : Number(body.ttlMs);
          if (!Number.isFinite(ttlMs) || ttlMs < TTL_MIN_MS || ttlMs > TTL_MAX_MS) {
            return sendJson(400, { error: 'ttlMs out of range (1h ~ 30d)', code: 'BAD_REQUEST' });
          }
          const live = body.live !== false;
          const token = randomBytes(48).toString('hex');
          const now = Date.now();
          const map = loadAndSweep();
          map[token] = { sessionId, expiresAt: now + ttlMs, createdAt: now, live };
          saveTokens(map);
          return sendJson(200, { ok: true, token, sessionId, url: `/share/${token}`, expiresAt: now + ttlMs, live });
        }

        if (pathname === '/api/share/list' && req.method === 'GET') {
          const map = loadAndSweep();
          const now = Date.now();
          const items = Object.entries(map)
            .map(([tok, e]) => ({
              token: tok,
              tokenDigest: `${tok.slice(0, 4)}…${tok.slice(-4)}`,
              sessionId: e.sessionId,
              createdAt: e.createdAt,
              expiresAt: e.expiresAt,
              remainMs: e.expiresAt - now,
              live: !!e.live,
            }))
            .sort((a, b) => b.createdAt - a.createdAt);
          return sendJson(200, { ok: true, items });
        }

        if (pathname === '/api/share/revoke' && req.method === 'POST') {
          const { tooLarge, body: raw } = await readBody();
          if (tooLarge) return sendJson(413, { error: 'payload too large', code: 'PAYLOAD_TOO_LARGE' });
          let body;
          try { body = JSON.parse(raw || '{}'); } catch { return sendJson(400, { error: 'bad json', code: 'BAD_REQUEST' }); }
          const token = String(body.token ?? '').trim();
          if (!token) return sendJson(400, { error: 'token required', code: 'BAD_REQUEST' });
          const map = loadAndSweep();
          const existed = token in map;
          if (existed) { delete map[token]; saveTokens(map); }
          return sendJson(200, { ok: true, revoked: existed });
        }

        if (pathname === '/api/share/refresh' && req.method === 'POST') {
          const { tooLarge, body: raw } = await readBody();
          if (tooLarge) return sendJson(413, { error: 'payload too large', code: 'PAYLOAD_TOO_LARGE' });
          let body;
          try { body = JSON.parse(raw || '{}'); } catch { return sendJson(400, { error: 'bad json', code: 'BAD_REQUEST' }); }
          const token = String(body.token ?? '').trim();
          if (!token) return sendJson(400, { error: 'token required', code: 'BAD_REQUEST' });
          const ttlMs = body.ttlMs === undefined ? TTL_DEFAULT_MS : Number(body.ttlMs);
          if (!Number.isFinite(ttlMs) || ttlMs < TTL_MIN_MS || ttlMs > TTL_MAX_MS) {
            return sendJson(400, { error: 'ttlMs out of range (1h ~ 30d)', code: 'BAD_REQUEST' });
          }
          const map = loadAndSweep();
          const e = map[token];
          if (!e) return sendJson(404, { error: 'token not found or expired', code: 'SHARE_NOT_FOUND' });
          e.expiresAt = Date.now() + ttlMs;
          saveTokens(map);
          return sendJson(200, { ok: true, token, expiresAt: e.expiresAt });
        }

        return sendJson(404, { error: 'not found' });
      }

      // ---- 只读面 /share/:token …（免登录，token 即门禁） ----
      const mHtml = pathname.match(/^\/share\/([A-Za-z0-9_-]{16,192})$/);
      const mJson = pathname.match(/^\/share\/([A-Za-z0-9_-]{16,192})\/json$/);
      const mMd = pathname.match(/^\/share\/([A-Za-z0-9_-]{16,192})\/markdown$/);
      const mAi = pathname.match(/^\/share\/([A-Za-z0-9_-]{16,192})\/ai$/);
      const token = mHtml?.[1] ?? mJson?.[1] ?? mMd?.[1] ?? mAi?.[1];
      if (!token) return sendJson(404, { error: 'not found' });

      // 只读面不过 sweep：过期判定要先行（410），删留在判定之后
      const map = loadTokens();
      const entry = map[token];
      if (!entry) return sendHtml(404, errorPage('链接无效或已过期'));
      if (entry.expiresAt < Date.now()) {
        delete map[token];
        saveTokens(map);
        return sendHtml(410, errorPage('链接已过期'));
      }
      const rec = readChatRecord(entry.sessionId);
      if (!rec || rec.deletedAt) return sendHtml(404, errorPage('会话已删除或不可读'));

      // 三个采集面并入转录（脱敏在 redactJson 统一执行；reqBody 里可能有密钥形态文本）
      const sid = entry.sessionId;
      const transcript = redactJson(buildTranscript(rec, {
        apiCalls: traces.readAll(sid),
        events: events.readAll(sid),
        turns: turns.readAll(sid).map((t) => t.payload ?? t),
      }));

      if (mHtml) return sendHtml(200, renderShareHtml(transcript, { live: !!entry.live }));
      if (mJson) return sendJson(200, transcript);
      if (mMd) {
        // 个人阅读版（做减法：叙事流 + 一行式工具 + API 一览表）
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(renderHumanMarkdown(transcript));
      }
      if (mAi) {
        // AI 分析版（结构化 + 分析任务书 + 派生指标）
        return sendJson(200, buildAiAnalysis(transcript));
      }
      return sendJson(404, { error: 'not found' });
    } catch (e) {
      return sendJson(500, { error: String(e?.message ?? e), code: 'SHARE_ERROR' });
    }
  };
}
