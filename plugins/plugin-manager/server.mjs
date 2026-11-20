/**
 * plugin-manager 插件的服务端半边（GET /api/plugin-admin/list + POST /api/plugin-admin/set-enabled）。
 *
 * 这是「插件双入口」的服务端那一半：启用/禁用必须落盘到 public/plugins/registry.json
 * （浏览器端写不了构建产物目录），由 plugins/server-registry.mjs 登记、server/host.mjs 装配。
 * 本文件被删除时宿主照常启动，只是插件管理面板的「启停」动作不可用（list 仍可走 cap.meta）。
 *
 * 安全模型（对齐 kv-store/html-preview server 半边）：
 * - 会话 cookie 硬门禁（未登录 401）；PLITE_PLUGIN_ADMIN=0 一键禁用；
 * - **只允许改 enabled 字段**：id 必须已存在于 registry 清单（白名单），
 *   module/style/新增/删除一律拒绝——权限变更（grants.json）走代码评审链，不开放运行时写入；
 * - 每次写盘重算 bundle 内容 hash（?v=），保证刷新后浏览器拉到新清单（registry 拉取是
 *   cache:'no-store'，但产物 URL 版本号变化可让静态层与 dev 缓存同时失效）；
 * - 写入原子化（tmp + rename），损坏的 registry 会让宿主启动失败，绝不能写出半截 JSON。
 */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const BODY_LIMIT = 4 * 1024;

export function createServerPart(options = {}) {
  const getSession = options.getSession;
  // 以本文件位置定位仓库根（plugins/plugin-manager/server.mjs → 仓库根在两级之上）。
  // dataDir 指向 .polaris-lite[-dev]（仓库子目录），从它向上推会算错层级，不可用。
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  // registry.json 有两份：
  // - public/plugins/registry.json：build-plugins.mjs 的产物源（gitignore）；
  // - dist/plugins/registry.json：vite build 从 public/ 拷贝的静态服务副本。
  // dev（vite middleware）与 prod（node server）都从 dist/ 提供静态文件——
  // 只写 public/ 会出现「面板说已禁用、刷新后浏览器仍读旧清单」的假失效。
  // 因此写盘必须双写，读取以 dist/（服务实况）为准。
  const registryFile = resolve(repoRoot, 'dist', 'plugins', 'registry.json');
  const registrySrcFile = resolve(repoRoot, 'public', 'plugins', 'registry.json');
  const hardOff = process.env.PLITE_PLUGIN_ADMIN === '0';

  function readRegistry() {
    for (const f of [registryFile, registrySrcFile]) {
      if (!existsSync(f)) continue;
      try {
        const parsed = JSON.parse(readFileSync(f, 'utf8'));
        if (parsed && Array.isArray(parsed.plugins)) return { file: f, data: parsed };
      } catch { /* 下一份 */ }
    }
    return null;
  }

  function writeRegistry(next) {
    for (const f of [registryFile, registrySrcFile]) {
      mkdirSync(dirname(f), { recursive: true });
      const tmp = `${f}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
      renameSync(tmp, f);
    }
  }

  /** 产物内容 hash（与 build-plugins.mjs 的版本号算法一致）：bundle 变了 URL 才变 */
  function currentVersion(pluginId) {
    for (const base of [dirname(registryFile), dirname(registrySrcFile)]) {
      try {
        const bundle = resolve(base, pluginId, 'plugin.js');
        if (existsSync(bundle)) return createHash('sha256').update(readFileSync(bundle)).digest('hex').slice(0, 8);
      } catch { /* 下一份 */ }
    }
    return null;
  }

  return async function pluginAdminApi(req, res, next) {
    if (hardOff) return next?.();
    const [pathname] = (req.url ?? '').split('?');
    if (!pathname.startsWith('/api/plugin-admin/')) return next?.();

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
      req.on('data', (c) => { b += c; if (b.length > BODY_LIMIT) req.destroy(); });
      req.on('end', () => r(b));
    });

    try {
      if (pathname === '/api/plugin-admin/list' && req.method === 'GET') {
        const registry = readRegistry();
        if (!registry) return sendJson(500, { error: 'registry.json 不可读（尚未构建？）', code: 'REGISTRY_UNAVAILABLE' });
        return sendJson(200, {
          ok: true,
          file: 'dist/plugins/registry.json + public/plugins/registry.json',
          plugins: registry.data.plugins,
        });
      }

      if (pathname === '/api/plugin-admin/set-enabled' && req.method === 'POST') {
        const body = JSON.parse((await readBody()) || '{}');
        const id = String(body.id ?? '');
        const enabled = body.enabled;
        if (!id || typeof enabled !== 'boolean') {
          return sendJson(400, { error: 'id 与 enabled(boolean) 必填' });
        }
        const registry = readRegistry();
        if (!registry) return sendJson(500, { error: 'registry.json 不可读', code: 'REGISTRY_UNAVAILABLE' });
        const entry = registry.data.plugins.find((p) => p && p.id === id);
        if (!entry) return sendJson(404, { error: `插件不在 registry 清单中：${id}` });
        if (entry.enabled === enabled) {
          return sendJson(200, { ok: true, id, enabled, changed: false, applied: false });
        }
        entry.enabled = enabled;
        // bump 版本号：刷新后动态 import 一定拿到最新产物 URL
        const v = currentVersion(id);
        if (v) {
          entry.module = `/plugins/${id}/plugin.js?v=${v}`;
          if (entry.style) entry.style = `/plugins/${id}/style.css?v=${v}`;
        }
        writeRegistry(registry.data);
        return sendJson(200, { ok: true, id, enabled, changed: true, applied: false });
      }

      return sendJson(404, { error: 'not found' });
    } catch (e) {
      return sendJson(400, { error: String(e?.message ?? e) });
    }
  };
}
