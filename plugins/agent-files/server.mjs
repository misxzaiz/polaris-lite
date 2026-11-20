/**
 * agent-files 插件服务端半边（POST /api/files-write/exec）。
 *
 * 定位：给 polaris-lite 的 AI 工具面补「结构化文件写/编辑」能力——
 * file-browser 的 cap.tool.fs 只有只读（roots/list/read），写文件此前全靠
 * agent-bash 的命令行凑（echo >/Set-Content），转义/编码/行尾易翻车且没有
 * 精确替换语义。本插件提供三个动作：
 *   write  写整文件（建父目录、保持既有行尾、UTF-8）
 *   edit   old_string 精确替换（唯一性校验 / expected_replacements / 最近行提示）
 *   patch  codex V4A 信封多文件补丁（Add/Delete/Update/Move to + 锚点）
 *
 * 安全模型（对齐 agent-bash / file-browser 既有约定，不另起炉灶）：
 * - 会话 cookie 或本地回环 Bearer 门禁（同 agent-bash ①）；
 * - 路径边界：目标必须落在 内建 workspace（<dataDir>/workspace）或
 *   workspace-roots.json 已登记根内（realpath 防符号链接逃逸）；
 *   dataDir 禁区（providers/auth/审计）与系统禁区（C:\Windows 等）沿用
 *   file-browser 的禁区清单；
 * - 二进制扩展名拒写（防把图片/数据库当文本覆盖）；
 * - edit 冲突检测：登记 read 时的 mtime，写前不符则拒绝（防覆盖外部修改）；
 * - 大小上限：单文件 2MB / patch 请求体 4MB；
 * - PLITE_FILES_WRITE=0 一键整体禁用；
 * - 全量审计落 <dataDir>/files-write-audit.log。
 *
 * 审批说明：审批在 agent-loop 的 decideApproval 统一裁决（danger: 'write'
 * → confirm 模式弹审批卡 / 会话信任 / 白名单）。服务端只做门禁+边界+审计，
 * 不重复审批（与 agent-bash 的 approved 语义一致）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, statSync, realpathSync, unlinkSync } from 'node:fs';
import { resolve, sep, extname, dirname } from 'node:path';

const MAX_FILE_BYTES = 2 * 1024 * 1024;      // 单文件写入上限
const MAX_PATCH_BYTES = 4 * 1024 * 1024;     // patch 请求总内容上限
const MAX_LINES_FEEDBACK = 4000;             // 结果摘要最大行数

/** 二进制扩展名：拒写（同 file-browser 的 BINARY_EXT 口径 + 常见数据/可执行） */
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp',
  '.exe', '.dll', '.so', '.dylib', '.zip', '.gz', '.7z', '.rar', '.tar',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.wasm', '.class', '.jar', '.node',
  '.pdb', '.ttf', '.otf', '.woff', '.woff2', '.pdf', '.docx', '.xlsx', '.pptx',
  '.sqlite', '.db',
]);

/** 永久禁区（realpath 前缀匹配；与 file-browser forbiddenZones 同清单） */
function forbiddenZones() {
  return [
    resolve('C:\\Windows'),
    resolve('C:\\Program Files'),
    resolve('C:\\Program Files (x86)'),
    resolve('/etc'), resolve('/usr'), resolve('/bin'), resolve('/sbin'), resolve('/var'),
  ];
}

function inZone(p, zone) {
  return p === zone || p.startsWith(zone + sep);
}

