/**
 * http-gateway 插件的服务端半边（/api/http-gw/*）：通用有状态 HTTP 转发 + 密钥保管。
 *
 * 为什么存在：外部插件（商城安装）只有 UI 半边，不能携带 server.mjs（信任边界）；
 * 而很多上游接口（OAuth2 登录、无 CORS 头的管理面 API）浏览器无法直连。宿主此前
 * 只有 /api/model-relay（绑死供应商语义、单发无状态），做不了 cookie-jar 跟 302 的
 * 登录链。本插件补上这块公共地基——**不认识任何具体上游/业务语义**，任何插件可复用。
 *
 * 端点（全部过宿主会话门禁 + 审计；对齐 docs/server-gateway-contract.md 的设计精神，
 * 但沿用 v1 中间件契约：createServerPart({ dataDir, getSession, policy, logger }) → 中间件）：
 *   POST /api/http-gw/session  {}                      → { sessionId }（cookie jar 会话）
 *   POST /api/http-gw/request  { sessionId?, url, method?, headers?, body?, maxRedirects?, timeoutMs? }
 *                            → { sessionId, status, headers, location?, body? }
 *   POST /api/http-gw/vault/set    { id, value, readable? } → { ok }
 *   POST /api/http-gw/vault/get    { id }               → { ok, value? }（readable=false 拒绝返回）
 *   POST /api/http-gw/vault/remove { id }               → { ok, removed }
 *   GET  /api/http-gw/vault/list                       → { ok, items:[{id,readable,updated_at}] }
 *
 * 能力语义（通用、非业务）：
 * - session：服务端持有 cookie jar。OAuth2 登录链的 csrf cookie 全程不出服务端。
 *   TTL 15min 空闲回收，进程内 LRU ≤ 64（登录链 ≤12 跳，远够）。
 * - request：redirect 恒 manual。maxRedirects>0 时服务端自动跟跳（jar 贯穿，每跳上限
 *   同参数）；=0 时单发，把 status/location 交还调用方自己决策（登录链的编排模式）。
 *   headers 值支持 {{vault:<id>}} 模板：**服务端解析注入后才外发**——密钥不过浏览器。
 *   响应体截断 512KB（管理面 JSON 足够；防拉大文件）。
 * - vault：AES-256-GCM 密文落盘 <dataDir>/http-gateway/vault.json（原子写，0600 尽力）。
 *   readable=true 的条目可经 vault/get 读取（token 类，供前端编排 refresh）；
 *   readable=false 永不回传（密码类），只能以 {{vault:}} 模板注入请求头/表单体。
 *
 * 安全模型（对齐全仓 server 半边惯例）：
 * - 会话 cookie 硬门禁（未登录 401）；PLITE_HTTP_GATEWAY=0 一键禁用；
 * - 上游地址逐请求过 policy.assertAllowedUrl（默认不限制；PLITE_UPSTREAM_STRICT=1
 *   恢复 https+白名单+私网拦截——白名单在 plugins/relay-hosts.json）；
 * - 同一会话的 URL 只允许 http/https；session 必须先建（request 带 sessionId 时校验归属，
 *   sessionId 是宿主签发的随机串，进程内存 Map，不可伪造）；
 * - vault id 规则 ^[a-z0-9][a-z0-9._:-]{0,119}$（小写字母数字开头，防路径花样）；
 *   调用方插件按惯例用 <pluginId>:<key> 前缀，命名空间自律（与 cap.config 同约定）；
 * - 审计：每次外发落一行 dataDir/http-gateway-audit.log（时间/用户/方法/host/path/状态/耗时），
 *   请求体与 header 一律不落日志（密钥安全）。
 */
