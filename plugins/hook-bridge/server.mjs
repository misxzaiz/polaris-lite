/**
 * hook-bridge 插件的服务端半边（/api/hooks/*）：
 * Claude Code / ZCode hooks 配置归一 + 进程执行器 + 审计。
 *
 * 配置来源（只读，合并；同名规则先到先得）：
 *   - ~/.claude/settings.json、<work>/.claude/settings.json、<work>/.claude/settings.local.json 的 hooks 键
 *   - ~/.zcode/cli/config.json、<work>/.zcode/config.json 的顶层 hooks（尊重其 enabled:true 前置）
 * 归一形态：{ event, matcher?, handlers:[{type:'command'|'process', command, args?, shell?, timeoutMs?, statusMessage?}] }
 *   - CC 形态：hooks.{EventName}:[{matcher, hooks:[{type:'command', command, timeout}]}]
 *   - ZC 形态：hooks:{enabled, timeoutMs, events:{EventName:[{matcher, hooks:[{type:'command'|'process', ...}]}]}}
 *
 * 执行协议（对齐 Claude/ZCode，V5 PoC 已验证）：
 *   stdin  = JSON {session_id, cwd, hook_event_name, tool_name?, tool_input?}
 *   stdout = JSON {hookSpecificOutput:{permissionDecision, additionalContext, updatedInput}, decision, reason}（解析失败当纯文本忽略）
 *   退出码 0=放行；2=阻断（PreToolUse 拒工具 / UserPromptSubmit 拒本轮）；其他=非阻断错误
 *
 * 事件：POST /api/hooks/pre-tool-use | post-tool-use | prompt-submit | session-start | turn-end
 * 安全：会话门禁；PLITE_HOOKS=0 禁用；workspace 级来源首启确认（kv 指纹）；全量审计。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, appendFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname, isAbsolute } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_TIMEOUT_MS = 60_000;
const AUDIT_PREVIEW_BYTES = 512;

/** Polaris 内置工具名 → Claude 系 matcher 名（使 CC 生态现成 matcher 直接可用） */
const TOOL_NAME_ALIASES = {
  bash: 'Bash',
  read_file: 'Read',
  write_file: 'Edit',
  edit_file: 'Edit',
  apply_patch: 'Edit',
  glob: 'Glob',
  dispatch_agent: 'Agent',
  update_plan: 'TodoWrite',
};

