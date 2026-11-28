/**
 * long-memory 插件的服务端半边。
 *
 * 职责三件事（存储全部复用 kv-store 的 service，不自建 sqlite）：
 * 1. service 表注册（id='long-memory'）：agent-runner 的 seedShadow 经
 *    registry.getService('long-memory') 取注入段——开关关闭或无记忆时返回 null，
 *    调用方静默跳过（与 system-prompt 同款容错与顺序约定）。
 * 2. 工具注册 ×3（memory_save / memory_recall / memory_forget）：工具常驻注册
 *    （引擎工具表不随开关动态增删），invoke 内按全局开关判定——关闭时返回明确
 *    「长期记忆未开启」错误，AI 会向用户解释而不是反复重试。
 * 3. HTTP 路由（/api/long-memory/*）：管理面板与 chat-lite 会话设置分区的读写通道
 *    （同源 cookie 硬门禁，与 kv-store /api/kv/* 同款安全模型）。
 *
 * kv 键约定（与 UI 半边一致）：
 *   namespace='long-memory'
 *   key='settings'        → { enabled, injectLimit }  全局开关与注入上限
 *   key=`item.<id>`        → { id, text, kind, reason, createdAt, updatedAt }
 *
 * 关闭 ≠ 清空：关闭只停注入/写入，条目保留（「清空」是 HTTP clear，由 UI 二次确认）。
 * PLITE_LONG_MEMORY=0 一键禁用整插件（对齐 PLITE_KV 模式）：路由放行、service 返回
 * null、工具返回禁用错误。
 *
 * 删除本文件时宿主照常启动，只是记忆注入/工具/面板读写失效（kv 数据仍在）。
 */

const NS = 'long-memory';
const MAX_ITEMS = 200;               // 条目上限（防膨胀；超限拒绝新写入）
const DEFAULT_INJECT_LIMIT = 2000;   // 注入段字符上限
const MAX_TEXT_LEN = 1000;           // 单条 text 上限
const BODY_LIMIT = 64 * 1024;       // HTTP body 上限（清单/单条远小于此）

/** 组合逻辑唯一权威：settings 读 + 缺省合并（存储里只存用户改过的字段） */
function settingsOf(kv) {
  const s = kv?.get?.(NS, 'settings');
  const enabled = !!(s && typeof s === 'object' && s.enabled === true);
  const injectLimit = Number(s?.injectLimit) > 0 ? Math.floor(Number(s.injectLimit)) : DEFAULT_INJECT_LIMIT;
  return { enabled, injectLimit };
}

/** 全部条目（按 createdAt 升序稳定输出） */
function itemsOf(kv) {
  const out = [];
  for (const key of kv?.keys?.(NS, 'item.') ?? []) {
    const it = kv.get(NS, key);
    if (it && typeof it === 'object' && typeof it.text === 'string' && it.text.trim()) out.push(it);
  }
  out.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  return out;
}

/** 新条目 id：毫秒时间戳 + 随机后缀（同毫秒并发不碰撞） */
function newId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 构造注入段（service.get 的实现核心）。
 * 开关关闭 / 无条目 / 插件禁用 → null；runner 只消费单一段字符串，不感知条目结构。
 * 超过 injectLimit 截断并提示走 memory_recall。
 */
function buildInjectText(kv) {
  const { enabled, injectLimit } = settingsOf(kv);
  if (!enabled) return null;
  const items = itemsOf(kv);
  if (items.length === 0) return null;
  const lines = [];
  let used = 0;
  let truncated = false;
  for (const it of items) {
    const line = `- ${it.text.trim()}`;
    if (used + line.length + 1 > injectLimit) { truncated = true; break; }
    lines.push(line);
    used += line.length + 1;
  }
  const head = '【长期记忆已开启】以下是关于用户的既有记忆（你过往对话中记录）：\n';
  const tail =
    '\n使用它们让回复更贴合用户；发现过时信息可用 memory_forget（先 memory_recall 拿 id）更新。' +
    '值得长期记住的新信息（用户偏好/决定/配置选择），主动用 memory_save 记录，可先征询用户。';
  const truncNote = truncated ? `\n（条目较多已截断，更多记忆用 memory_recall 检索）` : '';
  return `${head}${lines.join('\n')}${truncNote}${tail}`;
}

