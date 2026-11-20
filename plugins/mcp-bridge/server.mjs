/**
 * mcp-bridge 插件的服务端半边（/api/mcp/*）：MCP client 池 + 配置仓库 + 管理面。
 *
 * MCP 协议：JSON-RPC 2.0 over stdio（NDJSON），协议版本 2024-11-05。
 * 握手序列：initialize → notifications/initialized → tools/list（缓存）→ tools/call。
 * （真子进程全流程已验证：INIT_OK / TOOLS / CALL，含中文参数。）
 *
 * 配置（原生格式，唯一写目标）：<dataDir>/mcp-servers.json
 *   { "servers": { "<name>": { "command": "node", "args": ["x.js"], "env": {}, "cwd": "", "enabled": true, "timeoutMs": 30000 } } }
 *
 * 端点：
 *   GET  /api/mcp/servers      → { servers: [{name, command, args, enabled, status, tools[], source}] }
 *   POST /api/mcp/servers      → { name, command, args?, env?, enabled? }        增/改（原生配置）
 *   POST /api/mcp/servers/remove { name }                                          删
 *   GET  /api/mcp/tools        → { tools: [descriptor...] }                       聚合工具描述（门控过滤后）
 *   POST /api/mcp/call         → { name, arguments } → { ok, stdout } | { ok:false, error }
 *   GET  /api/mcp/active       → { mcpServers: [{server_name, command, args}] }   CLI 引擎透传用（codebuddy）
 *   POST /api/mcp/gate         → { tool, enabled }                                per-tool 门控（存 kv）
 *
 * 安全：会话门禁；PLITE_MCP=0 禁用；启动/调用写 <dataDir>/mcp-audit.log；
 *       command 必须为字符串（对齐 ZCode schema）；启动超时 15s。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

const PROTOCOL_VERSION = '2024-11-05';
const START_TIMEOUT_MS = 15_000;
const AUDIT_PREVIEW = 400;

export function createServerPart(options = {}) {
  const getSession = options.getSession;
  const dataDir = resolve(options.dataDir ?? '.polaris-lite');
  const hardOff = process.env.PLITE_MCP === '0';
  const configPath = join(dataDir, 'mcp-servers.json');
  const auditPath = join(dataDir, 'mcp-audit.log');
  const gatePath = join(dataDir, 'mcp-gates.json');

  /** server name → client 运行态 */
  const clients = new Map();

  function loadConfig() {
    try {
      if (!existsSync(configPath)) return { servers: {} };
      const j = JSON.parse(readFileSync(configPath, 'utf8'));
      return j && typeof j === 'object' && j.servers ? j : { servers: {} };
    } catch {
      return { servers: {} };
    }
  }

  function saveConfig(cfg) {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n');
  }

  function loadGates() {
    try {
      if (!existsSync(gatePath)) return {};
      return JSON.parse(readFileSync(gatePath, 'utf8'));
    } catch {
      return {};
    }
  }

  function saveGates(g) {
    mkdirSync(dirname(gatePath), { recursive: true });
    writeFileSync(gatePath, JSON.stringify(g, null, 2) + '\n');
  }

  function audit(entry) {
    try {
      appendFileSync(auditPath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
    } catch { /* 审计失败不阻塞 */ }
  }

  /** MCP stdio client：按需启动，进程级复用 */
  function getClient(name, cfg) {
    const existing = clients.get(name);
    if (existing && existing.child && !existing.child.killed) return existing;
    return startClient(name, cfg);
  }

  function startClient(name, cfg) {
    const state = { child: null, buf: '', pending: new Map(), nextId: 1, tools: null, ready: null };
    const child = spawn(cfg.command, Array.isArray(cfg.args) ? cfg.args : [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      cwd: cfg.cwd || undefined,
      env: { ...process.env, ...(cfg.env ?? {}) },
    });
    state.child = child;
    audit({ kind: 'spawn', server: name, command: cfg.command, pid: child.pid });

    child.stdout?.on('data', (d) => {
      state.buf += d.toString('utf8');
      let idx;
      while ((idx = state.buf.indexOf('\n')) >= 0) {
        const line = state.buf.slice(0, idx).trim();
        state.buf = state.buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const p = state.pending.get(msg.id);
        if (p) {
          state.pending.delete(msg.id);
          msg.error ? p.rej(new Error(msg.error.message ?? 'MCP error')) : p.res(msg.result);
        }
      }
    });
    child.on('exit', (code) => {
      audit({ kind: 'exit', server: name, code });
      for (const p of state.pending.values()) p.rej(new Error(`MCP server ${name} 已退出 (code=${code})`));
      state.pending.clear();
      clients.delete(name);
    });
    child.on('error', (e) => {
      audit({ kind: 'error', server: name, message: String(e?.message ?? e) });
      for (const p of state.pending.values()) p.rej(e);
      state.pending.clear();
      clients.delete(name);
    });

    const rpc = (method, params) => new Promise((res, rej) => {
      const id = state.nextId++;
      state.pending.set(id, { res, rej });
      try {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', 'utf-8');
      } catch (e) {
        state.pending.delete(id);
        rej(e);
      }
    });

    state.ready = (async () => {
      const init = await Promise.race([
        rpc('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'polaris-lite', version: '0.1.0' } }),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`MCP ${name} 启动超时（${START_TIMEOUT_MS}ms）`)), START_TIMEOUT_MS)),
      ]);
      try { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n', 'utf-8'); } catch { /* 忽略 */ }
      return init;
    })();
    state.rpc = rpc;
    clients.set(name, state);
    return state;
  }

  async function listServerTools(name, cfg) {
    const st = getClient(name, cfg);
    await st.ready;
    if (!st.tools) {
      const r = await st.rpc('tools/list', {});
      st.tools = Array.isArray(r.tools) ? r.tools : [];
    }
    return st.tools;
  }

  async function shutdownAll() {
    for (const [name, st] of clients) {
      try { st.child?.kill(); } catch { /* 忽略 */ }
      clients.delete(name);
    }
  }

  return async function mcpApi(req, res, next) {
    if (hardOff) return next?.();
    const [pathname] = (req.url ?? '').split('?');
    if (!pathname.startsWith('/api/mcp/')) return next?.();

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
      if (pathname === '/api/mcp/servers' && req.method === 'GET') {
        const cfg = loadConfig();
        const gates = loadGates();
        const servers = [];
        for (const [name, s] of Object.entries(cfg.servers)) {
          let status = 'stopped';
          let tools = [];
          let toolError;
          if (s.enabled !== false) {
            try {
              const list = await listServerTools(name, s);
              tools = list.map((t) => ({
                name: `mcp__${name}__${t.name}`,
                server: name,
                tool: t.name,
                description: String(t.description ?? ''),
                gated: gates[`mcp__${name}__${t.name}`] === false,
              }));
              status = 'connected';
            } catch (e) {
              status = 'error';
              toolError = String(e?.message ?? e);
            }
          } else {
            status = 'disabled';
          }
          servers.push({ name, command: s.command, args: s.args ?? [], enabled: s.enabled !== false, status, tools, toolError, source: s.source ?? 'native' });
        }
        return sendJson(200, { servers });
      }

      if (pathname === '/api/mcp/servers' && req.method === 'POST') {
        const body = JSON.parse((await readBody()) || '{}');
        const name = String(body.name ?? '').trim();
        if (!name || /[^a-zA-Z0-9_-]/.test(name)) return sendJson(400, { error: 'server 名不合法（仅字母数字_-）' });
        if (typeof body.command !== 'string' || !body.command.trim()) return sendJson(400, { error: 'command 必须为非空字符串' });
        const cfg = loadConfig();
        cfg.servers[name] = {
          command: body.command.trim(),
          args: Array.isArray(body.args) ? body.args.map(String) : [],
          env: body.env && typeof body.env === 'object' ? body.env : {},
          cwd: body.cwd ? String(body.cwd) : undefined,
          enabled: body.enabled !== false,
          timeoutMs: Number(body.timeoutMs) || 30000,
          source: 'native',
        };
        saveConfig(cfg);
        audit({ kind: 'config', server: name, action: 'upsert' });
        return sendJson(200, { ok: true });
      }

      if (pathname === '/api/mcp/servers/remove' && req.method === 'POST') {
        const body = JSON.parse((await readBody()) || '{}');
        const name = String(body.name ?? '');
        const cfg = loadConfig();
        if (!cfg.servers[name]) return sendJson(404, { error: `server 不存在: ${name}` });
        delete cfg.servers[name];
        saveConfig(cfg);
        const st = clients.get(name);
        if (st) { try { st.child?.kill(); } catch { /* 忽略 */ } clients.delete(name); }
        audit({ kind: 'config', server: name, action: 'remove' });
        return sendJson(200, { ok: true });
      }

      if (pathname === '/api/mcp/tools' && req.method === 'GET') {
        const cfg = loadConfig();
        const gates = loadGates();
        const tools = [];
        for (const [name, s] of Object.entries(cfg.servers)) {
          if (s.enabled === false) continue;
          try {
            const list = await listServerTools(name, s);
            for (const t of list) {
              const full = `mcp__${name}__${t.name}`;
              if (gates[full] === false) continue; // per-tool 门控
              tools.push({
                cap: 'cap.tool.mcp',
                name: full,
                description: String(t.description ?? '') + `（MCP server: ${name}）`,
                parameters: t.inputSchema ?? { type: 'object', properties: {} },
                danger: 'execute',
              });
            }
          } catch (e) {
            audit({ kind: 'tools-list-error', server: name, message: String(e?.message ?? e) });
          }
        }
        return sendJson(200, { tools });
      }

      if (pathname === '/api/mcp/call' && req.method === 'POST') {
        const body = JSON.parse((await readBody()) || '{}');
        const fullName = String(body.name ?? '');
        const m = /^mcp__([a-zA-Z0-9_-]+)__(.+)$/.exec(fullName);
        if (!m) return sendJson(400, { ok: false, error: `非法 MCP 工具名: ${fullName}` });
        const [, serverName, toolName] = m;
        const cfg = loadConfig();
        const s = cfg.servers[serverName];
        if (!s || s.enabled === false) return sendJson(404, { ok: false, error: `MCP server 不可用: ${serverName}` });
        if (loadGates()[fullName] === false) return sendJson(403, { ok: false, error: `工具已被门控关闭: ${fullName}` });
        const st = getClient(serverName, s);
        await st.ready;
        const r = await Promise.race([
          st.rpc('tools/call', { name: toolName, arguments: body.arguments ?? {} }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('MCP 调用超时（120s）')), 120_000)),
        ]);
        const text = Array.isArray(r.content)
          ? r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
          : '';
        audit({ kind: 'call', server: serverName, tool: toolName, ok: r.isError !== true, outBytes: text.length, preview: text.slice(0, AUDIT_PREVIEW) });
        if (r.isError) return sendJson(200, { ok: false, error: text || 'MCP 工具返回错误' });
        return sendJson(200, { ok: true, stdout: text });
      }

      if (pathname === '/api/mcp/active' && req.method === 'GET') {
        // CLI 引擎（codebuddy）透传用：仅返回启用的 stdio server
        const cfg = loadConfig();
        const mcpServers = Object.entries(cfg.servers)
          .filter(([, s]) => s.enabled !== false)
          .map(([name, s]) => ({ server_name: name, command: s.command, args: s.args ?? [] }));
        return sendJson(200, { mcpServers });
      }

      if (pathname === '/api/mcp/gate' && req.method === 'POST') {
        const body = JSON.parse((await readBody()) || '{}');
        const tool = String(body.tool ?? '');
        if (!tool) return sendJson(400, { error: 'tool required' });
        const gates = loadGates();
        if (body.enabled === false) gates[tool] = false;
        else delete gates[tool];
        saveGates(gates);
        audit({ kind: 'gate', tool, enabled: body.enabled !== false });
        return sendJson(200, { ok: true });
      }

      return sendJson(404, { error: 'not found' });
    } catch (e) {
      return sendJson(400, { ok: false, error: String(e?.message ?? e) });
    }
  };
}
