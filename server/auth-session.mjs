/**
 * 宿主登录会话（中继鉴权唯一权威）—— dev(vite middleware) 与 prod(node server) 共用。
 *
 * - 会话表：Map<sid, { user, roles, expiresAt }>，sid 为 24 字节随机 hex；
 * - Cookie：plite.sid，HttpOnly + SameSite=Lax + Path=/，Max-Age 12h；
 *   Secure 按部署形态决定（options.secureCookies 或 X-Forwarded-Proto === 'https'）；
 * - owner 账户（首登=注册，仅一次）上收服务端：.polaris-lite/auth-owner.json，
 *   存 sha256(salt + password)，比较用 timingSafeEqual；
 * - 登录限速：按 IP 维护失败计数，超过阈值临时拒绝（防爆破）。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const COOKIE = 'plite.sid';
const TTL_MS = 12 * 60 * 60 * 1000; // 12h

/** 会话持久化文件（服务重启后会话不失效，用户无需重新登录） */
const SESSIONS_FILE = '.polaris-lite/auth-sessions.json';

export function createAuthMiddleware(options = {}) {
  const dataDir = resolve(options.dataDir ?? '.polaris-lite');
  const ownerFile = resolve(options.ownerFile ?? `${dataDir}/auth-owner.json`);
  const sessionsFile = resolve(options.sessionsFile ?? SESSIONS_FILE);
  const secureCookies = !!options.secureCookies;
  // 会话表：启动时从磁盘恢复，变更时落盘（服务重启后 cookie 仍有效）
  const sessions = new Map();

  // 登录限速：ip -> { fails, until }
  const rate = new Map();
  const MAX_FAILS = 5;
  const LOCK_MS = 60_000;

  const sha256 = (s) => createHash('sha256').update(s).digest('hex');

  // ---- 会话持久化：sid 只以 sha256 哈希形式落盘（防文件读取后直接冒用会话）----
  const sidHash = (sid) => sha256(`sid:${sid}`);
  const loadSessions = () => {
    try {
      if (!existsSync(sessionsFile)) return;
      const data = JSON.parse(readFileSync(sessionsFile, 'utf8'));
      for (const [sidHashed, s] of Object.entries(data)) {
        if (s.expiresAt > Date.now()) sessions.set(sidHashed, s); // 过期条目不恢复
      }
    } catch { /* 损坏则忽略，从空开始 */ }
  };
  const saveSessions = () => {
    try {
      mkdirSync(dirname(sessionsFile), { recursive: true });
      writeFileSync(sessionsFile, JSON.stringify(Object.fromEntries(sessions)));
    } catch { /* 忽略写失败（只影响重启后会话保持） */ }
  };
  loadSessions();

  const safeEqual = (a, b) => {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    return ba.length === bb.length && timingSafeEqual(ba, bb);
  };

  const readOwner = () => (existsSync(ownerFile) ? JSON.parse(readFileSync(ownerFile, 'utf8')) : null);
  const writeOwner = (o) => {
    mkdirSync(dirname(ownerFile), { recursive: true });
    writeFileSync(ownerFile, JSON.stringify(o));
  };

  const parseCookies = (req) => {
    const out = {};
    for (const part of (req.headers.cookie ?? '').split(';')) {
      if (!part) continue;
      const i = part.indexOf('=');
      const k = part.slice(0, i).trim();
      const v = part.slice(i + 1).trim();
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v; // 畸形值不抛错（防远程 DoS，评审 V6）
      }
    }
    return out;
  };

  const getSession = (req) => {
    const sid = parseCookies(req)[COOKIE];
    const s = sid ? sessions.get(sidHash(sid)) : null;
    if (!s) return null;
    if (s.expiresAt < Date.now()) {
      sessions.delete(sidHash(sid));
      persistSessions();
      return null;
    }
    return s;
  };

  const cookieFor = (req, sid, maxAgeSeconds) => {
    const secure = secureCookies || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    return `${COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
  };

  const persistSessions = () => {
    try {
      mkdirSync(dirname(sessionsFile), { recursive: true });
      writeFileSync(sessionsFile, JSON.stringify(Object.fromEntries(sessions)));
    } catch { /* 忽略写失败（只影响重启后会话保持） */ }
  };

  const jsonWithRes = (res, code, obj) => {
    if (res.headersSent) return; // 防御：同一请求禁止二次响应（避免进程崩溃）
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  };

  const mintSession = (req, res, username, roles) => {
      const sid = randomBytes(24).toString('hex');
      sessions.set(sidHash(sid), {
        user: { id: `u-${username}`, name: username },
        roles,
        expiresAt: Date.now() + TTL_MS,
      });
      persistSessions();
      res.setHeader('Set-Cookie', cookieFor(req, sid, TTL_MS / 1000));
      return jsonWithRes(res, 200, { ok: true, status: 'authenticated', user: { id: `u-${username}`, name: username } });
  };

  const tooManyFails = (ip) => {
    const r = rate.get(ip);
    return r && r.fails >= MAX_FAILS && r.until > Date.now();
  };
  const recordFail = (ip) => {
    const r = rate.get(ip) ?? { fails: 0, until: 0 };
    r.fails += 1;
    r.until = Date.now() + LOCK_MS;
    rate.set(ip, r);
  };

  const middleware = async (req, res, next) => {
    if (!req.url.startsWith('/api/auth/')) return next?.();
    const json = (code, obj) => {
      jsonWithRes(res, code, obj);
    };
    const readBody = () => new Promise((r) => {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => r(b));
    });
    const ip = req.socket.remoteAddress ?? 'unknown';

    if (req.url === '/api/auth/login' && req.method === 'POST') {
      if (tooManyFails(ip)) {
        return json(429, { ok: false, error: { code: 'AUTH_RATE_LIMITED', message: '尝试过于频繁，请稍后再试' } });
      }
      const { username, password } = JSON.parse((await readBody()) || '{}');
      const u = String(username ?? '').trim();
      const p = String(password ?? '');
      if (!u || p.length < 4) {
        return json(400, { ok: false, error: { code: 'AUTH_INVALID_CREDENTIALS', message: '用户名/密码不合法' } });
      }
      const owner = readOwner();
      if (!owner) {
        // 首登 = 注册（服务端权威，仅一次；加盐哈希存储）
        const salt = randomBytes(16).toString('hex');
        writeOwner({ username: u, salt, passwordHash: sha256(salt + p), registeredAt: Date.now() });
      } else if (owner.username !== u || !safeEqual(owner.passwordHash, sha256(owner.salt + p))) {
        recordFail(ip);
        return json(401, { ok: false, error: { code: 'AUTH_INVALID_CREDENTIALS', message: '用户名或密码错误（本应用仅支持注册人账号登录）' } });
      }
      rate.delete(ip);
      const roles = owner && owner.username === u ? ['owner', 'user'] : ['user'];
      mintSession(req, res, u, roles);
      return json(200, { ok: true, status: 'authenticated', user: { id: `u-${u}`, name: u } });
    }

    if (req.url === '/api/auth/logout' && req.method === 'POST') {
      const sid = parseCookies(req)[COOKIE];
      if (sid) sessions.delete(sidHash(sid));
      persistSessions();
      res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
      return json(200, { ok: true });
    }

    if (req.url === '/api/auth/status' && req.method === 'GET') {
      const s = getSession(req);
      return json(200, s
        ? { status: 'authenticated', user: s.user, expiresAt: s.expiresAt }
        : { status: 'unauthenticated', user: null, hasOwner: !!readOwner() });
    }

    // 修改注册人账号/密码：必须已登录（会话 cookie），且提供正确的旧密码
    if (req.url === '/api/auth/change-credentials' && req.method === 'POST') {
      const session = getSession(req);
      if (!session) return json(401, { ok: false, error: { code: 'SESSION_REQUIRED', message: '未登录' } });
      const body = JSON.parse((await readBody()) || '{}');
      const newUsername = String(body.newUsername ?? '').trim();
      const oldPassword = String(body.oldPassword ?? '');
      const newPassword = String(body.newPassword ?? '');
      if (newUsername.length < 1) return json(400, { ok: false, error: { code: 'AUTH_INVALID_CREDENTIALS', message: '新用户名不能为空' } });
      if (newPassword.length < 4) return json(400, { ok: false, error: { code: 'AUTH_INVALID_CREDENTIALS', message: '新密码至少 4 位' } });
      const owner = readOwner();
      if (!owner) return json(401, { ok: false, error: { code: 'SESSION_REQUIRED', message: '尚未注册' } });
      // 旧密码校验（防会话被劫持后直接改凭据）
      if (owner.passwordHash !== sha256(owner.salt + oldPassword)) {
        return json(401, { ok: false, error: { code: 'AUTH_INVALID_CREDENTIALS', message: '旧密码错误' } });
      }
      // 会话必须属于当前 owner（防止新会话改名顶替）
      if (session.user.name !== owner.username) {
        return json(403, { ok: false, error: { code: 'AUTH_FORBIDDEN', message: '仅注册人可修改凭据' } });
      }
      writeOwner({ username: newUsername, salt: owner.salt, passwordHash: sha256(owner.salt + newPassword), registeredAt: owner.registeredAt, changedAt: Date.now() });
      // 使所有旧会话失效，要求用新凭据重新登录
      sessions.clear();
      res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
      return json(200, { ok: true });
    }

    return next?.();
  };

  return { getSession, middleware };
}
