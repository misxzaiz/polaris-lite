/**
 * 对话内图片卡 + 全屏查看器（image-push 渲染器；chat-lite artifact 块经
 * CHANNEL_ARTIFACT_RENDERERS(@sdk) 查表渲染本组件）。
 *
 * 全屏方案复用 html-preview 的结论（fullscreen.ts 演进史）：宿主 fixed 层是死方案
 * （.slot 隔离 / transform 劫持 / 门禁禁 fixed / 触摸滚动穿透四坑），用 Popover
 * top layer——`popover='manual'` + showPopover() 提升到所有层叠上下文之上，
 * UA 默认样式自带 position:fixed + inset:0（UA 源不受插件 CSS 门禁约束）。
 *
 * 手势（2026-11-28 经 ego CDP 真实多点触控实测）：
 * - 双指捏合缩放 1–8x，锚点公式 tx = m - w/2 - (m0 - w/2)*k + s*k
 *   （s=手势起始位移；不能回代当前位移，会反馈累积漂移——实测踩过）；
 * - 单指平移；双击 1x 与 2.5x 间切换；关闭按钮 / Esc / Android 返回键先关查看器。
 */
import { useEffect, useRef, useState } from 'react';

export interface ImageCardProps {
  callId: string;
  title: string;
  data: {
    url?: string;
    bytes?: number;
    mime?: string;
  };
}

const MAX_SCALE = 8;
const DBL_TAP_MS = 300;
const DBL_TAP_SCALE = 2.5;

