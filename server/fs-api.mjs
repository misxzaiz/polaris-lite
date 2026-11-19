/**
 * 文件浏览器 API（GET /api/fs/*）：盘符枚举 + 工作区根白名单 + 只读浏览/预览。
 *
 * 定位：与 relay/tool-exec 同层的宿主平台设施（浏览器沙箱无法读文件系统）；
 * 业务（面板 UI、工作区语义、AI 工具）在 file-browser 插件。设计见
 * docs/file-browser-analysis.md。
 *
 * 安全设计（公网穿透形态下这是第一议题）：
 * - 会话 cookie 硬门禁；PLITE_FS=0 一键禁用；
 * - **roots 白名单**：只有登记过的目录才可 list/read；登记与访问都走 realpath
 *   校验（Windows junction/符号链接会骗过字符串前缀匹配——必须解析真实路径）；
 * - 永久禁区：dataDir 除内建 workspace 外全体（providers.json/auth-owner/sessions/
 *   配置与审计）、系统目录；即使登记为 root 也硬拒；
 * - 盘符一级目录不可登记为 root（等于把整机交给 AI）；
 * - 全只读：本文件不提供任何写接口；写入走 bash 工具的既有审批/审计链；
 * - 限额：目录单次 500 项；文本预览 ≤512KB；二进制 ≤1MB 且扩展名白名单；
 * - 审计：list/read 各落一行到 fs-audit.log。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { resolve, join, sep, extname, dirname } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';

const LIST_LIMIT = 500;
const TEXT_PREVIEW_CAP = 512 * 1024;
const BINARY_PREVIEW_CAP = 1024 * 1024;
/** 二进制预览扩展名白名单（图片先服务 UI 缩略；其余二进制一律只给元信息） */
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp']);

/** 永久禁区（realpath 前缀匹配；登记与访问双重校验） */
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

function pathDepth(p) {
  // Windows: 'D:\\a' → 2 段；unix: '/a' → 1 段。盘符根（'D:\\' 或 '/'）深度不足 1 的子目录即拒绝
  const norm = p.replace(/[\\/]+$/, '');
  return norm.split(/[\\/]/).filter(Boolean).length;
}

