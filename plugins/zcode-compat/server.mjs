/**
 * zcode-compat 插件的服务端半边（/api/compat/*）：
 * Claude Code / ZCode 扩展文件扫描与固化导入。
 *
 * 扫描来源（只读）：
 *   MCP:  <ws>/.mcp.json、<ws>/.zcode/config.json(mcp.servers)、<ws>/.agents/mcp.json、
 *         ~/.claude.json(按当前 workspace projects 键)、~/.zcode/cli/config.json(mcp.servers)
 *   Skills: <ws>/.claude/skills、<ws>/.zcode/skills、<ws>/.agents/skills（SKILL.md）
 *   Hooks: ~/.claude/settings.json、<ws>/.claude/settings(.local).json、~/.zcode/cli/config.json、<ws>/.zcode/config.json
 *   插件: <ws>/.claude/plugins/、<ws>/.zcode/plugins/ 下的 .claude-plugin/plugin.json、.zcode-plugin/plugin.json
 *
 * 导入（固化）：
 *   MCP servers → <dataDir>/mcp-servers.json（mcp-bridge 原生格式；同名让位原生）
 *   skills      → 复制 SKILL.md 目录到 <dataDir>/skills/compat-<来源>-<名>/
 *   hooks       → <dataDir>/hooks-import.json（hook-bridge 读取的归一形态，与 settings 同构）
 *
 * 合并优先级：lite 原生 > 项目级（.mcp.json → .zcode → .agents）> 用户级（claude → zcode）；
 * 同名整条让位（先到先得）+ warn。${VAR}/${VAR:-d} 展开（WORKSPACE/CLAUDE_PROJECT_DIR/ZCODE_PROJECT_DIR），
 * 展开后 path.resolve 归一。ZCode 遗留字段迁移（remote→http 等）；http/sse 跳过+warn（P3 再接）。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, copyFileSync, rmSync } from 'node:fs';
import { join, resolve, isAbsolute, basename } from 'node:path';
import { homedir } from 'node:os';

export function createServerPart(options = {}) {
  const getSession = options.getSession;
  const dataDir = resolve(options.dataDir ?? '.polaris-lite');
  const hardOff = process.env.PLITE_COMPAT === '0';

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
      return (list.find((r) => r.builtin) ?? list[0])?.path ?? '';
    } catch {
      return '';
    }
  }

  function readJsonSafe(path) {
    try {
      if (!existsSync(path)) return null;
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return null;
    }
  }

  function expandVars(s, vars) {
    return String(s).replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g, (_, k, d) => vars[k] ?? d ?? '');
  }

  /** ZCode 遗留字段迁移 + type 推断；返回 {server}|{skip,reason} */
  function normalizeServer(name, raw, source, warns) {
    const s = { ...raw };
    if (s.type === 'remote') s.type = 'http';
    if (s.environment) { s.env = s.environment; delete s.environment; }
    if (s.enable !== undefined) { s.enabled = s.enable; delete s.enable; }
    if (s.http_headers) { s.headers = s.http_headers; delete s.http_headers; }
    const type = s.type ?? (s.command ? 'stdio' : s.url ? 'http' : null);
    if (!type) { warns.push(`${source}:${name} 无 command/url，跳过`); return { skip: true }; }
    if (type !== 'stdio') { warns.push(`${source}:${name} 传输 ${type} 暂不支持（P3），跳过`); return { skip: true }; }
    if (typeof s.command !== 'string' || !s.command.trim()) { warns.push(`${source}:${name} command 非字符串，跳过`); return { skip: true }; }
    if (isAbsolute(s.command) && !existsSync(s.command)) { warns.push(`${source}:${name} command 指向不存在的绝对路径，拒绝`); return { skip: true }; }
    return {
      server: {
        command: s.command,
        args: Array.isArray(s.args) ? s.args : [],
        env: s.env && typeof s.env === 'object' ? s.env : {},
        cwd: s.cwd ? String(s.cwd) : undefined,
        enabled: s.enabled !== false,
        timeoutMs: Number(s.timeoutMs) || 30000,
        source,
      },
    };
  }

  /** 多源 MCP 发现（返回 {merged, warns}；merged: name → server cfg，含展开后的 command/args/env） */
  function discoverMcp() {
    const ws = workspaceDir();
    const home = homedir();
    const vars = { WORKSPACE: ws, CLAUDE_PROJECT_DIR: ws, ZCODE_PROJECT_DIR: ws, POLARIS_LITE_WORKSPACE: ws };
    const warns = [];
    const merged = {};
    const sources = [
      ['project:.mcp.json', ws ? join(ws, '.mcp.json') : '', (j) => j?.mcpServers],
      ['project:.zcode/config.json', ws ? join(ws, '.zcode', 'config.json') : '', (j) => j?.mcp?.servers],
      ['project:.agents/mcp.json', ws ? join(ws, '.agents', 'mcp.json') : '', (j) => j?.mcpServers],
      ['user:~/.claude.json', join(home, '.claude.json'), (j) => (ws && j?.projects?.[ws]?.mcpServers) || j?.mcpServers],
      ['user:~/.zcode/cli/config.json', join(home, '.zcode', 'cli', 'config.json'), (j) => j?.mcp?.servers],
    ];
    for (const [source, path, pick] of sources) {
      if (!path || !existsSync(path)) continue;
      const j = readJsonSafe(path);
      if (!j) { warns.push(`${source}: 解析失败跳过`); continue; }
      const servers = pick(j) ?? {};
      for (const [name, raw] of Object.entries(servers)) {
        if (merged[name]) { warns.push(`${source}:${name} 与更早来源同名，让位`); continue; }
        const r = normalizeServer(name, raw, source, warns);
        if (r.skip) continue;
        const s = r.server;
        // command 只做变量展开不做 resolve——它可能是 'node'/'npx' 这类 PATH 命令，
        // resolve 会把相对命令名错拼成 CWD 下的路径；路径语义只对 args 生效。
        s.command = expandVars(s.command, vars);
        s.args = s.args.map((a) => resolveIfPathlike(expandVars(a, vars)));
        for (const [k, v] of Object.entries(s.env)) s.env[k] = expandVars(v, vars);
        merged[name] = s;
      }
    }
    return { merged, warns };
  }

  /** args 里的路径样变量展开后做 resolve 归一；普通参数（非存在路径、非以 / 或盘符开头）原样保留 */
  function resolveIfPathlike(s) {
    if (isAbsolute(s) || existsSync(s)) return resolve(s);
    return s;
  }

  /** skills 发现（CC/ZC/agents 目录） */
  function discoverSkills() {
    const ws = workspaceDir();
    const warns = [];
    const found = [];
    const dirs = [
      ['claude', ws ? join(ws, '.claude', 'skills') : ''],
      ['zcode', ws ? join(ws, '.zcode', 'skills') : ''],
      ['agents', ws ? join(ws, '.agents', 'skills') : ''],
    ];
    for (const [source, dir] of dirs) {
      if (!dir || !existsSync(dir)) continue;
      let entries;
      try { entries = readdirSync(dir); } catch { continue; }
      for (const name of entries) {
        if (name.startsWith('.') || name === 'node_modules') continue;
        const p = join(dir, name);
        let isDir = false;
        try { isDir = statSync(p).isDirectory(); } catch { continue; }
        if (!isDir || !existsSync(join(p, 'SKILL.md'))) continue;
        found.push({ name, source, dir: p });
      }
    }
    return { found, warns };
  }

  /** hooks 发现（归一为 hook-bridge 可读的 settings 同构形态） */
  function discoverHooks() {
    const ws = workspaceDir();
    const home = homedir();
    const warns = [];
    const merged = {};
    const sources = [
      ['user:~/.claude/settings.json', join(home, '.claude', 'settings.json')],
      ['workspace:.claude/settings.json', ws ? join(ws, '.claude', 'settings.json') : ''],
      ['workspace:.claude/settings.local.json', ws ? join(ws, '.claude', 'settings.local.json') : ''],
      ['user:~/.zcode/cli/config.json', join(home, '.zcode', 'cli', 'config.json')],
      ['workspace:.zcode/config.json', ws ? join(ws, '.zcode', 'config.json') : ''],
    ];
    for (const [source, path] of sources) {
      if (!path || !existsSync(path)) continue;
      const j = readJsonSafe(path);
      const hooks = source.includes('zcode') ? (j?.hooks?.events ? j.hooks : null) : (j?.hooks ?? null);
      if (!hooks) continue;
      if (hooks.enabled === false) { warns.push(`${source}: hooks.enabled=false，跳过`); continue; }
      // 合并事件映射（后者追加；同名 handler 让位）
      for (const [event, matchers] of Object.entries(hooks.events ?? hooks)) {
        if (['enabled', 'timeoutMs', 'maxOutputBytes'].includes(event)) continue;
        if (!Array.isArray(matchers)) continue;
        merged[event] = merged[event] ?? [];
        for (const m of matchers) {
          if (m && typeof m === 'object') merged[event].push(m);
        }
      }
    }
    return { hooks: Object.keys(merged).length ? { events: merged } : null, warns };
  }

  /** CC/ZC 插件目录发现（.claude-plugin/plugin.json / .zcode-plugin/plugin.json） */
  function discoverPlugins() {
    const ws = workspaceDir();
    const found = [];
    const warns = [];
    const roots = [
      ['claude', ws ? join(ws, '.claude', 'plugins') : ''],
      ['zcode', ws ? join(ws, '.zcode', 'plugins') : ''],
    ];
    for (const [kind, root] of roots) {
      if (!root || !existsSync(root)) continue;
      let entries;
      try { entries = readdirSync(root); } catch { continue; }
      for (const name of entries) {
        const dir = join(root, name);
        let isDir = false;
        try { isDir = statSync(dir).isDirectory(); } catch { continue; }
        if (!isDir) continue;
        const manifest = readJsonSafe(join(dir, '.claude-plugin', 'plugin.json')) ?? readJsonSafe(join(dir, '.zcode-plugin', 'plugin.json'));
        if (!manifest) continue;
        const id = String(manifest.name ?? name);
        if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(id)) { warns.push(`plugin ${name}: manifest name 不合法，跳过`); continue; }
        found.push({ kind, id, dir, manifest });
      }
    }
    return { found, warns };
  }

  function scanAll() {
    const mcp = discoverMcp();
    const skills = discoverSkills();
    const hooks = discoverHooks();
    const plugins = discoverPlugins();
    return {
      mcp: Object.entries(mcp.merged).map(([name, s]) => ({ name, command: s.command, args: s.args, enabled: s.enabled, source: s.source })),
      skills: skills.found.map(({ name, source, dir }) => ({ name, source, dir })),
      hooksEvents: Object.keys(hooks.hooks?.events ?? {}),
      plugins: plugins.found.map(({ kind, id, dir, manifest }) => ({
        kind, id, dir,
        mcpServers: Object.keys(manifest.mcpServers ?? {}).length,
        skills: Array.isArray(manifest.skills) ? manifest.skills.length : (manifest.skills ? Object.keys(manifest.skills).length : 0),
        hooks: Boolean(manifest.hooks),
      })),
      warns: [...mcp.warns, ...skills.warns, ...hooks.warns, ...plugins.warns],
    };
  }

  function importAll() {
    const log = [];
    const warns = [];
    // 1) MCP → mcp-bridge 原生配置（原生优先：已有同名（原生 source）不让位）
    const mcp = discoverMcp();
    const cfgPath = join(dataDir, 'mcp-servers.json');
    const existing = readJsonSafe(cfgPath) ?? { servers: {} };
    let mcpAdded = 0;
    for (const [name, s] of Object.entries(mcp.merged)) {
      const cur = existing.servers?.[name];
      if (cur && cur.source === 'native') { warns.push(`mcp:${name} 已有原生配置，让位`); continue; }
      existing.servers = existing.servers ?? {};
      existing.servers[name] = s;
      mcpAdded++;
    }
    if (mcpAdded) writeFileSync(cfgPath, JSON.stringify(existing, null, 2) + '\n');
    log.push(`mcp servers 导入 ${mcpAdded} 个`);

    // 2) skills → <dataDir>/skills/compat-<source>-<name>/
    const skills = discoverSkills();
    let skillCopied = 0;
    for (const s of skills.found) {
      const dest = join(dataDir, 'skills', `compat-${s.source}-${basename(s.dir)}`);
      try {
        mkdirSync(dest, { recursive: true });
        copyFileSync(join(s.dir, 'SKILL.md'), join(dest, 'SKILL.md'));
        skillCopied++;
      } catch (e) {
        warns.push(`skill:${s.name} 复制失败: ${e.message}`);
      }
    }
    log.push(`skills 复制 ${skillCopied} 个`);

    // 3) hooks → hooks-import.json（hook-bridge loadRules 的补充来源）
    const hooks = discoverHooks();
    if (hooks.hooks) {
      writeFileSync(join(dataDir, 'hooks-import.json'), JSON.stringify(hooks.hooks, null, 2) + '\n');
      log.push(`hooks 事件写入（${Object.keys(hooks.hooks.events).join(', ')}）`);
    } else {
      log.push('hooks 无可导入配置');
    }

    // 4) CC/ZC 插件：声明型贡献拆解导入（mcpServers/skills）
    const plugins = discoverPlugins();
    let pluginParts = 0;
    for (const p of plugins.found) {
      const m = p.manifest;
      const vars = { CLAUDE_PLUGIN_ROOT: p.dir, ZCODE_PLUGIN_ROOT: p.dir, CLAUDE_PROJECT_DIR: workspaceDir(), WORKSPACE: workspaceDir() };
      for (const [name, raw] of Object.entries(m.mcpServers ?? {})) {
        if (raw?.url) { warns.push(`plugin ${p.id}:${name} http/sse 暂不支持，跳过`); continue; }
        const expanded = {
          ...raw,
          command: expandVars(String(raw?.command ?? ''), vars),
          args: Array.isArray(raw?.args) ? raw.args.map((a) => resolveIfPathlike(expandVars(a, vars))) : [],
        };
        const r = normalizeServer(`${p.id}:${name}`, expanded, `plugin:${p.id}`, warns);
        if (r.skip) continue;
        const cfg = readJsonSafe(cfgPath) ?? { servers: {} };
        cfg.servers = cfg.servers ?? {};
        cfg.servers[`plugin-${p.id}-${name}`] = { ...r.server, source: 'native' };
        writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
        pluginParts++;
      }
      const skillList = Array.isArray(m.skills) ? m.skills : (m.skills && typeof m.skills === 'object' ? Object.keys(m.skills) : []);
      for (const sk of skillList) {
        const srcDir = join(p.dir, 'skills', String(sk));
        if (!existsSync(join(srcDir, 'SKILL.md'))) { warns.push(`plugin ${p.id}: skill ${sk} 缺 SKILL.md，跳过`); continue; }
        const dest = join(dataDir, 'skills', `compat-plugin-${p.id}-${sk}`);
        mkdirSync(dest, { recursive: true });
        copyFileSync(join(srcDir, 'SKILL.md'), join(dest, 'SKILL.md'));
        pluginParts++;
      }
    }
    log.push(`插件贡献拆解导入 ${pluginParts} 项`);

    // 导入后清 skill-loader 的扫描缓存（mtime 变了自然失效；显式删除冗余目录不存在）
    return { ok: true, log, warns };
  }

  return async function compatApi(req, res, next) {
    if (hardOff) return next?.();
    const [pathname] = (req.url ?? '').split('?');
    if (!pathname.startsWith('/api/compat/')) return next?.();

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
      req.on('data', (c) => { b += c; if (b.length > 100_000) req.destroy(); });
      req.on('end', () => r(b));
    });

    try {
      if (pathname === '/api/compat/scan' && req.method === 'GET') {
        return sendJson(200, scanAll());
      }
      if (pathname === '/api/compat/import' && req.method === 'POST') {
        await readBody(); // 无参数；导入即确认
        return sendJson(200, importAll());
      }
      return sendJson(404, { error: 'not found' });
    } catch (e) {
      return sendJson(400, { ok: false, error: String(e?.message ?? e) });
    }
  };
}
