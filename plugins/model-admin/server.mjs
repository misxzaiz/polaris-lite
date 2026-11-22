/**
 * model-admin 插件的服务端半边（探测迁移版，host-slimming-report §2.4 / §7.3 / §4 P2-1）。
 *
 * 职责：供应商能力探测——连通性测试 / 逐模型能力识别 / 运行时自愈回填。
 * 迁移自 server/providers-api.mjs（2026-11-21）：探测是「业务」而非平台能力，
 * 与 model-admin/detect.ts 是同一件事的两半（detect 头注释自述「服务端负责真实探测,
 * 本模块只做纯计算合并」）。宿主 providers-api 只留 CRUD/密钥保管/direct-config。
 *
 * 契约（server-registry）：export createServerPart({ dataDir, getSession, store, policy })
 * → 中间件函数。探测写回**仍走宿主注入的 store.updateModels**——不复制写回逻辑,
 * 防止宿主/插件双头写同一数据（report §7.3 风险对冲）。
 *
 * 端点（URL 不变,前端零改动）：
 *   POST /api/providers/test       { id } → 连通性测试
 *   POST /api/providers/probe      { id, live, deep, modelIds } → 逐模型能力识别
 *   POST /api/providers/note-probe { id, modelId, patch } → 运行时自愈回填
 *
 * 安全模型：全部端点要求宿主登录会话（getSession 注入,未登录 401）;
 * baseURL 经宿主 policy.assertAllowedUrl 校验（SSRF 白名单同宿主口径）;
 * 明文 key 只在服务端内存中用于上游调用,响应不含 key。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const PROBE_TIMEOUT_MS = 20_000;
/** 深度差分探针单次上限（effort 差分需要真实思考量，16 太小测不出差异） */
const DEEP_PROBE_TIMEOUT_MS = 120_000;
const DEEP_MAX_TOKENS = 2000;
/** 1x1 透明 PNG（探测 vision 通道用，最小体积） */
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function authHeader(key) {
  return { Authorization: `Bearer ${key}` };
}

async function jsonFetch(url, init = {}, timeoutMs = PROBE_TIMEOUT_MS) {
  const resp = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
  let json = null;
  const text = await resp.text().catch(() => '');
  try { json = JSON.parse(text); } catch { /* 非 JSON（如 SSE/纯文本错误页） */ }
  return { status: resp.status, json, text };
}

class ProbeHttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function createServerPart(options = {}) {
  const getSession = options.getSession;
  const store = options.store;
  const policy = options.policy;
  const dataDir = options.dataDir ?? '.polaris-lite';

  // ---------- models.dev 公开目录（随探测迁移；进程内 + 落盘双层缓存,TTL 7 天） ----------
  const catalogCacheFile = join(dataDir, 'modelsdev-cache.json');
  const CATALOG_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  let catalogMem = null;

  const readCatalogCache = () => {
    try {
      if (!existsSync(catalogCacheFile)) return null;
      const { at, json } = JSON.parse(readFileSync(catalogCacheFile, 'utf8'));
      if (!at || !json || Date.now() - at > CATALOG_TTL_MS) return null;
      return json;
    } catch { return null; }
  };
  const writeCatalogCache = (json) => {
    try {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(catalogCacheFile, JSON.stringify({ at: Date.now(), json }));
    } catch { /* 缓存失败不阻塞探测 */ }
  };

  const getCatalog = async () => {
    if (catalogMem) return catalogMem;
    const cached = readCatalogCache();
    if (cached) { catalogMem = cached; return cached; }
    try {
      const resp = await fetch('https://models.dev/api.json', { signal: AbortSignal.timeout(15_000) });
      if (!resp.ok) return null;
      const json = await resp.json();
      if (json && typeof json === 'object') {
        catalogMem = json;
        writeCatalogCache(json);
        return json;
      }
      return null;
    } catch {
      // 拉取失败：旧缓存即使过期也用（离线降级）
      try {
        if (existsSync(catalogCacheFile)) {
          const { json } = JSON.parse(readFileSync(catalogCacheFile, 'utf8'));
          if (json) return json;
        }
      } catch { /* 无缓存可用 */ }
      return null;
    }
  };

