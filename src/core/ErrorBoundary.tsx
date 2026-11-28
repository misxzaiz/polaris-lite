/**
 * 通用渲染错误边界（P0 同类渲染崩溃审计 · 六层保底的宿主层实施，2026-11-28）。
 *
 * 背景：宿主此前零边界零全局监听——任意插件面板/根布局渲染抛错直接白屏整页
 * （chat-lite 的 MessageBoundary 只保住了消息流）。本组件提供三个粒度：
 * - app：根装配（SlotLayout 崩了给可读兜底 + 重载，不再纯白）；
 * - panel：单个插件面板（SlotEntryView 统一包裹）——一个面板中毒只降级该面板，
 *   其余面板与壳层照常；
 * - inline：消息流里的单张工具卡（BlockGroup CardShim）——一张毒卡只降级一张卡，
 *   不再拖垮整条消息。
 *
 * 设计约束：宿主核心零插件引用（arch 门禁）；纯 class 组件 + 内联样式，
 * 不依赖任何 CSS 文件/插件 token（崩溃场景下插件 CSS 可能正是元凶）。
 * componentDidCatch 只 console 留底，不上报（本应用无遥测管道）。
 */
import { Component } from 'react';
import { pushNotice } from './shellState';

interface Props {
  variant?: 'app' | 'panel' | 'inline';
  /** 展示用标签（如插件 id/面板名），帮助定位是哪个子树崩了 */
  label?: string;
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: unknown): void {
    // eslint-disable-next-line no-console -- 崩溃留底是本组件的职责之一
    console.error(`[polaris-lite] 渲染错误已隔离（${this.props.variant ?? 'panel'}：${this.props.label ?? '?'}）:`, error, info);
  }

  private readonly reset = (): void => {
    this.setState({ error: null });
  };

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    const variant = this.props.variant ?? 'panel';
    const label = this.props.label ? `（${this.props.label}）` : '';
    if (variant === 'inline') {
      return (
        <div
          role="alert"
          data-testid="render-error-inline"
          style={{
            fontSize: 12,
            color: 'var(--plite-danger, #c0392b)',
            opacity: 0.85,
            padding: '2px 0',
            wordBreak: 'break-all',
          }}
        >
          工具卡渲染出错，已跳过{label}
        </div>
      );
    }
    const isApp = variant === 'app';
    return (
      <div
        role="alert"
        data-testid="render-error-boundary"
        style={{
          minHeight: isApp ? '60vh' : 120,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 10,
          padding: 24,
          boxSizing: 'border-box',
          color: 'var(--plite-fg, #1a1a1a)',
          fontSize: 13,
          textAlign: 'center',
        }}
      >
        <div style={{ fontWeight: 600, fontSize: 14 }}>
          {isApp ? '界面渲染出错' : '该面板渲染出错'}，其余部分不受影响{label}
        </div>
        <div style={{ color: 'var(--plite-fg-dim, #888)', maxWidth: 560, wordBreak: 'break-all' }}>
          {error.message}
        </div>
        <button
          type="button"
          onClick={isApp ? () => window.location.reload() : this.reset}
          style={{
            padding: '7px 18px',
            border: '1px solid var(--plite-border, #d8d8d8)',
            borderRadius: 8,
            background: 'transparent',
            color: 'inherit',
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          {isApp ? '重新加载' : '重试'}
        </button>
      </div>
    );
  }
}

/**
 * 全局运行时错误监听（window error / unhandledrejection）：只 console 留底 +
 * 通知中心 toast（pushNotice 自带「没人消费就只 console」的降级），不抛、不阻断。
 * 作用：React 边界之外的异步错误（事件回调/微任务）此前完全无痕。
 */
export function installGlobalErrorListeners(): void {
  if (typeof window === 'undefined') return;
  let lastNoticeAt = 0; // 同类错误风暴节流（30s 内最多一条 toast）
  const notice = (title: string, line: string): void => {
    const now = Date.now();
    if (now - lastNoticeAt < 30_000) return;
    lastNoticeAt = now;
    try { pushNotice(title, [line]); } catch { /* 通知通道未就绪时只 console */ }
  };
  window.addEventListener('error', (e) => {
    // 资源加载失败（img/script）也走这里，但无 error 对象细节——区分标记
    const msg = e.message || `${(e.target as HTMLElement)?.tagName ?? 'resource'} 资源加载失败`;
    // eslint-disable-next-line no-console
    console.error('[polaris-lite] window.error:', msg, e.error ?? '');
    notice('运行时错误', msg.slice(0, 200));
  });
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason instanceof Error ? `${e.reason.name}: ${e.reason.message}` : String(e.reason ?? '');
    // eslint-disable-next-line no-console
    console.error('[polaris-lite] unhandledrejection:', reason);
    notice('异步任务错误', reason.slice(0, 200));
  });
}
