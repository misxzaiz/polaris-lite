/**
 * BrowserPanel —— 浏览器控制台（panel 槽）。
 *
 * 人用与 AI 共用的观察面（spec: docs/browser-lite-plan.md §7）：
 * - 标签列表：全部标签（含无主标签），行 = 标题 + URL + 归属会话徽章（agentKey 前 6 位），
 *   选中高亮，可手动关（panel:closeTab 不做归属校验——人可关任何标签）；
 * - 地址栏：手动打开/导航（panel:navigate，AI 围栏不约束手动动作但审计留痕）；
 * - AI 操作日志：最近动作（经 cap 审计尾部过滤 target=cap.tool.browser）；
 * - screencast 内嵌实时画面：选中标签可展开，250ms 帧轮询 + 鼠标/键盘回传；
 * - 引擎徽章：ready/starting/stopped；停止态给 Chrome 安装指引。
 *
 * 刷新纪律：3s 轮询且仅页面可见时（cap-panel 5s 同款），后台 tab 不空转。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SlotHostApi } from '@sdk';
import { callBrowserApi } from './index';

/** 面板持有的宿主 API（预留：AI 日志经审计尾部时用；当前面板动作全走 /api/browser/*） */
export function setPanelApi(_a: SlotHostApi | null): void { /* reserved */ }

interface TabInfo {
  tabId: string;
  url: string;
  title: string;
  agentKey: string | null;
  lastUsedAt: number;
}

interface StatusInfo {
  engine: 'ready' | 'starting' | 'stopped';
  chromePath: string | null;
  tabs: TabInfo[];
}

/** 内嵌实时视图：screencast 帧轮询 + 鼠标/键盘回传（坐标按帧设备尺寸等比映射） */
function EmbeddedView({ tabId, onGone }: { tabId: string; onGone: () => void }) {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [frameInfo, setFrameInfo] = useState<{ w: number; h: number } | null>(null);
  const seqRef = useRef(0);
  const deadRef = useRef(false);

  useEffect(() => {
    deadRef.current = false;
    let cancelled = false;
    void (async () => {
      try {
        await callBrowserApi('panel:screencastStart', { tabId, quality: 45, maxWidth: 900 });
      } catch { /* 引擎忙时降级：轮询仍会尝试 */ }
      const loop = async () => {
        while (!cancelled && !deadRef.current) {
          try {
            const r = (await callBrowserApi('screencast', { tabId })) as {
              frame?: { data: string; deviceWidth: number; deviceHeight: number } | null;
              seq?: number;
              error?: string;
            };
            if (r.frame && typeof r.seq === 'number' && r.seq > seqRef.current && imgRef.current) {
              seqRef.current = r.seq;
              imgRef.current.src = `data:image/jpeg;base64,${r.frame.data}`;
              setFrameInfo({ w: r.frame.deviceWidth, h: r.frame.deviceHeight });
            }
          } catch { /* 服务暂不可达，下轮重试 */ }
          await new Promise((res) => setTimeout(res, 250));
        }
      };
      void loop();
    })();
    return () => {
      cancelled = true;
      deadRef.current = true;
      void callBrowserApi('panel:screencastStop', { tabId }).catch(() => {});
    };
  }, [tabId, onGone]);

  /** 面板显示坐标 → 页面坐标（按帧 deviceWidth 与显示宽度等比） */
  const toPage = (clientX: number, clientY: number) => {
    const el = imgRef.current;
    if (!el || !frameInfo || !frameInfo.w) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    const sx = frameInfo.w / rect.width;
    const sy = frameInfo.h / rect.height;
    return { x: Math.round((clientX - rect.left) * sx), y: Math.round((clientY - rect.top) * sy) };
  };

  const onMouse = (e: React.MouseEvent, type: 'mousePressed' | 'mouseReleased' | 'mouseMoved') => {
    const { x, y } = toPage(e.clientX, e.clientY);
    void callBrowserApi('panel:inputMouse', { tabId, type, x, y, clickCount: type === 'mousePressed' ? 1 : 0 }).catch(() => {});
  };

  const onWheel = (e: React.WheelEvent) => {
    const { x, y } = toPage(e.clientX, e.clientY);
    void callBrowserApi('panel:inputMouse', { tabId, type: 'mouseWheel', x, y, deltaX: e.deltaX, deltaY: e.deltaY }).catch(() => {});
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { onGone(); return; }
    void callBrowserApi('panel:inputKey', { tabId, type: 'keyDown', key: e.key }).catch(() => {});
  };

  return (
    <div
      className="bl-embed"
      tabIndex={0}
      onMouseMove={(e) => onMouse(e, 'mouseMoved')}
      onMouseDown={(e) => onMouse(e, 'mousePressed')}
      onMouseUp={(e) => onMouse(e, 'mouseReleased')}
      onWheel={onWheel}
      onKeyDown={onKeyDown}
    >
      <img ref={imgRef} alt="browser view" draggable={false} />
      {frameInfo && <span className="bl-embed-meta">{frameInfo.w}×{frameInfo.h}（Esc 收起）</span>}
    </div>
  );
}

