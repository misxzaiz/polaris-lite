/**
 * app-updater 插件的服务端半边（/api/app-updater/*）：构建版本查询。
 *
 * 这是「插件双入口」的服务端那一半：UI 半边在浏览器（index.tsx 轮询 +
 * 更新提示），本文件提供 Node 侧版本端点，由 plugins/server-registry.mjs
 * 登记、server/host.mjs 统一装配。宿主不认识 /api/app-updater/* 的任何语义。
 *
 * 为什么要有它：App（Captive 壳/PWA）里没有浏览器刷新入口，SPA 已加载的
 * JS 会一直跑旧代码——需要「客户端版本 vs 服务器版本」的比对源（详见
 * docs/app-updater-plan.md）。
 *
 * 版本来源：<dataDir>/app-updater-version.json，由 deploy 脚本（deploy-9826.mjs /
 * soft-deploy-9826.mjs 经其内部调用）在发布成功后写入：
 *   { "sha": "<full-sha>", "subject": "<commit 说明>", "time": "<ISO>" }
 * 文件缺失（从未部署过 / 生产环境没有 deploy 流程）返回 { sha: null }，
 * 前端按「版本信息不可用」优雅降级，而不是 500。
 *
 * 安全模型（对齐 kv-store）：
 * - 会话 cookie 硬门禁（未登录 401）——版本信息本身无害，但保持与其它
 *   /api/* 端点一致的鉴权面，不额外开匿名口子；
 * - 只读端点，无写入面，无用户可控输入（没有 query/body 解析）。
 *
 * 端点：
 *   GET /api/app-updater/version → { sha, subject, time } | { sha: null }
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function createServerPart(options = {}) {
  const getSession = options.getSession;
  const dataDir = resolve(options.dataDir ?? '.polaris-lite');
  const versionFile = resolve(dataDir, 'app-updater-version.json');

  return async function appUpdaterApi(req, res, next) {
    const [pathname] = (req.url ?? '').split('?');
    if (pathname !== '/api/app-updater/version') return next?.();

    // 会话 cookie 硬门禁（与 kv-store / html-preview 一致）
    const session = getSession?.(req);
    if (!session) {
      res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ error: 'unauthorized', code: 'SESSION_REQUIRED' }));
    }

    if (req.method !== 'GET') {
      res.writeHead(405, { Allow: 'GET', 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'method not allowed' }));
    }

    // 每次现读文件而不是启动时缓存：pm2 restart 前后文件都会被 deploy 改写，
    // 现读保证 restart 后第一条请求就拿到新值；文件极小（<200B），成本可忽略。
    let payload = { sha: null, subject: null, time: null };
    try {
      if (existsSync(versionFile)) {
        const raw = JSON.parse(readFileSync(versionFile, 'utf8'));
        if (typeof raw.sha === 'string' && raw.sha) {
          payload = {
            sha: raw.sha,
            subject: typeof raw.subject === 'string' ? raw.subject : null,
            time: typeof raw.time === 'string' ? raw.time : null,
          };
        }
      }
    } catch {
      // 文件损坏（半写/手工编辑错）→ 维持 { sha: null } 降级，不打挂端点
    }

    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(payload));
  };
}
