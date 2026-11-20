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
 * 端点：
 *   GET  /api/kv/get?namespace=&key=     → { value } | { value: null }
 *   POST /api/kv/set   { namespace, key, value }
 *   POST /api/kv/delete{ namespace, key }
 *   GET  /api/kv/list?namespace=       → { keys: string[] }
 */
import { existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MAX_KEY_LEN = 200;
const MAX_VALUE_BYTES = 1024 * 1024; // 1MB/键（记账日键、设置等远小于此）

export function createServerPart(options = {}) {
  const getSession = options.getSession;
  const dataDir = resolve(options.dataDir ?? '.polaris-lite');
  const dbPath = resolve(dataDir, 'stores', 'kv-store.db');
  const hardOff = process.env.PLITE_KV === '0';

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

  // 建库延迟到首个请求：createHost 阶段不持 sqlite 句柄，避免 Windows 下
  // 测试/热重启 rmSync 数据目录时 EPERM（WAL 文件被锁）。
  // fail-fast 语义保留：首个请求即建库，库打不开该请求 500 暴露问题。

  function fullId(namespace, key) {
    const ns = String(namespace ?? '').trim();
    const k = String(key ?? '').trim();
    if (!ns || ns.includes('/') || ns.includes('?')) throw new Error('namespace 不合法');
    if (!k) throw new Error('key 不能为空');
    const id = `${ns}.${k}`;
    if (id.length > MAX_KEY_LEN + ns.length + 1) throw new Error('key 过长');
    return id;
  }

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
      ensureDb();
      const url = new URL(req.url, 'http://x');

      if (pathname === '/api/kv/get' && req.method === 'GET') {
        const id = fullId(url.searchParams.get('namespace'), url.searchParams.get('key'));
        const row = stmtGet.get(id);
        return sendJson(200, { value: row ? JSON.parse(row.data) : null });
      }

      if (pathname === '/api/kv/set' && req.method === 'POST') {
        const body = JSON.parse((await readBody()) || '{}');
        const id = fullId(body.namespace, body.key);
        const json = JSON.stringify(body.value ?? null);
        if (Buffer.byteLength(json, 'utf8') > MAX_VALUE_BYTES) {
          return sendJson(400, { error: `value 过大（> ${MAX_VALUE_BYTES} bytes）` });
        }
        stmtSet.run(id, json, Date.now());
        return sendJson(200, { ok: true });
      }

      if (pathname === '/api/kv/delete' && req.method === 'POST') {
        const body = JSON.parse((await readBody()) || '{}');
        const id = fullId(body.namespace, body.key);
        stmtDel.run(id);
        return sendJson(200, { ok: true });
      }

      if (pathname === '/api/kv/list' && req.method === 'GET') {
        const ns = String(url.searchParams.get('namespace') ?? '').trim();
        if (!ns) return sendJson(400, { error: 'namespace required' });
        const rows = stmtList.all(`${ns}.`);
        return sendJson(200, { keys: rows.map((r) => r.id.slice(ns.length + 1)) });
      }

      return sendJson(404, { error: 'not found' });
    } catch (e) {
      return sendJson(400, { error: String(e?.message ?? e) });
    }
  };
}
