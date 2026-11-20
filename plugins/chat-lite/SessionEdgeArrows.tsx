/**
 * 输入条左右边缘的小悬浮箭头（chat-input-session-nav-plan 评审补充）。
 *
 * 背景：隐形滑切手势「不知道往哪儿划、何时生效」——可发现性缺口。左右两枚
 * 半透明小箭头补三件事：发现性（知道能切）、反馈（知道划没划生效）、边界（到头）。
 *
 * 克制原则：不新增输入条高度（绝对定位于两侧留白），平时低透明度不抢眼；
 * 手势滑动时对应方向箭头高亮（手势可视化）；到头侧禁用（更淡）。
 * 点击即切（桌面主路径，不依赖手势）；Alt+←/→ 与滑动手势并存互为兜底。
 */
import { useCallback } from 'react';
import { useSessionStore } from './store';
import { neighbors } from './session-nav';
import type { SwipeFeedback } from './useSessionSwipe';

function Chevron({ dir }: { dir: 'left' | 'right' }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" width="15" height="15" aria-hidden="true">
      <path
        d={dir === 'left' ? 'M14.5 5.5L8 12l6.5 6.5' : 'M9.5 5.5L16 12l-6.5 6.5'}
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function SessionEdgeArrows({ swipe }: { swipe: SwipeFeedback }) {
  const sessions = useSessionStore((s) => s.sessions);
  const activeId = useSessionStore((s) => s.activeId);
  const setActive = useSessionStore((s) => s.setActive);
  const nav = neighbors(sessions, activeId);

  const go = useCallback(
    (id: string | null) => {
      if (!id) return;
      setActive(id);
    },
    [setActive],
  );

  // 单会话/无会话：没有可切的对象，箭头整体不渲染
  if (sessions.length < 2 || !activeId) return null;

  // 手势联动：滑动中且过抓取阈值后，高亮滑动方向一侧；到头侧保持禁用
  const highlightLeft = swipe.swiping && swipe.direction === 'prev' && swipe.armed;
  const highlightRight = swipe.swiping && swipe.direction === 'next' && swipe.armed;

  return (
    <>
      <button
        type="button"
        className={[
          'chat-edge-arrow chat-edge-arrow-left',
          highlightLeft ? 'hot' : '',
          !nav.canPrev ? 'exhausted' : '',
        ].join(' ').trim()}
        onClick={() => go(nav.prev)}
        disabled={!nav.canPrev}
        aria-label="上一个会话"
        title="上一个会话（Alt+← 或在输入条上右滑）"
      >
        <Chevron dir="left" />
      </button>
      <button
        type="button"
        className={[
          'chat-edge-arrow chat-edge-arrow-right',
          highlightRight ? 'hot' : '',
          !nav.canNext ? 'exhausted' : '',
        ].join(' ').trim()}
        onClick={() => go(nav.next)}
        disabled={!nav.canNext}
        aria-label="下一个会话"
        title="下一个会话（Alt+→ 或在输入条上左滑）"
      >
        <Chevron dir="right" />
      </button>
    </>
  );
}
