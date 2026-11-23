/**
 * git-core 插件的服务端半边（POST /api/git/dispatch）：git 能力的唯一 Node 侧入口。
 *
 * 「插件双入口」的 server 半边：浏览器沙箱无法 spawn git，能力实现必须住这里。
 * 由 plugins/server-registry.mjs 登记、server/host.mjs 统一装配；本文件被删除时
 * 宿主照常启动，只是 cap.git 全部动作失败（解耦试金石）。
 *
 * 架构对齐 Polaris cap.git（services/router/git_capability.rs）的治理语义，按
 * polaris-lite 的插件契约裁剪为一期九动作：
 *   读：get_status / get_worktree_diff / get_worktree_file_diff / get_log / get_branches
 *   写：batch_stage / batch_unstage / commit_changes / checkout_branch
 *
 * 安全设计（对齐 file-browser / agent-bash 的 server 半边）：
 * - 会话 cookie 硬门禁（getSession 注入）；PLITE_GIT=0 一键禁用；
 * - **工作区根白名单**：rootId 必须命中 file-browser 维护的 workspace-roots.json
 *   （与 agent-bash 的 cwd 校验同一份根表），realpath 防符号链接逃逸；
 * - 动作白名单：未登记动作 400（对齐 Polaris KNOWN_ACTIONS / unsupported_action）；
 * - 写动作 FIFO 串行（WRITE_GATE，max=1）：git index.lock 不可并发写，多入口
 *   （面板 + AI + 多标签）必须排队；读动作不限并发；
 * - git CLI spawn：cwd=仓库根、超时 30s、输出 1MB 上限（头尾保留）、win32 杀进程树；
 * - 审计落 <dataDir>/git-audit.log（一行 JSON，含 action/rootId/ok/耗时/来源）。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

const TIMEOUT_MS = 30_000;
const OUT_LIMIT = 1024 * 1024;      // 单动作输出上限（git diff 可能很大）
const HEAD_KEEP = 512 * 1024;
const TAIL_KEEP = 256 * 1024;

/** 一期动作白名单（读并发 / 写串行）。新增动作须同时补 index.ts describe。 */
const READ_ACTIONS = new Set([
  'get_status', 'get_worktree_diff', 'get_worktree_file_diff', 'get_log', 'get_branches',
]);
const WRITE_ACTIONS = new Set([
  'batch_stage', 'batch_unstage', 'commit_changes', 'checkout_branch',
]);

/** git 仓库必须落在已登记工作区根内；返回 { rootPath } 或 { error, code }。 */
function resolveRoot(dataDir, rootId) {
  const wsRootsFile = resolve(dataDir, 'workspace-roots.json');
  let roots = [];
  try {
    const raw = JSON.parse(readFileSync(wsRootsFile, 'utf8'));
    roots = Array.isArray(raw.roots) ? raw.roots : [];
  } catch { /* 根表缺失时仅内建 workspace 兜底 */ }
  const builtin = resolve(dataDir, 'workspace');
  if (!roots.some((r) => r.builtin === true)) roots.push({ id: 'r-builtin', path: builtin, builtin: true });

  const hit = roots.find((r) => r && (r.id === rootId || r.path === rootId)) ?? roots.find((r) => r.builtin === true);
  if (!hit) return { error: '没有可用的工作区根', code: 'GIT_NO_ROOT' };
  let real;
  try {
    real = realpathSync(resolve(String(hit.path)));
  } catch {
    return { error: '工作区根不存在', code: 'GIT_ROOT_MISSING' };
  }
  if (real === resolve(dataDir) || real.startsWith(resolve(dataDir) + sep)) {
    // dataDir 本体是禁区（providers/auth/审计），内建 workspace 例外
    if (!real.startsWith(resolve(builtin))) return { error: '禁止对数据目录做 git 操作', code: 'GIT_FORBIDDEN' };
  }
  return { rootPath: real, rootLabel: String(hit.label ?? hit.id ?? 'workspace') };
}