/** 工具共用的执行内核（参数已在各 action 分支校验后调用） */
function execToolAction(kv, args) {
  const action = String(args.action ?? '');
  const { enabled } = settingsOf(kv);
  if (!enabled) return { ok: false, error: '长期记忆未开启（用户可在会话设置中开启）' };

  if (action === 'save') {
    const text = String(args.text ?? '').trim();
    if (!text) return { ok: false, error: 'text 不能为空' };
    if (text.length > MAX_TEXT_LEN) return { ok: false, error: `text 过长（>${MAX_TEXT_LEN} 字）` };
    const items = itemsOf(kv);
    if (items.length >= MAX_ITEMS) return { ok: false, error: `记忆已达上限（${MAX_ITEMS} 条），先用 forget 清理` };
    const kind = args.kind === 'config' ? 'config' : 'fact';
    const reason = String(args.reason ?? '').trim().slice(0, 200);
    const now = Date.now();
    const item = { id: newId(), text, kind, reason, createdAt: now, updatedAt: now };
    kv.set(NS, `item.${item.id}`, item);
    return { ok: true, stdout: JSON.stringify({ ok: true, id: item.id, total: items.length + 1 }) };
  }

  if (action === 'recall') {
    const q = String(args.q ?? '').trim().toLowerCase();
    let items = itemsOf(kv);
    if (q) items = items.filter((it) => it.text.toLowerCase().includes(q));
    const limit = Math.min(Math.max(Number(args.limit) || 50, 1), MAX_ITEMS);
    const slim = items.slice(-limit).reverse()
      .map((it) => ({ id: it.id, text: it.text, kind: it.kind, reason: it.reason, createdAt: it.createdAt }));
    return { ok: true, stdout: JSON.stringify({ count: slim.length, items: slim }) };
  }

  if (action === 'forget') {
    const id = String(args.id ?? '').trim();
    if (!id) return { ok: false, error: 'id required（先 recall 拿 id）' };
    const it = kv.get(NS, `item.${id}`);
    if (!it) return { ok: false, error: `未找到记忆 ${id}（先 recall 拿 id）` };
    kv.del(NS, `item.${id}`);
    return { ok: true, stdout: JSON.stringify({ ok: true, deleted: id }) };
  }

  return { ok: false, error: 'unknown action（可用：save/recall/forget）' };
}