import { createServer } from 'node:http';
import {
  mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, chmodSync, appendFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

const ROUTE_PREFIX = '/api/http-gw';
const SESSION_TTL_MS = 15 * 60 * 1000;
const SESSION_MAX = 64;
const BODY_MAX_BYTES = 64 * 1024;        // 网关自身请求体上限（转发体也够用：表单体远小于此）
const RESPONSE_MAX_BYTES = 512 * 1024;  // 上游响应截断上限
const REDIRECT_DEFAULT_MAX = 0;
const REDIRECT_HARD_MAX = 12;
const TIMEOUT_DEFAULT_MS = 30 * 1000;
const TIMEOUT_HARD_MAX_MS = 120 * 1000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const VAULT_ID_RE = /^[a-z0-9][a-z0-9._:-]{0,119}$/;
const VAULT_TEMPLATE_RE = /\{\{vault:([a-z0-9][a-z0-9._:-]{0,119})\}\}/g;

// ---------- 会话（进程内存 Map；重启即清——登录链本来就是短事务） ----------
class Session {
  constructor(id) {
    this.id = id;
    this.cookies = new Map(); // host -> Map<name, value>
    this.lastUsed = Date.now();
  }
  header(host) {
    const bucket = this.cookies.get(host);
    return bucket ? [...bucket.entries()].map(([k, v]) => `${k}=${v}`).join('; ') : '';
  }
  absorb(host, res) {
    let list = [];
    if (typeof res.headers.getSetCookie === 'function') list = res.headers.getSetCookie();
    else {
      const raw = res.headers.get('set-cookie');
      if (raw) list = [raw];
    }
    if (!list.length) return;
    const bucket = this.cookies.get(host) ?? new Map();
    for (const line of list) {
      const m = /^([^=;]+)=([^;]*)/.exec(String(line).trim());
      if (m) bucket.set(m[1].trim(), m[2].trim());
    }
    this.cookies.set(host, bucket);
    this.lastUsed = Date.now();
  }
  touch() { this.lastUsed = Date.now(); }
}

function makeSessions() {
  const map = new Map();
  function sweep() {
    const now = Date.now();
    for (const [id, s] of map) {
      if (now - s.lastUsed > SESSION_TTL_MS) map.delete(id);
    }
    // LRU 上限：插最旧的
    while (map.size > SESSION_MAX) {
      const oldest = [...map.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (!oldest) break;
      map.delete(oldest[0]);
    }
  }
  return {
    create() {
      sweep();
      const s = new Session(randomBytes(16).toString('hex'));
      map.set(s.id, s);
      return s;
    },
    get(id) {
      const s = map.get(String(id ?? ''));
      if (!s) return null;
      if (Date.now() - s.lastUsed > SESSION_TTL_MS) { map.delete(s.id); return null; }
      s.touch();
      return s;
    },
  };
}

// ---------- vault（AES-256-GCM 密文落盘） ----------
/** 设备密钥：独立文件，权限尽力 600。与密文分离——单文件泄漏互不构成威胁。 */
function loadDeviceKey(dir) {
  const file = join(dir, 'vault.key');
  if (existsSync(file)) return readFileSync(file);
  const key = randomBytes(32);
  writeFileSync(file, key, { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* Windows 尽力而为 */ }
  return key;
}
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function aesEncrypt(plain, key) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return { iv: b64u(iv), ct: b64u(ct), tag: b64u(c.getAuthTag()) };
}
function aesDecrypt(pack, key) {
  try {
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(pack.iv, 'base64url'));
    d.setAuthTag(Buffer.from(pack.tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(pack.ct, 'base64url')), d.final()]).toString('utf8');
  } catch { return null; }
}

