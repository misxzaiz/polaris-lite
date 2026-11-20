/** 对话空态：编辑式欢迎页。建议池随机抽样，点击后仅填入输入框，由用户确认后发送。 */
import { useEffect, useState } from 'react';
import { requestCompose } from './index';
import { ArrowUpRightIcon, PolarisMark, RefreshIcon } from './icons';
import { CATEGORY_LABEL, sampleSuggestions, type CategoryId, type Suggestion } from './suggestions';

/** no-session 偏「建立惊艳感」，no-message 偏「工作流」。 */
const PREFER: Record<'no-session' | 'no-message', CategoryId[]> = {
  'no-session': ['explore', 'tools', 'play'],
  'no-message': ['code', 'write', 'think'],
};

export function EmptyState({ variant }: { variant: 'no-session' | 'no-message' }) {
  const first = variant === 'no-session';
  const [items, setItems] = useState<Suggestion[]>([]);

  useEffect(() => {
    setItems(sampleSuggestions({ count: 4, prefer: PREFER[variant] }));
  }, [variant]);

  const reshuffle = () => {
    setItems((prev) => sampleSuggestions({ count: 4, prefer: PREFER[variant], exclude: prev.map((s) => s.prompt) }));
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