export function createFsApi(options = {}) {
  const getSession = options.getSession;
  const dataDir = resolve(options.dataDir ?? '.polaris-lite');
  const rootsFile = resolve(dataDir, 'workspace-roots.json');
  const auditFile = resolve(dataDir, 'fs-audit.log');
  const hardOff = process.env.PLITE_FS === '0';
  const zones = forbiddenZones();
  const dataDirZone = resolve(dataDir);

  mkdirSync(dataDir, { recursive: true });

  /** builtin 根：<dataDir>/workspace（bash 工具的默认 cwd，不可移除） */
  const builtinRoot = resolve(dataDir, 'workspace');
  mkdirSync(builtinRoot, { recursive: true });

  const hashId = (p) => 'r-' + createHash('sha256').update(p).digest('hex').slice(0, 10);

  function readRoots() {
    try {
      if (!existsSync(rootsFile)) return null;
      const raw = JSON.parse(readFileSync(rootsFile, 'utf8'));
      const list = Array.isArray(raw.roots) ? raw.roots.filter((r) => r && typeof r.path === 'string') : [];
      return list.map((r) => ({
        id: typeof r.id === 'string' && r.id ? r.id : hashId(r.path),
        path: r.path,
        label: typeof r.label === 'string' && r.label ? r.label : r.path.split(/[\\/]/).filter(Boolean).pop() || r.path,
        builtin: r.builtin === true,
      }));
    } catch {
      return null;
    }
  }

  function writeRoots(roots) {
    const tmp = `${rootsFile}.tmp`;
    writeFileSync(tmp, JSON.stringify({ roots }, null, 2));
    renameSync(tmp, rootsFile); // 原子写
  }

  /** 当前根表：内置 + 登记表（去重；登记路径失效保留但标 missing） */
  function currentRoots() {
    const saved = readRoots() ?? [];
    const map = new Map();
    for (const r of saved) map.set(r.path, r);
    if (![...map.values()].some((r) => r.builtin)) {
      map.set(builtinRoot, { id: hashId(builtinRoot), path: builtinRoot, label: 'workspace', builtin: true });
    }
    return [...map.values()].map((r) => ({ ...r, missing: !existsSync(r.path) }));
  }

  /** realpath 防逃逸校验：解析真实路径并逐一检查禁区与根归属 */
  function safeResolve(rootPath, relPath) {
    const target = resolve(join(rootPath, relPath || '.'));
    let real;
    try {
      real = realpathSync(target);
    } catch {
      return { error: '路径不存在或不可访问', code: 'FS_NOT_FOUND' };
    }
    const realRoot = realpathSync(rootPath);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) {
      return { error: '路径越出工作区根（含符号链接逃逸）', code: 'FS_ESCAPE' };
    }
    // dataDir 是禁区，但内建 workspace 根（dataDir/workspace）例外——它本身就是
    // 合法浏览目标；用白名单前缀放行，其余 dataDir 内容仍全拒（providers/auth/审计）
    if (inZone(real, dataDirZone) && !inZone(real, builtinRoot)) {
      return { error: `禁止访问：${dataDirZone}`, code: 'FS_FORBIDDEN' };
    }
    for (const z of zones) {
      if (inZone(real, z)) return { error: `禁止访问：${z}`, code: 'FS_FORBIDDEN' };
    }
    return { real, realRoot };
  }

  function audit(entry) {
    try {
      mkdirSync(dirname(rootsFile), { recursive: true });
      appendFileSync(auditFile, `${JSON.stringify(entry).replace(/\n/g, ' ')}\n`);
    } catch { /* 审计失败不阻塞 */ }
  }

  const drives = () => {
    if (process.platform === 'win32') {
      const out = [];
      for (let c = 65; c <= 90; c += 1) {
        const d = `${String.fromCharCode(c)}:\\`;
        if (existsSync(d)) out.push({ id: d, path: d, label: d });
      }
      return out;
    }
    return [{ id: '/', path: '/', label: '/' }];
  };

  return async function fsApi(req, res, next) {
    const [pathname] = (req.url ?? '').split('?');
    if (!pathname.startsWith('/api/fs/')) return next?.();

    if (hardOff) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'fs api disabled (PLITE_FS=0)', code: 'FS_DISABLED' }));
    }
    const session = getSession?.(req);
    if (!session) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'unauthorized', code: 'SESSION_REQUIRED' }));
    }

    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(obj));
    };
    const readBody = () => new Promise((r) => {
      let b = '';
      req.on('data', (c) => { b += c; if (b.length > 65536) req.destroy(); });
      req.on('end', () => r(b));
    });

    try {
      const roots = currentRoots();
      const findRoot = (id) => roots.find((r) => r.id === id || r.path === id);

      if (pathname === '/api/fs/roots' && req.method === 'GET') {
        return send(200, { roots });
      }

      if (pathname === '/api/fs/drives' && req.method === 'GET') {
        return send(200, { drives: drives() });
      }

      if (pathname === '/api/fs/roots' && req.method === 'POST') {
        const body = JSON.parse((await readBody()) || '{}');
        const raw = String(body.path ?? '').trim();
        const label = String(body.label ?? '').trim();
        if (!raw) return send(400, { error: 'path required', code: 'BAD_REQUEST' });
        let real;
        try {
          if (!existsSync(raw)) return send(404, { error: `目录不存在：${raw}`, code: 'FS_ROOT_MISSING' });
          real = realpathSync(resolve(raw));
          const st = statSync(real);
          if (!st.isDirectory()) return send(400, { error: '只能登记目录', code: 'FS_ROOT_NOT_DIR' });
        } catch (e) {
          return send(400, { error: String(e.message ?? e), code: 'BAD_REQUEST' });
        }
        // 盘符一级不可为 root（'D:\' depth=1；'D:\x' depth=2 —— 低于 2 即拒）
        if (process.platform === 'win32' && pathDepth(real) < 2) {
          return send(400, { error: '不能把盘符根目录登记为工作区（范围过大）', code: 'FS_ROOT_TOO_SHALLOW' });
        }
        for (const z of zones) {
          if (inZone(real, z)) return send(403, { error: `该目录在永久禁区内：${z}`, code: 'FS_ROOT_FORBIDDEN' });
        }
        if (real.includes(`${sep}.polaris-lite`)) return send(403, { error: '不能登记数据目录', code: 'FS_ROOT_FORBIDDEN' });
        if (roots.some((r) => realpathSafe(r.path) === real)) {
          return send(409, { error: '该目录已是工作区根', code: 'FS_ROOT_DUPLICATE' });
        }
        const entry = { id: hashId(real), path: real, label: label || real.split(/[\\/]/).filter(Boolean).pop() || real, builtin: false };
        writeRoots([...roots.filter((r) => !r.builtin), entry]);
        audit({ at: Date.now(), op: 'add-root', path: real, user: session.user?.name });
        return send(200, { roots: currentRoots() });
      }

      if (pathname === '/api/fs/roots/remove' && req.method === 'POST') {
        const body = JSON.parse((await readBody()) || '{}');
        const root = findRoot(String(body.id ?? ''));
        if (!root) return send(404, { error: 'root not found', code: 'FS_ROOT_NOT_FOUND' });
        if (root.builtin) return send(403, { error: '内建 workspace 根不可移除', code: 'FS_ROOT_BUILTIN' });
        writeRoots(currentRoots().filter((r) => r.id !== root.id));
        audit({ at: Date.now(), op: 'remove-root', path: root.path, user: session.user?.name });
        return send(200, { roots: currentRoots() });
      }

      if (pathname === '/api/fs/list' && req.method === 'GET') {
        const q = new URLSearchParams((req.url.split('?')[1] ?? ''));
        const root = findRoot(q.get('rootId') ?? '');
        if (!root) return send(400, { error: 'unknown rootId', code: 'FS_ROOT_NOT_FOUND' });
        const sv = safeResolve(root.path, q.get('path') ?? '');
        if (sv.error) return send(403, sv);
        const st = statSync(sv.real);
        if (!st.isDirectory()) return send(400, { error: 'not a directory', code: 'FS_NOT_DIR' });
        let names;
        try {
          names = readdirSync(sv.real);
        } catch (e) {
          return send(403, { error: String(e.message ?? e), code: 'FS_LIST_DENIED' });
        }
        const entries = [];
        let truncated = false;
        for (const name of names.sort((a, b) => a.localeCompare(b, 'zh'))) {
          if (name.startsWith('.') && name !== '.gitignore') continue; // 隐藏文件噪声过滤
          if (entries.length >= LIST_LIMIT) { truncated = true; break; }
          try {
            const s = statSync(join(sv.real, name));
            entries.push({ name, isDir: s.isDirectory(), size: s.isDirectory() ? undefined : s.size, mtime: s.mtimeMs });
          } catch { /* 单项 stat 失败跳过（权限/占用） */ }
        }
        audit({ at: Date.now(), op: 'list', rootId: root.id, path: q.get('path') ?? '', count: entries.length, user: session.user?.name });
        return send(200, { entries, truncated });
      }

      if (pathname === '/api/fs/read' && req.method === 'GET') {
        const q = new URLSearchParams((req.url.split('?')[1] ?? ''));
        const root = findRoot(q.get('rootId') ?? '');
        if (!root) return send(400, { error: 'unknown rootId', code: 'FS_ROOT_NOT_FOUND' });
        const rel = q.get('path') ?? '';
        const head = Math.max(0, Number(q.get('head')) || 0);
        const tail = Math.max(0, Number(q.get('tail')) || 0);
        const sv = safeResolve(root.path, rel);
        if (sv.error) return send(403, sv);
        const st = statSync(sv.real);
        if (st.isDirectory()) return send(400, { error: 'is directory', code: 'FS_IS_DIR' });
        const ext = extname(sv.real).toLowerCase();
        const isText = !BINARY_EXT.has(ext) && looksTextable(ext);
        if (st.size > (isText ? TEXT_PREVIEW_CAP : BINARY_PREVIEW_CAP)) {
          audit({ at: Date.now(), op: 'read-oversize', rootId: root.id, path: rel, size: st.size, user: session.user?.name });
          return send(200, {
            tooLarge: true, size: st.size, isText,
            hint: isText ? '文件超过 512KB 预览上限，可用 head/tail 参数取片段（或让 AI 用 bash 取）' : '文件超过 1MB 二进制预览上限',
          });
        }
        const buf = readFileSync(sv.real);
        audit({ at: Date.now(), op: 'read', rootId: root.id, path: rel, size: st.size, user: session.user?.name });
        if (isText) {
          let text = buf.toString('utf8');
          if (head) text = text.split('\n').slice(0, head).join('\n');
          else if (tail) {
            const lines = text.split('\n');
            text = lines.slice(Math.max(0, lines.length - tail)).join('\n');
          }
          return send(200, { isText: true, text, size: st.size, mtime: st.mtimeMs, truncated: head > 0 || tail > 0 });
        }
        return send(200, { isText: false, ext, data: buf.toString('base64'), size: st.size, mtime: st.mtimeMs });
      }

      return send(404, { error: 'unknown fs endpoint', code: 'FS_NOT_FOUND' });
    } catch (e) {
      return send(500, { error: String(e.message ?? e), code: 'FS_ERROR' });
    }
  };
}

/** 常见文本扩展名之外，按启发式放行（脚本/配置/无扩展名大多可安全按 utf-8 预览） */
function looksTextable(ext) {
  if (!ext) return true;
  const bin = new Set(['.exe', '.dll', '.so', '.dylib', '.zip', '.gz', '.7z', '.rar', '.tar', '.mp3', '.mp4', '.wav', '.avi', '.mov', '.wasm', '.class', '.jar', '.node', '.pdb', '.ttf', '.otf', '.woff', '.woff2', '.pdf', '.docx', '.xlsx', '.pptx', '.sqlite', '.db']);
  return !bin.has(ext);
}

function realpathSafe(p) {
  try { return realpathSync(resolve(p)); } catch { return resolve(p); }
}
