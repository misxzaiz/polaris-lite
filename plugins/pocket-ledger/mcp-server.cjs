#!/usr/bin/env node
'use strict';
/**
 * pocket-ledger MCP Server（polaris-lite 版）—— 日常记账的 AI 工具层（stdio，零依赖）
 *
 * 与原版 Polaris-plugin/pocket-ledger/mcp/server.js 的差异：原版走老 Polaris 的
 * router_dispatch IPC；本版直连 polaris-lite kv-store 的 sqlite 落盘文件
 * （<dataDir>/stores/kv-store.db，WAL 模式支持多进程并发读写），键形态
 * `pocket-ledger.ledger.day.<YYYY-MM-DD>` / `pocket-ledger.ledger.settings`——
 * 与插件前端半边（cap.kv）同一数据面，双侧天然同账。
 * 计算全部走 ledger-core.cjs（单一权威，与面板/AI 工具层口径一致）。
 *
 * 连接参数经 mcp-servers.json 的 env 注入：PLITE_DATA_DIR（数据目录）。
 * 工具一览：ledger_add / ledger_query / ledger_stats / ledger_delete /
 *           ledger_update / ledger_categories（与 cap.tool.ledger 同动作集）。
 */
const readline = require('node:readline');
const { existsSync, mkdirSync } = require('node:fs');
const { resolve, dirname } = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// ledger-core.cjs 与本脚本同目录（plugins/pocket-ledger/）
const core = require(require('node:path').join(__dirname, 'ledger-core.cjs'));

const SERVER_INFO = { name: 'pocket-ledger', version: '0.4.0' };
const PROTOCOL_VERSION = '2024-11-05';
const NS = 'pocket-ledger';