export function ImageCard({ callId, title, data }: ImageCardProps) {
  const url = String(data?.url ?? '');
  const bytes = Number(data?.bytes ?? 0);
  const [open, setOpen] = useState(false);
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const zoomRef = useRef<HTMLDivElement | null>(null);
  const openRef = useRef(false);
  const poppedByBackRef = useRef(false);

  const resetTransform = () => {
    const img = imgRef.current;
    if (img) img.style.transform = 'translate(-50%, -50%) translate(0px, 0px) scale(1)';
    if (zoomRef.current) zoomRef.current.textContent = '';
  };

  const closeViewer = () => {
    const el = viewerRef.current;
    if (el) {
      try { el.hidePopover(); } catch { /* 未显示时幂等容错 */ }
      // 关键：摘除 popover 属性——残留会让 UA 对 [popover] 关闭态的默认样式
      // （position:fixed + inset:0）继续命中（html-preview fullscreen.ts 实测坑）
      el.removeAttribute('popover');
    }
    // Android 返回键路径已经 pop 过栈；× / Esc 路径需要自己弹回
    if (!poppedByBackRef.current && history.state?.pliteImgViewer) history.back();
    poppedByBackRef.current = false;
    openRef.current = false;
    setOpen(false);
    resetTransform();
  };

  const openViewer = () => {
    const el = viewerRef.current;
    if (!el || typeof (el as unknown as { showPopover?: unknown }).showPopover !== 'function') {
      return; // popover 不支持：拒绝进入（对齐 html-preview「点了没反应」防线）
    }
    try {
      el.setAttribute('popover', 'manual');
      el.showPopover();
      history.pushState({ pliteImgViewer: true }, '');
    } catch { /* 已在 top layer 等异常：不翻转状态 */ return; }
    openRef.current = true;
    setOpen(true);
    resetTransform();
  };

  // Esc / Android 返回键收口：popstate 里 finalize（返回键「先关查看器再退页面」）
  useEffect(() => {
    const onPop = () => {
      if (!openRef.current) return;
      poppedByBackRef.current = true;
      closeViewer();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && openRef.current) closeViewer();
    };
    window.addEventListener('popstate', onPop);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 手势：原生监听（passive:false 才能 preventDefault 拦掉页面滚动/整页缩放）
  useEffect(() => {
    if (!open) return;
    const stage = stageRef.current;
    const img = imgRef.current;
    const zoomTag = zoomRef.current;
    if (!stage || !img) return;

    let scale = 1, tx = 0, ty = 0;
    let pinchStartDist = 0, pinchStartScale = 1;
    let pinchStartMid: { x: number; y: number } | null = null;
    let pinchStartOff: { x: number; y: number } | null = null;
    let panStart: { x: number; y: number; tx: number; ty: number } | null = null;
    let lastTapAt = 0;

    const apply = () => {
      img.style.transform = `translate(-50%, -50%) translate(${tx}px, ${ty}px) scale(${scale})`;
      if (zoomTag) zoomTag.textContent = scale > 1.05 ? `${Math.round(scale * 100) / 100}x` : '';
    };
    const dist = (a: Touch, b: Touch) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const mid = (a: Touch, b: Touch) => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });
    const clampZoom = (s: number) => Math.min(MAX_SCALE, Math.max(1, s));

    const onStart = (e: TouchEvent) => {
      e.preventDefault();
      if (e.touches.length === 2) {
        pinchStartDist = dist(e.touches[0], e.touches[1]);
        pinchStartScale = scale;
        pinchStartMid = mid(e.touches[0], e.touches[1]);
        pinchStartOff = { x: tx, y: ty };
        panStart = null;
      } else if (e.touches.length === 1) {
        panStart = { x: e.touches[0].clientX, y: e.touches[0].clientY, tx, ty };
      }
    };
    const onMove = (e: TouchEvent) => {
      e.preventDefault();
      if (e.touches.length === 2 && pinchStartDist > 0 && pinchStartMid && pinchStartOff) {
        const d = dist(e.touches[0], e.touches[1]);
        const m = mid(e.touches[0], e.touches[1]);
        scale = clampZoom(pinchStartScale * d / pinchStartDist);
        // 锚点公式：起始中点下的内容点保持在当前中点下（含手指整体拖动）。
        // tx = m - w/2 - (m0 - w/2)*k + s*k；s 用手势起始位移，回代当前值会漂移。
        const k = scale / pinchStartScale;
        const w2x = window.innerWidth / 2;
        const w2y = window.innerHeight / 2;
        tx = m.x - w2x - (pinchStartMid.x - w2x) * k + pinchStartOff.x * k;
        ty = m.y - w2y - (pinchStartMid.y - w2y) * k + pinchStartOff.y * k;
        apply();
      } else if (e.touches.length === 1 && panStart) {
        tx = panStart.tx + (e.touches[0].clientX - panStart.x);
        ty = panStart.ty + (e.touches[0].clientY - panStart.y);
        apply();
      }
    };
    const onEnd = (e: TouchEvent) => {
      if (e.touches.length === 0) {
        pinchStartDist = 0;
        pinchStartMid = null;
        pinchStartOff = null;
        panStart = null;
        // 双击：1x 与 2.5x 间切换（图片中心为锚，简单可靠）
        const now = Date.now();
        if (now - lastTapAt < DBL_TAP_MS) {
          if (scale > 1.5) { scale = 1; tx = 0; ty = 0; }
          else { scale = DBL_TAP_SCALE; }
          apply();
          lastTapAt = 0;
          return;
        }
        lastTapAt = now;
      }
    };
    stage.addEventListener('touchstart', onStart, { passive: false });
    stage.addEventListener('touchmove', onMove, { passive: false });
    stage.addEventListener('touchend', onEnd);
    return () => {
      stage.removeEventListener('touchstart', onStart);
      stage.removeEventListener('touchmove', onMove);
      stage.removeEventListener('touchend', onEnd);
    };
  }, [open]);

  if (!url) {
    return <div className="ip-missing">图片推送缺少 url（{title}）</div>;
  }
  return (
    <>
      <figure className="ip-card" onClick={openViewer} data-callid={callId}>
        <img src={url} alt={title} loading="lazy" decoding="async" />
        <figcaption className="ip-cap">
          {title}
          {bytes > 0 ? ` · ${Math.round(bytes / 1024)}KB` : ''}
          {' · 点开可放大'}
        </figcaption>
      </figure>
      <div ref={viewerRef} className="ip-viewer" aria-label={title}>
        <div ref={stageRef} className="ip-stage">
          <img ref={imgRef} className="ip-img" src={url} alt={title} decoding="async" />
        </div>
        <button className="ip-close" onClick={closeViewer} aria-label="关闭">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="m6 6 12 12M18 6 6 18" /></svg>
        </button>
        <div ref={zoomRef} className="ip-zoomtag" />
        <div className="ip-title">{title}</div>
      </div>
    </>
  );
}