  const matchCatalogEntry = (catalog, modelId) => {
    if (!catalog) return null;
    const exact = catalog[modelId];
    if (exact) return exact;
    // 后缀匹配（实测 `nex-agi/nex-n2.6` 命中聚合别名 `nex-n2.6`）
    const suffix = modelId.split('/').pop();
    for (const [id, entry] of Object.entries(catalog)) {
      if (id === suffix || id.split('/').pop() === suffix) return entry;
    }
    return null;
  };

  // ---------- 会话 / 供应商门禁（同宿主口径） ----------
  const requireSession = (req) => {
    const s = getSession?.(req);
    if (!s) throw new ProbeHttpError(401, 'SESSION_REQUIRED', '未登录');
    return s;
  };
  const requireProvider = (id) => {
    const p = store.get(String(id ?? ''));
    if (!p) throw new ProbeHttpError(404, 'PROVIDER_NOT_FOUND', `供应商不存在：${id}`);
    if (!p.apiKey) throw new ProbeHttpError(400, 'PROVIDER_NO_KEY', '该供应商未配置 API Key');
    return p;
  };

  // ---------- 探测实现（迁自 providers-api,逐字节同源） ----------
  const probeCatalog = async (p) => {
    const { status, json } = await jsonFetch(`${p.baseURL}/models`, { method: 'GET', headers: p.apiKey ? authHeader(p.apiKey) : {} });
    if (status !== 200 || !json) return null;
    const ids = (json.data ?? json.models ?? [])
      .map((m) => (typeof m === 'string' ? m : m?.id))
      .filter((x) => typeof x === 'string');
    return ids.length ? ids : null;
  };

