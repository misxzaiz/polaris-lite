/**
 * 宿主服务端装配（dev 与 prod 唯一出处）。
 *
 * 中间件顺序：鉴权 → 供应商配置 API → 模型中继 → 静态资源。
 * 三者共享同一个 provider store 与 SSRF 策略实例，避免 dev/prod 行为漂移。
 */
import { createAuthMiddleware } from './auth-session.mjs';
import { createProviderStore } from './provider-store.mjs';
import { createProvidersApi } from './providers-api.mjs';
import { createRelayMiddleware } from './relay-core.mjs';
import { createHostPolicy } from './upstream-policy.mjs';

export function createHost({ dataDir = '.polaris-lite', secureCookies = false, policyOptions } = {}) {
  const store = createProviderStore({ dataDir });
  const policy = createHostPolicy(undefined, policyOptions);
  const auth = createAuthMiddleware({ dataDir, secureCookies });
  const providers = createProvidersApi({ store, policy, getSession: auth.getSession });
  const relay = createRelayMiddleware({ store, policy, getSession: auth.getSession });

  /** 顺序敏感的中间件链（connect 风格：每个 handler 自行决定是否 next） */
  const middlewares = [auth.middleware, providers, relay];

  return { store, policy, auth, middlewares };
}
