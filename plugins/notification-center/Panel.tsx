/**
 * NotificationPanel：通知中心面板（panel 槽「通知」Tab）。
 *
 * 职责：历史列表（未读高亮）、全部已读、清空；不承载 toast（toast 由 index.tsx 的
 * ToastHost 常驻渲染，与本面板解耦——面板未挂载时通知照样弹）。
 */
import { useEffect, useState } from 'react';
import {
  clearInbox, loadInbox, markAllRead, markRead, subscribe, unreadCount,
  type NotifyItem,
} from './store';

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function Ico({ level }: { level: NotifyItem['level'] }) {
  const common = { viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true as const };
  if (level === 'success') {
    return (
      <svg {...common}><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" /><path d="m8.5 12.2 2.4 2.4 4.6-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
    );
  }
  if (level === 'warn' || level === 'error') {
    return (
      <svg {...common}><path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
    );
  }
  return (
    <svg {...common}><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" /><path d="M12 11v5m0-8h.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
  );
}

export function NotificationPanel() {
  const [items, setItems] = useState<NotifyItem[]>([]);

  useEffect(() => {
    let alive = true;
    const refresh = (): void => {
      void loadInbox().then((list) => {
        if (alive) setItems([...list]);
      });
    };
    refresh();
    const off = subscribe(refresh);
    // 同页 DOM 事件兜底（本插件 emit 时同步派发）
    window.addEventListener('notifications-changed', refresh);
    return () => {
      alive = false;
      off();
      window.removeEventListener('notifications-changed', refresh);
    };
  }, []);

  const unread = unreadCount(items);

  return (
    <div className="nc-panel" data-testid="nc-panel">
      <div className="ncp-toolbar">
        <strong>通知</strong>
        {unread > 0 && <span className="ncp-mark">{unread} 条未读</span>}
        <button
          type="button"
          className="ncp-clear"
          onClick={() => void markAllRead()}
          disabled={unread === 0}
        >
          全部已读
        </button>
        <button type="button" className="ncp-clear" onClick={() => void clearInbox()} disabled={items.length === 0}>
          清空
        </button>
      </div>
      <div className="ncp-list">
        {items.length === 0 ? (
          <div className="ncp-empty">没有通知，一切安静。其他插件经 cap.ui.notify 推送的通知会出现在这里。</div>
        ) : (
          items.map((n) => (
            <button
              key={n.id}
              type="button"
              className={`ncp-item ${n.read ? '' : 'unread'}`}
              data-level={n.level}
              onClick={() => void markRead(n.id)}
              title={n.read ? undefined : '点击标记已读'}
            >
              <span className="ncp-ico"><Ico level={n.level} /></span>
              <span className="ncp-main">
                <span className="ncp-t">{n.title}</span>
                {n.body && <span className="ncp-d">{n.body}</span>}
              </span>
              <span className="ncp-time">{fmtTime(n.at)}</span>
            </button>
          ))
        )}
      </div>
      <div className="ncp-foot">通知经 cap.ui.notify 推送，最近 100 条；点击条目标记已读。</div>
    </div>
  );
}
