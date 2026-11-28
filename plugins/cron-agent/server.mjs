/**
 * cron-agent：定时 AI 任务（spec 原型 2026-11-28 对话定稿）。
 *
 * 职责：cron 到点 → 以独立 sessionId 调 /api/agent/start 发起完整 AI 编排
 * （MCP / Skills / Hooks / 宿主工具全量经 agent-runner runLoop 生效），
 * 结果由 runner 落 chat-store 会话档；本插件跟踪 run 收尾并把结果写入
 * notification-center 的通知收件箱（kv 直写，面板可回看、可跳会话）。
 *
 * 边界（对齐项目纪律）：
 * - 零引擎知识：任务存 modelRef {engineId?, providerId?, modelId?, option?}，
 *   原样透传给 /api/agent/start，由 runner/适配器解析与报错（NO_PROVIDER 等）。
 * - 存储走 kv-store service（registry.getService('kv-store')），不自建 sqlite。
 * - 工具注册走通用 registry.registerTool（同 long-memory 惯例），AI 对话内可用。
 * - 定时器为进程内单实例分钟扫描（非每任务一 timer），常驻成本 O(任务数)；
 *   装配后 15s 自启（2026-11-28 重构：不再等面板首次访问——否则重启后
 *   没人打开面板任务就永远不跑，违背「后台运行」的语义）。
 *
 * 系统凭证（2026-11-28 401 事故修复）：loopback 调 /api/auth/login 用临时 Bearer
 * 换会话 cookie。owner 必须与 auth-owner.json 的真实用户名一致，否则登录
 * 校验（entry.owner !== readOwner().username）401——旧实现经 globalThis.__pliteNodeFs
 * 读 owner，而该全局从未被任何代码设置，解构抛错被吞后回退 'root'：
 * dev（root 账号）碰巧可用，生产（boss 等非 root 账号）必 401。
 * 修复 = 直接 import node:fs 读文件（node:* import 在 server.mjs 豁免，同 agent-runner）。
 *
 * HTTP 面（cookie 门禁，对齐 long-memory/kv-store）：
 *   GET  /api/cron/tasks           → 任务列表 + 最近运行
 *   POST /api/cron/tasks           → 创建
 *   POST /api/cron/tasks/update    → 更新（含启停）
 *   POST /api/cron/tasks/delete    → 删除
 *   POST /api/cron/tasks/run-now   → 立即试跑
 *   GET  /api/cron/engines         → 引擎/供应商目录（转发 cap 面：引擎注册表 + providers）
 */

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

const NS = 'cron-agent';
/** 通知中心收件箱的 kv 坐标与容量（与 notification-center/store.ts 保持一致） */
const NOTIFY_NS = 'notification-center';
const NOTIFY_KEY = 'inbox';
const NOTIFY_MAX = 100;
/** run 收尾跟踪：轮询间隔与上限（30 分钟；超时按跟踪失败收尾，不留永久「执行中」） */
const TRACK_POLL_MS = 15_000;
const TRACK_MAX_POLLS = 120;
/** 孤儿清扫：run 行卡 running 超过此时长视为跟踪丢失（进程重启） */
const STALE_RUNNING_MS = 45 * 60_000;
const TICK_MS = 20_000; // 分钟级扫描（留余量，重复触发由 lastRunAt 幂等挡住）
const MAX_RUNS_PER_TASK = 20;
const BODY_LIMIT = 1 << 20;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// ---- cron 表达式解析（5 段：分 时 日 月 周；支持 * , - / 与数字）----
function parseField(expr, min, max) {
  const out = new Set();
  for (const part of String(expr ?? '').split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`cron 字段不合法: ${expr}`);
    const step = m[2] ? Number(m[2]) : 1;
    if (step <= 0) throw new Error(`cron step 不合法: ${expr}`);
    let from = min; let to = max;
    if (m[1] !== '*') {
      const [a, b] = m[1].split('-').map(Number);
      from = a; to = b ?? a;
      if (from < min || to > max || from > to) throw new Error(`cron 字段越界: ${expr}`);
    }
    for (let i = from; i <= to; i += step) out.add(i);
  }
  return out;
}

