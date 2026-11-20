/**
 * Service Worker（缓存壳）——polaris-lite 手机 App 化的离线底线。
 *
 * 策略（docs/mobile-app-plan.md §4 P0-4）：
 * - navigate 请求（HTML 文档）：network-first——在线=新鲜壳，离线=上次的壳；
 * - 静态 assets（js/css/icons）：stale-while-revalidate——先给缓存、后台更新；
 * - API（/api/*、/api/model-relay）：**一律不缓存、不拦截**（红线：陈旧会话/密钥的诡异态难排查）。
 *
 * 产物清单由构建期生成：vite build 产出 hash 文件名的 assets 每次构建都变，
 * SW 缓存清单必须在 build 时注入（scripts/gen-sw-manifest.mjs 生成 sw-manifest.js），
 * 本文件在 install 期读取该清单——两份文件总是一起部署，不会错位。
 */
// build 期注入：importScripts('sw-manifest.js') 定义 self.__PLITE_ASSETS = [...]
importScripts('./sw-manifest.js');

const CACHE = 'plite-shell-v1';
const NAV_FALLBACK = '/index.html';

self.addEventListener('install', () => {
  // 不预缓存 assets（SWR 按需填充）；立即激活
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // 清理旧版本缓存
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 只管同源
  if (url.pathname.startsWith('/api/')) return; // API 红线：不碰

  // 文档导航：network-first，离线回退缓存壳
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          const cache = await caches.open(CACHE);
          cache.put(NAV_FALLBACK, fresh.clone());
          return fresh;
        } catch {
          const cached = (await caches.match(NAV_FALLBACK)) || (await caches.match(req));
          if (cached) return cached;
          return new Response('offline', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
        }
      })(),
    );
    return;
  }

  // 静态资源（构建期清单内的 hash 产物 + 图标/manifest）：SWR
  const assets = self.__PLITE_ASSETS || [];
  const isAsset = url.pathname.startsWith('/assets/') || assets.includes(url.pathname) ||
    url.pathname.startsWith('/icons/') || url.pathname === '/manifest.webmanifest';
  if (req.method === 'GET' && isAsset) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const cached = await cache.match(req);
        const fetchPromise = fetch(req)
          .then((res) => {
            if (res.ok) cache.put(req, res.clone());
            return res;
          })
          .catch(() => cached || Response.error());
        return cached || fetchPromise;
      })(),
    );
  }
  // 其余（插件产物等）直连，不拦——插件产物本就禁强缓存（prod-server 注释）
});
