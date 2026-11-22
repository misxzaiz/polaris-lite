/**
 * chat-store 插件的服务端半边（/api/chat/sessions*）：AI 对话会话的**服务端权威存储**。
 *
 * 这是「对话多设备共享」的服务端那一半（spec：docs/chat-multi-device-sync-plan.md）：
 * 会话从浏览器 localStorage 上移为服务端文件（<dataDir>/chat-store/<id>.json），
 * 同一账号的多个设备（多个 cookie 会话）读写同一份数据。
 *
 * 与 kv-store 的区别：kv-store 是通用 KV（1MB/键）；本插件面向「会话」这一领域形状——
 * 整会话读写、版本号乐观并发控制（409）、软删除墓碑、索引增量查询。服务端不理解
 * 消息内部语义（blocks/tool 卡等），只做外壳校验与存取——前端 chat-lite 是唯一解释者。
 *
 * 安全模型（对齐 kv-store/html-preview server 半边）：
 * - 会话 cookie 硬门禁（未登录 401）；PLITE_CHAT_STORE=0 一键禁用；
 * - sessionId 必须匹配 ^[A-Za-z0-9_-]{1,64}$（防路径穿越；前端 id 形如 s-<b36>-<b36>）；
 * - 单会话 JSON ≤ 4MB；写入原子（tmp + rename）；每会话一把互斥锁串行化读改写；
 * - 写操作落审计（JSON Lines），读不打点（轮询高频）。
 *
 * 端点：
 *   GET    /api/chat/sessions        → { sessions: [{id,title,createdAt,updatedAt,msgCount,lastMsgPreview,version,deletedAt?}], running: {<id>:{startedAt,device,phase,lastBeat}} }
 *                                       ?since=<ts> 增量：只回 updatedAt>since 的条目；tombstones 恒回全量
 *   GET    /api/chat/sessions/:id    → { session, version, updatedAt }
 *   PUT    /api/chat/sessions/:id    → body { session, baseVersion, force? }；版本不符 409
 *   DELETE /api/chat/sessions/:id    → 软删除（墓碑），物理文件保留待清理
 *
 * loop 运行态与实时推流（多设备「执行中」可见 + 跨设备实时查看）：
 *   POST /api/chat/sessions/:id/loop-state → body { event:'start'|'heartbeat'|'done', device?, phase? }
 *                                            agent-loop 上报生命周期；内存态不落盘
 *                                            （宿主重启=所有 loop 已死，是合理语义）；
 *                                            20s 无心跳由 GC 回收（发起端暴毙兜底）
 *   POST /api/chat/sessions/:id/live-event → body { events:[{kind,payload}] }
 *                                            发起端批量镜像编排事件（delta/工具卡/done…）
 *   GET  /api/chat/sessions/:id/events     → SSE 订阅该会话的 live 事件流（15s ping 保活）
 *
 * 索引变更广播（spec v0.2，2026-11-22：30s 轮询升级为「推送即时对账 + 轮询兜底」）：
 *   GET  /api/chat/sessions/index-events   → SSE 订阅全局索引变更；
 *                                            PUT/DELETE/loop-state/GC 回收都会扇出
 *                                            event:index-changed（payload 只带变更 ids，
 *                                            客户端据此 pull 对账——版本比对幂等，乱序无害）；
 *                                            轮询兜底保留（SSE 断开/未送达时 30s 内收敛）
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_SESSION_BYTES = 4 * 1024 * 1024; // 单会话 4MB（附件 base64 大图可能到 MB 级）
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PREVIEW_LEN = 60;
/** 墓碑保留期：到期物理清理（进程内懒清理，命中即扫） */
const TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** loop 心跳超时：超此未续期视为发起端已死，从运行表回收 */
const LOOP_BEAT_TIMEOUT_MS = 20_000;
/** SSE 保活 ping 间隔 */
const SSE_PING_MS = 15_000;
/** 单次 live-event 批量上报的事件数上限（防打爆；超出丢弃并计数） */
const LIVE_EVENT_BATCH_MAX = 64;
/** 单会话 live 事件订阅者上限（防同一会话被无限订阅） */
const LIVE_SUBS_PER_SESSION_MAX = 32;
/** 索引变更 SSE 订阅者上限 */
const INDEX_SUBS_MAX = 64;
/** 索引变更合批窗口（ms）：同窗口内多次写合并为一条事件（流式 settle + 队列派发可能连续写多个会话） */
const INDEX_NOTIFY_BATCH_MS = 120;

