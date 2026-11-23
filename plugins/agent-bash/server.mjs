/**
 * agent-bash 插件的服务端半边（POST /api/tool/exec + GET/POST /api/tool/config）。
 *
 * 这是「插件双入口」的服务端那一半：浏览器沙箱无法 spawn 进程，工具执行必须
 * 在 Node 侧；但「允许哪些命令、几档审批、cwd 范围」全是 agent-bash 的业务裁决，
 * 所以实现跟插件走，由 plugins/server-registry.mjs 登记、server/host.mjs 装配。
 * 本文件被删除时宿主照常启动，只是 bash 工具不可用。
 *
 * 编排侧（何时调用、审批卡、结果喂回模型）在 agent-bash/index.ts 与 agent-loop。
 *
 * 安全设计（这是「AI 有了 bash 就有了一切能力」的另一面——有了一切风险）：
 * - 会话 cookie 硬门禁（auth.getSession 注入）；外部 curl 无 cookie 一律 401；
 * - PLITE_TOOL_EXEC=0 一键整体禁用（公网穿透部署建议关闭）；
 * - 三档模式：confirm（默认，服务端挂起 120s 等审批）/ allowlist（前缀白名单放行）/ yolo；
 *   模式与白名单落盘 .polaris-lite/tool-exec.json，服务端为裁决者（不信任前端）；
 * - denylist 硬拦截且不可被 yolo 豁免：危险管道、全盘破坏、改 auth/provider 数据等；
 * - cwd 锁定 <dataDir>/workspace 内；timeout 默认 30s 上限 300s；
 * - 输出 64KB 上限（头尾保留 + truncated 标记）；并发 1（BUSY 拒绝）；
 * - win32 杀进程树 taskkill /T /F（Node kill 只杀直接子进程）；客户端断开 → abort → 杀树；
 * - win32 优先经 Git Bash 执行（模型写 POSIX 语法，cmd /c 会把 2>/dev/null、;
 *   当成错误重定向/参数——见 resolveBashExe 注释）；无 bash 回退 cmd；
 * - 全量审计落 <dataDir>/tool-exec-audit.log。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, appendFileSync, renameSync, writeFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

const BODY_LIMIT = 64 * 1024;          // 单流输出上限
const HEAD_KEEP = 32 * 1024;           // 超限时保留头部
const TAIL_KEEP = 32 * 1024;           // 超限时保留尾部
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const CONFIRM_WAIT_MS = 120_000;       // confirm 模式审批等待（超时=拒绝）

/** 危险命令模式：命中直接拒绝，任何模式（含 yolo）都不可豁免。
 *  教训：不要对整串做 \b 词边界匹配——PowerShell 的 -Format 参数、管道后的
 *  Format-List/Table、URL 的 ?format= 都会被误伤（历史 12 条 denylist 命中里 11 条是误伤）。
 *  危险词一律锚定「命令首词」位置（行首 / ;&| 之后 / 引号内新命令首词）。 */
