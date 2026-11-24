/**
 * translate 插件：中英互译 + 多语言翻译（自 Polaris「翻译」功能移植，纯插件形态）。
 *
 * 职责：
 * - cap.tool.translate：AI 工具（describe 协议进 agent-loop），AI 可直接把文本翻译成指定语言；
 * - panel 槽：翻译面板（方向切换/输入/结果/复制/历史），未配密钥时内嵌配置表单；
 * - server 半边（server.mjs）：百度翻译代理 + 签名 + 错误码中文化 + LRU 缓存 + 配置存储；
 * - 历史：cap.kv（namespace='translate'），内存式最近 50 条。
 *
 * 对齐 Polaris 交互：
 * - 方向自动判断：选中文本含中文则译英，否则译中（containsChinese）；
 * - 面板手动切换 toEn/toZh，默认 toEn。
 */
import type { CapabilityHandler, LitePlugin, SlotHostApi } from '@sdk';
import { TranslatePanel } from './Panel';
import './panel.css';

export const NS = 'translate';
export const HISTORY_KEY = 'history';
const MAX_HISTORY = 50;
const MAX_TEXT_LEN = 6000;

let api: SlotHostApi | null = null;

/** 面板侧宿主 API 桥（Panel 与本模块同 bundle，直接共享 setup 注入的 api） */
let panelApi: SlotHostApi | null = null;
export function setPanelHostApi(a: SlotHostApi): void { panelApi = a; }
export function getPanelHostApi(): SlotHostApi | null { return panelApi; }

// ── 方向判断（对齐 Polaris SelectionContextMenu.tsx L34-36） ─────────────

export function containsChinese(text: string): boolean {
  return /[\u4e00-\u9fa5]/.test(text);
}

/** 自动目标语言：含中文译 en，否则译 zh */
export function autoTargetLang(text: string): string {
  return containsChinese(text) ? 'en' : 'zh';
}

// ── server 代理调用（同源 fetch；session cookie 自动携带） ───────────────

export interface TranslateResult {
  ok: boolean;
  result?: string;
  src?: string;
  to?: string;
  cached?: boolean;
  error?: string;
}

export interface TranslateConfigStatus {
  ok?: boolean;
  configured: boolean;
  appId?: string;
  langs?: { code: string; label: string }[];
}

export async function callTranslate(text: string, to?: string): Promise<TranslateResult> {
  const res = await fetch('/api/translate/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, to: to ?? autoTargetLang(text) }),
  });
  return (await res.json()) as TranslateResult;
}

/** 批量翻译（translate_texts）：字符串数组进、数组出（失败项 null） */
export async function callTranslateBatch(texts: string[], to?: string): Promise<(string | null)[]> {
  const api0 = getPanelHostApi();
  if (api0) {
    const res = await api0.dispatch<{ ok: boolean; results?: (string | null)[]; error?: string }>({
      target: 'cap.tool.translate', action: 'exec_batch', payload: { texts, to },
    });
    if (res.ok && res.data?.ok) return res.data.results ?? texts.map(() => null);
    const err = res.data?.error ?? res.error;
    throw new Error(typeof err === 'string' ? err : '批量翻译失败');
  }
  const r = await fetch('/api/translate/translate-batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texts, to }),
  });
  const j = (await r.json()) as { ok: boolean; results?: (string | null)[]; error?: string };
  if (!j.ok) throw new Error(j.error ?? '批量翻译失败');
  return j.results ?? texts.map(() => null);
}

export async function fetchTranslateConfig(): Promise<TranslateConfigStatus> {
  const res = await fetch('/api/translate/config');
  return (await res.json()) as TranslateConfigStatus;
}

export async function saveTranslateConfig(appId: string, secretKey: string): Promise<{ ok: boolean; configured: boolean; error?: string }> {
  const res = await fetch('/api/translate/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId, secretKey }),
  });
  return (await res.json()) as { ok: boolean; configured: boolean; error?: string };
}

// ── 历史（cap.kv；AI 工具与面板同键空间） ───────────────────────────────

export interface HistoryItem {
  id: string;
  text: string;
  result: string;
  to: string;
  createdAt: string;
}

async function historyGet(): Promise<HistoryItem[]> {
  if (!api) return [];
  const res = await api.dispatch<{ value?: HistoryItem[] | null }>({
    target: 'cap.kv', action: 'get', payload: { namespace: NS, key: HISTORY_KEY },
  });
  const v = res.ok ? res.data?.value : null;
  return Array.isArray(v) ? v : [];
}

async function historySet(items: HistoryItem[]): Promise<void> {
  await api?.dispatch({ target: 'cap.kv', action: 'set', payload: { namespace: NS, key: HISTORY_KEY, value: items } });
}

