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
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync, renameSync, readdirSync, rmSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { Agent, fetch as undiciFetch } from 'undici';
// 上下文压缩（simple_ai/compact.rs 语义纯函数；Node 24 类型剥离直接吃 TS）。
// 零 DOM/零副作用：UsageAccumulator/estimateTokens/compactShadow 均可服务端复用。
import { UsageAccumulator, estimateTokens, compactShadow } from '../shared/context-compact.ts';
import { buildUsagePayload } from '../shared/usage.ts';
// pocket-ledger 计算内核（纯 CJS vendor；与面板/MCP server 共用同一权威实现）。
const require = createRequire(import.meta.url);
const ledgerCore = require('../pocket-ledger/ledger-core.cjs');

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const RUNS_DIR = 'agent-runs';
/** 上游模型流超时（对齐 relay-core：推理模型长思考期间上游不发字节） */
const UPSTREAM_TIMEOUT_MS = 30 * 60 * 1000;
const upstreamAgent = new Agent({ headersTimeout: UPSTREAM_TIMEOUT_MS, bodyTimeout: UPSTREAM_TIMEOUT_MS });
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
/** 断流自动重试上限（对齐 real-engine MAX_STREAM_RETRIES） */
const MAX_STREAM_RETRIES = 10;

export function createServerPart(options = {}) {
  const getSession = options.getSession;
  const dataDir = resolve(options.dataDir ?? '.polaris-lite');
  const runsDir = resolve(dataDir, RUNS_DIR);
  const auditFile = resolve(dataDir, 'agent-runner-audit.log');
  const hardOff = process.env.PLITE_AGENT_RUNNER === '0';

  // ---- 供应商存取（与 relay-core 同源：store.get 拿明文 key，不出服务端） ----
  const providerStore = options.store;

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

  function runLogPath(runId) { return join(runsDir, `${runId}.events.jsonl`); }
  function runStatePath(runId) { return join(runsDir, `${runId}.state.json`); }

  // ------------------------------------------------------------------
  // 会话档服务端直写（消除「发消息后关页面 → 对话消失」的易失窗口）
  // ------------------------------------------------------------------
  // 背景：会话消息的持久化此前完全依赖客户端（chat-lite 消费事件后防抖 PUT
  // chat-store）。发起端在防抖窗口内被杀（关 App/浏览器/切后台被冻结）时，
  // 用户消息与 AI 回复都不会进入服务端会话档——任务虽在服务端跑完，重开页面
  // 却看不到这条对话。
  //
  // 做法：编排器在服务端把「用户消息 + 本轮 AI 产出」直接写进 chat-store 的
  // 会话文件（<dataDir>/chat-store/<sessionId>.json，与 chat-store 插件的
  // readRecord/writeRecord 同构：{version,updatedAt,session}）。跨插件直写
  // 文件先例：本文件已直连 kv-store sqlite（kvDb/readKvSync）。
  //
  // 合并语义（幂等键 = 消息 id）：
  // - 写前必重读文件（客户端/其他端可能并发 PUT 过）——服务端档是权威，
  //   本地有的消息不重复、不覆盖，只补缺失的本 run 消息；
  // - version 取 max(现有+1, 1) 递增，updatedAt 刷新——与 PUT 通道的版本
  //   语义一致，客户端 409 对账后 pull 即拿到含本轮消息的完整档；
  // - 失败只审计不阻断编排（会话档写失败 ≠ 任务失败）。
  const chatStoreDir = resolve(dataDir, 'chat-store');

  function readChatRecord(sessionId) {
    const file = join(chatStoreDir, `${sessionId}.json`);
    if (!existsSync(file)) return null;
    try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
  }

  function writeChatRecord(sessionId, record) {
    mkdirSync(chatStoreDir, { recursive: true });
    const file = join(chatStoreDir, `${sessionId}.json`);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(record), 'utf8');
    renameSync(tmp, file);
  }

  /**
   * 把消息合并进服务端会话档（幂等：按消息 id 去重；缺会话则建壳）。
   * messages: 追加的完整消息对象（ChatMessage / AssistantBlockMessage 形状）。
   * mergeBlocks: true 时对已存在的 assistant 消息做块级合并（同一 assistantId
   * 跨多轮增量落档——后到的 blocks 追加到既有消息，content 取最长正文）。
   * 返回是否实际写入（无可新增内容时 false，不空转版本号）。
   */
  function mergeChatMessages(sessionId, title, messages, { createdAt, mergeBlocks = false } = {}) {
    if (!sessionId || !ID_RE.test(sessionId) || !messages?.length) return false;
    try {
      const rec = readChatRecord(sessionId);
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
        if (!mergeBlocks) continue;
        // 块级合并：同一 assistant 消息的后续轮次产出追加（工具卡/正文/思考保序），
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
      writeChatRecord(sessionId, { version, updatedAt: Date.now(), session });
      audit({ op: 'chat-sync', sessionId, version, added: fresh.length, merged: changed ? 1 : 0 });
      return true;
    } catch (e) {
      audit({ op: 'chat-sync-fail', sessionId, error: String(e?.message ?? e).slice(0, 120) });
      return false;
    }
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
      } else if (ev.kind === 'tool.card') {
        blocks.push({ type: 'tool', card: { callId: p.callId, name: p.name, command: p.command, argsJson: p.argsJson, status: 'running' } });
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

  /** 事件先落盘再扇出。返回全局递增 seq（=Last-Event-Id 续传游标）。 */
  function emitEvent(run, kind, payload) {
    run.seq += 1;
    const ev = { seq: run.seq, kind, payload, at: Date.now() };
    run.buffer.push(ev);
    // 落盘（append-only JSONL；损坏不影响内存流）
    try {
      mkdirSync(runsDir, { recursive: true });
      const line = `${JSON.stringify(ev)}\n`;
      const st = statSync(runLogPath(run.id), { throwIfNoEntry: false });
      if (!st || st.size < RUN_LOG_MAX_BYTES) appendFileSync(runLogPath(run.id), line);
    } catch { /* 日志失败不阻断执行 */ }
    // 扇出给 SSE 订阅者
    const frame = `id: ${ev.seq}\nevent: agent\ndata: ${JSON.stringify(ev)}\n\n`;
    for (const res of [...run.subs]) {
      try { res.write(frame); } catch { run.subs.delete(res); }
    }
    return ev;
  }

  /** 读取 run 事件日志（重放用）；fromSeq 之后的返回 */
  function readRunEvents(runId, fromSeq = 0) {
    const file = runLogPath(runId);
    if (!existsSync(file)) return [];
    const out = [];
    try {
      const text = readFileSync(file, 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.seq > fromSeq) out.push(ev);
        } catch { /* 跳过损坏行 */ }
      }
    } catch { /* 读失败返回空 */ }
    return out;
  }

  // ------------------------------------------------------------------
  // 模型调用（服务端直连；与 relay-core 同款 undici + 超时 + 断流帧语义）
  // ------------------------------------------------------------------
  function resolveProvider(providerId, modelId) {
    const list = providerStore?.list?.() ?? [];
    let provider = providerId ? list.find((c) => c.id === providerId) : null;
    if (!provider) provider = providerStore?.getActive?.() ?? null;
    if (!provider || provider.enabled === false || !provider.apiKey) return null;
    const activeModel = modelId && (provider.models ?? []).some((m) => m.id === modelId)
      ? modelId
      : (provider.activeModel || provider.models?.[0]?.id || '');
    return { provider, activeModel };
  }

  function buildCapabilityParams(provider) {
    const caps = (provider.models ?? []).find((m) => m.id === provider.activeModel)?.capabilities
      ?? provider.models?.[0]?.capabilities;
    const out = {};
    out.max_tokens = caps && caps.maxOutputTokens > 0 ? caps.maxOutputTokens : 8192;
    if (caps?.effort) out.reasoning_effort = caps.effort;
    return out;
  }

  /**
   * 引擎流一轮（服务端版 engineTurn）：调 relay 同款上游流式接口，聚合
   * delta/reasoning/tool_calls，产出 { text, toolCalls, finishReason, partialToolCalls }。
   * 断流自动续写（prefill）语义与 real-engine 对齐。
   */
  async function engineTurn(run, { messages, tools, onDelta, onReasoning, onRetry, signal }) {
    const { provider, activeModel } = run.model;
    let carriedText = '';
    let wireUsage = null;
    for (let attempt = 1; attempt <= MAX_STREAM_RETRIES; attempt += 1) {
      const attemptMessages = carriedText ? [...messages, { role: 'assistant', content: carriedText }] : messages;
      const body = {
        model: activeModel,
        stream: true,
        messages: attemptMessages,
        ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
        ...buildCapabilityParams(provider),
        stream_options: { include_usage: true },
      };
      const resp = await undiciFetch(`${provider.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
        body: JSON.stringify(body),
        redirect: 'manual',
        signal,
        dispatcher: upstreamAgent,
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        let msg = `HTTP ${resp.status}`;
        try { const j = JSON.parse(text); msg = j.error?.message ?? j.message ?? j.error ?? msg; } catch { /* 保留状态描述 */ }
        throw new Error(String(msg));
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      const toolAcc = new Map();
      let finishReason = '';
      let sawDone = false;
      let broke = false;
      let attemptText = '';
      let sawUsage = false;
      pump: for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (!data) continue;
          if (data === '[DONE]') { sawDone = true; continue; }
          let json;
          try { json = JSON.parse(data); } catch { continue; }
          if (json?.error?.code === 'UPSTREAM_DISCONNECTED') { broke = true; break pump; }
          if (json.usage && typeof json.usage === 'object') { wireUsage = json.usage; sawUsage = true; }
          const choice = json.choices?.[0];
          const reasoning = choice?.delta?.reasoning_content;
          if (reasoning) onReasoning?.(reasoning);
          const delta = choice?.delta?.content;
          if (delta) { attemptText += delta; onDelta?.(delta); }
          // tool_calls 分片聚合（OpenAI 规范 index 维度）
          if (Array.isArray(choice?.delta?.tool_calls)) {
            for (const tc of choice.delta.tool_calls) {
              const idx = Number(tc?.index ?? 0);
              const slot = toolAcc.get(idx) ?? { id: '', name: '', arguments: '' };
              if (tc.id) slot.id = slot.id || String(tc.id);
              if (tc.function?.name) slot.name += String(tc.function.name);
              if (tc.function?.arguments) slot.arguments += String(tc.function.arguments);
              toolAcc.set(idx, slot);
            }
          }
          if (choice?.finish_reason) { finishReason = String(choice.finish_reason); sawDone = true; }
        }
      }
      if (!sawDone) broke = true;
      if (!broke) {
        const toolCalls = finishReason === 'tool_calls' && toolAcc.size > 0
          ? [...toolAcc.entries()].sort(([a], [b]) => a - b).map(([, v]) => ({ id: v.id, name: v.name, arguments: v.arguments }))
          : [];
        const partialToolCalls = finishReason && finishReason !== 'tool_calls' ? toolAcc.size : 0;
        run.lastUsage = wireUsage && sawUsage ? wireUsage : run.lastUsage;
        return { text: attemptText, toolCalls, finishReason, partialToolCalls, usage: (wireUsage && sawUsage ? wireUsage : null) };
      }
      carriedText += attemptText;
      if (attempt >= MAX_STREAM_RETRIES) {
        throw new Error(`上游连接反复中断（已自动重试 ${MAX_STREAM_RETRIES} 次，共生成 ${carriedText.length} 字）`);
      }
      onRetry?.(attempt, MAX_STREAM_RETRIES);
      await new Promise((r) => setTimeout(r, Math.min(500 * attempt, 4500)));
      if (signal?.aborted) throw new Error('INTERRUPTED');
    }
    throw new Error('unreachable');
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
  // ledger（记账）服务端实现：数据在 kv-store（cap.kv → /api/kv/*），
  // 计算复用 pocket-ledger/ledger-core.cjs 单一权威内核（与面板/AI 旧通道同源）。
  // ------------------------------------------------------------------
  const LEDGER_NS = 'pocket-ledger';
  const ledgerSettings = () => {
    const s = readKvSync(LEDGER_NS, 'settings');
    return { ...ledgerCore.DEFAULT_SETTINGS, ...(s && typeof s === 'object' ? s : {}) };
  };
  // kv 读写直连 kv-store 的 sqlite（表 items，id=`${namespace}.${key}`，与插件同构）。
  // 数据目录无库/表时按空处理（首次记账自动建）。
  function kvDb() {
    const dbFile = resolve(dataDir, 'stores', 'kv-store.db');
    mkdirSync(resolve(dataDir, 'stores'), { recursive: true });
    const Database = require('node:sqlite').DatabaseSync;
    const db = new Database(dbFile);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL)');
    return db;
  }
  function readKvSync(ns, key) {
    try {
      const db = kvDb();
      const row = db.prepare('SELECT data FROM items WHERE id = ?').get(`${ns}.${key}`);
      db.close();
      return row ? JSON.parse(row.data) : null;
    } catch { return null; }
  }
  function writeKvSync(ns, key, value) {
    try {
      const db = kvDb();
      db.prepare('INSERT INTO items (id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
        .run(`${ns}.${key}`, JSON.stringify(value ?? null), Date.now());
      db.close();
    } catch { /* 写失败按业务错误返回 */ }
  }
  function ledgerDayKeys() {
    const keys = [];
    try {
      const db = kvDb();
      const rows = db.prepare('SELECT id FROM items WHERE id LIKE ?').all(`${LEDGER_NS}.ledger.day.%`);
      db.close();
      for (const r of rows) keys.push(String(r.id).slice(`${LEDGER_NS}.`.length));
    } catch { /* 忽略 */ }
    return keys.sort();
  }

  async function execLedger(run, args, signal) {
    const settings = ledgerSettings();
    const valid = [...new Set([...(settings.categories ?? []), ...(settings.incomeCategories ?? [])])];
    const action = String(args.action ?? '');
    if (action === 'add') {
      let ts;
      if (Number(args.ts) > 0) ts = Number(args.ts);
      else {
        const resolved = ledgerCore.resolveBillTime({ date: args.date, time: args.time, timeOfDay: args.timeOfDay, hint: args.note }, Date.now());
        if (resolved.error) return { ok: false, error: resolved.error };
        ts = resolved.ts;
      }
      const norm = ledgerCore.normalizeBill({ amount: Number(args.amount), type: args.type === 'income' ? 'income' : 'expense', category: args.category, note: args.note, ts, source: 'ai' }, valid);
      if (norm.error || !norm.bill) return { ok: false, error: norm.error ?? '账单不合法' };
      const bill = norm.bill;
      const dk = ledgerCore.K.day(ledgerCore.dayKeyOf(bill.ts));
      const existing = readKvSync(LEDGER_NS, dk) ?? [];
      const merged = ledgerCore.appendBills(Array.isArray(existing) ? existing : [], [bill]);
      writeKvSync(LEDGER_NS, dk, merged);
      return { ok: true, stdout: JSON.stringify({ ok: true, bill, total: merged.length }) };
    }
    if (action === 'query' || action === 'stats') {
      const month = args.month === 'last' ? ledgerCore.shiftMonth(ledgerCore.currentMonth(), -1)
        : args.month && args.month !== 'this' ? String(args.month) : ledgerCore.currentMonth();
      const prefix = `ledger.day.${month}-`;
      let bills = [];
      for (const dk of ledgerDayKeys()) {
        if (!dk.startsWith(prefix)) continue;
        const arr = readKvSync(LEDGER_NS, dk);
        if (Array.isArray(arr)) bills.push(...arr);
      }
      bills = ledgerCore.filterBills(bills, { category: args.category, type: args.type === 'income' ? 'income' : args.type === 'expense' ? 'expense' : undefined, keyword: args.keyword });
      if (action === 'stats') {
        const stats = ledgerCore.computeStats(bills, settings, month);
        const hint = ledgerCore.budgetHint(stats);
        return { ok: true, stdout: JSON.stringify({ month, stats, ...(hint ? { hint } : {}) }).slice(0, FEEDBACK_CAP) };
      }
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
      const slim = bills.slice(-limit).reverse().map((b) => ({ id: b.id, amount: b.amount, type: b.type, category: b.category, note: b.note, time: new Date(b.ts).toLocaleString('zh-CN', { hour12: false }) }));
      return { ok: true, stdout: JSON.stringify({ month, count: bills.length, bills: slim }).slice(0, FEEDBACK_CAP) };
    }
    if (action === 'delete' || action === 'update') {
      const id = String(args.id ?? '');
      if (!id) return { ok: false, error: 'id required（先用 query 拿 id）' };
      for (const dk of ledgerDayKeys()) {
        const arr = readKvSync(LEDGER_NS, dk);
        if (!Array.isArray(arr)) continue;
        if (action === 'delete') {
          const { arr: next, removed } = ledgerCore.removeBill(arr, id);
          if (removed) { writeKvSync(LEDGER_NS, dk, next); return { ok: true, stdout: JSON.stringify({ ok: true, deleted: id }) }; }
        } else {
          const patch = args.patch ?? {};
          let ts;
          if (patch.date !== undefined || patch.time !== undefined || patch.timeOfDay !== undefined) {
            const resolved = ledgerCore.resolveBillTime({ date: patch.date, time: patch.time, timeOfDay: patch.timeOfDay, hint: patch.note }, Date.now());
            if (!resolved.error) ts = resolved.ts;
          }
          const next = { ...args };
          const { arr: updated, found, bill } = ledgerCore.updateBill(arr, id, { amount: patch.amount !== undefined ? Number(patch.amount) : undefined, category: patch.category, note: patch.note, type: patch.type, ts });
          if (found) { writeKvSync(LEDGER_NS, dk, updated); return { ok: true, stdout: JSON.stringify({ ok: true, bill }) }; }
        }
      }
      return action === 'delete'
        ? { ok: false, error: `未找到账单 ${id}（先用 query 拿 id）` }
        : { ok: false, error: `未找到账单 ${id}（先用 query 拿 id）` };
    }
    if (action === 'categories') {
      const op = String(args.op ?? 'list');
      if (op === 'list') return { ok: true, stdout: JSON.stringify({ categories: settings.categories, incomeCategories: settings.incomeCategories, budgets: settings.budgets }).slice(0, FEEDBACK_CAP) };
      if (op === 'add') {
        const name = String(args.name ?? '').trim();
        const kind = args.kind === 'income' ? 'incomeCategories' : 'categories';
        if (!name) return { ok: false, error: 'name required' };
        if (settings[kind].includes(name)) return { ok: true, stdout: JSON.stringify({ ok: true, already: true }) };
        settings[kind].push(name);
        writeKvSync(LEDGER_NS, 'settings', settings);
        return { ok: true, stdout: JSON.stringify({ ok: true, categories: settings[kind] }) };
      }
      if (op === 'remove') {
        const name = String(args.name ?? '').trim();
        const kind = args.kind === 'income' ? 'incomeCategories' : 'categories';
        settings[kind] = (settings[kind] ?? []).filter((c) => c !== name);
        delete settings.budgets[name];
        writeKvSync(LEDGER_NS, 'settings', settings);
        return { ok: true, stdout: JSON.stringify({ ok: true, removed: true }) };
      }
      return { ok: false, error: `unknown op: ${op}` };
    }
    return { ok: false, error: `unknown action: ${action}（可用：add/query/stats/delete/update/categories）` };
  }

  /** 执行单个工具调用（按工具家族分发；返回 {feedback, status, stdout, stderr, exitCode}） */
  async function execTool(run, call, signal) {
    const args = parseArgs(call.arguments);
    const name = call.name;
    const sessionId = run.sessionId;
    const base = { sessionId, approved: true };
    try {
      if (name === 'bash') {
        const r = await callToolEndpoint('/api/tool/exec', { ...base, command: String(args.command ?? ''), timeoutMs: args.timeoutMs ? Number(args.timeoutMs) : undefined, cwd: run.execCwd }, signal);
        const j = r.json ?? {};
        return { ok: !!j.ok || r.ok, exitCode: j.exitCode, stdout: j.stdout ?? '', stderr: j.stderr ?? j.error ?? '', durationMs: j.durationMs, truncated: j.truncated, denied: j.denied };
      }
      if (name === 'files_write') {
        const payload = { ...args, ...(args.rootId ? {} : { rootId: run.boundRootId }), ...base };
        const r = await callToolEndpoint('/api/files-write/exec', payload, signal);
        const j = r.json ?? {};
        return { ok: r.ok && j.ok !== false, exitCode: j.exitCode ?? (r.ok ? 0 : 1), stdout: j.stdout ?? JSON.stringify(j).slice(0, 2000), stderr: j.error ?? '', durationMs: j.durationMs, denied: j.denied };
      }
      if (name === 'files') {
        const action = String(args.action ?? '');
        if (action === 'roots') {
          const r = await fsGet('/api/fs/roots', signal);
          const roots = r.json?.roots ?? [];
          const summary = roots.length ? `roots=${roots.length}: ${roots.map((x) => `${x.label}（id=${x.id}, path=${x.path}${x.builtin ? ', builtin' : ''}）`).join('; ')}` : '（无登记根）';
          return { ok: r.ok, stdout: `[files 完成] ${summary}`, stderr: r.ok ? '' : `HTTP ${r.status}` };
        }
        if (action === 'list') {
          let rootId = args.rootId ?? run.boundRootId;
          if (!rootId) {
            const rr = await fsGet('/api/fs/roots', signal);
            const builtin = (rr.json?.roots ?? []).find((x) => x.builtin) ?? rr.json?.roots?.[0];
            rootId = builtin?.id;
          }
          if (!rootId) return { ok: false, stdout: '', stderr: 'rootId required（且无可用默认根）' };
          const q = new URLSearchParams({ rootId, path: String(args.path ?? '') });
          const r = await fsGet(`/api/fs/list?${q}`, signal);
          const j = r.json ?? {};
          const summary = r.ok ? `list ok（${(j.entries ?? []).length} 项，rootId=${rootId}，path=${args.path ?? ''}）` : `list 失败：${j.error ?? `HTTP ${r.status}`}`;
          return { ok: r.ok, stdout: r.ok ? `[files 完成] ${summary}` : '', stderr: r.ok ? '' : `[files 工具执行失败] ${summary}` };
        }
        if (action === 'read') {
          let rootId = args.rootId ?? run.boundRootId;
          if (!rootId) {
            const rr = await fsGet('/api/fs/roots', signal);
            const builtin = (rr.json?.roots ?? []).find((x) => x.builtin) ?? rr.json?.roots?.[0];
            rootId = builtin?.id;
          }
          if (!rootId) return { ok: false, stdout: '', stderr: 'rootId required（且无可用默认根）' };
          const q = new URLSearchParams({ rootId, path: String(args.path ?? '') });
          if (args.head) q.set('head', String(args.head));
          if (args.tail) q.set('tail', String(args.tail));
          const r = await fsGet(`/api/fs/read?${q}`, signal);
          const j = r.json ?? {};
          if (!r.ok) return { ok: false, stdout: '', stderr: `[files 工具执行失败] read 失败：${j.error ?? `HTTP ${r.status}`}` };
          if (j.tooLarge) return { ok: false, stdout: '', stderr: `[files 工具执行失败] ${j.hint ?? '文件过大'}` };
          if (j.isText === false) return { ok: false, stdout: '', stderr: '[files 工具执行失败] 二进制文件不支持文本读取' };
          return { ok: true, stdout: `[files 完成] read ok（${j.size ?? '?'}B，path=${args.path ?? ''}）：\n${capText(String(j.text ?? ''), 2000)}`, stderr: '' };
        }
        return { ok: false, stdout: '', stderr: `unknown fs action: ${action}（可用：roots/list/read）` };
      }
      if (name === 'render') {
        const r = await callToolEndpoint('/api/preview/render', { html: args.html, title: args.title, basePreviewId: args.basePreviewId, sessionId }, signal);
        const j = r.json ?? {};
        const ok = r.ok && j.ok !== false;
        const feedback = ok
          ? `[预览已生成] previewId=${j.previewId} 版本=${j.versionLabel ?? '?'} 标题=${j.title ?? '?'}。用户可在对话卡片与「预览」面板中查看运行。`
          : `[预览生成失败] ${j.error ?? `HTTP ${r.status}`}`;
        // 通用产物事件（对齐 html-preview 前端半边 emit 的 artifact.created）：
        // chat-lite 据此在对话里落 artifact 块（rendererType=html-preview → PreviewCard）。
        // callId 用工具调用 callId——artifact 归位到本工具卡之后（而非沉到消息尾）。
        if (ok) {
          emitEvent(run, 'artifact.created', {
            sessionId: run.sessionId,
            messageId: run.assistantId,
            callId: call.id,
            rendererType: 'html-preview',
            title: String(j.title ?? args.title ?? '交互面板'),
            data: { previewId: j.previewId, url: j.url, versionLabel: j.versionLabel },
          });
        }
        return { ok, stdout: ok ? feedback : '', stderr: ok ? '' : feedback };
      }
      if (name === 'browser') {
        const r = await callToolEndpoint('/api/browser/dispatch', { ...args, sessionId, callId: call.id }, signal);
        const j = r.json ?? {};
        const ok = r.ok && (j.ok !== false);
        const feedback = ok ? `[浏览器操作完成] ${JSON.stringify(j).slice(0, FEEDBACK_CAP)}` : `[浏览器操作失败] ${j.error ?? `HTTP ${r.status}`}`;
        return { ok, stdout: ok ? feedback : '', stderr: ok ? '' : feedback };
      }
      if (name === 'read_skill') {
        const r = await fsGet(`/api/skills/read?name=${encodeURIComponent(String(args.name ?? ''))}`, signal);
        const j = r.json ?? {};
        const ok = r.ok && j.ok !== false;
        return { ok, stdout: ok ? (j.content ?? '') : '', stderr: ok ? '' : (j.error ?? `HTTP ${r.status}`) };
      }
      if (name.startsWith('mcp_')) {
        // MCP 管理三连（mcp_server_add/remove/list）与 MCP 工具调用都走 /api/mcp/*
        if (name === 'mcp_server_list') {
          const r = await fsGet('/api/mcp/servers', signal);
          return { ok: r.ok, stdout: JSON.stringify(r.json ?? {}).slice(0, FEEDBACK_CAP), stderr: r.ok ? '' : `HTTP ${r.status}` };
        }
        if (name === 'mcp_server_add' || name === 'mcp_server_remove') {
          const r = await callToolEndpoint(name === 'mcp_server_add' ? '/api/mcp/servers' : '/api/mcp/servers/remove', args, signal);
          return { ok: r.ok, stdout: JSON.stringify(r.json ?? {}).slice(0, FEEDBACK_CAP), stderr: r.ok ? '' : `HTTP ${r.status}` };
        }
        // MCP 聚合工具：/api/mcp/call {name, arguments}
        const r = await callToolEndpoint('/api/mcp/call', { name, arguments: args }, signal);
        const j = r.json ?? {};
        const ok = r.ok && j.ok !== false;
        return { ok, stdout: ok ? String(j.stdout ?? JSON.stringify(j).slice(0, FEEDBACK_CAP)) : '', stderr: ok ? '' : String(j.error ?? `HTTP ${r.status}`) };
      }
      if (name === 'ledger') {
        const r = await execLedger(run, args, signal);
        return { ok: !!r.ok, stdout: r.stdout, stderr: r.ok ? '' : (r.error ?? 'ledger 执行失败') };
      }
      if (name === 'translate') {
        const text = String(args.text ?? '').trim();
        if (!text) return { ok: false, stdout: '', stderr: 'text 不能为空' };
        const to = args.to ? String(args.to) : (/[一-鿿]/.test(text) ? 'en' : 'zh');
        const r = await callToolEndpoint('/api/translate/translate', { text, to }, signal);
        const j = r.json ?? {};
        const ok = r.ok && j.ok !== false;
        return { ok, stdout: ok ? String(j.text ?? j.translated ?? JSON.stringify(j).slice(0, 2000)) : '', stderr: ok ? '' : String(j.error ?? `HTTP ${r.status}`) };
      }
      if (name === 'interactive') {
        // 交互卡：服务端不持 UI——把交互需求作为事件广播，等待任一设备回填。
        const decision = await askInteractive(run, call, args, signal);
        return { ok: true, stdout: decision, stderr: '' };
      }
      // 未知工具
      return { ok: false, stdout: '', stderr: `工具 ${name} 未注册` };
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
  const DEFAULT_CONTEXT_WINDOW = 200_000;

  /** 窗口解析：优先 start payload 显式窗口 → 供应商能力表 maxInputTokens → 默认 200k */
  function resolveCtxWindow(run) {
    if (run.ctxWindow > 0) return run.ctxWindow;
    try {
      const caps = run.model?.provider?.models?.find((m) => m.id === run.model.activeModel)?.capabilities
        ?? run.model?.provider?.models?.[0]?.capabilities;
      const win = Number(caps?.maxInputTokens ?? 0);
      if (Number.isFinite(win) && win > 0) { run.ctxWindow = win; return win; }
    } catch { /* 能力表缺失：回默认 */ }
    run.ctxWindow = DEFAULT_CONTEXT_WINDOW;
    return DEFAULT_CONTEXT_WINDOW;
  }

  /** 非流式补全（压缩摘要专用；走同款上游、key 在服务端、显式 max_tokens、不进 shadow） */
  async function compactComplete(run, { system, user, maxTokens }) {
    const { provider, activeModel } = run.model;
    const body = {
      model: activeModel,
      stream: false,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_tokens: maxTokens,
    };
    const resp = await undiciFetch(`${provider.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
      body: JSON.stringify(body),
      dispatcher: upstreamAgent,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`compact HTTP ${resp.status}: ${text.slice(0, 160)}`);
    }
    const json = await resp.json().catch(() => null);
    const choice = json?.choices?.[0];
    let text = '';
    const content = choice?.message?.content;
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) text = content.map((p) => p?.text ?? '').join('');
    const truncated = choice?.finish_reason === 'length'
      || (!text.trim() && (choice?.message?.reasoning !== undefined || choice?.message?.reasoning_content !== undefined));
    return { text, truncated };
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
    const { sessionId, assistantId } = run;
    const signal = run.controller.signal;
    try {
      // 工具表：start 时已装配 run.toolDefs（静态表 + MCP 聚合补入）；此处兜底重建
      const toolDefs = run.toolDefs?.length ? run.toolDefs : buildServerToolDefs(run);
      let turn = 0;
      let totalToolCalls = 0;
      const toolFailStreak = new Map();
      let toolOnlyStreak = 0;
      let autoContinueLeft = 3;
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

        // assistant.tool_calls 入 shadow（协议成对）
        run.shadow.push({
          role: 'assistant',
          content: result.text,
          tool_calls: result.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
        });

        // 逐个执行：审批 → 工具直调 → 结果卡 + shadow
        for (const call of result.toolCalls) {
          totalToolCalls += 1;
          const callId = call.id || `call-${turn}-${totalToolCalls}`;
          const display = summarizeCall(call);
          emitEvent(run, 'tool.card', { sessionId, messageId: assistantId, callId, name: call.name, command: display, argsJson: call.arguments });

          // 交互卡：不走审批（问用户本身就是审批）
          if (call.name === 'interactive') {
            const r = await execTool(run, call, signal);
            emitEvent(run, 'tool.result', { sessionId, messageId: assistantId, callId, status: r.ok ? 'done' : 'error', command: display, stdout: r.stdout, stderr: r.stderr });
            run.shadow.push({ role: 'tool', content: r.ok ? r.stdout : `[交互卡失败] ${r.stderr}`, tool_call_id: call.id, name: call.name });
            continue;
          }

          // 审批：confirm/allowlist 模式由服务端挂起；yolo 直接放行（与 agent-bash 裁决一致）。
          // 会话级白名单：always=按 approvalKey 前缀；trust=按工具名（run 内内存态）。
          const mode = readToolMode();
          const approvalKey = approvalKeyOf(call);
          const allowlisted = mode.allowPrefixes.some((p) => approvalKey === p || approvalKey.startsWith(`${p} `))
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
    run.controller.abort(); // 兜底：中断残余上游流
    for (const [, a] of run.approvals) a.resolve?.('deny');
    run.approvals.clear();
    for (const [, i] of run.interactives) i.resolve?.(JSON.stringify({ __timeout: true }));
    run.interactives.clear();
    runsBySession.delete(run.sessionId);
    runs.delete(run.id); // runs 表同步回收（否则并发上限被历史 run 占满 → TOO_MANY_RUNS）
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
  function buildServerToolDefs(run) {
    const defs = [];
    const shell = run.shellHint === 'cmd' ? 'cmd' : 'bash';
    defs.push({
      type: 'function',
      function: {
        name: 'bash',
        description: '执行 shell 命令。' + (shell === 'cmd'
          ? '当前宿主为 Windows cmd：不支持 2>/dev/null、; 分隔与 $VAR——请用 cmd 等价写法（2>nul、& 分隔）。'
          : '当前宿主经 Git Bash 执行：写 POSIX bash 语法（2>/dev/null、管道、&&/; 分隔、$VAR 均可用）。') +
          ' 可用于读写文件、运行脚本、安装依赖、调用任意 CLI。限制：cwd 锁定工作区目录；单条超时默认 30s（最长 300s）；输出上限 64KB（超长截断）；命令串行执行，并发自动排队。写文件优先用 files_write 工具。危险命令（rm -rf、curl|sh、改配置存储等）会被无条件拒绝。',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: '要执行的命令（完整一行）' },
            timeoutMs: { type: 'number', description: '超时毫秒，默认 30000，上限 300000' },
          },
          required: ['command'],
        },
      },
    });
    defs.push({
      type: 'function',
      function: {
        name: 'files',
        description: '浏览与读取文件（只读）。动作：roots=列出可用工作区根；list=列目录（rootId+path）；read=读文件（rootId+path，支持 head/tail）。path 传相对工作区根的相对路径；读其它项目目录先 roots 拿根 id。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['roots', 'list', 'read'], description: '要执行的动作' },
            rootId: { type: 'string', description: '工作区根 id（roots 返回）' },
            path: { type: 'string', description: '相对工作区根的路径' },
            head: { type: 'number', description: '只读前 N 字节' },
            tail: { type: 'number', description: '只读后 N 字节' },
          },
          required: ['action'],
        },
      },
    });
    defs.push({
      type: 'function',
      function: {
        name: 'files_write',
        description: '结构化写入与编辑工作区文件（写面；读用 files 工具）。动作：write=写整文件（path+content）；edit=精确替换（path+old_string+new_string）；patch=多文件补丁。路径支持绝对路径或相对工作区根；只能写工作区内；二进制拒写。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['write', 'edit', 'patch'], description: '要执行的动作' },
            path: { type: 'string', description: 'write/edit：目标文件路径' },
            content: { type: 'string', description: 'write：完整内容' },
            old_string: { type: 'string', description: 'edit：被替换的精确原文' },
            new_string: { type: 'string', description: 'edit：替换后的文本' },
            expected_replacements: { type: 'number', description: 'edit：预期出现次数' },
            patch: { type: 'string', description: 'patch：完整补丁信封' },
            rootId: { type: 'string', description: '可选：工作区根 id' },
          },
          required: ['action'],
        },
      },
    });
    defs.push({
      type: 'function',
      function: {
        name: 'render',
        description: '生成自包含 HTML 交互面板（小游戏/原型/图表/教具），在对话卡片与「预览」面板中运行。HTML 必须自包含：内联 CSS/JS、不引 CDN、不 fetch、模型与贴图用 base64；改动旧面板传 basePreviewId。',
        parameters: {
          type: 'object',
          properties: {
            html: { type: 'string', description: '完整 HTML 文档' },
            title: { type: 'string', description: '面板标题' },
            basePreviewId: { type: 'string', description: '可选：基于旧版本迭代' },
          },
          required: ['html'],
        },
      },
    });
    defs.push({
      type: 'function',
      function: {
        name: 'browser',
        description: '驱动系统 Chrome 搜索/阅读/操作网页：search 搜索、read 读正文、navigate/click/fill 交互、screenshot 截图、tabs 标签管理。会话操作路由到本会话绑定标签；优先结构化动作而非 evaluate。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', description: '动作：search/read/navigate/click/fill/press/scroll/screenshot/tabs/close等' },
            url: { type: 'string', description: '目标 URL' },
            query: { type: 'string', description: '搜索词' },
            label: { type: 'string', description: '元素可见文本' },
            selector: { type: 'string', description: 'CSS 选择器' },
            value: { type: 'string', description: '输入值' },
            limit: { type: 'number', description: '结果数上限' },
          },
          required: ['action'],
        },
      },
    });
    defs.push({
      type: 'function',
      function: {
        name: 'read_skill',
        description: '读取技能全文（SKILL.md）。先用系统提示附录里的技能索引选名字，再用本工具读全文。',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string', description: '技能名' } },
          required: ['name'],
        },
      },
    });
    defs.push({
      type: 'function',
      function: {
        name: 'interactive',
        description: '向用户发起结构化交互并等待作答（question 多选 / form 表单 / confirm 确认）。缺少必要信息时用本工具直接问，不要靠开放式文本猜。用户可跳过；超时返回 {"__timeout":true}，应改用已有信息继续。',
        parameters: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['question', 'form', 'confirm'], description: '交互形态' },
            title: { type: 'string', description: '标题' },
            options: { type: 'array', items: { type: 'string' }, description: 'question 的候选选项' },
            fields: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, label: { type: 'string' } } }, description: 'form 的字段列表' },
          },
          required: ['kind', 'title'],
        },
      },
    });
    defs.push({
      type: 'function',
      function: {
        name: 'ledger',
        description: '日常记账。用户说「午饭 35」「打车 48」这类消费/收入时调用 add 记账：amount=金额（正数），type 缺省 expense（收入才传 income），category 从对话语境选（餐饮/交通/购物/居住/娱乐/医疗/学习/人情/其他；收入用 工资/理财/红包/退款/其他收入），note 写简短备注（含菜品/事由，会用于时段推导），时间不明就传 date（today/yesterday/YYYY-MM-DD），不传 time/timeOfDay（按备注触发词或当前时刻就近归档）。用户问「花了多少/这个月怎么样」用 stats/query；改账先 query 拿 id 再 update/delete。入账响应自带预算提醒。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['add', 'query', 'stats', 'delete', 'update', 'categories'], description: '要执行的动作' },
            amount: { type: 'number', description: '金额（正数；add 必填）' },
            type: { type: 'string', description: 'expense（默认）| income' },
            category: { type: 'string', description: '分类；不传由 AI 按语境选' },
            note: { type: 'string', description: '备注（简短）' },
            date: { type: 'string', description: 'today | yesterday | YYYY-MM-DD' },
            time: { type: 'string', description: 'HH:MM（24h）' },
            timeOfDay: { type: 'string', description: '时段档位或中文（凌晨/早上/中午/下午/傍晚/晚上）' },
            id: { type: 'string', description: '账单 id（delete/update 必填；从 query 结果取）' },
            month: { type: 'string', description: 'this | last | YYYY-MM（query/stats）' },
            keyword: { type: 'string', description: '备注/分类关键词（query 过滤）' },
            limit: { type: 'number', description: 'query 返回条数上限（默认 20）' },
            op: { type: 'string', description: 'categories 动作：list | add | remove' },
            name: { type: 'string', description: 'categories add/remove 的分类名' },
            kind: { type: 'string', description: 'categories 分类性质：expense | income' },
            patch: { type: 'object', description: 'update 的字段 { amount?, category?, note?, date?, time?, timeOfDay? }' },
          },
          required: ['action'],
        },
      },
    });
    defs.push({
      type: 'function',
      function: {
        name: 'translate',
        description: '把文本翻译成目标语言（from=auto 自动检测源语言）。to 从 zh(中文)/en(英语)/jp(日语)/kor(韩语)/fra(法语)/de(德语)/ru(俄语)/spa(西班牙语)/wyw(文言文) 里选；不传 to 时自动判断：含中文译英语，否则译中文。文本 ≤6000 字。',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '要翻译的文本（≤6000 字）' },
            to: { type: 'string', description: '目标语言代码：zh|en|jp|kor|fra|de|ru|spa|wyw；省略时自动判断' },
          },
          required: ['text'],
        },
      },
    });
    // MCP 工具（服务端 /api/mcp/tools 聚合描述；未配置时省略）
    try {
      // 同步读不可行（server 端点是异步）；MCP 工具在 start 时经 ensureMcpTools 异步补入
    } catch { /* 忽略 */ }
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
    // 留档供下一 run 延续（同会话 shadow 跨 run 不断档）
    sessionShadows.set(run.sessionId, shadow);
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

  function summarizeCall(call) {
    const args = parseArgs(call.arguments);
    const s = (v) => (v === undefined || v === null ? '' : String(v));
    if (call.name === 'bash') return s(args.command).slice(0, 120);
    if (call.name === 'files' || call.name === 'files_write') return `${call.name} ${s(args.action)} ${s(args.path)}`.trim().slice(0, 120);
    if (call.name === 'browser') return `browser ${s(args.action)}${args.url ? ` ${s(args.url)}` : ''}${args.query ? ` "${s(args.query)}"` : ''}`.slice(0, 120);
    if (call.name === 'render') return `render ${s(args.title)}`.trim().slice(0, 120);
    if (call.name === 'read_skill') return `read_skill ${s(args.name)}`.slice(0, 120);
    if (call.name === 'interactive') return `interactive ${s(args.kind)} ${s(args.title)}`.trim().slice(0, 120);
    if (call.name.startsWith('mcp_')) return `${call.name} ${JSON.stringify(args).slice(0, 100)}`;
    return `${call.name} ${JSON.stringify(args).slice(0, 100)}`;
  }

  function approvalKeyOf(call) {
    const args = parseArgs(call.arguments);
    if (call.name === 'bash') return String(args.command ?? '');
    if (call.name === 'browser') return `browser ${String(args.action ?? '')}`;
    if (call.name.startsWith('mcp_')) return call.name;
    return `${call.name} ${String(args.action ?? '')}`.trim();
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
      const runId = `r-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
      const run = {
        id: runId,
        sessionId,
        assistantId,
        phase: 'running',
        startedAt: Date.now(),
        seq: 0,
        buffer: [],
        subs: new Set(),
        approvals: new Map(),
        interactives: new Map(),
        controller: new AbortController(),
        shadow: [],
        finished: false,
        extraToolDefs: [],
        model: resolveProvider(body.providerId, body.modelId),
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
          run.toolDefs = [...buildServerToolDefs(run), ...run.extraToolDefs];
          await seedShadow(run, body, prompt);
          // 用户消息即刻落服务端会话档（幂等）：发起端随后被杀也不丢这条对话
          syncUserMessage(run, prompt, body?.createdAt);
          await runLoop(run);
        })
        .catch((e) => {
          audit({ op: 'run-fatal', runId, error: String(e?.message ?? e) });
          emitEvent(run, 'stream.error', { sessionId, messageId: assistantId, message: String(e?.message ?? e).slice(0, 300) });
          finishRun(run);
        });
      return send(res, 200, { ok: true, runId, existing: false });
    }

    // ---- GET /api/agent/events?sessionId=&runId=&lastEventId=：SSE 订阅 ----
    if (pathname === '/api/agent/events' && req.method === 'GET') {
      const url = new URL(req.url, 'http://x');
      const sessionId = url.searchParams.get('sessionId') ?? '';
      const runId = url.searchParams.get('runId') ?? '';
      const lastEventId = Number(url.searchParams.get('lastEventId') ?? 0) || 0;
      const run = (runId && runs.get(runId)) || (sessionId && runsBySession.get(sessionId)) || null;
      if (!run) return send(res, 404, { error: 'run not found (already finished?)', code: 'RUN_NOT_FOUND' });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();
      // 续传：先补发 lastEventId 之后的历史事件（从落盘日志读，进程重启也不丢）
      for (const ev of readRunEvents(run.id, lastEventId)) {
        try { res.write(`id: ${ev.seq}\nevent: agent\ndata: ${JSON.stringify(ev)}\n\n`); } catch { /* 断开由 close 回收 */ }
      }
      if (run.finished) {
        res.write(`event: run-ended\ndata: ${JSON.stringify({ runId: run.id, sessionId: run.sessionId })}\n\n`);
        return res.end();
      }
      run.subs.add(res);
      const ping = setInterval(() => {
        try { res.write(`event: ping\ndata: ${JSON.stringify({ at: Date.now(), seq: run.seq })}\n\n`); } catch { /* 断开由 close 回收 */ }
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
        assistantId: run.assistantId,
      });
    }

    return send(res, 404, { error: 'not found' });
  };
}
