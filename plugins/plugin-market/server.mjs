/**
 * plugin-market 的服务端半边：商城源管理 + 安装器 + /ext-plugins 自服务路由。
 *
 * 端点：
 *   GET  /api/market/sources            → { sources:[{name,type,ref}] }（已登记源）
 *   POST /api/market/sources            { name, type:'dir'|'http', ref }   添加源
 *   POST /api/market/sources/remove     { name }                            删除源
 *   GET  /api/market/list               → { items:[{id,name,version,description,sha256,source,installed,updatable,localVersion}] }
 *   POST /api/market/install            { source, id } → 安装（下载/校验/落盘/registry 双写）
 *   POST /api/market/uninstall          { id }        → 卸载（删目录 + registry 移除）
 *   GET  /ext-plugins/<id>/plugin.js|style.css          → 外部插件 bundle 自服务（no-store + 穿越校验）
 *
 * 源清单 index.json：{name, plugins:[{id,name,version,description,downloadUrl,sha256,tags?}]}
 * 下载包：zip（含 plugin.json + plugin.js[+ style.css]）——用 Node 内置解压？zip 需要依赖——
 * P2 保守选择：支持「清单内嵌包目录」（downloadUrl 指向源内目录，直接复制文件，不经网络与解压）。
 * zip/http 远程包列为 P3（避免引入 unzip 依赖与供应链面）。
 *
 * 安全：会话门禁；PLITE_MARKET=0；sha256 对目录源 = 清单里登记的目标文件指纹（安装时重算）；
 * 路径逃逸拒绝；registry 双写复用 plugin-manager 惯例（dist+public 双写 + ?v=bump）。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, copyFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname, basename, extname, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const MIME = {
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

export function createServerPart(options = {}) {
  const getSession = options.getSession;
  const dataDir = resolve(options.dataDir ?? '.polaris-lite');
  const hardOff = process.env.PLITE_MARKET === '0';
  const extPluginsDir = join(dataDir, 'plugins');
  const sourcesPath = join(dataDir, 'market-sources.json');
  // registry 双写路径（与 plugin-manager 同源约定）：仓库根从本模块向上推导。
  // 必须 fileURLToPath：Windows 下 URL.pathname 是 /D:/... 形态，且 dirname() 对带尾斜杠
  // 路径会多吃一层——实测 dirname(pathname,'..','..') 推到 D:\ 导致 registry 写入静默丢失。
  const here = fileURLToPath(new URL('.', import.meta.url));
  const repoRoot = resolve(here, '..', '..');
  const publicRegistry = join(repoRoot, 'public', 'plugins', 'registry.json');
  const distRegistry = join(repoRoot, 'dist', 'plugins', 'registry.json');

  function loadSources() {
    try {
      if (!existsSync(sourcesPath)) return [];
      const j = JSON.parse(readFileSync(sourcesPath, 'utf8'));
      return Array.isArray(j) ? j : [];
    } catch {
      return [];
    }
  }

  function saveSources(list) {
    mkdirSync(dirname(sourcesPath), { recursive: true });
    writeFileSync(sourcesPath, JSON.stringify(list, null, 2) + '\n');
  }

  function readRegistry(path) {
    try {
      if (!existsSync(path)) return null;
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return null;
    }
  }

  function writeRegistry(data) {
    // 双写 public + dist（plugin-manager 惯例；缺哪个跳过哪个——dev 无 dist）
    for (const p of [publicRegistry, distRegistry]) {
      try {
        if (existsSync(p)) writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
      } catch { /* 只写存在的；缺失侧由构建补齐 */ }
    }
  }

  /** 目录源：源 ref 即一个目录，内含 index.json 清单 + 各插件包目录（<id>/plugin.json|plugin.js|style.css） */
  function readSourceIndex(source) {
    const idxPath = join(source.ref, 'index.json');
    const j = (() => { try { return JSON.parse(readFileSync(idxPath, 'utf8')); } catch { return null; } })();
    if (!j || !Array.isArray(j.plugins)) return null;
    return j;
  }

  function sha256File(path) {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  }

  /** 安装：目录源复制文件（含 sha256 校验 plugin.js）；registry 增项指向 /ext-plugins */
  function installFromDir(source, id) {
    const idx = readSourceIndex(source);
    if (!idx) return { error: `源 ${source.name} 的 index.json 不可读` };
    const entry = idx.plugins.find((p) => p && p.id === id);
    if (!entry) return { error: `清单中不存在插件：${id}` };
    const pkgDir = join(source.ref, id);
    const manifestPath = join(pkgDir, 'plugin.json');
    const bundlePath = join(pkgDir, 'plugin.js');
    if (!existsSync(manifestPath) || !existsSync(bundlePath)) {
      return { error: `插件包不完整（缺 plugin.json 或 plugin.js）` };
    }
    // sha256 强校验（清单登记的 bundle 指纹）
    if (entry.sha256) {
      const actual = sha256File(bundlePath);
      if (actual !== entry.sha256) return { error: `sha256 不符（清单 ${String(entry.sha256).slice(0, 12)}… 实际 ${actual.slice(0, 12)}…），拒绝安装` };
    }
    // manifest 校验：LiteManifest 声明子集
    let manifest;
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { return { error: 'plugin.json 解析失败' }; }
    if (!manifest || typeof manifest.id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(manifest.id)) {
      return { error: 'plugin.json 的 id 不合法' };
    }
    if (manifest.id !== id) return { error: `plugin.json id(${manifest.id}) 与安装请求(${id}) 不符` };
    // 禁止覆盖内置插件 id（与 build:plugins 清单冲突）
    const reg = readRegistry(publicRegistry) ?? readRegistry(distRegistry);
    if (reg?.plugins?.some((p) => p && p.id === id)) {
      return { error: `插件 id 与已注册插件冲突：${id}` };
    }
    // 落盘到外部插件目录
    const dest = join(extPluginsDir, id);
    try { rmSync(dest, { recursive: true, force: true }); } catch { /* 无旧版 */ }
    mkdirSync(dest, { recursive: true });
    copyFileSync(bundlePath, join(dest, 'plugin.js'));
    copyFileSync(manifestPath, join(dest, 'plugin.json'));
    if (existsSync(join(pkgDir, 'style.css'))) copyFileSync(join(pkgDir, 'style.css'), join(dest, 'style.css'));
    // registry 增项（module 指向 /ext-plugins；?v= 用 bundle 指纹前 8 位）
    const v = sha256File(join(dest, 'plugin.js')).slice(0, 8);
    const registry = reg ?? { plugins: [] };
    registry.plugins = registry.plugins.filter((p) => p && p.id !== id);
    registry.plugins.push({
      id,
      module: `/ext-plugins/${id}/plugin.js?v=${v}`,
      enabled: true,
      ...(existsSync(join(dest, 'style.css')) ? { style: `/ext-plugins/${id}/style.css?v=${v}` } : {}),
    });
    writeRegistry(registry);
    return { ok: true, id, version: entry.version ?? manifest.version, note: '刷新页面生效' };
  }

  function listAll() {
    const sources = loadSources();
    const reg = readRegistry(publicRegistry) ?? readRegistry(distRegistry);
    const items = [];
    const warns = [];
    for (const source of sources) {
      if (source.type !== 'dir') { warns.push(`源 ${source.name} 类型 ${source.type} 暂不支持（P3 接 http/zip）`); continue; }
      if (!existsSync(source.ref)) { warns.push(`源 ${source.name} 目录不存在：${source.ref}`); continue; }
      const idx = readSourceIndex(source);
      if (!idx) { warns.push(`源 ${source.name} 的 index.json 不可读`); continue; }
      for (const p of idx.plugins ?? []) {
        if (!p || typeof p.id !== 'string') continue;
        const installedDir = join(extPluginsDir, p.id);
        const installed = existsSync(installedDir);
        let localVersion;
        if (installed) {
          try { localVersion = JSON.parse(readFileSync(join(installedDir, 'plugin.json'), 'utf8')).version; } catch { /* 忽略 */ }
        }
        items.push({
          id: p.id, name: p.name ?? p.id, version: p.version ?? '?',
          description: p.description ?? '', sha256: p.sha256 ?? '', tags: p.tags ?? [],
          source: source.name,
          installed,
          updatable: installed && p.version && localVersion && p.version !== localVersion,
          localVersion,
        });
      }
    }
    return { sources, items, warns, extCount: (reg?.plugins ?? []).filter((p) => p && String(p.module ?? '').startsWith('/ext-plugins/')).length };
  }

  function uninstall(id) {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) return { error: '插件 id 不合法' };
    const dest = join(extPluginsDir, id);
    if (!existsSync(dest)) return { error: `未安装：${id}` };
    const reg = readRegistry(publicRegistry) ?? readRegistry(distRegistry);
    if (reg) {
      reg.plugins = (reg.plugins ?? []).filter((p) => !p || p.id !== id);
      writeRegistry(reg);
    }
    try { rmSync(dest, { recursive: true, force: true }); } catch (e) { return { error: `删除失败：${e?.message ?? e}` }; }
    return { ok: true, id, note: '刷新页面生效' };
  }

  return async function marketApi(req, res, next) {
    if (hardOff) return next?.();
    const [pathname] = (req.url ?? '').split('?');

    // /ext-plugins/<id>/<file>：bundle 自服务（免鉴权与 registry 同级——插件产物是公开静态资源）
    if (pathname.startsWith('/ext-plugins/')) {
      const rel = pathname.slice('/ext-plugins/'.length);
      const segs = rel.split('/').filter(Boolean);
      if (segs.length !== 2 || segs.some((s) => s.includes('..') || s.includes('\\') || s.includes(':'))) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        return res.end('bad path');
      }
      const [id, file] = segs;
      if (!/^[\w.-]+$/.test(file)) { res.writeHead(400); return res.end('bad file'); }
      const target = resolve(extPluginsDir, id, file);
      if (!target.startsWith(resolve(extPluginsDir) + sep) || !existsSync(target) || statSync(target).isDirectory()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('not found');
      }
      const mime = MIME[extname(file)] ?? 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
      return res.end(readFileSync(target));
    }

    if (!pathname.startsWith('/api/market/')) return next?.();

    const session = getSession?.(req);
    if (!session) {
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
      if (pathname === '/api/market/sources' && req.method === 'GET') {
        return sendJson(200, { sources: loadSources() });
      }
      if (pathname === '/api/market/sources' && req.method === 'POST') {
        const body = JSON.parse((await readBody()) || '{}');
        const name = String(body.name ?? '').trim();
        const ref = String(body.ref ?? '').trim();
        if (!name || !ref) return sendJson(400, { error: 'name 与 ref 必填' });
        if (body.type !== 'dir') return sendJson(400, { error: '暂只支持 dir 类型源（本地目录）' });
        if (!existsSync(ref)) return sendJson(400, { error: `源目录不存在：${ref}` });
        const list = loadSources();
        if (list.some((s) => s.name === name)) return sendJson(400, { error: `源名已存在：${name}` });
        list.push({ name, type: 'dir', ref: resolve(ref) });
        saveSources(list);
        return sendJson(200, { ok: true });
      }
      if (pathname === '/api/market/sources/remove' && req.method === 'POST') {
        const body = JSON.parse((await readBody()) || '{}');
        const list = loadSources().filter((s) => s.name !== body.name);
        saveSources(list);
        return sendJson(200, { ok: true });
      }
      if (pathname === '/api/market/list' && req.method === 'GET') {
        return sendJson(200, listAll());
      }
      if (pathname === '/api/market/install' && req.method === 'POST') {
        const body = JSON.parse((await readBody()) || '{}');
        const source = loadSources().find((s) => s.name === body.source);
        if (!source) return sendJson(400, { error: `源不存在：${body.source}` });
        const r = installFromDir(source, String(body.id ?? ''));
        if (r.error) return sendJson(400, r);
        return sendJson(200, r);
      }
      if (pathname === '/api/market/uninstall' && req.method === 'POST') {
        const body = JSON.parse((await readBody()) || '{}');
        const r = uninstall(String(body.id ?? ''));
        if (r.error) return sendJson(400, r);
        return sendJson(200, r);
      }
      return sendJson(404, { error: 'not found' });
    } catch (e) {
      return sendJson(400, { ok: false, error: String(e?.message ?? e) });
    }
  };
}