/** 写入一条历史（插头、去重相邻同文、上限 50）；变更后广播 refresh 事件 */
export async function pushHistory(text: string, result: string, to: string): Promise<HistoryItem[]> {
  const items = await historyGet();
  const entry: HistoryItem = {
    id: `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    text, result, to, createdAt: new Date().toISOString(),
  };
  const next = [entry, ...items.filter((h) => !(h.text === text && h.to === to))].slice(0, MAX_HISTORY);
  await historySet(next);
  api?.emit('translate-history-changed', { count: next.length });
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('translate-history-changed'));
  return next;
}

export async function clearHistory(): Promise<void> {
  await historySet([]);
  api?.emit('translate-history-changed', { count: 0 });
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('translate-history-changed'));
}

export async function listHistory(): Promise<HistoryItem[]> {
  return historyGet();
}

// ── AI 工具（describe 协议） ────────────────────────────────────────────

const LANG_CODES = ['zh', 'en', 'jp', 'kor', 'fra', 'de', 'ru', 'spa', 'wyw'];

const DESCRIPTOR = {
  cap: 'cap.tool.translate',
  name: 'translate',
  description:
    '把文本翻译成目标语言（百度翻译，from=auto 自动检测源语言）。' +
    '当用户说「翻译这段话/帮我翻译成英语」时调用。' +
    'to 从 zh(中文)/en(英语)/jp(日语)/kor(韩语)/fra(法语)/de(德语)/ru(俄语)/spa(西班牙语)/wyw(文言文) 里选；' +
    '不传 to 时自动判断：含中文译英语，否则译中文。文本 ≤6000 字。',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: '要翻译的文本（≤6000 字）' },
      to: { type: 'string', description: '目标语言代码：zh|en|jp|kor|fra|de|ru|spa|wyw；省略时自动判断（中译英，非中译中）', enum: LANG_CODES },
    },
    required: ['text'],
  },
  danger: 'read' as const,
};

function createTranslateHandler(): CapabilityHandler {
  return async (req) => {
    const p = (req.payload ?? {}) as Record<string, unknown>;
    try {
      if (req.action === 'describe') return { descriptor: DESCRIPTOR };
      if (req.action === 'exec') {
        const text = typeof p.text === 'string' ? p.text.trim() : '';
        if (!text) return { ok: false, error: 'text 不能为空' };
        if (text.length > MAX_TEXT_LEN) return { ok: false, error: `text 超长（${text.length} > ${MAX_TEXT_LEN}），请分段` };
        const to = p.to ? String(p.to) : autoTargetLang(text);
        if (!LANG_CODES.includes(to)) return { ok: false, error: `不支持的目标语言：${to}` };
        const r = await callTranslate(text, to);
        if (!r.ok) return { ok: false, error: r.error ?? '翻译失败' };
        void pushHistory(text, r.result ?? '', to); // 历史失败不影响主链路
        return { ok: true, result: r.result, src: r.src, to, cached: r.cached };
      }
      // 批量动作（面板/其它插件接入用）：字符串数组进、数组出，失败项以 null 占位
      if (req.action === 'exec_batch') {
        const texts = Array.isArray(p.texts) ? p.texts : [];
        if (!texts.length) return { ok: false, error: 'texts 不能为空' };
        if (texts.length > 50) return { ok: false, error: 'texts 一次最多 50 条' };
        const to = p.to ? String(p.to) : '';
        const results: (string | null)[] = [];
        for (const raw of texts) {
          const text = typeof raw === 'string' ? raw.trim() : '';
          if (!text || text.length > MAX_TEXT_LEN) { results.push(null); continue; }
          const target = to || autoTargetLang(text);
          if (!LANG_CODES.includes(target)) { results.push(null); continue; }
          try {
            const r = await callTranslate(text, target);
            results.push(r.ok ? (r.result ?? null) : null);
          } catch { results.push(null); }
        }
        return { ok: true, results };
      }
      return { ok: false, error: `unknown action: ${req.action}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };
}

// ── 插件定义 ────────────────────────────────────────────────────────────

export const translatePlugin: LitePlugin = {
  manifest: {
    id: 'translate',
    name: '翻译',
    version: '0.1.0',
    capabilities: ['cap.kv'],
    provides: ['cap.tool.translate'],
    events: ['tool-registered', 'translate-history-changed'],
    contributes: {
      // title ≤4 字：panel tab 等分宽约 74px；order 27（26 被 git-panel 占用）
      slots: [{ slot: 'panel', component: 'TranslatePanel', order: 27, title: '翻译' }],
    },
  },
  setup(a: SlotHostApi) {
    api = a;
    setPanelHostApi(a);
    a.registerCapability.register('cap.tool.translate', createTranslateHandler());
    // 迟到广播兜底（loop 晚于本插件装配时也能发现工具）
    a.emit('tool-registered', { cap: 'cap.tool.translate', name: 'translate' });
  },
};

export { TranslatePanel };
export { useAutoTranslate, isEnglishDesc } from './useAutoTranslate';
export default translatePlugin;
