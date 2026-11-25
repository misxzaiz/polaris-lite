/**
 * codebuddy-engine 插件的服务端半边（POST /api/codebuddy/stream + /api/codebuddy/interrupt）。
 *
 * 职责：spawn 本目录 adapter.js（复用 Polaris-plugin codebuddy 适配器），把 adapter 的
 * engine-v1 JSONL 帧翻译为 polaris-lite 的 StreamEvent，经 SSE 推给前端半边（index.ts），
 * 后者原样 emit 进宿主总线（cap.ai.chat:event）。
 *
 * 安全模型（对齐 agent-bash / phone-agent server 半边）：
 * - 会话 cookie 硬门禁（auth.getSession 注入），未登录 401；
 * - PLITE_CODEBUDDY=0 一键禁用；
 * - cwd 锁定 <dataDir>/workspace 内（会话绑定根的路径由前端透传，服务端按登记根白名单校验——
 *   与 agent-bash 同策略；本引擎自持 CLI 内置工具，不经 cap.tool.* 审批链，在面板/文档明示）；
 * - 中断：内存表记「会话::消息 → 子进程」，interrupt 端点 taskkill /T /F 树杀（adapter 内部
 *   也会响应 interrupt 帧，双保险）；客户端断开 SSE → abort → 树杀；
 * - 审计落 <dataDir>/codebuddy-audit.log（JSON Lines，一轮一条开始/结束）。
 *
 * 与 agent-bash 的关键差异：adapter 是「每轮一启一退」（runSession 结束即 process.exit），
 * 本服务端为每个 start 请求 spawn 一个 adapter 进程，SSE 关闭/CLI 退出即回收。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 每个在途会话的运行态：sessionId::messageId → 控制 */
const running = new Map();

