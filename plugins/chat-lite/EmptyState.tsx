/**
 * 对话空态：两种场景共用一套视觉，靠 variant 区分文案与引导力度。
 *
 * - no-session：全新用户，一句话都还没说（首屏）；
 * - no-message：已点「+ 新会话」，会话存在但还没消息。
 *   这是原实现最尴尬的一屏——侧栏有「新会话 0」，中间却全黑，用户不知道下一步。
 *
 * 快捷建议点击后**填入输入框**而不是直接发送：建议句多数需要改两个字再用，
 * 直接发出去反而要用户先撤回。填入走 index.ts 的 compose 通道，不引入跨组件状态。
 */
import { requestCompose } from './index';

const SUGGESTIONS = [
  '总结一下这段代码的作用',
  '帮我写一个 SQL 查询',
  '解释这个报错信息',
  '把这段话翻译成英文',
];

export function EmptyState({ variant }: { variant: 'no-session' | 'no-message' }) {
  const first = variant === 'no-session';
  return (
    <div className="chat-empty" data-testid={`chat-empty-${variant}`}>
      <div className="chat-empty-logo" aria-hidden="true">◈</div>
      <h2>{first ? 'Polaris Lite' : '开始新的对话'}</h2>
      <p>{first ? '轻量版对话已就绪，试试：' : '输入消息，或从下面挑一个开头：'}</p>
      <div className="chat-empty-chips">
        {SUGGESTIONS.map((s) => (
          <button key={s} className="chat-empty-chip" onClick={() => requestCompose(s)}>
            {s}
          </button>
        ))}
      </div>
      {!first && <span className="chat-empty-hint">也可以从左侧切回之前的会话</span>}
      {first && <div className="chat-empty-lead" aria-hidden="true" />}
    </div>
  );
}