function makeVault(dir) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'vault.json');
  const key = loadDeviceKey(dir);
  let data = { items: {} };
  try {
    if (existsSync(file)) {
      const j = JSON.parse(readFileSync(file, 'utf8'));
      if (j && typeof j.items === 'object') data = j;
    }
  } catch { /* 密文库损坏：从空库开始，不 brick 网关 */ }
  function persist() {
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
    try { chmodSync(file, 0o600); } catch { /* 尽力而为 */ }
  }
  return {
    set(id, value, readable) {
      data.items[id] = {
        enc: aesEncrypt(String(value), key),
        readable: readable !== false, // 缺省可读（token 类居多）
        updated_at: Math.floor(Date.now() / 1000),
      };
      persist();
      return true;
    },
    /** 明文只在服务端内存出现；readable=false 一律拒绝 */
    get(id) {
      const item = data.items[id];
      if (!item) return { missing: true };
      if (item.readable === false) return { forbidden: true };
      const plain = aesDecrypt(item.enc, key);
      if (plain === null) return { corrupt: true };
      return { value: plain };
    },
    /** 注入用：不检查 readable（{{vault:}} 模板就是要注入不可读密钥） */
    getForInject(id) {
      const item = data.items[id];
      if (!item) return { missing: true };
      const plain = aesDecrypt(item.enc, key);
      return plain === null ? { corrupt: true } : { value: plain };
    },
    remove(id) {
      const had = !!data.items[id];
      delete data.items[id];
      if (had) persist();
      return had;
    },
    list() {
      return Object.entries(data.items)
        .map(([id, it]) => ({ id, readable: it.readable !== false, updated_at: it.updated_at ?? null }))
        .sort((a, b) => a.id.localeCompare(b.id));
    },
  };
}

// ---------- 模板注入（服务端完成；未命中 fail-fast） ----------
/** 深度遍历对象/数组的字符串值做模板注入（键名不动；注入后再序列化，转义交给 JSON.stringify） */
function injectValue(val, vault) {
  if (typeof val === 'string') {
    return val.replace(VAULT_TEMPLATE_RE, (full, id) => {
      const r = vault.getForInject(id);
      if (r.missing || r.corrupt) {
        const e = new Error(`vault 条目不存在或损坏：${id}`);
        e.status = 400;
        throw e;
      }
      return r.value;
    });
  }
  if (Array.isArray(val)) return val.map((v) => injectValue(v, vault));
  if (val && typeof val === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(val)) out[k] = injectValue(v, vault);
    return out;
  }
  return val;
}
function injectTemplates(headers, vault, logAudit) {
  const out = {};
  let injected = 0;
  for (const [name, raw] of Object.entries(headers ?? {})) {
    const val = String(raw);
    out[name] = val.replace(VAULT_TEMPLATE_RE, (full, id) => {
      const r = vault.getForInject(id);
      if (r.missing || r.corrupt) {
        const e = new Error(`vault 条目不存在或损坏：${id}`);
        e.status = 400;
        throw e;
      }
      injected += 1;
      return r.value;
    });
  }
  if (injected > 0) logAudit(`template-inject headers x${injected}`);
  return out;
}

