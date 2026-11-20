/**
 * 会话切换行（chat-input-session-nav-plan §5.3）：输入条顶部的 ‹ 标题 › 分页器。
 *
 * 只做「相邻快速横跳」：‹ 上一会话（更旧）· 当前标题 · 下一会话（更新）›；
 * 全量浏览/搜索/删除仍归左侧栏，不在这里重复。
 * sessions>1 才渲染——单会话放一个切换器只会让人「按了没反应」。
 * 到头即停不循环：循环会让人迷失「现在在第几个」。
 */
import { useCallback } from 'react';
import { useSessionStore } from './store';
import { neighbors } from './session-nav';

function ChevronIcon({ dir }: { dir: 'left' | 'right' }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" width="14" height="14" aria-hidden="true">
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

export function SessionNav({ onFocusInput }: { onFocusInput: () => void }) {
  const sessions = useSessionStore((s) => s.sessions);
  const activeId = useSessionStore((s) => s.activeId);
  const setActive = useSessionStore((s) => s.setActive);
  const nav = neighbors(sessions, activeId);

  if (!activeId || sessions.length < 2) return null;

  const go = useCallback(
    (id: string | null) => {
      if (!id) return;
      setActive(id);
      // 焦点回输入框：切换会话的意图是「接着在这个会话里说话」
      onFocusInput();
    },
    [setActive, onFocusInput],
  );

  return (
    <div className="chat-session-nav" role="group" aria-label="会话切换">
      <button
        type="button"
        className="chat-session-nav-btn"
        onClick={() => go(nav.prev)}
        disabled={!nav.canPrev}
        aria-label="上一个会话"
        title="上一个会话（Alt+←）"
      >
        <ChevronIcon dir="left" />
      </button>
      <span className={`chat-session-nav-title ${nav.streaming ? 'streaming' : ''}`} title={nav.label}>
        {nav.streaming && <span className="chat-session-nav-dot" aria-hidden="true" />}
        {nav.label}
      </span>
      <button
        type="button"
        className="chat-session-nav-btn"
        onClick={() => go(nav.next)}
        disabled={!nav.canNext}
        aria-label="下一个会话"
        title="下一个会话（Alt+→）"
      >
        <ChevronIcon dir="right" />
      </button>
    </div>
  );
}
