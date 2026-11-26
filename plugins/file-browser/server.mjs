/**
 * file-browser 插件的服务端半边（GET/POST /api/fs/*）：盘符 + 工作区根 + 只读浏览/预览。
 *
 * 这是「插件双入口」的服务端那一半：UI 半边是 Panel.tsx（浏览器），本文件是它在
 * Node 侧的能力实现，由 plugins/server-registry.mjs 登记、server/host.mjs 统一装配。
 * 宿主不认识 /api/fs/* 的任何语义——本文件被删除时宿主照常启动，只是该端点 404。
 *
 * 为什么必须放服务端：浏览器沙箱无法读本地文件系统；但「读哪些目录、暴露多少」
 * 是 file-browser 的业务决策（工作区语义、L0 漫游），所以实现跟插件走，而不是留在宿主。
 * 设计见 docs/file-browser-analysis.md。
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

import { registerFilesTool } from './tool.mjs';

export function createServerPart(options = {}) {
  // 工具声明随插件：启用本插件即注册只读 files 工具；禁用即消失。
  if (options.registry) registerFilesTool(options.registry);
  const getSession = options.getSession;
  /** 临时 Bearer 凭证校验（auth-session 签发；仅本地回环 IP 可用） */
  const verifyTempToken = options.verifyTempToken ?? ((token) => false);
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
    // 登录门禁：会话 cookie 或临时 Bearer 凭证（auth-session 签发，仅本地回环 IP）二选一
    const authHeader = String(req.headers.authorization ?? '');
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const bearerValid = !!(bearerToken && verifyTempToken(bearerToken));
    const session = getSession?.(req);
    if (!session && !bearerValid) {
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

      /**
       * L0 会话漫游校验（v2 三级访问模型，docs/fs-tree-analysis.md §3.1）：
       * 任意非禁区目录只读浏览；不落盘、不进根表。PLITE_FS_SESSION=0 可单独禁用。
       * 禁区（dataDir 除 workspace 外/系统目录）与 realpath 校验复用，绝不放宽。
       */
      const sessionRoam = process.env.PLITE_FS_SESSION !== '0';
      const safeAbs = (rawPath) => {
        let real;
        try {
          real = realpathSync(resolve(String(rawPath ?? '')));
        } catch {
          return { error: '路径不存在或不可访问', code: 'FS_NOT_FOUND' };
        }
        if (inZone(real, dataDirZone) && !inZone(real, builtinRoot)) {
          return { error: `禁止访问：${dataDirZone}`, code: 'FS_FORBIDDEN' };
        }
        for (const z of zones) {
          if (inZone(real, z)) return { error: `禁止访问：${z}`, code: 'FS_FORBIDDEN' };
        }
        return { real };
      };

      if (pathname === '/api/fs/roots' && req.method === 'GET') {
        return send(200, { roots, sessionRoam });
      }

      if (pathname === '/api/fs/drives' && req.method === 'GET') {
        return send(200, { drives: drives(), sessionRoam });
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
        audit({ at: Date.now(), op: 'add-root', path: real, user: session?.user?.name });
        return send(200, { roots: currentRoots() });
      }

      // 重命名工作区根显示名（builtin label 不可改——「workspace」是约定名）
      if (pathname === '/api/fs/roots/rename' && req.method === 'POST') {
        const body = JSON.parse((await readBody()) || '{}');
        const id = String(body.id ?? '');
        const label = String(body.label ?? '').trim();
        const target = currentRoots().find((r) => r.id === id);
        if (!target) return send(404, { error: 'root not found', code: 'FS_ROOT_NOT_FOUND' });
        if (target.builtin) return send(403, { error: '内建 workspace 根不可重命名', code: 'FS_ROOT_BUILTIN' });
        if (!label) return send(400, { error: 'label required', code: 'BAD_REQUEST' });
        writeRoots(currentRoots().map((r) => (r.id === id ? { ...r, label } : r)));
        audit({ at: Date.now(), op: 'rename-root', path: target.path, label, user: session?.user?.name });
        return send(200, { roots: currentRoots() });
      }

      if (pathname === '/api/fs/roots/remove' && req.method === 'POST') {
        const body = JSON.parse((await readBody()) || '{}');
        const root = findRoot(String(body.id ?? ''));
        if (!root) return send(404, { error: 'root not found', code: 'FS_ROOT_NOT_FOUND' });
        if (root.builtin) return send(403, { error: '内建 workspace 根不可移除', code: 'FS_ROOT_BUILTIN' });
        writeRoots(currentRoots().filter((r) => r.id !== root.id));
        audit({ at: Date.now(), op: 'remove-root', path: root.path, user: session?.user?.name });
        return send(200, { roots: currentRoots() });
      }

      /**
       * 树主通道（v2）：单层节点 + hasChildren（懒加载契约）。
       * - dir 缺省：返回盘符 + 所有 L1 根（树的顶层骨架）
       * - dir=盘符/绝对路径：L0 漫游单层（sessionRoam 开关）
       * - rootId + path：L1 根内单层（与 list 同源同校验）
       */
      if (pathname === '/api/fs/tree' && req.method === 'GET') {
        const q = new URLSearchParams((req.url.split('?')[1] ?? ''));
        const rootId = q.get('rootId') ?? '';
        const dir = (q.get('dir') ?? '').trim();
        const filter = (q.get('filter') ?? '').trim().toLowerCase();

        // 顶层骨架：盘符 + L1 根
        if (!rootId && !dir) {
          const top = [];
          for (const r of roots) {
            top.push({ name: r.label, isDir: true, path: r.path, isRoot: true, rootId: r.id, builtin: !!r.builtin, missing: !!r.missing, hasChildren: !r.missing });
          }
          if (sessionRoam) {
            for (const d of drives()) {
              top.push({ name: d.label, isDir: true, path: d.path, isDrive: true, hasChildren: true });
            }
          }
          return send(200, { nodes: top, sessionRoam });
        }

        // L1 根内单层
        if (rootId) {
          const root = findRoot(rootId);
          if (!root) return send(400, { error: 'unknown rootId', code: 'FS_ROOT_NOT_FOUND' });
          const sv = safeResolve(root.path, dir);
          if (sv.error) return send(403, sv);
          let names;
          try { names = readdirSync(sv.real); } catch (e) {
            return send(403, { error: String(e.message ?? e), code: 'FS_LIST_DENIED' });
          }
          const nodes = [];
          for (const name of names.sort((a, b) => a.localeCompare(b, 'zh'))) {
            if (name.startsWith('.') && name !== '.gitignore') continue;
            if (filter && !name.toLowerCase().includes(filter)) continue;
            if (nodes.length >= LIST_LIMIT) break;
            try {
              const full = join(sv.real, name);
              const s = statSync(full);
              nodes.push({
                name, isDir: s.isDirectory(), path: join(dir === '' ? '' : dir, name).replace(/\\/g, '/'),
                relDir: dir, rootId, size: s.isDirectory() ? undefined : s.size, mtime: s.mtimeMs,
                hasChildren: s.isDirectory() ? hasChildrenSync(full) : undefined,
              });
            } catch { /* 权限/占用跳过 */ }
          }
          audit({ at: Date.now(), op: 'tree', rootId, path: dir, count: nodes.length, user: session?.user?.name });
          return send(200, { nodes, absoluteBase: sv.real });
        }

        // L0 漫游单层（dir 为绝对路径）
        if (!sessionRoam) return send(403, { error: '会话漫游已被禁用（PLITE_FS_SESSION=0）', code: 'FS_ROAM_DISABLED' });
        const sv = safeAbs(dir);
        if (sv.error) return send(403, sv);
        const st = statSync(sv.real);
        if (!st.isDirectory()) return send(400, { error: 'not a directory', code: 'FS_NOT_DIR' });
        let names;
        try { names = readdirSync(sv.real); } catch (e) {
          return send(403, { error: String(e.message ?? e), code: 'FS_LIST_DENIED' });
        }
        const nodes = [];
        for (const name of names.sort((a, b) => a.localeCompare(b, 'zh'))) {
          if (name.startsWith('.') && name !== '.gitignore') continue;
          if (filter && !name.toLowerCase().includes(filter)) continue;
          if (nodes.length >= LIST_LIMIT) break;
          try {
            const full = join(sv.real, name);
            const s = statSync(full);
            nodes.push({
              name, isDir: s.isDirectory(), path: full,
              size: s.isDirectory() ? undefined : s.size, mtime: s.mtimeMs,
              hasChildren: s.isDirectory() ? hasChildrenSync(full) : undefined,
            });
          } catch { /* 跳过 */ }
        }
        audit({ at: Date.now(), op: 'tree-roam', path: sv.real, count: nodes.length, user: session?.user?.name });
        return send(200, { nodes, absoluteBase: sv.real });
      }

      /** 「树上选文件夹设为工作区」的一步登记（内部=add root，前端从树节点直接调） */
      if (pathname === '/api/fs/roots/from-path' && req.method === 'POST') {
        const body = JSON.parse((await readBody()) || '{}');
        const raw = String(body.path ?? '').trim();
        const label = String(body.label ?? '').trim();
        if (!raw) return send(400, { error: 'path required', code: 'BAD_REQUEST' });
        const sv = safeAbs(raw);
        if (sv.error) return send(403, sv);
        if (!statSync(sv.real).isDirectory()) return send(400, { error: '只能登记目录', code: 'FS_ROOT_NOT_DIR' });
        if (process.platform === 'win32' && pathDepth(sv.real) < 2) {
          return send(400, { error: '不能把盘符根目录登记为工作区（范围过大）', code: 'FS_ROOT_TOO_SHALLOW' });
        }
        if (roots.some((r) => realpathSafe(r.path) === sv.real)) {
          // 已是根：直接返回（前端随后标记 active 即可）
          return send(200, { roots: currentRoots(), existing: true });
        }
        const entry = { id: hashId(sv.real), path: sv.real, label: label || sv.real.split(/[\\/]/).filter(Boolean).pop() || sv.real, builtin: false };
        writeRoots([...roots.filter((r) => !r.builtin), entry]);
        audit({ at: Date.now(), op: 'add-root-from-tree', path: sv.real, user: session?.user?.name });
        return send(200, { roots: currentRoots() });
      }

      if (pathname === '/api/fs/list' && req.method === 'GET') {
        const q = new URLSearchParams((req.url.split('?')[1] ?? ''));
        const rootId = q.get('rootId') ?? '';
        // v2：无 rootId = L0 漫游（绝对路径）；有 rootId = L1 根内相对路径
        let baseReal;
        let mode;
        if (rootId) {
          const root = findRoot(rootId);
          if (!root) return send(400, { error: 'unknown rootId', code: 'FS_ROOT_NOT_FOUND' });
          const sv = safeResolve(root.path, q.get('path') ?? '');
          if (sv.error) return send(403, sv);
          baseReal = sv.real;
          mode = 'root';
        } else {
          if (!sessionRoam) return send(403, { error: '会话漫游已被禁用（PLITE_FS_SESSION=0）', code: 'FS_ROAM_DISABLED' });
          const sv = safeAbs(q.get('path') ?? '');
          if (sv.error) return send(403, sv);
          baseReal = sv.real;
          mode = 'roam';
        }
        const st = statSync(baseReal);
        if (!st.isDirectory()) return send(400, { error: 'not a directory', code: 'FS_NOT_DIR' });
        let names;
        try {
          names = readdirSync(baseReal);
        } catch (e) {
          return send(403, { error: String(e.message ?? e), code: 'FS_LIST_DENIED' });
        }
        const entries = [];
        let truncated = false;
        for (const name of names.sort((a, b) => a.localeCompare(b, 'zh'))) {
          if (name.startsWith('.') && name !== '.gitignore') continue; // 隐藏文件噪声过滤
          if (entries.length >= LIST_LIMIT) { truncated = true; break; }
          try {
            const s = statSync(join(baseReal, name));
            entries.push({ name, isDir: s.isDirectory(), size: s.isDirectory() ? undefined : s.size, mtime: s.mtimeMs });
          } catch { /* 单项 stat 失败跳过（权限/占用） */ }
        }
        audit({ at: Date.now(), op: 'list', mode, rootId: rootId || undefined, path: q.get('path') ?? '', count: entries.length, user: session?.user?.name });
        return send(200, { entries, truncated });
      }

      if (pathname === '/api/fs/read' && req.method === 'GET') {
        const q = new URLSearchParams((req.url.split('?')[1] ?? ''));
        const rootId = q.get('rootId') ?? '';
        const rel = q.get('path') ?? '';
        const head = Math.max(0, Number(q.get('head')) || 0);
        const tail = Math.max(0, Number(q.get('tail')) || 0);
        // v2：L0 漫游绝对路径 or L1 根内相对路径；L0 预览限额更紧（roam 256KB）
        let real;
        let roam = false;
        if (rootId) {
          const root = findRoot(rootId);
          if (!root) return send(400, { error: 'unknown rootId', code: 'FS_ROOT_NOT_FOUND' });
          const sv = safeResolve(root.path, rel);
          if (sv.error) return send(403, sv);
          real = sv.real;
        } else {
          if (!sessionRoam) return send(403, { error: '会话漫游已被禁用（PLITE_FS_SESSION=0）', code: 'FS_ROAM_DISABLED' });
          const sv = safeAbs(rel);
          if (sv.error) return send(403, sv);
          real = sv.real;
          roam = true;
        }
        const st = statSync(real);
        if (st.isDirectory()) return send(400, { error: 'is directory', code: 'FS_IS_DIR' });
        const ext = extname(real).toLowerCase();
        const isText = !BINARY_EXT.has(ext) && looksTextable(ext);
        const textCap = roam ? 256 * 1024 : TEXT_PREVIEW_CAP;
        if (st.size > (isText ? textCap : BINARY_PREVIEW_CAP)) {
          audit({ at: Date.now(), op: 'read-oversize', mode: roam ? 'roam' : 'root', path: rel, size: st.size, user: session?.user?.name });
          return send(200, {
            tooLarge: true, size: st.size, isText,
            hint: isText ? `文件超过 ${Math.round(textCap / 1024)}KB 预览上限，可用 head/tail 参数取片段（或让 AI 用 bash 取）` : '文件超过 1MB 二进制预览上限',
          });
        }
        const buf = readFileSync(real);
        audit({ at: Date.now(), op: 'read', mode: roam ? 'roam' : 'root', rootId: rootId || undefined, path: rel, size: st.size, user: session?.user?.name });
        if (isText) {
          let text = buf.toString('utf8');
          if (head) text = text.split('\n').slice(0, head).join('\n');
          else if (tail) {
            const lines = text.split('\n');
            text = lines.slice(Math.max(0, lines.length - tail)).join('\n');
          }
          return send(200, { isText: true, text, size: st.size, mtime: st.mtimeMs, truncated: head > 0 || tail > 0 });
        }
        return send(200, { isText: false, ext, mime: extMime(ext), data: buf.toString('base64'), size: st.size, mtime: st.mtimeMs });
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

/** 目录是否有子项（只取第一个有效项判断，避免空目录出现展开箭头） */
function hasChildrenSync(dir) {
  try {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.') && name !== '.gitignore') continue;
      return true;
    }
  } catch { /* 权限失败视为无子项（展开时报错） */ }
  return false;
}

/** 二进制预览 mime（修 v1 写死 png 的坑：按扩展名给） */
function extMime(ext) {
  const m = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
  };
  return m[ext] ?? 'application/octet-stream';
}
