/**
 * kv-store 插件的服务端半边（/api/kv/*）：通用键值存储（sqlite 落盘）。
 *
 * 这是「插件双入口」的服务端那一半：UI 半边在浏览器（index.ts 注册 cap.kv，
 * 经 /api/kv/* 读写），本文件提供 Node 侧实现，由 plugins/server-registry.mjs
 * 登记、server/host.mjs 统一装配。宿主不认识 /api/kv/* 的任何语义。
 *
 * 为什么要有它：此前插件数据落浏览器 localStorage（cap.config）——换浏览器/清缓存/
 * 多端使用即丢。kv-store 把存储上收到服务端 sqlite（单文件 <dataDir>/stores/kv-store.db），
 * 浏览器侧只是缓存视图；桌面/手机/Web 打开同一份。
 *
 * 安全模型（对齐 html-preview server 半边）：
 * - 会话 cookie 硬门禁（未登录 401）；PLITE_KV=0 一键禁用；
 * - namespace 由插件自报（建议用插件 id），key ≤ 200 字符，value ≤ 1MB；
 * - sqlite 预编译语句，无 SQL 拼接；写入同步落盘（WAL）。
 *
 * 跨插件访问（2026-11-26）：除了 HTTP 端点，本插件还把**领域操作**注册进
 * server/adapter-registry 的 service 表（id='kv-store'）。其它插件的 server 半边
 * （agent-runner 的 ledger 工具等）经 `registry.getService('kv-store')` 使用，
 * 不再自己 new DatabaseSync 复制本插件的表结构——换存储实现时消费方零改动。
 *
 * 端点：
 *   GET  /api/kv/get?namespace=&key=     → { value } | { value: null }
 *   POST /api/kv/set   { namespace, key, value }
 *   POST /api/kv/delete{ namespace, key }
 *   GET  /api/kv/list?namespace=       → { keys: string[] }
 */
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MAX_KEY_LEN = 200;
const MAX_VALUE_BYTES = 1024 * 1024; // 1MB/键（记账日键、设置等远小于此）

/**
 * KV 存储访问器（同步）：HTTP 半边与其它插件 server 半边共用。
 *
 * 建库延迟到首次读写：createHost 阶段不持 sqlite 句柄，避免 Windows 下
 * 测试/热重启 rmSync 数据目录时 EPERM（WAL 文件被锁）。
 */
export function createKvAccess({ dataDir }) {
  const dbPath = resolve(resolve(dataDir ?? '.polaris-lite'), 'stores', 'kv-store.db');
  let db = null;
  let stmtGet = null;
  let stmtSet = null;
  let stmtDel = null;
  let stmtList = null;

  function ensureDb() {
    if (db) return db;
    mkdirSync(dirname(dbPath), { recursive: true });
    db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec(`CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    stmtGet = db.prepare('SELECT data FROM items WHERE id = ?');
    stmtSet = db.prepare(`INSERT INTO items (id, data, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`);
    stmtDel = db.prepare('DELETE FROM items WHERE id = ?');
    stmtList = db.prepare("SELECT id FROM items WHERE id LIKE ? || '%' ORDER BY id");
    return db;
  }

  function fullId(namespace, key) {
    const ns = String(namespace ?? '').trim();
    const k = String(key ?? '').trim();
    if (!ns || ns.includes('/') || ns.includes('?')) throw new Error('namespace 不合法');
    if (!k) throw new Error('key 不能为空');
    const id = `${ns}.${k}`;
    if (id.length > MAX_KEY_LEN + ns.length + 1) throw new Error('key 过长');
    return id;
  }

  return {
    /** 读一个键；不存在返回 null。JSON 损坏视为不存在（不 brick 调用方）。 */
    get(namespace, key) {
      ensureDb();
      const row = stmtGet.get(fullId(namespace, key));
      if (!row) return null;
      try { return JSON.parse(row.data); } catch { return null; }
    },
    /** 写一个键；value 超过 1MB 抛错（调用方转业务错误）。 */
    set(namespace, key, value) {
      ensureDb();
      const id = fullId(namespace, key);
      const json = JSON.stringify(value ?? null);
      if (Buffer.byteLength(json, 'utf8') > MAX_VALUE_BYTES) {
        throw new Error(`value 过大（> ${MAX_VALUE_BYTES} bytes）`);
      }
      stmtSet.run(id, json, Date.now());
    },
    del(namespace, key) {
      ensureDb();
      stmtDel.run(fullId(namespace, key));
    },
    /** 某 namespace 下的全部键（去掉 `ns.` 前缀） */
    keys(namespace) {
      ensureDb();
      const ns = String(namespace ?? '').trim();
      if (!ns) return [];
      return stmtList.all(`${ns}.`).map((r) => String(r.id).slice(ns.length + 1));
    },
    /** 某 namespace 下匹配前缀的键（去掉 `ns.` 前缀），升序 */
    keysWithPrefix(namespace, prefix) {
      ensureDb();
      const ns = String(namespace ?? '').trim();
      if (!ns) return [];
      return stmtList.all(`${ns}.${String(prefix ?? '')}`).map((r) => String(r.id).slice(ns.length + 1));
    },
  };
}

export function createServerPart(options = {}) {
  const getSession = options.getSession;
  const hardOff = process.env.PLITE_KV === '0';
  const access = createKvAccess({ dataDir: options.dataDir });
  // 跨插件服务注册（consumer 见 agent-runner 的 kv 适配）
  options.registry?.registerService?.('kv-store', access);

  return async function kvApi(req, res, next) {
    if (hardOff) return next?.();
    const [pathname] = (req.url ?? '').split('?');
    if (!pathname.startsWith('/api/kv/')) return next?.();

    // 会话 cookie 硬门禁
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
      req.on('data', (c) => { b += c; if (b.length > MAX_VALUE_BYTES + 4096) req.destroy(); });
      req.on('end', () => r(b));
    });

    try {
      const url = new URL(req.url, 'http://x');

      if (pathname === '/api/kv/get' && req.method === 'GET') {
        const value = access.get(url.searchParams.get('namespace'), url.searchParams.get('key'));
        return sendJson(200, { value });
      }

      if (pathname === '/api/kv/set' && req.method === 'POST') {
        const body = JSON.parse((await readBody()) || '{}');
        access.set(body.namespace, body.key, body.value);
        return sendJson(200, { ok: true });
      }

      if (pathname === '/api/kv/delete' && req.method === 'POST') {
        const body = JSON.parse((await readBody()) || '{}');
        access.del(body.namespace, body.key);
        return sendJson(200, { ok: true });
      }

      if (pathname === '/api/kv/list' && req.method === 'GET') {
        const ns = String(url.searchParams.get('namespace') ?? '').trim();
        if (!ns) return sendJson(400, { error: 'namespace required' });
        return sendJson(200, { keys: access.keys(ns) });
      }

      return sendJson(404, { error: 'not found' });
    } catch (e) {
      return sendJson(400, { error: String(e?.message ?? e) });
    }
  };
}
