/**
 * 对话内预览卡片（html-preview 渲染器；chat-lite artifact 块经
 * CHANNEL_ARTIFACT_RENDERERS(@sdk) 查表渲染本组件）。
 *
 * 卡片结构：标题栏（AI 生成徽标 + 标题 + 版本 + 操作钮[全屏/展开]）+ 沙箱 iframe。
 * iframe 源是 /api/preview/:id/raw（服务端 CSP sandbox 头 + 本组件 sandbox 属性双保险）。
 *
 * 全屏方案：**浏览器原生 requestFullscreen()**——盖满整个应用视口（顶栏/tab/侧栏/
 * 输入区全部遮住），卡片容器（标题栏 + iframe）成为全屏层，顶行自然保留
 * 「退出全屏」按钮。要点：
 * - iframe 原元素参与全屏，**零重载**（reparent/portal 都会让 iframe 重启丢
 *   游戏进度——原版 interactive-component 双实例的病根）；
 * - DOM 全屏是浏览器协议而非 CSS 样式逃逸——插件 CSS 门禁禁 position:fixed
 *   （防插件盖宿主层），原生全屏不在其列；全屏层自带 `:fullscreen` 伪类样式；
 * - 进入/退出双向同步：按钮进、Esc/浏览器菜单退（fullscreenchange 监听统一收口，
 *   React 状态不与浏览器脱节）。
 * - 移动端朝向：安卓浏览器进全屏常被当成「看视频」强制转横屏，进全屏后用 Screen
 *   Orientation API 锁回点击那一刻的朝向（见 fullscreen.ts），退出时解锁。
 */
import { useEffect, useRef, useState } from 'react';
import { enterFullscreenKeepingOrientation, exitFullscreenAndUnlock, releaseOrientationLock } from './fullscreen';

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

  // 全屏状态以浏览器为单一事实源：进入 = 容器 requestFullscreen()；
  // 退出（Esc / 浏览器菜单 / 按钮）都经 fullscreenchange 收敛回 React。
  useEffect(() => {
    const onFsChange = () => {
      setFullscreen(document.fullscreenElement === boxRef.current);
      // Esc / 浏览器返回退出全屏时也释放方向锁，避免退出后页面被钉死在某个朝向
      if (!document.fullscreenElement) releaseOrientationLock();
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  // 移动端：浏览器进全屏常把屏幕强制转成横屏，这里在进全屏后按「点击时的朝向」锁回去
  const enterFullscreen = (): void => {
    void enterFullscreenKeepingOrientation(boxRef.current);
  };

  const exitFullscreen = (): void => {
    exitFullscreenAndUnlock();
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
      className={`hp-card ${expanded ? 'hp-expanded' : ''} ${fullscreen ? 'hp-is-fullscreen' : ''}`}
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