export function createServerPart(options = {}) {
  const getSession = options.getSession;
  const verifyTempToken = options.verifyTempToken ?? ((token) => false);
  const dataDir = resolve(options.dataDir ?? '.polaris-lite');
  const rootsFile = resolve(dataDir, 'workspace-roots.json');
  const auditFile = resolve(dataDir, 'files-write-audit.log');
  const hardOff = process.env.PLITE_FILES_WRITE === '0';
  const zones = forbiddenZones();
  const dataDirZone = resolve(dataDir);
  const builtinRoot = resolve(dataDir, 'workspace');
  mkdirSync(builtinRoot, { recursive: true });

  /** read 工具的 mtime 登记（edit 冲突检测）：realPath → mtimeMs。进程内存态。 */
  const readRegistry = new Map();

  function audit(entry) {
    try {
      mkdirSync(dirname(auditFile), { recursive: true });
      appendFileSync(auditFile, `${JSON.stringify(entry).replace(/\n/g, ' ')}\n`);
    } catch { /* 审计失败不阻塞 */ }
  }

  function readRoots() {
    try {
      if (!existsSync(rootsFile)) return [];
      const raw = JSON.parse(readFileSync(rootsFile, 'utf8'));
      return (Array.isArray(raw.roots) ? raw.roots : [])
        .map((r) => String(r.path ?? ''))
        .filter(Boolean);
    } catch { return []; }
  }

  /**
   * 写路径边界校验：目标（绝对）必须位于 内建 workspace 或任一登记根内，
   * 且不落入 dataDir 禁区（workspace 本身例外）与系统禁区。
   * 与 file-browser 的差别：这里是**写**面，不提供 L0 会话漫游（只读特权不放行到写）。
   */
  function resolveSafeWritePath(rootId, absOrRel) {
    if (typeof absOrRel !== 'string' || !absOrRel.trim()) {
      return { error: 'path required', code: 'PATH_REQUIRED' };
    }
    let rootPath = null;
    if (rootId) {
      const roots = readRoots();
      const hit = roots.find((p) => p === rootId || p.endsWith(rootId));
      if (hit) rootPath = hit;
      else return { error: `unknown rootId: ${rootId}`, code: 'ROOT_NOT_FOUND' };
    }
    const raw = String(absOrRel);
    const target = rootPath ? resolve(rootPath, raw) : resolve(raw);
    // 目标存在 → 直接 realpath；不存在（新建）→ 用「存在的最近祖先的 realpath +
    // 原始尾段」重组，保证 mkdir 前也能做边界判定（win32 上 mkdir 前文件不存在）。
    let real;
    if (existsSync(target)) {
      try {
        real = realpathSync(target);
      } catch {
        return { error: '路径不存在或不可访问', code: 'PATH_NOT_FOUND' };
      }
    } else {
      // 从目标向上找最近一个存在的祖先，用其 realpath + 相对尾段重组。
      // 注意尾段必须完整保留「祖先之下」的所有段（含不存在的中间目录）。
      let anchor = target;
      const tail = [];
      for (let guard = 0; guard < 64; guard += 1) {
        const parent = dirname(anchor);
        if (parent === anchor) break;
        const relSeg = anchor.slice(parent.length).replace(/^[\\/]+/, '');
        if (relSeg) tail.push(relSeg);
        if (existsSync(parent)) {
          let parentReal;
          try { parentReal = realpathSync(parent); } catch { break; }
          tail.reverse();
          real = resolve(parentReal, ...tail);
          break;
        }
        anchor = parent;
      }
      if (!real) real = resolve(target);
    }
    const roots = [builtinRoot, ...readRoots().map((p) => { try { return realpathSync(p); } catch { return ''; } }).filter(Boolean)];
    const within = roots.some((root) => real === root || real.startsWith(root + sep));
    if (!within) {
      return { error: '路径越出工作区根（写面只允许内建 workspace 与已登记根）', code: 'PATH_ESCAPE' };
    }
    if (inZone(real, dataDirZone) && !inZone(real, builtinRoot)) {
      return { error: `禁止写入：${dataDirZone}`, code: 'FORBIDDEN' };
    }
    for (const z of zones) {
      if (inZone(real, z)) return { error: `禁止写入：${z}`, code: 'FORBIDDEN' };
    }
    return { real };
  }

  function detectLineEndings(content) {
    if (content.includes('\r\n')) return '\r\n';
    if (content.includes('\r')) return '\r';
    return '\n';
  }

  function applyLineEndings(lfContent, eol) {
    if (eol === '\n') return lfContent;
    return lfContent.replace(/\r?\n/g, eol).replace(/\r$/, '');
  }

  function similarity(a, b) {
    if (!a.length || !b.length) return 0;
    let maxLen = 0;
    for (let i = 0; i < a.length; i += 1) {
      for (let j = 0; j < b.length; j += 1) {
        let k = 0;
        while (i + k < a.length && j + k < b.length && a[i + k] === b[j + k]) k += 1;
        if (k > maxLen) maxLen = k;
      }
    }
    return Math.floor((maxLen * 100) / Math.max(a.length, b.length));
  }

  function closestLineHint(content, oldString) {
    const needle = (oldString.split('\n')[0] || oldString).trim();
    if (!needle) return '';
    let best = null;
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const score = similarity(needle, trimmed);
      if (!best || score > best.score) best = { score, line };
    }
    if (best && best.score >= 40) return `Closest line: "${best.line.trim()}"`;
    return '';
  }

  // ── apply_patch（codex V4A 信封；与宿主侧 apply_patch 同 grammar 的 JS 移植）──

  const PATCH_BEGIN = '*** Begin Patch';
  const PATCH_END = '*** End Patch';
  const ADD_FILE = '*** Add File:';
  const DELETE_FILE = '*** Delete File:';
  const UPDATE_FILE = '*** Update File:';
  const MOVE_TO = '*** Move to:';
  const END_OF_FILE = '*** End of File';

  function stripMarker(trimmed, marker) {
    if (trimmed.startsWith(marker)) return trimmed.slice(marker.length).trim();
    return null;
  }

  function isFileMarker(line) {
    const t = line.trim();
    return t.startsWith(ADD_FILE) || t.startsWith(DELETE_FILE) || t.startsWith(UPDATE_FILE) || t === PATCH_END;
  }

  function parsePatch(patch) {
    const lines = String(patch || '').split(/\r?\n/);
    const begin = lines.findIndex((l) => l.trim() === PATCH_BEGIN);
    if (begin === -1) throw new Error("patch must start with '*** Begin Patch'");
    const ops = [];
    let i = begin + 1;
    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();
      if (trimmed === PATCH_END) break;
      const addRest = stripMarker(trimmed, ADD_FILE);
      if (addRest !== null) {
        const content = [];
        i += 1;
        while (i < lines.length && !isFileMarker(lines[i])) {
          const l = lines[i];
          content.push(l.startsWith('+') ? l.slice(1) : l);
          i += 1;
        }
        ops.push({ type: 'add', path: addRest, content: content.join('\n') });
        continue;
      }
      const delRest = stripMarker(trimmed, DELETE_FILE);
      if (delRest !== null) {
        ops.push({ type: 'delete', path: delRest });
        i += 1;
        continue;
      }
      const updRest = stripMarker(trimmed, UPDATE_FILE);
      if (updRest !== null) {
        i += 1;
        let moveTo = null;
        if (i < lines.length) {
          const m = stripMarker(lines[i].trim(), MOVE_TO);
          if (m !== null) { moveTo = m; i += 1; }
        }
        const chunks = [];
        let cur = null;
        while (i < lines.length && !isFileMarker(lines[i])) {
          const l = lines[i];
          if (l.startsWith('@@')) {
            if (cur) chunks.push(cur);
            const ctx = l.slice(2).trim();
            cur = { context: ctx || null, oldLines: [], newLines: [] };
            i += 1;
            continue;
          }
          if (l.trim() === END_OF_FILE) { i += 1; continue; }
          if (!cur) cur = { context: null, oldLines: [], newLines: [] };
          if (l.startsWith('+')) cur.newLines.push(l.slice(1));
          else if (l.startsWith('-')) cur.oldLines.push(l.slice(1));
          else if (l.startsWith(' ')) { cur.oldLines.push(l.slice(1)); cur.newLines.push(l.slice(1)); }
          else { cur.oldLines.push(l); cur.newLines.push(l); }
          i += 1;
        }
        if (cur) chunks.push(cur);
        ops.push({ type: 'update', path: updRest, moveTo, chunks });
        continue;
      }
      i += 1;
    }
    if (ops.length === 0) throw new Error('no file operations found in patch');
    return ops;
  }

  function applyChunks(content, chunks, pathForErr) {
    const normalized = content.replace(/\r\n/g, '\n');
    const trailingNewline = normalized.endsWith('\n');
    const lines = normalized.split('\n');
    if (trailingNewline) lines.pop();
    let searchFrom = 0;
    const linesEq = (a, b) => a.trimEnd() === b.trimEnd();
    const findLine = (target, from) => {
      for (let i = from; i < lines.length; i += 1) if (linesEq(lines[i], target)) return i;
      return -1;
    };
    const findSub = (needle, from) => {
      if (!needle.length) return from;
      outer:
      for (let i = from; i + needle.length <= lines.length; i += 1) {
        for (let k = 0; k < needle.length; k += 1) {
          if (!linesEq(lines[i + k], needle[k])) continue outer;
        }
        return i;
      }
      return -1;
    };
    chunks.forEach((chunk, ci) => {
      let start = searchFrom;
      if (chunk.context) {
        const idx = findLine(chunk.context, searchFrom);
        if (idx === -1) throw new Error(`chunk ${ci + 1}: context anchor '${chunk.context}' not found in ${pathForErr}`);
        start = idx + 1;
      }
      if (!chunk.oldLines.length) {
        lines.splice(start, 0, ...chunk.newLines);
        searchFrom = start + chunk.newLines.length;
        return;
      }
      const pos = findSub(chunk.oldLines, start);
      if (pos === -1) {
        throw new Error(
          `chunk ${ci + 1}: could not locate the lines to replace in ${pathForErr}.\n`
          + `Expected context (first 3 lines):\n${chunk.oldLines.slice(0, 3).map((l) => `  ${JSON.stringify(l)}`).join('\n')}\n`
          + `Hint: the file may have changed since you read it. Re-read it first.`,
        );
      }
      lines.splice(pos, chunk.oldLines.length, ...chunk.newLines);
      searchFrom = pos + chunk.newLines.length;
    });
    let out = lines.join('\n');
    if (trailingNewline) out += '\n';
    return out;
  }

  // ── 三个动作实现 ──────────────────────────────────────────────────────────

  function doWrite(args) {
    const chk = resolveSafeWritePath(args.rootId, args.path);
    if (chk.error) return chk;
    const real = chk.real;
    if (existsSync(real) && statSync(real).isDirectory()) {
      return { error: `目标是目录，不能当文件写入: ${real}`, code: 'IS_DIR' };
    }
    const ext = extname(real).toLowerCase();
    if (BINARY_EXT.has(ext)) {
      return { error: `拒绝写入二进制扩展名 ${ext}（文本工具不写二进制）`, code: 'BINARY_DENIED' };
    }
    const content = String(args.content ?? '');
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
      return { error: `内容超过单文件上限 ${Math.round(MAX_FILE_BYTES / 1024)}KB`, code: 'TOO_LARGE' };
    }
    let eol = '\n';
    try { eol = detectLineEndings(readFileSync(real, 'utf8')); } catch { /* 新文件默认 \n */ }
    const normalized = applyLineEndings(content, eol);
    mkdirSync(dirname(real), { recursive: true });
    writeFileSync(real, normalized, 'utf8');
    try { readRegistry.set(real, statSync(real).mtimeMs); } catch { /* ignore */ }
    return {
      ok: true,
      action: 'write',
      path: real,
      bytes: Buffer.byteLength(normalized, 'utf8'),
      eol: eol === '\r\n' ? 'CRLF' : 'LF',
    };
  }

  function doEdit(args) {
    const chk = resolveSafeWritePath(args.rootId, args.path);
    if (chk.error) return chk;
    const real = chk.real;
    if (!existsSync(real)) return { error: `文件不存在: ${real}`, code: 'NOT_FOUND' };
    const ext = extname(real).toLowerCase();
    if (BINARY_EXT.has(ext)) return { error: `拒绝编辑二进制文件 ${ext}`, code: 'BINARY_DENIED' };
    const content = readFileSync(real, 'utf8');
    // mtime 冲突检测：read 之后被外部修改则拒绝（防盲覆盖）
    const regMtime = readRegistry.get(real);
    const curMtime = statSync(real).mtimeMs;
    if (regMtime !== undefined && regMtime !== curMtime) {
      return {
        error: `文件在读取后被外部修改（mtime ${regMtime} → ${curMtime}），请重新读取再编辑`,
        code: 'STALE_READ',
      };
    }
    const oldString = args.old_string;
    if (typeof oldString !== 'string' || !oldString) return { error: 'old_string required', code: 'BAD_REQUEST' };
    const newString = args.new_string;
    if (typeof newString !== 'string') return { error: 'new_string required（删除内容请传空串）', code: 'BAD_REQUEST' };
    const expected = args.expected_replacements === undefined || args.expected_replacements === null
      ? null : Number(args.expected_replacements);
    const matches = content.split(oldString).length - 1;
    if (matches === 0) {
      const hint = closestLineHint(content, oldString);
      return {
        error: `old_string was not found in '${real}'. It must match exactly (including whitespace and line endings). Re-read the file and copy the exact text.${hint ? `\n${hint}` : ''}`,
        code: 'NOT_MATCHED',
      };
    }
    if (matches > 1 && expected === null) {
      return {
        error: `old_string appears ${matches} times in '${real}' — ambiguous. Add expected_replacements=${matches} to replace all, or make old_string more specific.`,
        code: 'AMBIGUOUS',
      };
    }
    if (expected !== null && expected !== matches) {
      return { error: `old_string appears ${matches} times, but expected_replacements=${expected}`, code: 'COUNT_MISMATCH' };
    }
    const updated = matches > 1 ? content.split(oldString).join(newString) : content.replace(oldString, newString);
    const eol = detectLineEndings(content);
    const fixed = applyLineEndings(updated, eol);
    writeFileSync(real, fixed, 'utf8');
    try { readRegistry.set(real, statSync(real).mtimeMs); } catch { /* ignore */ }
    return { ok: true, action: 'edit', path: real, replacements: matches };
  }

  function doPatch(args) {
    const patch = String(args.patch ?? args.input ?? '');
    if (!patch.trim()) return { error: 'patch required', code: 'BAD_REQUEST' };
    if (Buffer.byteLength(patch, 'utf8') > MAX_PATCH_BYTES) {
      return { error: `patch 超过上限 ${Math.round(MAX_PATCH_BYTES / 1024)}KB`, code: 'TOO_LARGE' };
    }
    let ops;
    try { ops = parsePatch(patch); } catch (e) {
      return { error: `parse error: ${e.message}`, code: 'PARSE_ERROR' };
    }
    const summary = [];
    for (const op of ops) {
      try {
        if (op.type === 'add') {
          const chk = resolveSafeWritePath(args.rootId, op.path);
          if (chk.error) return { ...chk, op: op.path };
          const real = chk.real;
          if (BINARY_EXT.has(extname(real).toLowerCase())) return { error: `拒绝写入二进制扩展名: ${op.path}`, code: 'BINARY_DENIED', op: op.path };
          mkdirSync(dirname(real), { recursive: true });
          writeFileSync(real, op.content, 'utf8');
          summary.push(`Added ${op.path}`);
        } else if (op.type === 'delete') {
          const chk = resolveSafeWritePath(args.rootId, op.path);
          if (chk.error) return { ...chk, op: op.path };
          if (!existsSync(chk.real)) return { error: `delete: 文件不存在 ${op.path}`, code: 'NOT_FOUND', op: op.path };
          unlinkSync(chk.real);
          readRegistry.delete(chk.real);
          summary.push(`Deleted ${op.path}`);
        } else {
          const chk = resolveSafeWritePath(args.rootId, op.path);
          if (chk.error) return { ...chk, op: op.path };
          const real = chk.real;
          if (!existsSync(real)) return { error: `update: 文件不存在 ${op.path}`, code: 'NOT_FOUND', op: op.path };
          if (BINARY_EXT.has(extname(real).toLowerCase())) return { error: `拒绝编辑二进制文件: ${op.path}`, code: 'BINARY_DENIED', op: op.path };
          const content = readFileSync(real, 'utf8');
          const updated = applyChunks(content, op.chunks, op.path);
          if (op.moveTo && op.moveTo !== op.path) {
            const dst = resolveSafeWritePath(args.rootId, op.moveTo);
            if (dst.error) return { ...dst, op: op.moveTo };
            mkdirSync(dirname(dst.real), { recursive: true });
            writeFileSync(dst.real, updated, 'utf8');
            unlinkSync(real);
            readRegistry.delete(real);
            summary.push(`Updated ${op.path} -> ${op.moveTo}`);
          } else {
            writeFileSync(real, updated, 'utf8');
            summary.push(`Updated ${op.path}`);
          }
        }
      } catch (e) {
        return { error: `patch failed at ${op.type} '${op.path}': ${e.message}`, code: 'APPLY_ERROR', op: op.path };
      }
    }
    return { ok: true, action: 'patch', summary };
  }

  // ── HTTP 中间件 ───────────────────────────────────────────────────────────

  return async function filesWriteApi(req, res, next) {
    const [pathname] = (req.url ?? '').split('?');
    if (pathname !== '/api/files-write/exec') return next?.();

    if (hardOff) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'files-write disabled (PLITE_FILES_WRITE=0)', code: 'FILES_WRITE_DISABLED' }));
    }
    // 门禁：会话 cookie 或本地回环 Bearer（同 agent-bash ①）
    const authHeader = String(req.headers.authorization ?? '');
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const bearerValid = !!(bearerToken && verifyTempToken(bearerToken));
    const session = getSession?.(req);
    if (!session && !bearerValid) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'unauthorized', code: 'SESSION_REQUIRED' }));
    }
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }

    const readBody = () => new Promise((r) => {
      let b = '';
      req.on('data', (c) => { b += c; if (b.length > 8 * 1024 * 1024) req.destroy(); });
      req.on('end', () => r(b));
    });
    let body;
    try { body = JSON.parse((await readBody()) || '{}'); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'bad json', code: 'BAD_REQUEST' }));
    }

    const action = String(body.action ?? '');
    const args = body;
    const user = session?.user?.name ?? (bearerValid ? 'bearer' : 'unknown');
    let result;
    if (action === 'write') result = doWrite(args);
    else if (action === 'edit') result = doEdit(args);
    else if (action === 'patch') result = doPatch(args);
    else {
      result = { error: `unknown action: ${action || '(empty)'}（可用：write/edit/patch）`, code: 'BAD_ACTION' };
    }
    audit({
      at: Date.now(), user, sessionId: String(body.sessionId ?? 'unknown'),
      action, path: String(body.path ?? ''), op: result.op,
      ok: result.ok === true, code: result.code, error: result.error,
    });
    const status = result.ok ? 200 : (result.code === 'PATH_ESCAPE' || result.code === 'FORBIDDEN' || result.code === 'BINARY_DENIED' ? 403 : 400);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(result));
  };
}