export function createServerPart(options = {}) {
  const getSession = options.getSession;
  const verifyTempToken = options.verifyTempToken ?? ((token) => false);
  const dataDir = resolve(options.dataDir ?? '.polaris-lite');
  const hardOff = process.env.PLITE_HOOKS === '0';
  const auditPath = join(dataDir, 'hooks-audit.log');
  const hooksTrustPath = join(dataDir, 'hooks-trust.json');

  // 多工作区缓存：按 ws 分桶，key 含源路径与文件指纹（跨会话不同工作区互不错命中）
  const ruleCache = new Map();

  function readJsonSafe(path) {
    try {
      if (!existsSync(path)) return null;
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return null;
    }
  }

  /** 会话→工作区映射（agent-loop 派发钩子时上报；解决钩子路径与会话工作区不一致：
   *  会话绑定非默认工作区时，AI 把 settings.json 写进会话工作区，而此前的
   *  activeWorkspace() 只看全局/登记表——钩子静默丢失。 */
  const sessionWs = new Map();

  function sessionWsFor(sessionId) {
    return (sessionId && sessionWs.get(sessionId)) || null;
  }

  /** 当前应使用的钩子目录定位：会话绑定优先，其次全局解析，最后内建工作区 */
  function hooksWorkspaceDir(sessionId) {
    return sessionWsFor(sessionId) ?? workspaceDir();
  }

  function workspaceDir() {
    try {
      const p = join(dataDir, 'workspace-state.json');
      if (existsSync(p)) {
        const j = JSON.parse(readFileSync(p, 'utf8'));
        if (j.activeRootPath) return j.activeRootPath;
      }
    } catch { /* 忽略 */ }
    try {
      const roots = JSON.parse(readFileSync(join(dataDir, 'workspace-roots.json'), 'utf8'));
      const list = Array.isArray(roots.roots) ? roots.roots : [];
      const hit = list.find((r) => r.path && !r.builtin) ?? list.find((r) => r.path);
      if (hit?.path && existsSync(hit.path)) return hit.path;
    } catch { /* 忽略 */ }
    // 兜底：宿主内建工作区（与 skill-loader 同步修复——全新实例两个 state 文件都不存在）
    return join(dataDir, 'workspace');
  }

  /** 把 CC/ZC 的一种 handler 归一；非法/不支持返回 null（warn 收集） */
  function normalizeHandler(raw, source, warns) {
    if (!raw || typeof raw !== 'object') return null;
    const type = raw.type ?? 'command';
    if (type !== 'command' && type !== 'process') {
      warns.push(`${source}: handler type=${type} 暂不支持（仅 command/process），忽略`);
      return null;
    }
    const command = String(raw.command ?? '').trim();
    if (!command) {
      warns.push(`${source}: handler 缺 command，忽略`);
      return null;
    }
    if (isAbsolute(command) && !existsSync(command)) {
      warns.push(`${source}: command 指向不存在的绝对路径，忽略`);
      return null;
    }
    // timeout：ZC 秒字段 与 CC 秒字段统一为 ms；ZC 的 timeoutMs 优先
    const timeoutMs = Number(raw.timeoutMs ?? (raw.timeout ? Number(raw.timeout) * 1000 : 0)) || DEFAULT_TIMEOUT_MS;
    return {
      type,
      command,
      args: Array.isArray(raw.args) ? raw.args.map(String) : [],
      shell: raw.shell ? String(raw.shell) : undefined,
      timeoutMs,
    };
  }

  /** 归一一种配置文件里的 hooks 对象；scope='user'|'workspace' */
  function normalizeHooksObject(hooks, source, scope, warns, out) {
    if (!hooks || typeof hooks !== 'object') return;
    if (hooks.enabled === false) return; // ZC 显式关闭
    if (hooks.enabled !== true && source.includes('zcode')) {
      // ZCode 语义：配置 hook 必须 enabled:true 才生效；这里对混合形态宽松处理（有 events 就收）
    }
    const events = hooks.events ?? hooks; // CC 顶层即事件映射；ZC 在 events 键下
    const SUPPORTED = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'Stop'];
    for (const [eventName, matchers] of Object.entries(events)) {
      if (eventName === 'enabled' || eventName === 'timeoutMs' || eventName === 'maxOutputBytes') continue;
      if (!SUPPORTED.includes(eventName)) {
        if (!warns.some((w) => w.includes('事件不支持'))) {
          warns.push(`${source}: 存在不支持的事件（Claude 独有），已忽略（仅提示一次）`);
        }
        continue;
      }
      if (!Array.isArray(matchers)) continue;
      for (const m of matchers) {
        if (!m || typeof m !== 'object') continue;
        const matcher = m.matcher ? String(m.matcher) : undefined;
        const hs = Array.isArray(m.hooks) ? m.hooks : [];
        for (const raw of hs) {
          const h = normalizeHandler(raw, `${source}:${eventName}`, warns);
          if (h) out.push({ event: eventName, matcher, handler: h, scope, source });
        }
      }
    }
  }

  function loadRules(wsOverride) {
    const ws = wsOverride ?? workspaceDir();
    const home = homedir();
    const sources = [
      ['user:~/.claude/settings.json', join(home, '.claude', 'settings.json'), 'user'],
      ['builtin-ws:.claude/settings.json', join(dataDir, 'workspace', '.claude', 'settings.json'), 'workspace'],
      ['workspace:.claude/settings.json', ws ? join(ws, '.claude', 'settings.json') : '', 'workspace'],
      ['workspace:.claude/settings.local.json', ws ? join(ws, '.claude', 'settings.local.json') : '', 'workspace'],
      // 全局通用钩子源（不依赖任何工作区；用户诉求：默认全局路径）
      ['global:<dataDir>/hooks/settings.json', join(dataDir, 'hooks', 'settings.json'), 'user'],
      ['user:~/.zcode/cli/config.json', join(home, '.zcode', 'cli', 'config.json'), 'user'],
      ['workspace:.zcode/config.json', ws ? join(ws, '.zcode', 'config.json') : '', 'workspace'],
      // zcode-compat 导入产物（{events:{...}} 同构形态）：CC/ZC hooks 经固化导入后在此生效
      ['import:hooks-import.json', join(dataDir, 'hooks-import.json'), 'workspace'],
    ];
    const key = JSON.stringify(sources.map(([p]) => p)) + '|' + sources.map(([p]) => { try { return existsSync(p) ? statMtime(p) : ''; } catch { return ''; } }).join(',');
    const cached = ruleCache.get(ws ?? '__default__');
    if (cached && cached.key === key && cached.rules) return cached;

    const warns = [];
    const rules = [];
    for (const [source, path, scope] of sources) {
      if (!path || !existsSync(path)) continue;
      const j = readJsonSafe(path);
      if (!j) { warns.push(`${source}: 解析失败跳过`); continue; }
      // hooks-import.json（zcode-compat 导入产物）本身就是 {events:{...}} 归一形态，无 hooks 包裹层
      const hooksObj = source.startsWith('import:') ? j : (j.hooks ?? (source.includes('zcode') ? j : null));
      normalizeHooksObject(hooksObj, source, scope, warns, rules);
    }
    const entry = { key, rules, warns };
    ruleCache.set(ws ?? '__default__', entry);
    return entry;
  }

  function statMtime(p) {
    try { return readFileSync(p, 'utf8').length + ':' + existsSync(p); } catch { return ''; }
  }

  function audit(entry) {
    try {
      appendFileSync(auditPath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
    } catch { /* 审计失败不阻塞 */ }
  }

  function matcherMatches(matcher, toolName) {
    if (!matcher || matcher === '*') return true;
    const candidates = [toolName, TOOL_NAME_ALIASES[toolName]].filter(Boolean);
    try {
      const re = new RegExp(matcher);
      return candidates.some((c) => re.test(c));
    } catch {
      return false; // 非法正则：永不匹配（ZCode 语义）+ 已在加载时可见
    }
  }

  /** 执行单个 handler；返回 {code, stdout, stderr, timedOut} */
  function runHandler(rule, input) {
    return new Promise((resolveP) => {
      const { handler } = rule;
      let child;
      try {
        if (handler.type === 'process') {
          // process 型：argv 向量，不经 shell（最可移植，对齐 ZCode）
          child = spawn(handler.command, [...handler.args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, cwd: input.cwd || undefined });
        } else {
          // command 型：shell 串。必须用 shell:true 的字符串形态——Windows 下 spawn('cmd',['/c',str])
          // 会对 argv 再做一层引号处理，命令里自带的引号（如 node "C:\path with space\x.cjs"）会被
          // 原样传给 node 变成模块路径的一部分（实测 loader 报 Cannot find module '"C:\..."'）。
          child = spawn(handler.command, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, cwd: input.cwd || undefined, shell: true });
        }
      } catch (e) {
        resolveP({ code: -1, stdout: '', stderr: String(e?.message ?? e), timedOut: false });
        return;
      }
      let stdout = '', stderr = '', timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill(); } catch { /* 忽略 */ }
      }, handler.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      child.stdout?.on('data', (d) => { stdout += d; });
      child.stderr?.on('data', (d) => { stderr += d; });
      child.on('error', (e) => {
        clearTimeout(timer);
        resolveP({ code: -1, stdout, stderr: stderr + String(e?.message ?? e), timedOut });
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolveP({ code: code ?? -1, stdout, stderr, timedOut });
      });
      try {
        child.stdin.write(JSON.stringify(input) + '\n', 'utf-8');
        child.stdin.end();
      } catch { /* stdin 关闭早于写入：忽略，按空输入处理 */ }
    });
  }

  /** 解析 hook 输出：stdout JSON 优先，退出码兜底 */
  function interpret(results) {
    let decision = 'allow';
    let reason;
    let additionalContext;
    let updatedInput;
    for (const r of results) {
      let parsed = null;
      try { parsed = JSON.parse(r.stdout); } catch { /* 纯文本或空：按退出码 */ }
      const specific = parsed?.hookSpecificOutput;
      const d = specific?.permissionDecision ?? parsed?.decision;
      if (d === 'deny' || d === 'block') decision = 'deny';
      if (specific?.permissionDecisionReason) reason = String(specific.permissionDecisionReason);
      if (specific?.updatedInput && typeof specific.updatedInput === 'object') updatedInput = specific.updatedInput;
      const ctx = specific?.additionalContext ?? parsed?.additionalContext;
      if (ctx) additionalContext = (additionalContext ? additionalContext + '\n' : '') + String(ctx);
      if (parsed?.reason) reason = String(parsed.reason);
      if (r.code === 2) decision = 'deny';
      if (r.timedOut) { decision = decision === 'deny' ? 'deny' : 'allow'; reason = reason ?? 'hook 超时（按放行处理，已记审计）'; }
    }
    return { decision, reason, additionalContext, updatedInput };
  }

  /** workspace 级钩子变更确认闸（runtime-extensions-and-market-final.md P1.2）：
   * workspace 作用域（含 zcode-compat 导入的 hooks-import.json）的规则集首次出现/内容变更时，
   * 用户须在面板确认后才执行；未确认只记审计并放行（fail-open，不阻塞主流程）。
   * 信任依据 = workspace 规则集的内容指纹（sha256）；确认记录持久化在 <dataDir>/hooks-trust.json。
   * AI 可写工作区 hooks（files_write），此闸防止其绕过审批体系给自己放行。 */
  function workspaceRulesFingerprint(rules) {
    const ws = rules.filter((r) => r.scope === 'workspace');
    const text = JSON.stringify(ws.map(({ event, matcher, handler }) => ({ event, matcher, handler })));
    return createHash('sha256').update(text).digest('hex');
  }

  function loadTrust() {
    try {
      if (!existsSync(hooksTrustPath)) return {};
      return JSON.parse(readFileSync(hooksTrustPath, 'utf8'));
    } catch {
      return {};
    }
  }

  function saveTrust(t) {
    try {
      mkdirSync(dirname(hooksTrustPath), { recursive: true });
      writeFileSync(hooksTrustPath, JSON.stringify(t, null, 2) + '\n');
    } catch { /* 信任记录写失败不阻塞（下次仍会要求确认） */ }
  }

  /** 返回 {trusted: boolean, fingerprint, changed}——changed=true 表示有未确认的变更 */
  function checkWorkspaceTrust(rules) {
    const fp = workspaceRulesFingerprint(rules);
    const trust = loadTrust();
    return { trusted: trust.fingerprint === fp, fingerprint: fp, changed: trust.fingerprint !== fp };
  }

  async function runEvent(eventName, input, res, sendJson) {
    const ws = hooksWorkspaceDir(input.session_id);
    const { rules, warns } = loadRules(ws);
    const matched = rules.filter((r) => r.event === eventName && matcherMatches(r.matcher, input.tool_name ?? ''));
    if (!matched.length) {
      return sendJson(200, { decision: 'allow', warns: warns.length ? warns : undefined });
    }
    // 确认闸：默认关闭（用户定调 AI 自建钩子免人工确认）；PLITE_HOOK_CONFIRM=1 恢复强制确认。
    // 无论闸状态，workspace 规则变更都记审计（指纹可见）。
    const wsMatched = matched.some((r) => r.scope === 'workspace');
    if (wsMatched && process.env.PLITE_HOOK_CONFIRM === '1') {
      const trust = checkWorkspaceTrust(rules);
      if (!trust.trusted) {
        audit({ event: eventName, kind: 'trust-gate', fingerprint: trust.fingerprint.slice(0, 16), note: 'workspace hooks 未确认，跳过执行' });
        return sendJson(200, {
          decision: 'allow',
          warns: [...warns, 'workspace 级 hooks 有未确认的变更：本次未执行钩子（请在「钩子」面板确认）'],
        });
      }
    }
    const hookInput = {
      session_id: input.session_id ?? '',
      cwd: input.cwd ?? ws,
      hook_event_name: eventName,
      permission_mode: 'default',
    };
    if (input.tool_name !== undefined) { hookInput.tool_name = input.tool_name; hookInput.tool_input = input.tool_input ?? {}; }
    if (input.prompt !== undefined) hookInput.prompt = input.prompt;

    const results = [];
    for (const rule of matched) {
      const r = await runHandler(rule, hookInput);
      results.push(r);
      audit({
        event: eventName, matcher: rule.matcher ?? '*', scope: rule.scope, source: rule.source,
        handler: `${rule.handler.type}:${rule.handler.command.slice(0, 120)}`,
        exitCode: r.code, timedOut: r.timedOut, durationHint: r.stderr?.length ?? 0,
        stdoutPreview: r.stdout.slice(0, AUDIT_PREVIEW_BYTES),
        stderrPreview: r.stderr.slice(0, AUDIT_PREVIEW_BYTES),
      });
    }
    const outcome = interpret(results);
    return sendJson(200, { ...outcome, warns: warns.length ? warns : undefined });
  }

  return async function hooksApi(req, res, next) {
    if (hardOff) return next?.();
    const [pathname] = (req.url ?? '').split('?');
    if (!pathname.startsWith('/api/hooks/')) return next?.();

    // 门禁：会话 cookie 或 本地回环 Bearer 临时凭证（同 agent-files 双认证惯例）
    const session = getSession?.(req);
    const bearer = String(req.headers.authorization ?? '');
    const bearerOk = bearer.startsWith('Bearer ') && verifyTempToken(bearer.slice(7));
    if (!session && !bearerOk) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'unauthorized', code: 'SESSION_REQUIRED' }));
    }

    const sendJson = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(obj));
    };
    const readBody = () => new Promise((r) => {
      let b = '';
      req.on('data', (c) => { b += c; if (b.length > 1_000_000) req.destroy(); });
      req.on('end', () => r(b));
    });

    try {
      if (pathname === '/api/hooks/pre-tool-use' && req.method === 'POST') {
        const body = JSON.parse((await readBody()) || '{}');
        return await runEvent('PreToolUse', { session_id: body.sessionId, tool_name: body.toolName, tool_input: body.toolInput }, res, sendJson);
      }
      if (pathname === '/api/hooks/post-tool-use' && req.method === 'POST') {
        const body = JSON.parse((await readBody()) || '{}');
        const eventName = body.success === false ? 'PostToolUseFailure' : 'PostToolUse';
        return await runEvent(eventName, { session_id: body.sessionId, tool_name: body.toolName, tool_input: body.toolInput }, res, sendJson);
      }
      if (pathname === '/api/hooks/prompt-submit' && req.method === 'POST') {
        const body = JSON.parse((await readBody()) || '{}');
        return await runEvent('UserPromptSubmit', { session_id: body.sessionId, prompt: body.prompt }, res, sendJson);
      }
      if (pathname === '/api/hooks/session-start' && req.method === 'POST') {
        const body = JSON.parse((await readBody()) || '{}');
        return await runEvent('SessionStart', { session_id: body.sessionId }, res, sendJson);
      }
      if (pathname === '/api/hooks/turn-end' && req.method === 'POST') {
        const body = JSON.parse((await readBody()) || '{}');
        return await runEvent('Stop', { session_id: body.sessionId }, res, sendJson);
      }
      if (pathname === '/api/hooks/list' && req.method === 'GET') {
        const url = new URL(req.url, 'http://x');
        const sid = url.searchParams.get('sessionId') ?? '';
        const ws = hooksWorkspaceDir(sid);
        const { rules, warns } = loadRules(ws);
        const trust = checkWorkspaceTrust(rules);
        return sendJson(200, {
          rules: rules.map(({ event, matcher, scope, source, handler }) => ({ event, matcher, scope, source, type: handler.type, command: handler.command, timeoutMs: handler.timeoutMs })),
          warns,
          // 确认闸状态：pending=workspace 规则集有未确认变更（执行被跳过）
          trust: { trusted: trust.trusted, pending: trust.changed },
          hooksWs: ws,
          globalHooksPath: join(dataDir, 'hooks', 'settings.json'),
        });
      }
      if (pathname === '/api/hooks/session-ws' && req.method === 'POST') {
        // 会话工作区上报（agent-loop 每次 loop start 传来）：钩子目录与该会话的
        // files/bash 工作区保持一致（此前两套解析，会话绑定非默认工作区时钩子静默丢失）
        const body = JSON.parse((await readBody()) || '{}');
        if (body.sessionId && body.workspace && existsSync(String(body.workspace))) {
          sessionWs.set(String(body.sessionId), resolve(String(body.workspace)));
        }
        return sendJson(200, { ok: true });
      }
      if (pathname === '/api/hooks/confirm' && req.method === 'POST') {
        // 用户在面板点「确认」：把当前 workspace 规则集指纹写入信任记录
        const { rules } = loadRules();
        const fp = workspaceRulesFingerprint(rules);
        const trust = loadTrust();
        trust.fingerprint = fp;
        trust.confirmedAt = new Date().toISOString();
        saveTrust(trust);
        audit({ kind: 'trust-confirm', fingerprint: fp.slice(0, 16) });
        return sendJson(200, { ok: true });
      }
      return sendJson(404, { error: 'not found' });
    } catch (e) {
      return sendJson(400, { error: String(e?.message ?? e) });
    }
  };
}
