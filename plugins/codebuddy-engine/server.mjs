/**
 * codebuddy-engine 插件的服务端半边。
 *
 * 两个职责（一个文件、同一 createServerPart 入口）：
 *
 * ① HTTP 中间件（POST /api/codebuddy/stream + /api/codebuddy/interrupt + health）：
 *    spawn 本目录 adapter.cjs（复用 Polaris-plugin codebuddy 适配器），把 adapter 的
 *    engine-v1 JSONL 帧翻译为 polaris-lite 的 StreamEvent，经 SSE 推给前端半边——
 *    这条「直连通道」现在只服务两个场景：CLI 不可用环境的兜底对话、以及独立档
 *    （standalone，无服务端编排）。常规编排已改走 agent-runner（职责②）。
 *
 * ② 服务端引擎适配器（registry.registerEngine）：把「如何驱动 CodeBuddy CLI」的
 *    领域知识暴露给 agent-runner 的编排循环——runTurn（一轮编排 = spawn 一次
 *    adapter + CLI，工具由 CLI 自持执行，结束时把 tool 帧聚合为 OpenAI 协议的
 *    tool_calls/tool 结果喂回 shadow）/ resolveModel / contextWindow。
 *    关页/断联只影响 SSE 订阅，编排循环在服务端继续——与 real-engine 对称，
 *    runner 零引擎知识，只按 engineId 查通用注册表。
 *
 * 安全模型（对齐 agent-bash / phone-agent server 半边）：
 * - 会话 cookie 硬门禁（auth.getSession 注入），未登录 401；
 * - PLITE_CODEBUDDY=0 一键禁用（适配器也同步禁注册，runner 拿不到 ENGINE_NOT_FOUND 回 400）；
 * - cwd 锁定 <dataDir>/workspace 内（会话绑定根的路径由 prepareWorkspace 解析，
 *   服务端按登记根白名单校验——与 agent-bash 同策略；CLI 自持工具不经
 *   cap.tool.* 审批链，在面板/文档明示）；
 * - 中断：runTurn 挂 AbortSignal，signal 一 abort 即树杀 CLI；直连通道保留
 *   interrupt 端点 + SSE 断连宽限（原有韧性语义不变）；
 * - 审计落 <dataDir>/codebuddy-audit.log（JSON Lines，一轮一条开始/结束）。
 *
 * 与 agent-bash 的关键差异：adapter 是「每轮一启一退」（runSession 结束即 process.exit）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 每个在途会话的运行态：sessionId::messageId → 控制 */

// 断连宽限：客户端 SSE 断开（手机网络抖动/锁屏/刷新）后保留 run 的时长；
// 期内重连续订则取消，超时才树杀。默认 2 分钟（一轮长任务 typical 上限内）。
const DISCONNECT_GRACE_MS = Number(process.env.PLITE_CODEBUDDY_GRACE_MS ?? 120_000);
// SSE 心跳：向在途订阅者定期写 ping，兼探测死连接
const SSE_PING_MS = 15_000;
// 事件缓冲上限：重放窗口的兜底（内存防护；正常一轮远达不到）
const MAX_BUFFERED_EVENTS = 5_000;
// run 结束后的重放保留窗口：迟到重连只读重放；期内同 messageId 新请求会替换
const REPLAY_WINDOW_MS = 60_000;

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
          // 原始参数单独带一份：ArgsBlock / 悬浮岛变更统计 / ai-events 都读 argsJson，
          // 只放在 command 里这些消费方看不到。首帧为 {}，第二帧由宿主幂等回填完整值。
          ...(frame.args && typeof frame.args === 'object' ? { argsJson: JSON.stringify(frame.args) } : {}),
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

// ---- HTML 预览联动（2026-11-25）：CLI Write 工具写了 .html → 落 preview → artifact.created ----
// 与 agent-runner 的 render 工具同一终点（/api/preview/render + artifact 事件），UI 零改动。
// 系统自签 token（与 agent-runner ensureSystemToken 同机制）：Bearer 表达「本地系统调用已审批」。
let systemToken = null;
function ensureSystemToken(verifyTempToken, tempTokens, dataDir) {
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
    return token;
  } catch { return null; }
}

/**
 * Write 工具写 .html 成功后的预览联动。
 * 尺寸护栏：CLI Write 无上限，preview/render 端自身限 2MB + 入库扫描；这里先按字节粗检
 * （>2MB 跳过联动，文件本身仍保留）。失败不阻断 SSE（联动是增益不是依赖）。
 */
