/**
 * 会话隐形滑切手势（chat-input-session-nav-plan 补充定案：输入条横向滑动切会话）。
 *
 * 设计（零常驻 UI，动作即手势）：
 * - 起手区：输入条内**非 textarea** 区域（按钮行/附件条/内衬空隙）。textarea 命中不触发——
 *   保护打字、光标与文本选择；
 * - 判定：横向位移 ≥ SWIPE_THRESHOLD 且 |dx| > 2|dy|（斜划不误触）；位移 >6px 即进入
 *   手势态并吞掉后续 click（防「按住发送按钮横划」先触发发送）；
 * - 跟随：滑动中 bar translateX(dx/3)（阻尼，上限 ±MAX_FOLLOW）；松手未过阈值回弹；
 * - 方向：向左滑 = 下一个（更新），向右滑 = 上一个（更旧）；到头即停：边缘会话阻尼加倍
 *   且不切换；
 * - 切换复用 setActive：草稿/队列/流式按 sessionId 寻址，滑切不丢数据。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSessionStore } from './store';

/** 触发阈值（px）：约输入条宽 1/7，短划不误触 */
const SWIPE_THRESHOLD = 56;
/** 进入手势态的最小位移：超过它就吞 click、进入跟随 */
const GRAB_THRESHOLD = 6;
/** 方向判定：横向位移须大于纵向 2 倍 */
const AXIS_RATIO = 2;
/** 跟随位移上限（px）：视觉提示而非拖走整个输入条 */
const MAX_FOLLOW = 18;

export interface SwipeState {
  /** 滑动跟随中的横向偏移（渲染为 translateX） */
  dx: number;
  /** 是否处于拖拽手势中（回弹动画关闭） */
  dragging: boolean;
  /** 到头仍在划（边界提示） */
  atEdge: boolean;
}

export function useSessionSwipe(textareaRef: React.RefObject<HTMLTextAreaElement | null>) {
  const [state, setState] = useState<SwipeState>({ dx: 0, dragging: false, atEdge: false });
  /** 手势会话内所有可变量收进 ref：pointermove 高频，不进 React 状态 */
  const gesture = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    grabbed: boolean;
    atEdge: boolean;
  } | null>(null);
  const rafRef = useRef<number | null>(null);
  const pendingDx = useRef(0);

  const setFollow = useCallback((dx: number, dragging: boolean, atEdge: boolean) => {
    pendingDx.current = dx;
    if (rafRef.current !== null) return;
    // rAF 合并高频 pointermove 的 setState；rAF 不可用（后台冻结）时退化为直写
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      setState({ dx: pendingDx.current, dragging, atEdge });
    });
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // textarea 上不起手：打字/光标/文本选择优先
      if (textareaRef.current?.contains(e.target as Node)) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      gesture.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, grabbed: false, atEdge: false };
    },
    [textareaRef],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const g = gesture.current;
      if (!g || e.pointerId !== g.pointerId) return;
      const dx = e.clientX - g.startX;
      const dy = e.clientY - g.startY;

      if (!g.grabbed) {
        // 未过抓取阈值前不定向：超过 6px 且横向占优才进入手势
        if (Math.abs(dx) < GRAB_THRESHOLD) return;
        if (Math.abs(dx) <= Math.abs(dy) * AXIS_RATIO) {
          gesture.current = null; // 纵向为主：不是横划，放手
          return;
        }
        g.grabbed = true;
        e.preventDefault();
      }
      e.preventDefault();

      const st = useSessionStore.getState();
      const idx = st.sessions.findIndex((s) => s.id === st.activeId);
      if (idx < 0 || st.sessions.length < 2) {
        gesture.current = null;
        setFollow(0, false, false);
        return;
      }
      // 向左滑（dx<0）= 下一个 = 下标-1；向右滑 = 上一个 = 下标+1
      const canSwipe = dx < 0 ? idx > 0 : idx < st.sessions.length - 1;
      g.atEdge = !canSwipe;
      // 阻尼跟随；到头时阻尼加倍（更「黏」），提示没有更多
      const damp = canSwipe ? 3 : 6;
      const follow = Math.max(-MAX_FOLLOW, Math.min(MAX_FOLLOW, dx / damp));
      setFollow(follow, true, g.atEdge);
    },
    [setFollow],
  );

  const finish = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, committed: boolean) => {
      const g = gesture.current;
      gesture.current = null;
      if (!g || e.pointerId !== g.pointerId) return;
      const dx = e.clientX - g.startX;
      const dy = e.clientY - g.startY;
      const passed = g.grabbed && Math.abs(dx) >= SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy) * AXIS_RATIO;
      if (committed && passed) {
        const st = useSessionStore.getState();
        const idx = st.sessions.findIndex((s) => s.id === st.activeId);
        const target = st.sessions[dx < 0 ? idx - 1 : idx + 1];
        if (target) st.setActive(target.id); // 切换后焦点不抢：用户手上还有后续动作
      }
      setFollow(0, false, false);
    },
    [setFollow],
  );

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => finish(e, true), [finish]);
  const onPointerCancel = useCallback((e: React.PointerEvent<HTMLDivElement>) => finish(e, false), [finish]);

  // 手势态下吞掉 click：按住按钮行横划时，松手不应触发发送/附件等点击语义。
  // capture 阶段拦截 + preventDefault/stopPropagation，手势结束即恢复。
  useEffect(() => {
    if (!state.dragging) return;
    const swallow = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener('click', swallow, true);
    return () => document.removeEventListener('click', swallow, true);
  }, [state.dragging]);

  useEffect(() => () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
  }, []);

  return {
    swipeProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      'data-swiping': state.dragging ? 'true' : undefined,
      'data-swipe-edge': state.dragging && state.atEdge ? 'true' : undefined,
      style: {
        transform: state.dx !== 0 ? `translateX(${state.dx.toFixed(1)}px)` : undefined,
        transition: state.dragging ? 'none' : 'transform 160ms var(--plite-ease, ease-out)',
      } as React.CSSProperties,
    },
    swiping: state.dragging,
  };
}