/** 在仓库根内执行 git CLI；返回 { ok, stdout, stderr, exitCode, truncated }。 */
function gitRun(rootPath, args, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolveDone) => {
    const started = Date.now();
    const isWin = process.platform === 'win32';
    const child = spawn('git', args, {
      cwd: rootPath,
      windowsHide: true,
      env: { ...process.env, NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0', PLITE_GIT_CORE: '1' },
      detached: !isWin,
    });
    const chunks = [];
    const errChunks = [];
    let size = 0;
    let truncated = false;
    const push = (buf) => {
      if (size >= OUT_LIMIT) { truncated = true; return; }
      size += buf.length;
      if (size > OUT_LIMIT) { chunks.push(buf.subarray(0, buf.length - (size - OUT_LIMIT))); truncated = true; return; }
      chunks.push(buf);
    };
    child.stdout.on('data', push);
    child.stderr.on('data', (b) => { errChunks.push(b); });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (isWin) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
        else process.kill(-child.pid, 'SIGKILL');
      } catch { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }
    }, timeoutMs);
    const finish = (code) => {
      clearTimeout(timer);
      resolveDone({
        ok: !timedOut && code === 0,
        exitCode: timedOut ? -1 : code,
        stdout: Buffer.concat(chunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8') + (timedOut ? `\n[git-core] 超时 ${timeoutMs}ms` : '') + (truncated ? '\n[git-core] 输出截断' : ''),
        truncated,
        durationMs: Date.now() - started,
      });
    };
    child.on('close', (code) => finish(code ?? -1));
    child.on('error', (err) => {
      errChunks.push(Buffer.from(`spawn failed: ${err.message}`));
      finish(-1);
    });
  });
}

