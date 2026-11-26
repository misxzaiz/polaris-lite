/**
 * 对话内预览卡片（html-preview 渲染器；chat-lite artifact 块经
 * CHANNEL_ARTIFACT_RENDERERS(@sdk) 查表渲染本组件）。
 *
 * 卡片结构：标题栏（AI 生成徽标 + 标题 + 版本 + 操作钮[全屏/展开]）+ 沙箱 iframe。
 * iframe 源是 /api/preview/:id/raw（服务端 CSP sandbox 头 + 本组件 sandbox 属性双保险）。
 *
 * 全屏方案（2026-11-26 二次重写）：**伪全屏 = Popover top layer**——容器挂
 * popover='manual' + showPopover()，被浏览器提升到所有层叠上下文之上渲染，
 * DOM 原位不动（iframe 零重载，进度不丢）。布局由插件 panel.css 的
 * :popover-open 段负责（撑满视口 + safe-area），锚定/层级交给 top layer。
 * 三个死方案的原因见 fullscreen.ts 头注释（requestFullscreen / 宿主 fixed 层）。
 */
import { useEffect, useRef, useState } from 'react';
import { enterPseudoFullscreen, exitPseudoFullscreen, onPseudoFullscreenChange } from './fullscreen';

export interface PreviewCardProps {
  callId: string;
  title: string;
  data: {
    previewId?: string;
    url?: string;
    versionLabel?: string;
  };
}

export function PreviewCard({ callId, title, data }: PreviewCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  const url = data.url ?? (data.previewId ? `/api/preview/${data.previewId}/raw` : null);

  // 全屏状态经 onPseudoFullscreenChange 订阅伪全屏模块（进入/退出都通知，
  // 覆盖按钮 / Esc / 返回键三条退出路径，React 状态不脱节）。
  useEffect(() => {
    return onPseudoFullscreenChange((el) => setFullscreen(el === boxRef.current));
  }, []);

  // 伪全屏：只挂属性，不动 DOM 结构
  const enterFullscreen = (): void => {
    if (boxRef.current) enterPseudoFullscreen(boxRef.current);
  };

  const exitFullscreen = (): void => {
    exitPseudoFullscreen();
  };

  if (!url) {
    return (
      <div className="hp-card hp-error" data-testid={`hp-${callId}`}>
        <div className="hp-title">预览数据缺失（无 previewId）</div>
      </div>
    );
  }

  return (
    <div
      ref={boxRef}
      className={`hp-card ${expanded ? 'hp-expanded' : ''} ${fullscreen ? 'hp-fullscreen' : ''}`}
      data-call-id={callId}
      data-testid={`hp-${callId}`}
    >
      <div className="hp-bar">
        <span className="hp-chip">AI 生成</span>
        <span className="hp-title">{title}</span>
        {data.versionLabel ? <span className="hp-ver">{data.versionLabel}</span> : null}
        <span className="hp-actions">
          {fullscreen ? (
            <button type="button" className="hp-btn hp-exit" onClick={exitFullscreen}>退出全屏</button>
          ) : (
            <button type="button" className="hp-btn" onClick={enterFullscreen}>全屏</button>
          )}
          {!fullscreen ? (
            <button type="button" className="hp-btn" onClick={() => setExpanded(!expanded)}>
              {expanded ? '收起' : '展开'}
            </button>
          ) : null}
        </span>
      </div>
      <div className="hp-body">
        <iframe
          title={title}
          src={url}
          sandbox="allow-scripts allow-forms allow-pointer-lock"
          allow="autoplay"
          referrerPolicy="no-referrer"
        />
      </div>
    </div>
  );
}
