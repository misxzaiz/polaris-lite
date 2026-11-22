/**
 * ShotCard —— 浏览器截图卡片（chat-lite 通用 artifact 块的渲染器）。
 *
 * 登记进 CHANNEL_ARTIFACT_RENDERERS(@sdk)['browser-lite-shot']（index.ts setup 时），
 * chat-lite 只认 {rendererType, callId, title, data} 契约，零 chat-lite 依赖。
 * iframe/img 原素零重载（html-preview PreviewCard 同纪律）。
 */
import { useState } from 'react';

interface ShotData {
  shotId?: string;
  url?: string;
  tabId?: string;
}

export function ShotCard({ title, data }: { callId: string; title: string; data: Record<string, unknown> }) {
  const d = data as ShotData;
  const url = d.url ?? (d.shotId ? `/api/browser/shot/${d.shotId}.jpg` : null);
  const [zoom, setZoom] = useState(false);

  if (!url) {
    return <div className="bl-shot bl-shot-missing">截图引用缺失（插件数据异常）</div>;
  }

  return (
    <div className={`bl-shot${zoom ? ' bl-shot-zoom' : ''}`}>
      <div className="bl-shot-head">
        <span className="bl-shot-badge">AI 截图</span>
        <span className="bl-shot-title">{title}</span>
        <span className="bl-shot-actions">
          <button type="button" className="bl-shot-btn" onClick={() => setZoom(!zoom)}>{zoom ? '收起' : '放大'}</button>
          <a className="bl-shot-btn" href={url} target="_blank" rel="noreferrer">原图</a>
        </span>
      </div>
      <div className="bl-shot-body">
        <img src={url} alt={title} loading="lazy" />
      </div>
    </div>
  );
}