async function previewFromWrite(dataDir, selfPort, verifyTempToken, tempTokens, filePath, callId, sessionId, messageId) {
  try {
    const abs = resolve(String(filePath ?? ''));
    if (!abs.toLowerCase().endsWith('.html')) return null;
    if (!existsSync(abs)) return null;
    const html = readFileSync(abs, 'utf8');
    if (!html.trim() || html.length > 2 * 1024 * 1024) return null;
    const headers = { 'Content-Type': 'application/json' };
    const token = ensureSystemToken(verifyTempToken, tempTokens, dataDir);
    if (token) headers.Authorization = `Bearer ${token}`;
    const resp = await fetch(`http://127.0.0.1:${selfPort}/api/preview/render`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ html, title: abs.split(sep).pop()?.replace(/\.html?$/i, '') || '交互面板' }),
    });
    const j = await resp.json().catch(() => null);
    if (!resp.ok || !j?.previewId) return null;
    // 同一事件形状：runner 的 artifact.created（chat-lite 落 artifact 块 → PreviewCard）
    return {
      kind: 'artifact.created',
      payload: {
        sessionId, messageId, callId,
        rendererType: 'html-preview',
        title: String(j.title ?? '交互面板'),
        data: { previewId: j.previewId, url: j.url, versionLabel: j.versionLabel },
      },
    };
  } catch { return null }
}

