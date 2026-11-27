/**
 * token-ledger 服务端半边：
 *
 * 1. 注册 kv 服务消费者（registry）——server 内直接写 kv-store 的 sqlite，
 *    与前端 cap.kv dispatch 同一份存储（namespace: token-ledger）；
 * 2. 暴露 POST /api/token-ledger/backfill-agent-runs：重导 <dataDir>/agent-runs/*.events.jsonl
 *    里的全部 ai.usage 事件到台账（服务器侧权威回填源，含全部轮次与缓存字段）。
 *
 * 背景（2026-11-27 核查）：agent-loop 每轮 engineTurn 都 emit 一条 ai.usage
 * （messageId 同为 assistantId），前端按 sessionId::messageId 幂等去重导致
 * 每消息只记第一轮（9826 实测丢账 94%）。事件原件在 agent-runs 落盘，
 * 本端点把逐轮记录全部补进台账，id 以 at 时间戳保轮次唯一。
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const NS = 'token-ledger';

/** UsageRecord 形状（与前端 ledgerStore 保持一致） */
function makeRecord(payload, at) {
  const inT = Math.max(0, Number(payload.inputTokens ?? 0));
  const outT = Math.max(0, Number(payload.outputTokens ?? 0));
  if (inT === 0 && outT === 0) return null;
  const cached = Number(payload.cachedTokens ?? 0);
  const cc = Number(payload.cacheCreationTokens ?? 0);
  return {
    // 轮次唯一 id：sessionId::messageId::at（同消息多轮天然区分）
    id: `${payload.sessionId}::${payload.messageId}::${at}`,
    at,
    sessionId: String(payload.sessionId),
    messageId: String(payload.messageId),
    model: payload.model || undefined,
    inputTokens: inT,
    outputTokens: outT,
    cachedTokens: cached > 0 ? cached : undefined,
    cacheCreationTokens: cc > 0 ? cc : undefined,
    durationMs: payload.durationMs != null ? Math.max(0, Number(payload.durationMs)) : undefined,
    estimated: payload.estimated === true,
    source: 'agent-runs',
  };
}

/** 扫描 agent-runs 目录，收集全部 ai.usage 事件 */
function scanUsageEvents(runsDir) {
  const out = [];
  if (!existsSync(runsDir)) return out;
  for (const f of readdirSync(runsDir)) {
    if (!f.endsWith('.events.jsonl')) continue;
    let text;
    try {
      text = readFileSync(join(runsDir, f), 'utf8');
    } catch {
      continue; // 单文件读失败跳过，不阻断整体
    }
    for (const line of text.split('\n')) {
      if (!line.includes('"ai.usage"')) continue; // 快速预筛
      let j;
      try {
        j = JSON.parse(line);
      } catch {
        continue;
      }
      if (j?.kind !== 'ai.usage' || !j?.payload) continue;
      const p = j.payload;
      if (!p.sessionId || !p.messageId) continue;
      const rec = makeRecord(p, Number(j.at ?? p.at ?? Date.now()));
      if (rec) out.push(rec);
    }
  }
  out.sort((a, b) => a.at - b.at);
  return out;
}

/** 载荷内嵌去重：同 id（=同轮）只留一条 */
function dedupeById(records) {
  const seen = new Set();
  const out = [];
  for (const r of records) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

/** 把记录按 day.<YYYY-MM-DD> 分桶 */
function bucketByDay(records) {
  const days = new Map();
  for (const r of records) {
    const d = new Date(r.at);
    const dk = `day.${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (!days.has(dk)) days.set(dk, []);
    days.get(dk).push(r);
  }
  return days;
}

/** 聚合（与前端 aggFromRows 同口径） */
function aggRows(rows) {
  const a = { in: 0, out: 0, cached: 0, turns: 0, est: 0, realIn: 0, cachedTurns: 0 };
  for (const r of rows) {
    a.in += r.inputTokens;
    a.out += r.outputTokens;
    a.cached += r.cachedTokens ?? 0;
    if (!r.estimated) a.realIn += r.inputTokens;
    if ((r.cachedTokens ?? 0) > 0) a.cachedTurns += 1;
    if (r.estimated) a.est += 1;
    a.turns += 1;
  }
  return a;
}

export function createServerPart(options = {}) {
  const dataDir = options.dataDir;
  const runsDir = join(dataDir, 'agent-runs');
  const getSession = options.getSession;
  const kv = options.registry?.getService?.('kv-store') ?? null;

  /** server 侧 kv 读写（与 kv-store server.mjs 的 fullId 约定一致） */
  const kvGet = async (key) => {
    if (!kv) return null;
    try {
      return await kv.get(NS, key);
    } catch {
      return null;
    }
  };
  const kvSet = async (key, value) => {
    if (kv) await kv.set(NS, key, value);
  };

  return async function tokenLedgerServer(req, res, next) {
    const [pathname] = (req.url ?? '').split('?');
    if (!pathname.startsWith('/api/token-ledger/')) return next?.();

    // 会话 cookie 硬门禁（与 kv-store 同款）
    if (!getSession?.(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ error: 'unauthorized', code: 'SESSION_REQUIRED' }));
    }

    if (pathname === '/api/token-ledger/backfill-agent-runs' && req.method === 'POST') {
      try {
        const records = dedupeById(scanUsageEvents(runsDir));
        const days = bucketByDay(records);

        // 已有台账记录（防重复导入）：收集现有 id
        const existing = new Set();
        const dayKeys = typeof kv?.keysWithPrefix === 'function' ? kv.keysWithPrefix(NS, 'day.') : [];
        for (const dk of dayKeys) {
          const arr = await kvGet(dk);
          if (Array.isArray(arr)) for (const r of arr) existing.add(r.id);
        }

        // 合并写入：day 键读改写 + totals 重算
        const totals = (await kvGet('totals')) ?? { grand: {}, months: {} };
        let imported = 0;
        for (const [dk, rows] of days) {
          const fresh = rows.filter((r) => !existing.has(r.id));
          if (fresh.length === 0) continue;
          const cur = (await kvGet(dk)) ?? [];
          const merged = [...cur, ...fresh].sort((a, b) => a.at - b.at);
          await kvSet(dk, merged);
          imported += fresh.length;
          // 同步 totals（重算该天聚合）
          const month = dk.slice(4, 11);
          const day = dk.slice(8);
          totals.months[month] ??= {};
          totals.months[month][day] = aggRows(merged);
        }
        // grand 重算
        const g = { in: 0, out: 0, cached: 0, turns: 0, est: 0, realIn: 0, cachedTurns: 0 };
        for (const m of Object.values(totals.months)) {
          for (const d of Object.values(m)) {
            g.in += d.in; g.out += d.out; g.cached += d.cached;
            g.turns += d.turns; g.est += d.est;
            g.realIn += d.realIn ?? 0; g.cachedTurns += d.cachedTurns ?? 0;
          }
        }
        totals.grand = g;
        await kvSet('totals', totals);

        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify({ ok: true, imported, files: 0 }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
      }
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'not found' }));
  };
}
