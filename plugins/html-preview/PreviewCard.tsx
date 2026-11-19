/**
 * 对话内预览卡片（html-preview 渲染器；chat-lite artifact 块经
 * __PLITE_ARTIFACT_RENDERERS__ 查表渲染本组件）。
 *
 * 卡片结构：标题栏（AI 生成徽标 + 标题 + 版本 + 操作钮[展开/全屏]）+ 沙箱 iframe。
 * iframe 源是 /api/preview/:id/raw（服务端 CSP sandbox 头 + 本组件 sandbox 属性双保险）。
 *
 * 全屏方案：**节点原地不动**，卡片容器挂 fixed 全屏类——Chrome 移动 iframe 节点
 * （appendChild/portal）会触发重载丢交互状态（原版 interactive-component 双实例的病根）；
 * lite 消息流无 transform 祖先，fixed 可逃逸 overflow 裁剪，同实例零重载。
 */
import { useEffect, useRef, useState } from 'react';

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

  // 全屏 = 容器加 absolute 全屏类（原地；退出还原）。Esc 辅助出口（焦点在 iframe 内收不到，
  // 顶栏「退出全屏」按钮兜底）。
  //
  // 包含块坑（实测）：.chat-msg 的入场动画 message-enter 是 fill-mode:both——动画
  // 结束后 Chrome 仍保持合成层，computed transform = identity matrix（≠none），
  // 使它成为 absolute 后代的包含块——全屏 inset:0 只盖到消息内容高（44px）。
  // 全屏期间置 .chat-msg 内联 animation:none（动画早已播完，无视觉影响），
  // transform 计算值归 none，包含块恢复为 stream 槽的 .slot（满高）。退出还原。
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    if (fullscreen) {
      const msg = box.closest('.chat-msg') as HTMLElement | null;
      const prevAnim = msg?.style.animation ?? null;
      if (msg) msg.style.animation = 'none';
      box.classList.add('hp-fullscreen');
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') setFullscreen(false);
      };
      document.addEventListener('keydown', onKey);
      return () => {
        document.removeEventListener('keydown', onKey);
        box.classList.remove('hp-fullscreen');
        if (msg) msg.style.animation = prevAnim ?? '';
      };
    }
  }, [fullscreen]);

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
      className={`hp-card ${expanded ? 'hp-expanded' : ''}`}
      data-call-id={callId}
      data-testid={`hp-${callId}`}
    >
      <div className="hp-bar">
        <span className="hp-chip">AI 生成</span>
        <span className="hp-title">{title}</span>
        {data.versionLabel ? <span className="hp-ver">{data.versionLabel}</span> : null}
        <span className="hp-actions">
          <button type="button" className="hp-btn" onClick={() => setFullscreen(!fullscreen)}>
            {fullscreen ? '退出全屏' : '全屏'}
          </button>
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
