/**
 * 会话滑动指示器（v3 定案：箭头太远不好用 → 手势为主 + 状态指示）。
 *
 * 只在**滑动进行中**显示，平时完全隐形（零常驻 UI）：告诉用户「正在切、切到第几个、
 * 往哪个方向、还有没有更多」。松手即隐。点击不再承担切换职责（手势 + Alt 快捷键已覆盖）。
 */
import { useSessionStore } from './store';
import type { SwipeFeedback } from './useSessionSwipe';

export function SwipeIndicator({ swipe }: { swipe: SwipeFeedback }) {
  const sessions = useSessionStore((s) => s.sessions);
  const activeId = useSessionStore((s) => s.activeId);

  // 单会话/无会话：无可切对象，不渲染
  if (sessions.length < 2 || !activeId) return null;
  // 只在滑动中显示；松手立即隐去（transition 由 CSS 处理）
  if (!swipe.swiping) return null;

  const index = sessions.findIndex((x) => x.id === activeId);
  const armed = Math.abs(swipe.progress) >= 1;

  // 目标会话标题：滑动方向一侧的相邻会话（到头时无目标，只显示当前位置）
  const targetIndex = swipe.direction === 'next' ? index - 1 : index + 1;
  const target = sessions[targetIndex] ?? null;
  const targetLabel = target
    ? (target.title !== '新会话' ? target.title : (target.messages?.[0]?.content ?? '').slice(0, 18) || '新会话')
    : null;

  return (
    <div className="chat-swipe-indicator" role="status" aria-live="polite">
      <span className="chat-swipe-indicator-count">{index + 1}/{sessions.length}</span>
      <span className="chat-swipe-indicator-title">
        {targetLabel ? (swipe.direction === 'next' ? '→ ' : '← ') + targetLabel : '没有更多会话'}
      </span>
      <span className={`chat-swipe-indicator-dots dir-${swipe.direction ?? 'none'} ${armed ? 'armed' : ''}`} aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <i key={i} className={Math.abs(swipe.progress) * 3 > i ? 'lit' : ''} />
        ))}
      </span>
    </div>
  );
}
