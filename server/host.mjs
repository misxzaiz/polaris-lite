/**
 * 宿主服务端装配（dev 与 prod 唯一出处）。
 *
 * 平台能力：鉴权 → 供应商配置 API → 模型中继 → 静态资源。
 * 领域能力：一律由 plugins/server-registry.mjs 登记的服务端半边提供（文件浏览、
 * 工具执行等）。宿主**不 import 任何领域实现**——这是「核心零业务」在服务端的一侧。
 * 三者共享同一个 provider store 与 SSRF 策略实例，避免 dev/prod 行为漂移。
 *
 * 装配时机：本模块顶层 await 解析服务端插件清单（ESM 支持），所以 createHost 保持
 * 同步，vite.config.ts / prod-server.mjs / 测试无需改动调用方式。插件加载失败会
 * 直接让宿主启动失败（fail-fast），而不是运行时静默 404。
 */
import { createAuthMiddleware } from './auth-session.mjs';
import { createProviderStore } from './provider-store.mjs';
import { createProvidersApi } from './providers-api.mjs';
import { createRelayMiddleware } from './relay-core.mjs';
import { createHostPolicy } from './upstream-policy.mjs';
import { loadServerParts } from '../plugins/server-registry.mjs';

/** 工厂清单在模块加载期解析一次；每个 createHost 用真实 options 调工厂取独立中间件实例 */
const SERVER_PARTS = await loadServerParts();

export function createHost({ dataDir = '.polaris-lite', secureCookies = false, policyOptions } = {}) {
  const store = createProviderStore({ dataDir });
  const policy = createHostPolicy(undefined, policyOptions);
  const auth = createAuthMiddleware({ dataDir, secureCookies });
  const providers = createProvidersApi({ store, policy, getSession: auth.getSession });
  const relay = createRelayMiddleware({ store, policy, getSession: auth.getSession });

  // 领域中间件全部来自插件注册表的 server 半边；宿主按清单顺序装配，不认识任何领域语义。
  const pluginMiddlewares = SERVER_PARTS.map(({ id, createServerPart }) => {
    const mw = createServerPart({ dataDir, getSession: auth.getSession, store, policy, verifyTempToken: auth.verifyTempToken, tempTokens: auth.tempTokens });
    if (typeof mw !== 'function') throw new Error(`服务端插件 ${id} 的 createServerPart 未返回中间件函数`);
    return mw;
  });

  /** 顺序敏感的中间件链（connect 风格：每个 handler 自行决定是否 next） */
  const middlewares = [auth.middleware, providers, relay, ...pluginMiddlewares];

  return { store, policy, auth, middlewares, serverPlugins: SERVER_PARTS.map((p) => p.id) };
}
