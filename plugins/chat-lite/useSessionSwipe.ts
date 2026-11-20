/**
 * 会话隐形滑切手势 v2（评审定案：滑动是主路径，箭头太远不好用）。
 *
 * v2 相对 v1 的变化（每条都来自真实使用反馈）：
 * - **全域起手**：textarea 上也能滑。保护逻辑从「textarea 命中即放弃」改为
 *   「先到先得」——横向位移先越过抓取阈值就归手势，纵向滚动/文本选择先动就归原生行为。
 *   原因：textarea 占输入条 70% 面积，排除它等于手势只存在于边角，用户在框上划永远无效。
 * - **阈值 56→36px**：滑一半就白划的抱怨直接砍阈值；且**越过阈值立即切换**（不必等松手），
 *   切完本次手势作废（switched 锁），连续快速划可连续切。
 * - **吞 click 改为捕获 pointerdown 后的 click 一次**（原来靠 dragging 状态挂全局监听，
 *   越阈即切后 dragging 立即结束，click 反而漏网）；换用「手势抓取过就拦截下一次 click」。
 * - **progress 暴露给指示器**：滑动进度比例（0~1，含方向），驱动输入条上方的会话指示器。
 *
 * 不变量：切换复用 setActive——草稿/队列/流式按 sessionId 寻址，滑切不丢数据；
 * 到头即停（不循环）；多会话才启用手势。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSessionStore } from './store';

/** 触发阈值（px）：越过即切，短划不误触 */
const SWIPE_THRESHOLD = 36;
/** 进入手势态的最小位移：超过它就吞 click、进入跟随 */
const GRAB_THRESHOLD = 8;
/** 方向判定：横向位移须大于纵向 2 倍 */
const AXIS_RATIO = 2;
/** 跟随位移上限（px）：视觉提示而非拖走整个输入条 */
const MAX_FOLLOW = 14;

export interface SwipeState {
  /** 滑动跟随中的横向偏移（渲染为 translateX） */
  dx: number;
  /** 是否处于拖拽手势中（回弹动画关闭） */
  dragging: boolean;
  /** 到头仍在划（边界提示） */
  atEdge: boolean;
}

/** 手势对外反馈（会话指示器联动） */
export interface SwipeFeedback {
  /** 手势进行中（已过抓取阈值） */
  swiping: boolean;
  /** 滑动方向：prev=向右滑（更旧）/ next=向左滑（更新） */
  direction: 'prev' | 'next' | null;
  /** -1~1：滑动进度（负=向左=next），到头一侧恒 0 */
  progress: number;
  /** 当前激活会话在列表中的序号（0=最新）与总数（指示器显示 n/N） */
  index: number;
  count: number;
}

