/**
 * 供应商配置 API（服务端权威 + 明文 key 不出服务端）。
 *
 * 全部路由要求宿主登录会话（HttpOnly cookie）；未登录一律 401。
 *
 * 2026-11-21 探测半边迁移（host-slimming-report §2.4/§7.3）：test/probe/note-probe
 * 与 models.dev 目录已迁至 plugins/model-admin/server.mjs（探测是业务,与
 * model-admin/detect.ts 同一件事的两半）。本文件只留 CRUD/密钥保管/direct-config
 * 平台能力。写回仍走本模块注入的 store.updateModels(权威在宿主,不双头)。
 */
import { readJson, sendJson, sendError, HttpError, BODY_LIMIT_SMALL } from './http-util.mjs';
import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function createProvidersApi({ store, policy, getSession }) {

  const requireSession = (req) => {
    const s = getSession?.(req);
    if (!s) throw new HttpError(401, 'SESSION_REQUIRED', '未登录');
    return s;
  };

  /** 敏感操作审计（reveal-key 等）：一行一条 JSON，落在数据目录，损坏不影响主流程 */
  const audit = (entry) => {
    try {
      appendFileSync(join(dirname(store.file), 'providers-audit.jsonl'), `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
    } catch { /* 审计失败不阻塞主操作 */ }
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

    
    /**
     * 查看明文 API Key（「key 不出服务端」的唯一面板例外，与 direct-config 同套路）：
     *   ① 登录会话硬门禁；② PLITE_ALLOW_REVEAL=0 一键禁用（公网/生产部署建议关闭）；
     *   ③ 每次查看写入数据目录 providers-audit.jsonl（时间 + 用户 + 供应商）。
     * 前端护栏（10s 自动隐藏、只提供复制不持久化）在面板侧实现。
     */
    'POST /api/providers/reveal-key': async (req) => {
      const s = requireSession(req);
      if (process.env.PLITE_ALLOW_REVEAL === '0') {
        throw new HttpError(403, 'REVEAL_DISABLED', '本部署已禁用明文 Key 查看（PLITE_ALLOW_REVEAL=0）');
      }
      const { id } = await readJson(req, BODY_LIMIT_SMALL);
      const p = store.get(String(id ?? ''));
      if (!p) throw new HttpError(404, 'PROVIDER_NOT_FOUND', `供应商不存在：${id}`);
      if (!p.apiKey) throw new HttpError(400, 'PROVIDER_NO_KEY', '该供应商未配置 API Key');
      audit({ op: 'reveal-key', user: s.user?.name ?? 'unknown', providerId: p.id, providerName: p.name });
      return { ok: true, key: p.apiKey };
    },

    'POST /api/providers/set-default': async (req) => {
      requireSession(req);
      const { id } = await readJson(req, BODY_LIMIT_SMALL);
      if (!id) throw new HttpError(400, 'ID_REQUIRED', '缺少供应商 id');
      store.setDefault(String(id));
      return { configs: store.listPublic() };
    },




    /**
     * 直连配置（独立档 B 专用；docs/mobile-app-plan.md §10.3）：
     * 把当前启用供应商的明文 key + baseURL 发给前端，供手机在宿主不可达时
     * 直连供应商。这是「key 不出服务端」原则的唯一受控例外——约束：
     *   ① 已登录会话硬门禁（未登录 401）；
     *   ② PLITE_ALLOW_DIRECT_CONFIG=0 一键禁用（公网部署建议关闭）；
     *   ③ 调用方视角是「手机端点在连接档主动拉取」——UI 侧（real-engine 的
     *     独立模式面板）只在用户显式点「保存直连配置到本机」后才调用本接口，
     *     拉到的 key 由 UI 存本机 localStorage 供独立档使用。
     * （v2 修订：不再限回环 IP——手机经局域网访问时来源非回环，回环限制会让
     *  独立档在真机上永远取不到配置——原设计缺陷，单测从回环跑而掩盖了它。）
     */
    'POST /api/providers/direct-config': async (req) => {
      requireSession(req);
      if (process.env.PLITE_ALLOW_DIRECT_CONFIG === '0') {
        throw new HttpError(403, 'DIRECT_CONFIG_DISABLED', '本部署已禁用直连配置下发');
      }
      const active = store.getActive();
      if (!active || !active.apiKey) {
        throw new HttpError(404, 'PROVIDER_NO_ACTIVE', '没有已启用且配置了 Key 的供应商');
      }
      return {
        config: {
          id: active.id,
          name: active.name,
          baseURL: active.baseURL,
          apiKey: active.apiKey,
          models: active.models,
          activeModel: active.activeModel,
        },
      };
    },
  };

  return function providersApi(req, res, next) {
    const [pathname] = (req.url ?? '').split('?');
    if (!pathname.startsWith('/api/providers/')) return next?.();
    const handler = routes[`${req.method} ${pathname}`];
    // 未命中路由交给链上后续中间件（探测端点在 model-admin server 半边）;
    // 全链都未认领时由静态层兜底 404。
    if (!handler) return next?.();
    handler(req, res).then(
      (data) => sendJson(res, 200, { ok: true, ...data }),
      (err) => sendError(res, err),
    );
  };
}
