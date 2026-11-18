/**
 * 供应商配置 API（服务端权威 + 明文 key 不出服务端）。
 *
 * 全部路由要求宿主登录会话（HttpOnly cookie）；未登录一律 401。
 * 能力识别（catalog / vision / effort）在上游侧完成，浏览器只拿结论——
 * 因为探测必须带明文 key，而 key 已不在浏览器。
 */
import { readJson, sendJson, sendError, HttpError, BODY_LIMIT_SMALL } from './http-util.mjs';

const PROBE_TIMEOUT_MS = 20_000;
/** 1x1 透明 PNG（探测 vision 通道用，最小体积） */
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function authHeader(key) {
  return { Authorization: `Bearer ${key}` };
}

async function jsonFetch(url, init = {}) {
  const resp = await fetch(url, { ...init, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), redirect: 'manual' });
  let json = null;
  const text = await resp.text().catch(() => '');
  try { json = JSON.parse(text); } catch { /* 非 JSON（如 SSE/纯文本错误页） */ }
  return { status: resp.status, json, text };
}

export function createProvidersApi({ store, policy, getSession }) {
  const requireSession = (req) => {
    const s = getSession?.(req);
    if (!s) throw new HttpError(401, 'SESSION_REQUIRED', '未登录');
    return s;
  };

  const requireProvider = (id) => {
    const p = store.get(String(id ?? ''));
    if (!p) throw new HttpError(404, 'PROVIDER_NOT_FOUND', `供应商不存在：${id}`);
    if (!p.apiKey) throw new HttpError(400, 'PROVIDER_NO_KEY', '该供应商未配置 API Key');
    return p;
  };

  /** 供应商 baseURL 保存前校验（SSRF：https + 白名单 + 非私有地址） */
  const validateBaseURL = (baseURL) => {
    if (!baseURL) throw new HttpError(400, 'BASE_URL_REQUIRED', '请填写 Base URL');
    try {
      policy.assertAllowedUrl(`${baseURL.replace(/\/+$/, '')}/`);
    } catch (e) {
      throw new HttpError(400, 'BASE_URL_NOT_ALLOWED', e.message);
    }
  };

  // ---------- 探测（全部服务端执行） ----------

  const probeCatalog = async (p) => {
    const { status, json } = await jsonFetch(`${p.baseURL}/models`, { method: 'GET', headers: authHeader(p.apiKey) });
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

  const routes = {
    'GET /api/providers/list': async (req) => {
      requireSession(req);
      return { configs: store.listPublic(), activeId: store.getActive()?.id ?? null };
    },

    'POST /api/providers/save': async (req) => {
      requireSession(req);
      const body = await readJson(req, BODY_LIMIT_SMALL);
      const config = body.config ?? {};
      if (!config.id) throw new HttpError(400, 'ID_REQUIRED', '缺少供应商 id');
      if (config.baseURL) validateBaseURL(String(config.baseURL).replace(/\/+$/, ''));
      store.save(config);
      return { configs: store.listPublic() };
    },

    'POST /api/providers/remove': async (req) => {
      requireSession(req);
      const { id } = await readJson(req, BODY_LIMIT_SMALL);
      if (!id) throw new HttpError(400, 'ID_REQUIRED', '缺少供应商 id');
      store.remove(String(id));
      return { configs: store.listPublic() };
    },

    'POST /api/providers/set-default': async (req) => {
      requireSession(req);
      const { id } = await readJson(req, BODY_LIMIT_SMALL);
      if (!id) throw new HttpError(400, 'ID_REQUIRED', '缺少供应商 id');
      store.setDefault(String(id));
      return { configs: store.listPublic() };
    },

    /** 连通性测试：先试 /models，不支持则退化为最小 chat 请求 */
    'POST /api/providers/test': async (req) => {
      requireSession(req);
      const { id } = await readJson(req, BODY_LIMIT_SMALL);
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
      const body = await readJson(req, BODY_LIMIT_SMALL);
      const p = requireProvider(body.id);
      if (!p.baseURL) throw new HttpError(400, 'BASE_URL_REQUIRED', '该供应商未配置 Base URL');
      try {
        policy.assertAllowedUrl(`${p.baseURL}/`);
      } catch (e) {
        throw new HttpError(400, 'BASE_URL_NOT_ALLOWED', e.message);
      }

      const notes = [];
      const catalogIds = body.live === false ? null : await probeCatalog(p);
      if (body.live !== false) {
        notes.push(catalogIds ? `模型目录探测成功（${catalogIds.length} 个模型）` : '模型目录不可用（跳过 catalog 级）');
      }

      const probes = {};
      if (body.live !== false) {
        for (const m of p.models) {
          probes[m.id] = {
            vision: await probeVision(p, m.id),
            effort: await probeEffort(p, m.id),
          };
        }
      }
      return { ok: true, catalogIds, probes, notes };
    },
  };

  return function providersApi(req, res, next) {
    const [pathname] = (req.url ?? '').split('?');
    if (!pathname.startsWith('/api/providers/')) return next?.();
    const handler = routes[`${req.method} ${pathname}`];
    if (!handler) return sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'no such route' } });
    handler(req, res).then(
      (data) => sendJson(res, 200, { ok: true, ...data }),
      (err) => sendError(res, err),
    );
  };
}
