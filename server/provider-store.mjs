/**
 * 供应商配置存储（服务端唯一权威）。
 *
 * 为什么在服务端：API Key 一旦进入浏览器，就等于进入 localStorage、内存、DevTools、
 * harness 日志与 XSS 的射程。此处把「配置 + 密钥」整体上收：
 * - 落盘 `.polaris-lite/providers.json`（0600，原子写：tmp + rename）；
 * - 对前端只暴露 masked 视图（keyMasked / hasKey），明文永不外发；
 * - 上游请求由 relay 在服务端注入 key（见 relay-core.mjs）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

export function maskKey(key) {
  if (!key) return '';
  if (key.length <= 8) return '*'.repeat(key.length);
  return `${key.slice(0, 3)}***${key.slice(-4)}`;
}

/**
 * 宽松解析 token 数量（能力字段的第二道防线）：接受数字 / "1m" / "1M" / "200k" /
 * "128000" / "1,000,000"；非法返回 null。此前 `Number(x)||0` 会把 "1m" 变 NaN→0、
 * 把剥掉后缀的 "1" 原样收下——上下文窗口于是永远回落默认 200k。与前端
 * plugins/model-admin/tokens.ts 的 parseTokenCount 同语义（两半边各自独立实现，
 * server 半边不 import 插件 TS）。
 */
export function parseTokenCount(raw) {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0) return null;
    return Math.floor(raw);
  }
  if (typeof raw !== 'string') return null;
  const s = raw.trim().replace(/[,\s_]/g, '');
  if (s === '') return 0; // 清空 = 未知
  const m = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  const mult = m[2] === 'm' || m[2] === 'M' ? 1e6 : m[2] === 'k' || m[2] === 'K' ? 1e3 : 1;
  return Math.floor(n * mult);
}

function tokenCap(m, key) {
  const parsed = parseTokenCount(m?.capabilities?.[key]);
  return parsed ?? 0; // 非法字面量归 0（=未知），绝不吞成错误值
}

/** 校验并规整一条供应商配置；apiKey 为空表示「保持原值」（编辑场景） */
function normalize(input, prev) {
  const baseURL = String(input.baseURL ?? '').trim().replace(/\/+$/, '');
  const models = Array.isArray(input.models)
    ? input.models
        .map((m) => ({
          id: String(m?.id ?? '').trim(),
          capabilities: {
            maxInputTokens: tokenCap(m, 'maxInputTokens'),
            maxOutputTokens: tokenCap(m, 'maxOutputTokens'),
            effort: m?.capabilities?.effort ?? null,
            vision: m?.capabilities?.vision === true,
            ...(m?.capabilities?.detected ? { detected: m.capabilities.detected } : {}),
            ...(m?.capabilities?.detectedAt ? { detectedAt: m.capabilities.detectedAt } : {}),
            // 布尔三态字段（true/false 写回，null/缺省不落）
            ...(m?.capabilities?.tools === true || m?.capabilities?.tools === false
              ? { tools: m.capabilities.tools } : {}),
            ...(m?.capabilities?.canDisableThinking === true || m?.capabilities?.canDisableThinking === false
              ? { canDisableThinking: m.capabilities.canDisableThinking } : {}),
            ...(m?.capabilities?.reasoningEatsBudget === true || m?.capabilities?.reasoningEatsBudget === false
              ? { reasoningEatsBudget: m.capabilities.reasoningEatsBudget } : {}),
          },
        }))
        .filter((m) => m.id)
    : [];
  const apiKey = typeof input.apiKey === 'string' && input.apiKey.trim() ? input.apiKey.trim() : (prev?.apiKey ?? '');
  return {
    id: String(input.id ?? prev?.id ?? `prov-${randomBytes(4).toString('hex')}`),
    name: String(input.name ?? prev?.name ?? '未命名供应商').trim() || '未命名供应商',
    baseURL,
    apiKey,
    models,
    activeModel: String(input.activeModel ?? prev?.activeModel ?? models[0]?.id ?? ''),
    enabled: input.enabled !== false,
    isDefault: input.isDefault === true,
  };
}

export function createProviderStore({ dataDir = '.polaris-lite' } = {}) {
  const file = resolve(process.cwd(), dataDir, 'providers.json');

  const read = () => {
    try {
      if (!existsSync(file)) return { providers: [] };
      const data = JSON.parse(readFileSync(file, 'utf8'));
      // 兼容早期形态：直接是数组
      const providers = Array.isArray(data) ? data : Array.isArray(data?.providers) ? data.providers : [];
      return { providers };
    } catch {
      return { providers: [] }; // 损坏则从空开始，不阻塞启动
    }
  };

  const write = (data) => {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, file); // 原子替换：不会留下半截文件
    try { chmodSync(file, 0o600); } catch { /* Windows 上无意义，忽略 */ }
  };

  const list = () => read().providers;

  /** 对外视图：明文 key 不出服务端 */
  const publicView = (c) => ({
    id: c.id,
    name: c.name,
    baseURL: c.baseURL,
    keyMasked: maskKey(c.apiKey),
    hasKey: !!c.apiKey,
    models: c.models ?? [],
    activeModel: c.activeModel ?? '',
    enabled: c.enabled !== false,
    isDefault: c.isDefault === true,
  });

  const listPublic = () => {
    const providers = list();
    return providers.map(publicView);
  };

  const get = (id) => list().find((c) => c.id === id) ?? null;

  /** 当前生效供应商：默认且启用且有 key → 否则任一启用且有 key */
  const getActive = () =>
    list().find((c) => c.isDefault && c.enabled !== false && c.apiKey) ??
    list().find((c) => c.enabled !== false && c.apiKey) ??
    null;

  const save = (input) => {
    const data = read();
    const idx = data.providers.findIndex((c) => c.id === input.id);
    const prev = idx >= 0 ? data.providers[idx] : null;
    const next = normalize(input, prev);
    if (idx >= 0) data.providers[idx] = next;
    else data.providers.push(next);
    if (next.isDefault) data.providers.forEach((c) => { if (c.id !== next.id) c.isDefault = false; });
    // 首个供应商自动成为默认
    if (!data.providers.some((c) => c.isDefault)) data.providers[0].isDefault = true;
    write(data);
    return next;
  };

  const remove = (id) => {
    const data = read();
    data.providers = data.providers.filter((c) => c.id !== id);
    if (data.providers.length && !data.providers.some((c) => c.isDefault)) data.providers[0].isDefault = true;
    write(data);
    return data.providers;
  };

  const setDefault = (id) => {
    const data = read();
    data.providers.forEach((c) => { c.isDefault = c.id === id; });
    write(data);
    return data.providers;
  };

  /** 能力识别回填：只改 models，不触碰 key */
  const updateModels = (id, models) => {
    const data = read();
    const target = data.providers.find((c) => c.id === id);
    if (!target) return null;
    target.models = models;
    write(data);
    return target;
  };

  return { file, list, listPublic, get, getActive, save, remove, setDefault, updateModels, publicView };
}