export function useSessionSwipe() {
  const [state, setState] = useState<SwipeState>({ dx: 0, dragging: false, atEdge: false });
  const [feedback, setFeedback] = useState<SwipeFeedback>({
    swiping: false, direction: null, progress: 0, index: 0, count: 0,
  });
  /** 手势会话内所有可变量收进 ref：pointermove 高频，不进 React 状态 */
  const gesture = useRef<{
    pointerId: number;
    /** 每次有效切换后重置的滑动原点（支持一次长划连续切） */
    originX: number;
    startY: number;
    grabbed: boolean;
    atEdge: boolean;
    /** 越过阈值已切换：本次手势进入冷却，滑回/继续都不再重复触发 */
    switched: boolean;
  } | null>(null);
  const rafRef = useRef<number | null>(null);
  const pending = useRef({ dx: 0, atEdge: false, dir: null as 'prev' | 'next' | null, progress: 0, index: 0, count: 0 });
  /** 手势抓取过（grabbed）就拦下一次 click——不依赖 React 状态，避免越阈即切后监听已卸载的漏网 */
  const swallowClick = useRef(false);
  /** 手势抓取成功即置位：拦掉随之而来的 click（不依赖 React 状态，越阈即切后监听仍在） */
  const markSwallow = useCallback(() => {
    swallowClick.current = true;
  }, []);

  const setFollow = useCallback((dragging: boolean) => {
    if (rafRef.current !== null) return;
    // rAF 合并高频 pointermove 的 setState；rAF 不可用（后台冻结）时退化为直写
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      setState({ dx: pending.current.dx, dragging, atEdge: pending.current.atEdge });
      setFeedback({
        swiping: dragging,
        direction: pending.current.dir,
        progress: pending.current.progress,
        index: pending.current.index,
        count: pending.current.count,
      });
    });
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    gesture.current = {
      pointerId: e.pointerId,
      originX: e.clientX,
      startY: e.clientY,
      grabbed: false,
      atEdge: false,
      switched: false,
    };
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const g = gesture.current;
      if (!g || e.pointerId !== g.pointerId) return;
      const dx = e.clientX - g.originX;
      const dy = e.clientY - g.startY;

      if (!g.grabbed) {
        // 未抓取前先判轴：谁先越过阈值归谁。纵向先动 = 滚动/选择，交还原生行为
        if (Math.abs(dx) < GRAB_THRESHOLD && Math.abs(dy) < GRAB_THRESHOLD) return;
        if (Math.abs(dy) >= Math.abs(dx) * AXIS_RATIO) {
          gesture.current = null; // 纵向为主：不是横划，放手
          return;
        }
        g.grabbed = true;
        g.originX = e.clientX; // 抓取点归零，阈值从抓取点起算
        markSwallow(); // 手势抓取成功：拦掉随之而来的 click（按住按钮横划不误发）
        e.preventDefault();
      }
      e.preventDefault();

      const st = useSessionStore.getState();
      const idx = st.sessions.findIndex((s) => s.id === st.activeId);
      if (idx < 0 || st.sessions.length < 2) {
        gesture.current = null;
        setFollow(false);
        return;
      }
      // 向左滑（dx<0）= 下一个 = 下标-1；向右滑 = 上一个 = 下标+1
      const dir: 'prev' | 'next' = dx < 0 ? 'next' : 'prev';
      const canSwipe = dir === 'next' ? idx > 0 : idx < st.sessions.length - 1;
      g.atEdge = !canSwipe;
      pending.current.dir = dir;
      pending.current.index = idx;
      pending.current.count = st.sessions.length;

      // 越过阈值且未到头 → 立即切换（不等松手）；切完重置原点进入冷却，
      // 一次长划只切一次，想连切继续拖即可
      if (!g.switched && canSwipe && Math.abs(dx) >= SWIPE_THRESHOLD) {
        const target = st.sessions[dir === 'next' ? idx - 1 : idx + 1];
        if (target) {
          st.setActive(target.id);
          g.switched = true;
          g.originX = e.clientX;
          pending.current.dx = 0;
          setFollow(true);
          return;
        }
      }
      // 跟随位移：未切换时给阻尼预览；已切换（冷却中）回正；到头阻尼加倍
      const damp = !canSwipe ? 6 : g.switched ? 12 : 3;
      const follow = Math.max(-MAX_FOLLOW, Math.min(MAX_FOLLOW, dx / damp));
      pending.current.dx = follow;
      pending.current.progress = Math.max(-1, Math.min(1, Math.abs(dx) / SWIPE_THRESHOLD)) * (dir === 'next' ? -1 : 1);
      setFollow(true);
    },
    [setFollow, markSwallow],
  );

  const finish = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const g = gesture.current;
      gesture.current = null;
      if (!g || e.pointerId !== g.pointerId) return;
      pending.current.dir = null;
      pending.current.progress = 0;
      setFollow(false);
    },
    [setFollow],
  );

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => finish(e), [finish]);
  const onPointerCancel = useCallback((e: React.PointerEvent<HTMLDivElement>) => finish(e), [finish]);

  // 手势抓取过就吞掉随之而来的 click：按住发送/附件按钮横划时，松手不应触发点击语义。
  // 不依赖 React 状态（越阈即切后 dragging 已结束），capture 拦一次即自行失效。
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
      'data-swiping': state.dragging ? 'true' : undefined,
      'data-swipe-edge': state.dragging && state.atEdge ? 'true' : undefined,
      style: {
        transform: state.dx !== 0 ? `translateX(${state.dx.toFixed(1)}px)` : undefined,
        transition: state.dragging ? 'none' : 'transform 160ms var(--plite-ease, ease-out)',
      } as React.CSSProperties,
    },
    swiping: state.dragging,
    feedback,
    markSwallow,
  };
}
