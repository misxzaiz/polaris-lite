/**
 * agent-runner 的内建工具适配器集合（服务端执行域）。
 *
 * 每个工具是一个自描述对象：{ descriptor, invoke, approvalKey?, summarize? }。
 * 通过 registry.registerTool / registerToolPrefix 注册，runner 只按工具名查表调用——
 * 不再写死 9 个工具分支、6 个 safeXxxArgs 清洗函数与 buildServerToolDefs 大表。
 * 新增工具 = 新增一个适配器对象（可在任意 server 半边注册），runner 零改动。
 *
 * 这里保留原有 loopback HTTP 门禁语义（callToolEndpoint / fsGet 由 runner 注入），
 * 以及 ledger 的单权威内核；仅改变「谁声明工具、谁派发」——行为仍在各自工具插件的
 * server 半边（这些 HTTP 端点），本模块只做协议适配。
 */
const FEEDBACK_CAP = 8 * 1024;

function capText(text, cap = FEEDBACK_CAP) {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap / 2)}\n…[输出过长已截断 ${text.length}B]…\n${text.slice(-cap / 2)}`;
}

/** 构造全部内建工具适配器。helpers 由 runner 注入（含 loopback、kv、事件、交互等上下文）。 */
export function registerBuiltinTools(registry, helpers) {
  const {
    callToolEndpoint, fsGet, emitEvent, askInteractive,
    readKvSync, writeKvSync, kvKeys, selfPort, ledgerCore,
  } = helpers;

  // ---- bash ----
  registry.registerTool({
    name: 'bash',
    descriptor: {
      type: 'function',
      function: {
        name: 'bash',
        description: '执行 shell 命令。可用于读写文件、运行脚本、安装依赖、调用任意 CLI（cwd 锁定工作区）。写文件优先用 files_write 工具。危险命令会被无条件拒绝。',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: '要执行的命令（完整一行）' },
            timeoutMs: { type: 'number', description: '超时毫秒，默认 30000，上限 300000' },
          },
          required: ['command'],
        },
      },
    },
    async invoke({ args, run, signal }) {
      const r = await callToolEndpoint('/api/tool/exec', {
        sessionId: run.sessionId, approved: true,
        command: String(args.command ?? ''),
        timeoutMs: args.timeoutMs ? Number(args.timeoutMs) : undefined,
        cwd: run.execCwd,
      }, signal);
      const j = r.json ?? {};
      return { ok: !!j.ok || r.ok, exitCode: j.exitCode, stdout: j.stdout ?? '', stderr: j.stderr ?? j.error ?? '', durationMs: j.durationMs, truncated: j.truncated, denied: j.denied };
    },
  });

  // ---- files（只读）----
  registry.registerTool({
    name: 'files',
    descriptor: {
      type: 'function',
      function: {
        name: 'files',
        description: '浏览与读取文件（只读）。动作：roots 列出工作区根；list 列目录；read 读文件。path 传相对工作区根的相对路径。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['roots', 'list', 'read'] },
            rootId: { type: 'string' }, path: { type: 'string' },
            head: { type: 'number' }, tail: { type: 'number' },
          },
          required: ['action'],
        },
      },
    },
    async invoke({ args, run, signal }) {
      const action = String(args.action ?? '');
      async function pickRoot() {
        if (args.rootId ?? run.boundRootId) return args.rootId ?? run.boundRootId;
        const rr = await fsGet('/api/fs/roots', signal);
        const roots = rr.json?.roots ?? [];
        return (roots.find((x) => x.builtin) ?? roots[0])?.id;
      }
      if (action === 'roots') {
        const r = await fsGet('/api/fs/roots', signal);
        const roots = r.json?.roots ?? [];
        const summary = roots.length ? `roots=${roots.length}: ${roots.map((x) => `${x.label}（id=${x.id}, path=${x.path}${x.builtin ? ', builtin' : ''}）`).join('; ')}` : '（无登记根）';
        return { ok: r.ok, stdout: `[files 完成] ${summary}`, stderr: r.ok ? '' : `HTTP ${r.status}` };
      }
      if (action === 'list' || action === 'read') {
        const rootId = await pickRoot();
        if (!rootId) return { ok: false, stdout: '', stderr: 'rootId required（且无可用默认根）' };
        const q = new URLSearchParams({ rootId, path: String(args.path ?? '') });
        if (action === 'read') {
          if (args.head) q.set('head', String(args.head));
          if (args.tail) q.set('tail', String(args.tail));
        }
        const r = await fsGet(`/api/fs/${action}?${q}`, signal);
        const j = r.json ?? {};
        if (!r.ok) return { ok: false, stdout: '', stderr: `[files 工具执行失败] ${action} 失败：${j.error ?? `HTTP ${r.status}`}` };
        if (action === 'read') {
          if (j.tooLarge) return { ok: false, stdout: '', stderr: `[files 工具执行失败] ${j.hint ?? '文件过大'}` };
          if (j.isText === false) return { ok: false, stdout: '', stderr: '[files 工具执行失败] 二进制文件不支持文本读取' };
          return { ok: true, stdout: `[files 完成] read ok（${j.size ?? '?'}B，path=${args.path ?? ''}）：\n${capText(String(j.text ?? ''), 2000)}`, stderr: '' };
        }
        const summary = `list ok（${(j.entries ?? []).length} 项，rootId=${rootId}，path=${args.path ?? ''}）`;
        return { ok: true, stdout: `[files 完成] ${summary}`, stderr: '' };
      }
      return { ok: false, stdout: '', stderr: `unknown fs action: ${action}（可用：roots/list/read）` };
    },
  });

  // ---- files_write ----
  registry.registerTool({
    name: 'files_write',
    descriptor: {
      type: 'function',
      function: {
        name: 'files_write',
        description: '结构化写入与编辑工作区文件（写面；读用 files 工具）。动作：write 写整文件；edit 精确替换；patch 多文件补丁。只能写工作区内。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['write', 'edit', 'patch'] },
            path: { type: 'string' }, content: { type: 'string' },
            old_string: { type: 'string' }, new_string: { type: 'string' },
            expected_replacements: { type: 'number' }, patch: { type: 'string' }, rootId: { type: 'string' },
          },
          required: ['action'],
        },
      },
    },
    async invoke({ args, run, signal }) {
      const payload = { ...args, ...(args.rootId ? {} : { rootId: run.boundRootId }), sessionId: run.sessionId, approved: true };
      const r = await callToolEndpoint('/api/files-write/exec', payload, signal);
      const j = r.json ?? {};
      return { ok: r.ok && j.ok !== false, exitCode: j.exitCode ?? (r.ok ? 0 : 1), stdout: j.stdout ?? JSON.stringify(j).slice(0, 2000), stderr: j.error ?? '', durationMs: j.durationMs, denied: j.denied };
    },
  });

  // ---- render ----
  registry.registerTool({
    name: 'render',
    descriptor: {
      type: 'function',
      function: {
        name: 'render',
        description: '生成自包含 HTML 交互面板（小游戏/原型/图表/教具）。HTML 必须自包含：内联 CSS/JS、不引 CDN、不 fetch；改动旧面板传 basePreviewId。',
        parameters: {
          type: 'object',
          properties: { html: { type: 'string' }, title: { type: 'string' }, basePreviewId: { type: 'string' } },
          required: ['html'],
        },
      },
    },
    async invoke({ args, run, call, signal }) {
      const r = await callToolEndpoint('/api/preview/render', { html: args.html, title: args.title, basePreviewId: args.basePreviewId, sessionId: run.sessionId }, signal);
      const j = r.json ?? {};
      const ok = r.ok && j.ok !== false;
      const feedback = ok
        ? `[预览已生成] previewId=${j.previewId} 版本=${j.versionLabel ?? '?'} 标题=${j.title ?? '?'}。用户可在对话卡片与「预览」面板中查看运行。`
        : `[预览生成失败] ${j.error ?? `HTTP ${r.status}`}`;
      if (ok) {
        emitEvent(run, 'artifact.created', {
          sessionId: run.sessionId, messageId: run.assistantId, callId: call.id,
          rendererType: 'html-preview', title: String(j.title ?? args.title ?? '交互面板'),
          data: { previewId: j.previewId, url: j.url, versionLabel: j.versionLabel },
        });
      }
      return { ok, stdout: ok ? feedback : '', stderr: ok ? '' : feedback };
    },
  });

  // ---- browser ----
  registry.registerTool({
    name: 'browser',
    descriptor: {
      type: 'function',
      function: {
        name: 'browser',
        description: '驱动系统 Chrome 搜索/阅读/操作网页：search/read/navigate/click/fill/screenshot/tabs 等。优先结构化动作而非 evaluate。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string' }, url: { type: 'string' }, query: { type: 'string' },
            label: { type: 'string' }, selector: { type: 'string' }, value: { type: 'string' }, limit: { type: 'number' },
          },
          required: ['action'],
        },
      },
    },
    async invoke({ args, run, call, signal }) {
      const r = await callToolEndpoint('/api/browser/dispatch', { ...args, sessionId: run.sessionId, callId: call.id }, signal);
      const j = r.json ?? {};
      const ok = r.ok && (j.ok !== false);
      const feedback = ok ? `[浏览器操作完成] ${JSON.stringify(j).slice(0, FEEDBACK_CAP)}` : `[浏览器操作失败] ${j.error ?? `HTTP ${r.status}`}`;
      return { ok, stdout: ok ? feedback : '', stderr: ok ? '' : feedback };
    },
  });

  // ---- read_skill ----
  registry.registerTool({
    name: 'read_skill',
    descriptor: {
      type: 'function',
      function: {
        name: 'read_skill',
        description: '读取技能全文（SKILL.md）。先用系统提示附录里的技能索引选名字，再用本工具读全文。',
        parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      },
    },
    async invoke({ args, signal }) {
      const r = await fsGet(`/api/skills/read?name=${encodeURIComponent(String(args.name ?? ''))}`, signal);
      const j = r.json ?? {};
      const ok = r.ok && j.ok !== false;
      return { ok, stdout: ok ? (j.content ?? '') : '', stderr: ok ? '' : (j.error ?? `HTTP ${r.status}`) };
    },
  });

  // ---- interactive（交互卡：不走审批，服务端广播事件等待回填）----
  registry.registerTool({
    name: 'interactive',
    descriptor: {
      type: 'function',
      function: {
        name: 'interactive',
        description: '向用户发起结构化交互并等待作答（question 多选 / form 表单 / confirm 确认）。缺少必要信息时直接问。超时返回 {"__timeout":true}。',
        parameters: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['question', 'form', 'confirm'] }, title: { type: 'string' },
            options: { type: 'array', items: { type: 'string' } },
            fields: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, label: { type: 'string' } } } },
          },
          required: ['kind', 'title'],
        },
      },
    },
    noApproval: true,
    async invoke({ run, call, args, signal }) {
      const decision = await askInteractive(run, call, args, signal);
      return { ok: true, stdout: decision, stderr: '' };
    },
  });

  // ---- ledger（记账：kv-store + 单一权威内核）----
  const LEDGER_NS = 'pocket-ledger';
  const ledgerSettings = () => {
    const s = readKvSync(LEDGER_NS, 'settings');
    return { ...ledgerCore.DEFAULT_SETTINGS, ...(s && typeof s === 'object' ? s : {}) };
  };
  async function execLedger(args) {
    const settings = ledgerSettings();
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
      const existing = readKvSync(LEDGER_NS, dk) ?? [];
      const merged = ledgerCore.appendBills(Array.isArray(existing) ? existing : [], [bill]);
      writeKvSync(LEDGER_NS, dk, merged);
      return { ok: true, stdout: JSON.stringify({ ok: true, bill, total: merged.length }) };
    }
    if (action === 'query' || action === 'stats') {
      const month = args.month === 'last' ? ledgerCore.shiftMonth(ledgerCore.currentMonth(), -1)
        : args.month && args.month !== 'this' ? String(args.month) : ledgerCore.currentMonth();
      const prefix = `ledger.day.${month}-`;
      let bills = [];
      for (const dk of kvKeys(LEDGER_NS, 'ledger.day.')) {
        if (!dk.startsWith(prefix)) continue;
        const arr = readKvSync(LEDGER_NS, dk);
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
      for (const dk of kvKeys(LEDGER_NS, 'ledger.day.')) {
        const arr = readKvSync(LEDGER_NS, dk);
        if (!Array.isArray(arr)) continue;
        if (action === 'delete') {
          const { arr: next, removed } = ledgerCore.removeBill(arr, id);
          if (removed) { writeKvSync(LEDGER_NS, dk, next); return { ok: true, stdout: JSON.stringify({ ok: true, deleted: id }) }; }
        } else {
          const patch = args.patch ?? {};
          let ts;
          if (patch.date !== undefined || patch.time !== undefined || patch.timeOfDay !== undefined) {
            const resolved = ledgerCore.resolveBillTime({ date: patch.date, time: patch.time, timeOfDay: patch.timeOfDay, hint: patch.note }, Date.now());
            if (!resolved.error) ts = resolved.ts;
          }
          const { arr: updated, found, bill } = ledgerCore.updateBill(arr, id, { amount: patch.amount !== undefined ? Number(patch.amount) : undefined, category: patch.category, note: patch.note, type: patch.type, ts });
          if (found) { writeKvSync(LEDGER_NS, dk, updated); return { ok: true, stdout: JSON.stringify({ ok: true, bill }) }; }
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
        writeKvSync(LEDGER_NS, 'settings', settings);
        return { ok: true, stdout: JSON.stringify({ ok: true, categories: settings[kind] }) };
      }
      if (op === 'remove') {
        const name = String(args.name ?? '').trim();
        const kind = args.kind === 'income' ? 'incomeCategories' : 'categories';
        settings[kind] = (settings[kind] ?? []).filter((c) => c !== name);
        delete settings.budgets[name];
        writeKvSync(LEDGER_NS, 'settings', settings);
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
    async invoke({ args }) { const r = await execLedger(args); return { ok: !!r.ok, stdout: r.stdout, stderr: r.ok ? '' : (r.error ?? 'ledger 执行失败') }; },
  });

  // ---- translate ----
  registry.registerTool({
    name: 'translate',
    descriptor: {
      type: 'function',
      function: {
        name: 'translate',
        description: '把文本翻译成目标语言。to 从 zh/en/jp/kor/fra/de/ru/spa/wyw 选；不传时含中文译英语、否则译中文。文本 ≤6000 字。',
        parameters: { type: 'object', properties: { text: { type: 'string' }, to: { type: 'string' } }, required: ['text'] },
      },
    },
    async invoke({ args, signal }) {
      const text = String(args.text ?? '').trim();
      if (!text) return { ok: false, stdout: '', stderr: 'text 不能为空' };
      const to = args.to ? String(args.to) : (/[一-鿿]/.test(text) ? 'en' : 'zh');
      const r = await callToolEndpoint('/api/translate/translate', { text, to }, signal);
      const j = r.json ?? {};
      const ok = r.ok && j.ok !== false;
      return { ok, stdout: ok ? String(j.text ?? j.translated ?? JSON.stringify(j).slice(0, 2000)) : '', stderr: ok ? '' : String(j.error ?? `HTTP ${r.status}`) };
    },
  });

  // ---- suggestions（开场建议池管理：kv namespace=starter-suggestions）----
  registry.registerTool({
    name: 'suggestions',
    descriptor: {
      type: 'function',
      function: {
        name: 'suggestions',
        description:
          '管理「新会话开场建议池」（用户首次打开对话页看到的推荐起点）。' +
          '用户说「加一条开场建议/推荐」时用 add：label 是短标题（≤40 字），prompt 是点击后填入输入框的完整提示词（≤500 字），' +
          'category 从 explore/tools/code/write/think/play 里按内容选。查看/删除/修改用 list/remove/update；update/remove 用 id（先 list 拿）。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'add', 'update', 'remove', 'stats'] },
            id: { type: 'string' }, label: { type: 'string' }, prompt: { type: 'string' },
            category: { type: 'string', enum: ['explore', 'tools', 'code', 'write', 'think', 'play'] },
          },
          required: ['action'],
        },
      },
    },
    async invoke({ args, run, call, signal }) {
      // 与前端 handler 同构的池操作；「列表变化」用事件广播让在线面板即时刷新
      const action = String(args.action ?? '');
      const apply = (items) => items;
      const listPool = () => readKvSync('starter-suggestions', 'pool');
      const savePool = (pool) => writeKvSync('starter-suggestions', 'pool', pool);
      const MAX_ITEMS = 60;
      const valid = ['explore', 'tools', 'code', 'write', 'think', 'play'];
      const norm = (v) => (valid.includes(v) ? v : 'explore');
      const validate = (a) => {
        const label = typeof a.label === 'string' ? a.label.trim() : '';
        const prompt = typeof a.prompt === 'string' ? a.prompt.trim() : '';
        if (!label) return { error: 'label 不能为空' };
        if (!prompt) return { error: 'prompt 不能为空' };
        if (label.length > 40) return { error: 'label 超过 40 字' };
        if (prompt.length > 500) return { error: 'prompt 超过 500 字' };
        return { label, prompt, category: norm(a.category) };
      };
      const pool = listPool();
      const items = Array.isArray(pool?.items) ? pool.items : [];
      if (action === 'list') {
        return { ok: true, stdout: JSON.stringify({ count: items.length, items: items.map((s) => ({ id: s.id, label: s.label, category: s.category, enabled: s.enabled, source: s.source, prompt: s.prompt })) }).slice(0, FEEDBACK_CAP), stderr: '' };
      }
      if (action === 'add') {
        const v = validate(args);
        if (v.error) return { ok: false, stdout: '', stderr: v.error };
        if (items.length >= MAX_ITEMS) return { ok: false, stdout: '', stderr: `建议池已达上限 ${MAX_ITEMS} 条，请先 remove` };
        if (items.some((s) => s.prompt === v.prompt)) return { ok: true, stdout: '已存在相同 prompt 的建议', stderr: '' };
        const item = {
          id: `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          label: v.label, prompt: v.prompt, category: v.category,
          enabled: true, source: 'ai', createdAt: new Date().toISOString(), uses: 0,
        };
        savePool({ ...(pool ?? { version: 1 }), items: [...items, item] });
        emitEvent(run, 'suggestions-changed', { sessionId: run.sessionId, messageId: run.assistantId, callId: call.id });
        return { ok: true, stdout: JSON.stringify({ ok: true, id: item.id }), stderr: '' };
      }
      if (action === 'update') {
        const id = String(args.id ?? '');
        const idx = items.findIndex((s) => s.id === id);
        if (idx < 0) return { ok: false, stdout: '', stderr: `未找到建议 ${id}（先用 list 拿 id）` };
        const cur = items[idx];
        const v = validate({ label: args.label ?? cur.label, prompt: args.prompt ?? cur.prompt, category: args.category ?? cur.category });
        if (v.error) return { ok: false, stdout: '', stderr: v.error };
        const next = [...items];
        next[idx] = { ...cur, label: v.label, prompt: v.prompt, category: v.category };
        savePool({ ...(pool ?? { version: 1 }), items: next });
        emitEvent(run, 'suggestions-changed', { sessionId: run.sessionId, messageId: run.assistantId, callId: call.id });
        return { ok: true, stdout: JSON.stringify({ ok: true }), stderr: '' };
      }
      if (action === 'remove') {
        const id = String(args.id ?? '');
        const next = items.filter((s) => s.id !== id);
        if (next.length === items.length) return { ok: false, stdout: '', stderr: `未找到建议 ${id}（先用 list 拿 id）` };
        savePool({ ...(pool ?? { version: 1 }), items: next });
        emitEvent(run, 'suggestions-changed', { sessionId: run.sessionId, messageId: run.assistantId, callId: call.id });
        return { ok: true, stdout: JSON.stringify({ ok: true }), stderr: '' };
      }
      if (action === 'stats') {
        const bySource = {};
        for (const s of items) bySource[s.source] = (bySource[s.source] ?? 0) + 1;
        return { ok: true, stdout: JSON.stringify({ total: items.length, bySource }), stderr: '' };
      }
      return { ok: false, stdout: '', stderr: `unknown action: ${action}（可用：list/add/update/remove/stats）` };
    },
  });

  // ---- transcript（对话分享与转录读取；数据面同源 /api/share/*）----
  registry.registerTool({
    name: 'transcript',
    descriptor: {
      type: 'function',
      function: {
        name: 'transcript',
        description:
          '对话过程分享与转录读取（只读）。动作：share=为指定会话生成只读分享链接（sessionId 必填；ttlMs 1h~30d 默认 24h；live 默认 true），返回 { url, token, expiresAt }，把 url 告诉用户即可；' +
          'transcript=读取会话结构化转录（sessionId 必填），含每条消息与全部工具调用，供复盘；list=列出活动分享；revoke=吊销分享（token 必填）。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['share', 'transcript', 'list', 'revoke'] },
            sessionId: { type: 'string' }, ttlMs: { type: 'number' }, live: { type: 'boolean' },
            token: { type: 'string' },
          },
          required: ['action'],
        },
      },
    },
    async invoke({ args, signal }) {
      const action = String(args.action ?? '');
      if (action === 'share' || action === 'transcript') {
        const sid = String(args.sessionId ?? '').trim();
        if (!sid) return { ok: false, stdout: '', stderr: 'sessionId required' };
        const r = await callToolEndpoint('/api/share/create', {
          sessionId: sid,
          ...(action === 'share' && args.ttlMs !== undefined ? { ttlMs: Number(args.ttlMs) } : {}),
          ...(action === 'share' ? { live: args.live !== false } : { ttlMs: 3600_000, live: false }),
        }, signal);
        const j = r.json ?? {};
        if (!r.ok || !j.ok) return { ok: false, stdout: '', stderr: String(j.error ?? `HTTP ${r.status}`) };
        if (action === 'share') return { ok: true, stdout: JSON.stringify({ url: j.url, token: j.token, expiresAt: j.expiresAt, live: j.live }), stderr: '' };
        const r2 = await callToolEndpoint(`/share/${j.token}/json`, {}, signal);
        const t = r2.json;
        if (!r2.ok || !t) return { ok: false, stdout: '', stderr: `transcript fetch failed: HTTP ${r2.status}` };
        return { ok: true, stdout: JSON.stringify(t).slice(0, FEEDBACK_CAP), stderr: '' };
      }
      if (action === 'list') {
        const r = await callToolEndpoint('/api/share/list', {}, signal);
        return { ok: r.ok, stdout: JSON.stringify(r.json ?? {}).slice(0, FEEDBACK_CAP), stderr: r.ok ? '' : `HTTP ${r.status}` };
      }
      if (action === 'revoke') {
        const token = String(args.token ?? '').trim();
        if (!token) return { ok: false, stdout: '', stderr: 'token required' };
        const r = await callToolEndpoint('/api/share/revoke', { token }, signal);
        const j = r.json ?? {};
        return { ok: r.ok && j.ok !== false, stdout: JSON.stringify(j).slice(0, 2000), stderr: r.ok ? '' : String(j.error ?? `HTTP ${r.status}`) };
      }
      return { ok: false, stdout: '', stderr: `unknown action: ${action}（可用：share/transcript/list/revoke）` };
    },
  });

  // ---- phone（手机端点：剪贴板/通知/页面文本；等手机 SSE 结果）----
  registry.registerTool({
    name: 'phone',
    descriptor: {
      type: 'function',
      function: {
        name: 'phone',
        description:
          '访问用户的手机端点：读/写手机剪贴板、发手机通知、抓取手机当前页面文本。手机必须在线（App 处于打开状态）且用户已在手机上确认允许访问；离线或未确认会返回明确错误，请把错误转述给用户而不是重试。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', description: 'clipboard.read / clipboard.write / notify / page.snap' },
            text: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' },
            timeoutMs: { type: 'number' },
          },
          required: ['action'],
        },
      },
    },
    async invoke({ args, signal }) {
      const r = await callToolEndpoint('/api/phone/command', {
        action: String(args.action ?? ''),
        payload: {
          ...(args.text !== undefined ? { text: String(args.text) } : {}),
          ...(args.title !== undefined ? { title: String(args.title) } : {}),
          ...(args.body !== undefined ? { body: String(args.body) } : {}),
        },
        timeoutMs: args.timeoutMs ? Number(args.timeoutMs) : undefined,
      }, signal);
      const j = r.json ?? {};
      const ok = r.ok && j.ok !== false;
      return { ok, stdout: ok ? JSON.stringify(j.result ?? j).slice(0, FEEDBACK_CAP) : '', stderr: ok ? '' : String(j.error ?? `HTTP ${r.status}`) };
    },
  });

  // ---- market_*（商城三连：免审批自建管理工具，服务端有 sha256/路径围栏/审计）----
  for (const [mName, mPath] of [
    ['market_list', '/api/market/list'],
    ['market_install', '/api/market/install'],
    ['market_uninstall', '/api/market/uninstall'],
  ]) {
    registry.registerTool({
      name: mName,
      noApproval: true,
      descriptor: {
        type: 'function',
        function: {
          name: mName,
          description: mName === 'market_list'
            ? '列出商城源里可安装的插件及安装状态（含 Claude Code 商城：source 为 marketplace 名、id 为插件名的条目标记为 (cc)）。'
            : mName === 'market_install'
              ? '从商城安装插件。普通目录源传 source（源名）+id；Claude Code 商城 source 直接填 marketplace 名（仅导入声明型资源，不运行外部 JS）。target 决定作用域：global（默认）| project。'
              : '卸载一个已安装的外部插件（刷新页面生效）。',
          parameters: {
            type: 'object',
            properties: {
              ...(mName !== 'market_list' ? {
                source: { type: 'string', description: '商城源名或 CC marketplace 名' },
                id: { type: 'string', description: '插件 id' },
                ...(mName === 'market_install' ? { target: { type: 'string', enum: ['global', 'project'], description: '作用域：global（默认）| project' } } : {}),
              } : {}),
          },
          },
        },
      },
      async invoke({ args, signal }) {
        const r = await callToolEndpoint(mPath, {
          ...(mName === 'market_list' ? {} : {
            source: String(args.source ?? ''),
            id: String(args.id ?? ''),
            ...(mName === 'market_install' && args.target ? { target: String(args.target) } : {}),
          }),
        }, signal);
        const j = r.json ?? {};
        const ok = r.ok && j.ok !== false;
        return { ok, stdout: JSON.stringify(j).slice(0, FEEDBACK_CAP), stderr: ok ? '' : String(j.error ?? j.warns ?? `HTTP ${r.status}`).slice(0, 500) };
      },
    });
  }

  // ---- MCP 管理三连 + 聚合工具（前缀适配器 mcp_）----
  registry.registerToolPrefix('mcp_', {
    descriptor: null, // 动态工具，描述由 ensureMcpTools 注入
    async invoke({ name, args, signal }) {
      if (name === 'mcp_server_list') {
        const r = await fsGet('/api/mcp/servers', signal);
        return { ok: r.ok, stdout: JSON.stringify(r.json ?? {}).slice(0, FEEDBACK_CAP), stderr: r.ok ? '' : `HTTP ${r.status}` };
      }
      if (name === 'mcp_server_add' || name === 'mcp_server_remove') {
        const r = await callToolEndpoint(name === 'mcp_server_add' ? '/api/mcp/servers' : '/api/mcp/servers/remove', args, signal);
        return { ok: r.ok, stdout: JSON.stringify(r.json ?? {}).slice(0, FEEDBACK_CAP), stderr: r.ok ? '' : `HTTP ${r.status}` };
      }
      const r = await callToolEndpoint('/api/mcp/call', { name, arguments: args }, signal);
      const j = r.json ?? {};
      const ok = r.ok && j.ok !== false;
      return { ok, stdout: ok ? String(j.stdout ?? JSON.stringify(j).slice(0, FEEDBACK_CAP)) : '', stderr: ok ? '' : String(j.error ?? `HTTP ${r.status}`) };
    },
  });
}
