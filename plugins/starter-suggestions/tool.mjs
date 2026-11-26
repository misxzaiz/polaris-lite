/**
 * starter-suggestions 在服务端执行域的工具声明（suggestions）。
 * 池数据经 host.kv（namespace=starter-suggestions，与面板同一份）；
 * 变更后 host.emit('suggestions-changed') 让在线面板即时刷新。
 */
const FEEDBACK_CAP = 8 * 1024;
const NS = 'starter-suggestions';
const POOL_KEY = 'pool';

export function registerSuggestionsTool(registry) {
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
    async invoke({ args, run, call, host }) {
      const action = String(args.action ?? '');
      const listPool = () => host.kv.get(NS, POOL_KEY);
      const savePool = (pool) => host.kv.set(NS, POOL_KEY, pool);
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
        host.emit(run, 'suggestions-changed', { sessionId: run.sessionId, messageId: run.assistantId, callId: call.id });
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
        host.emit(run, 'suggestions-changed', { sessionId: run.sessionId, messageId: run.assistantId, callId: call.id });
        return { ok: true, stdout: JSON.stringify({ ok: true }), stderr: '' };
      }
      if (action === 'remove') {
        const id = String(args.id ?? '');
        const next = items.filter((s) => s.id !== id);
        if (next.length === items.length) return { ok: false, stdout: '', stderr: `未找到建议 ${id}（先用 list 拿 id）` };
        savePool({ ...(pool ?? { version: 1 }), items: next });
        host.emit(run, 'suggestions-changed', { sessionId: run.sessionId, messageId: run.assistantId, callId: call.id });
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
}
