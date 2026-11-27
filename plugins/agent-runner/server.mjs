/**
 * agent-runner 插件的服务端半边（/api/agent/*）：AI 编排循环的服务端执行器。
 *
 * spec：docs/chat-server-orchestration-plan.md（B1 服务端编排）+ docs/agent-runner-plan.md
 *
 * 解决的两个根因（原前端 agent-loop 的结构性缺陷）：
 * ① 流式中刷新页面任务即死——shadow transcript / 循环 / 审批挂起全在浏览器闭包；
 * ② 多设备看不到执行中的实时情况——执行状态只在发起设备内存。
 *
 * 架构：
 * - 编排循环跑在本服务端中间件进程内（异步任务，不 spawn 子进程）；
 * - runs 表（内存）：runId → { sessionId, shadow, phase, cursor, abort, subs… }；
 * - 事件先落盘（<dataDir>/agent-runs/<runId>.events.jsonl）再扇出（SSE）；
 *   订阅端带 Last-Event-Id 续传——刷新/重连后 UI 从事件日志完整重建；
 * - 模型调用直连 provider store + undici（与 relay-core 同款超时/断流语义），
 *   key 只在服务端；工具调用直连各工具 server 半边端点（loopback，沿用其
 *   cookie 门禁之下的同一裁决/审计；会话身份用系统级 Bearer 临时凭证）；
 * - 审批服务端挂起（Promise），任意在线设备 POST /approve 先到先得；
 *   全部设备离线 120s 超时自动拒绝（沿用前端 agent-loop 语义）。
 *
 * 安全模型：
 * - 会话 cookie 硬门禁（未登录 401）；PLITE_AGENT_RUNNER=0 一键禁用；
 * - runId/sessionId 匹配 ^[A-Za-z0-9_-]{1,64}$（防路径穿越）；
 * - 工具执行沿用 agent-bash 的 mode/denylist/审计裁决（approved 标记由本编排器
 *   在审批通过后携带，服务端二次校验语义不变）；
 * - 事件日志按 run 落盘，run 结束保留（UI 重放需要），由 GC 按 TTL 清理。
 */
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync, renameSync, readdirSync, rmSync, statSync, openSync, writeSync, closeSync } from 'node:fs';
import { once } from 'node:events';
import { resolve, join } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
// 上下文压缩（simple_ai/compact.rs 语义纯函数；Node 24 类型剥离直接吃 TS）。
// 零 DOM/零副作用：UsageAccumulator/estimateTokens/compactShadow 均可服务端复用。
import { UsageAccumulator, estimateTokens, compactShadow } from '../shared/context-compact.ts';
import { buildUsagePayload } from '../shared/usage.ts';
import { summarizeToolCall } from '../shared/tool-summary.ts';
// 编排协议工具：仅 `interactive`（向用户提问的编排原语，依赖 run 的挂起回填表）。
// 所有**领域工具**（bash/files/files_write/render/browser/read_skill/ledger/translate/
// suggestions/transcript/phone/market_*/mcp_*）由各自插件的 server 半边在
// createServerPart 里经 registry.registerTool 自注册——runner 不认识任何具体工具。
import { registerOrchestrationTools } from './orchestration-tools.mjs';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const RUNS_DIR = 'agent-runs';
/** SSE 保活 ping 间隔 */
const SSE_PING_MS = 15_000;
/** 审批挂起超时（无人值守自动拒绝；对齐前端 agent-loop APPROVAL_TIMEOUT_MS） */
const APPROVAL_TIMEOUT_MS = 120_000;
/** 循环护栏（对齐前端 agent-loop 2026-11-25 恢复的循环闸） */
const MAX_LOOP_TURNS = 40;
const MAX_TOOL_CALLS = 80;
/** 截断结果喂回模型的上下限（对齐 FEEDBACK_CAP） */
const FEEDBACK_CAP = 8 * 1024;
/** 单 run 事件日志大小上限（防失控；超出截断并标记） */
const RUN_LOG_MAX_BYTES = 32 * 1024 * 1024;
/** 已结束 run 的事件日志保留期（GC 懒清理） */
const RUN_LOG_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 并发 run 上限（单 owner 场景） */
const MAX_CONCURRENT_RUNS = 3;
/** SSE delta 合批窗口（毫秒）：逐 token 不逐条 write/落盘，降事件循环压力 */
const DELTA_FLUSH_MS = 16;
/** sessionShadows 上限（LRU）：跨 run 只保留最近 N 个会话的 shadow，防常驻泄漏 */
const MAX_SESSION_SHADOWS = 24;
/** 单个 run buffer 上限（超出丢弃最旧——syncTurnToSession 只需未同步段） */
const MAX_RUN_BUFFER = 4096;

