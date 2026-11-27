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
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, copyFileSync, rmSync, renameSync } from 'node:fs';
import { join, resolve, dirname, basename, extname, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

const MIME = {
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

import { registerMarketTools } from './tool.mjs';

export function createServerPart(options = {}) {
  // 工具声明随插件：启用本插件即注册 market_* 三连；禁用即消失。
  if (options.registry) registerMarketTools(options.registry);
  const getSession = options.getSession;
  const verifyTempToken = options.verifyTempToken ?? ((token) => false);
  const policy = options.policy; // 上游策略（http 源地址过闸；默认不限制，PLITE_UPSTREAM_STRICT=1 恢复白名单）
  const dataDir = resolve(options.dataDir ?? '.polaris-lite');
  const hardOff = process.env.PLITE_MARKET === '0';
  const extPluginsDir = join(dataDir, 'plugins');
  const sourcesPath = join(dataDir, 'market-sources.json');
  // registry 双写路径（与 plugin-manager 同源约定）：仓库根从本模块向上推导。
  // 必须 fileURLToPath：Windows 下 URL.pathname 是 /D:/... 形态，且 dirname() 对带尾斜杠
  // 路径会多吃一层——实测 dirname(pathname,'..','..') 推到 D:\ 导致 registry 写入静默丢失。
  const here = fileURLToPath(new URL('.', import.meta.url));
  const repoRoot = options.repoRoot ?? resolve(here, '..', '..');
  const publicRegistry = join(repoRoot, 'public', 'plugins', 'registry.json');
  const distRegistry = join(repoRoot, 'dist', 'plugins', 'registry.json');
  // grants 双写（与 registry 双写同路径约定）：宿主启动 fetch /grants.json（vite build 快照
  // 进 dist，sync-dist 同步 public→dist）。商城安装的外部插件若只进 registry 不进 grants，
  // 宿主会弹「未在 grants.json 登记，已按 manifest 自声明放行」的启动告警条（BootNotices）。
  const publicGrants = join(repoRoot, 'public', 'grants.json');
  const distGrants = join(repoRoot, 'dist', 'grants.json');

  /** dataDir 里已安装的外置插件 id 列表（安装态权威源；registry 被构建冲洗也不丢） */
  function extInstalledIds() {
    try {
      if (!existsSync(extPluginsDir)) return [];
      return readdirSync(extPluginsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(join(extPluginsDir, d.name, 'plugin.js')))
        .map((d) => d.name);
    } catch {
      return [];
    }
  }

  /** 外置插件 bundle 指纹（缓存破坏用；与 installDir 双写 registry 的 ?v= 同源约定） */
  function extBundleVersion(id) {
    try {
      return createHash('sha256').update(readFileSync(join(extPluginsDir, id, 'plugin.js'))).digest('hex').slice(0, 8);
    } catch {
      return '0';
    }
  }

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

  /** 读取 grants.json（public 优先，回退 dist）；损坏/缺失返回 null */
  function readGrants() {
    for (const f of [publicGrants, distGrants]) {
      try {
        if (!existsSync(f)) continue;
        const j = JSON.parse(readFileSync(f, 'utf8'));
        if (j && typeof j === 'object' && j.plugins) return { file: f, data: j };
      } catch { /* 下一份 */ }
    }
    return null;
  }

  /**
   * 商城安装的插件同步登记 grants（unlistedPolicy='declare' 的落盘等价物）：
   * 授权项 = 插件 plugin.json 的 manifest 自声明（capabilities/provides/events），
   * 与宿主 resolvePolicy 对未登记插件的放行口径完全一致——本修复只消除
   * 「registry 有、grants 无」的启动告警与 listed=false 状态，不放大任何权限。
   * 双写 public + dist（缺侧跳过，与 registry 双写同纪律）。
   */
  function grantExtPlugin(id, manifest) {
    const found = readGrants();
    if (!found) return; // 连 grants 文件都没有：宿主本来就走全量自声明，无需写
    const g = found.data;
    g.plugins[id] = {
      capabilities: Array.isArray(manifest.capabilities) ? manifest.capabilities : [],
      provides: Array.isArray(manifest.provides) ? manifest.provides : [],
      events: Array.isArray(manifest.events) ? manifest.events : [],
    };
    if (typeof g.version === 'number') g.version += 1;
    for (const f of [publicGrants, distGrants]) {
      try {
        if (!existsSync(f)) continue;
        writeFileSync(f, JSON.stringify(g, null, 2) + '\n');
      } catch { /* 只写存在的 */ }
    }
  }

  /** 卸载时同步移除 grants 条目（registry 移除了，授权留着会成僵尸条目） */
  function revokeExtPlugin(id) {
    const found = readGrants();
    if (!found || !found.data.plugins[id]) return;
    delete found.data.plugins[id];
    if (typeof found.data.version === 'number') found.data.version += 1;
    for (const f of [publicGrants, distGrants]) {
      try {
        if (!existsSync(f)) continue;
        writeFileSync(f, JSON.stringify(found.data, null, 2) + '\n');
      } catch { /* 只写存在的 */ }
    }
  }

  /** 目录源：源 ref 即一个目录，内含 index.json 清单 + 各插件包目录（<id>/plugin.json|plugin.js|style.css） */
  function readSourceIndex(source) {
    // http 源：清单本身是 URL（网络读取走 readSourceIndexAsync）
    if (source.type === 'http') return null;
    const idxPath = join(source.ref, 'index.json');
    const j = (() => { try { return JSON.parse(readFileSync(idxPath, 'utf8')); } catch { return null; } })();
    if (!j || !Array.isArray(j.plugins)) return null;
    return j;
  }

  /** http 源：fetch 清单 JSON（{plugins:[{id,name,version,description,sha256,...}]}） */
  async function readSourceIndexAsync(source) {
    if (source.type !== 'http') return readSourceIndex(source);
    const res = await fetch(source.ref, { signal: AbortSignal.timeout(15_000), redirect: 'follow' });
    if (!res.ok) return null;
    const j = await res.json().catch(() => null);
    if (!j || !Array.isArray(j.plugins)) return null;
    return j;
  }

  /** http 源：按清单 URL 同目录拼相对路径（清单内也可写绝对 downloadUrl） */
  function httpAssetUrl(baseRef, rel) {
    const base = baseRef.endsWith('/') ? baseRef : baseRef + '/';
    return new URL(rel, base).href;
  }

  async function fetchAsset(url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}：${url}`);
    return Buffer.from(await res.arrayBuffer());
  }

  function sha256Buf(buf) {
    return createHash('sha256').update(buf).digest('hex');
  }

  /**
   * 安装：http 源 —— fetch 清单 → 下载 plugin.json / plugin.js / style.css →
   * sha256 强校验（清单 sha256 必填，供应链防线）→ manifest 校验 → 落盘 + registry 双写。
   */
  async function installFromHttp(source, id) {
    const idx = await readSourceIndexAsync(source);
    if (!idx) return { error: `源 ${source.name} 的清单不可读（${source.ref}）` };
    const entry = idx.plugins.find((p) => p && p.id === id);
    if (!entry) return { error: `清单中不存在插件：${id}` };
    if (!entry.sha256 || !/^[0-9a-f]{64}$/i.test(String(entry.sha256))) {
      return { error: 'http 源安装要求清单登记 64 位 sha256，该条目缺失或不合法' };
    }
    // 清单 URL 若以 index.json 结尾，包根取其父目录；否则按清单 URL 本身同目录拼接
    const idxBase = /index\.json$/.test(source.ref) ? source.ref.replace(/index\.json$/, '') : source.ref;
    const pkgBase = httpAssetUrl(idxBase, `${id}/`);
    let bundle, manifestRaw, style = null;
    try {
      bundle = await fetchAsset(httpAssetUrl(pkgBase, 'plugin.js'));
      manifestRaw = await fetchAsset(httpAssetUrl(pkgBase, 'plugin.json'));
      try { style = await fetchAsset(httpAssetUrl(pkgBase, 'style.css')); } catch { /* 可选文件 */ }
    } catch (e) {
      return { error: `插件包下载失败：${e?.message ?? e}` };
    }
    const actual = sha256Buf(bundle);
    if (actual !== String(entry.sha256).toLowerCase()) {
      return { error: `sha256 不符（清单 ${String(entry.sha256).slice(0, 12)}… 实际 ${actual.slice(0, 12)}…），拒绝安装` };
    }
    let manifest;
    try { manifest = JSON.parse(manifestRaw.toString('utf8')); } catch { return { error: 'plugin.json 解析失败' }; }
    if (!manifest || typeof manifest.id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(manifest.id)) {
      return { error: 'plugin.json 的 id 不合法' };
    }
    if (manifest.id !== id) return { error: `plugin.json id(${manifest.id}) 与安装请求(${id}) 不符` };
    return finalizeInstall({ id, entry, manifest, bundle, style });
  }

  /** 落盘 + registry 双写（dir/http 两类源共用尾段） */
  function finalizeInstall({ id, entry, manifest, bundle, style }) {
    const reg = readRegistry(publicRegistry) ?? readRegistry(distRegistry);
    if (reg?.plugins?.some((p) => p && p.id === id)) {
      return { error: `插件 id 与已注册插件冲突：${id}` };
    }
    const dest = join(extPluginsDir, id);
    try { rmSync(dest, { recursive: true, force: true }); } catch { /* 无旧版 */ }
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'plugin.js'), bundle);
    writeFileSync(join(dest, 'plugin.json'), JSON.stringify(manifest, null, 2) + '\n');
    let hasStyle = false;
    if (style && style.length > 0) { writeFileSync(join(dest, 'style.css'), style); hasStyle = true; }
    const v = sha256Buf(bundle).slice(0, 8);
    const registry = reg ?? { plugins: [] };
    registry.plugins = registry.plugins.filter((p) => p && p.id !== id);
    registry.plugins.push({
      id,
      module: `/ext-plugins/${id}/plugin.js?v=${v}`,
      enabled: true,
      ...(hasStyle ? { style: `/ext-plugins/${id}/style.css?v=${v}` } : {}),
    });
    writeRegistry(registry);
    grantExtPlugin(id, manifest);
    return { ok: true, id, version: entry.version ?? manifest.version, note: '刷新页面生效' };
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
    // 注意（信任边界，刻意为之）：外部插件只装 UI 半边（plugin.js / style.css）。
    // server.mjs 属于「在宿主进程里执行任意 Node 代码」，只对随仓库评审的内置插件开放；
    // 运行时安装的包即使带了 server.mjs 也不复制、不加载。
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
    grantExtPlugin(id, manifest);
    return { ok: true, id, version: entry.version ?? manifest.version, note: '刷新页面生效' };
  }

  async function listAll(auth = {}) {
    const { session, bearerOk, bearer, req } = auth;
    const sources = loadSources();
    const reg = readRegistry(publicRegistry) ?? readRegistry(distRegistry);
    const items = [];
    const warns = [];
    for (const source of sources) {
      // cc-marketplace 源不是 dir 清单：数据走 ccMarkets 字段（见下），跳过 dir 处理链
      if (source.type === 'cc-marketplace') continue;
      if (source.type !== 'dir' && source.type !== 'http') { warns.push(`源 ${source.name} 类型 ${source.type} 暂不支持`); continue; }
      let idx = null;
      if (source.type === 'http') {
        idx = await readSourceIndexAsync(source);
        if (!idx) { warns.push(`源 ${source.name} 的清单不可读（${source.ref}）`); continue; }
      } else {
        if (!existsSync(source.ref)) { warns.push(`源 ${source.name} 目录不存在：${source.ref}`); continue; }
        idx = readSourceIndex(source);
        if (!idx) { warns.push(`源 ${source.name} 的 index.json 不可读`); continue; }
      }
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
    // CC 商城（claude code marketplaces）：声明型资源插件（skills/hooks/mcpServers），
    // 安装走 /api/compat/cc-market/install（zcode-compat 转译），不经 /ext-plugins。
    // 扫描 ~/.claude 本机的 + 用户以 cc-marketplace 类型添加的源（clone 到 <dataDir>/marketplaces/）。
    const ccMarkets = readCcMarkets(sources.filter((s) => s.type === 'cc-marketplace'));
    // 已导入的 CC 声明型资源（「已装」tab 展示；经 zcode-compat 聚合）
    let ccInstalled = [];
    try {
      const r = await fetch(`http://127.0.0.1:${process.env.PORT ?? '5000'}/api/compat/cc-installed`, {
        headers: { ...(bearerOk ? { Authorization: `Bearer ${bearer.slice(7)}` } : {}), ...(session ? { Cookie: req.headers.cookie ?? '' } : {}) },
      });
      if (r.ok) ccInstalled = (await r.json().catch(() => null))?.installed ?? [];
    } catch { /* 回环失败不阻塞 list */ }
    return { sources, items, ccMarkets, ccInstalled, warns, extCount: (reg?.plugins ?? []).filter((p) => p && String(p.module ?? '').startsWith('/ext-plugins/')).length };
  }

  /** 读 CC 商城清单（同进程内直接调 zcode-compat 的发现逻辑不可行——跨插件；
   *  改为读它的 /api/compat/cc-market？也不行——那是 HTTP 端点需会话。
   *  最简：这里复制轻量版发现（只列 installable 摘要），与 zcode-compat 的 discoverCcMarket 同口径。
   *  roots：待扫描的 marketplace 目录列表（~/.claude 本机的 + 用户加的 cc-marketplace 源 localRoot）。 */
  function readCcMarkets(extraRoots = []) {
    const roots = new Map(); // path → 别名（去重）
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const marketsRoot = join(home, '.claude', 'plugins', 'marketplaces');
    if (home && existsSync(marketsRoot)) {
      let names;
      try { names = readdirSync(marketsRoot); } catch { names = []; }
      for (const n of names) {
        const p = join(marketsRoot, n);
        try { if (statSync(p).isDirectory()) roots.set(p, n); } catch { /* 忽略 */ }
      }
    }
    for (const s of extraRoots) {
      if (s?.localRoot && existsSync(s.localRoot)) roots.set(s.localRoot, s.name);
    }
    const out = [];
    for (const [mroot, alias] of roots) {
      let mf;
      try { mf = JSON.parse(readFileSync(join(mroot, '.claude-plugin', 'marketplace.json'), 'utf8')); } catch { continue; }
      if (!mf || !Array.isArray(mf.plugins)) continue;
      const plugins = [];
      const seen = new Set();
      for (const p of mf.plugins) {
        if (!p || typeof p.name !== 'string') continue;
        const src = p.source;
        const localRel = typeof src === 'string' && src.startsWith('./') ? src.slice(2) : '';
        const localDir = localRel ? join(mroot, localRel) : '';
        const installable = localRel && existsSync(join(localDir, '.claude-plugin', 'plugin.json'));
        seen.add(p.name);
        plugins.push({
          id: p.name,
          description: String(p.description ?? ''),
          installable,
          // 远程条目也标可装（安装时服务端自动 clone）——仅当清单提供了 git url
          remote: installable ? null : (src && typeof src === 'object' ? String(src.url ?? '') : ''),
        });
      }
      const localPluginsDir = join(mroot, 'plugins');
      if (existsSync(localPluginsDir)) {
        let extras;
        try { extras = readdirSync(localPluginsDir); } catch { extras = []; }
        for (const name of extras) {
          if (seen.has(name)) continue;
          if (!existsSync(join(localPluginsDir, name, '.claude-plugin', 'plugin.json'))) continue;
          seen.add(name);
          plugins.push({ id: name, description: '', installable: true });
        }
      }
      out.push({ name: alias, realName: String(mf.name ?? alias), owner: String(mf.owner?.name ?? ''), pluginCount: plugins.length, installableCount: plugins.filter((p) => p.installable || p.remote).length, plugins });
    }
    return out;
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
    revokeExtPlugin(id);
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

    // /plugins/registry.json：外置插件条目动态合并——build:plugins 会按内置清单重新生成
    // registry（外置插件不在构建清单里，每次构建/deploy 必然被冲掉），而安装态永存 dataDir。
    // 服务侧实时合并静态 registry + dataDir 已装目录，前端拿到的永远是完整清单，
    // 「已安装但 tab 消失」的加载/安装态解耦问题从根上消除。免鉴权（与静态 registry 同级公开清单）。
    if (pathname === '/plugins/registry.json') {
      const merged = { plugins: [] };
      for (const f of [distRegistry, publicRegistry]) {
        try {
          const base = JSON.parse(readFileSync(f, 'utf8'));
          if (Array.isArray(base.plugins) && base.plugins.length) { merged.plugins = base.plugins; break; }
        } catch { /* 下一份 */ }
      }
      for (const id of extInstalledIds()) {
        if (merged.plugins.some((p) => p && p.id === id)) continue; // 静态侧已有（构建双写未冲掉时）防重复
        const hasStyle = existsSync(join(extPluginsDir, id, 'style.css'));
        merged.plugins.push({
          id,
          module: '/ext-plugins/' + id + '/plugin.js?v=' + extBundleVersion(id),
          enabled: true,
          ...(hasStyle ? { style: '/ext-plugins/' + id + '/style.css?v=' + extBundleVersion(id) } : {}),
        });
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(merged));
    }

    if (!pathname.startsWith('/api/market/')) return next?.();

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
      if (pathname === '/api/market/sources' && req.method === 'GET') {
        return sendJson(200, { sources: loadSources() });
      }
      if (pathname === '/api/market/sources' && req.method === 'POST') {
        const body = JSON.parse((await readBody()) || '{}');
        const name = String(body.name ?? '').trim();
        const ref = String(body.ref ?? '').trim();
        const type = String(body.type ?? 'dir');
        if (!name || !ref) return sendJson(400, { error: 'name 与 ref 必填' });
        const list = loadSources();
        if (list.some((s) => s.name === name)) return sendJson(400, { error: `源名已存在：${name}` });
        if (type === 'cc-marketplace') {
          // CC 商城源：ref = github owner/repo（或已存在的本地 marketplace 目录）。
          // 对齐 Claude Code 心智：加源 = clone 商城仓库到 <dataDir>/marketplaces/<name>/；
          // 已有本地 clone（~/.claude/plugins/marketplaces/<name>）则直接复用不重复下载。
          if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(ref)) {
            return sendJson(400, { error: `cc-marketplace 源 ref 应为 owner/repo 形态（如 anthropics/claude-plugins-official），收到: ${ref}` });
          }
          const repoName = ref.split('/')[1];
          const ccRoot = join(homedir(), '.claude', 'plugins', 'marketplaces', repoName);
          const localRoot = existsSync(join(ccRoot, '.claude-plugin', 'marketplace.json'))
            ? ccRoot
            : join(dataDir, 'marketplaces', repoName);
          if (localRoot !== ccRoot && !existsSync(join(localRoot, '.claude-plugin', 'marketplace.json'))) {
            // clone 到临时目录再改名：失败/中断不留半成品目录（半成品会让下次 clone 报 dir not empty）
            const tmpRoot = `${localRoot}.tmp-${Date.now().toString(36)}`;
            const clone = spawnSync('git', ['clone', '--depth', '1', `https://github.com/${ref}.git`, tmpRoot], {
              stdio: 'ignore', timeout: 180_000, windowsHide: true,
            });
            const ok = clone.status === 0 && existsSync(join(tmpRoot, '.claude-plugin', 'marketplace.json'));
            if (!ok) {
              try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 清理失败忽略 */ }
              try { rmSync(localRoot, { recursive: true, force: true }); } catch { /* 清掉上次残留的半成品 */ }
              return sendJson(400, { error: `clone 商城仓库失败：https://github.com/${ref}.git（检查网络/仓库名；也可用本地已 clone 的目录）` });
            }
            try { rmSync(localRoot, { recursive: true, force: true }); } catch { /* 无旧目录 */ }
            mkdirSync(dirname(localRoot), { recursive: true });
            try { renameSync(tmpRoot, localRoot); } catch (e) {
              try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 忽略 */ }
              return sendJson(400, { error: `clone 成功但落位失败：${e?.message ?? e}` });
            }
          }
          list.push({ name, type: 'cc-marketplace', ref, localRoot });
          saveSources(list);
          return sendJson(200, { ok: true, localRoot, reused: localRoot === ccRoot });
        }
        if (type === 'http') {
          // http 源：ref = 清单 index.json 的 URL（清单与插件包同目录树，按 <id>/ 相对寻址）
          let u;
          try { u = new URL(ref); } catch { return sendJson(400, { error: `http 源 ref 必须是合法 URL：${ref}` }); }
          if (u.protocol !== 'http:' && u.protocol !== 'https:') return sendJson(400, { error: 'http 源 ref 仅支持 http/https URL' });
          try { policy?.assertAllowedUrl?.(ref); } catch (e) { return sendJson(400, { error: `源地址被策略拒绝：${e?.message ?? e}` }); }
          list.push({ name, type: 'http', ref });
          saveSources(list);
          return sendJson(200, { ok: true });
        }
        if (type !== 'dir') return sendJson(400, { error: '源类型仅支持 dir、http 或 cc-marketplace' });
        if (!existsSync(ref)) return sendJson(400, { error: `源目录不存在：${ref}` });
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
        return sendJson(200, await listAll({ session, bearerOk, bearer, req }));
      }
      if (pathname === '/api/market/install' && req.method === 'POST') {
        const body = JSON.parse((await readBody()) || '{}');
        const sourceName = String(body.source ?? '');
        // CC 商城源（source = marketplace 名）：走声明型资源转译导入（不运行外部 JS）。
        // target: 'global'（默认，落 <dataDir>）/ 'project'（落当前激活 workspace）。
        const sourcesAll = loadSources();
        const ccMarkets = readCcMarkets(sourcesAll.filter((s) => s.type === 'cc-marketplace'));
        const ccHit = ccMarkets.find((m) => m.name === sourceName);
        if (ccHit) {
          // zcode-compat 端按 marketplace 目录名/清单名匹配——把真实 marketplace 名传过去
          // （源别名 cc-official 只是用户起的源名；localRoot 指向的目录名才是 marketplace 名）。
          const realName = ccHit.realName || ccHit.name;
          const r = await fetch(`http://127.0.0.1:${process.env.PORT ?? '5000'}/api/compat/cc-market/install`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(bearerOk ? { Authorization: `Bearer ${bearer.slice(7)}` } : {}), ...(session ? { Cookie: req.headers.cookie ?? '' } : {}) },
            body: JSON.stringify({ market: realName, id: body.id, target: body.target ?? 'global' }),
          });
          const j = await r.json().catch(() => null);
          return sendJson(r.status, j ?? { ok: false, error: `HTTP ${r.status}` });
        }
        const source = loadSources().find((s) => s.name === sourceName);
        if (!source) return sendJson(400, { error: `源不存在：${sourceName}（CC 商城请用商城名，如 claude-plugins-official）` });
        const r = source.type === 'http'
          ? await installFromHttp(source, String(body.id ?? ''))
          : installFromDir(source, String(body.id ?? ''));
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