/** 读取登记工作区根（与 agent-bash 同源：file-browser 维护的 workspace-roots.json） */
function readRegisteredRoots(dataDir) {
  try {
    const raw = JSON.parse(readFileSync(resolve(dataDir, 'workspace-roots.json'), 'utf8'));
    return (Array.isArray(raw.roots) ? raw.roots : [])
      .map((r) => String(r.path ?? ''))
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** cwd 白名单校验：内建 workspace 或任一登记根之下 */
function resolveWorkdir(dataDir, requested) {
  const builtin = resolve(dataDir, 'workspace');
  const candidates = [builtin, ...readRegisteredRoots(dataDir)];
  if (requested) {
    const req = resolve(requested);
    for (const root of candidates) {
      if (req === root || req.startsWith(root + sep)) return req;
    }
  }
  return builtin;
}

/** 把 chat-lite/agent-loop 的请求摊平成单条 prompt 文本（adapter 只收单 message）。
 *  两种来源：
 *  - chat-lite 直连：{ prompt, history }；
 *  - agent-loop 编排：{ messages: OpenAI 协议消息数组（含 system/assistant.tool_calls/tool） }。
 *  防御：prompt 为空时回退 history/messages 里最后一条 user 消息（UI 首条竞态实测）。
 *  tool 消息渲染为「工具结果」段，assistant.tool_calls 渲染为「助手调用工具」段，
 *  保证多轮编排上下文不丢。 */
function flattenPrompt(payload) {
  const parts = [];
  const push = (role, content) => parts.push(`【${role}】${content}`);
  const str = (v) => (typeof v === 'string' ? v : JSON.stringify(v ?? ''));

  if (Array.isArray(payload.messages) && payload.messages.length > 0) {
    for (const m of payload.messages) {
      const role = m?.role;
      if (role === 'user') push('用户', str(m.content));
      else if (role === 'assistant') {
        if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
          push('助手', str(m.content) + (m.content ? '\n' : '') + m.tool_calls.map((tc) => `调用工具 ${tc?.function?.name ?? '?'}(${tc?.function?.arguments ?? ''})`).join('\n'));
        } else push('助手', str(m.content));
      } else if (role === 'tool') push('工具结果', str(m.content));
      else push('系统', str(m.content));
    }
    return parts.join('\n\n');
  }

  const history = Array.isArray(payload.history) ? payload.history : [];
  let prompt = String(payload.prompt ?? '');
  if (!prompt.trim()) {
    const lastUser = [...history].reverse().find((m) => m?.role === 'user');
    if (lastUser) {
      prompt = str(lastUser.content);
      history.splice(history.indexOf(lastUser), 1); // 该条已上移为 prompt，不再重复进上下文
    }
  }
  for (const m of history) {
    const role = m?.role === 'assistant' ? '助手' : m?.role === 'system' ? '系统' : '用户';
    push(role, str(m.content));
  }
  push('用户', prompt);
  return parts.join('\n\n');
}

/** adapter AIEvent → polaris-lite StreamEvent */
function translateEvent(sessionId, messageId, frame) {
  switch (frame.type) {
    case 'session_start':
      // 状态行走 message.reasoning 通道太吵；chat-lite 看门狗只认 message.*，
      // 用一条轻量 status delta 喂狗（不影响正文渲染——空 delta 会被 chat-lite 忽略？不会，
      // 这里给非空但无意义的提示文本不合适。改为 engine.status 自定义事件 + 立即回一条
      // reasoning 空串会污染。最终方案：session_start/cli_init 都不发 UI 事件，冷启动
      // 提示由前端半边的「已连接引擎」本地状态承担；这里仅透传 token/thinking/工具/usage。
      return null;
    case 'token':
      return { kind: 'message.delta', payload: { sessionId, messageId, delta: String(frame.value ?? '') } };
    case 'thinking':
      return { kind: 'message.reasoning', payload: { sessionId, messageId, delta: String(frame.content ?? '') } };
    case 'tool_call_start':
      return {
        kind: 'tool.card',
        payload: {
          sessionId, messageId,
          callId: frame.call_id || randomUUID(),
          name: frame.tool || 'tool',
          command: typeof frame.args === 'object' ? JSON.stringify(frame.args) : String(frame.args ?? ''),
        },
      };
    case 'tool_call_end':
      return {
        kind: 'tool.result',
        payload: {
          sessionId, messageId,
          callId: frame.call_id || '',
          status: frame.success === false ? 'error' : 'done',
          stdout: typeof frame.result === 'string' ? frame.result : JSON.stringify(frame.result ?? ''),
        },
      };
    case 'usage':
      return {
        kind: 'ai.usage',
        payload: {
          sessionId, messageId,
          inputTokens: Number(frame.input_tokens ?? 0),
          outputTokens: Number(frame.output_tokens ?? 0),
          totalTokens: Number(frame.input_tokens ?? 0) + Number(frame.output_tokens ?? 0),
          cachedTokens: Number(frame.cache_read_input_tokens ?? 0) || undefined,
          cacheCreationTokens: Number(frame.cache_creation_input_tokens ?? 0) || undefined,
          model: frame.actual_model || undefined,
          durationMs: 0,
        },
      };
    case 'error':
      return { kind: 'stream.error', payload: { sessionId, messageId, message: String(frame.error ?? 'CLI 错误') } };
    default:
      return null;
  }
}

/** 写审计 */
function audit(dataDir, entry) {
  try {
    appendFileSync(resolve(dataDir, 'codebuddy-audit.log'), JSON.stringify({ at: Date.now(), ...entry }) + '\n');
  } catch { /* 审计失败不阻断主流程 */ }
}

/** SSE 帧写出 */
function sseWrite(res, obj) {
  try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* 连接已断 */ }
}

/** 树杀一个运行态 */
function killRun(run, reason) {
  if (!run || run.killed) return;
  run.killed = true;
  if (run.child?.pid) {
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(run.child.pid), '/T', '/F'], { windowsHide: true });
      } else {
        run.child.kill('SIGKILL');
      }
    } catch { /* 进程已死 */ }
  }
  try { run.adapterStdin?.end(); } catch { /* 已关 */ }
  audit(run.dataDir, { event: 'killed', reason, sessionId: run.sessionId, messageId: run.messageId });
}