/** 提取会话的展示字段（服务端不理解消息语义，只数条数与取首条 content 做预览） */
function summarize(session) {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  const firstUser = messages.find((m) => m && m.role === 'user' && typeof m.content === 'string');
  const preview = (firstUser?.content ?? '').replace(/\s+/g, ' ').slice(0, PREVIEW_LEN);
  return {
    id: String(session.id),
    title: typeof session.title === 'string' ? session.title : '新会话',
    createdAt: Number(session.createdAt) || 0,
    msgCount: messages.length,
    lastMsgPreview: preview,
  };
}

export function createServerPart(options = {}) {
  const getSession = options.getSession;
  const dataDir = resolve(options.dataDir ?? '.polaris-lite');
  const storeDir = resolve(dataDir, 'chat-store');
  const auditFile = resolve(dataDir, 'chat-store-audit.log');
  const hardOff = process.env.PLITE_CHAT_STORE === '0';

  /** 每会话互斥锁：sessionId → Promise 链尾（同会话读改写串行化） */
  const locks = new Map();

  function lock(key, fn) {
    const prev = locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    // 防止未处理 rejection 累积；错误由调用方在 fn 内自行捕获
    locks.set(key, next.catch(() => undefined));
    return next;
  }

  function audit(entry) {
    try {
      mkdirSync(dataDir, { recursive: true });
      appendFileSync(auditFile, `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
    } catch { /* 审计失败不阻断业务 */ }
  }

  const sessionFile = (id) => join(storeDir, `${id}.json`);

  function readRecord(id) {
    const file = sessionFile(id);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return null; // 损坏按不存在处理（不 brick 索引）
    }
  }

  function writeRecord(id, record) {
    mkdirSync(storeDir, { recursive: true });
    const file = sessionFile(id);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(record), 'utf8');
    renameSync(tmp, file);
  }

  /** 目录级索引（会话量级 ≤ 数百，每次全扫可忽略；读损坏文件跳过） */
  function listRecords() {
    if (!existsSync(storeDir)) return [];
    const out = [];
    for (const name of readdirSync(storeDir)) {
      if (!name.endsWith('.json') || name.endsWith('.tmp')) continue;
      const id = name.slice(0, -5);
      if (!ID_RE.test(id)) continue;
      const rec = readRecord(id);
      if (rec) out.push(rec);
    }
    return out;
  }

  /** 墓碑到期物理清理（写路径懒触发，不设定时器） */
  function sweepTombstones() {
    const now = Date.now();
    for (const rec of listRecords()) {
      if (rec.deletedAt && now - rec.deletedAt > TOMBSTONE_TTL_MS) {
        try { rmSync(sessionFile(rec.id)); } catch { /* 忽略 */ }
      }
    }
  }

  // ---- loop 运行态（内存表；见文件头「loop 运行态与实时推流」注释） ----
  /** sessionId → { startedAt, device, phase, lastBeat }；done/超时即回收 */
  const runningLoops = new Map();
  /** sessionId → Set<res(SSE)>；live 事件订阅者 */
  const liveSubs = new Map();
  // ---- 索引变更广播（见文件头「索引变更广播」注释） ----
  /** Set<res(SSE)>；全局索引变更订阅者 */
  const indexSubs = new Set();
  /** 合批窗口内的待通知变更 ids */
  const indexPendingIds = new Set();
  let indexNotifyTimer = null;

  /** 扇出索引变更事件给所有订阅者（断开连接由 close 自清理） */
  function fanoutIndexChanged(ids) {
    if (indexSubs.size === 0 || ids.length === 0) return;
    const frame = `event: index-changed\ndata: ${JSON.stringify({ ids, at: Date.now() })}\n\n`;
    for (const res of [...indexSubs]) {
      try { res.write(frame); } catch { indexSubs.delete(res); }
    }
    if (indexSubs.size === 0) indexSubs.clear();
  }

  /** 记录一次索引变更（合批后扇出；幂等——同一会话窗口内只出现一次） */
  function notifyIndex(...ids) {
    for (const id of ids) {
      if (id && typeof id === 'string') indexPendingIds.add(id);
    }
    if (indexPendingIds.size === 0) return;
    if (indexNotifyTimer) return; // 窗口已排程
    indexNotifyTimer = setTimeout(() => {
      indexNotifyTimer = null;
      const batch = [...indexPendingIds];
      indexPendingIds.clear();
      fanoutIndexChanged(batch);
    }, INDEX_NOTIFY_BATCH_MS);
  }

  function gcLoops() {
    const now = Date.now();
    for (const [id, st] of runningLoops) {
      if (now - st.lastBeat > LOOP_BEAT_TIMEOUT_MS) {
        runningLoops.delete(id);
        notifyIndex(id); // GC 回收也是「执行中」徽标的可见性变更（其他设备即时摘牌）
      }
    }
  }

  function runningSnapshot() {
    gcLoops();
    const out = {};
    for (const [id, st] of runningLoops) {
      out[id] = { startedAt: st.startedAt, device: st.device, phase: st.phase, lastBeat: st.lastBeat };
    }
    return out;
  }

  /** live 事件扇出给该会话的所有 SSE 订阅者（连接断开即自清理） */
  function fanoutLive(sessionId, events) {
    const subs = liveSubs.get(sessionId);
    if (!subs || subs.size === 0) return;
    const frame = `event: live\ndata: ${JSON.stringify({ events })}\n\n`;
    for (const res of [...subs]) {
      try { res.write(frame); } catch { subs.delete(res); }
    }
    if (subs.size === 0) liveSubs.delete(sessionId);
  }

  return async function chatStoreApi(req, res, next) {
    if (hardOff) return next?.();
    const [pathname] = (req.url ?? '').split('?');
    if (!pathname.startsWith('/api/chat/sessions')) return next?.();

    // 会话 cookie 硬门禁
    const session = getSession?.(req);
    if (!session) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'unauthorized', code: 'SESSION_REQUIRED' }));
    }

    const sendJson = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(obj));
    };
    const readBody = () => new Promise((r) => {
      let b = '';
      let torn = false;
      req.on('data', (c) => {
        if (torn) return;
        b += c;
        if (b.length > MAX_SESSION_BYTES + 4096) {
          // 超限：不能直接 destroy（客户端只看到 ECONNRESET）——
          // 标记后继续排空，请求结束时统一回 413
          torn = true;
          b = '';
        }
      });
      req.on('end', () => r({ body: b, tooLarge: torn }));
    });

    try {
      const url = new URL(req.url, 'http://x');

      // ---- 索引 ----
      if (pathname === '/api/chat/sessions' && req.method === 'GET') {
        const since = Number(url.searchParams.get('since') ?? 0) || 0;
        const recs = listRecords();
        const sessions = recs
          .filter((r) => !r.deletedAt) // 墓碑不进常规索引（删除即从列表消失）
          .filter((r) => !since || r.updatedAt > since)
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map((r) => ({
            ...summarize(r.session),
            updatedAt: r.updatedAt,
            version: r.version,
            ...(r.deletedAt ? { deletedAt: r.deletedAt } : {}),
          }));
        // 墓碑恒回全量（删除事件不能因 since 截断而漏）；记录顶层无 id，id 在 session.id
        const tombstones = recs
          .filter((r) => r.deletedAt)
          .map((r) => ({ id: String(r.session?.id ?? ''), deletedAt: r.deletedAt, version: r.version }))
          .filter((tb) => tb.id);
        // loop 运行态随索引下发（侧栏「执行中」徽标的数据源；全设备可见）
        return sendJson(200, { sessions, tombstones, running: runningSnapshot() });
      }

      // ---- 索引变更 SSE 订阅（全局；15s ping 保活，断开自清理；见文件头「索引变更广播」） ----
      // 注意：必须先于 :id 匹配——id 白名单含连字符，index-events 会被误认成会话 id
      if (pathname === '/api/chat/sessions/index-events' && req.method === 'GET') {
        if (indexSubs.size >= INDEX_SUBS_MAX) {
          return sendJson(429, { error: 'too many subscribers', code: 'TOO_MANY_SUBSCRIBERS' });
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.flushHeaders(); // writeHead 不主动上线，客户端 fetch/EventSource 会挂到首个 ping（15s）才 open
        indexSubs.add(res);
        const ping = setInterval(() => {
          try { res.write(`event: ping\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`); } catch { /* 断开由 close 回收 */ }
        }, SSE_PING_MS);
        req.on('close', () => {
          clearInterval(ping);
          indexSubs.delete(res);
        });
        return; // SSE 长连接由 res 持有
      }

      // ---- 单会话（:id）----
      const m = pathname.match(/^\/api\/chat\/sessions\/([A-Za-z0-9_-]{1,64})$/);
      if (m) {
        const id = m[1];

        if (req.method === 'GET') {
          const rec = readRecord(id);
          if (!rec || rec.deletedAt) return sendJson(404, { error: 'session not found', code: 'SESSION_NOT_FOUND' });
          return sendJson(200, { session: rec.session, version: rec.version, updatedAt: rec.updatedAt });
        }

        if (req.method === 'PUT') {
          const { body: raw, tooLarge } = await readBody();
          if (tooLarge) {
            return sendJson(413, { error: `session too large (> ${MAX_SESSION_BYTES} bytes)`, code: 'SESSION_TOO_LARGE' });
          }
          let body;
          try {
            body = JSON.parse(raw || '{}');
          } catch {
            return sendJson(400, { error: 'bad json', code: 'BAD_REQUEST' });
          }
          const incoming = body?.session;
          if (!incoming || typeof incoming !== 'object') {
            return sendJson(400, { error: 'session required', code: 'BAD_REQUEST' });
          }
          if (String(incoming.id ?? '') !== id) {
            return sendJson(400, { error: 'session.id must match url id', code: 'BAD_REQUEST' });
          }
          if (!Array.isArray(incoming.messages)) {
            return sendJson(400, { error: 'session.messages must be an array', code: 'BAD_REQUEST' });
          }
          const baseVersion = Number(body.baseVersion ?? 0);
          if (!Number.isInteger(baseVersion) || baseVersion < 0) {
            return sendJson(400, { error: 'baseVersion must be a non-negative integer', code: 'BAD_REQUEST' });
          }
          const force = body.force === true;

          const result = await lock(id, () => {
            const cur = readRecord(id);
            if (cur?.deletedAt) {
              return { status: 404, body: { error: 'session deleted', code: 'SESSION_NOT_FOUND' } };
            }
            if (cur && !force && cur.version !== baseVersion) {
              return { status: 409, body: { error: 'version conflict', code: 'VERSION_CONFLICT', currentVersion: cur.version, updatedAt: cur.updatedAt } };
            }
            const version = (cur?.version ?? 0) + 1;
            const updatedAt = Date.now();
            writeRecord(id, { version, updatedAt, session: incoming });
            audit({ op: 'put', sessionId: id, version, ok: true, force });
            notifyIndex(id); // 索引变更广播（v0.2）：其他设备即时对账
            return { status: 200, body: { ok: true, version, updatedAt } };
          });
          if (result.status !== 200) audit({ op: 'put', sessionId: id, ok: false, code: result.body.code });
          return sendJson(result.status, result.body);
        }

        if (req.method === 'DELETE') {
          const result = await lock(id, () => {
            const cur = readRecord(id);
            if (!cur) return { status: 404, body: { error: 'session not found', code: 'SESSION_NOT_FOUND' } };
            if (cur.deletedAt) return { status: 200, body: { ok: true, version: cur.version } };
            const version = cur.version + 1;
            const now = Date.now();
            writeRecord(id, { ...cur, version, updatedAt: now, deletedAt: now });
            audit({ op: 'delete', sessionId: id, version, ok: true });
            sweepTombstones();
            notifyIndex(id); // 墓碑广播：其他设备即时移除该条目
            return { status: 200, body: { ok: true, version } };
          });
          return sendJson(result.status, result.body);
        }

        return sendJson(405, { error: 'method not allowed' });
      }

      // ---- loop 运行态上报（agent-loop 发起端；内存态，见文件头） ----
      const mState = pathname.match(/^\/api\/chat\/sessions\/([A-Za-z0-9_-]{1,64})\/loop-state$/);
      if (mState && req.method === 'POST') {
        const id = mState[1];
        const { body: raw, tooLarge } = await readBody();
        if (tooLarge) return sendJson(413, { error: 'payload too large', code: 'PAYLOAD_TOO_LARGE' });
        let body;
        try { body = JSON.parse(raw || '{}'); } catch { return sendJson(400, { error: 'bad json', code: 'BAD_REQUEST' }); }
        const event = String(body.event ?? '');
        if (event !== 'start' && event !== 'heartbeat' && event !== 'done') {
          return sendJson(400, { error: 'event must be start|heartbeat|done', code: 'BAD_REQUEST' });
        }
        if (event === 'start') {
          runningLoops.set(id, {
            startedAt: Date.now(),
            device: String(body.device ?? '未知设备').slice(0, 40),
            phase: String(body.phase ?? 'running').slice(0, 24),
            lastBeat: Date.now(),
          });
          audit({ op: 'loop-start', sessionId: id });
          notifyIndex(id); // 「执行中」徽标全设备即时亮起
        } else if (event === 'heartbeat') {
          const st = runningLoops.get(id);
          if (st) { st.lastBeat = Date.now(); st.phase = String(body.phase ?? st.phase).slice(0, 24); }
          // 未知 id 的心跳静默忽略（GC 已回收的不再复活，避免暴毙端复活假象）
        } else {
          runningLoops.delete(id);
          audit({ op: 'loop-done', sessionId: id });
          notifyIndex(id); // 「执行中」徽标全设备即时摘除
        }
        return sendJson(200, { ok: true });
      }

      // ---- live 事件批量镜像（发起端 → 服务端扇出；只透传不落盘不解释） ----
      const mLive = pathname.match(/^\/api\/chat\/sessions\/([A-Za-z0-9_-]{1,64})\/live-event$/);
      if (mLive && req.method === 'POST') {
        const id = mLive[1];
        const { body: raw, tooLarge } = await readBody();
        if (tooLarge) return sendJson(413, { error: 'payload too large', code: 'PAYLOAD_TOO_LARGE' });
        let body;
        try { body = JSON.parse(raw || '{}'); } catch { return sendJson(400, { error: 'bad json', code: 'BAD_REQUEST' }); }
        const events = Array.isArray(body.events) ? body.events : [];
        if (events.length === 0) return sendJson(200, { ok: true, delivered: 0 });
        if (events.length > LIVE_EVENT_BATCH_MAX) {
          return sendJson(413, { error: `too many events (max ${LIVE_EVENT_BATCH_MAX})`, code: 'TOO_MANY_EVENTS' });
        }
        // 事件透传给订阅端；只做形状钳制（kind 必须是字符串，payload 原样）
        const clean = events
          .filter((e) => e && typeof e.kind === 'string' && e.kind.length <= 64)
          .slice(0, LIVE_EVENT_BATCH_MAX)
          .map((e) => ({ kind: e.kind, payload: e.payload ?? {}, at: Date.now() }));
        fanoutLive(id, clean);
        return sendJson(200, { ok: true, delivered: clean.length });
      }

      // ---- live 事件 SSE 订阅（查看端；15s ping 保活，断开自清理） ----
      const mEvents = pathname.match(/^\/api\/chat\/sessions\/([A-Za-z0-9_-]{1,64})\/events$/);
      if (mEvents && req.method === 'GET') {
        const id = mEvents[1];
        let subs = liveSubs.get(id);
        if (!subs) { subs = new Set(); liveSubs.set(id, subs); }
        if (subs.size >= LIVE_SUBS_PER_SESSION_MAX) {
          return sendJson(429, { error: 'too many subscribers', code: 'TOO_MANY_SUBSCRIBERS' });
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.flushHeaders(); // 同上：不冲刷则 live overlay 订阅要等 15s ping 才建立
        subs.add(res);
        const ping = setInterval(() => {
          try { res.write(`event: ping\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`); } catch { /* 断开由 close 回收 */ }
        }, SSE_PING_MS);
        req.on('close', () => {
          clearInterval(ping);
          subs.delete(res);
          if (subs.size === 0) liveSubs.delete(id);
        });
        return; // SSE 长连接由 res 持有
      }

      return sendJson(404, { error: 'not found' });
    } catch (e) {
      return sendJson(500, { error: String(e?.message ?? e), code: 'CHAT_STORE_ERROR' });
    }
  };
}
