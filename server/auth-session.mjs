/**
 * 宿主登录会话（中继/供应商 API 鉴权唯一权威）—— dev(vite middleware) 与 prod(node server) 共用。
 *
 * - 会话表：Map<sha256(sid), { user, roles, expiresAt }>；sid 为 24 字节随机 hex；
 *   落盘只存哈希，文件被读也无法直接冒用会话；
 * - Cookie：plite.sid，HttpOnly + SameSite=Lax + Path=/，Max-Age 12h；
 *   Secure 按部署形态决定（options.secureCookies 或 X-Forwarded-Proto === 'https'）；
 * - owner（首登=注册，仅一次）：.polaris-lite/auth-owner.json，scrypt(64B) 哈希，
 *   比较走 timingSafeEqual；历史 sha256(salt+md5(pw)) 记录在登录成功后自动升级为 scrypt；
 * - 请求体：上限 64KB、畸形 JSON 返回 400（原实现在 async 中间件里抛出会挂死请求）；
 * - 登录限速：按 IP 计失败次数，超阈值锁定 60s；注册路径同样受限速保护。
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { readJson, sendJson, sendError, HttpError, BODY_LIMIT_SMALL } from './http-util.mjs';

const COOKIE = 'plite.sid';
const TTL_MS = 12 * 60 * 60 * 1000; // 12h
const MAX_FAILS = 5;
const LOCK_MS = 60_000;
const SCRYPT_KEYLEN = 64;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const md5 = (s) => createHash('md5').update(s).digest('hex');

const safeEqualBuf = (a, b) => {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
};

export function createAuthMiddleware(options = {}) {
  const dataDir = resolve(options.dataDir ?? '.polaris-lite');
  const ownerFile = resolve(options.ownerFile ?? `${dataDir}/auth-owner.json`);
  const sessionsFile = resolve(options.sessionsFile ?? `${dataDir}/auth-sessions.json`);
  const secureCookies = !!options.secureCookies;
  const ttlMs = options.sessionTtlMs ?? TTL_MS;

  const sessions = new Map();
  // ip -> { fails, until }；定期清理，避免被随机 IP 撑爆内存
  const rate = new Map();

  const sidHash = (sid) => sha256(`sid:${sid}`);

  const loadSessions = () => {
    try {
      if (!existsSync(sessionsFile)) return;
      const data = JSON.parse(readFileSync(sessionsFile, 'utf8'));
      for (const [key, s] of Object.entries(data)) {
        if (s?.expiresAt > Date.now()) sessions.set(key, s);
      }
    } catch { /* 损坏则忽略，从空开始 */ }
  };
  const persistSessions = () => {
    try {
      mkdirSync(dirname(sessionsFile), { recursive: true });
      writeFileSync(sessionsFile, JSON.stringify(Object.fromEntries(sessions)));
    } catch { /* 只影响重启后会话保持 */ }
  };
  loadSessions();

  const readOwner = () => {
    try {
      return existsSync(ownerFile) ? JSON.parse(readFileSync(ownerFile, 'utf8')) : null;
    } catch {
      return null;
    }
  };
  const writeOwner = (o) => {
    mkdirSync(dirname(ownerFile), { recursive: true });
    writeFileSync(ownerFile, JSON.stringify(o));
  };

  /** scrypt 哈希（新注册与升级都用它） */
  const scryptHash = (password, salt) => scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');

  /**
   * 校验密码。兼容两代格式：
   * - { algo:'scrypt', salt, passwordHash } —— 当前
   * - { salt, passwordHash } —— 历史：sha256(salt + md5(password))
   * 返回 { ok, needsUpgrade }
   */
  const verifyPassword = (owner, password) => {
    if (owner?.algo === 'scrypt') {
      return { ok: safeEqualBuf(owner.passwordHash, scryptHash(password, owner.salt)), needsUpgrade: false };
    }
    const legacy = sha256(owner.salt + md5(password));
    return { ok: safeEqualBuf(owner.passwordHash, legacy), needsUpgrade: true };
  };

  const parseCookies = (req) => {
    const out = {};
    for (const part of (req.headers.cookie ?? '').split(';')) {
      if (!part) continue;
      const i = part.indexOf('=');
      if (i < 0) continue;
      const k = part.slice(0, i).trim();
      const v = part.slice(i + 1).trim();
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v; // 畸形值不抛错（防远程 DoS）
      }
    }
    return out;
  };

  const getSession = (req) => {
    const sid = parseCookies(req)[COOKIE];
    if (!sid) return null;
    const key = sidHash(sid);
    const s = sessions.get(key);
    if (!s) return null;
    if (s.expiresAt < Date.now()) {
      sessions.delete(key);
      persistSessions();
      return null;
    }
    return s;
  };

  const cookieFor = (req, sid, maxAgeSeconds) => {
    const secure = secureCookies || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    return `${COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
  };

  const clearCookie = `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

  const mintSession = (req, res, username, roles) => {
    const sid = randomBytes(24).toString('hex');
    sessions.set(sidHash(sid), {
      user: { id: `u-${username}`, name: username },
      roles,
      expiresAt: Date.now() + ttlMs,
    });
    persistSessions();
    res.setHeader('Set-Cookie', cookieFor(req, sid, ttlMs / 1000));
  };

  const pruneRate = () => {
    if (rate.size < 500) return;
    const now = Date.now();
    for (const [ip, r] of rate) {
      if (r.until < now && r.fails === 0) rate.delete(ip);
    }
  };
  const tooManyFails = (ip) => {
    const r = rate.get(ip);
    return !!r && r.fails >= MAX_FAILS && r.until > Date.now();
  };
  const recordFail = (ip) => {
    pruneRate();
    const r = rate.get(ip) ?? { fails: 0, until: 0 };
    r.fails += 1;
    r.until = Date.now() + LOCK_MS;
    rate.set(ip, r);
  };

  const middleware = async (req, res, next) => {
    const [pathname] = (req.url ?? '').split('?');
    if (!pathname.startsWith('/api/auth/')) return next?.();

    try {
      const ip = req.socket?.remoteAddress ?? 'unknown';

      if (pathname === '/api/auth/login' && req.method === 'POST') {
        if (tooManyFails(ip)) {
          throw new HttpError(429, 'AUTH_RATE_LIMITED', '尝试过于频繁，请稍后再试');
        }
        const body = await readJson(req, BODY_LIMIT_SMALL);
        const username = String(body.username ?? '').trim();
        const password = String(body.password ?? '');
        if (!username || password.length < 4) {
          throw new HttpError(400, 'AUTH_INVALID_CREDENTIALS', '用户名/密码不合法');
        }

        let owner = readOwner();
        if (!owner) {
          // 首登 = 注册（原子写入：并发首登只有一个能成功）
          const salt = randomBytes(16).toString('hex');
          const record = {
            username,
            algo: 'scrypt',
            salt,
            passwordHash: scryptHash(password, salt),
            registeredAt: Date.now(),
          };
          try {
            mkdirSync(dirname(ownerFile), { recursive: true });
            writeFileSync(ownerFile, JSON.stringify(record), { flag: 'wx' });
            owner = record;
          } catch {
            // 已被并发请求注册：回到常规校验路径
            owner = readOwner();
            if (!owner) throw new HttpError(500, 'AUTH_STORE_FAILED', '注册失败，请重试');
            const v = verifyPassword(owner, password);
            if (owner.username !== username || !v.ok) {
              recordFail(ip);
              throw new HttpError(401, 'AUTH_INVALID_CREDENTIALS', '用户名或密码错误');
            }
          }
        } else {
          const v = verifyPassword(owner, password);
          if (owner.username !== username || !v.ok) {
            recordFail(ip);
            throw new HttpError(401, 'AUTH_INVALID_CREDENTIALS', '用户名或密码错误（本应用仅支持注册人账号登录）');
          }
          if (v.needsUpgrade) {
            // 历史 sha256+md5 记录：登录成功即透明升级为 scrypt
            const salt = randomBytes(16).toString('hex');
            writeOwner({ ...owner, algo: 'scrypt', salt, passwordHash: scryptHash(password, salt), upgradedAt: Date.now() });
            owner = readOwner();
          }
        }

        rate.delete(ip);
        mintSession(req, res, username, ['owner', 'user']);
        return sendJson(res, 200, { ok: true, status: 'authenticated', user: { id: `u-${username}`, name: username } });
      }

      if (pathname === '/api/auth/logout' && req.method === 'POST') {
        const sid = parseCookies(req)[COOKIE];
        if (sid) sessions.delete(sidHash(sid));
        persistSessions();
        res.setHeader('Set-Cookie', clearCookie);
        return sendJson(res, 200, { ok: true });
      }

      if (pathname === '/api/auth/status' && req.method === 'GET') {
        const s = getSession(req);
        return sendJson(res, 200, s
          ? { status: 'authenticated', user: s.user, expiresAt: s.expiresAt }
          : { status: 'unauthenticated', user: null, hasOwner: !!readOwner() });
      }

      // 修改注册人账号/密码：必须已登录，且提供正确旧密码
      if (pathname === '/api/auth/change-credentials' && req.method === 'POST') {
        const session = getSession(req);
        if (!session) throw new HttpError(401, 'SESSION_REQUIRED', '未登录');
        const body = await readJson(req, BODY_LIMIT_SMALL);
        const newUsername = String(body.newUsername ?? '').trim();
        const oldPassword = String(body.oldPassword ?? '');
        const newPassword = String(body.newPassword ?? '');
        if (!newUsername) throw new HttpError(400, 'AUTH_INVALID_CREDENTIALS', '新用户名不能为空');
        if (newPassword.length < 4) throw new HttpError(400, 'AUTH_INVALID_CREDENTIALS', '新密码至少 4 位');

        const owner = readOwner();
        if (!owner) throw new HttpError(401, 'SESSION_REQUIRED', '尚未注册');
        if (session.user.name !== owner.username) {
          throw new HttpError(403, 'AUTH_FORBIDDEN', '仅注册人可修改凭据');
        }
        if (!verifyPassword(owner, oldPassword).ok) {
          throw new HttpError(401, 'AUTH_INVALID_CREDENTIALS', '旧密码错误');
        }
        const salt = randomBytes(16).toString('hex');
        writeOwner({
          username: newUsername,
          algo: 'scrypt',
          salt,
          passwordHash: scryptHash(newPassword, salt),
          registeredAt: owner.registeredAt,
          changedAt: Date.now(),
        });
        // 所有旧会话失效，必须用新凭据重新登录
        sessions.clear();
        persistSessions();
        res.setHeader('Set-Cookie', clearCookie);
        return sendJson(res, 200, { ok: true });
      }

      return next?.();
    } catch (err) {
      return sendError(res, err);
    }
  };

  return { getSession, middleware, ownerFile, sessionsFile };
}