const DENYLIST = [
  // ── 递归删除（posix + PowerShell + cmd 等价物）────────────────────────
  /rm\s+(-[a-z]*\s+)*-[a-z]*[rf]{2,}/i,                       // rm -rf 类
  /rm\s+-[a-z]*r[a-z]*f/i,
  // cmd del/erase/rd/rmdir：只有带 /s（递归）才是大破坏；/q（安静）/f（强制）单独出现无害
  /(^|[;&|]\s*|["']\s*)(del|erase|rd|rmdir)(\.exe)?\s+[^;&|]*\/s/i,
  // PowerShell Remove-Item -Recurse（含管道前段）
  /Remove-Item\s+[^;'|&]*-Recurse/i,
  // PowerShell rm/ri 别名带 -r（rm C:/ -r -fo 等；引号内也算）
  /(^|[;&|]\s*|["']\s*)(rm|ri)\s+[^;&|]*-r/i,
  // ── 远程代码执行管道 ─────────────────────────────────────────────────
  /curl[^|;&]*\|\s*(sudo\s+)?(ba)?sh/i,                       // curl | sh 管道
  /wget[^|;&]*\|\s*(sudo\s+)?(ba)?sh/i,
  // ── 全盘破坏：仅命令首词命中（见头部注释）────────────────────────────
  /(^|[;&|]\s*)(format(\s+[a-z]:|\/| |$)|mkfs(\.ext[234]|\.vfat|\.ntfs)?\s|diskpart|fdisk)/i,
  /\b(shutdown|reboot|poweroff)\b/i,
  /\breg\s+(add|delete)\b/i,                                  // 注册表
  /\bschtasks\b/i,                                            // 计划任务
  /\battrib\b/i,
  /[>|]+\s*.*\.polaris-lite[\\/](providers|auth-owner|tool-exec)/i, // 写核心数据文件
  /\b(Add-MpPreference|Set-MpPreference)\b/i,                 // Defender 排除项
  /\b(Invoke-Expression|iex)\b/i,
];

/** 命令替换检测（借鉴 Gemini CLI shell-utils 的 detectCommandSubstitution）：
 *  $()、反引号、<()、>()、PowerShell @() 会把不可信内容拼进命令再执行，
 *  属于注入面；单引号内不检测（内容是字面量）。双引号内仍检测 $()（bash 会展开）。 */
export function detectCommandSubstitution(command) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (inSingle) continue;
    if (ch === '`' && !inDouble) return true;                                  // bash 反引号
    if (ch === '$' && command[i + 1] === '(') return true;                     // $() 子命令
    if (!inDouble && (ch === '<' || ch === '>') && command[i + 1] === '(') return true; // 进程替换
    if (ch === '@' && command[i + 1] === '(') return true;                     // PowerShell @()
  }
  return false;
}

/** win32 下解析可用的 bash（Git Bash），找不到返回 ''（回退 cmd）。
 *  为什么必须有它：模型写的是 POSIX bash 命令（2>/dev/null、; 分隔、引号转义），
 *  而 shell:true 在 win32 走 cmd /c——`2>/dev/null` 会重定向到不存在的 \dev\null
 *  （exit 255「系统找不到指定的路径」）、`;` 会被当成参数传给 head 等程序。
 *  历史事故：2026-11-23 转录复盘，182 条失败工具调用里约 80 条是这个根因。
 *  顺序：PLITE_BASH 显式指定 > Git for Windows 常见安装路径；绝不采用 PATH 里
 *  搜到的 WindowsApps\bash.exe（那是 WSL，文件系统视图完全不同）。 */
const BASH_CANDIDATES = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
];
export function resolveBashExe(env = process.env) {
  if (process.platform !== 'win32') return '';
  const override = String(env.PLITE_BASH ?? '').trim();
  if (override) { try { if (existsSync(override)) return override; } catch { /* 忽略 */ } }
  for (const p of BASH_CANDIDATES) {
    try { if (existsSync(p)) return p; } catch { /* 忽略 */ }
  }
  return '';
}

/** 解码子进程输出：win32 上 cmd 默认 GBK、PowerShell 默认跟随控制台代码页，
 *  直接按 utf8 解码中文会乱码。策略：utf8 解码若出现替换符（U+FFFD）比例高，
 *  回退用 GBK 解码（TextDecoder('gbk') 在 Node 24 全量 ICU 下可用）。 */
function decodeOutput(buf) {
  const utf8 = buf.toString('utf8');
  const bad = (utf8.match(/\uFFFD/g) ?? []).length;
  if (bad === 0 || buf.length < 8) return utf8;
  // 替换符占比超过 2% 才回退，避免个别二进制噪声触发误判
  if (bad / utf8.length < 0.02) return utf8;
  try {
    const gbk = new TextDecoder('gbk').decode(buf);
    return (gbk.match(/\uFFFD/g) ?? []).length < bad ? gbk : utf8;
  } catch {
    return utf8;
  }
}

export function createServerPart(options = {}) {
  /** 临时 Bearer 凭证校验（auth-session 签发；仅本地回环 IP 可用） */
  const tempTokens = options.tempTokens ?? new Map();
  const verifyTempToken = options.verifyTempToken ?? ((token) => false);
  const getSession = options.getSession;
  const dataDir = resolve(options.dataDir ?? '.polaris-lite');
  const workspaceRoot = resolve(dataDir, 'workspace');
  const wsRootsFile = resolve(dataDir, 'workspace-roots.json');
  /** 已登记根的 realpath 列表（fs-api 维护 workspace-roots.json；读失败回退仅内建） */
  const registeredRoots = () => {
    try {
      const raw = JSON.parse(readFileSync(wsRootsFile, 'utf8'));
      return (Array.isArray(raw.roots) ? raw.roots : [])
        .map((r) => String(r.path ?? ''))
        .filter(Boolean)
        .map((p) => { try { return realpathSync(resolve(p)); } catch { return ''; } })
        .filter(Boolean);
    } catch { return []; }
  };
  const configFile = resolve(dataDir, 'tool-exec.json');
  const auditFile = resolve(dataDir, 'tool-exec-audit.log');
  const hardOff = process.env.PLITE_TOOL_EXEC === '0';

  mkdirSync(workspaceRoot, { recursive: true });

  const defaultConfig = () => ({ enabled: true, mode: 'confirm', allowPrefixes: [] });

  function readConfig() {
    try {
      if (!existsSync(configFile)) return defaultConfig();
      const raw = JSON.parse(readFileSync(configFile, 'utf8'));
      const mode = ['confirm', 'allowlist', 'yolo'].includes(raw.mode) ? raw.mode : 'confirm';
      const allowPrefixes = Array.isArray(raw.allowPrefixes)
        ? raw.allowPrefixes.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim())
        : [];
      return { enabled: raw.enabled !== false, mode, allowPrefixes };
    } catch {
      return defaultConfig();
    }
  }

  function writeConfig(next) {
    const tmp = `${configFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2));
    renameSync(tmp, configFile); // 原子写
  }

  function audit(entry) {
    try {
      appendFileSync(auditFile, `${JSON.stringify(entry)}\n`);
    } catch { /* 审计失败不阻塞执行 */ }
  }

  const isDenied = (cmd) => DENYLIST.some((re) => re.test(cmd));
  const isAllowedPrefix = (cmd, prefixes) =>
    prefixes.some((p) => cmd === p || cmd.startsWith(`${p} `) || cmd.startsWith(`${p}\t`));

  /** 在途执行表（并发 1 + 中断杀树） */
  let inflight = null; // { id, kill, sessionId }

  function killTree(child) {
    if (!child || child.exitCode !== null || child.killed) return;
    if (process.platform === 'win32') {
      // Windows：必须 taskkill /T /F 杀整棵树（孙进程持有 stdio 管道，只杀 cmd 外壳
      // 会让 'close' 等到孙进程退出）。不可先 child.kill()——会与 taskkill 竞态：
      // cmd 先死则 taskkill /T 找不到树根，孙进程漏杀（实测挂 60s 的根因）。
      try {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
        return;
      } catch { /* 落到兜底：只能杀外壳 */ }
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
    } else {
      // posix：detached 使子进程为进程组长，负 pid 整组杀
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }
    }
  }

  function runCommand(command, cwd, timeoutMs, sessionId, abortSignal) {
    return new Promise((resolveExec) => {
      const started = Date.now();
      const isWin = process.platform === 'win32';
      // win32 优先 Git Bash（模型写 POSIX 语法）；无 bash 才回退 cmd /c
      const bashExe = resolveBashExe();
      const child = bashExe
        ? spawn(bashExe, ['-c', command], {
            cwd,
            windowsHide: true,
            env: { ...process.env, PLITE_TOOL: '1', NO_COLOR: '1' },
          })
        : spawn(command, {
            shell: true, // win32 → cmd /c；unix → /bin/sh -c
            cwd,
            windowsHide: true,
            env: { ...process.env, PLITE_TOOL: '1', NO_COLOR: '1' },
            detached: !isWin, // posix 下独立进程组，便于整组杀
          });

      let stdoutHead = '';
      let stdoutTail = '';
      let stderrHead = '';
      let stderrTail = '';
      let truncated = false;
      let spawnError = '';
      const stdoutChunks = [];
      const stderrChunks = [];
      const push = (which, chunk) => {
        (which === 'out' ? stdoutChunks : stderrChunks).push(chunk);
        const head = which === 'out' ? stdoutHead : stderrHead;
        const tail = which === 'out' ? stdoutTail : stderrTail;
        const text = chunk.toString('utf8');
        if (head.length + tail.length + text.length > BODY_LIMIT) truncated = true;
        let newHead = head + text;
        if (newHead.length > HEAD_KEEP) {
          // 头满后写入尾窗（保留最新内容）
          const overflow = newHead.slice(HEAD_KEEP);
          const newTail = (tail + overflow).slice(-TAIL_KEEP);
          newHead = newHead.slice(0, HEAD_KEEP);
          if (which === 'out') { stdoutHead = newHead; stdoutTail = newTail; }
          else { stderrHead = newHead; stderrTail = newTail; }
          return;
        }
        if (which === 'out') stdoutHead = newHead;
        else stderrHead = newHead;
      };
      child.stdout.on('data', (c) => push('out', c));
      child.stderr.on('data', (c) => push('err', c));

      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
      const onAbort = () => killTree(child);
      abortSignal?.addEventListener('abort', onAbort, { once: true });

      const finish = (exitCode, signal) => {
        clearTimeout(timer);
        abortSignal?.removeEventListener('abort', onAbort);
        inflight = null;
        // 输出统一走 decodeOutput（utf8 为主，GBK 回退），避免中文乱码
        const stdoutFull = decodeOutput(Buffer.concat(stdoutChunks));
        const stderrFull = decodeOutput(Buffer.concat(stderrChunks));
        const cap = (s) => (s.length > BODY_LIMIT ? `${s.slice(0, HEAD_KEEP)}\n…[输出截断]…\n${s.slice(-TAIL_KEEP)}` : s);
        resolveExec({
          stdout: cap(stdoutFull),
          stderr: cap(stderrFull),
          exitCode: exitCode ?? (timedOut ? -1 : null),
          durationMs: Date.now() - started,
          truncated,
          timedOut,
          aborted: abortSignal?.aborted === true,
          ...(spawnError ? { error: spawnError } : {}),
        });
      };
      child.on('close', (code, signal) => finish(code, signal));
      // spawn 失败（命令不存在等）：error 事件后未必触发 close（win32 cmd 会自己打错误到
      // stderr 并以 exit 1 关闭；posix 直接 error）。统一兜底，把失败原因带给模型。
      child.on('error', (err) => {
        spawnError = `spawn failed: ${err?.code ?? ''} ${err?.message ?? err}`.trim();
        if (child.exitCode === null && child.signalCode === null && !child.killed) {
          try { killTree(child); } catch { /* 已退出 */ }
        }
        finish(-1, null);
      });
    });
  }

  return async function toolExec(req, res, next) {
    const [pathname] = (req.url ?? '').split('?');
    if (pathname !== '/api/tool/exec' && pathname !== '/api/tool/config') return next?.();

    // ① 登录门禁：会话 cookie 或临时 Bearer 凭证二选一。
    //    临时凭证（auth-session 签发，仅本地回环 IP 有效）让 AI/本机脚本无 cookie 也能调用；
    //    exec 的「视为已审批」语义在 ⑤' 处理（confirm 模式下 Bearer 直接放行执行）。
    const authHeader0 = String(req.headers.authorization ?? '');
    const bearerToken0 = authHeader0.startsWith('Bearer ') ? authHeader0.slice(7) : '';
    const bearerValid0 = !!(bearerToken0 && verifyTempToken(bearerToken0));
    const session = getSession?.(req);
    if (!session && !bearerValid0) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'unauthorized', code: 'SESSION_REQUIRED' }));
    }

    const readBody = () => new Promise((r) => {
      let b = '';
      req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
      req.on('end', () => r(b));
    });

    // ② 配置读写（面板 UI 与审批「总是允许」共用）
    if (pathname === '/api/tool/config') {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        // shell 告诉前端实际执行环境（bash/cmd），describe 描述据此给模型写对语法
        return res.end(JSON.stringify({ ...readConfig(), hardOff, shell: resolveBashExe() ? 'bash' : 'cmd' }));
      }
      if (req.method === 'POST') {
        const body = JSON.parse((await readBody()) || '{}');
        const cur = readConfig();
        const next = { ...cur };
        if (typeof body.mode === 'string' && ['confirm', 'allowlist', 'yolo'].includes(body.mode)) next.mode = body.mode;
        if (typeof body.enabled === 'boolean') next.enabled = body.enabled;
        if (typeof body.addPrefix === 'string' && body.addPrefix.trim() && !cur.allowPrefixes.includes(body.addPrefix.trim())) {
          next.allowPrefixes = [...cur.allowPrefixes, body.addPrefix.trim()];
        }
        if (typeof body.removePrefix === 'string') {
          next.allowPrefixes = cur.allowPrefixes.filter((p) => p !== body.removePrefix.trim());
        }
        writeConfig(next);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(next));
      }
      res.writeHead(405); return res.end();
    }

    // ③ 执行
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    if (hardOff) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'tool exec disabled (PLITE_TOOL_EXEC=0)', code: 'EXEC_DISABLED' }));
    }
    const cfg = readConfig();
    if (!cfg.enabled) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'tool exec disabled by config', code: 'EXEC_DISABLED' }));
    }
    // 并发 1 的排队/自杀逻辑在 ⑦（cwd 校验之后、spawn 之前）——这里不再直接 429，
    // 见 ⑦ 注释（2026-11-23 一条卡住命令拖死后续全部工具调用的转录教训）。

    let body;
    try {
      body = JSON.parse((await readBody()) || '{}');
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'bad json', code: 'BAD_REQUEST' }));
    }

    const command = typeof body.command === 'string' ? body.command.trim() : '';
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : 'unknown';
    const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || DEFAULT_TIMEOUT_MS, 1_000), MAX_TIMEOUT_MS);
    if (!command) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'command required', code: 'BAD_REQUEST' }));
    }

    // ④ denylist：任何模式（含 yolo）都不可豁免
    if (isDenied(command)) {
      audit({ at: Date.now(), sessionId, command, verdict: 'denylist', mode: cfg.mode });
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'command matched denylist (not overridable)', code: 'EXEC_DENIED', denied: true }));
    }

    // ④' 命令替换检测：$()、反引号、<()、>()、@() 会把不可信内容拼进命令再执行，
    //    是注入面（借鉴 Gemini CLI detectCommandSubstitution）。同样不可豁免。
    if (detectCommandSubstitution(command)) {
      audit({ at: Date.now(), sessionId, command, verdict: 'substitution', mode: cfg.mode });
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        error: 'command substitution detected ($(), backticks, <(), >(), @()) — blocked as injection risk',
        code: 'EXEC_SUBSTITUTION', denied: true,
      }));
    }

    // ⑤ 模式裁决：allowlist 前缀放行；yolo 全放；confirm 由编排方先行完成审批
    //    （编排方在 confirm 模式下必须在 payload.approved=true 才允许发到这里；
    //     服务端二次校验：confirm 模式下未带 approved 的一律拒绝——双层防御）
    const allowlisted = isAllowedPrefix(command, cfg.allowPrefixes);
    const modeAllows = cfg.mode === 'yolo' || (cfg.mode === 'allowlist' && allowlisted);
    if (!modeAllows && body.approved !== true) {
      audit({ at: Date.now(), sessionId, command, verdict: 'unapproved', mode: cfg.mode });
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'approval required', code: 'EXEC_APPROVAL_REQUIRED', denied: true }));
    }

    // ⑤' 临时凭证：Authorization: Bearer <temp-token>（auth-session 签发，仅本地回环 IP）。
    // 有效 → 视为已审批（approved）；与 cookie 会话二选一。
    const authHeader = String(req.headers.authorization ?? '');
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const isLocal = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '') === '127.0.0.1';
    let bearerOk = false;
    if (bearerToken && typeof verifyTempToken === 'function') {
      if (!isLocal) {
        audit({ at: Date.now(), sessionId, command, verdict: 'bearer-remote-rejected', mode: cfg.mode });
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'temp credential only allowed from localhost', code: 'EXEC_BEARER_REMOTE', denied: true }));
      }
      bearerOk = verifyTempToken(bearerToken);
      if (!bearerOk) {
        audit({ at: Date.now(), sessionId, command, verdict: 'bearer-invalid', mode: cfg.mode });
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'invalid or expired temp credential', code: 'EXEC_BEARER_INVALID', denied: true }));
      }
    }

    // ⑥ cwd 允许范围：内建 workspace 或任一已登记工作区根（realpath 防符号链接逃逸）
    const cwdReq = typeof body.cwd === 'string' && body.cwd.trim() ? resolve(body.cwd.trim()) : workspaceRoot;
    let cwdReal;
    try {
      cwdReal = realpathSync(cwdReq);
    } catch {
      audit({ at: Date.now(), sessionId, command, verdict: 'cwd-missing', mode: cfg.mode });
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'cwd does not exist', code: 'EXEC_CWD_MISSING', denied: true }));
    }
    const workspaceReal = realpathSync(workspaceRoot);
    const withinWorkspace = cwdReal === workspaceReal || cwdReal.startsWith(workspaceReal + sep);
    const withinRegistered = registeredRoots().some((rr) => cwdReal === rr || cwdReal.startsWith(rr + sep));
    if (!withinWorkspace && !withinRegistered) {
      audit({ at: Date.now(), sessionId, command, verdict: 'cwd-escape', mode: cfg.mode });
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'cwd must be the builtin workspace or a registered workspace root', code: 'EXEC_CWD_ESCAPED', denied: true }));
    }
    mkdirSync(cwdReal, { recursive: true });

    const abort = new AbortController();
    res.on('close', () => abort.abort()); // 编排方中断（fetch abort）→ 杀树

    const execId = randomUUID().slice(0, 8);
    inflight = { id: execId, kill: () => abort.abort(), sessionId };
    const result = await runCommand(command, cwdReq, timeoutMs, sessionId, abort.signal);
    audit({
      at: Date.now(), sessionId, execId, command,
      verdict: result.exitCode === 0 ? 'ok' : `exit-${result.exitCode}`,
      durationMs: result.durationMs, truncated: result.truncated,
      timedOut: result.timedOut, mode: cfg.mode,
    });

    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(result));
  };
}
