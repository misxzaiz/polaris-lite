/** 对话空态：编辑式欢迎页。建议池随机抽样，点击后仅填入输入框，由用户确认后发送。 */
import { useEffect, useState } from 'react';
import { requestCompose } from './index';
import { ArrowUpRightIcon, PolarisMark, RefreshIcon } from './icons';
import { CATEGORY_LABEL, sampleSuggestions, SUGGESTIONS, type CategoryId, type Suggestion } from './suggestions';
import { SRV } from './serverApi';

/** starter-suggestions 插件写入 kv 的池条目（只取渲染所需字段，其余忽略） */
interface PoolItem {
  label?: unknown;
  prompt?: unknown;
  category?: unknown;
  enabled?: unknown;
  source?: unknown;
}

/** 从 kv 池读取可展示建议；任何异常都回退 null（调用方用内置池兜底） */
async function loadPoolSuggestions(): Promise<{ items: Suggestion[]; builtinEnabled: boolean } | null> {
  try {
    const resp = await fetch(`${SRV.kv}/get?namespace=starter-suggestions&key=pool`, { credentials: 'include' });
    if (!resp.ok) return null;
    const j = (await resp.json()) as { value?: { items?: PoolItem[]; settings?: { builtinEnabled?: boolean } } | null };
    const items = j?.value?.items;
    if (!Array.isArray(items) || items.length === 0) return null;
    const builtinEnabled = j?.value?.settings?.builtinEnabled !== false;
    const out: Suggestion[] = [];
    for (const it of items) {
      if (it?.enabled === false) continue;
      // 池级开关：关闭「应用自带开场白」时过滤内置条目（AI/手动建议不受影响）
      if (!builtinEnabled && it?.source === 'builtin') continue;
      const label = typeof it.label === 'string' ? it.label : '';
      const prompt = typeof it.prompt === 'string' ? it.prompt : '';
      if (!label || !prompt) continue;
      const category = (CATEGORY_LABEL as Record<string, string>)[String(it.category)] ? (it.category as CategoryId) : 'explore';
      out.push({ label, prompt, category });
    }
    return out.length > 0 ? { items: out, builtinEnabled } : null;
  } catch {
    return null;
  }
}

/** no-session 偏「建立惊艳感」，no-message 偏「工作流」。 */
const PREFER: Record<'no-session' | 'no-message', CategoryId[]> = {
  'no-session': ['explore', 'tools', 'play'],
  'no-message': ['code', 'write', 'think'],
};

export function EmptyState({ variant }: { variant: 'no-session' | 'no-message' }) {
  const first = variant === 'no-session';
  // 首帧直接用内置池同步抽样（无闪烁）；kv 池到达后替换为合并池
  const [pool, setPool] = useState<Suggestion[]>(SUGGESTIONS);

  useEffect(() => {
    let alive = true;
    void loadPoolSuggestions().then((remote) => {
      if (alive && remote) setPool(remote.items);
    });
    return () => { alive = false; };
  }, []);

  const [items, setItems] = useState<Suggestion[]>([]);

  useEffect(() => {
    setItems(sampleSuggestions({ count: 4, prefer: PREFER[variant], source: pool }));
  }, [variant, pool]);

  const reshuffle = () => {
    setItems((prev) => sampleSuggestions({ count: 4, prefer: PREFER[variant], exclude: prev.map((s) => s.prompt), source: pool }));
  };

  return (
    <div className="chat-empty" data-testid={`chat-empty-${variant}`}>
      <div className="chat-empty-logo" aria-hidden="true"><PolarisMark size={38} /></div>
      <span className="chat-empty-eyebrow">Polaris · Private Intelligence</span>
      <h2>{first ? '思考，从此刻展开。' : '开启一段新的对话'}</h2>
      <p>{first ? '一个安静、专注的智能工作空间。' : '选择下面的起点，或直接输入你的想法。'}</p>
      <div className="chat-empty-chips">
        {items.map((s, index) => (
          <button key={s.prompt} className="chat-empty-chip" onClick={() => requestCompose(s.prompt)}>
            <span className="chat-empty-chip-index">{String(index + 1).padStart(2, '0')}</span>
            <span className="chat-empty-chip-copy">
              <span className="chat-empty-chip-category">
                <i className={`chat-empty-dot dot-${s.category}`} aria-hidden="true" />
                {CATEGORY_LABEL[s.category]}
              </span>
              <strong>{s.label}</strong>
            </span>
            <ArrowUpRightIcon />
          </button>
        ))}
      </div>
      <div className="chat-empty-foot">
        <button type="button" className="chat-empty-refresh" onClick={reshuffle}>
          <RefreshIcon />
          <span>换一批</span>
        </button>
        <span className="chat-empty-hint">{first ? '你的每一次思考，都值得被认真对待' : '也可以从左侧切回之前的会话'}</span>
      </div>
    </div>
  );
}
