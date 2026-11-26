/**
 * pocket-ledger 在服务端执行域的工具声明（ledger）。
 * 计算内核 ledger-core.cjs 由 server.mjs 加载后传入（tool.mjs 不碰 node:* 模块，
 * 以通过插件运行时代码的依赖门禁）；kv 读写经 runner 注入的 host.kv。
 */
const FEEDBACK_CAP = 8 * 1024;
const LEDGER_NS = 'pocket-ledger';

export function registerLedgerTool(registry, { ledgerCore }) {
  const settingsOf = (kv) => {
    const s = kv.get(LEDGER_NS, 'settings');
    return { ...ledgerCore.DEFAULT_SETTINGS, ...(s && typeof s === 'object' ? s : {}) };
  };

  async function execLedger(args, kv) {
    const settings = settingsOf(kv);
    const valid = [...new Set([...(settings.categories ?? []), ...(settings.incomeCategories ?? [])])];
    const action = String(args.action ?? '');
    if (action === 'add') {
      let ts;
      if (Number(args.ts) > 0) ts = Number(args.ts);
      else {
        const resolved = ledgerCore.resolveBillTime({ date: args.date, time: args.time, timeOfDay: args.timeOfDay, hint: args.note }, Date.now());
        if (resolved.error) return { ok: false, error: resolved.error };
        ts = resolved.ts;
      }
      const norm = ledgerCore.normalizeBill({ amount: Number(args.amount), type: args.type === 'income' ? 'income' : 'expense', category: args.category, note: args.note, ts, source: 'ai' }, valid);
      if (norm.error || !norm.bill) return { ok: false, error: norm.error ?? '账单不合法' };
      const bill = norm.bill;
      const dk = ledgerCore.K.day(ledgerCore.dayKeyOf(bill.ts));
      const existing = kv.get(LEDGER_NS, dk) ?? [];
      const merged = ledgerCore.appendBills(Array.isArray(existing) ? existing : [], [bill]);
      kv.set(LEDGER_NS, dk, merged);
      return { ok: true, stdout: JSON.stringify({ ok: true, bill, total: merged.length }) };
    }
    if (action === 'query' || action === 'stats') {
      const month = args.month === 'last' ? ledgerCore.shiftMonth(ledgerCore.currentMonth(), -1)
        : args.month && args.month !== 'this' ? String(args.month) : ledgerCore.currentMonth();
      const prefix = `ledger.day.${month}-`;
      let bills = [];
      for (const dk of kv.keys(LEDGER_NS, 'ledger.day.')) {
        if (!dk.startsWith(prefix)) continue;
        const arr = kv.get(LEDGER_NS, dk);
        if (Array.isArray(arr)) bills.push(...arr);
      }
      bills = ledgerCore.filterBills(bills, { category: args.category, type: args.type === 'income' ? 'income' : args.type === 'expense' ? 'expense' : undefined, keyword: args.keyword });
      if (action === 'stats') {
        const stats = ledgerCore.computeStats(bills, settings, month);
        const hint = ledgerCore.budgetHint(stats);
        return { ok: true, stdout: JSON.stringify({ month, stats, ...(hint ? { hint } : {}) }).slice(0, FEEDBACK_CAP) };
      }
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
      const slim = bills.slice(-limit).reverse().map((b) => ({ id: b.id, amount: b.amount, type: b.type, category: b.category, note: b.note, time: new Date(b.ts).toLocaleString('zh-CN', { hour12: false }) }));
      return { ok: true, stdout: JSON.stringify({ month, count: bills.length, bills: slim }).slice(0, FEEDBACK_CAP) };
    }
    if (action === 'delete' || action === 'update') {
      const id = String(args.id ?? '');
      if (!id) return { ok: false, error: 'id required（先用 query 拿 id）' };
      for (const dk of kv.keys(LEDGER_NS, 'ledger.day.')) {
        const arr = kv.get(LEDGER_NS, dk);
        if (!Array.isArray(arr)) continue;
        if (action === 'delete') {
          const { arr: next, removed } = ledgerCore.removeBill(arr, id);
          if (removed) { kv.set(LEDGER_NS, dk, next); return { ok: true, stdout: JSON.stringify({ ok: true, deleted: id }) }; }
        } else {
          const patch = args.patch ?? {};
          let ts;
          if (patch.date !== undefined || patch.time !== undefined || patch.timeOfDay !== undefined) {
            const resolved = ledgerCore.resolveBillTime({ date: patch.date, time: patch.time, timeOfDay: patch.timeOfDay, hint: patch.note }, Date.now());
            if (!resolved.error) ts = resolved.ts;
          }
          const { arr: updated, found, bill } = ledgerCore.updateBill(arr, id, { amount: patch.amount !== undefined ? Number(patch.amount) : undefined, category: patch.category, note: patch.note, type: patch.type, ts });
          if (found) { kv.set(LEDGER_NS, dk, updated); return { ok: true, stdout: JSON.stringify({ ok: true, bill }) }; }
        }
      }
      return { ok: false, error: `未找到账单 ${id}（先用 query 拿 id）` };
    }
    if (action === 'categories') {
      const op = String(args.op ?? 'list');
      if (op === 'list') return { ok: true, stdout: JSON.stringify({ categories: settings.categories, incomeCategories: settings.incomeCategories, budgets: settings.budgets }).slice(0, FEEDBACK_CAP) };
      if (op === 'add') {
        const name = String(args.name ?? '').trim();
        const kind = args.kind === 'income' ? 'incomeCategories' : 'categories';
        if (!name) return { ok: false, error: 'name required' };
        if (settings[kind].includes(name)) return { ok: true, stdout: JSON.stringify({ ok: true, already: true }) };
        settings[kind].push(name);
        kv.set(LEDGER_NS, 'settings', settings);
        return { ok: true, stdout: JSON.stringify({ ok: true, categories: settings[kind] }) };
      }
      if (op === 'remove') {
        const name = String(args.name ?? '').trim();
        const kind = args.kind === 'income' ? 'incomeCategories' : 'categories';
        settings[kind] = (settings[kind] ?? []).filter((c) => c !== name);
        delete settings.budgets[name];
        kv.set(LEDGER_NS, 'settings', settings);
        return { ok: true, stdout: JSON.stringify({ ok: true, removed: true }) };
      }
      return { ok: false, error: `unknown op: ${op}` };
    }
    return { ok: false, error: `unknown action: ${action}（可用：add/query/stats/delete/update/categories）` };
  }

  registry.registerTool({
    name: 'ledger',
    descriptor: {
      type: 'function',
      function: {
        name: 'ledger',
        description: '日常记账。用户说消费/收入时用 add；问「花了多少/这个月怎么样」用 stats/query；改账先 query 拿 id 再 update/delete。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['add', 'query', 'stats', 'delete', 'update', 'categories'] },
            amount: { type: 'number' }, type: { type: 'string' }, category: { type: 'string' }, note: { type: 'string' },
            date: { type: 'string' }, time: { type: 'string' }, timeOfDay: { type: 'string' },
            id: { type: 'string' }, month: { type: 'string' }, keyword: { type: 'string' }, limit: { type: 'number' },
            op: { type: 'string' }, name: { type: 'string' }, kind: { type: 'string' }, patch: { type: 'object' },
          },
          required: ['action'],
        },
      },
    },
    async invoke({ args, host }) {
      const r = await execLedger(args, host.kv);
      return { ok: !!r.ok, stdout: r.stdout, stderr: r.ok ? '' : (r.error ?? 'ledger 执行失败') };
    },
  });
}
