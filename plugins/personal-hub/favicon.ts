/**
 * 网站图标抓取（对齐 Polaris src/services/personalHub/favicon.ts）。
 *
 * 纯前端探测站点静态资源 + DuckDuckGo 兜底；缓存原实现落 localStorage（7 天），
 * lite 侧存储键空间紧张（config-manager localStorage），改内存缓存 + 会话级复用，
 * 失效只影响一次重新探测。
 */

interface IconCacheEntry {
  url: string;
  timestamp: number;
}

const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 天
const memCache = new Map<string, IconCacheEntry>();

export async function fetchFavicon(url: string): Promise<string | null> {
  try {
    const origin = new URL(url).origin;
    const host = new URL(url).host;

    const cached = memCache.get(origin);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.url;

    const sources = [
      `${origin}/favicon.ico`,
      `${origin}/favicon.png`,
      `${origin}/apple-touch-icon.png`,
      `${origin}/icon.png`,
      `https://icons.duckduckgo.com/ip3/${host}.ico`,
    ];

    for (const iconUrl of sources) {
      try {
        if (await testImageUrl(iconUrl)) {
          memCache.set(origin, { url: iconUrl, timestamp: Date.now() });
          return iconUrl;
        }
      } catch {
        continue;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** 测试图片是否可加载（8 秒超时） */
export function testImageUrl(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image();
    const timeout = setTimeout(() => {
      img.src = '';
      resolve(false);
    }, 8000);
    img.onload = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    img.onerror = () => {
      clearTimeout(timeout);
      resolve(false);
    };
    img.src = `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`;
  });
}