function parseCron(expr) {
  const fields = String(expr ?? '').trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('cron 需要 5 段：分 时 日 月 周');
  return {
    minute: parseField(fields[0], 0, 59),
    hour: parseField(fields[1], 0, 23),
    dom: parseField(fields[2], 1, 31),
    month: parseField(fields[3], 1, 12),
    dow: parseField(fields[4], 0, 7), // 0 与 7 都指周日，匹配时归一化
  };
}

/** 判断某时刻是否命中 */
function cronMatches(c, d) {
  if (!c.minute.has(d.getMinutes())) return false;
  if (!c.hour.has(d.getHours())) return false;
  if (!c.dom.has(d.getDate())) return false;
  if (!c.month.has(d.getMonth() + 1)) return false;
  const dow = d.getDay() === 0 ? 7 : d.getDay();
  return c.dow.has(dow) || c.dow.has(0) && dow === 7;
}

/** 下次触发时间（供面板展示；扫描本身逐分钟判断，不依赖此函数） */
function nextFire(c, from = new Date()) {
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60; i++) { // 上限一年分钟数，防死循环
    if (cronMatches(c, d)) return d;
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

export function createServerPart(options = {}) {
  const getSession = options.getSession;
  const registry = options.registry;
  const dataDir = options.dataDir;
  const hardOff = process.env.PLITE_CRON_AGENT === '0';
  // loopback 目标端口：惰性求值（测试经 PLITE_SELF_PORT 指向真实测试服务，
  // createProdServer listen(0) 的随机端口在装配期还拿不到）。
  const selfPort = () => Number(process.env.PLITE_SELF_PORT ?? process.env.PORT ?? 5000);

  const kv = () => registry?.getService?.('kv-store') ?? null;
  const audit = (entry) => {
    try {
      options.logger?.info?.(`[cron-agent] ${JSON.stringify(entry).slice(0, 300)}`);
    } catch { /* */ }
  };

  // ---- 系统级临时凭证（同 agent-runner ensureSystemToken 模式）----
  const verifyTempToken = options.verifyTempToken;
  const tempTokens = options.tempTokens;
  let systemToken = null;
  function ensureSystemToken() {
    try {
      if (systemToken && verifyTempToken?.(systemToken)) return systemToken;
      // owner 必须取 auth-owner.json 的真实用户名：临时凭证登录按
      // entry.owner === 当前 owner 校验，错了登录必 401（2026-11-28 事故根因）。
      const ownerName = (() => {
        try {
          const ownerFile = resolvePath(dataDir, 'auth-owner.json');
          if (existsSync(ownerFile)) return String(JSON.parse(readFileSync(ownerFile, 'utf8')).username ?? 'root');
        } catch { /* 读不到按 root */ }
        return 'root';
      })();
      const token = randomBytes(24).toString('hex');
      tempTokens?.set?.(token, { expiresAt: Date.now() + 24 * 60 * 60 * 1000, owner: ownerName });
      systemToken = token;
      return systemToken;
    } catch { /* 取不到就退化：调用不带凭证，业务错误透传 */ }
    return null;
  }

  // ---- 任务存取（kv 单键 tasks 数组 + 每任务 runs 数组；读多写少，简单可靠）----
  function loadTasks() {
    const k = kv();
    if (!k) return [];
    const v = k.get(NS, 'tasks');
    return Array.isArray(v) ? v.filter((t) => t && typeof t === 'object') : [];
  }
  function saveTasks(tasks) {
    const k = kv();
    if (!k) throw new Error('kv-store 未装配');
    k.set(NS, 'tasks', tasks);
  }
  function loadRuns(taskId) {
    const k = kv();
    if (!k) return [];
    const v = k.get(NS, `runs:${taskId}`);
    return Array.isArray(v) ? v : [];
  }
  function saveRuns(taskId, runs) {
    const k = kv();
    if (!k) throw new Error('kv-store 未装配');
    k.set(NS, `runs:${taskId}`, runs.slice(-MAX_RUNS_PER_TASK));
  }

  function publicTask(t) {
    return {
      id: t.id, name: t.name, cron: t.cron, prompt: t.prompt,
      modelRef: t.modelRef ?? {}, enabled: t.enabled !== false,
      notify: { enabled: notifyEnabled(t) },
      createdAt: t.createdAt, lastRunAt: t.lastRunAt ?? null,
      nextRunAt: t.nextRunAt ?? null,
      lastError: t.lastError ?? null,
    };
  }

  /** 通知开关（新形态 {enabled}；兼容旧 {desktop, phone} 数据） */
  function notifyEnabled(t) {
    const n = t?.notify;
    if (!n || typeof n !== 'object') return true;
    if (typeof n.enabled === 'boolean') return n.enabled;
    if (n.desktop === false && n.phone === false) return false;
    return true;
  }

  function normalizeModelRef(raw) {
    if (!raw || typeof raw !== 'object') return {};
    const ref = {};
    for (const f of ['engineId', 'providerId', 'modelId', 'option']) {
      if (raw[f] !== undefined && raw[f] !== null && String(raw[f]).trim()) ref[f] = String(raw[f]).slice(0, 200);
    }
    return ref;
  }

  function validateTaskInput(body, { partial = false } = {}) {
    const out = {};
    if (!partial || body.name !== undefined) {
      const name = String(body.name ?? '').trim();
      if (!name || name.length > 60) throw new Error('任务名称需 1-60 字');
      out.name = name;
    }
    if (!partial || body.cron !== undefined) {
      out.cron = String(body.cron ?? '').trim();
      out.cronParsed = parseCron(out.cron); // 校验 + 缓存解析结果
    }
    if (!partial || body.prompt !== undefined) {
      const p = String(body.prompt ?? '').trim();
      if (!p || p.length > 4000) throw new Error('提示词需 1-4000 字');
      out.prompt = p;
    }
    if (body.modelRef !== undefined) out.modelRef = normalizeModelRef(body.modelRef);
    if (body.notify !== undefined && typeof body.notify === 'object') {
      // 新形态 {enabled}；兼容旧 {desktop, phone}（二者皆 false 视为关）
      const n = body.notify;
      if (typeof n.enabled === 'boolean') out.notify = { enabled: n.enabled };
      else out.notify = { enabled: !(n.desktop === false && n.phone === false) };
    }
    if (body.enabled !== undefined) out.enabled = !!body.enabled;
    return out;
  }

  // ---- 触发：调 /api/agent/start（同进程 loopback，系统 Bearer）----
  // agent-runner 的 /api/agent/start 走 cookie 会话门禁；临时 Bearer 需先在
  // /api/auth/login 换成会话 cookie（同 auth-session「凭证登录」路径），随后带 cookie 直调。
  let cookieSession = null; // { cookie, expiresAt }
  async function obtainSessionCookie(token) {
    if (!token) return null;
    if (cookieSession && cookieSession.expiresAt > Date.now() + 60_000) return cookieSession;
    const resp = await fetch(`http://127.0.0.1:${selfPort()}/api/auth/login`, {
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

  async function triggerRun(task) {
    const token = ensureSystemToken();
    const sess = await obtainSessionCookie(token);
    const headers = { 'Content-Type': 'application/json' };
    if (sess) headers.Cookie = sess.cookie;
    const sessionId = `cron-${task.id}-${Date.now().toString(36)}`;
    const payload = {
      sessionId,
      messageId: `m-cron-${Date.now().toString(36)}`,
      prompt: task.prompt,
      device: 'cron-agent 定时触发',
      ...task.modelRef,
    };
    const resp = await fetch(`http://127.0.0.1:${selfPort()}/api/agent/start`, {
      method: 'POST', headers, body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await resp.text().catch(() => '');
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* */ }
    return { status: resp.status, ok: resp.ok, json, sessionId };
  }

  function pushRun(taskId, run) {
    const runs = loadRuns(taskId);
    runs.push(run);
    saveRuns(taskId, runs);
    return run;
  }

  /** 更新一条 run 行（只对仍处 running 的行生效，幂等；找不到/已终态则不动） */
  function settleRun(taskId, runId, patch) {
    const runs = loadRuns(taskId);
    const row = runs.find((x) => x.runId && x.runId === runId);
    if (!row || row.status !== 'running') return null;
    Object.assign(row, patch);
    saveRuns(taskId, runs);
    return row;
  }

  function updateTaskMeta(taskId, patch) {
    const tasks = loadTasks();
    const t = tasks.find((x) => x.id === taskId);
    if (!t) return;
    Object.assign(t, patch);
    saveTasks(tasks);
  }

  // ---- 通知：直写 notification-center 收件箱（kv 同步读改写）----
  // 旧实现调 /api/notify、/api/phone/notify——两个端点全库不存在，通知从未落地。
  // 收件箱本就持久化在 kv（namespace=notification-center, key=inbox），服务端直写
  // 即全设备可见（面板/下次打开 App 可回看，条目带 sessionId 可跳会话）。
  // 已知边界：与前端页面的读改写存在竞态（页面 markRead 整表回写可能覆盖掉
  // 刚写入的一两条），对个人应用属可接受概率；通知中心做服务端写通道时再收敛。
  function pushInboxNotice(item) {
    const k = kv();
    if (!k) return;
    try {
      const list = k.get(NOTIFY_NS, NOTIFY_KEY);
      const prev = Array.isArray(list) ? list : [];
      const next = [item, ...prev.filter((x) => x?.id !== item.id)].slice(0, NOTIFY_MAX);
      k.set(NOTIFY_NS, NOTIFY_KEY, next);
    } catch { /* 通知失败不阻断业务 */ }
  }

  function notifyResult(task, run) {
    const ok = run.status === 'done';
    const failed = run.status === 'failed';
    const title = ok ? `定时任务「${task.name}」已完成` : failed ? `定时任务「${task.name}」失败` : `定时任务「${task.name}」${run.status === 'skipped' ? '被跳过' : '已发起'}`;
    const body = failed
      ? `失败原因：${run.error ?? 'unknown'}`
      : ok
        ? `整轮执行结束${run.turns ? `（${run.turns} 轮）` : ''}，点开对话面板可回看完整过程。`
        : (run.error ?? '详见对话面板。');
    pushInboxNotice({
      id: `cron:${run.sessionId ?? `${task.id}:${run.startedAt}`}`,
      level: ok ? 'success' : failed ? 'error' : 'info',
      title, body,
      at: Date.now(),
      read: false,
      source: 'cron-agent',
      sessionId: run.sessionId ?? undefined,
    });
  }

  // ---- run 收尾跟踪：轮询 /api/agent/state + 事件文件判终态 ----
  // run 行发起时落 running；runner 在内存里跑，不回调本插件——旧实现没人跟踪，
  // 行永远停在 running（面板永远「执行中」，下次到点还会被记 skipped）。
  /** 从 run 事件日志提取终态：<dataDir>/agent-runs/<runId>.events.jsonl 尾部的
   *  stream.error / message.done(interrupted) / loop.done。读不到返回 null。 */
  function readRunOutcome(runId) {
    if (!runId) return null;
    try {
      const file = resolvePath(dataDir, 'agent-runs', `${runId}.events.jsonl`);
      if (!existsSync(file)) return null;
      const lines = readFileSync(file, 'utf8').trimEnd().split('\n').slice(-40);
      let outcome = null;
      for (const line of lines) {
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev?.kind === 'stream.error') {
          outcome = { status: 'failed', error: String(ev.payload?.message ?? '执行出错').slice(0, 200) };
        } else if (ev?.kind === 'message.done') {
          if (ev.payload?.interrupted === true) outcome = { status: 'failed', error: '已被中断' };
          else if (!outcome) outcome = { status: 'done' };
        } else if (ev?.kind === 'loop.done') {
          outcome = { ...(outcome ?? { status: 'done' }), turns: Number(ev.payload?.turns ?? 0) || undefined };
        }
      }
      return outcome;
    } catch { return null; }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function trackRunCompletion(task, run) {
    const token = ensureSystemToken();
    for (let i = 0; i < TRACK_MAX_POLLS; i++) {
      await sleep(TRACK_POLL_MS);
      try {
        const sess = await obtainSessionCookie(token);
        const headers = {};
        if (sess) headers.Cookie = sess.cookie;
        const resp = await fetch(`http://127.0.0.1:${selfPort()}/api/agent/state?sessionId=${encodeURIComponent(run.sessionId)}`, { headers, signal: AbortSignal.timeout(10_000) });
        const j = await resp.json().catch(() => null);
        if (resp.ok && j?.running === false) break;
        // 401/网络抖动：下一轮重试（obtainSessionCookie 会换新 cookie）
      } catch { /* 轮询失败不放弃，下一轮再试 */ }
    }
    // 收尾：事件文件优先（含成败语义），读不到再看是否轮询超时
    const outcome = readRunOutcome(run.runId);
    let patch;
    if (outcome) {
      patch = outcome.status === 'failed'
        ? { status: 'failed', endedAt: Date.now(), error: outcome.error }
        : { status: 'done', endedAt: Date.now(), turns: outcome.turns ?? null };
    } else {
      patch = { status: 'failed', endedAt: Date.now(), error: '执行状态丢失（进程重启？结果以会话档为准）' };
    }
    const settled = settleRun(task.id, run.runId, patch) ?? { ...run, ...patch };
    updateTaskMeta(task.id, { lastError: settled.status === 'failed' ? (settled.error ?? null) : null });
    await notifyResult(task, settled);
  }

  /** 发起一次执行（试跑或到点触发共用）；失败落 runs + lastError 并立刻通知；
   *  成功则异步跟踪收尾（完成/失败时再落终态 + 通知）。 */
  async function executeTask(task, reason) {
    const startedAt = Date.now();
    let run;
    try {
      const r = await triggerRun(task);
      if (!r.ok) {
        const err = `start 失败(${r.status}): ${r.json?.error ?? 'unknown'}`;
        run = pushRun(task.id, { runId: null, sessionId: r.sessionId, reason, status: 'failed', startedAt, endedAt: Date.now(), error: err });
      } else {
        run = pushRun(task.id, { runId: r.json?.runId ?? null, sessionId: r.sessionId, reason, status: 'running', startedAt, endedAt: null });
        void trackRunCompletion(task, run).catch(() => undefined);
      }
    } catch (e) {
      run = pushRun(task.id, { runId: null, sessionId: null, reason, status: 'failed', startedAt, endedAt: Date.now(), error: String(e?.message ?? e).slice(0, 200) });
    }
    // 回写任务元数据（lastRunAt / lastError）
    updateTaskMeta(task.id, { lastRunAt: startedAt, lastError: run.status === 'failed' ? (run.error ?? null) : null });
    // 失败立刻通知；成功路径的通知在 trackRunCompletion 收尾时发（带真实结果）
    if (run.status === 'failed') await notifyResult(task, run);
    return run;
  }

  // ---- 调度器：单 timer 分钟扫描 ----
  let tickTimer = null;
  function tick() {
    try {
      const now = new Date();
      const tasks = loadTasks();
      for (const t of tasks) {
        if (t.enabled === false) continue;
        let c;
        try { c = parseCron(t.cron); } catch { continue; }
        // 幂等：同分钟内已触发过（lastRunAt 落在同一触发分钟）则跳过
        const last = t.lastRunAt ? new Date(t.lastRunAt) : null;
        if (last && now.getTime() - last.getTime() < 60_000) continue;
        if (!cronMatches(c, now)) continue;
        // 任务级单飞：上一轮还在 running 则记 skipped
        const runs = loadRuns(t.id);
        if (runs.length && runs[runs.length - 1].status === 'running') {
          pushRun(t.id, { runId: null, sessionId: null, reason: 'cron 到点', status: 'skipped', startedAt: Date.now(), endedAt: Date.now(), error: '上一轮仍在执行' });
          continue;
        }
        audit({ op: 'cron-fire', taskId: t.id, name: t.name });
        void executeTask(t, 'cron 到点').catch(() => undefined);
      }
      // 孤儿清扫：跟踪器只活在进程内存里，进程重启后 run 行会永久卡 running——
      // 超过 STALE_RUNNING_MS 仍 running 的行按「执行状态丢失」收尾并通知。
      for (const t of tasks) {
        try {
          const runs = loadRuns(t.id);
          const lastRun = runs[runs.length - 1];
          if (lastRun?.status === 'running' && Date.now() - (lastRun.startedAt ?? 0) > STALE_RUNNING_MS) {
            const settled = settleRun(t.id, lastRun.runId, { status: 'failed', endedAt: Date.now(), error: '执行状态丢失（进程重启？结果以会话档为准）' });
            if (settled) notifyResult(t, settled);
          }
        } catch { /* 单任务清扫失败不影响其他任务 */ }
      }
      // 顺手刷新展示用 nextRunAt（低频写，不与触发路径竞争）
      let dirty = false;
      for (const t of tasks) {
        try {
          const nf = nextFire(parseCron(t.cron), now)?.getTime() ?? null;
          if (t.nextRunAt !== nf && t.enabled !== false) { t.nextRunAt = nf; dirty = true; }
        } catch { /* 单任务坏 cron 不拖垮整轮刷新 */ }
      }
      if (dirty) saveTasks(tasks);
    } catch { /* 扫描永不抛 */ }
  }

  // ---- 工具注册（AI 在对话里管理定时任务；同 long-memory 惯例）----
  const toolDescriptor = (name, description) => ({
    type: 'function',
    function: { name, description, parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['list', 'create', 'update', 'delete', 'run-now'], description: '操作：list 列出/create 新建/update 更新/delete 删除/run-now 立即试跑' },
      id: { type: 'string', description: '任务 id（update/delete/run-now 必填）' },
      name: { type: 'string', description: '任务名称（create 必填）' },
      cron: { type: 'string', description: 'cron 表达式，5 段「分 时 日 月 周」，如 0 8 * * *（每天8点）、0 9 5 * *（每月5号9点）' },
      prompt: { type: 'string', description: '任务提示词：AI 到点收到的完整指令（create 必填）' },
      modelRef: { type: 'object', description: '模型选择 {engineId?, providerId?, modelId?, option?}，可留空跟随当前活跃模型' },
      enabled: { type: 'boolean', description: '是否启用（update 可改）' },
    }, required: ['action'] } },
  });

  function execToolAction(args) {
    ensureStarted(); // AI 工具路径也拉起调度（不经 HTTP 中间件，没有中间件里的 ensureStarted）
    const a = args ?? {};
    const action = String(a.action ?? '');
    if (action === 'list') {
      const tasks = loadTasks();
      return { ok: true, text: JSON.stringify(tasks.map(publicTask)) };
    }
    if (action === 'create') {
      const tasks = loadTasks();
      const v = validateTaskInput(a);
      if (tasks.length >= 100) throw new Error('任务数已达上限 100');
      const t = {
        id: `t-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`,
        ...v, modelRef: v.modelRef ?? {},
        notify: v.notify ?? { enabled: true },
        enabled: true, createdAt: Date.now(), lastRunAt: null, nextRunAt: null, lastError: null,
      };
      t.nextRunAt = nextFire(t.cronParsed)?.getTime() ?? null;
      delete t.cronParsed; // 解析缓存只在校验期用，不落盘
      tasks.push(t);
      saveTasks(tasks);
      return { ok: true, text: JSON.stringify(publicTask(t)) };
    }
    if (action === 'update') {
      const tasks = loadTasks();
      const t = tasks.find((x) => x.id === String(a.id ?? ''));
      if (!t) throw new Error(`任务不存在: ${a.id}`);
      const v = validateTaskInput(a, { partial: true });
      Object.assign(t, v);
      delete t.cronParsed; // 解析缓存只在校验期用，不落盘
      try { t.nextRunAt = nextFire(parseCron(t.cron))?.getTime() ?? null; } catch { /* */ }
      saveTasks(tasks);
      return { ok: true, text: JSON.stringify(publicTask(t)) };
    }
    if (action === 'delete') {
      const tasks = loadTasks();
      const rest = tasks.filter((x) => x.id !== String(a.id ?? ''));
      if (rest.length === tasks.length) throw new Error(`任务不存在: ${a.id}`);
      saveTasks(rest);
      kv()?.del?.(NS, `runs:${a.id}`);
      return { ok: true, text: `已删除任务 ${a.id}` };
    }
    if (action === 'run-now') {
      const t = loadTasks().find((x) => x.id === String(a.id ?? ''));
      if (!t) throw new Error(`任务不存在: ${a.id}`);
      void executeTask(t, '手动试跑').catch(() => undefined);
      return { ok: true, text: `任务「${t.name}」已发起试跑（报告将自动推送）` };
    }
    throw new Error(`未知 action: ${action}`);
  }

  if (registry?.registerTool) {
    registry.registerTool({
      name: 'cron_tasks',
      noApproval: true,
      descriptor: toolDescriptor('cron_tasks',
        '定时 AI 任务管理：到点自动以完整 AI 对话执行任务（MCP/Skills/Hooks/全部工具可用），报告落会话档并推送。action=list 列出/create 新建/update 修改/delete 删除/run-now 立即试跑。cron 为 5 段「分 时 日 月 周」。'),
      invoke: async ({ args }) => {
        try {
          const r = execToolAction(args);
          return { ok: true, stdout: r.text, stderr: '' };
        } catch (e) {
          return { ok: false, stdout: '', stderr: String(e?.message ?? e) };
        }
      },
    });
  }

  // ---- 启动调度：装配后 15s 自启（不依赖面板访问；unref 不阻塞退出）----
  // 旧实现只在有人访问 /api/cron/* 时才启动——重启后没人打开面板，任务就
  // 永远不跑，违背「定时任务 = 后台运行」的语义（2026-11-28 用户质疑的根因）。
  let started = false;
  function ensureStarted() {
    if (started || hardOff) return;
    started = true;
    tickTimer = setInterval(tick, TICK_MS);
    tickTimer.unref?.(); // 不阻塞进程退出
    audit({ op: 'scheduler-start', tickMs: TICK_MS });
  }
  const bootTimer = setTimeout(() => { try { ensureStarted(); } catch { /* */ } }, 15_000);
  bootTimer.unref?.();

  return async function cronAgentApi(req, res, next) {
    if (hardOff) return next?.();
    const [pathname] = (req.url ?? '').split('?');
    if (!pathname.startsWith('/api/cron/')) return next?.();

    const session = getSession?.(req);
    if (!session) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'unauthorized', code: 'SESSION_REQUIRED' }));
    }
    ensureStarted(); // 首次有人访问（含面板打开）即启动调度

    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(obj));
    };
    const readBody = () => new Promise((r) => {
      let b = '';
      req.on('data', (c) => { b += c; if (b.length > BODY_LIMIT) req.destroy(); });
      req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r(null); } });
      req.on('error', () => r(null));
    });

    try {
      // GET /api/cron/tasks → 任务 + 各自最近 runs
      if (pathname === '/api/cron/tasks' && req.method === 'GET') {
        const tasks = loadTasks().map((t) => ({ ...publicTask(t), runs: loadRuns(t.id).slice(-5).reverse() }));
        return send(200, { tasks });
      }

      if (pathname === '/api/cron/tasks' && req.method === 'POST') {
        const body = await readBody();
        if (!body) return send(400, { error: 'bad json' });
        const tasks = loadTasks();
        const v = validateTaskInput(body);
        const t = {
          id: `t-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`,
          ...v, modelRef: v.modelRef ?? {},
          notify: v.notify ?? { enabled: true },
          enabled: body.enabled === false ? false : true,
          createdAt: Date.now(), lastRunAt: null, nextRunAt: null, lastError: null,
        };
        t.nextRunAt = nextFire(t.cronParsed)?.getTime() ?? null;
        delete t.cronParsed; // 解析缓存只在校验期用，不落盘
        tasks.push(t);
        saveTasks(tasks);
        audit({ op: 'task-create', id: t.id, name: t.name });
        return send(200, { ok: true, task: publicTask(t) });
      }

      if (pathname === '/api/cron/tasks/update' && req.method === 'POST') {
        const body = await readBody();
        if (!body) return send(400, { error: 'bad json' });
        const tasks = loadTasks();
        const t = tasks.find((x) => x.id === String(body.id ?? ''));
        if (!t) return send(404, { error: '任务不存在' });
        const v = validateTaskInput(body, { partial: true });
        Object.assign(t, v);
        delete t.cronParsed; // 解析缓存只在校验期用，不落盘
        try { t.nextRunAt = nextFire(parseCron(t.cron))?.getTime() ?? null; } catch (e) {
          return send(400, { error: String(e?.message ?? e) });
        }
        saveTasks(tasks);
        return send(200, { ok: true, task: publicTask(t) });
      }

      if (pathname === '/api/cron/tasks/delete' && req.method === 'POST') {
        const body = await readBody();
        if (!body) return send(400, { error: 'bad json' });
        const tasks = loadTasks();
        const rest = tasks.filter((x) => x.id !== String(body.id ?? ''));
        if (rest.length === tasks.length) return send(404, { error: '任务不存在' });
        saveTasks(rest);
        kv()?.del?.(NS, `runs:${body.id}`);
        return send(200, { ok: true });
      }

      if (pathname === '/api/cron/tasks/run-now' && req.method === 'POST') {
        const body = await readBody();
        if (!body) return send(400, { error: 'bad json' });
        const t = loadTasks().find((x) => x.id === String(body.id ?? ''));
        if (!t) return send(404, { error: '任务不存在' });
        void executeTask(t, '手动试跑').catch(() => undefined);
        return send(200, { ok: true, message: '已发起' });
      }

      // GET /api/cron/engines → 三级模型目录（引擎注册表 + providers 活跃模型）
      if (pathname === '/api/cron/engines' && req.method === 'GET') {
        const engines = registry?.listEngines?.() ?? [];
        const token = ensureSystemToken();
        const headers = {};
        if (token) headers.Authorization = `Bearer ${token}`;
        let providers = [];
        try {
          const r = await fetch(`http://127.0.0.1:${selfPort()}/api/providers/list`, { headers });
          const j = await r.json().catch(() => null);
          providers = Array.isArray(j?.configs)
            ? j.configs.map((p) => ({ id: p.id, label: p.label ?? p.id, activeModel: p.activeModel ?? null }))
            : [];
        } catch { providers = []; }
        return send(200, { engines, providers, activeId: null });
      }

      return send(404, { error: 'not found' });
    } catch (e) {
      return send(400, { error: String(e?.message ?? e) });
    }
  };
}
