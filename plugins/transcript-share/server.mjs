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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { redactJson } from './redact.mjs';
import { renderShareHtml, renderMarkdown, errorPage } from './render.mjs';

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
  function buildTranscript(record) {
    const session = record?.session ?? {};
    const messages = Array.isArray(session.messages) ? session.messages : [];
    return {
      title: typeof session.title === 'string' ? session.title : '未命名会话',
      sessionId: String(session.id ?? ''),
      createdAt: Number(session.createdAt) || 0,
      lastActiveAt: Number(session.lastActiveAt) || Number(session.createdAt) || 0,
      version: Number(record?.version) || 0,
      capturedAt: Date.now(),
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
      const token = mHtml?.[1] ?? mJson?.[1] ?? mMd?.[1];
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

      const transcript = redactJson(buildTranscript(rec));

      if (mHtml) return sendHtml(200, renderShareHtml(transcript, { live: !!entry.live }));
      if (mJson) return sendJson(200, transcript);
      if (mMd) {
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(renderMarkdown(transcript));
      }
      return sendJson(404, { error: 'not found' });
    } catch (e) {
      return sendJson(500, { error: String(e?.message ?? e), code: 'SHARE_ERROR' });
    }
  };
}
