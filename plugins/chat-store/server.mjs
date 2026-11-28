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
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, appendFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';

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
  const storeDir = access.storeDir; // 工具侧缓存 mtime 校验用（同一存储目录）
  options.registry?.registerService?.('chat-store', access);

  // ------------------------------------------------------------------
  // chat_history 工具（AI 可用）：历史会话的 list / search / read / set_model
  // ------------------------------------------------------------------
  // 动机：transcript 工具能读单会话但 AI 拿不到 sessionId；侧栏搜索是纯前端。
  // 本工具补上「AI 视角的会话检索闭环」：搜到 → 读全 → （可选）换模型续聊。
  // 只读为主；set_model 是唯一写操作（乐观锁，版本不符报 409 语义）。
  if (options.registry?.registerTool) {
    const HISTORY_FEEDBACK_CAP = 8 * 1024; // 反馈帽：与 transcript/mcp_ 惯例一致
    const SEARCH_HITS_MAX = 20;            // 命中会话数上限
    const SEARCH_SNIPPET = 120;            // 命中片段长度
    /** 全文搜索缓存：sessionId → { mtime, msgs }（mtime 不变则复用已解析 messages） */
    const searchCache = new Map();

    /** 读取会话消息为纯文本数组（标题 + 全部消息正文；含缓存） */
    function sessionTexts(rec) {
      const session = rec?.session;
      if (!session || !Array.isArray(session.messages)) return [];
      return session.messages
        .filter((m) => m && typeof m.content === 'string' && m.content.trim())
        .map((m) => ({ role: m.role, content: m.content }));
    }

    /** 缓存版：sessionId → [{role, content}]（文件 mtime 变化才重新解析） */
    function cachedTexts(id, rec) {
      let mtime = 0;
      try { mtime = statSync(join(storeDir, `${id}.json`)).mtimeMs; } catch { return { mtime: 0, texts: [] }; }
      const hit = searchCache.get(id);
      if (hit && hit.mtime === mtime) return hit;
      const entry = { mtime, texts: sessionTexts(rec) };
      searchCache.set(id, entry);
      // 简单防膨胀：超过 512 条目时清最旧一半（会话量级 ≤ 数百，正常不会触顶）
      if (searchCache.size > 512) {
        const keys = [...searchCache.keys()].slice(0, 256);
        for (const k of keys) searchCache.delete(k);
      }
      return entry;
    }

    /** 朴素全文搜索：标题 + 全部消息正文；返回命中会话摘要（限 SEARCH_HITS_MAX） */
    function searchSessions(q) {
      const needle = String(q ?? '').trim().toLowerCase();
      if (!needle) return { error: 'q required' };
      const hits = [];
      for (const rec of listRecords()) {
        if (rec.deletedAt) continue;
        const session = rec.session ?? {};
        const title = String(session.title ?? '');
        let snippet = '';
        let hitInTitle = title.toLowerCase().includes(needle);
        let hitInBody = false;
        const { texts } = cachedTexts(rec.session?.id, rec);
        for (const t of texts) {
          const lower = t.content.toLowerCase();
          const idx = lower.indexOf(needle);
          if (idx >= 0) {
            hitInBody = true;
            snippet = t.content.slice(Math.max(0, idx - 40), idx + SEARCH_SNIPPET).replace(/\s+/g, ' ');
            break; // 每会话取首个命中片段即可
          }
        }
        if (hitInTitle || hitInBody) {
          hits.push({
            sessionId: rec.session?.id,
            title: title || '（无标题）',
            msgCount: texts.length,
            updatedAt: rec.updatedAt,
            lastActiveAt: session.lastActiveAt ?? 0,
            matched: hitInTitle ? 'title' : 'body',
            snippet,
          });
        }
        if (hits.length >= SEARCH_HITS_MAX) break;
      }
      hits.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      return { hits, total: hits.length };
    }

    /** 读单会话转录（标题/模型/消息对，正文截断到总帽） */
    function readSessionTranscript(id) {
      if (!ID_RE.test(String(id ?? ''))) return { error: 'sessionId invalid' };
      const rec = readRecord(id);
      if (!rec) return { error: 'session not found' };
      const session = rec.session ?? {};
      const msgs = (session.messages ?? []).map((m) => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : '',
        createdAt: m.createdAt,
      }));
      return {
        sessionId: id,
        title: session.title ?? '（无标题）',
        modelRef: session.modelRef ?? (session.engineId ? { engineId: session.engineId } : null),
        codebuddyModel: session.codebuddyModel ?? null,
        createdAt: session.createdAt,
        lastActiveAt: session.lastActiveAt ?? 0,
        msgCount: msgs.length,
        messages: msgs,
      };
    }

    options.registry.registerTool({
      name: 'chat_history',
      // 读历史无审批成本；set_model 是低风险配置写（用户可随时在 UI 再改）
      noApproval: true,
      descriptor: {
        type: 'function',
        function: {
          name: 'chat_history',
          description:
            '历史会话检索与模型切换（只读为主）。action=list 列出会话（标题/时间/消息数，limit 可选默认 50）；' +
            'search=全文搜索标题+全部消息正文（q 必填，返回 sessionId+命中片段）；' +
            'read=读会话完整转录（sessionId 必填，含当时模型）；' +
            'set_model=设置会话模型（sessionId+modelRef 必填，下一轮对话生效，版本冲突返回 409 语义需重读重试）。' +
            '典型链路：search 拿 sessionId → read 看全文 → 向用户汇报或 set_model 换模型。',
          parameters: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['list', 'search', 'read', 'set_model'] },
              sessionId: { type: 'string', description: '会话 id（read/set_model 必填）' },
              q: { type: 'string', description: '搜索词（search 必填）' },
              limit: { type: 'number', description: 'list 返回条数上限（默认 50，最大 200）' },
              modelRef: { type: 'object', description: '模型选择 {engineId?, providerId?, modelId?, option?}（set_model 必填）' },
            },
            required: ['action'],
          },
        },
      },
      invoke: async ({ args }) => {
        if (hardOff) return { ok: false, stdout: '', stderr: 'chat-store 已被 PLITE_CHAT_STORE=0 禁用' };
        const action = String(args?.action ?? '');
        try {
          if (action === 'list') {
            const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 200);
            const sessions = listRecords()
              .filter((r) => !r.deletedAt)
              .sort((a, b) => (b.session?.lastActiveAt ?? b.updatedAt ?? 0) - (a.session?.lastActiveAt ?? a.updatedAt ?? 0))
              .slice(0, limit)
              .map((r) => ({
                sessionId: r.session?.id,
                title: r.session?.title ?? '（无标题）',
                msgCount: Array.isArray(r.session?.messages) ? r.session.messages.length : 0,
                createdAt: r.session?.createdAt ?? 0,
                lastActiveAt: r.session?.lastActiveAt ?? r.updatedAt ?? 0,
              }));
            return { ok: true, stdout: JSON.stringify({ count: sessions.length, sessions }).slice(0, HISTORY_FEEDBACK_CAP), stderr: '' };
          }
          if (action === 'search') {
            const r = searchSessions(args.q);
            if (r.error) return { ok: false, stdout: '', stderr: r.error };
            return { ok: true, stdout: JSON.stringify(r).slice(0, HISTORY_FEEDBACK_CAP), stderr: '' };
          }
          if (action === 'read') {
            const t = readSessionTranscript(args.sessionId);
            if (t.error) return { ok: false, stdout: '', stderr: t.error };
            return { ok: true, stdout: JSON.stringify(t).slice(0, HISTORY_FEEDBACK_CAP), stderr: '' };
          }
          if (action === 'set_model') {
            const sid = String(args.sessionId ?? '').trim();
            if (!ID_RE.test(sid)) return { ok: false, stdout: '', stderr: 'sessionId invalid' };
            const modelRef = args.modelRef;
            if (!modelRef || typeof modelRef !== 'object' || Array.isArray(modelRef)) {
              return { ok: false, stdout: '', stderr: 'modelRef required (object {engineId?,providerId?,modelId?,option?})' };
            }
            const clean = {};
            for (const k of ['engineId', 'providerId', 'modelId', 'option']) {
              if (modelRef[k] !== undefined) clean[k] = modelRef[k];
            }
            if (Object.keys(clean).length === 0) return { ok: false, stdout: '', stderr: 'modelRef 不能为空对象' };
            const applied = await lock(sid, () => {
              const rec = readRecord(sid);
              if (!rec) return { error: 'session not found' };
              rec.session = rec.session ?? {};
              rec.session.modelRef = clean;
              const version = (Number(rec.version) || 0) + 1;
              writeRecord(sid, { version, updatedAt: Date.now(), session: rec.session });
              notifyIndex(sid);
              audit({ op: 'set-model', sessionId: sid, modelRef: clean, version });
              return { version, modelRef: clean };
            });
            if (applied.error) return { ok: false, stdout: '', stderr: applied.error };
            return { ok: true, stdout: JSON.stringify({ ok: true, sessionId: sid, ...applied, note: '下一轮对话生效' }), stderr: '' };
          }
          return { ok: false, stdout: '', stderr: `unknown action: ${action}（可用：list/search/read/set_model）` };
        } catch (e) {
          return { ok: false, stdout: '', stderr: String(e?.message ?? e) };
        }
      },
    });
  }
  // ------------------------------------------------------------------
  // chat_start 工具（AI 可用）：AI 在对话内发起一个全新独立会话
  // ------------------------------------------------------------------
  // P2（docs/chat-history-tool-plan.md）：内部即 POST /api/agent/start，
  // 新 sessionId + modelRef 透传，run/审批/工具/推送全套走 runner 既有编排。
  // 防递归护栏：invoke 上下文带 run（发起方 run）——若发起方自身已是 AI run
  //（其 sessionId 以 'chat-start-' 前缀标记），拒绝再套娃（深度恒为 1）。
  if (options.registry?.registerTool) {
    const selfPort = Number(process.env.PORT ?? 5000);
    const verifyTempToken = options.verifyTempToken;
    const tempTokens = options.tempTokens;
    let systemToken = null;
    /** 系统级临时凭证（同 cron-agent/agent-runner ensureSystemToken 模式） */
    function ensureSystemToken() {
      try {
        if (systemToken && verifyTempToken?.(systemToken)) return systemToken;
        const ownerName = (() => {
          try {
            const { resolve: rsv, existsSync: ex, readFileSync: rf } = globalThis.__pliteNodeFs;
            if (ex && rf) {
              const f = rsv(dataDir, 'auth-owner.json');
              if (ex(f)) return String(JSON.parse(rf(f, 'utf8')).username ?? 'root');
            }
          } catch { /* */ }
          return 'root';
        })();
        const token = randomBytes(24).toString('hex');
        tempTokens?.set?.(token, { expiresAt: Date.now() + 24 * 60 * 60 * 1000, owner: ownerName });
        systemToken = token;
        return token;
      } catch { return null; }
    }
    let cookieSession = null; // { cookie, expiresAt }
    async function obtainSessionCookie(token) {
      if (!token) return null;
      if (cookieSession && cookieSession.expiresAt > Date.now() + 60_000) return cookieSession;
      const resp = await fetch(`http://127.0.0.1:${selfPort}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: '{}', signal: AbortSignal.timeout(10_000),
      });
      const setCookie = resp.headers.get('set-cookie');
      if (!resp.ok || !setCookie) return null;
      const sid = /plite\.sid=([^;]+)/.exec(setCookie)?.[1];
      if (!sid) return null;
      cookieSession = { cookie: `plite.sid=${sid}`, expiresAt: Date.now() + 60 * 60 * 1000 };
      return cookieSession;
    }

    options.registry.registerTool({
      name: 'chat_start',
      // 发起一个新会话即产生真实 AI 消耗，保留审批（用户确认成本合理）
      noApproval: false,
      descriptor: {
        type: 'function',
        function: {
          name: 'chat_start',
          description:
            '以指定模型发起一个全新的独立 AI 对话（新会话，不接续当前上下文）。prompt 为首轮用户消息（1-4000 字），' +
            'modelRef 可选 {engineId?, providerId?, modelId?, option?}（留空跟随默认引擎/模型）。' +
            '返回新会话的 sessionId 与 runId，结果由 runner 落会话档，用户可在侧栏打开查看。' +
            '防套娃：由 AI 工具发起的会话内不可再调本工具。',
          parameters: {
            type: 'object',
            properties: {
              prompt: { type: 'string', description: '新会话的首轮用户消息（必填，1-4000 字）' },
              modelRef: { type: 'object', description: '模型选择 {engineId?, providerId?, modelId?, option?}（可选）' },
              title: { type: 'string', description: '新会话标题（可选，缺省由首条消息生成）' },
            },
            required: ['prompt'],
          },
        },
      },
      invoke: async ({ args, run }) => {
        if (hardOff) return { ok: false, stdout: '', stderr: 'chat-store 已被 PLITE_CHAT_STORE=0 禁用' };
        try {
          // 防递归：当前 run 若本身就是 chat_start 发起的会话（sessionId 前缀标记），拒绝
          const originSessionId = String(run?.sessionId ?? '');
          if (originSessionId.startsWith('chat-start-')) {
            return { ok: false, stdout: '', stderr: '拒绝：本会话由 AI 工具发起，不可再嵌套 chat_start（防无限套娃）' };
          }
          const prompt = String(args?.prompt ?? '').trim();
          if (!prompt || prompt.length > 4000) return { ok: false, stdout: '', stderr: 'prompt 需 1-4000 字' };
          const modelRef = (args?.modelRef && typeof args.modelRef === 'object' && !Array.isArray(args.modelRef)) ? args.modelRef : {};
          const cleanRef = {};
          for (const k of ['engineId', 'providerId', 'modelId', 'option']) {
            if (modelRef[k] !== undefined) cleanRef[k] = modelRef[k];
          }
          const sessionId = `chat-start-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
          // 标题预置（首条消息落档后 chat-store 会用其生成标题；显式传入则直接写档）
          if (args?.title && typeof args.title === 'string' && args.title.trim()) {
            try {
              await lock(sessionId, () => {
                writeRecord(sessionId, { version: 1, updatedAt: Date.now(), session: { id: sessionId, title: String(args.title).trim().slice(0, 80), createdAt: Date.now(), messages: [] } });
                return null;
              });
              notifyIndex(sessionId);
            } catch { /* 标题写失败不阻断发起 */ }
          }
          const token = ensureSystemToken();
          const sess = await obtainSessionCookie(token);
          const headers = { 'Content-Type': 'application/json' };
          if (sess) headers.Cookie = sess.cookie;
          const payload = {
            sessionId,
            messageId: `m-cs-${Date.now().toString(36)}`,
            prompt,
            device: 'chat_start（AI 发起）',
            ...cleanRef,
          };
          const resp = await fetch(`http://127.0.0.1:${selfPort}/api/agent/start`, {
            method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(30_000),
          });
          const text = await resp.text().catch(() => '');
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch { /* */ }
          if (!resp.ok) {
            const errText = json?.error ?? (text.slice(0, 200) || 'unknown');
            return { ok: false, stdout: '', stderr: `start 失败(${resp.status}): ${errText}` };
          }
          audit({ op: 'chat-start', sessionId, originSessionId, modelRef: cleanRef, runId: json?.runId ?? null });
          return {
            ok: true,
            stdout: JSON.stringify({ ok: true, sessionId, runId: json?.runId ?? null, note: '新会话已发起，runner 正在执行，结果落会话档，用户可在侧栏打开' }),
            stderr: '',
          };
        } catch (e) {
          return { ok: false, stdout: '', stderr: String(e?.message ?? e) };
        }
      },
    });
  }
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
