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

/**
 * 会话存储访问器：本插件 HTTP 半边与**其它插件 server 半边**共用的领域接口。
 *
 * 为什么单独导出：agent-runner 需要在服务端把本轮消息合并进会话档（断联续跑），
 * 但文件版式、版本语义、索引广播都是 chat-store 的私有实现。消费方只经
 * `mergeMessages / readRecord` 这类**领域操作**使用，不认识存储布局——
 * 换实现（文件 → sqlite / 远端）时消费方零改动。
 */
export function createChatStoreAccess({ dataDir, onAudit = () => {}, onIndexChange = () => {} }) {
  const storeDir = resolve(dataDir, 'chat-store');
  /** 每会话互斥锁：sessionId → Promise 链尾（同会话读改写串行化） */
  const locks = new Map();

  function lock(key, fn) {
    const prev = locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    // 防止未处理 rejection 累积；错误由调用方在 fn 内自行捕获
    locks.set(key, next.catch(() => undefined));
    return next;
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

  /**
   * 幂等合并消息（键 = 消息 id）：缺会话则建壳，版本递增、索引广播。
   * mergeBlocks=true 时对已存在的 assistant 消息做块级合并（同一 assistantId
   * 跨多轮增量落档）。返回是否实际写入（无可新增内容时 false，不空转版本号）。
   *
   * - mergeBlocks=false（默认）：只补缺失消息，已存在的不动。
   * - mergeMode='append'（agent-runner 用，需 mergeBlocks=true）：块追加、
   *   content 取最长——服务端 runner 每轮增量落块的语义。
   * - mergeMode='replace'（前端直连通道 settle 用，**不要求 mergeBlocks**）：
   *   整条消息按 id 替换（blocks/content/endedAt 全量覆盖）——幂等重推
   *   同一条消息不会叠加重复块。
   *
   * 读改写全程同步（Node 单线程内无交错），与 HTTP PUT 的 lock 语义等价。
   */
  function mergeMessages(sessionId, title, messages, { createdAt, mergeBlocks = false, mergeMode = 'append' } = {}) {
    if (!sessionId || !ID_RE.test(sessionId) || !messages?.length) return false;
    try {
      const rec = readRecord(sessionId);
      const session = rec?.session ?? {
        id: sessionId,
        title: typeof title === 'string' && title ? title : '新会话',
        messages: [],
        createdAt: Number(createdAt) || Date.now(),
      };
      if (!Array.isArray(session.messages)) session.messages = [];
      const known = new Map(session.messages.map((m) => [m?.id, m]).filter(([id]) => !!id));
      const fresh = [];
      let changed = false;
      for (const m of messages) {
        if (!m?.id) continue;
        const exist = known.get(m.id);
        if (!exist) { fresh.push(m); known.set(m.id, m); continue; }
        // replace 与 mergeBlocks 无关（HTTP /messages 的 replace 模式传的是
        // mergeBlocks=false）：必须先于「只补缺失」的短路判断，否则替换分支永不执行
        // ——2026-11-26 实证：内容变更被误判成 noChange，会话档停在旧值。
        if (mergeMode === 'replace') {
          // 整条替换：内容不同才算变更（幂等重推不空转版本号）
          if (JSON.stringify(exist) !== JSON.stringify(m)) {
            session.messages[session.messages.indexOf(exist)] = m;
            changed = true;
          }
          continue;
        }
        if (!mergeBlocks) continue;
        // append：块级合并——同一 assistant 消息的后续轮次产出追加（工具卡/正文/思考保序），
        // content 镜像取累计最长文本；endedAt 以最后一次为准。
        const before = JSON.stringify(exist.blocks ?? []).length + (exist.content ?? '').length;
        exist.blocks = [...(exist.blocks ?? []), ...(m.blocks ?? [])];
        if ((m.content ?? '').length > (exist.content ?? '').length) exist.content = m.content;
        if (m.endedAt) exist.endedAt = m.endedAt;
        const after = JSON.stringify(exist.blocks ?? []).length + (exist.content ?? '').length;
        if (after > before) changed = true;
      }
      if (fresh.length === 0 && !changed) return false;
      session.messages.push(...fresh);
      // 自动命名（对齐前端 ensureAutoTitle 口径）：仍是「新会话」才用首条用户消息前 40 字
      if (session.title === '新会话') {
        const firstUser = [...messages].reverse().find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.trim());
        const t = firstUser ? firstUser.content.replace(/\s+/g, ' ').trim().slice(0, 40) : '';
        if (t) session.title = t;
      }
      const version = (Number(rec?.version) || 0) + 1;
      writeRecord(sessionId, { version, updatedAt: Date.now(), session });
      onIndexChange(sessionId);
      onAudit({ op: 'merge', sessionId, version, added: fresh.length, merged: changed ? 1 : 0 });
      return true;
    } catch (e) {
      onAudit({ op: 'merge-fail', sessionId, error: String(e?.message ?? e).slice(0, 120) });
      return false;
    }
  }

  return { storeDir, readRecord, writeRecord, listRecords, sweepTombstones, mergeMessages, lock };
}