export function createServerPart(options = {}) {
  const getSession = options.getSession;
  const dataDir = resolve(options.dataDir ?? '.polaris-lite');
  const runsDir = resolve(dataDir, RUNS_DIR);
  const auditFile = resolve(dataDir, 'agent-runner-audit.log');
  const hardOff = process.env.PLITE_AGENT_RUNNER === '0';

  // ---- 系统级临时凭证（工具 server 半边的 Bearer 门禁；仅 loopback） ----
  // tempTokens 是「token → {expiresAt, owner}」Map（auth-session 注入），verifyTempToken
  // 校验 owner=注册人用户名。编排器在首次需要时自签一个 owner=注册人的系统 token
  //（TTL 24h，续期懒触发）——工具 server 半边的 denylist/mode/审计裁决原样生效，
  // Bearer 只表达「本地系统调用已审批」这一既有语义（与 auth-session 文档一致）。
  const verifyTempToken = options.verifyTempToken;
  const tempTokens = options.tempTokens;
  let systemToken = null;
  function ensureSystemToken() {
    try {
      if (systemToken && verifyTempToken?.(systemToken)) return systemToken;
      const ownerName = (() => {
        try {
          const ownerFile = resolve(dataDir, 'auth-owner.json');
          if (existsSync(ownerFile)) return String(JSON.parse(readFileSync(ownerFile, 'utf8')).username ?? 'root');
        } catch { /* 读不到按 root */ }
        return 'root';
      })();
      const token = randomBytes(24).toString('hex');
      const ttlMs = 24 * 60 * 60 * 1000;
      tempTokens?.set?.(token, { expiresAt: Date.now() + ttlMs, owner: ownerName });
      systemToken = token;
      return systemToken;
    } catch { /* 取不到就退化：工具调用不带 Bearer（confirm 模式走 approved 标记） */ }
    return null;
  }

  function audit(entry) {
    try {
      mkdirSync(dataDir, { recursive: true });
      appendFileSync(auditFile, `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
    } catch { /* 审计失败不阻断业务 */ }
  }

  // ------------------------------------------------------------------
  // runs 表（内存；进程重启即全收口——宿主重启=所有 loop 已死，与旧语义一致）
  // ------------------------------------------------------------------
  /** runId → run 记录 */
  const runs = new Map();
  /** sessionId → runId（同会话单飞；重复 start 返回既有 run） */
  const runsBySession = new Map();
  /** sessionId → 上一 run 的 shadow（多轮会话跨 run 延续；进程内存态） */
  const sessionShadows = new Map();
  /** `sessionId::assistantId` → 已结束 run 的可续写快照（「继续」按钮服务端恢复；LRU 上限） */
  const resumableRuns = new Map();
  const MAX_RESUMABLE_RUNS = 16;

  function runLogPath(runId) { return join(runsDir, `${runId}.events.jsonl`); }
  function runStatePath(runId) { return join(runsDir, `${runId}.state.json`); }

  // ------------------------------------------------------------------
  // 会话档服务端合并（消除「发消息后关页面 → 对话消失」的易失窗口）
  // ------------------------------------------------------------------
  // 背景：会话消息的持久化此前完全依赖客户端（chat-lite 消费事件后防抖 PUT
  // chat-store）。发起端在防抖窗口内被杀（关 App/浏览器/切后台被冻结）时，
  // 用户消息与 AI 回复都不会进入服务端会话档——任务虽在服务端跑完，重开页面
  // 却看不到这条对话。
  //
  // 做法：编排器在服务端把「用户消息 + 本轮 AI 产出」合并进服务端会话档。
  // **不直写文件**：经 server/adapter-registry 的 service 表取 chat-store 注册的
  // 访问器（mergeMessages 内部保证版本递增、索引广播、审计）——runner 不认识
  // <dataDir>/chat-store 的文件版式，换存储实现时这里零改动。
  const chatStoreService = () => options.registry?.getService?.('chat-store') ?? null;

  /**
   * 把消息合并进服务端会话档（幂等：按消息 id 去重；缺会话则建壳）。
   * 语义由 chat-store 的 mergeMessages 定义（本文件不再复制第二份）。
   * 返回是否实际写入（无新增内容时 false，不空转版本号）。
   */
  function mergeChatMessages(sessionId, title, messages, opts = {}) {
    const svc = chatStoreService();
    if (!svc?.mergeMessages) {
      audit({ op: 'chat-sync-skip', sessionId, reason: 'chat-store service unavailable' });
      return false;
    }
    try {
      return svc.mergeMessages(sessionId, title, messages, opts) === true;
    } catch (e) {
      audit({ op: 'chat-sync-fail', sessionId, error: String(e?.message ?? e).slice(0, 120) });
      return false;
    }
  }

  /** 「执行中」徽标上报（chat-store 的 loop 运行态；service 不可用时静默降级——
   *  徽标是可见性增强，缺失不影响任何主流程）。device 取发起端透传的 body.device。 */
  function reportLoopState(run, event) {
    try {
      const svc = options.registry?.getService?.('chat-loop-state');
      svc?.report?.(run.sessionId, event, { device: run.device ?? '编排服务端', phase: 'running' });
    } catch { /* 徽标链路失败静默 */ }
  }

  /** 本 run 的用户消息（start 时落一次；幂等） */
  function syncUserMessage(run, prompt, createdAt) {
    if (!prompt?.trim()) return;
    mergeChatMessages(run.sessionId, null, [{
      id: `u-${run.id}`,
      role: 'user',
      content: prompt,
      createdAt: Number(createdAt) || Date.now(),
    }], { createdAt });
  }

  /**
   * 本轮 AI 产出落档（每轮 engineTurn 收敛后调用；增量、幂等）。
   * 结构：text/thinking 聚合为 blocks（与前端 appendAssistantBlock 同形状），
   * 工具卡逐个落 tool 块（含结果回填），interactive/artifact 落对应块。
   */
  function syncTurnToSession(run, turnNo) {
    const seen = run.syncedSeq ?? 0;
    const evs = run.buffer.filter((e) => e.seq > seen);
    if (evs.length === 0) return;
    run.syncedSeq = evs[evs.length - 1].seq;
    const blocks = [];
    let text = '';
    for (const ev of evs) {
      const p = ev.payload ?? {};
      if (ev.kind === 'message.reasoning' && p.delta) {
        const last = blocks[blocks.length - 1];
        if (last?.type === 'thinking') last.text += p.delta;
        else blocks.push({ type: 'thinking', text: p.delta });
      } else if (ev.kind === 'message.delta' && p.delta) {
        text += p.delta;
        const last = blocks[blocks.length - 1];
        if (last?.type === 'text') last.text += p.delta;
        else blocks.push({ type: 'text', text: p.delta });
      } else if (ev.kind === 'tool.args.delta') {
        // 流式预览增量：不落档（完整参数由收尾的 tool.card / tool.calls 帧承载）
      } else if (ev.kind === 'tool.card') {
        // 同 callId 可能连发两帧（首帧 args 恒为空、收尾帧才带完整参数），也可能
        // 由引擎在 turn 内实时上报一次、再由 runner 的回放段上报一次：一律按
        // callId 幂等——已存在则回填非空字段，绝不新建第二个块（否则工具卡重复）。
        const exist = blocks.find((b) => b.type === 'tool' && b.card?.callId === p.callId);
        if (exist) {
          if (p.name) exist.card.name = p.name;
          if (p.command) exist.card.command = p.command;
          if (p.argsJson) exist.card.argsJson = p.argsJson;
        } else {
          blocks.push({ type: 'tool', card: { callId: p.callId, name: p.name, command: p.command, argsJson: p.argsJson, status: 'running' } });
        }
      } else if (ev.kind === 'tool.result') {
        const card = blocks.find((b) => b.type === 'tool' && b.card?.callId === p.callId)?.card;
        if (card) {
          card.status = p.status === 'done' ? 'done' : p.status === 'denied' ? 'denied' : 'error';
          card.stdout = p.stdout; card.stderr = p.stderr; card.exitCode = p.exitCode;
          card.durationMs = p.durationMs; card.truncated = p.truncated;
        }
      } else if (ev.kind === 'tool.approval.resolved') {
        const card = blocks.find((b) => b.type === 'tool' && b.card?.callId === p.callId)?.card;
        if (card && card.status === 'running' && (p.decision === 'deny' || p.autoRejected)) card.status = 'denied';
      } else if (ev.kind === 'interactive.required') {
        blocks.push({ type: 'interactive', card: { callId: p.callId, kind: p.kind ?? 'question', title: p.title ?? '', payload: { options: p.options ?? [], fields: p.fields ?? [] }, status: 'awaiting' } });
      } else if (ev.kind === 'interactive.resolved') {
        const card = blocks.find((b) => b.type === 'interactive' && b.card?.callId === p.callId)?.card;
        if (card) { card.status = 'answered'; card.answer = p.answer ?? {}; }
      } else if (ev.kind === 'artifact.created') {
        blocks.push({ type: 'artifact', card: { callId: p.callId, rendererType: p.rendererType, title: p.title ?? '产物', status: 'ready', data: p.data ?? {} } });
      } else if (ev.kind === 'message.continued') {
        blocks.push({ type: 'notice', text: `[已自动续写 ${p.attempt ?? '?'}/${p.max ?? 3}]` });
      } else if (ev.kind === 'message.truncated') {
        blocks.push({ type: 'truncated', text: p.text ?? '回复因达到输出上限被截断' });
      } else if (ev.kind === 'stream.error') {
        // 错误同样要落档：上游 402/401、引擎崩、CLI 未登录都只会走到这里。
        // 不落的话刷新/换设备就只剩一条用户消息，看起来像「消息丢了」。
        blocks.push({ type: 'text', text: String(p.message ?? '流式请求失败') });
        text = text || String(p.message ?? '流式请求失败');
      }
    }
    if (blocks.length === 0) return;
    mergeChatMessages(run.sessionId, null, [{
      id: run.assistantId,
      role: 'assistant',
      content: text,
      blocks,
      createdAt: run.turnStartedAt ?? Date.now(),
      ...(run.finished ? { endedAt: Date.now() } : {}),
    }], { mergeBlocks: true });
  }

  /** 单条 SSE 写出：respect 背压，write()===false 时排队到 drain，避免慢客户端在 Node 缓冲无界增长。 */
  function writeFrame(res, frame) {
    try {
      if (res._agentPaused) {
        (res._agentQueue ??= []).push(frame);
        if (res._agentQueue.length > 2048) { res.destroy(); return; }
        return;
      }
      if (res.write(frame) === false) {
        res._agentPaused = true;
        once(res, 'drain', () => {
          res._agentPaused = false;
          const q = res._agentQueue ?? [];
          res._agentQueue = [];
          for (const f of q) writeFrame(res, f);
        });
      }
    } catch { /* 断开由 close 回收 */ }
  }

  /** 冲刷 delta 合批缓冲（保序：把待发的 delta 帧合并后一次性扇出）。 */
  function flushFrames(run) {
    if (run.frameTimer) { clearTimeout(run.frameTimer); run.frameTimer = null; }
    const frames = run.pendingFrames;
    if (!frames || frames.length === 0) return;
    run.pendingFrames = [];
    const combined = frames.join('');
    for (const res of [...run.subs]) writeFrame(res, combined);
  }

  /** 事件先落盘再扇出。返回全局递增 seq（=Last-Event-Id 续传游标）。
   *  性能：常开 fd 追加（去掉逐事件 statSync/open）、序列化只做一次；
   *  message.delta/reasoning 按 ~16ms 合批扇出，非 delta 事件冲刷后即刻发出。 */
  function emitEvent(run, kind, payload) {
    run.seq += 1;
    const ev = { seq: run.seq, kind, payload, at: Date.now() };
    run.buffer.push(ev);
    // buffer 裁剪：只保留 > 已同步游标的事件 + 上限（syncTurnToSession 只吃未同步段）
    if (run.buffer.length > MAX_RUN_BUFFER) {
      const seen = run.syncedSeq ?? 0;
      while (run.buffer.length > MAX_RUN_BUFFER && run.buffer[0] && run.buffer[0].seq <= seen) run.buffer.shift();
      if (run.buffer.length > MAX_RUN_BUFFER) run.buffer.splice(0, run.buffer.length - MAX_RUN_BUFFER);
    }
    // 落盘：常开 fd + 内存 size 计数，去掉逐事件 statSync/open；单次序列化复用给 SSE
    const data = JSON.stringify(ev);
    try {
      if (run.logFd == null) {
        mkdirSync(runsDir, { recursive: true });
        const p = runLogPath(run.id);
        run.logFd = openSync(p, 'a');
        const st = statSync(p, { throwIfNoEntry: false });
        run.logSize = st?.size ?? 0;
      }
      const bytes = Buffer.byteLength(data) + 1; // +1 = '\n'
      if (run.logSize + bytes <= RUN_LOG_MAX_BYTES) {
        writeSync(run.logFd, `${data}\n`);
        run.logSize += bytes;
      }
    } catch { /* 日志失败不阻断执行 */ }
    // 扇出：delta/reasoning/args.delta 合批（高频率增量类），其余先冲刷再发（保序）
    const frame = `id: ${ev.seq}\nevent: agent\ndata: ${data}\n\n`;
    if (kind === 'message.delta' || kind === 'message.reasoning' || kind === 'tool.args.delta') {
      (run.pendingFrames ??= []).push(frame);
      if (!run.frameTimer) run.frameTimer = setTimeout(() => flushFrames(run), DELTA_FLUSH_MS);
    } else {
      flushFrames(run);
      for (const res of [...run.subs]) writeFrame(res, frame);
    }
    return ev;
  }

  /** 续传重放：活跃 run 直接从内存 buffer 取（去掉整文件 read+parse）；buffer 已被裁到边界时回退磁盘。 */
  function eventsForReplay(run, fromSeq) {
    const buf = run.buffer;
    if (buf.length > 0 && buf[0].seq <= fromSeq + 1) return buf.filter((e) => e.seq > fromSeq);
    return readRunEvents(run.id, fromSeq);
  }

  /** 读取 run 事件日志（重放回退）；fromSeq 之后的返回。
   *  增量读：行首即 `"seq":N`（emitEvent 序列化顺序固定），先用前缀轻解析跳过
   *  已覆盖行——避免大日志重连时对每一行做完整 JSON.parse（O(N) parse → 只解析尾部）。 */
  function readRunEvents(runId, fromSeq = 0) {
    const file = runLogPath(runId);
    if (!existsSync(file)) return [];
    const out = [];
    try {
      const text = readFileSync(file, 'utf8');
      for (const line of text.split('\n')) {
        if (line.length < 12) continue;
        // 轻量前缀判定：{"seq":N  的 N 与 fromSeq 比较，无需 parse 整行
        const m = /^\{"seq":(\d+)/.exec(line);
        if (m && Number(m[1]) <= fromSeq) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.seq > fromSeq) out.push(ev);
        } catch { /* 跳过损坏行 */ }
      }
    } catch { /* 读失败返回空 */ }
    return out;
  }

  // ------------------------------------------------------------------
  // 引擎调用（服务端）：runner 零引擎知识，只按 engineId 查通用注册表调用适配器。
  // resolveModel / runTurn / complete / contextWindow 全在引擎插件的 server 半边。
  // ------------------------------------------------------------------
  const registry = options.registry;

  // 注册编排协议工具（仅 interactive：它依赖 run.interactives 挂起表，属编排层原语）。
  // 领域工具由各插件 server 半边自注册；重复注册由 registry fail-fast。
  if (registry) {
    registerOrchestrationTools(registry, { askInteractive });
  }

  function engineTurn(run, args) {
    // 参数增量转发（流式预览）：real-engine 逐帧回调 → tool.args.delta 事件扇出。
    // 合批与 message.delta 同队列（高频率），避免事件洪峰。
    return run.engine.runTurn({
      ...args,
      ...(run.engine.id === 'real' || !run.engine.id ? { onToolArgsDelta: (callId, delta) => emitEvent(run, 'tool.args.delta', { sessionId: run.sessionId, messageId: run.assistantId, callId, delta }) } : {}),
    });
  }

  // ------------------------------------------------------------------
  // 工具调用（服务端直连各工具 server 半边；loopback HTTP 沿用其门禁/审计）
  // ------------------------------------------------------------------
  function parseArgs(raw) {
    try {
      const p = JSON.parse(raw || '{}');
      return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
    } catch { return {}; }
  }

  function capText(text, cap = FEEDBACK_CAP) {
    if (text.length <= cap) return text;
    return `${text.slice(0, cap / 2)}\n…[输出过长已截断 ${text.length}B]…\n${text.slice(-cap / 2)}`;
  }

  /** 服务端直调工具端点（loopback）。带系统 Bearer + approved 标记；
   *  agent-bash 的 mode/denylist/审计裁决原样生效（我们不绕过）。
   *  端口：宿主进程自身监听口（PORT env，prod-server 直跑时设置；缺省 5000=开发档）。 */
  const selfPort = Number(process.env.PORT ?? 5000);

  async function callToolEndpoint(path, body, signal) {
    const headers = { 'Content-Type': 'application/json' };
    const token = ensureSystemToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const resp = await fetch(`http://127.0.0.1:${selfPort}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
    const text = await resp.text().catch(() => '');
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
    return { status: resp.status, ok: resp.ok, json };
  }

  /** 服务端生命周期钩子（原 agent-loop 的 onSessionStart/PreToolUse/PostToolUse/onTurnEnd）。
   *  走 hook-bridge 的 /api/hooks/*，系统 Bearer 与工具同通道；钩子失败不影响编排。 */
  function fireHook(endpoint, body) {
    void callToolEndpoint(`/api/hooks/${endpoint}`, body).catch(() => undefined);
  }

  /** files 只读（GET /api/fs/list|read|roots） */
  async function fsGet(path, signal) {
    const headers = {};
    const token = ensureSystemToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const resp = await fetch(`http://127.0.0.1:${selfPort}${path}`, { headers, signal });
    const json = await resp.json().catch(() => null);
    return { status: resp.status, ok: resp.ok, json };
  }

  // ------------------------------------------------------------------
  // kv 访问：经 service 表取 kv-store 注册的实现（不自己开 sqlite、不复制表结构）。
  // ledger 适配器复用这些 helper；ledger-core.cjs 仍是计算单一权威。
  // ------------------------------------------------------------------
  const kvService = () => options.registry?.getService?.('kv-store') ?? null;

  function readKvSync(ns, key) {
    try { return kvService()?.get(ns, key) ?? null; } catch { return null; }
  }
  function writeKvSync(ns, key, value) {
    try { kvService()?.set(ns, key, value); } catch { /* 写失败按业务错误返回 */ }
  }
  /** 返回匹配前缀的 key（去掉 `ns.` 前缀），供 ledger 适配器枚举账目。 */
  function kvKeys(ns, prefix) {
    try { return kvService()?.keysWithPrefix(ns, prefix) ?? []; } catch { return []; }
  }

  /**
   * 执行单个工具调用：按工具名查通用注册表（适配器由工具插件注册），runner 零工具知识。
   * 返回 { ok, stdout, stderr, exitCode, durationMs, truncated, denied }。
   */
  async function execTool(run, call, signal) {
    const name = call.name;
    const args = parseArgs(call.arguments);
    const adapter = registry?.getTool?.(name);
    if (!adapter) return { ok: false, stdout: '', stderr: `工具 ${name} 未注册` };
    try {
      return await adapter.invoke({
        name, args, run, call, signal,
        capText,
        // 平台能力注入：领域工具在各自插件里，但 loopback 调用/事件/交互/kv 由 runner
        // 在调用期提供（工具插件不认识宿主内部实现）。与前端 SlotHostApi 同一原则。
        host: {
          callEndpoint: callToolEndpoint,
          get: fsGet,
          emit: emitEvent,
          interactive: askInteractive,
          kv: { get: readKvSync, set: writeKvSync, keys: kvKeys },
        },
      });
    } catch (err) {
      if (signal?.aborted) throw new Error('INTERRUPTED');
      return { ok: false, stdout: '', stderr: err instanceof Error ? err.message : String(err) };
    }
  }


  // ------------------------------------------------------------------
  // 审批（服务端挂起；任意在线设备回填，先到先得；120s 超时自动拒绝）
  // ------------------------------------------------------------------
  function askApproval(run, call, command) {
    return new Promise((resolveDecision) => {
      const callId = call.id;
      const timer = setTimeout(() => {
        if (run.approvals.has(callId)) {
          run.approvals.delete(callId);
          emitEvent(run, 'tool.approval.resolved', { sessionId: run.sessionId, messageId: run.assistantId, callId, decision: 'deny', autoRejected: true });
          resolveDecision('timeout');
        }
      }, APPROVAL_TIMEOUT_MS);
      run.approvals.set(callId, {
        resolve: (decision) => {
          clearTimeout(timer);
          resolveDecision(decision);
        },
        call,
        command,
      });
      emitEvent(run, 'tool.approval.required', { sessionId: run.sessionId, messageId: run.assistantId, callId, name: call.name, command, argsJson: call.arguments });
    });
  }

  function askInteractive(run, call, args, signal) {
    return new Promise((resolveAnswer) => {
      const callId = call.id;
      const timer = setTimeout(() => {
        if (run.interactives.has(callId)) {
          run.interactives.delete(callId);
          resolveAnswer(JSON.stringify({ __timeout: true }));
        }
      }, APPROVAL_TIMEOUT_MS);
      run.interactives.set(callId, {
        resolve: (answer) => { clearTimeout(timer); resolveAnswer(answer); },
      });
      emitEvent(run, 'interactive.required', { sessionId: run.sessionId, messageId: run.assistantId, callId, kind: args.kind ?? 'question', title: args.title ?? '', options: args.options ?? [], fields: args.fields ?? [] });
      if (signal?.aborted) resolveAnswer(JSON.stringify({ __timeout: true }));
    });
  }

  // ------------------------------------------------------------------
  // 上下文压缩（服务端版；对齐前端 agent-loop §5.2 语义）
  // ------------------------------------------------------------------

  /** 窗口解析：优先 start payload 显式窗口 → 引擎适配器 contextWindow → 默认 */
  function resolveCtxWindow(run) {
    if (run.ctxWindow > 0) return run.ctxWindow;
    const win = Number(run.engine?.contextWindow?.(run.model) ?? 0);
    if (Number.isFinite(win) && win > 0) { run.ctxWindow = win; return win; }
    run.ctxWindow = 200_000;
    return 200_000;
  }

  /** 非流式补全（压缩摘要专用）：委托引擎适配器 complete，runner 不认识上游协议。 */
  function compactComplete(run, req) {
    return run.engine.complete({ model: run.model, ...req });
  }

  /**
   * 每轮引擎调用前触发压缩（对齐前端 agent-loop）：
   * 水位（真实 usage 优先，字符估算兜底）达阈值 + 未熔断 + 未在压 → compactShadow。
   * 非破坏：失败回滚原 shadow，任务继续（context.compact-failed 事件可见）。
   */
  async function maybeCompact(run) {
    const { sessionId, assistantId } = run;
    const policy = run.ctxPolicy;
    if (!policy.autoCompact || run.compacting || run.acc.exhausted) return;
    const window = resolveCtxWindow(run);
    if (!run.acc.shouldCompact(window, policy.threshold, run.shadow)) return;
    run.compacting = true;
    emitEvent(run, 'context.compacting', {
      sessionId, messageId: assistantId,
      estimatedTokens: run.acc.lastInput > 0 ? run.acc.lastInput : estimateTokens(run.shadow),
      window,
    });
    try {
      const outcome = await compactShadow(run.shadow, window, policy.keepRecent, (req) => compactComplete(run, req));
      if (outcome.ok) {
        run.acc.resetLast();
        emitEvent(run, 'context.compacted', {
          sessionId, messageId: assistantId,
          summary: outcome.summary, removedMessages: outcome.removedMessages,
          tokensBefore: outcome.tokensBefore, tokensAfter: outcome.tokensAfter, at: Date.now(),
        });
      } else if (outcome.error !== 'range-too-small') {
        emitEvent(run, 'context.compact-failed', { sessionId, messageId: assistantId, reason: outcome.error ?? 'unknown' });
      }
      // range-too-small：静默跳过（下一轮消息增多后区间可选再压），不打扰 UI
    } catch (err) {
      emitEvent(run, 'context.compact-failed', { sessionId, messageId: assistantId, reason: String(err?.message ?? err).slice(0, 200) });
    } finally {
      run.compacting = false;
    }
  }

  /** usage 采集：engineTurn 返回的真实 usage 优先（流末帧），否则按 shadow 估算 */
  function noteUsage(run, wireUsage) {
    const input = Number(wireUsage?.prompt_tokens ?? 0);
    if (input > 0) run.acc.add(input);
    else run.acc.add(estimateTokens(run.shadow));
    // 压缩后冷却期结束判断：刚压缩完又立刻超阈 → 熔断（对齐 notePostCompactRound）
    const window = resolveCtxWindow(run);
    run.acc.notePostCompactRound(run.acc.lastInput >= window * run.ctxPolicy.threshold);
  }

  // ------------------------------------------------------------------
  // 编排主循环（前端 agent-loop 的服务端移植；事件形状保持一致）
  // ------------------------------------------------------------------
  async function runLoop(run) {
    // 「执行中」徽标（2026-11-27）：run 进入主循环即向 chat-store 上报 start，
    // finishRun 时 done。经 adapter-registry 的 chat-loop-state service 同进程直调
    // （写消息的 mergeMessages 同一通道），SSE 扇出让全设备侧栏徽标即时亮/灭。
    reportLoopState(run, 'start');
    const { sessionId, assistantId } = run;
    const signal = run.controller.signal;
    let turn = 0; // try 块外声明：catch/finally 的 syncTurnToSession 也要引用
    try {
      fireHook('session-start', { sessionId });
      // 工具表：start 时已装配 run.toolDefs（静态表 + MCP 聚合补入）；此处兜底重建
      const toolDefs = run.toolDefs?.length ? run.toolDefs : buildServerToolDefs(run);
      let totalToolCalls = 0;
      const toolFailStreak = new Map();
      let toolOnlyStreak = 0;
      let autoContinueLeft = 3;
      // agent 型引擎（CLI 自持工具循环）在 runTurn 内部就执行完工具：工具卡只能由
      // 引擎帧驱动实时落位——等 turn 收敛再统一发，整轮的工具卡就全堆到正文之后了
      // （实测现象：CodeBuddy 一轮里 26 次调用全排在回复末尾）。这两张表记下已实时
      // 流出的 callId，runner 自己的回放段据此去重，保证每个调用只发一次卡/结果。
      const streamedCards = new Set();
      const streamedResults = new Set();
      // 本 run 已派发（真实执行）过的调用签名（name+arguments）——重复调用护栏的去重源
      const dispatchedCalls = new Set();
      const onToolCall = (c) => {
        if (!c?.id) return;
        streamedCards.add(c.id);
        emitEvent(run, 'tool.card', {
          sessionId, messageId: assistantId, callId: c.id, name: c.name || 'tool',
          command: summarizeCall({ name: c.name || 'tool', arguments: c.arguments ?? '{}' }),
          argsJson: c.arguments,
        });
      };
      const onToolResult = (r) => {
        if (!r?.id) return;
        streamedResults.add(r.id);
        emitEvent(run, 'tool.result', {
          sessionId, messageId: assistantId, callId: r.id,
          status: r.success === false ? 'error' : 'done',
          stdout: capText(String(r.result ?? '')),
        });
      };
      for (; !signal.aborted; turn += 1) {
        run.turnStartedAt = Date.now();
        // 触发压缩（先压再请求；水位达阈值 + 未熔断；失败非破坏回滚）
        await maybeCompact(run);
        if (signal.aborted) { emitEvent(run, 'message.done', { sessionId, messageId: assistantId, interrupted: true }); return; }
        if (turn >= MAX_LOOP_TURNS || totalToolCalls >= MAX_TOOL_CALLS) {
          run.shadow.push({
            role: 'user',
            content: `（系统：本轮任务已连续运行 ${turn} 轮、${totalToolCalls} 次工具调用，达到安全上限。` +
              '请立即停止继续调用工具，基于已获得的信息给出当前结论与后续建议；若任务确实未完成，请明确说明剩余步骤，由用户决定是否继续。）',
          });
          const r = await engineTurn(run, { messages: run.shadow, tools: [], signal });
          run.shadow.push({ role: 'assistant', content: r.text });
          emitEvent(run, 'message.delta', { sessionId, messageId: assistantId, delta: r.text });
          emitEvent(run, 'message.done', { sessionId, messageId: assistantId, finishReason: 'stop' });
          emitEvent(run, 'loop.done', { sessionId, messageId: assistantId, turns: turn, guardLimit: true });
          syncTurnToSession(run, turn);
          return;
        }
        const result = await engineTurn(run, {
          messages: run.shadow,
          tools: toolDefs,
          signal,
          onDelta: (delta) => emitEvent(run, 'message.delta', { sessionId, messageId: assistantId, delta }),
          onReasoning: (delta) => emitEvent(run, 'message.reasoning', { sessionId, messageId: assistantId, delta }),
          onRetry: (attempt, maxAttempts) => emitEvent(run, 'stream.retry', { sessionId, messageId: assistantId, attempt, maxAttempts }),
          onToolCall,
          onToolResult,
        });
        if (signal.aborted) { emitEvent(run, 'message.done', { sessionId, messageId: assistantId, interrupted: true }); syncTurnToSession(run, turn); return; }
        // 本轮 AI 产出落服务端会话档（幂等增量）：发起端被杀也留痕
        syncTurnToSession(run, turn);
        // usage 采集：压缩触发基准（真实 usage 优先，估算兜底）
        noteUsage(run, result.usage);
        // ai.usage 事件（spec §4.1）：ContextMeter/速率展示的数据源——与 real-engine
        // 同款 buildUsagePayload（缓存字段提取链对齐 simple_ai）。
        emitEvent(run, 'ai.usage', buildUsagePayload({
          sessionId, messageId: assistantId,
          messages: run.shadow,
          wireUsage: result.usage ?? null,
          model: run.model?.activeModel,
          maxInputTokens: resolveCtxWindow(run),
          startedAt: run.turnStartedAt ?? Date.now(),
        }));
        // 上下文水位快照：ContextMeter 数据源（真实 usage 优先，字符估算兜底；spec §5.2）
        {
          const window = resolveCtxWindow(run);
          const used = run.acc.lastInput > 0 ? run.acc.lastInput : estimateTokens(run.shadow);
          emitEvent(run, 'context.snapshot', {
            sessionId, messageId: assistantId,
            usedTokens: used,
            window,
            percent: window > 0 ? Math.min(1, used / window) : 0,
            messages: run.shadow.length,
            compacted: run.acc.roundsSinceCompact !== null,
            exhausted: run.acc.exhausted,
          });
        }

        // 无工具调用：正文收敛
        if (result.finishReason !== 'tool_calls' || result.toolCalls.length === 0) {
          toolOnlyStreak = 0;
          run.shadow.push({ role: 'assistant', content: result.text });
          if (result.finishReason === 'length') {
            const reason = result.partialToolCalls > 0 ? 'tool-truncated' : (result.text.trim() ? 'text-truncated' : 'reasoning-exhausted');
            if (autoContinueLeft > 0) {
              autoContinueLeft -= 1;
              emitEvent(run, 'message.continued', { sessionId, messageId: assistantId, attempt: 3 - autoContinueLeft, max: 3, reason });
              if (reason === 'tool-truncated') {
                run.shadow.push({ role: 'user', content: `（系统：上一条响应在生成 ${result.partialToolCalls} 个工具调用时被单次输出上限截断，未执行。请重新调用所需工具；参数过长时请精简内容或分多次调用。）` });
              } else if (reason === 'reasoning-exhausted') {
                run.shadow.push({ role: 'user', content: '（系统：上一条响应把单次输出预算耗在思考上，没有产出正文。请直接给出结论，减少铺垫与重复论证。）' });
              }
              continue;
            }
            emitEvent(run, 'message.truncated', { sessionId, messageId: assistantId, reason: 'length', text: '回复因达到单次输出上限（max_tokens）被截断。发送「继续」可接续。' });
          }
          break;
        }

        // ---- 重复调用护栏（2026-11-27，针对 9826 实测「答案已收敛仍追加冗余工具调用」）----
        // 场景：模型同一条响应里既输出了完整正文、又附带了与本 run 已派发过的调用
        // 完全相同（名字+参数逐字一致）的 tool_calls（finish_reason=tool_calls）。
        // 旧逻辑只看 tool_calls 存在与否 → 执行冗余调用 → 进下一轮 → 模型再次
        // 「保险起见重跑一遍」→ 空转循环。收敛判据（两条同时满足才跳过）：
        //   1) 本轮全部调用都与已派发过的调用重复（有新调用则照常执行——
        //      「先说一句进度再继续」的合法 text+tool 模式不受影响）；
        //   2) 正文非空（把正文视为收敛信号；正文为空时不视为收敛，但也不再
        //      原样执行重复调用——以工具结果形式回一条 nudge，逼下一轮产出正文）。
        const callKey = (c) => `${c.name}::${String(c.arguments ?? '')}`;
        const allRepeat = result.toolCalls.length > 0
          && result.toolCalls.every((c) => dispatchedCalls.has(callKey(c)));
        if (allRepeat) {
          const hasText = result.text.trim().length > 0;
          for (const call of result.toolCalls) {
            const callId = call.id || `call-${turn}-${totalToolCalls + 1}`;
            const display = summarizeCall(call);
            // assistant.tool_calls 已入 shadow（协议成对）：跳过的调用也要回一条
            // tool 结果（不同正文，避免与上一条混淆协议），并落一张「已跳过」卡。
            const skipNote = hasText
              ? '[runner 护栏：该调用与本 run 之前派发的调用完全重复，已跳过执行（本轮正文已含结论，视为收敛）。]'
              : '[runner 护栏：该调用与本 run 之前派发的调用完全重复，已跳过执行。请勿原样重试；若任务未完成，请换参数/换工具或直接给出正文结论。]';
            if (!streamedResults.has(callId)) emitEvent(run, 'tool.result', { sessionId, messageId: assistantId, callId, status: 'skipped', command: display, stdout: capText(skipNote) });
            run.shadow.push({ role: 'tool', content: skipNote, tool_call_id: call.id, name: call.name });
          }
          if (hasText) {
            toolOnlyStreak = 0;
            run.shadow.push({ role: 'assistant', content: result.text });
            break;
          }
          continue; // 空正文 + 全重复：不发正文（无 delta），直接下一轮（nudge 在 shadow 里）
        }
        for (const c of result.toolCalls) dispatchedCalls.add(callKey(c));

        // assistant.tool_calls 入 shadow（协议成对）
        run.shadow.push({
          role: 'assistant',
          content: result.text,
          tool_calls: result.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
        });

        // 逐个执行：审批 → 工具直调 → 结果卡 + shadow
        // 性能（P2）：无依赖工具并行执行。分两类处理：
        //  - 「已执行」（agent 型引擎带回 result）与 noApproval 工具：互不依赖，
        //    Promise.all 并行跑，多工具延迟从累加变取最大；
        //  - 需审批的工具：逐个挂起（审批语义要求按序裁决），通过后立即执行。
        // 事件与 shadow 仍按 tool_calls 原始顺序落（收集后按序回放），协议成对不变。
        const prepared = result.toolCalls.map((call, i) => {
          totalToolCalls += 1;
          const callId = call.id || `call-${turn}-${totalToolCalls}`;
          const display = summarizeCall(call);
          // 引擎已在 turn 内实时发过这张卡（agent 型 CLI）：不再重复发，位置也保持
          // 引擎帧里的真实顺序。runner 自己执行的引擎（real-engine）没发过，照旧发。
          if (!streamedCards.has(callId)) {
            emitEvent(run, 'tool.card', { sessionId, messageId: assistantId, callId, name: call.name, command: display, argsJson: call.arguments });
          }
          const adapter = registry?.getTool?.(call.name);
          return {
            idx: i, call, callId, display, adapter,
            preExecuted: call.result !== undefined,
            freePass: call.result !== undefined || !!adapter?.noApproval,
          };
        });

        // 并行段：已执行 + 免审批工具同时跑（各事件先收集，回放段按序落）
        const parallel = prepared.filter((p) => p.freePass);
        const parallelResults = await Promise.all(parallel.map(async (p) => {
          const { call, callId, display } = p;
          if (p.preExecuted) {
            const okExec = call.success !== false;
            return {
              idx: p.idx, ok: okExec, denied: false, exitCode: undefined, durationMs: undefined,
              resultEvent: { sessionId, messageId: assistantId, callId, status: okExec ? 'done' : 'error', command: display, stdout: capText(String(call.result ?? '')) },
              feedback: okExec
                ? `[${call.name} 执行完成]\nSTDOUT:\n${capText(String(call.result ?? '') || '(空)')}`
                : `[工具执行失败] ${capText(String(call.result ?? ''))}`,
              hookInput: parseArgs(call.arguments), hookFire: false,
            };
          }
          const toolInput = parseArgs(call.arguments);
          fireHook('pre-tool-use', { sessionId, toolName: call.name, toolInput });
          const r = await execTool(run, call, signal);
          return {
            idx: p.idx, ok: r.ok, denied: !!r.denied, exitCode: r.exitCode, durationMs: r.durationMs,
            resultEvent: { sessionId, messageId: assistantId, callId, status: r.ok ? 'done' : 'error', command: display, stdout: r.stdout, stderr: r.stderr },
            feedback: r.ok ? r.stdout : `[工具失败] ${r.stderr}`,
            hookInput: toolInput, hookFire: true,
          };
        }));
        for (const pr of parallelResults) {
          const { call, callId } = prepared[pr.idx];
          if (pr.hookFire) fireHook('post-tool-use', { sessionId, toolName: call.name, toolInput: pr.hookInput, success: pr.ok });
          if (!streamedResults.has(pr.resultEvent.callId)) emitEvent(run, 'tool.result', pr.resultEvent);
          run.shadow.push({ role: 'tool', content: pr.feedback, tool_call_id: call.id, name: call.name });
        }
        if (signal.aborted) { emitEvent(run, 'message.done', { sessionId, messageId: assistantId, interrupted: true }); return; }

        // 串行段：需审批的工具逐个挂起（先到先得；shadow 按调用顺序续接并行段之后）
        for (const p of prepared.filter((x) => !x.freePass)) {
          const { call, callId, display } = p;
          const toolInput = parseArgs(call.arguments);
          fireHook('pre-tool-use', { sessionId, toolName: call.name, toolInput });
          // 审批：confirm/allowlist 模式由服务端挂起；yolo 直接放行（与 agent-bash 裁决一致）。
          // 会话级白名单：always=按 approvalKey 前缀；trust=按工具名（run 内内存态）。
          const mode = readToolMode();
          const approvalKey = approvalKeyOf(call);
          const allowlisted = mode.allowPrefixes.some((pre) => approvalKey === pre || approvalKey.startsWith(`${pre} `))
            || (run.sessionAllow?.has(approvalKey) ?? false)
            || (run.sessionAllow?.has(`tool:${call.name}`) ?? false);
          const needApproval = (mode.mode === 'confirm' || (mode.mode === 'allowlist' && !allowlisted)) && !allowlisted;
          let verdict = 'ok';
          if (needApproval) verdict = await askApproval(run, call, display);
          if (signal.aborted) { emitEvent(run, 'message.done', { sessionId, messageId: assistantId, interrupted: true }); return; }
          // 审批决策映射（对齐前端 decideApproval）：once=放行一次；always/trust=
          // 沉淀会话级白名单（后续同前缀/同工具免审批）；deny/timeout=拒绝。
          if (verdict === 'always' || verdict === 'trust') {
            const set = run.sessionAllow ?? (run.sessionAllow = new Set());
            set.add(verdict === 'always' ? approvalKey : `tool:${call.name}`);
          }
          const approved = verdict === 'ok' || verdict === 'once' || verdict === 'always' || verdict === 'trust';
          if (!approved) {
            emitEvent(run, 'tool.result', { sessionId, messageId: assistantId, callId, status: 'denied', command: display });
            const feedback = verdict === 'timeout'
              ? `[无人值守：该工具调用等待 ${APPROVAL_TIMEOUT_MS / 1000}s 无用户审批，已自动拒绝（并非用户否决本次操作）。请改用不需要危险权限的安全方式继续当前任务。不要停下等待用户回复，也不要原样重试同一被拒命令。]`
              : '[工具被用户拒绝执行。请尊重用户决定，改用其他方式或直接回答。]';
            run.shadow.push({ role: 'tool', content: feedback, tool_call_id: call.id, name: call.name });
            continue;
          }

          const r = await execTool(run, call, signal);
          fireHook('post-tool-use', { sessionId, toolName: call.name, toolInput, success: r.ok && (r.exitCode === undefined || r.exitCode === 0) });
          if (signal.aborted) { emitEvent(run, 'message.done', { sessionId, messageId: assistantId, interrupted: true }); return; }
          const status = r.ok && (r.exitCode === undefined || r.exitCode === 0) ? 'done' : r.denied ? 'denied' : 'error';
          emitEvent(run, 'tool.result', {
            sessionId, messageId: assistantId, callId, status,
            command: display,
            stdout: capText(String(r.stdout ?? '')),
            stderr: capText(String(r.stderr ?? '')),
            exitCode: r.exitCode, durationMs: r.durationMs, truncated: r.truncated,
          });
          const okExec = r.ok && (r.exitCode === undefined || r.exitCode === 0);
          if (okExec) toolFailStreak.delete(call.name);
          else toolFailStreak.set(call.name, (toolFailStreak.get(call.name) ?? 0) + 1);
          const failN = toolFailStreak.get(call.name) ?? 0;
          const feedback = okExec
            ? `[${call.name} 执行完成${r.exitCode !== undefined ? ` exit=${r.exitCode}` : ''}${r.durationMs ? ` ${r.durationMs}ms` : ''}]\nSTDOUT:\n${capText(String(r.stdout ?? '') || '(空)')}\nSTDERR:\n${capText(String(r.stderr ?? '') || '(空)')}`
            : `[工具执行失败] ${r.stderr || r.stdout || 'unknown'}\nSTDERR:\n${capText(String(r.stderr ?? ''))}`;
          run.shadow.push({ role: 'tool', content: feedback, tool_call_id: call.id, name: call.name });
          if (!okExec && failN >= 4 && failN % 4 === 0) {
            run.shadow.push({
              role: 'user',
              content: `（系统：工具 ${call.name} 已连续失败 ${failN} 次。请停止重复同一调用，先分析失败原因（参数？权限？环境？），换一种实现路径，或直接向用户说明障碍与已验证的结论。）`,
            });
          }
        }
        toolOnlyStreak += 1;
        if (toolOnlyStreak > 0 && toolOnlyStreak % 12 === 0) {
          run.shadow.push({
            role: 'user',
            content: `（系统：你已经连续 ${toolOnlyStreak} 轮只调用工具、没有任何正文输出。如果任务已完成，请立即直接向用户报告结果并停止调用工具；如果确实还需要继续，请先用一句话说明当前进度再继续。不要用重复的 ping/echo 等空转调用保活。）`,
          });
          emitEvent(run, 'message.continued', { sessionId, messageId: assistantId, attempt: Math.floor(toolOnlyStreak / 12), max: 0, reason: 'tool-streak-nudge' });
        }
      }
      emitEvent(run, 'loop.done', { sessionId, messageId: assistantId, turns: turn });
      emitEvent(run, 'message.done', { sessionId, messageId: assistantId, finishReason: 'stop' });
      syncTurnToSession(run, turn);
    } catch (err) {
      if (signal.aborted) {
        emitEvent(run, 'message.done', { sessionId, messageId: assistantId, interrupted: true });
      } else {
        emitEvent(run, 'stream.error', { sessionId, messageId: assistantId, message: err instanceof Error ? err.message : String(err) });
      }
      syncTurnToSession(run, turn);
    } finally {
      finishRun(run);
    }
  }

  function finishRun(run) {
    if (run.finished) return;
    run.finished = true;
    run.phase = 'done';
    reportLoopState(run, 'done'); // 「执行中」徽标摘除（在 finished 置位后，不进 catch 路径）
    fireHook('turn-end', { sessionId: run.sessionId });
    run.controller.abort(); // 兜底：中断残余上游流
    for (const [, a] of run.approvals) a.resolve?.('deny');
    run.approvals.clear();
    for (const [, i] of run.interactives) i.resolve?.(JSON.stringify({ __timeout: true }));
    run.interactives.clear();
    // 续写快照：保留 shadow + 引擎/模型/策略，供「继续」按钮在服务端接续（不重放旧轮次）
    if (run.shadow?.length) {
      const key = `${run.sessionId}::${run.assistantId}`;
      resumableRuns.delete(key);
      resumableRuns.set(key, {
        shadow: run.shadow, engine: run.engine, engineId: run.engineId, model: run.model,
        ctxWindow: run.ctxWindow, ctxPolicy: run.ctxPolicy, acc: run.acc,
        extraToolDefs: run.extraToolDefs, shellHint: run.shellHint,
        boundRootId: run.boundRootId, execCwd: run.execCwd, device: run.device,
      });
      while (resumableRuns.size > MAX_RESUMABLE_RUNS) {
        const oldest = resumableRuns.keys().next().value;
        if (oldest === undefined) break;
        resumableRuns.delete(oldest);
      }
    }
    runsBySession.delete(run.sessionId);
    runs.delete(run.id); // runs 表同步回收（否则并发上限被历史 run 占满 → TOO_MANY_RUNS）
    // 冲刷残余 delta 合批 + 关闭常开 fd（防止 fd 泄漏；事件日志已落盘供续传）
    flushFrames(run);
    if (run.logFd != null) { try { closeSync(run.logFd); } catch { /* */ } run.logFd = null; }
    audit({ op: 'run-done', runId: run.id, sessionId: run.sessionId, seq: run.seq });
    // 最终事件已全部落盘；SSE 订阅者发一帧 done-note 后由前端自行关闭
    for (const res of [...run.subs]) {
      try { res.write(`event: run-ended\ndata: ${JSON.stringify({ runId: run.id, sessionId: run.sessionId })}\n\n`); } catch { /* */ }
    }
    run.subs.clear();
    scheduleGc();
  }

  // ------------------------------------------------------------------
  // 服务端工具表（静态装配；与前端 describe 协议同形状）
  // ------------------------------------------------------------------
  /** 工具表：从通用注册表读所有已注册工具的 descriptor（runner 零工具知识）。
   *  MCP 动态工具由 ensureMcpTools 异步补入。 */
  function buildServerToolDefs(run) {
    const defs = registry?.listTools?.().map((t) => t.descriptor).filter(Boolean) ?? [];
    return defs;
  }


  /** start 时异步补入 MCP 聚合工具描述（有 server 配置才注入） */
  async function ensureMcpTools(run) {
    try {
      const r = await fsGet('/api/mcp/tools', run.controller.signal);
      const tools = Array.isArray(r.json?.tools) ? r.json.tools : [];
      for (const t of tools) {
        if (!t?.name) continue;
        run.extraToolDefs.push({
          type: 'function',
          function: { name: String(t.name), description: String(t.description ?? 'MCP tool'), parameters: t.parameters ?? { type: 'object', properties: {} } },
        });
      }
    } catch { /* MCP 不可用：无 MCP 工具继续 */ }
  }

  /**
   * 工作区解析（对齐前端 agent-loop 语义）：
   * - payload.workspaceId 命中已登记根 → bash cwd=该根路径，files 默认根跟随；
   * - 绑定失效 → 回落内建 workspace 并在 system prompt 说明；
   * - 未绑定 → 回落内建 workspace；
   * - 关联只读目录（linkedWorkspaceIds）进 system prompt 只读提示。
   * 同时解析 bash 语法提示（server config.shell）。
   */
  async function prepareWorkspace(run, body) {
    try {
      const rr = await fsGet('/api/fs/roots', run.controller.signal);
      const list = Array.isArray(rr.json?.roots) ? rr.json.roots : [];
      const boundId = String(body.workspaceId ?? '');
      const bound = boundId ? list.find((r) => r.id === boundId) : undefined;
      const builtin = list.find((r) => r.builtin);
      if (bound?.path) {
        run.boundRootId = bound.id;
        run.execCwd = bound.path;
        run.wsHint = `${bound.label ?? bound.id}（${bound.path}）`;
      } else {
        if (boundId) run.wsFallbackNote = `注意：会话绑定的工作区已失效（id=${boundId}），已回落默认工作区。`;
        if (builtin?.path) {
          run.boundRootId = builtin.id;
          run.execCwd = builtin.path;
          run.wsHint = builtin.path;
        }
      }
      // 只读可见范围：显式关联优先，否则其余已登记根（与前端 agent-loop 同口径）
      const linkedIds = Array.isArray(body.linkedWorkspaceIds) ? body.linkedWorkspaceIds.map(String) : [];
      const linkedSet = new Set(linkedIds);
      const readonly = linkedIds.length > 0
        ? list.filter((r) => linkedSet.has(r.id) && r.path !== run.execCwd)
        : list.filter((r) => !r.builtin && r.path !== run.execCwd);
      if (readonly.length > 0) {
        run.readonlyHint = linkedIds.length > 0
          ? ` 用户为本对话关联了这些只读目录（可浏览/读取，不可写、bash 不在其中执行）：${readonly.map((r) => `${r.label}（${r.path}）`).join('、')}。`
          : ` files 工具另可只读浏览这些已登记目录（bash 不可达、不可写入）：${readonly.map((r) => `${r.label}（${r.path}）`).join('、')}。`;
      }
    } catch { /* roots 不可用：保持默认（tool-exec 服务端仍会按白名单校验 cwd） */ }
    try {
      const cfg = readToolMode();
      run.shellHint = cfg.shell ?? undefined;
    } catch { /* 默认 bash 语法 */ }
  }

  /**
   * shadow 播种（对齐前端 agent-loop）：system（含 cwd/工具语义/日期）+ history
   * + skill 附录 + 时间提示 + prompt。skill 附录经 /api/skills/appendix（索引 +
   * AGENTS.md/CLAUDE.md 项目指令），不可用时静默跳过。
   */
  async function seedShadow(run, body, prompt) {
    const sysParts = [];
    sysParts.push(
      '你是 polaris-lite 工作台里的 AI 助手，可以使用 bash 工具与 files 工具（浏览/读取文件，只读）。',
    );
    sysParts.push(`当前日期时间：${new Date().toLocaleString('zh-CN', { hour12: false })}（宿主本地时区）。`);
    // 实例身份：同一台机器上跑着 5000/9825/9826 三个实例，数据目录各不相同。
    // 不写明的话 AI 只能靠端口猜测自己在哪里，容易把写入/查询指向别的实例。
    const instPort = String(process.env.PORT ?? '').trim();
    if (instPort) {
      const instRole = instPort === '5000' ? '开发' : instPort === '9825' ? '生产' : instPort === '9826' ? '钉住分析实例' : '未登记';
      sysParts.push(`当前实例：http://127.0.0.1:${instPort}（${instRole}），数据目录 ${dataDir}。`);
    }
    if (run.wsHint) sysParts.push(`bash 的 cwd 固定为：${run.wsHint}。`);
    if (run.wsFallbackNote) sysParts.push(run.wsFallbackNote);
    sysParts.push(
      '需要读写文件、跑脚本、查状态时优先用工具，不要凭空编造输出；' +
      '命令要一次做完一件事；输出很长时先自己截取关键部分再回答。' +
      'bash 的读写只能发生在 cwd 内；需要浏览或读取 cwd 之外的文件时，用 files 工具的 roots/list/read（只读）。' +
      'files_write 工具可写/编辑工作区文件（write/edit/patch 三个动作）。' +
      'interactive 工具可向用户发起结构化提问/表单/确认（question/form/confirm）；' +
      '当任务缺少用户的必要信息或需要用户拍板时，优先用 interactive 直接问，不要自行猜测用户偏好。' +
      'render 工具可生成自包含 HTML 交互面板（小游戏/原型/图表/教具），在对话卡片与「预览」面板中运行；' +
      'HTML 必须自包含：内联 CSS/JS、不引 CDN、不 fetch、模型与贴图用 base64；改动旧面板传 basePreviewId。' +
      'browser 工具可驱动系统 Chrome 搜索/阅读/操作网页（search 搜索、read 读正文、click/fill 交互、screenshot 截图）；' +
      '本会话的操作自动路由到本会话绑定的标签，不会影响其他会话打开的网页；优先用结构化动作而非 evaluate。' +
      (run.readonlyHint ?? ''),
    );
    sysParts.push(' 用 files 工具读文件时：path 传相对工作区根的相对路径；要读其它项目目录（如仓库根）的文件，先调 roots 拿到对应根的 id，再用该 rootId+相对路径，不要把绝对路径当 path 传。');
    // agent 型引擎（自带工具循环）的提示追加段由引擎适配器声明，runner 零引擎知识
    if (run.engine?.systemHint) sysParts.push(` ${run.engine.systemHint}`);
    // 用户自定义系统提示词（system-prompt 插件提供，经 service 表按 sessionId 取）：
    // 追加而非替换——内置段（实例身份/工具语义/环境纪律）必须保留在前，否则
    // 换工作区/多实例时 AI 失去环境感知。service 不存在（插件未装）时静默跳过。
    try {
      const spService = registry?.getService?.('system-prompt');
      const sp = spService?.get?.(run.sessionId);
      if (typeof sp === 'string' && sp.trim()) {
        sysParts.push(`\n\n以下是用户为本会话设定的自定义指令（优先级高于以上默认行为描述，但不得违反环境纪律）：\n${sp.trim()}`);
      }
    } catch { /* 提示词服务不可用：无注入继续 */ }
    // 长期记忆（long-memory 插件提供，经 service 表取全局注入段）：
    // 排在自定义指令之后（顺序：内置纪律 → 用户指令 → 记忆段）。开关关闭/无记忆
    // 时 service 返回 null，静默跳过——插件未装/禁用均无感知，与 system-prompt 同款。
    try {
      const lmService = registry?.getService?.('long-memory');
      const lm = lmService?.get?.();
      if (typeof lm === 'string' && lm.trim()) {
        sysParts.push(`\n\n${lm.trim()}`);
      }
    } catch { /* 记忆服务不可用：无注入继续 */ }
    const shadow = [{ role: 'system', content: sysParts.join('') }];
    // 多轮会话 shadow 延续：同会话上一 run 的 shadow 仍在（服务端常驻），优先续用——
    // 它包含完整工具调用过程（前端 history 只有可见文本，工具结果会丢）。
    // system prompt 每轮重建（日期/工作区可能变化），history 段从旧 shadow 尾部续。
    const prev = sessionShadows.get(run.sessionId);
    if (prev && Array.isArray(body.history) && body.history.length > 0) {
      // 以最后一条 user 消息为界：旧 shadow 中该消息之前的部分与前端可见历史对齐，
      // 直接整段续用（含 tool_calls/tool 结果），之后追加本条 prompt。
      shadow.push(...prev.slice(1));
    } else if (Array.isArray(body.history)) {
      for (const m of body.history) {
        shadow.push({ role: m.role, content: m.content });
      }
    }
    // skill 附录（技能索引 + 项目指令 AGENTS.md/CLAUDE.md）
    try {
      const r = await fsGet('/api/skills/appendix', run.controller.signal);
      const text = String(r.json?.text ?? '');
      if (text) shadow[0].content += '\n\n' + text;
    } catch { /* 附录不可用：无附录继续 */ }
    if (prompt) {
      shadow.push({ role: 'user', content: `（系统提示：当前日期时间 ${new Date().toLocaleString('zh-CN', { hour12: false })}，宿主本地时区。）` });
      shadow.push({ role: 'user', content: prompt });
    }
    run.shadow = shadow;
    // 留档供下一 run 延续（同会话 shadow 跨 run 不断档）；LRU 上限防常驻泄漏
    sessionShadows.delete(run.sessionId);
    sessionShadows.set(run.sessionId, shadow);
    while (sessionShadows.size > MAX_SESSION_SHADOWS) {
      const oldest = sessionShadows.keys().next().value;
      if (oldest === undefined) break;
      sessionShadows.delete(oldest);
    }
  }

  // ------------------------------------------------------------------
  // 工具模式（读 agent-bash 的 tool-exec.json；confirm/allowlist/yolo 裁决同源）
  // ------------------------------------------------------------------
  function readToolMode() {
    try {
      const file = resolve(dataDir, 'tool-exec.json');
      if (existsSync(file)) {
        const raw = JSON.parse(readFileSync(file, 'utf8'));
        const mode = ['confirm', 'allowlist', 'yolo'].includes(raw.mode) ? raw.mode : 'confirm';
        const allowPrefixes = Array.isArray(raw.allowPrefixes) ? raw.allowPrefixes.filter((p) => typeof p === 'string') : [];
        return { mode, allowPrefixes, enabled: raw.enabled !== false };
      }
    } catch { /* 回落默认 */ }
    return { mode: 'confirm', allowPrefixes: [], enabled: true };
  }

  /** 工具卡单行摘要 + 审批白名单键：复用 @shared 通用规则（按工具名+参数推导，零硬编码）。 */
  function summarizeCall(call) {
    return summarizeToolCall(call.name, call.arguments ?? '{}').display;
  }
  function approvalKeyOf(call) {
    return summarizeToolCall(call.name, call.arguments ?? '{}').approvalKey;
  }


  // ------------------------------------------------------------------
  // GC：过期 run 日志清理（懒触发）
  // ------------------------------------------------------------------
  let gcTimer = null;
  function scheduleGc() {
    if (gcTimer) return;
    gcTimer = setTimeout(() => {
      gcTimer = null;
      try {
        if (!existsSync(runsDir)) return;
        const now = Date.now();
        for (const name of readdirSync(runsDir)) {
          const file = join(runsDir, name);
          try {
            const st = statSync(file);
            if (now - st.mtimeMs > RUN_LOG_TTL_MS) rmSync(file);
          } catch { /* 忽略 */ }
        }
      } catch { /* GC 失败不影响业务 */ }
    }, 60_000);
    if (typeof gcTimer.unref === 'function') gcTimer.unref();
  }

  // ------------------------------------------------------------------
  // HTTP 端点
  // ------------------------------------------------------------------
  function send(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  async function readBody(req, limit = 8 * 1024 * 1024) {
    let b = '';
    for await (const c of req) {
      b += c;
      if (b.length > limit) throw new Error('payload too large');
    }
    return b;
  }

  return async function agentRunner(req, res, next) {
    const [pathname] = (req.url ?? '').split('?');
    if (!pathname.startsWith('/api/agent/')) return next?.();

    // 登录门禁
    const session = getSession?.(req);
    if (!session) return send(res, 401, { error: 'unauthorized', code: 'SESSION_REQUIRED' });
    if (hardOff) return send(res, 403, { error: 'agent runner disabled (PLITE_AGENT_RUNNER=0)', code: 'RUNNER_DISABLED' });

    // ---- POST /api/agent/start：发起/续跑编排 ----
    if (pathname === '/api/agent/start' && req.method === 'POST') {
      let body;
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(res, 400, { error: 'bad json', code: 'BAD_REQUEST' }); }
      const sessionId = String(body.sessionId ?? '');
      if (!ID_RE.test(sessionId)) return send(res, 400, { error: 'sessionId invalid', code: 'BAD_REQUEST' });
      const assistantId = String(body.messageId ?? `m-${Date.now().toString(36)}`);
      const prompt = String(body.prompt ?? '');
      // 同会话单飞：已有 run 直接返回（前端重复触发/多端同时发起都收敛到同一次执行）
      const existing = runsBySession.get(sessionId);
      if (existing && !existing.finished) {
        return send(res, 200, { ok: true, runId: existing.id, existing: true, phase: existing.phase });
      }
      if (runs.size >= MAX_CONCURRENT_RUNS) {
        return send(res, 429, { error: 'too many concurrent runs', code: 'TOO_MANY_RUNS' });
      }
      // 引擎按 engineId 从通用注册表查适配器；缺省走 manifest 标 default 的引擎。
      // runner 不认识任何具体引擎 id / 厂商——只调用适配器的 resolveModel/runTurn/complete。
      const engineId = String(body.engineId ?? '') || registry?.defaultEngineId?.() || '';
      const engine = engineId ? registry?.getEngine?.(engineId) : null;
      if (!engine) {
        return send(res, 400, { error: `AI 引擎 ${engineId || '(未指定)'} 未注册服务端适配器`, code: 'ENGINE_NOT_FOUND' });
      }
      // option 是「自带目录引擎」的模型选择（如 CLI 模型）——平台只搬运，引擎自行解释
      const model = engine.resolveModel?.({ providerId: body.providerId, modelId: body.modelId, option: body.option }) ?? null;
      const runId = `r-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
      const run = {
        id: runId,
        sessionId,
        assistantId,
        // 发起端设备名（「执行中」徽标 hover 展示「xx 发起 · 已执行 Ns」用）
        device: String(body.device ?? '编排服务端').slice(0, 40),
        phase: 'running',
        startedAt: Date.now(),
        seq: 0,
        buffer: [],
        syncedSeq: 0,
        logFd: null,
        logSize: 0,
        pendingFrames: [],
        frameTimer: null,
        subs: new Set(),
        approvals: new Map(),
        interactives: new Map(),
        controller: new AbortController(),
        shadow: [],
        finished: false,
        extraToolDefs: [],
        engine,
        engineId,
        model,
        execCwd: body.execCwd,
        boundRootId: body.rootId,
        shellHint: body.shellHint,
        // 上下文压缩状态（spec §5.2）：真实 usage 优先、字符估算兜底；会话级策略
        // autoCompact/threshold/keepRecent 由 start payload 透传（缺省对齐前端默认）。
        acc: new UsageAccumulator(),
        ctxWindow: 0,
        ctxPolicy: {
          autoCompact: body.ctxPolicy?.autoCompact !== false,
          threshold: Number(body.ctxPolicy?.threshold) || 0.75,
          keepRecent: Number(body.ctxPolicy?.keepRecent) || 6,
        },
        compacting: false,
      };
      if (!run.model) {
        return send(res, 400, { error: 'no usable model provider (missing key?)', code: 'NO_PROVIDER' });
      }
      runs.set(runId, run);
      runsBySession.set(sessionId, run);
      // 异步执行（不等完成；HTTP 立即返回 runId）。
      // 工作区解析 + system prompt + skill 附录都在异步段做（需要 await roots/appendix）。
      ensureMcpTools(run)
        .then(() => prepareWorkspace(run, body))
        .then(async () => {
          // agent 型引擎（kind:'agent'，自带工具循环）不注入宿主工具表——
          // 适配器的 systemHint 已声明工具语义，喂宿主工具定义只会诱导模型调用不存在的工具
          run.toolDefs = run.engine?.kind === 'agent' ? [] : [...buildServerToolDefs(run), ...run.extraToolDefs];
          await seedShadow(run, body, prompt);
          // 用户消息即刻落服务端会话档（幂等）：发起端随后被杀也不丢这条对话
          syncUserMessage(run, prompt, body?.createdAt);
          await runLoop(run);
        })
        .catch((e) => {
          audit({ op: 'run-fatal', runId, error: String(e?.message ?? e) });
          emitEvent(run, 'stream.error', { sessionId, messageId: assistantId, message: String(e?.message ?? e).slice(0, 300) });
          syncTurnToSession(run, 0); // 致命错误同样落档（否则刷新后只剩一条用户消息）
          finishRun(run);
        });
      return send(res, 200, { ok: true, runId, existing: false });
    }

    // ---- POST /api/agent/resume：截断「继续」——服务端接续上一 run 的 shadow ----
    if (pathname === '/api/agent/resume' && req.method === 'POST') {
      let body;
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(res, 400, { error: 'bad json', code: 'BAD_REQUEST' }); }
      const sessionId = String(body.sessionId ?? '');
      const assistantId = String(body.messageId ?? '');
      const snap = resumableRuns.get(`${sessionId}::${assistantId}`);
      if (!snap || !snap.engine) return send(res, 404, { error: '无可续写的 run（已过期或未完成）', code: 'RESUME_NOT_FOUND' });
      const existing = runsBySession.get(sessionId);
      if (existing && !existing.finished) return send(res, 200, { ok: true, runId: existing.id, existing: true });
      if (runs.size >= MAX_CONCURRENT_RUNS) return send(res, 429, { error: 'too many concurrent runs', code: 'TOO_MANY_RUNS' });
      resumableRuns.delete(`${sessionId}::${assistantId}`);
      const runId = `r-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
      const run = {
        id: runId, sessionId, assistantId, device: snap.device ?? '编排服务端', phase: 'running', startedAt: Date.now(),
        seq: 0, buffer: [], syncedSeq: 0, logFd: null, logSize: 0, pendingFrames: [], frameTimer: null,
        subs: new Set(), approvals: new Map(), interactives: new Map(), controller: new AbortController(),
        finished: false, extraToolDefs: snap.extraToolDefs ?? [], engine: snap.engine, engineId: snap.engineId,
        model: snap.model, execCwd: snap.execCwd, boundRootId: snap.boundRootId, shellHint: snap.shellHint,
        acc: snap.acc ?? new UsageAccumulator(), ctxWindow: snap.ctxWindow ?? 0, ctxPolicy: snap.ctxPolicy ?? { autoCompact: true, threshold: 0.75, keepRecent: 6 },
        shadow: [...snap.shadow], compacting: false,
      };
      // 半截 prefill：shadow 尾是 assistant 半截，续写时下方 runLoop 会自然接续；
      // 追加续写提示（对齐前端 resume 不带 prompt 的语义：直接续，不注入用户问句）。
      runs.set(runId, run);
      runsBySession.set(sessionId, run);
      void runLoop(run).catch((e) => {
        audit({ op: 'resume-fatal', runId, error: String(e?.message ?? e) });
        emitEvent(run, 'stream.error', { sessionId, messageId: assistantId, message: String(e?.message ?? e).slice(0, 300) });
        syncTurnToSession(run, 0);
        finishRun(run);
      });
      return send(res, 200, { ok: true, runId, existing: false });
    }

    // ---- GET /api/agent/events?sessionId=&runId=&lastEventId=：SSE 订阅 ----
    if (pathname === '/api/agent/events' && req.method === 'GET') {
      const url = new URL(req.url, 'http://x');
      const sessionId = url.searchParams.get('sessionId') ?? '';
      const runId = url.searchParams.get('runId') ?? '';
      // 原生 Last-Event-Id 头优先（EventSource 重连自动带），query 仅作兜底；
      // 服务端从当前 seq 决定续传点，不再由前端固化 query 游标导致全量重放。
      const headerSeq = Number(req.headers['last-event-id'] ?? 0) || 0;
      const querySeq = Number(url.searchParams.get('lastEventId') ?? 0) || 0;
      const lastEventId = Math.max(headerSeq, querySeq);
      const run = (runId && runs.get(runId)) || (sessionId && runsBySession.get(sessionId)) || null;
      if (!run) return send(res, 404, { error: 'run not found (already finished?)', code: 'RUN_NOT_FOUND' });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();
      // 续传：先补发 lastEventId 之后的历史事件（活跃 run 从内存 buffer 取，省去整文件读）
      for (const ev of eventsForReplay(run, lastEventId)) {
        writeFrame(res, `id: ${ev.seq}\nevent: agent\ndata: ${JSON.stringify(ev)}\n\n`);
      }
      if (run.finished) {
        writeFrame(res, `event: run-ended\ndata: ${JSON.stringify({ runId: run.id, sessionId: run.sessionId })}\n\n`);
        return res.end();
      }
      run.subs.add(res);
      const ping = setInterval(() => {
        writeFrame(res, `event: ping\ndata: ${JSON.stringify({ at: Date.now(), seq: run.seq })}\n\n`);
      }, SSE_PING_MS);
      req.on('close', () => {
        clearInterval(ping);
        run.subs.delete(res);
      });
      return;
    }

    // ---- POST /api/agent/approve：审批回填（先到先得） ----
    if (pathname === '/api/agent/approve' && req.method === 'POST') {
      let body;
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(res, 400, { error: 'bad json', code: 'BAD_REQUEST' }); }
      const runId = String(body.runId ?? '');
      const callId = String(body.callId ?? '');
      const decision = ['once', 'always', 'trust', 'deny'].includes(body.decision) ? body.decision : 'deny';
      const run = runs.get(runId);
      const pending = run?.approvals.get(callId);
      if (!run || !pending) return send(res, 404, { error: 'approval not found (resolved or expired)', code: 'APPROVAL_NOT_FOUND' });
      run.approvals.delete(callId);
      emitEvent(run, 'tool.approval.resolved', { sessionId: run.sessionId, messageId: run.assistantId, callId, decision, autoRejected: false });
      pending.resolve(decision);
      audit({ op: 'approve', runId, callId, decision, user: session?.user?.name });
      return send(res, 200, { ok: true });
    }

    // ---- POST /api/agent/interactive：交互卡作答回填 ----
    if (pathname === '/api/agent/interactive' && req.method === 'POST') {
      let body;
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(res, 400, { error: 'bad json', code: 'BAD_REQUEST' }); }
      const runId = String(body.runId ?? '');
      const callId = String(body.callId ?? '');
      const run = runs.get(runId);
      const pending = run?.interactives.get(callId);
      if (!run || !pending) return send(res, 404, { error: 'interactive not found', code: 'INTERACTIVE_NOT_FOUND' });
      run.interactives.delete(callId);
      const answer = body.answer ?? { __skipped: true };
      pending.resolve(JSON.stringify(answer));
      // resolved 事件带回作答内容：本端/他端卡片收敛时才有回显数据（否则「已提交 · {}」空白）
      emitEvent(run, 'interactive.resolved', { sessionId: run.sessionId, messageId: run.assistantId, callId, answer });
      return send(res, 200, { ok: true });
    }

    // ---- POST /api/agent/interrupt：中断 run（abort 上游流 + 挂起审批 deny 收敛） ----
    if (pathname === '/api/agent/interrupt' && req.method === 'POST') {
      let body;
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(res, 400, { error: 'bad json', code: 'BAD_REQUEST' }); }
      const runId = String(body.runId ?? '');
      const sessionId = String(body.sessionId ?? '');
      const run = (runId && runs.get(runId)) || (sessionId && runsBySession.get(sessionId)) || null;
      if (!run) return send(res, 404, { error: 'run not found', code: 'RUN_NOT_FOUND' });
      audit({ op: 'interrupt', runId: run.id, sessionId: run.sessionId, user: session?.user?.name });
      emitEvent(run, 'message.done', { sessionId: run.sessionId, messageId: run.assistantId, interrupted: true });
      finishRun(run);
      return send(res, 200, { ok: true });
    }

    // ---- GET /api/agent/state?sessionId=：run 状态查询（刷新后 UI 对账） ----
    if (pathname === '/api/agent/state' && req.method === 'GET') {
      const url = new URL(req.url, 'http://x');
      const sessionId = url.searchParams.get('sessionId') ?? '';
      const run = runsBySession.get(sessionId) ?? null;
      if (!run) return send(res, 200, { ok: true, running: false });
      return send(res, 200, {
        ok: true,
        running: !run.finished,
        runId: run.id,
        phase: run.phase,
        startedAt: run.startedAt,
        seq: run.seq,
        // 已落进 chat-store 的事件游标：重开页面时从这之后放，避免把已落档的
        // 正文块再追加一遍（工具卡按 callId 幂等，正文不幂等）。
        syncedSeq: run.syncedSeq ?? 0,
        assistantId: run.assistantId,
      });
    }

    return send(res, 404, { error: 'not found' });
  };
}