/** SSE 帧写出（遗留单点写；主路径已由 emitEvent 扇出，保留给独立小响应） */
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
  const registry = options.registry;
  const dataDir = resolve(options.dataDir ?? '.polaris-lite');
  const hardOff = process.env.PLITE_CODEBUDDY === '0';
  // 预览联动用的本地自调端口 + 系统通道（与 agent-runner 的 callToolEndpoint 同机制）
  const selfPort = Number(process.env.PORT ?? 5000);
  const verifyTempToken = options.verifyTempToken;
  const tempTokens = options.tempTokens;

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

  /** CLI 支持的模型清单（缓存一次；从 --help 的 --model 行解析）。
   *  会话设置「模型」行的数据源——不硬编码清单：CLI 升级新增模型自动跟随，
   *  解析失败回退空数组（UI 显示「默认」，仍可对话）。 */
  let modelsCache = null;
  function cliModels() {
    if (modelsCache !== null) return modelsCache;
    modelsCache = [];
    try {
      const help = process.platform === 'win32'
        ? spawnSync('codebuddy', ['--help'], { windowsHide: true, timeout: 15000, shell: true, encoding: 'utf8' })
        : spawnSync('codebuddy', ['--help'], { windowsHide: true, timeout: 15000, encoding: 'utf8' });
      const m = /Currently supported:\s*\(([^)]*)\)/.exec(String(help.stdout ?? ''));
      if (m) {
        modelsCache = m[1].split(',').map((s) => s.trim()).filter(Boolean);
      }
    } catch { /* 解析失败：空清单，UI 走「默认」 */ }
    return modelsCache;
  }

  // ------------------------------------------------------------------
  // 职责②：服务端引擎适配器（agent-runner 编排循环的执行体）。
  // runTurn 的多轮循环由 CLI 自持：一轮 runTurn = spawn 一次 adapter（内部再起
  // CLI、自己跑完内部工具循环），结束时把 tool 帧聚合成 OpenAI 协议结果。
  // 因此 runner 的 tools 参数被忽略（CLI 工具表自带），shadow 里的工具语义靠
  // flattenPrompt 保留。这与 real 的「runner 驱动每步工具」是两种合法形态。
  // ------------------------------------------------------------------
  const codebuddyEngine = {
    id: 'codebuddy',
    kind: 'agent',

    /** runner 的 system prompt 追加段：告知模型本引擎在 CLI 内自带工具循环（bash/
     *  文件读写等由 CLI 直接执行），宿主侧工具表不适用。 */
    systemHint: '当前引擎（CodeBuddy CLI）自带 bash/文件读写等内置工具：需要读写文件、跑命令时直接调用你的内置工具完成，不要调用宿主侧的 bash/files/files_write 工具。',

    /** CLI 自带模型目录（modelRef.option → model）；无供应商概念，恒可用。 */
    resolveModel(modelRef = {}) {
      if (hardOff || !cliFound()) return null;
      const modelId = typeof modelRef.option === 'string' && modelRef.option.trim()
        ? modelRef.option.trim()
        : (typeof modelRef.modelId === 'string' && modelRef.modelId.trim() ? modelRef.modelId.trim() : 'hy4flash-free');
      return { provider: { id: 'codebuddy', name: 'CodeBuddy CLI', baseURL: '', apiKey: '', models: [], activeModel: modelId }, activeModel: modelId };
    },

    contextWindow() {
      // CLI 无公开窗口数；autocompact 自管，给一个保守估计值（仅作水位参考）
      return 200_000;
    },

    /**
     * 一轮编排：spawn adapter → CLI 跑完自持工具循环 → 聚合结果。
     * 返回 real-engine 同款 { text, toolCalls, finishReason, partialToolCalls, usage, lastUsage }。
     * CLI 的工具已全部执行完毕，toolCalls 聚合后带 injected 结果（runner 端
     * skipExecution 标记直接采用，不再重复执行）。
     */
    async runTurn({ model, messages, signal, onDelta, onReasoning }) {
      if (hardOff) throw new Error('codebuddy 引擎已被禁用（PLITE_CODEBUDDY=0）');
      const prompt = flattenPrompt({ messages });
      const textAcc = [];
      let reasoningAcc = '';
      const toolCalls = [];        // CLI 已执行完的工具调用（含结果）
      const usageFrags = [];
      let errorText = '';

      // adapter 的 start_params 里 work_dir 用 builtin workspace（runner 的 execCwd
      // 属于宿主工具域，CLI 在自己的 builtin 根跑；多轮上下文靠 prompt 摊平传递）
      const workdir = resolveWorkdir(dataDir, undefined);
      const adapter = spawn(process.execPath, [resolve(__dirname, 'adapter.cjs')], {
        cwd: workdir,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });

      const cleanup = new Set();
      const kill = () => {
        if (adapter.pid) {
          try {
            if (process.platform === 'win32') {
              spawnSync('taskkill', ['/pid', String(adapter.pid), '/T', '/F'], { windowsHide: true });
            } else {
              adapter.kill('SIGKILL');
            }
          } catch { /* 进程已死 */ }
        }
        try { adapter.stdin.end(); } catch { /* 已关 */ }
      };
      if (signal) {
        if (signal.aborted) { kill(); throw new Error('INTERRUPTED'); }
        const onAbort = () => kill();
        signal.addEventListener('abort', onAbort, { once: true });
        cleanup.add(() => signal.removeEventListener('abort', onAbort));
      }

      const done = new Promise((resolveTurn, rejectTurn) => {
        let settled = false;
        let outBuf = '';
        const stdoutDecoder = new StringDecoder('utf-8');
        const toolArgs = new Map(); // call_id → args 对象（start 帧收集，end 帧配对出结果）

        const settle = (err) => {
          if (settled) return;
          settled = true;
          for (const fn of cleanup) { try { fn(); } catch { /* */ } }
          if (err) rejectTurn(err);
          else resolveTurn({
            text: textAcc.join(''),
            toolCalls,
            finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
            partialToolCalls: 0,
            usage: usageFrags.length > 0 ? usageFrags[usageFrags.length - 1] : null,
            lastUsage: usageFrags.length > 0 ? usageFrags[usageFrags.length - 1] : null,
          });
        };

        adapter.on('error', (e) => settle(new Error(`启动适配器失败：${e.message}`)));
        adapter.on('close', (code) => {
          // session_end 正常路径已 resolve；这里兜底异常退出（含被 abort 树杀）
          if (signal?.aborted) return settle(new Error('INTERRUPTED'));
          settle(new Error(errorText || `引擎异常退出（码 ${code}）`));
        });
        adapter.stderr.on('data', (chunk) => {
          audit(dataDir, { event: 'runner-stderr', text: chunk.toString('utf-8').slice(0, 300) });
        });
        adapter.stdout.on('data', (chunk) => {
          outBuf += stdoutDecoder.write(chunk);
          let idx;
          while ((idx = outBuf.indexOf('\n')) >= 0) {
            const line = outBuf.substring(0, idx).trim();
            outBuf = outBuf.substring(idx + 1);
            if (!line) continue;
            let frame;
            try { frame = JSON.parse(line); } catch { continue; }
            if (frame.event !== 'ai_event') continue;
            const t = frame.type;
            if (t === 'session_end') {
              settle(null);
              return;
            }
            if (t === 'token') {
              const v = String(frame.value ?? '');
              if (v) { textAcc.push(v); onDelta?.(v); }
            } else if (t === 'thinking') {
              const c = String(frame.content ?? '');
              if (c) { reasoningAcc += c; onReasoning?.(c); }
            } else if (t === 'tool_call_start') {
              const callId = frame.call_id || randomUUID();
              const args = frame.args && typeof frame.args === 'object' ? frame.args : {};
              toolArgs.set(callId, { name: String(frame.tool || 'tool'), args });
              onDelta?.(''); // 空帧喂看门狗由 onReasoning 承担；这里仅保持既有信号
            } else if (t === 'tool_call_end') {
              const entry = toolArgs.get(frame.call_id);
              toolArgs.delete(frame.call_id);
              if (entry) {
                toolCalls.push({
                  id: String(frame.call_id || randomUUID()),
                  name: entry.name,
                  arguments: JSON.stringify(entry.args),
                  result: typeof frame.result === 'string' ? frame.result : JSON.stringify(frame.result ?? ''),
                  success: frame.success !== false,
                });
              }
            } else if (t === 'usage') {
              usageFrags.push({
                prompt_tokens: Number(frame.input_tokens ?? 0),
                completion_tokens: Number(frame.output_tokens ?? 0),
                total_tokens: Number(frame.input_tokens ?? 0) + Number(frame.output_tokens ?? 0),
                ...(Number(frame.cache_read_input_tokens ?? 0) > 0 ? { prompt_cache_hit_tokens: Number(frame.cache_read_input_tokens) } : {}),
              });
            } else if (t === 'error') {
              errorText = String(frame.error ?? 'CLI 错误');
              // error 帧不立即 settle：CLI 可能继续输出，session_end/close 兜底收敛
            }
          }
        });
      });

      // MCP 透传（与直连通道同源：mcp-bridge 的 mcp-servers.json 是单一数据源）
      const startParams = {
        session_id: `runner-${Date.now().toString(36)}`,
        message: prompt,
        work_dir: workdir,
        model: String(model?.activeModel ?? 'hy4flash-free'),
        permission_mode: 'bypassPermissions',
      };
      try {
        const mcpCfgPath = resolve(dataDir, 'mcp-servers.json');
        if (existsSync(mcpCfgPath)) {
          const mcpCfg = JSON.parse(readFileSync(mcpCfgPath, 'utf8'));
          const servers = mcpCfg?.servers ?? {};
          const mcpServers = Object.entries(servers)
            .filter(([, s]) => s && s.enabled !== false && typeof s.command === 'string' && s.command.trim())
            .map(([name, s]) => ({
              server_name: name,
              command: s.command,
              args: Array.isArray(s.args) ? s.args : [],
              ...(s.env && typeof s.env === 'object' && Object.keys(s.env).length > 0 ? { env: s.env } : {}),
              ...(typeof s.cwd === 'string' && s.cwd.trim() ? { cwd: s.cwd } : {}),
            }));
          if (mcpServers.length > 0) startParams.mcp_servers = mcpServers;
        }
      } catch { /* MCP 配置不可读：不透传，引擎照常启动 */ }
      audit(dataDir, { event: 'runner-turn', model: startParams.model, promptChars: prompt.length });
      // 必须显式 'utf-8'：Node 对 pipe 默认按 latin1/系统码页写，中文会 mojibake
      adapter.stdin.write(JSON.stringify({ id: 1, method: 'start_session', params: startParams }) + '\n', 'utf-8');

      try {
        return await done;
      } finally {
        kill(); // 幂等：正常退出时进程已死，只剩 stdin.end 兜底
      }
    },
  };
  if (registry && !hardOff) registry.registerEngine(codebuddyEngine);

  return async function codebuddyMiddleware(req, res, next) {
    const url = req.url || '';

    // ---- GET /api/codebuddy/health：引擎可用性探测 + 模型清单（会话设置数据源）----
    if (url === '/api/codebuddy/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: !hardOff, cliFound: !hardOff && cliFound(), models: !hardOff && cliFound() ? cliModels() : [] }));
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

      const existingRun = running.get(key);
      if (existingRun && existingRun.finished) {
        // run 已结束但仍在重放保留窗口内：迟到重连只读重放（含末尾 message.done）
        // 即刻关闭，不重新执行任务。
        attachToRun(existingRun, res, Number(payload.lastEventId ?? 0) || 0);
        return;
      }
      if (existingRun) {
        // 同一 messageId 重复请求 = 断连重连（续订），不是冲突：
        // 先重放 lastEventId 之后的事件，再挂订阅。writeHead 由 attachToRun 统一发出。
        attachToRun(existingRun, res, Number(payload.lastEventId ?? 0) || 0);
        return;
      }
      // 上面两个分支覆盖了 existingRun 的全部情况；走到这里必然没有在途 run，
      // 但 stale 的 finished run 可能还占着位（REPLAY_WINDOW_MS 内被用户重发）——先清掉。
      running.delete(key);

      const workdir = resolveWorkdir(dataDir, payload.workdir);
      const prompt = flattenPrompt(payload);

      const run = {
        sessionId, messageId, dataDir, key,
        killed: false, child: null, adapterStdin: null,
        finished: false,
        seq: 0,
        events: [],          // { seq, kind, payload }（内存态；run 结束即弃）
        subs: new Set(),     // 在途 SSE 响应（断连可再补）
        graceTimer: null,
        writeArgs: null,
      };
      running.set(key, run);
      audit(dataDir, { event: 'start', sessionId, messageId, workdir, model: payload.model ?? 'hy4flash-free' });

      // 事件写出到所有在途订阅者（断连重连后新 res 也在 subs 里）
      const emitEvent = (kind, payload) => {
        run.seq += 1;
        const ev = { seq: run.seq, kind, payload };
        run.events.push(ev);
        if (run.events.length > MAX_BUFFERED_EVENTS) run.events.splice(0, run.events.length - MAX_BUFFERED_EVENTS);
        const frame = `data: ${JSON.stringify({ kind, payload, seq: ev.seq })}\n\n`;
        for (const sub of [...run.subs]) {
          try { sub.write(frame); } catch { run.subs.delete(sub); /* close 回调统一回收 */ }
        }
        return ev;
      };

      // 订阅一个响应到 run（重连续订共用）：先重放 lastEventId 之后的事件，再挂订阅与心跳。
      function attachToRun(r, subRes, lastEventId) {
        subRes.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        subRes.flushHeaders();
        for (const ev of r.events) {
          if (ev.seq <= lastEventId) continue;
          try { subRes.write(`data: ${JSON.stringify({ kind: ev.kind, payload: ev.payload, seq: ev.seq })}\n\n`); } catch { return; /* 断开，close 回调回收 */ }
        }
        if (r.finished) {
          try { subRes.end(); } catch { /* 已断 */ }
          return;
        }
        // 有新订阅者在线：取消未决的断连树杀
        if (r.graceTimer) { clearTimeout(r.graceTimer); r.graceTimer = null; audit(r.dataDir, { event: 'grace-cancel', sessionId: r.sessionId, messageId: r.messageId }); }
        r.subs.add(subRes);
        const ping = setInterval(() => {
          try { subRes.write(`data: ${JSON.stringify({ kind: 'ping', payload: {}, seq: 0 })}\n\n`); } catch { /* close 回收 */ }
        }, SSE_PING_MS);
        subRes.on('close', () => {
          clearInterval(ping);
          r.subs.delete(subRes);
          // 最后一个订阅者断开且 run 未结束：进入宽限期
          if (r.subs.size === 0 && !r.finished) enterGrace(r);
        });
      }

      // 宽限期：CLI 继续跑，事件继续进缓冲；到期仍无订阅者 → 树杀回收
      function enterGrace(r) {
        if (r.graceTimer || r.finished) return;
        r.graceTimer = setTimeout(() => {
          r.graceTimer = null;
          if (r.subs.size === 0 && !r.finished) {
            killRun(r, 'grace-expired');
            if (running.get(r.key) === r) {
              running.delete(r.key);
              audit(r.dataDir, { event: 'end', reason: 'grace-expired', sessionId: r.sessionId, messageId: r.messageId });
            }
          }
        }, DISCONNECT_GRACE_MS);
        audit(r.dataDir, { event: 'grace-start', sessionId: r.sessionId, messageId: r.messageId, ms: DISCONNECT_GRACE_MS });
      }

      // 首个请求的响应也走统一订阅路径（心跳 + 断连宽限一并生效）
      attachToRun(run, res, 0);

      const finish = (reason, extraEvent) => {
        if (run.finished) return;
        run.finished = true;
        if (run.graceTimer) { clearTimeout(run.graceTimer); run.graceTimer = null; }
        running.delete(key);
        if (extraEvent) emitEvent(extraEvent.kind, extraEvent.payload);
        emitEvent('message.done', { sessionId, messageId, ...(reason === 'interrupted' ? { interrupted: true } : {}) });
        for (const sub of [...run.subs]) {
          try { sub.end(); } catch { /* 已断 */ }
        }
        run.subs.clear();
        audit(dataDir, { event: 'end', reason, sessionId, messageId });
        // 结束后的重放窗口：客户端可能在 run 结束的瞬间才重连（断连期间任务跑完）。
        // 短暂保留 run（只读重放，不再执行），迟到者带 lastEventId 续订能拿到全部事件；
        // 窗口过后彻底回收。若期间同 messageId 发来新请求（用户重发），回收让位。
        const doneRun = run;
        setTimeout(() => {
          if (running.get(key) === doneRun) running.delete(key);
        }, REPLAY_WINDOW_MS).unref?.();
        running.set(key, doneRun); // 重占位：attachToRun 见 finished=true 只重放即关闭
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
        model: String(payload.model ?? 'hy4flash-free'),
        permission_mode: 'bypassPermissions',
      };
      // MCP 透传（plans/extension-capability-pure-plugin-plan.md §2.1）：
      // mcp-bridge 的原生配置 <dataDir>/mcp-servers.json 是单一数据源；这里把启用的
      // stdio server 转成 engine-v1 的 mcp_servers 形态，adapter.cjs 会写成临时 JSON
      // 并以 --strict-mcp-config --mcp-config 传给 codebuddy CLI（通道本就存在）。
      // env/cwd 也一并透传（2026-11-25 补齐）：带 API key 环境变量的 server 此前会起不来。
      try {
        const mcpCfgPath = resolve(run.dataDir, 'mcp-servers.json');
        if (existsSync(mcpCfgPath)) {
          const mcpCfg = JSON.parse(readFileSync(mcpCfgPath, 'utf8'));
          const servers = mcpCfg?.servers ?? {};
          const mcpServers = Object.entries(servers)
            .filter(([, s]) => s && s.enabled !== false && typeof s.command === 'string' && s.command.trim())
            .map(([name, s]) => ({
              server_name: name,
              command: s.command,
              args: Array.isArray(s.args) ? s.args : [],
              ...(s.env && typeof s.env === 'object' && Object.keys(s.env).length > 0 ? { env: s.env } : {}),
              ...(typeof s.cwd === 'string' && s.cwd.trim() ? { cwd: s.cwd } : {}),
            }));
          if (mcpServers.length > 0) startParams.mcp_servers = mcpServers;
        }
      } catch { /* MCP 配置不可读：不透传，引擎照常启动 */ }
      // adapter stdin：一条 start_session，prompt 摊平走 stdin。
      // 必须显式 'utf-8'：Node 对 pipe 默认按 latin1/系统码页写，中文会 mojibake
      adapter.stdin.write(JSON.stringify({ id: 1, method: 'start_session', params: startParams }) + '\n', 'utf-8');

      // ---- 事件循环：adapter stdout JSONL → SSE 事件 ----
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
          if (ev) emitEvent(ev.kind, ev.payload);
          // HTML 预览联动：Write 工具成功写了 .html → 落 preview 并发 artifact.created
          //（Write 的参数在 tool_call_start 帧；start/end 两帧按 call_id 配对取 file_path）。
          if (frame.type === 'tool_call_start' && frame.tool === 'Write') {
            try {
              const a = typeof frame.args === 'object' ? frame.args : JSON.parse(frame.args ?? '{}');
              (run.writeArgs ??= new Map()).set(frame.call_id, String(a?.file_path ?? ''));
            } catch { /* 参数解析失败：跳过联动 */ }
          }
          if (frame.type === 'tool_call_end' && frame.success !== false && frame.tool === 'Write') {
            const filePath = run.writeArgs?.get(frame.call_id);
            run.writeArgs?.delete(frame.call_id);
            if (filePath) {
              void previewFromWrite(dataDir, selfPort, verifyTempToken, tempTokens, filePath, frame.call_id || '', sessionId, messageId)
                .then((artifactEv) => { if (artifactEv && !run.finished) emitEvent(artifactEv.kind, artifactEv.payload); })
                .catch(() => { /* 联动失败不影响主流程 */ });
            }
          }
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
        if (!run.finished) {
          finish(run.killed ? 'interrupted' : (code === 0 ? 'completed' : 'error'),
            run.killed || code === 0 ? undefined : { kind: 'stream.error', payload: { sessionId, messageId, message: `引擎异常退出（码 ${code}）` } });
        }
      });

      // 首个响应断开：不再立即树杀——进入宽限期（重连续订可取消），由 attachToRun 的
      // close 回调统一管理（attach 时已挂 res.on('close')）。这里不重复挂监听。
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
