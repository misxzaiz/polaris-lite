/**
 * NotificationPanel：通知中心面板（panel 槽「通知」Tab）。
 *
 * 2026-11-27 视觉重构：
 * - 列表从「无边框平铺流」改为「日期分组卡片列表」：今天/昨天/更早粘性分组头，
 *   条目为独立圆角卡片，未读整卡着色（不再只是小圆点）。
 * - 四级视觉语言：图标色相 + 左缘色条 + error 淡红底，扫视可辨。
 * - 相对时间（刚刚/N 分钟前/N 小时前，跨天回落 MM-DD HH:mm）。
 * - 过滤条（全部/未读）+ 操作按钮收纳。
 * - 偏好开关收进折叠区，不再永久占据首屏。
 * - 兼容测试选择器：.nc-panel/.ncp-toolbar strong/.ncp-item(.unread)/.ncp-t/.ncp-clear。
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

/** 相对时间：小时内用相对表达，跨天/更早回落绝对时间 */
function fmtRel(ts: number): string {
  const p2 = (n: number): string => String(n).padStart(2, '0');
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay && diff < 24 * 3_600_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  return fmtTime(ts);
}

/** 分组：今天 / 昨天 / 更早（更早再按月日粗分） */
function groupLabel(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return '今天';
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return '昨天';
  return '更早';
}

interface Group {
  label: string;
  items: NotifyItem[];
}

function groupItems(items: NotifyItem[]): Group[] {
  const groups: Group[] = [];
  for (const n of items) {
    const label = groupLabel(n.at);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(n);
    else groups.push({ label, items: [n] });
  }
  return groups;
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

type Filter = 'all' | 'unread';

export function NotificationPanel() {
  const [items, setItems] = useState<NotifyItem[]>([]);
  const [prefs, setPrefs] = useState<NotifyPrefs>(() => getPrefs());
  const [filter, setFilter] = useState<Filter>('all');
  const [prefsOpen, setPrefsOpen] = useState(false);

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
  const shown = filter === 'unread' ? items.filter((n) => !n.read) : items;
  const groups = groupItems(shown);

  return (
    <div className="nc-panel" data-testid="nc-panel">
      <div className="ncp-toolbar">
        <strong>通知</strong>
        {unread > 0 && <span className="ncp-mark">{unread} 条未读</span>}
        <div className="ncp-actions">
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
          <button
            type="button"
            className={`ncp-clear ncp-prefs-toggle ${prefsOpen ? 'on' : ''}`}
            aria-expanded={prefsOpen}
            onClick={() => setPrefsOpen((v) => !v)}
          >
            设置
          </button>
        </div>
      </div>

      {prefsOpen && (
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
      )}

      <div className="ncp-filter" role="tablist" aria-label="通知过滤">
        <button
          type="button"
          className={`ncp-chip ${filter === 'all' ? 'on' : ''}`}
          role="tab"
          aria-selected={filter === 'all'}
          onClick={() => setFilter('all')}
        >
          全部 {items.length > 0 && <em>{items.length}</em>}
        </button>
        <button
          type="button"
          className={`ncp-chip ${filter === 'unread' ? 'on' : ''}`}
          role="tab"
          aria-selected={filter === 'unread'}
          onClick={() => setFilter('unread')}
        >
          未读 {unread > 0 && <em>{unread}</em>}
        </button>
      </div>

      <div className="ncp-list">
        {shown.length === 0 ? (
          <div className="ncp-empty">
            <span className="ncp-empty-ico"><Ico level="info" /></span>
            {filter === 'unread'
              ? '没有未读通知，都处理完了。'
              : '没有通知，一切安静。其他插件经 cap.ui.notify 推送的通知会出现在这里。'}
          </div>
        ) : (
          groups.map((g) => (
            <div key={g.label} className="ncp-group">
              <div className="ncp-group-head">{g.label}</div>
              <div className="ncp-group-body">
                {g.items.map((n) => (
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
                    <span className="ncp-side">
                      <span className="ncp-time">{fmtRel(n.at)}</span>
                      {n.sessionId && <span className="ncp-jump" aria-hidden="true">跳转 →</span>}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
      <div className="ncp-foot">通知经 cap.ui.notify 推送，最近 100 条；点击会话通知跳转，其余标记已读。</div>
    </div>
  );
}