export function BrowserPanel() {
  const [status, setStatus] = useState<StatusInfo | null>(null);
  const [addr, setAddr] = useState('');
  const [selTab, setSelTab] = useState<string | null>(null);
  const [embedTab, setEmbedTab] = useState<string | null>(null);
  const [err, setErr] = useState('');

  const refresh = useCallback(async () => {
    try {
      const resp = await fetch('/api/browser/status', { credentials: 'include' });
      if (resp.status === 404) { setStatus(null); setErr('浏览器服务未启用（server 半边缺失或 PLITE_BROWSER=0）'); return; }
      if (!resp.ok) { setErr(`status HTTP ${resp.status}`); return; }
      setStatus((await resp.json()) as StatusInfo);
      setErr('');
    } catch { setErr('status 不可达'); }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 3000);
    return () => clearInterval(timer);
  }, [refresh]);

  const openAddr = async () => {
    const target = addr.trim();
    if (!target) return;
    const r = await callBrowserApi('panel:navigate', { url: target });
    if (!r.ok && r.error) setErr(r.error);
    setAddr('');
    void refresh();
  };

  const closeTab = async (tabId: string) => {
    await callBrowserApi('panel:closeTab', { tabId });
    if (selTab === tabId) { setSelTab(null); setEmbedTab(null); }
    void refresh();
  };

  const tabs = status?.tabs ?? [];
  const engine = status?.engine ?? 'stopped';

  return (
    <div className="bl-root" data-testid="browser-lite">
      <div className="bl-header">
        <input
          className="bl-addr"
          type="text"
          placeholder="输入 URL 或搜索词打开"
          value={addr}
          onChange={(e) => setAddr(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void openAddr(); }}
        />
        <span className={`bl-badge bl-badge-${engine}`} title={status?.chromePath ?? ''}>
          <span className={`bl-dot bl-dot-${engine}`} />
          {engine === 'ready' ? '就绪' : engine === 'starting' ? '启动中' : '未启动'}
        </span>
      </div>

      {err && <div className="bl-err">{err}</div>}

      {engine === 'stopped' && !tabs.length && (
        <div className="bl-guide">
          浏览器引擎未启动。首次使用时 AI 调用 browser 工具或上方地址栏打开网页会自动拉起系统 Chrome。
          未找到 Chrome/Edge 时请设置 <code>BROWSER_LITE_CHROME</code> 环境变量。
        </div>
      )}

      <div className="bl-section">
        <span>打开的标签（{tabs.length}）</span>
        <span className="bl-section-spacer" />
        <button type="button" className="bl-action" onClick={() => { void callBrowserApi('panel:closeAll'); void refresh(); }} disabled={!tabs.length}>
          全部关闭
        </button>
      </div>

      <div className="bl-tabs">
        {tabs.map((t) => (
          <div
            key={t.tabId}
            className={`bl-tab${selTab === t.tabId ? ' bl-tab-on' : ''}`}
            onClick={() => setSelTab(t.tabId)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter') setSelTab(t.tabId); }}
          >
            <div className="bl-tab-main">
              <span className="bl-tab-title">{t.title || '(无标题)'}</span>
              <span className="bl-tab-url">{t.url}</span>
            </div>
            {t.agentKey && <span className="bl-tab-agent" title={`会话 ${t.agentKey}`}>{t.agentKey.slice(0, 6)}</span>}
            <button
              type="button"
              className="bl-tab-close"
              onClick={(e) => { e.stopPropagation(); void closeTab(t.tabId); }}
              aria-label="关闭标签"
            >
              ×
            </button>
          </div>
        ))}
        {!tabs.length && <div className="bl-empty">暂无打开的标签</div>}
      </div>

      {selTab && (
        <div className="bl-section">
          <span>实时画面</span>
          <span className="bl-section-spacer" />
          <button type="button" className="bl-action" onClick={() => setEmbedTab(embedTab ? null : selTab)}>
            {embedTab ? '收起' : '显示'}
          </button>
        </div>
      )}
      {selTab && embedTab === selTab && <EmbeddedView tabId={selTab} onGone={() => setEmbedTab(null)} />}
    </div>
  );
}
