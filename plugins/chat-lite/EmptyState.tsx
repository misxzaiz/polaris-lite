/** 对话空态：编辑式欢迎页，建议仅填入输入框，由用户确认后发送。 */
import { requestCompose } from './index';
import { ArrowUpRightIcon, PolarisMark } from './icons';

const SUGGESTIONS = [
  { prompt: '总结一下这段代码的作用', label: '理解一段代码', category: 'CODE REVIEW' },
  { prompt: '帮我写一个 SQL 查询', label: '构建 SQL 查询', category: 'DATABASE' },
  { prompt: '解释这个报错信息', label: '诊断报错信息', category: 'DEBUGGING' },
  { prompt: '把这段话翻译成英文', label: '翻译一段文字', category: 'TRANSLATION' },
];

export function EmptyState({ variant }: { variant: 'no-session' | 'no-message' }) {
  const first = variant === 'no-session';
  return (
    <div className="chat-empty" data-testid={`chat-empty-${variant}`}>
      <div className="chat-empty-logo" aria-hidden="true"><PolarisMark size={38} /></div>
      <span className="chat-empty-eyebrow">Polaris · Private Intelligence</span>
      <h2>{first ? '思考，从此刻展开。' : '开启一段新的对话'}</h2>
      <p>{first ? '一个安静、专注的智能工作空间。' : '选择下面的起点，或直接输入你的想法。'}</p>
      <div className="chat-empty-chips">
        {SUGGESTIONS.map((s, index) => (
          <button key={s.prompt} className="chat-empty-chip" onClick={() => requestCompose(s.prompt)}>
            <span className="chat-empty-chip-index">{String(index + 1).padStart(2, '0')}</span>
            <span className="chat-empty-chip-copy">
              <span className="chat-empty-chip-category">{s.category}</span>
              <strong>{s.label}</strong>
            </span>
            <ArrowUpRightIcon />
          </button>
        ))}
      </div>
      <span className="chat-empty-hint">{first ? '你的每一次思考，都值得被认真对待' : '也可以从左侧切回之前的会话'}</span>
    </div>
  );
}