// ---- 数据面：sqlite 直连（与 kv-store 同库同键；WAL 并发安全）----
let db = null;
function ensureDb() {
  if (db) return db;
  const dataDir = resolve(process.env.PLITE_DATA_DIR ?? '.polaris-lite');
  const dbPath = resolve(dataDir, 'stores', 'kv-store.db');
  if (!existsSync(dbPath)) {
    // 库未建（kv-store 懒建库）：先建同构表，kv-store 后续 ensureDb 走 CREATE IF NOT EXISTS 不冲突
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(`CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  return db;
}

function kvGet(key) {
  const d = ensureDb();
  const row = d.prepare('SELECT data FROM items WHERE id = ?').get(`${NS}.${key}`);
  return row ? JSON.parse(row.data) : null;
}
function kvSet(key, value) {
  const d = ensureDb();
  d.prepare('INSERT INTO items (id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
    .run(`${NS}.${key}`, JSON.stringify(value ?? null), Date.now());
}
function kvDel(key) {
  ensureDb().prepare('DELETE FROM items WHERE id = ?').run(`${NS}.${key}`);
}
function kvKeys(prefix) {
  const rows = ensureDb().prepare("SELECT id FROM items WHERE id LIKE ? || '%' ORDER BY id").all(`${NS}.${prefix}`);
  return rows.map((r) => r.id.slice(NS.length + 1));
}

// ---- 账本数据访问（与插件 store.ts 同口径）----
async function loadSettings() {
  const s = kvGet(core.K.settings);
  return { ...core.DEFAULT_SETTINGS, ...(s && typeof s === 'object' ? s : {}) };
}
function validCategories(settings) {
  return [...new Set([...(settings.categories || []), ...(settings.incomeCategories || [])])];
}
async function loadMonth(month) {
  const keys = kvKeys(core.K.dayPrefixOf(month));
  const all = [];
  for (const dayKey of keys.sort()) {
    const bills = kvGet(dayKey) ?? [];
    if (Array.isArray(bills)) all.push(...bills);
  }
  return all;
}
async function loadDay(day) {
  const bills = kvGet(core.K.day(day)) ?? [];
  return Array.isArray(bills) ? bills : [];
}

// ---- 工具集 ----
const tools = [
  {
    name: 'ledger_add',
    description: '记一笔账。用户说「午饭 35」「打车 48」这类消费/收入时调用：amount=金额（正数），type 缺省 expense（收入才传 income），category 从语境选（餐饮/交通/购物/居住/娱乐/医疗/学习/人情/其他；收入用 工资/理财/红包/退款/其他收入），note 简短备注，时间不明传 date（today/yesterday/YYYY-MM-DD），timeOfDay 可选时段档位。入账响应自带预算提醒。',
    inputSchema: {
      type: 'object',
      properties: {
        amount: { type: 'number', description: '金额（正数；必填）' },
        type: { type: 'string', description: 'expense（默认）| income' },
        category: { type: 'string', description: '分类；不传由 AI 按语境选' },
        note: { type: 'string', description: '备注（含菜品/事由，可辅助时段推导）' },
        date: { type: 'string', description: 'today | yesterday | YYYY-MM-DD（补记）' },
        time: { type: 'string', description: 'HH:MM（24h，明确时刻）' },
        timeOfDay: { type: 'string', description: 'early_morning/morning/noon/afternoon/evening/night 或中文（凌晨/早上/中午/下午/傍晚/晚上）' },
      },
      required: ['amount'],
    },
  },
  {
    name: 'ledger_query',
    description: '查账单。用户问「昨天花了多少」「查一下打车」用本工具：month（this/last/YYYY-MM）或 date（today/yesterday/YYYY-MM-DD）二选一，可加 category/type/keyword 过滤，limit 默认 20。',
    inputSchema: {
      type: 'object',
      properties: {
        month: { type: 'string', description: 'this | last | YYYY-MM' },
        date: { type: 'string', description: 'today | yesterday | YYYY-MM-DD' },
        category: { type: 'string' },
        type: { type: 'string', description: 'expense | income' },
        keyword: { type: 'string', description: '备注/分类关键词' },
        limit: { type: 'number', description: '返回条数上限（默认 20，最大 100）' },
      },
    },
  },
  {
    name: 'ledger_stats',
    description: '月度统计与预算提醒。用户问「这个月怎么样」「预算还剩多少」用本工具：month（this/last/YYYY-MM，默认本月）。',
    inputSchema: {
      type: 'object',
      properties: { month: { type: 'string', description: 'this | last | YYYY-MM' } },
    },
  },
  {
    name: 'ledger_delete',
    description: '删除一笔账单（按 id；从 ledger_query 结果取）。',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'ledger_update',
    description: '修改一笔账单（按 id；可改 amount/category/note/date/time/timeOfDay，跨日自动迁移）。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        patch: { type: 'object', description: '{ amount?, category?, note?, date?, time?, timeOfDay? }' },
      },
      required: ['id'],
    },
  },
  {
    name: 'ledger_categories',
    description: '查看/增删自定义分类：op=list（默认）| add | remove，add/remove 需 name + kind（expense|income）。',
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', description: 'list | add | remove' },
        name: { type: 'string' },
        kind: { type: 'string', description: 'expense | income' },
      },
    },
  },
];

async function callTool(name, args) {
  const settings = await loadSettings();
  switch (name) {
    case 'ledger_add': {
      // 与插件 store.ts addBill 同口径：先 resolveBillTime 解析 ts，再 normalizeBill
      const resolved = core.resolveBillTime({
        date: args?.date,
        time: args?.time,
        timeOfDay: args?.timeOfDay,
        hint: args?.note,
      }, Date.now());
      if (resolved.error) throw new Error(resolved.error);
      const bill = core.normalizeBill({
        amount: Number(args?.amount),
        type: args?.type === 'income' ? 'income' : 'expense',
        category: args?.category,
        note: args?.note,
        ts: resolved.ts,
      }, validCategories(settings));
      if (!bill || bill.error) throw new Error(bill?.error ?? '账单参数不合法（amount 必须为正数）');
      const dk = core.K.day(core.dayKeyOf(bill.bill.ts));
      const existing = await loadDay(dk);
      kvSet(dk, core.appendBills(existing, [bill.bill]));
      const month = core.monthOf(bill.bill.ts);
      const bills = await loadMonth(month);
      const stats = core.computeStats(bills, settings, month);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, id: bill.bill.id, ...stats.hint ? { hint: stats.hint } : {} }) }] };
    }
    case 'ledger_query': {
      let bills;
      if (args?.date) {
        const day = args.date === 'yesterday' || args.date === '昨天' ? core.dayKeyOf(Date.now() - 24 * 3600 * 1000)
          : args.date === 'today' || args.date === '今天' ? core.dayKeyOf(Date.now()) : String(args.date);
        bills = await loadDay(day);
      } else {
        const month = !args?.month || args.month === 'this' ? core.currentMonth() : args.month === 'last' ? core.shiftMonth(core.currentMonth(), -1) : String(args.month);
        bills = await loadMonth(month);
      }
      const filtered = core.filterBills(bills, {
        category: args?.category,
        type: args?.type === 'income' || args?.type === 'expense' ? args.type : undefined,
        keyword: args?.keyword,
      });
      const sorted = filtered.slice().sort((a, b) => b.ts - a.ts);
      const limited = sorted.slice(0, Math.min(Math.max(1, Number(args?.limit) || 20), 100));
      return { content: [{ type: 'text', text: JSON.stringify({
        ok: true, count: filtered.length,
        bills: limited.map((b) => ({ id: b.id, time: new Date(b.ts).toLocaleString('zh-CN', { hour12: false }), type: b.type, amount: b.amount, category: b.category, note: b.note })),
      }) }] };
    }
    case 'ledger_stats': {
      const month = !args?.month || args.month === 'this' ? core.currentMonth() : args.month === 'last' ? core.shiftMonth(core.currentMonth(), -1) : String(args.month);
      const bills = await loadMonth(month);
      const stats = core.computeStats(bills, settings, month);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, month, ...stats, hint: core.budgetHint(stats) }) }] };
    }
    case 'ledger_delete': {
      const id = String(args?.id ?? '');
      let found = false;
      // id 里带日期（date-key 结构）：扫近 3 个月日键（覆盖补记/改期场景）
      for (let delta = 0; delta < 3 && !found; delta += 1) {
        const month = core.shiftMonth(core.currentMonth(), -delta);
        const keys = kvKeys(core.K.dayPrefixOf(month));
        for (const dayKey of keys) {
          const bills = kvGet(dayKey) ?? [];
          if (!Array.isArray(bills) || !bills.some((b) => b.id === id)) continue;
          kvSet(dayKey, core.removeBill(bills, id));
          found = true;
          break;
        }
      }
      return { content: [{ type: 'text', text: JSON.stringify({ ok: found, id }) }] };
    }
    case 'ledger_update': {
      const id = String(args?.id ?? '');
      const patch = args?.patch ?? {};
      let result = { ok: false, id, error: '账单不存在' };
      for (let delta = 0; delta < 3 && !result.ok; delta += 1) {
        const month = core.shiftMonth(core.currentMonth(), -delta);
        const keys = kvKeys(core.K.dayPrefixOf(month));
        for (const dayKey of keys) {
          const bills = kvGet(dayKey) ?? [];
          if (!Array.isArray(bills) || !bills.some((b) => b.id === id)) continue;
          const { arr, found, moved, bill } = core.updateBill(bills, id, patch);
          if (!found) continue;
          if (moved && bill) {
            // 跨日迁移：原日键移除，新日键（按账单日期）追加
            kvSet(dayKey, core.removeBill(arr, id));
            const newDay = core.K.day(core.dayKeyOf(bill.ts));
            const target = kvGet(newDay) ?? [];
            kvSet(newDay, core.appendBills(target, [bill]));
          } else {
            kvSet(dayKey, arr);
          }
          result = { ok: true, id, moved };
          break;
        }
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    case 'ledger_categories': {
      const op = String(args?.op ?? 'list');
      if (op === 'add' || op === 'remove') {
        const name = String(args?.name ?? '').trim();
        const kind = args?.kind === 'income' ? 'income' : 'expense';
        if (!name) throw new Error('name 必填');
        const key = kind === 'income' ? 'incomeCategories' : 'categories';
        const list = [...(settings[key] ?? [])];
        const idx = list.indexOf(name);
        if (op === 'add' && idx < 0) list.push(name);
        if (op === 'remove' && idx >= 0) list.splice(idx, 1);
        kvSet(core.K.settings, { ...settings, [key]: list });
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, kind, categories: list }) }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, categories: settings.categories ?? [], incomeCategories: settings.incomeCategories ?? [] }) }] };
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// ---- stdio JSON-RPC 循环（与 mcp-demo/server.mjs 同款）----
function respond(msg, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
}
function respondError(msg, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code, message } }) + '\n');
}
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); } catch { return; }
  if (msg.id === undefined) return;
  Promise.resolve()
    .then(() => {
      switch (msg.method) {
        case 'initialize':
          return respond(msg, {
            protocolVersion: msg.params?.protocolVersion ?? PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
          });
        case 'tools/list':
          return respond(msg, { tools });
        case 'tools/call':
          return callTool(msg.params?.name, msg.params?.arguments)
            .then((r) => respond(msg, r))
            .catch((e) => respond(msg, { content: [{ type: 'text', text: `错误: ${e?.message ?? e}` }], isError: true }));
        case 'ping':
          return respond(msg, {});
        default:
          return respondError(msg, -32601, `method not found: ${msg.method}`);
      }
    })
    .catch((e) => respondError(msg, -32603, String(e?.message ?? e)));
});