export function createServerPart(options = {}) {
  const getSession = options.getSession;
  const policy = options.policy;
  const dataDir = resolve(options.dataDir ?? '.polaris-lite');
  const vaultDir = join(dataDir, 'http-gateway');
  const auditFile = join(vaultDir, 'audit.log');
  const hardOff = process.env.PLITE_HTTP_GATEWAY === '0';

  const sessions = makeSessions();
  const vault = makeVault(vaultDir);

  function logAudit(line) {
    try {
      appendFileSync(auditFile, `${new Date().toISOString()} ${line}\n`);
    } catch { /* 审计失败不阻断业务 */ }
  }

  function sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  }

  async function readBody(req) {
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > BODY_MAX_BYTES) throw Object.assign(new Error('请求体过大'), { status: 413 });
      chunks.push(c);
    }
    if (!chunks.length) return {};
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  /** 单跳外发（jar 贯穿）。返回 undici Response。 */
  async function hop(url, opts, session) {
    const host = new URL(url).host;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs);
    try {
      const cookie = session ? session.header(host) : '';
      const res = await fetch(url, {
        method: opts.method,
        redirect: 'manual',
        signal: ctl.signal,
        headers: {
          'User-Agent': UA,
          'Accept-Language': 'zh-CN',
          ...(cookie ? { Cookie: cookie } : {}),
          ...opts.headers,
        },
        body: opts.body,
      });
      session?.absorb(host, res);
      return res;
    } finally { clearTimeout(timer); }
  }

  return async function httpGateway(req, res, next) {
    if (hardOff) return next?.();
    const [pathname] = (req.url ?? '').split('?');
    if (!pathname.startsWith(ROUTE_PREFIX)) return next?.();

    // ① 会话门禁（所有 /api/http-gw/* 一律要求宿主登录态）
    const session = getSession?.(req);
    if (!session) return sendJson(res, 401, { ok: false, error: 'unauthorized', code: 'SESSION_REQUIRED' });

    try {
      // ---------- POST /session ----------
      if (pathname === `${ROUTE_PREFIX}/session` && req.method === 'POST') {
        const s = sessions.create();
        logAudit(`session-create user=${session.user?.name ?? 'unknown'} sid=${s.id.slice(0, 8)}`);
        return sendJson(res, 200, { ok: true, sessionId: s.id, ttl_ms: SESSION_TTL_MS });
      }

      // ---------- POST /request ----------
      if (pathname === `${ROUTE_PREFIX}/request` && req.method === 'POST') {
        const b = await readBody(req);
        const url = String(b.url ?? '');
        if (!/^https?:\/\//.test(url)) return sendJson(res, 400, { ok: false, error: 'url 必须是 http/https 绝对地址' });

        // SSRF 策略（默认不限制；strict 时白名单+私网拦截）
        try { policy?.assertAllowedUrl?.(url); }
        catch (e) { return sendJson(res, 400, { ok: false, error: `上游地址被策略拒绝：${e.message}`, code: 'UPSTREAM_NOT_ALLOWED' }); }

        let gwSession = null;
        if (b.sessionId) {
          gwSession = sessions.get(b.sessionId);
          if (!gwSession) return sendJson(res, 400, { ok: false, error: 'sessionId 不存在或已过期（TTL 15min）' });
        }
        const isNew = !gwSession && b.autoSession !== false;
        if (isNew) gwSession = sessions.create();

        const method = /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/.test(String(b.method ?? '')) ? String(b.method) : 'GET';
        const timeoutMs = Math.min(Number(b.timeoutMs) || TIMEOUT_DEFAULT_MS, TIMEOUT_HARD_MAX_MS);
        const maxRedirects = Math.min(Number(b.maxRedirects) || REDIRECT_DEFAULT_MAX, REDIRECT_HARD_MAX);

        let headers;
        try { headers = injectTemplates(b.headers, vault, logAudit); }
        catch (e) { return sendJson(res, e.status ?? 500, { ok: false, error: e.message }); }

        let bodyOut;
        if (b.body !== undefined && method !== 'GET' && method !== 'HEAD') {
          // body 也要模板注入（自动重登时密码从 vault 注入 JSON body，明文不过浏览器）
          let bodyVal;
          try { bodyVal = injectValue(b.body, vault); }
          catch (e) { return sendJson(res, e.status ?? 500, { ok: false, error: e.message }); }
          const ct = String(headers['Content-Type'] ?? headers['content-type'] ?? '');
          if (typeof bodyVal === 'object' && ct.includes('json')) bodyOut = JSON.stringify(bodyVal);
          else bodyOut = String(bodyVal);
        }

        // 跟跳循环：redirect 恒 manual，由本层决定跟几跳
        let currentUrl = url;
        let up = null;
        for (let i = 0; i <= maxRedirects; i++) {
          up = await hop(currentUrl, { method: i === 0 ? method : 'GET', headers, body: i === 0 ? bodyOut : undefined, timeoutMs }, gwSession);
          const status = up.status;
          if (status >= 300 && status < 400) {
            const loc = up.headers.get('location');
            if (!loc) break;
            const nextUrl = loc.startsWith('/') ? new URL(loc, currentUrl).href : loc;
            if (!/^https?:\/\//.test(nextUrl)) break;
            currentUrl = nextUrl;
            continue;
          }
          break;
        }

        // 响应体读取 + 截断
        const respHeaders = {};
        up.headers.forEach((v, k) => { respHeaders[k] = v; });
        let respBody = null;
        let truncated = false;
        if (method !== 'HEAD' && up.body) {
          try {
            const buf = Buffer.from(await up.arrayBuffer());
            truncated = buf.length > RESPONSE_MAX_BYTES;
            respBody = buf.subarray(0, RESPONSE_MAX_BYTES).toString('utf8');
            // 尝试 JSON 透传（解析失败则原样字符串）
          } catch { respBody = null; }
        }

        logAudit(`request user=${session.user?.name ?? 'unknown'} ${method} ${new URL(currentUrl).host}${new URL(currentUrl).pathname} → ${up.status} ${Date.now() % 100000}ms sid=${gwSession.id.slice(0, 8)}`);

        const out = {
          ok: true,
          sessionId: gwSession.id,
          finalUrl: currentUrl,
          status: up.status,
          headers: respHeaders,
          location: up.headers.get('location') ?? null,
        };
        if (respBody !== null) {
          out.body = respBody;
          out.truncated = truncated;
          if ((up.headers.get('content-type') ?? '').includes('json')) {
            try { out.json = JSON.parse(respBody); } catch { /* 保留字符串 body */ }
          }
        }
        return sendJson(res, 200, out);
      }

      // ---------- vault ----------
      if (pathname === `${ROUTE_PREFIX}/vault/set` && req.method === 'POST') {
        const b = await readBody(req);
        const id = String(b.id ?? '');
        if (!VAULT_ID_RE.test(id)) return sendJson(res, 400, { ok: false, error: 'vault id 不合法（^[a-z0-9][a-z0-9._:-]{0,119}$；建议 <pluginId>:<key>）' });
        if (typeof b.value !== 'string' || !b.value) return sendJson(res, 400, { ok: false, error: 'value 必须是非空字符串' });
        vault.set(id, b.value, b.readable !== false);
        logAudit(`vault-set id=${id} readable=${b.readable !== false} user=${session.user?.name ?? 'unknown'}`);
        return sendJson(res, 200, { ok: true });
      }
      if (pathname === `${ROUTE_PREFIX}/vault/get` && req.method === 'POST') {
        const b = await readBody(req);
        const id = String(b.id ?? '');
        if (!VAULT_ID_RE.test(id)) return sendJson(res, 400, { ok: false, error: 'vault id 不合法' });
        const r = vault.get(id);
        if (r.missing) return sendJson(res, 404, { ok: false, error: '条目不存在' });
        if (r.forbidden) return sendJson(res, 403, { ok: false, error: '该条目不可读取（readable=false，只能经 {{vault:}} 模板注入）' });
        if (r.corrupt) return sendJson(res, 500, { ok: false, error: '条目解密失败（密钥文件丢失或损坏）' });
        return sendJson(res, 200, { ok: true, value: r.value });
      }
      if (pathname === `${ROUTE_PREFIX}/vault/remove` && req.method === 'POST') {
        const b = await readBody(req);
        const id = String(b.id ?? '');
        if (!VAULT_ID_RE.test(id)) return sendJson(res, 400, { ok: false, error: 'vault id 不合法' });
        const had = vault.remove(id);
        logAudit(`vault-remove id=${id} user=${session.user?.name ?? 'unknown'}`);
        return sendJson(res, 200, { ok: true, removed: had });
      }
      if (pathname === `${ROUTE_PREFIX}/vault/list` && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, items: vault.list() });
      }

      return sendJson(res, 404, { ok: false, error: `unknown route: ${req.method} ${pathname}` });
    } catch (e) {
      if (e?.name === 'AbortError' || e?.name === 'TimeoutError') {
        return sendJson(res, 504, { ok: false, error: '上游请求超时' });
      }
      logAudit(`error ${pathname}: ${e.message}`);
      return sendJson(res, e.status ?? 500, { ok: false, error: e.message || String(e) });
    }
  };
}