export function createServerPart(options = {}) {
  const getSession = options.getSession;
  const dataDir = resolve(options.dataDir ?? '.polaris-lite');
  const hardOff = process.env.PLITE_CODEBUDDY === '0';

  mkdirSync(resolve(dataDir, 'workspace'), { recursive: true });

  /** CLI 可用性探测（缓存一次；spawnSync where 每次都同步阻塞不划算）。
   *  chat-lite 会话设置面板据此决定「AI 引擎」行是否可选——CLI 缺失的环境
   *  给用户一个锁定的「默认」，比可选了发消息才报错友好。
   *  Windows 注意：npm 全局装的 CLI 是 .cmd，Node 20+ 无 shell 直接 spawn 会 EINVAL；
   *  探测参数是硬编码 ['--version']，无用户输入拼接，shell:true 无注入面。 */
  let cliFoundCache = null;
  function cliFound() {
    if (cliFoundCache !== null) return cliFoundCache;
    cliFoundCache = (process.platform === 'win32'
      ? spawnSync('codebuddy', ['--version'], { windowsHide: true, timeout: 15000, shell: true })
      : spawnSync('codebuddy', ['--version'], { windowsHide: true, timeout: 15000 })).status === 0;
    return cliFoundCache;
  }

  return async function codebuddyMiddleware(req, res, next) {
    const url = req.url || '';

    // ---- GET /api/codebuddy/health：引擎可用性探测（会话设置「AI 引擎」行数据源）----
    if (url === '/api/codebuddy/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: !hardOff, cliFound: !hardOff && cliFound() }));
      return;
    }

    // ---- POST /api/codebuddy/stream：SSE 流式对话 ----
    if (url === '/api/codebuddy/stream' && req.method === 'POST') {
      if (hardOff) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'codebuddy 引擎已被禁用（PLITE_CODEBUDDY=0）' }));
        return;
      }
      const session = getSession(req);
      if (!session) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '未登录' }));
        return;
      }
      // 读 body（JSON，64KB 上限——聊天消息不会更大；附件不支持，走文本降级提示）
      let body = '';
      let oversized = false;
      await new Promise((resolveRead) => {
        req.on('data', (c) => {
          body += c;
          if (body.length > 64 * 1024) { oversized = true; req.destroy(); resolveRead(); }
        });
        req.on('end', resolveRead);
        req.on('error', resolveRead);
      });
      if (oversized) return;
      let payload;
      try { payload = JSON.parse(body); } catch { payload = {}; }
      const sessionId = String(payload.sessionId ?? 'unknown');
      const messageId = String(payload.messageId ?? 'unknown');
      const key = `${sessionId}::${messageId}`;

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      if (running.has(key)) {
        sseWrite(res, { kind: 'stream.error', payload: { sessionId, messageId, message: '该消息已有在途引擎会话' } });
        sseWrite(res, { kind: 'message.done', payload: { sessionId, messageId } });
        res.end();
        return;
      }

      const workdir = resolveWorkdir(dataDir, payload.workdir);
      const prompt = flattenPrompt(payload);
      const run = { sessionId, messageId, dataDir, killed: false, child: null, adapterStdin: null };
      running.set(key, run);
      audit(dataDir, { event: 'start', sessionId, messageId, workdir, model: payload.model ?? 'hy4free' });

      const finish = (reason, extraEvent) => {
        if (!running.has(key)) return;
        running.delete(key);
        if (extraEvent) sseWrite(res, extraEvent);
        sseWrite(res, { kind: 'message.done', payload: { sessionId, messageId, ...(reason === 'interrupted' ? { interrupted: true } : {}) } });
        try { res.end(); } catch { /* 已断 */ }
        audit(dataDir, { event: 'end', reason, sessionId, messageId });
      };

      // spawn adapter（每轮一启一退；adapter 内部再 spawn codebuddy CLI）
      let adapter;
      try {
        adapter = spawn(process.execPath, [resolve(__dirname, 'adapter.cjs')], {
          cwd: workdir,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (e) {
        finish('error', { kind: 'stream.error', payload: { sessionId, messageId, message: `启动适配器失败：${e.message}` } });
        return;
      }
      run.child = adapter;
      run.adapterStdin = adapter.stdin;

      // adapter stdin：一条 start_session，prompt 摊平走 stdin
      const startParams = {
        session_id: sessionId,
        message: prompt,
        work_dir: workdir,
        model: String(payload.model ?? 'hy4free'),
        permission_mode: 'bypassPermissions',
      };
      // MCP 透传（plans/extension-capability-pure-plugin-plan.md §2.1）：
      // mcp-bridge 的原生配置 <dataDir>/mcp-servers.json 是单一数据源；这里把启用的
      // stdio server 转成 engine-v1 的 mcp_servers 形态，adapter.cjs 会写成临时 JSON
      // 并以 --strict-mcp-config --mcp-config 传给 codebuddy CLI（通道本就存在）。
      try {
        const mcpCfgPath = resolve(run.dataDir, 'mcp-servers.json');
        if (existsSync(mcpCfgPath)) {
          const mcpCfg = JSON.parse(readFileSync(mcpCfgPath, 'utf8'));
          const servers = mcpCfg?.servers ?? {};
          const mcpServers = Object.entries(servers)
            .filter(([, s]) => s && s.enabled !== false && typeof s.command === 'string' && s.command.trim())
            .map(([name, s]) => ({ server_name: name, command: s.command, args: Array.isArray(s.args) ? s.args : [] }));
          if (mcpServers.length > 0) startParams.mcp_servers = mcpServers;
        }
      } catch { /* MCP 配置不可读：不透传，引擎照常启动 */ }
      // adapter stdin：一条 start_session，prompt 摊平走 stdin。
      // 必须显式 'utf-8'：Node 对 pipe 默认按 latin1/系统码页写，中文会 mojibake
      adapter.stdin.write(JSON.stringify({ id: 1, method: 'start_session', params: startParams }) + '\n', 'utf-8');

      let outBuf = '';
      const stdoutDecoder = new StringDecoder('utf-8');
      adapter.stdout.on('data', (chunk) => {
        outBuf += stdoutDecoder.write(chunk);
        let idx;
        while ((idx = outBuf.indexOf('\n')) >= 0) {
          const line = outBuf.substring(0, idx).trim();
          outBuf = outBuf.substring(idx + 1);
          if (!line) continue;
          let frame;
          try { frame = JSON.parse(line); } catch { continue; }
          if (frame.event !== 'ai_event') continue; // 响应帧（result）不进 UI
          if (frame.type === 'session_end') { finish(frame.reason === 'aborted' ? 'interrupted' : 'completed'); return; }
          const ev = translateEvent(sessionId, messageId, frame);
          if (ev) sseWrite(res, ev);
        }
      });
      adapter.stderr.on('data', (chunk) => {
        // adapter/CLI 的 stderr 仅落审计，不进 UI（避免噪声）
        audit(dataDir, { event: 'stderr', sessionId, messageId, text: chunk.toString('utf-8').slice(0, 500) });
      });
      adapter.on('error', (e) => {
        finish('error', { kind: 'stream.error', payload: { sessionId, messageId, message: `适配器进程错误：${e.message}` } });
      });
      adapter.on('close', (code) => {
        // 正常路径 session_end 帧已 finish；这里是异常退出（崩溃/被杀）兜底
        if (running.has(key)) {
          finish(run.killed ? 'interrupted' : (code === 0 ? 'completed' : 'error'),
            run.killed || code === 0 ? undefined : { kind: 'stream.error', payload: { sessionId, messageId, message: `引擎异常退出（码 ${code}）` } });
        }
      });

      // 客户端断开（前端 abort / 页面关闭）→ 树杀
      res.on('close', () => {
        if (running.has(key)) {
          killRun(run, 'client-disconnected');
          running.delete(key);
          audit(dataDir, { event: 'end', reason: 'client-disconnected', sessionId, messageId });
        }
      });
      return;
    }

    // ---- POST /api/codebuddy/interrupt：中断在途会话（幂等） ----
    if (url === '/api/codebuddy/interrupt' && req.method === 'POST') {
      if (hardOff) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'codebuddy 引擎已被禁用' }));
        return;
      }
      const session = getSession(req);
      if (!session) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '未登录' }));
        return;
      }
      let body = '';
      await new Promise((r) => { req.on('data', (c) => { body += c; }); req.on('end', r); req.on('error', r); });
      let payload;
      try { payload = JSON.parse(body); } catch { payload = {}; }
      const sessionId = String(payload.sessionId ?? '');
      let found = false;
      for (const [key, run] of [...running.entries()]) {
        if (run.sessionId === sessionId) {
          killRun(run, 'interrupt');
          found = true;
          // 注意：不在这里 running.delete(key)——adapter close 事件触发 finish()
          // 时需要 running.has(key) 为真才会收敛 SSE（补发 done{interrupted}）。
          // 过早删除会让 SSE 永远挂住（实测 e2e-int 挂死根因）。
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, found }));
      return;
    }

    next();
  };
}
