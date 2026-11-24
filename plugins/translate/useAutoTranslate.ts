/**
 * useAutoTranslate —— 面板英文描述自动翻译 hook（translate 插件的共享前端能力）。
 *
 * 设计：
 * - isEnglish：无中文字符且含拉丁字母且长度 ≥ 阈值（默认 12）才判定需要翻译；
 * - 缓存：内存 Map + cap.kv（namespace='translate', key='desc-cache'）双层；
 *   kv 命中后二次打开秒出译文；翻译成功后异步回写 kv（失败不影响 UI）；
 * - 通道：优先 /api/translate/translate（server 代理，百度）；未配置密钥时
 *   自动降级 cap.ai.chat 让 AI 翻（质量更好且零配置）。
 * - 该文件与 translate 插件同 bundle；其它插件不可直接 import（构建隔离），
 *   接入方式见 skill-loader / mcp-bridge 面板内的内联小 hook（同构复刻）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { NS, autoTargetLang, getPanelHostApi } from './index';

const CACHE_KEY = 'desc-cache';
const MEM_MAX = 300;
const memCache = new Map<string, string>();

/** 英文描述判定：无 CJK、含拉丁字母、长度达标 */
export function isEnglishDesc(text: string, minLen = 12): boolean {
  if (!text || text.length < minLen) return false;
  if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(text)) return false;
  return /[a-zA-Z]/.test(text);
}

function memGet(key: string): string | undefined {
  const v = memCache.get(key);
  if (v !== undefined) { memCache.delete(key); memCache.set(key, v); }
  return v;
}
function memPut(key: string, val: string) {
  if (memCache.has(key)) memCache.delete(key);
  memCache.set(key, val);
  const oldest = memCache.keys().next().value;
  if (memCache.size > MEM_MAX && oldest !== undefined) memCache.delete(oldest);
}

async function kvGetCache(): Promise<Record<string, string>> {
  const api = getPanelHostApi();
  if (!api) return {};
  const res = await api.dispatch<{ value?: Record<string, string> | null }>({
    target: 'cap.kv', action: 'get', payload: { namespace: NS, key: CACHE_KEY },
  });
  const v = res.ok ? res.data?.value : null;
  return v && typeof v === 'object' ? v : {};
}

async function kvPutCache(cache: Record<string, string>) {
  const api = getPanelHostApi();
  if (!api) return;
  await api.dispatch({ target: 'cap.kv', action: 'set', payload: { namespace: NS, key: CACHE_KEY, value: cache } });
}

/** AI 降级翻译（cap.ai.chat 一次性，攒流收敛，参照 starter-suggestions requestAiOnce） */
async function aiTranslate(text: string, timeoutMs = 60_000): Promise<string> {
  const api = getPanelHostApi();
  if (!api) throw new Error('宿主 API 未就绪');
  const sessionId = `tr-ai-${Date.now().toString(36)}`;
  const messageId = `tr-msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const prompt =
    '把下面的英文技术描述翻译成简体中文，保留专有名词（如 MCP、skill、API、server 名）英文，' +
    '只输出译文本身，不要任何解释：\n' + text;
  return new Promise<string>((resolve, reject) => {
    let out = '';
    let settled = false;
    let off: () => void = () => undefined;
    const finishOk = () => { if (!settled) { settled = true; clearTimeout(timer); off(); resolve(out.trim()); } };
    const finishFail = (m: string) => { if (!settled) { settled = true; clearTimeout(timer); off(); reject(new Error(m)); } };
    const timer = setTimeout(() => finishFail('AI 翻译超时'), timeoutMs);
    off = api.listen('cap.ai.chat:event', (raw) => {
      const ev = (raw ?? {}) as { kind?: string; payload?: { sessionId?: string; messageId?: string; delta?: string; message?: string } };
      const inner = ev.payload ?? {};
      if (inner.sessionId && inner.sessionId !== sessionId) return;
      if (inner.messageId && inner.messageId !== messageId) return;
      if (ev.kind === 'message.delta' && inner.delta) out += inner.delta;
      else if (ev.kind === 'message.reasoning' || ev.kind === 'tool.card' || ev.kind === 'tool.result') { /* 跳过 */ }
      else if (ev.kind === 'loop.done' || ev.kind === 'message.done') finishOk();
      else if (ev.kind === 'stream.error') finishFail(inner.message ?? 'AI 翻译失败');
    });
    void api.dispatch({ target: 'cap.ai.chat', action: 'start', payload: { sessionId, messageId, prompt, history: [] } })
      .catch((e: unknown) => finishFail(e instanceof Error ? e.message : String(e)));
  });
}

/**
 * 单条描述自动翻译。
 * 返回 { need, translated, loading, translate }；translate() 幂等（成功后不再重复请求）。
 */
export function useAutoTranslate(text: string) {
  const [translated, setTranslated] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inflight = useRef(false);
  const need = isEnglishDesc(text);

  useEffect(() => {
    // 卸载安全：仅 setState 于挂载期
    let alive = true;
    if (need && translated === null) {
      const hit = memGet(text);
      if (hit) { if (alive) setTranslated(hit); return () => { alive = false; }; }
      void (async () => {
        const cache = await kvGetCache();
        const hitKv = cache[text];
        if (hitKv) { memPut(text, hitKv); if (alive) setTranslated(hitKv); }
      })();
    }
    return () => { alive = false; };
  }, [need, text, translated]);

  const translate = useCallback(async () => {
    if (!need || inflight.current) return;
    const hit = memGet(text);
    if (hit) { setTranslated(hit); return; }
    inflight.current = true;
    setLoading(true);
    try {
      let result = '';
      try {
        const to = autoTargetLang(text); // 英文 → zh
        const res = await fetch('/api/translate/translate', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, to }),
        });
        const j = (await res.json()) as { ok: boolean; result?: string; error?: string };
        if (!j.ok) throw new Error(j.error ?? '翻译失败');
        result = j.result ?? '';
      } catch {
        result = await aiTranslate(text); // 百度未配置/失败 → AI 降级
      }
      if (result) {
        memPut(text, result);
        setTranslated(result);
        void (async () => {
          try { const c = await kvGetCache(); c[text] = result; await kvPutCache(c); } catch { /* 缓存失败忽略 */ }
        })();
      }
    } finally {
      inflight.current = false;
      setLoading(false);
    }
  }, [need, text]);

  return { need, translated, loading, translate };
}
