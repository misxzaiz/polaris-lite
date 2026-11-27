/**
 * NotificationPanel：通知中心面板（panel 槽「通知」Tab）。
 *
 * 职责：历史列表（未读高亮）、全部已读、清空；不承载 toast（toast 由 index.tsx 的
 * ToastHost 常驻渲染，与本面板解耦——面板未挂载时通知照样弹）。
 */
import { useEffect, useState } from 'react';
import { CHANNEL_SESSION_INTENT } from '@sdk';
import {
  clearInbox, getPrefs, loadInbox, loadPrefs, markAllRead, markRead, savePrefs, subscribe, subscribePrefs, unreadCount,
  type NotifyItem, type NotifyPrefs,
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
  const [prefs, setPrefs] = useState<NotifyPrefs>(() => getPrefs());

  useEffect(() => {
    let alive = true;
    const refresh = (): void => {
      void loadInbox().then((list) => {
        if (alive) setItems([...list]);
      });
    };
    refresh();
    void loadPrefs().then((p) => {
      if (alive) setPrefs({ ...p });
    });
    const off = subscribe(refresh);
    const offPrefs = subscribePrefs(() => setPrefs({ ...getPrefs() }));
    // 同页 DOM 事件兜底（本插件 emit 时同步派发）
    window.addEventListener('notifications-changed', refresh);
    return () => {
      alive = false;
      off();
      offPrefs();
      window.removeEventListener('notifications-changed', refresh);
    };
  }, []);

  const toggleDone = (): void => {
    void savePrefs({ ...prefs, notifyOnDone: !prefs.notifyOnDone });
  };
  const toggleInteractive = (): void => {
    void savePrefs({ ...prefs, notifyOnInteractive: !prefs.notifyOnInteractive });
  };
  /** 条目点击：有 sessionId 先跳会话（notification-center 的跳转意图），再标已读 */
  const openItem = (n: NotifyItem): void => {
    if (n.sessionId) {
      window.dispatchEvent(new CustomEvent(CHANNEL_SESSION_INTENT, { detail: { sessionId: n.sessionId } }));
    }
    void markRead(n.id);
  };

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
      <div className="ncp-prefs" data-testid="nc-prefs">
        <div className="ncp-pref-row">
          <span className="ncp-pref-main">
            <span className="ncp-pref-t">会话完成通知</span>
            <span className="ncp-pref-d">整轮回复结束（含工具链）/中断/失败时提醒；仅提醒未打开的会话</span>
          </span>
          <button
            type="button"
            className={`ncp-switch ${prefs.notifyOnDone ? 'on' : ''}`}
            role="switch"
            aria-checked={prefs.notifyOnDone}
            aria-label="会话完成通知开关"
            data-testid="nc-switch-done"
            onClick={toggleDone}
          >
            <span className="ncp-switch-knob" />
          </button>
        </div>
        <div className="ncp-pref-row">
          <span className="ncp-pref-main">
            <span className="ncp-pref-t">询问等待通知</span>
            <span className="ncp-pref-d">其他会话的 AI 发起表单/选择/确认时提醒，点击通知跳转作答</span>
          </span>
          <button
            type="button"
            className={`ncp-switch ${prefs.notifyOnInteractive ? 'on' : ''}`}
            role="switch"
            aria-checked={prefs.notifyOnInteractive}
            aria-label="询问等待通知开关"
            data-testid="nc-switch-ia"
            onClick={toggleInteractive}
          >
            <span className="ncp-switch-knob" />
          </button>
        </div>
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
              onClick={() => openItem(n)}
              title={n.sessionId ? '点击跳转到该会话' : n.read ? undefined : '点击标记已读'}
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
      <div className="ncp-foot">通知经 cap.ui.notify 推送，最近 100 条；点击会话通知跳转，其余标记已读。</div>
    </div>
  );
}