  const probeVision = async (p, modelId) => {
    try {
      const { status, json, text } = await jsonFetch(`${p.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader(p.apiKey) },
        body: JSON.stringify({
          model: modelId,
          max_tokens: 1,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: 'ping' },
              { type: 'image_url', image_url: { url: TINY_PNG } },
            ],
          }],
        }),
      });
      if (status >= 200 && status < 300) return true;
      const msg = String(json?.error?.message ?? json?.message ?? text ?? '');
      if (/image|vision|multimodal|not support|unsupported|invalid content/i.test(msg)) return false;
      return null; // 限流/鉴权等：维持未知
    } catch {
      return null;
    }
  };

  const probeEffort = async (p, modelId) => {
    try {
      const { status, json, text } = await jsonFetch(`${p.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader(p.apiKey) },
        body: JSON.stringify({
          model: modelId,
          max_tokens: 1,
          reasoning_effort: 'low',
          messages: [{ role: 'user', content: 'ping' }],
        }),
      });
      if (status >= 200 && status < 300) return 'low';
      const msg = String(json?.error?.message ?? json?.message ?? text ?? '');
      if (/reasoning|effort|unknown (parameter|field)|unexpected/i.test(msg)) return null;
      return 'unknown';
    } catch {
      return 'unknown';
    }
  };

  function parseLimitFromError(text) {
    const patterns = [
      /between\s+\d+\s+and\s+(\d+)/i,
      /at\s+most\s+(\d+)/i,
      /(?:maximum|limit|max)[^\d]{0,24}(\d{3,})/i,
    ];
    for (const re of patterns) {
      const m = String(text ?? '').match(re);
      const v = m ? Number(m[1]) : NaN;
      if (Number.isFinite(v) && v > 0) return v;
    }
    return null;
  }

  const probeOutputLimit = async (p, modelId) => {
    try {
      const { status, json, text } = await jsonFetch(`${p.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader(p.apiKey) },
        body: JSON.stringify({
          model: modelId,
          max_tokens: 999_999_999,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      if (status === 400) {
        const msg = String(json?.error?.message ?? json?.message ?? text ?? '');
        const limit = parseLimitFromError(msg);
        return { kind: limit ? 'revealed' : 'unknown', limit };
      }
      if (status >= 200 && status < 300) return { kind: 'lenient', limit: null };
      return { kind: 'unknown', limit: null };
    } catch {
      return { kind: 'unknown', limit: null };
    }
  };

  const TINY_TOOL = {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get current weather for a city',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    },
  };

  const probeTools = async (p, modelId) => {
    const attempt = async (toolChoice) =>
      jsonFetch(`${p.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader(p.apiKey) },
        body: JSON.stringify({
          model: modelId,
          max_tokens: 64,
          messages: [{ role: 'user', content: 'What is the weather in Paris? Use the tool.' }],
          tools: [TINY_TOOL],
          tool_choice: toolChoice,
        }),
      });
    try {
      let r = await attempt('required');
      if (r.status === 400) r = await attempt('auto');
      if (r.status >= 200 && r.status < 300) {
        const tcs = r.json?.choices?.[0]?.message?.tool_calls;
        return Array.isArray(tcs) && tcs.length > 0 ? true : null;
      }
      const msg = String(r.json?.error?.message ?? r.json?.message ?? r.text ?? '');
      if (/tool|function/i.test(msg)) return false;
      return null;
    } catch {
      return null;
    }
  };

  const probeThinkingBasics = async (p, modelId) => {
    let eatsBudget = null;
    try {
      const { status, json } = await jsonFetch(`${p.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader(p.apiKey) },
        body: JSON.stringify({
          model: modelId,
          max_tokens: 64,
          messages: [{ role: 'user', content: '9.11 和 9.9 哪个大？请仔细推理后回答。' }],
        }),
      });
      if (status >= 200 && status < 300) {
        const msg = json?.choices?.[0]?.message ?? {};
        const rt = Number(json?.usage?.completion_tokens_details?.reasoning_tokens);
        const content = typeof msg.content === 'string'
          ? msg.content.trim()
          : Array.isArray(msg.content)
            ? msg.content.map((x) => x?.text ?? '').join('').trim()
            : '';
        if (Number.isFinite(rt)) eatsBudget = rt >= 64 && content === '';
      }
    } catch { /* 保持 null */ }
    let canDisable = null;
    try {
      const { status, json, text } = await jsonFetch(`${p.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader(p.apiKey) },
        body: JSON.stringify({
          model: modelId,
          max_tokens: 16,
          thinking: { type: 'disabled' },
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      if (status >= 200 && status < 300) canDisable = true;
      else if (status === 400) {
        const msg = String(json?.error?.message ?? json?.message ?? text ?? '');
        if (/disabl|think/i.test(msg)) canDisable = false;
        else if (/unrecognized|unknown (parameter|field)|unexpected/i.test(msg)) canDisable = null;
        else canDisable = null;
      }
    } catch { /* 保持 null */ }
    return { eatsBudget, canDisable };
  };

  const THINK_PROMPT = '9.11 和 9.9 哪个大？请一步一步仔细论证你的结论，不要省略推理过程。';

  const deepChat = async (p, modelId, extra) => {
    try {
      const { status, json } = await jsonFetch(`${p.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader(p.apiKey) },
        body: JSON.stringify({
          model: modelId,
          max_tokens: DEEP_MAX_TOKENS,
          messages: [{ role: 'user', content: THINK_PROMPT }],
          ...extra,
        }),
      }, DEEP_PROBE_TIMEOUT_MS);
      if (status < 200 || status >= 300) return { status };
      const rt = Number(json?.usage?.completion_tokens_details?.reasoning_tokens);
      return { status, reasoningTokens: Number.isFinite(rt) ? rt : null };
    } catch {
      return { status: 0 };
    }
  };

  const median = (arr) => {
    const s = arr.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : null;
  };

  const probeEffortDeep = async (p, modelId) => {
    const low = [];
    const high = [];
    for (let i = 0; i < 2; i += 1) {
      const r = await deepChat(p, modelId, { reasoning_effort: 'low' });
      if (r.status === 200) low.push(r.reasoningTokens);
    }
    for (let i = 0; i < 2; i += 1) {
      const r = await deepChat(p, modelId, { reasoning_effort: 'high' });
      if (r.status === 200) high.push(r.reasoningTokens);
    }
    const lm = median(low);
    const hm = median(high);
    const effortAccepted = lm !== null && hm !== null;
    const effortHonored = effortAccepted && hm !== null && lm !== null ? hm > lm * 1.5 : null;
    let budgetKnob = null;
    if (effortAccepted) {
      const b = await deepChat(p, modelId, { thinking: { type: 'enabled', budget_tokens: 4096 } });
      if (b.status === 200 && b.reasoningTokens !== null && hm !== null && b.reasoningTokens > hm) {
        budgetKnob = 'budget_tokens';
      }
    }
    return { effortAccepted, effortHonored, budgetKnob };
  };

  async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let i = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i;
        i += 1;
        out[idx] = await fn(items[idx], idx);
      }
    });
    await Promise.all(workers);
    return out;
  }

  const readBody = (req, limit = 64 * 1024) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) { reject(new ProbeHttpError(413, 'PAYLOAD_TOO_LARGE', '请求体过大')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
        catch { reject(new ProbeHttpError(400, 'BAD_JSON', '请求体不是合法 JSON')); }
      });
      req.on('error', reject);
    });

  const routes = {
    /** 拉取上游模型清单（/models,可缺省 key——部分网关不要求鉴权） */
    'POST /api/providers/fetch-models': async (req) => {
      requireSession(req);
      const body = await readBody(req);
      const saved = body.id ? store.get(String(body.id)) : null;
      const baseURL = String(body.baseURL ?? saved?.baseURL ?? '').trim().replace(/\/+$/, '');
      if (!baseURL) throw new ProbeHttpError(400, 'BASE_URL_REQUIRED', '请填写 Base URL');
      try {
        policy.assertAllowedUrl(`${baseURL}/`);
      } catch (e) {
        throw new ProbeHttpError(400, 'BASE_URL_NOT_ALLOWED', e.message);
      }
      const apiKey = (typeof body.apiKey === 'string' && body.apiKey.trim()) || saved?.apiKey || '';
      const ids = await probeCatalog({ baseURL, apiKey }) ?? null;
      return { ok: true, ids, count: ids?.length ?? 0 };
    },

    /** 连通性测试：先试 /models，不支持则退化为最小 chat 请求 */
    'POST /api/providers/test': async (req) => {
      requireSession(req);
      const { id } = await readBody(req);
      const p = requireProvider(id);
      try {
        policy.assertAllowedUrl(`${p.baseURL}/`);
      } catch (e) {
        return { ok: false, text: `地址被策略拦截：${e.message}` };
      }
      try {
        const models = await jsonFetch(`${p.baseURL}/models`, { method: 'GET', headers: authHeader(p.apiKey) });
        if (models.status >= 200 && models.status < 300) {
          const count = (models.json?.data ?? models.json?.models ?? []).length;
          return { ok: true, text: `连通成功（/models 返回 ${count} 个模型）` };
        }
        const chat = await jsonFetch(`${p.baseURL}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeader(p.apiKey) },
          body: JSON.stringify({
            model: p.activeModel || p.models[0]?.id || '',
            max_tokens: 1,
            messages: [{ role: 'user', content: 'ping' }],
          }),
        });
        if (chat.status >= 200 && chat.status < 300) return { ok: true, text: '连通成功（chat/completions 有响应）' };
        const msg = chat.json?.error?.message ?? chat.json?.message ?? `HTTP ${chat.status}`;
        return { ok: false, text: `调用失败：${msg}` };
      } catch (e) {
        return { ok: false, text: `连接异常：${e instanceof Error ? e.message : String(e)}` };
      }
    },

    /** 能力识别：结论写回存储，返回逐模型报告（不含 key） */
    'POST /api/providers/probe': async (req) => {
      requireSession(req);
      const body = await readBody(req);
      const p = requireProvider(body.id);
      if (!p.baseURL) throw new ProbeHttpError(400, 'BASE_URL_REQUIRED', '该供应商未配置 Base URL');
      try {
        policy.assertAllowedUrl(`${p.baseURL}/`);
      } catch (e) {
        throw new ProbeHttpError(400, 'BASE_URL_NOT_ALLOWED', e.message);
      }

      const deep = body.deep === true;
      const live = body.live !== false;
      const filterIds = Array.isArray(body.modelIds) ? body.modelIds.map(String) : null;
      const models = filterIds?.length ? p.models.filter((m) => filterIds.includes(m.id)) : p.models;
      const notes = [];
      if (filterIds?.length && live) notes.push(`单模型重探：${models.map((m) => m.id).join(', ')}`);
      const catalogIds = live ? await probeCatalog(p) : null;
      if (live) {
        notes.push(catalogIds ? `模型目录探测成功（${catalogIds.length} 个模型）` : '模型目录不可用（跳过 catalog 级）');
      }

      let catalogEntries = null;
      if (live && process.env.PLITE_MODELSDEV !== '0') {
        try {
          const catalog = await getCatalog();
          if (catalog) {
            catalogEntries = {};
            let hits = 0;
            for (const m of models) {
              const entry = matchCatalogEntry(catalog, m.id);
              if (entry) {
                catalogEntries[m.id] = entry;
                hits += 1;
              }
            }
            notes.push(`models.dev 目录命中 ${hits}/${models.length} 个模型`);
          } else {
            notes.push('models.dev 目录不可用（离线降级，跳过 catalog 级初值）');
          }
        } catch {
          notes.push('models.dev 目录解析失败（跳过 catalog 级初值）');
        }
      }

      const probes = {};
      if (live) {
        await mapLimit(models, 3, async (m) => {
          const vision = await probeVision(p, m.id);
          const effort = await probeEffort(p, m.id);
          const outputLimit = await probeOutputLimit(p, m.id);
          const tools = await probeTools(p, m.id);
          const thinking = await probeThinkingBasics(p, m.id);
          probes[m.id] = { vision, effort, outputLimit, tools, thinking };
          if (deep) {
            probes[m.id].deep = await probeEffortDeep(p, m.id);
          }
        });
      }
      return { ok: true, catalogIds, catalogEntries, probes, notes };
    },

    /**
     * 运行时自愈回填（real-engine 从上游限值报错里解析出真实上限后调用）。
     * 写回走宿主注入的 store.updateModels——探测在插件,写回权威在宿主,不双头。
     */
    'POST /api/providers/note-probe': async (req) => {
      requireSession(req);
      const body = await readBody(req);
      const p = requireProvider(body.id);
      const modelId = String(body.modelId ?? '');
      const patch = body.patch ?? {};
      const model = (p.models ?? []).find((m) => m.id === modelId);
      if (!model) throw new ProbeHttpError(404, 'MODEL_NOT_FOUND', `模型不存在：${modelId}`);
      const caps = { ...(model.capabilities ?? {}) };
      let touched = false;
      for (const key of ['maxOutputTokens', 'maxInputTokens']) {
        const v = Number(patch[key]);
        if (Number.isFinite(v) && v > 0 && caps[key] !== v) {
          caps[key] = Math.floor(v);
          touched = true;
        }
      }
      if (!touched) return { ok: true, changed: false, models: p.models };
      caps.detected = 'probe';
      caps.detectedAt = Date.now();
      const models = p.models.map((m) => (m.id === modelId ? { ...m, capabilities: caps } : m));
      store.updateModels(p.id, models);
      return { ok: true, changed: true, models };
    },
  };

  return function modelAdminProbeApi(req, res, next) {
    const [pathname] = (req.url ?? '').split('?');
    const key = `${req.method} ${pathname}`;
    if (!(key in routes)) return next?.();
    routes[key](req, res).then(
      (data) => {
        if (res.writableEnded) return;
        const body = JSON.stringify({ ok: true, ...data });
        res.writeHead(data ? 200 : 204, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(body);
      },
      (err) => {
        if (res.writableEnded) return;
        const status = err instanceof ProbeHttpError ? err.status : 500;
        const code = err instanceof ProbeHttpError ? err.code : 'INTERNAL';
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: { code, message: err instanceof Error ? err.message : String(err) } }));
      },
    );
  };
}