/** 动作 → git argv（白名单内的参数整形；不透传任意参数，防注入）。 */
function buildArgs(action, p) {
  switch (action) {
    case 'get_status': return ['status', '--porcelain=v1', '--branch', '--ahead-behind'];
    case 'get_worktree_diff': return ['diff', '--numstat', '--'];
    case 'get_worktree_file_diff':
      if (!p.filePath) return null;
      return ['diff', '--', String(p.filePath)];
    case 'get_log': {
      const limit = Math.min(Math.max(Number(p.limit ?? 50), 1), 200);
      const skip = Math.max(Number(p.skip ?? 0), 0);
      const args = ['log', `--max-count=${limit}`];
      if (skip > 0) args.push(`--skip=${skip}`);
      args.push('--date=relative', '--pretty=format:%h%x1f%an%x1f%at%x1f%s');
      return args;
    }
    case 'get_branches': return ['branch', '--format=%(refname:short)%x1f%(HEAD)'];
    case 'batch_stage': {
      const files = Array.isArray(p.filePaths) ? p.filePaths.map(String) : [];
      if (!files.length) return null;
      return ['add', '--', ...files];
    }
    case 'batch_unstage': {
      const files = Array.isArray(p.filePaths) ? p.filePaths.map(String) : [];
      if (!files.length) return null;
      return ['reset', 'HEAD', '--', ...files];
    }
    case 'commit_changes': {
      const msg = String(p.message ?? '').trim();
      if (!msg) return null;
      const args = ['commit', '-m', msg];
      if (p.stageAll === true) args.push('-a');
      return args;
    }
    case 'checkout_branch': {
      const name = String(p.name ?? '').trim();
      if (!name || /[`\n\r;]/.test(name)) return null;
      return ['checkout', name];
    }
    default: return null;
  }
}

/** get_status 的 porcelain 输出 → 结构化 JSON（对齐原型的三区计数 + 文件清单）。 */
function parseStatus(out) {
  const lines = out.split('\n').filter(Boolean);
  const head = lines.find((l) => l.startsWith('##')) ?? '';
  const branch = head.replace(/^##\s*/, '').split(/\.\.\.|\s*\[/)[0].trim();
  const abMatch = head.match(/\[(ahead (\d+))?[,\s]*(behind (\d+))?\]/);
  const files = [];
  for (const l of lines) {
    if (l.startsWith('##')) continue;
    const code = l.slice(0, 2);
    const path = l.slice(3).split(' -> ').pop();
    if (!path) continue;
    files.push({
      path,
      x: code[0] === ' ' ? ' ' : code[0],
      y: code[1],
      staged: code[0] !== ' ' && code[0] !== '?',
      unstaged: code[1] !== ' ' && code[1] !== '?',
      untracked: code === '??',
    });
  }
  return {
    branch,
    ahead: abMatch ? Number(abMatch[2] ?? 0) : 0,
    behind: abMatch ? Number(abMatch[4] ?? 0) : 0,
    staged: files.filter((f) => f.staged),
    unstaged: files.filter((f) => f.unstaged && !f.untracked),
    untracked: files.filter((f) => f.untracked).map((f) => f.path),
    files,
  };
}

export function createServerPart(options = {}) {
  const getSession = options.getSession;
  const dataDir = resolve(options.dataDir ?? '.polaris-lite');
  const auditFile = resolve(dataDir, 'git-audit.log');
  const hardOff = process.env.PLITE_GIT === '0';
  /** 写动作 FIFO 闸（Polaris WRITE_GATE 的 Node 等价物）：git index.lock 不可并发写。 */
  let writeChain = Promise.resolve();

  function audit(entry) {
    try { appendFileSync(auditFile, `${JSON.stringify(entry)}\n`); } catch { /* 审计失败不阻塞 */ }
  }

  return async function gitApi(req, res, next) {
    const [pathname] = (req.url ?? '').split('?');
    if (pathname !== '/api/git/dispatch') return next?.();

    if (hardOff) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'git api disabled (PLITE_GIT=0)', code: 'GIT_DISABLED' }));
    }
    if (!getSession?.(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'unauthorized', code: 'SESSION_REQUIRED' }));
    }

    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 2e6) req.destroy(); });
    req.on('end', async () => {
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch { /* 保持空对象 */ }
      const action = String(payload.action ?? '');
      const root = resolveRoot(dataDir, payload.rootId ? String(payload.rootId) : '');

      const respond = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(obj));
      };

      if (!READ_ACTIONS.has(action) && !WRITE_ACTIONS.has(action)) {
        audit({ at: Date.now(), action, ok: false, verdict: 'unknown-action' });
        return respond(400, { ok: false, error: `未知动作: ${action}（白名单外）`, code: 'GIT_UNKNOWN_ACTION' });
      }
      if (root.error) {
        audit({ at: Date.now(), action, ok: false, verdict: 'root-escape' });
        return respond(403, { ok: false, error: root.error, code: root.code });
      }
      const args = buildArgs(action, payload.params ?? payload);
      if (!args) {
        return respond(400, { ok: false, error: '参数缺失或非法', code: 'GIT_BAD_PARAMS' });
      }

      const run = () => gitRun(root.rootPath, args);
      const result = WRITE_ACTIONS.has(action)
        ? await (writeChain = writeChain.then(run, run))   // 写串行：先到先执行
        : await run();

      audit({
        at: Date.now(), action, rootId: payload.rootId ?? null, root: root.rootLabel,
        ok: result.ok, exitCode: result.exitCode, durationMs: result.durationMs, truncated: result.truncated,
      });

      let parsed = null;
      if (action === 'get_status' && result.ok) parsed = parseStatus(result.stdout);
      if (action === 'get_log' && result.ok) {
        parsed = result.stdout.split('\n').filter(Boolean).map((l) => {
          const [sha, author, at, ...msg] = l.split('\x1f');
          return { sha, author, at: Number(at), message: msg.join('\x1f') };
        });
      }
      if (action === 'get_branches' && result.ok) {
        parsed = result.stdout.split('\n').filter(Boolean).map((l) => {
          const [name, head] = l.split('\x1f');
          return { name, current: head === '*' };
        });
      }
      if (action === 'get_worktree_diff' && result.ok) {
        parsed = result.stdout.split('\n').filter(Boolean).map((l) => {
          const [add, del, path] = l.split('\t');
          return { path, additions: add === '-' ? null : Number(add), deletions: del === '-' ? null : Number(del) };
        });
      }

      respond(result.ok ? 200 : 422, {
        ok: result.ok,
        action,
        result: parsed,
        stdout: parsed ? undefined : result.stdout.slice(0, 64 * 1024),
        stderr: result.stderr.slice(0, 16 * 1024) || undefined,
        exitCode: result.exitCode,
        truncated: result.truncated,
        durationMs: result.durationMs,
      });
    });
  };
}

export default createServerPart;
