/**
 * 预览面板（panel 槽）：应用架——列出落盘的 AI 生成预览，点击运行，可全屏。
 *
 * 与原版 interactive-component 的「window 全局会话内共享」不同，这里数据源是
 * GET /api/preview/list（服务端落盘目录实读）——刷新/跨会话不丢。
 * 实时刷新：AI 每次 render 落盘后，index.ts 会派发 hp-previews-changed
 * （插件内 window 事件），本组件监听后重拉列表——面板打开时新增即刻可见。
 *
 * 容器适配：panel 槽的 .slot 是内容高容器（宿主 flex:0 1 auto，无 stretch 规则），
 * height:100% 会塌成 0——正常态给运行区一个视口自适应的固定高度；
 * 全屏态 reparent 到 .slot-tabpanel（满高 positioned 祖先，见 panel.css 注释）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

interface PreviewItem {
  previewId: string;
  title: string;
  version: number;
  versionLabel: string;
  createdAt: string;
}

export function HtmlPreviewPanel() {
  const [items, setItems] = useState<PreviewItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const resp = await fetch('/api/preview/list?limit=100', { credentials: 'include' });
      if (!resp.ok) { setItems([]); return; }
      const json = (await resp.json()) as { previews?: PreviewItem[] };
      setItems(json.previews ?? []);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // 实时刷新：AI render 落盘 → hp-previews-changed → 重拉列表。
  // 懒挂载下面板可能尚未在 DOM（display:none 的 tabpanel 内）——刷新仍执行，
  // React 状态更新后用户切过来即见最新数据。
  useEffect(() => {
    const onChange = () => { void refresh(); };
    window.addEventListener('hp-previews-changed', onChange);
    return () => window.removeEventListener('hp-previews-changed', onChange);
  }, [refresh]);

  const current = items.find((i) => i.previewId === selected) ?? items[0] ?? null;

  // 全屏（面板侧）：reparent 到最近的满高 positioned 祖先（.slot-tabpanel）。
  // 原因：面板槽的 .slot 是内容高，absolute inset:0 只能盖到内容范围；
  // .slot-tabpanel（tabpanel 主体）满高。面板 iframe 是「点开才运行」的容器，
  // reparent 重载可接受（对话卡片才是保活优先场景，那边维持原地不 reparent）。
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    if (fullscreen) {
      const host = box.closest('.slot-tabpanel') as HTMLElement | null;
      const restoreTo = box.parentElement;
      if (host && restoreTo) {
        box.classList.add('hp-fullscreen');
        host.appendChild(box);
        const onKey = (e: KeyboardEvent) => {
          if (e.key === 'Escape') setFullscreen(false);
        };
        document.addEventListener('keydown', onKey);
        return () => {
          document.removeEventListener('keydown', onKey);
          box.classList.remove('hp-fullscreen');
          restoreTo.appendChild(box);
        };
      }
      setFullscreen(false); // 找不到挂载点：回退非全屏，避免状态与视觉脱节
    }
  }, [fullscreen]);

  return (
    <div ref={boxRef} className="hp-panel cap-panel html-preview" data-testid="html-preview">
      <div className="hp-panel-head">
        <span className="hp-panel-title">预览应用架</span>
        <span className="hp-panel-meta">{items.length ? `${items.length} 个` : ''}</span>
        <button type="button" className="hp-btn" onClick={() => void refresh()}>刷新</button>
        {current ? (
          <button type="button" className="hp-btn" onClick={() => setFullscreen(!fullscreen)}>
            {fullscreen ? '退出全屏' : '全屏运行'}
          </button>
        ) : null}
      </div>
      {loading ? (
        <div className="hp-panel-empty">加载中</div>
      ) : items.length === 0 ? (
        <div className="hp-panel-empty">
          <div className="hp-panel-empty-title">预览应用架</div>
          <div className="hp-panel-empty-hint">
            在对话中让 AI 用 render 工具生成一个 HTML 页面（小游戏、原型、教具），
            生成后这里就会出现可运行的应用。
          </div>
        </div>
      ) : (
        <div className="hp-panel-body">
          <div className="hp-panel-list">
            {items.map((it) => (
              <button
                key={it.previewId}
                type="button"
                className={`hp-panel-item ${current?.previewId === it.previewId ? 'active' : ''}`}
                onClick={() => setSelected(it.previewId)}
                title={it.title}
              >
                <span className="hp-panel-item-title">{it.title}</span>
                <span className="hp-panel-item-ver">{it.versionLabel}</span>
              </button>
            ))}
          </div>
          <div className="hp-panel-run">
            {current ? (
              <iframe
                title={current.title}
                src={`/api/preview/${current.previewId}/raw`}
                sandbox="allow-scripts allow-forms allow-pointer-lock"
                allow="autoplay"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="hp-panel-empty">选择左侧应用运行</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