export function createServerPart(options = {}) {
  const getSession = options.getSession;
  const dataDir = resolve(options.dataDir ?? '.polaris-lite');
  const auditFile = resolve(dataDir, 'chat-store-audit.log');
  const hardOff = process.env.PLITE_CHAT_STORE === '0';

  function audit(entry) {
    try {
      mkdirSync(dataDir, { recursive: true });
      appendFileSync(auditFile, `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
    } catch { /* 审计失败不阻断业务 */ }
  }

  // 存储访问器：本插件 HTTP 半边与其它插件（agent-runner/transcript-share）共用同一实现。
  // 消费方经 server/adapter-registry 的 service 注册表取用，不认识 <dataDir>/chat-store 布局。
  const access = createChatStoreAccess({ dataDir, onAudit: audit, onIndexChange: (id) => notifyIndex(id) });
  const { readRecord, writeRecord, listRecords, sweepTombstones, mergeMessages, lock } = access;
  options.registry?.registerService?.('chat-store', access);
  // loop-state 内部上报接口（agent-runner 编排 run 的「执行中」徽标；同进程直调）
  options.registry?.registerService?.('chat-loop-state', {
    /** run start/heartbeat/done（与 HTTP loop-state 端点同语义） */
    report: applyLoopState,
  });

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

  /** loop 运行态落地（start/heartbeat/done 三态语义；HTTP 端点与 agent-runner service 共用）。
   *  2026-11-27：agent-runner 编排的 run 也经此上报——服务端编排后「执行中」徽标链路
   *  断了半年（loop-state 只剩旧前端 agent-loop 在调，那个通道已被删除），侧栏从此
   *  看不出哪个会话在跑。runner 直调本函数（service 接口），不绕 HTTP 自调。 */
  function applyLoopState(id, event, info = {}) {
    if (typeof id !== 'string' || !ID_RE.test(id)) return false;
    if (event === 'start') {
      runningLoops.set(id, {
        startedAt: Date.now(),
        device: String(info.device ?? '未知设备').slice(0, 40),
        phase: String(info.phase ?? 'running').slice(0, 24),
        lastBeat: Date.now(),
      });
      audit({ op: 'loop-start', sessionId: id });
      notifyIndex(id); // 「执行中」徽标全设备即时亮起
      return true;
    }
    if (event === 'heartbeat') {
      const st = runningLoops.get(id);
      if (st) { st.lastBeat = Date.now(); st.phase = String(info.phase ?? st.phase).slice(0, 24); }
      // 未知 id 的心跳静默忽略（GC 已回收的不再复活，避免暴毙端复活假象）
      return true;
    }
    if (event === 'done') {
      runningLoops.delete(id);
      audit({ op: 'loop-done', sessionId: id });
      notifyIndex(id); // 「执行中」徽标全设备即时摘除
      return true;
    }
    return false;
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

      // ---- 消息增量合并（POST /:id/messages）----
      // 会话档单一权威化（2026-11-26）：前端直连通道（非服务端 runner 编排）的
      // 消息经此增量落档，不再整会话 PUT。语义与 agent-runner 直写同源
      //（access.mergeMessages，键=消息 id 幂等）：
      // - mode='replace'（默认）：已存在的消息整条替换（settle 后全量推一次，
      //   重推幂等不叠块）——前端直连引擎流的落档模式；
      // - mode='append'：块级追加（服务端 runner 每轮增量）。
      // 服务端 runner 编排的会话不经此端点（runner 直写），前端对那些会话只读。
      // 注意：必须在 :id 精确匹配之前路由（子路径不命中 :id 的 ^...$ 正则）。
      const mMsgs = pathname.match(/^\/api\/chat\/sessions\/([A-Za-z0-9_-]{1,64})\/messages$/);
      if (mMsgs && req.method === 'POST') {
        const id = mMsgs[1];
        const { body: raw, tooLarge } = await readBody();
        if (tooLarge) return sendJson(413, { error: `payload too large (> ${MAX_SESSION_BYTES} bytes)`, code: 'PAYLOAD_TOO_LARGE' });
        let body;
        try { body = JSON.parse(raw || '{}'); } catch { return sendJson(400, { error: 'bad json', code: 'BAD_REQUEST' }); }
        const messages = Array.isArray(body?.messages) ? body.messages : null;
        if (!messages || messages.length === 0) return sendJson(400, { error: 'messages must be a non-empty array', code: 'BAD_REQUEST' });
        if (messages.length > 200) return sendJson(413, { error: 'messages batch too large (max 200)', code: 'PAYLOAD_TOO_LARGE' });
        // 白名单校验：消息必须是带 id 的对象（防畸形数据进档）
        for (const m of messages) {
          if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !m.id) {
            return sendJson(400, { error: 'each message must have a non-empty string id', code: 'BAD_REQUEST' });
          }
        }
        const mode = body.mode === 'append' ? 'append' : 'replace';
        const mergeBlocks = body.mergeBlocks === true || mode === 'append';
        const result = await lock(id, () => {
          const cur = readRecord(id);
          if (cur?.deletedAt) return { status: 404, body: { error: 'session deleted', code: 'SESSION_NOT_FOUND' } };
          const wrote = mergeMessages(id, body.title, messages, {
            createdAt: body.createdAt,
            mergeBlocks,
            mergeMode: mode,
          });
          if (!wrote) return { status: 200, body: { ok: true, version: cur?.version ?? 0, noChange: true } };
          const after = readRecord(id);
          return { status: 200, body: { ok: true, version: after.version, updatedAt: after.updatedAt } };
        });
        return sendJson(result.status, result.body);
      }

      // ---- 元数据补丁（POST /:id/meta）----
      // 改名/置顶/绑定工作区/模型引用等元操作：浅覆盖提供的字段（undefined 字段
      // 不动）；会话不存在时建壳（新建会话的落档入口——此后消息走 /messages）。
      const mMeta = pathname.match(/^\/api\/chat\/sessions\/([A-Za-z0-9_-]{1,64})\/meta$/);
      if (mMeta && req.method === 'POST') {
        const id = mMeta[1];
        const { body: raw, tooLarge } = await readBody();
        if (tooLarge) return sendJson(413, { error: 'payload too large', code: 'PAYLOAD_TOO_LARGE' });
        let body;
        try { body = JSON.parse(raw || '{}'); } catch { return sendJson(400, { error: 'bad json', code: 'BAD_REQUEST' }); }
        const patch = body?.patch;
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
          return sendJson(400, { error: 'patch must be an object', code: 'BAD_REQUEST' });
        }
        // 字段白名单：只接受会话元字段（title/pinned/workspaceId/linkedWorkspaceIds/
        // modelRef/lastActiveAt）；messages 不许从这进（防止绕过 /messages 的校验）
        const ALLOWED = ['title', 'pinned', 'workspaceId', 'linkedWorkspaceIds', 'modelRef', 'lastActiveAt'];
        const clean = {};
        for (const k of ALLOWED) {
          if (patch[k] !== undefined) clean[k] = patch[k];
        }
        if (Object.keys(clean).length === 0) {
          return sendJson(400, { error: `patch must contain at least one of: ${ALLOWED.join(', ')}`, code: 'BAD_REQUEST' });
        }
        const result = await lock(id, () => {
          const cur = readRecord(id);
          if (cur?.deletedAt) return { status: 404, body: { error: 'session deleted', code: 'SESSION_NOT_FOUND' } };
          const session = cur?.session ?? { id, title: '新会话', messages: [], createdAt: Date.now() };
          const before = JSON.stringify(session);
          Object.assign(session, clean);
          if (JSON.stringify(session) === before) {
            return { status: 200, body: { ok: true, version: cur?.version ?? 0, noChange: true } };
          }
          const version = (cur?.version ?? 0) + 1;
          const updatedAt = Date.now();
          writeRecord(id, { version, updatedAt, session });
          audit({ op: 'meta', sessionId: id, version, fields: Object.keys(clean) });
          notifyIndex(id);
          return { status: 200, body: { ok: true, version, updatedAt } };
        });
        return sendJson(result.status, result.body);
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

        // 消息增量合并与元数据补丁已在 :id 精确匹配之前路由（子路径走 mMsgs/mMeta）
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
        const applied = applyLoopState(id, event, { device: body.device, phase: body.phase });
        return applied ? sendJson(200, { ok: true }) : sendJson(400, { error: 'bad id', code: 'BAD_REQUEST' });
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
