/**
 * 上游访问策略（SSRF 防线，服务端唯一出处）。
 *
 * 密钥下沉服务端后，上游 URL 由服务端从 providers.json 读取并拼接，
 * 因此这里必须在**保存时**与**转发时**各校验一次：
 * - 仅 https；
 * - 主机必须在白名单（内置 + plugins/relay-hosts.json）；
 * - 拒绝私有/环回/链路本地地址（防 169.254.169.254 一类元数据端点）；
 * - 不跟随重定向（relay 用 redirect:'manual'）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const DEFAULT_HOSTS = [
  'api.openai.com', 'api.deepseek.com', 'api.moonshot.cn',
  'api.anthropic.com', 'dashscope.aliyuncs.com', 'open.bigmodel.cn',
  'api.mosi.cn',
];

/** 读取自定义白名单（plugins/relay-hosts.json，面板新增供应商时追加） */
export function loadExtraHosts() {
  try {
    const file = resolve(process.cwd(), 'plugins/relay-hosts.json');
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (Array.isArray(parsed)) return parsed.filter((h) => typeof h === 'string');
    }
  } catch { /* 配置损坏时按无自定义白名单处理 */ }
  return [];
}

export function createHostPolicy(extraHosts = loadExtraHosts(), options = {}) {
  const allowed = new Set([...DEFAULT_HOSTS, ...extraHosts].map((h) => h.toLowerCase()));
  /** 仅供本地联调/测试放行环回地址；生产形态永远保持 false */
  const allowPrivate = options.allowPrivate === true;

  /** 私有/环回/链路本地地址判定（含 IPv4 与常见 IPv6 写法） */
  const isPrivateHost = (hostname) => {
    const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
    if (h === '::1' || h === '::' || h.startsWith('fd') || h.startsWith('fe80')) return true;
    const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) return false;
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  };

  /**
   * 校验上游地址；不合法直接抛错（调用方转 400/502）。
   * @param {string} raw 完整 URL
   * @returns {URL} 校验通过的 URL
   */
  const assertAllowedUrl = (raw) => {
    let u;
    try {
      u = new URL(raw);
    } catch {
      throw new Error('upstream url 非法');
    }
    if (u.protocol !== 'https:') throw new Error('only https upstream allowed');
    if (!allowPrivate && isPrivateHost(u.hostname)) throw new Error(`private upstream blocked: ${u.hostname}`);
    if (!allowed.has(u.hostname.toLowerCase())) {
      throw new Error(`host not allowed: ${u.hostname}（如需支持，加入 plugins/relay-hosts.json）`);
    }
    return u;
  };

  return { assertAllowedUrl, isPrivateHost, allowedHosts: () => [...allowed] };
}