export function createServerPart(options = {}) {
  const registry = options.registry;
  const getSession = options.getSession;
  const hardOff = process.env.PLITE_LONG_MEMORY === '0';
  const kv = () => registry?.getService?.('kv-store') ?? null;

  // ---- 0. 内置纪律种子（2026-11-28 路线图「知识注入」项，幂等 + 惰性）----
  // 环境纪律/发版纪律/协作纪律/验证链四条。两个约束：
  //  - 幂等：kv 标记键存在即跳过（用户删除单条种子不会复活——标记在整体层面）；
  //  - 惰性：不能在 createServerPart 装配期写 kv——测试环境装配全部 server 半边时
  //    会凭空打开临时数据目录的 sqlite（句柄不关），测试清理 rmSync 撞 EPERM
  //    （2026-11-28 server-boundary 两例实测）。首次真正消费 service 才种。
  let seedChecked = false;
  const ensureSeeded = () => {
    if (seedChecked) return;
    seedChecked = true;
    try {
      const k = kv();
      if (!k || k.get(NS, 'seed.env-discipline-v1')) return;
      const now = Date.now();
      const seeds = [
        { text: '环境判别只看端口：5000=开发（root/1234，可随便改可重启）；9825=生产（只读观察，禁止写入/重启/写测试数据）；9826=钉住的分析实例（允许写入重启）。', kind: 'config', reason: '内置种子：环境纪律' },
        { text: '发版只由用户执行 npm run release（commit→push→deploy:9826→build+restart 9825→三处一致终检）；AI 不执行 release/push/checkout/pm2 操作（bash 硬规则会拦）。', kind: 'config', reason: '内置种子：发版纪律' },
        { text: '工作树常有用户未提交的 WIP：动手前先用 git 工具看 status/diff，不碰未跟踪文件；git 工具只读，提交/切分支走面板或 bash 审批链。', kind: 'config', reason: '内置种子：协作纪律' },
        { text: '改完前端/插件的验证链：npm run typecheck → npm test → npm run build:plugins；改插件 server 源码后 dev 需重启实例才生效。', kind: 'config', reason: '内置种子：验证链' },
      ];
      for (const s of seeds) {
        const item = { id: newId(), text: s.text, kind: s.kind, reason: s.reason, createdAt: now, updatedAt: now };
        k.set(NS, `item.${item.id}`, item);
      }
      k.set(NS, 'seed.env-discipline-v1', String(now));
    } catch { /* 种子失败不阻塞消费 */ }
  };

  // ---- 1. service 表注册（seedShadow 消费）----
  if (registry?.registerService && !registry.getService?.('long-memory')) {
    registry.registerService('long-memory', {
      /** 读注入段；禁用/关闭/无记忆返回 null（调用方静默跳过） */
      get() {
        try {
          if (hardOff) return null;
          ensureSeeded();
          return buildInjectText(kv());
        } catch {
          return null;
        }
      },
      /** 开关状态（面板/设置分区可经 HTTP 查，service 形态留给未来同进程消费方） */
      settings() {
        try {
          if (hardOff) return { enabled: false, injectLimit: DEFAULT_INJECT_LIMIT, hardOff: true };
          ensureSeeded();
          return { ...settingsOf(kv()), count: itemsOf(kv()).length };
        } catch {
          return { enabled: false, injectLimit: DEFAULT_INJECT_LIMIT, count: 0 };
        }
      },
    });
  }

  // ---- 2. 工具注册 ×3 ----
  const toolDescriptor = (name, description, extraProps) => ({
    type: 'function',
    function: {
      name,
      description,
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['save', 'recall', 'forget'] },
          text: { type: 'string' },
          kind: { type: 'string', enum: ['fact', 'config'] },
          reason: { type: 'string' },
          q: { type: 'string' },
          id: { type: 'string' },
          limit: { type: 'number' },
          ...extraProps,
        },
        required: ['action'],
      },
    },
  });

  const toolInvoke = async ({ args }) => {
    const k = kv();
    if (!k) return { ok: false, stdout: '', stderr: '长期记忆服务不可用（kv-store 未装配）' };
    if (hardOff) return { ok: false, stdout: '', stderr: '长期记忆已被 PLITE_LONG_MEMORY=0 禁用' };
    const r = execToolAction(k, args);
    return { ok: !!r.ok, stdout: r.stdout ?? '', stderr: r.ok ? '' : (r.error ?? '执行失败') };
  };

  if (registry?.registerTool) {
    registry.registerTool({
      name: 'memory',
      // 记忆写入不需要逐次审批：写错可 forget；与 ledger 同级信任（noApproval）
      noApproval: true,
      descriptor: toolDescriptor(
        'memory',
        '长期记忆存取。值得长期记住的用户偏好/决定/配置选择用 save（kind：fact=对话事实，config=配置偏好；reason 必附一句话理由）；查找记忆用 recall（支持关键词 q）；过时信息用 forget（先 recall 拿 id）。未开启时返回提示，需用户在会话设置开启。',
      ),
      invoke: toolInvoke,
    });
  }

  // ---- 3. HTTP 路由（管理面板 / chat-lite 设置分区）----
  return async function longMemoryApi(req, res, next) {
    if (hardOff) return next?.();
    const [pathname] = (req.url ?? '').split('?');
    if (!pathname.startsWith('/api/long-memory/')) return next?.();

    // 会话 cookie 硬门禁（对齐 kv-store）
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
      req.on('data', (c) => { b += c; if (b.length > BODY_LIMIT) req.destroy(); });
      req.on('end', () => r(b));
    });

    try {
      const k = kv();
      if (!k) return sendJson(503, { error: 'kv-store 未装配' });
      const url = new URL(req.url, 'http://x');

      // GET /api/long-memory/settings → { enabled, injectLimit, count }
      if (pathname === '/api/long-memory/settings' && req.method === 'GET') {
        ensureSeeded();
        return sendJson(200, { ...settingsOf(k), count: itemsOf(k).length });
      }

      // POST /api/long-memory/settings { enabled?, injectLimit? }
      if (pathname === '/api/long-memory/settings' && req.method === 'POST') {
        const body = JSON.parse((await readBody()) || '{}');
        const cur = settingsOf(k);
        const next = {
          enabled: typeof body.enabled === 'boolean' ? body.enabled : cur.enabled,
          injectLimit: Number(body.injectLimit) > 0 ? Math.min(Math.floor(Number(body.injectLimit)), 20000) : cur.injectLimit,
        };
        k.set(NS, 'settings', next);
        return sendJson(200, { ok: true, ...next, count: itemsOf(k).length });
      }

      // GET /api/long-memory/items?kind=&q= → { items }
      if (pathname === '/api/long-memory/items' && req.method === 'GET') {
        const kind = url.searchParams.get('kind');
        const q = String(url.searchParams.get('q') ?? '').trim().toLowerCase();
        let items = itemsOf(k);
        if (kind === 'fact' || kind === 'config') items = items.filter((it) => it.kind === kind);
        if (q) items = items.filter((it) => it.text.toLowerCase().includes(q) || String(it.reason ?? '').toLowerCase().includes(q));
        return sendJson(200, { items: items.slice(-500).reverse() });
      }

      // POST /api/long-memory/items { text, kind, reason }（面板手动新增）
      if (pathname === '/api/long-memory/items' && req.method === 'POST') {
        const body = JSON.parse((await readBody()) || '{}');
        const r = execToolAction(k, { action: 'save', text: String(body.text ?? ''), kind: body.kind, reason: body.reason });
        return r.ok ? sendJson(200, JSON.parse(r.stdout)) : sendJson(400, { error: r.error });
      }

      // POST /api/long-memory/update { id, text, kind, reason }
      if (pathname === '/api/long-memory/update' && req.method === 'POST') {
        const body = JSON.parse((await readBody()) || '{}');
        const id = String(body.id ?? '').trim();
        const it = id ? k.get(NS, `item.${id}`) : null;
        if (!it) return sendJson(404, { error: `未找到记忆 ${id}` });
        const text = body.text !== undefined ? String(body.text).trim().slice(0, MAX_TEXT_LEN) : it.text;
        if (!text) return sendJson(400, { error: 'text 不能为空' });
        const next = {
          ...it,
          text,
          kind: body.kind === 'config' || body.kind === 'fact' ? body.kind : it.kind,
          reason: body.reason !== undefined ? String(body.reason).trim().slice(0, 200) : it.reason,
          updatedAt: Date.now(),
        };
        k.set(NS, `item.${id}`, next);
        return sendJson(200, { ok: true, item: next });
      }

      // POST /api/long-memory/delete { id }
      if (pathname === '/api/long-memory/delete' && req.method === 'POST') {
        const body = JSON.parse((await readBody()) || '{}');
        const id = String(body.id ?? '').trim();
        if (!id || !k.get(NS, `item.${id}`)) return sendJson(404, { error: `未找到记忆 ${id}` });
        k.del(NS, `item.${id}`);
        return sendJson(200, { ok: true, deleted: id });
      }

      // POST /api/long-memory/clear（清空全部条目；二次确认由 UI 承担）
      if (pathname === '/api/long-memory/clear' && req.method === 'POST') {
        await readBody();
        let n = 0;
        for (const key of k.keys(NS, 'item.')) { k.del(NS, key); n++; }
        return sendJson(200, { ok: true, cleared: n });
      }

      return sendJson(404, { error: 'not found' });
    } catch (e) {
      return sendJson(400, { error: String(e?.message ?? e) });
    }
  };
}
