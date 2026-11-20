/**
 * 会话隐形滑切手势 v4（评审定案：不流畅 + 输入框漂移 + 有时划了无效）。
 *
 * v4 相对 v3 的三处根治：
 * - **不再位移输入条**：v3 的 translateX(dx/3) 阻尼跟随是「漂移」观感的根源（回弹时序
 *   与 rAF 刷新还会让它停偏）。v4 改为输入条上缘一条 2px 方向进度线（width % 驱动），
 *   零位移、零漂移；
 * - **切换不依赖任何 setState**：pointermove 里同步计算并直接 setActive（v3 的
 *   rAF→setState→指示器链路在部分环境丢帧 = 「不流畅」+「有时划了无效」）。setState
 *   只喂指示器展示细节，且降频到每帧一次；
 * - **消除「划了无效」**：判轴从「8px 定终身」改为持续判轴（累计 24px 前可修正方向）；
 *   阈值从按下点连续累计（不再抓取后 originX 归零重算——那会让小步滑永远差一点）；
 *   到头侧不再静默：指示器显示「没有更多会话」+ 输入条 3px 边界推压。
 *
 * 不变量：切换复用 setActive（草稿/队列/流式按 sessionId 寻址，滑切不丢数据）；
 * 到头即停；多会话才启用；Alt+←/→/N 快捷键并存。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSessionStore } from './store';

/** 触发阈值（px）：从按下点连续累计，越过即切 */
const SWIPE_THRESHOLD = 36;
/** 轴向判定窗口：累计位移超过它之后方向锁定（之前可修正） */
const AXIS_WINDOW = 24;
/** 方向判定：横向位移须大于纵向 2 倍 */
const AXIS_RATIO = 2;

/** 手势对外反馈（会话指示器联动） */
export interface SwipeFeedback {
  /** 手势进行中（已过抓取阈值） */
  swiping: boolean;
  /** 滑动方向：prev=向右滑（更旧）/ next=向左滑（更新） */
  direction: 'prev' | 'next' | null;
  /** -1~1：滑动进度（负=向左=next） */
  progress: number;
  /** 当前激活会话序号（0=最新）与总数 */
  index: number;
  count: number;
  /** 到头仍在划 */
  atEdge: boolean;
}

const IDLE: SwipeFeedback = {
  swiping: false, direction: null, progress: 0, index: 0, count: 0, atEdge: false,
};

export function useSessionSwipe() {
  const [feedback, setFeedback] = useState<SwipeFeedback>(IDLE);
  /** 手势可变量全收 ref：pointermove 高频，绝不进 React 状态 */
  const gesture = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    grabbed: boolean;
    switched: boolean;
  } | null>(null);
  const rafRef = useRef<number | null>(null);
  const pending = useRef<SwipeFeedback>(IDLE);
  /** 抓取成功即置位：拦掉随之而来的 click（按住发送钮横划不误发） */
  const swallowClick = useRef(false);

  /** 指示器展示细节降频刷新（rAF）：切换本身不走这里，丢帧只影响显示不影响功能 */
  const flush = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      setFeedback({ ...pending.current });
    });
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    gesture.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      grabbed: false,
      switched: false,
    };
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const g = gesture.current;
      if (!g || e.pointerId !== g.pointerId) return;
      const dx = e.clientX - g.startX;
      const dy = e.clientY - g.startY;

      if (!g.grabbed) {
        // 持续判轴：AXIS_WINDOW 内可修正方向；纵向先占优则交还原生行为（滚动/选择）
        if (Math.abs(dx) < AXIS_WINDOW && Math.abs(dy) < AXIS_WINDOW) return;
        if (Math.abs(dy) > Math.abs(dx) * AXIS_RATIO) {
          gesture.current = null;
          return;
        }
        g.grabbed = true;
        swallowClick.current = true; // 手势成立：拦掉随之而来的 click
        e.preventDefault();
      }
      e.preventDefault();

      const st = useSessionStore.getState();
      const idx = st.sessions.findIndex((s) => s.id === st.activeId);
      if (idx < 0 || st.sessions.length < 2) {
        gesture.current = null;
        pending.current = IDLE;
        flush();
        return;
      }
      const dir: 'prev' | 'next' = dx < 0 ? 'next' : 'prev';
      const canSwipe = dir === 'next' ? idx > 0 : idx < st.sessions.length - 1;

      // 越过阈值 → **同步直接切换**（不进 setState 链路，杜绝「划了没跟上」）；
      // switched 锁保证一次长划只切一次，想连切继续拖即可
      if (!g.switched && canSwipe && Math.abs(dx) >= SWIPE_THRESHOLD) {
        const target = st.sessions[dir === 'next' ? idx - 1 : idx + 1];
        if (target) {
          st.setActive(target.id);
          g.switched = true;
        }
      }

      // 指示器展示：进度、方向、到头（切换已同步完成，这里只管显示）
      const progress = Math.max(-1, Math.min(1, Math.abs(dx) / SWIPE_THRESHOLD)) * (dir === 'next' ? -1 : 1);
      pending.current = {
        swiping: true,
        direction: dir,
        progress: canSwipe ? progress : 0,
        index: idx,
        count: st.sessions.length,
        atEdge: !canSwipe,
      };
      flush();
    },
    [flush],
  );

  const finish = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const g = gesture.current;
      gesture.current = null;
      if (!g || e.pointerId !== g.pointerId) return;
      pending.current = IDLE;
      flush();
    },
    [flush],
  );

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => finish(e), [finish]);
  const onPointerCancel = useCallback((e: React.PointerEvent<HTMLDivElement>) => finish(e), [finish]);

  // 手势抓取过就吞掉随之而来的 click（一次性，capture 阶段）：按住发送/附件按钮横划时，
  // 松手不应触发点击语义。不依赖 React 状态。
  useEffect(() => {
    const swallow = (e: MouseEvent) => {
      if (!swallowClick.current) return;
      swallowClick.current = false;
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener('click', swallow, true);
    return () => document.removeEventListener('click', swallow, true);
  }, []);

  useEffect(() => () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
  }, []);

  return {
    swipeProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onPointerLeave: onPointerCancel,
      'data-swiping': feedback.swiping ? 'true' : undefined,
      'data-swipe-edge': feedback.swiping && feedback.atEdge ? 'true' : undefined,
      'data-swipe-dir': feedback.swiping ? (feedback.direction ?? undefined) : undefined,
      'data-swipe-armed': feedback.swiping && Math.abs(feedback.progress) >= 1 ? 'true' : undefined,
      style: {
        // 进度线长度（CSS ::after 消费）；不再位移输入条本体（漂移根源已移除）
        '--swipe-progress': feedback.swiping ? Math.abs(feedback.progress).toFixed(3) : '0',
      } as React.CSSProperties,
    },
    feedback,
  };
}
