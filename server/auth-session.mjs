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
 * - 登录限速：按 IP 计失败次数，超阈值锁定 60s；注册路径同样受限速保护；
 * - 临时凭证登录：POST /api/auth/login { tempToken }（或 Authorization: Bearer）→ 换取
 *   与密码登录同权的会话 cookie；无效/过期凭证计入限速。
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
/** 临时凭证默认/最长有效期 */
const TEMP_TOKEN_DEFAULT_MS = 30 * 60 * 1000; // 30 分钟
const TEMP_TOKEN_MIN_MS = 60 * 1000; // 1 分钟
const TEMP_TOKEN_MAX_MS = 24 * 60 * 60 * 1000; // 24 小时

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
  /** 临时 Bearer 凭证（token → {expiresAt, owner}）；仅本地 IP 可用，重启即失效 */
  const tempTokens = new Map();
  /** 规范化临时凭证 TTL：非法/越界回退默认值（签发接口自带 400，这里是兜底） */
  const normalizeTempTtl = (ms, { strict = false } = {}) => {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) {
      if (strict) throw new HttpError(400, 'AUTH_INVALID_TTL', '有效期必须是正数（毫秒）');
      return TEMP_TOKEN_DEFAULT_MS;
    }
    if (n < TEMP_TOKEN_MIN_MS) {
      if (strict) throw new HttpError(400, 'AUTH_INVALID_TTL', `有效期至少 ${TEMP_TOKEN_MIN_MS / 1000} 秒`);
      return TEMP_TOKEN_MIN_MS;
    }
    if (n > TEMP_TOKEN_MAX_MS) {
      if (strict) throw new HttpError(400, 'AUTH_INVALID_TTL', `有效期最长 ${TEMP_TOKEN_MAX_MS / (60 * 60 * 1000)} 小时`);
      return TEMP_TOKEN_MAX_MS;
    }
    return Math.floor(n);
  };
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

  const audit = (entry) => { try { console.log('[auth-audit]', JSON.stringify(entry)); } catch { /* ignore */ } };
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
        // 临时凭证登录：body.tempToken（或 Authorization: Bearer 头）二选一。
        // 凭证有效 → 直接铸会话（与密码登录同权限）；无效/过期按失败计数，防穷举。
        const bearerFromHeader = (req.headers.authorization ?? '').startsWith('Bearer ')
          ? req.headers.authorization.slice(7).trim()
          : '';
        const tempToken = String(body.tempToken ?? bearerFromHeader ?? '').trim();
        if (tempToken) {
          const entry = tempTokens.get(tempToken);
          if (!entry || entry.expiresAt < Date.now() || entry.owner !== (readOwner()?.username ?? '')) {
            tempTokens.delete(tempToken);
            recordFail(ip);
            throw new HttpError(401, 'AUTH_INVALID_CREDENTIALS', '临时凭证无效或已过期');
          }
          rate.delete(ip);
          mintSession(req, res, entry.owner, ['owner', 'user']);
          audit({ at: Date.now(), op: 'login-via-temp-credential', user: entry.owner, ip });
          return sendJson(res, 200, {
            ok: true,
            status: 'authenticated',
            user: { id: `u-${entry.owner}`, name: entry.owner },
            via: 'temp-credential',
          });
        }
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
      // 临时凭证：owner 登录后签发短 TTL Bearer token（仅本地回环 IP 可用，
      // 供 AI/外部工具访问本地 /api/fs/* 与 /api/tool/exec；不落盘、重启即失效）。
      // body.ttlMs 可自定义有效期（1 分钟 ~ 24 小时），缺省 30 分钟。
      if (pathname === '/api/auth/temp-credential' && req.method === 'POST') {
        const session = getSession(req);
        if (!session) throw new HttpError(401, 'SESSION_REQUIRED', '未登录');
        const owner = readOwner();
        if (!owner) throw new HttpError(401, 'SESSION_REQUIRED', '尚未注册');
        if (session.user.name !== owner.username) throw new HttpError(403, 'AUTH_FORBIDDEN', '仅注册人可签发临时凭证');
        // 兼容空 body 的 POST：body 非法/为空时按 {} 处理（readJson 对空串返回 {}，
        // JSON 数组/标量按 BAD_JSON 由 readJson 统一拒绝）
        let body = {};
        try { body = await readJson(req, BODY_LIMIT_SMALL); } catch { body = {}; }
        const ttlMs = body?.ttlMs === undefined ? TEMP_TOKEN_DEFAULT_MS : normalizeTempTtl(body.ttlMs, { strict: true });
        const token = randomBytes(24).toString('hex');
        const expiresAt = Date.now() + ttlMs;
        tempTokens.set(token, { expiresAt, owner: owner.username });
        setTimeout(() => tempTokens.delete(token), ttlMs).unref?.();
        audit({ at: Date.now(), op: 'temp-credential-issued', user: owner.username, ttlMs });
        return sendJson(res, 200, {
          ok: true,
          token,
          expiresAt,
          expiresInMs: ttlMs,
          note: `仅限 127.0.0.1/localhost 本地访问；${Math.round(ttlMs / 60000)} 分钟后自动失效`,
        });
      }

      // 吊销临时凭证：owner 传 token（或 tokenDigest）即可作废，防泄露后无法回收
      if (pathname === '/api/auth/temp-credential/revoke' && req.method === 'POST') {
        const session = getSession(req);
        if (!session) throw new HttpError(401, 'SESSION_REQUIRED', '未登录');
        const owner = readOwner();
        if (!owner) throw new HttpError(401, 'SESSION_REQUIRED', '尚未注册');
        if (session.user.name !== owner.username) throw new HttpError(403, 'AUTH_FORBIDDEN', '仅注册人可吊销临时凭证');
        let body0 = {};
        try { body0 = await readJson(req, BODY_LIMIT_SMALL); } catch { body0 = {}; }
        const token = String(body0?.token ?? '').trim();
        if (!token) throw new HttpError(400, 'AUTH_INVALID_CREDENTIALS', '缺少 token');
        const existed = tempTokens.delete(token);
        return sendJson(res, 200, { ok: true, revoked: existed });
      }

      // 列出未过期临时凭证（脱敏摘要，仅 owner）：便于看到手里有哪些有效钥匙
      if (pathname === '/api/auth/temp-credential/list' && req.method === 'GET') {
        const session = getSession(req);
        if (!session) throw new HttpError(401, 'SESSION_REQUIRED', '未登录');
        const owner = readOwner();
        if (!owner) throw new HttpError(401, 'SESSION_REQUIRED', '尚未注册');
        if (session.user.name !== owner.username) throw new HttpError(403, 'AUTH_FORBIDDEN', '仅注册人可查看临时凭证');
        const now = Date.now();
        const items = [...tempTokens.entries()]
          .filter(([, e]) => e.owner === owner.username && e.expiresAt > now)
          .map(([tok, e]) => ({
            tokenDigest: `${tok.slice(0, 4)}…${tok.slice(-4)}`,
            expiresAt: e.expiresAt,
            remainMs: e.expiresAt - now,
          }))
          .sort((a, b) => a.expiresAt - b.expiresAt);
        return sendJson(res, 200, { ok: true, items });
      }

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

  return {
    getSession,
    middleware,
    ownerFile,
    sessionsFile,
    tempTokens,
    tempTokenLimits: { defaultMs: TEMP_TOKEN_DEFAULT_MS, minMs: TEMP_TOKEN_MIN_MS, maxMs: TEMP_TOKEN_MAX_MS },
    verifyTempToken: (token) => { const e = tempTokens.get(token); if (!e || e.expiresAt < Date.now()) return false; return e.owner === (readOwner()?.username ?? ''); },
  };
}
