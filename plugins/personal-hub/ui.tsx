/** Personal Hub 共享常量与工具函数（对齐 Polaris PersonalHub/constants.ts） */
import type { LinkType, Priority } from './types';

export const TYPE_LABELS: Record<LinkType, string> = {
  navigation: '导航',
  bookmark: '书签',
  todo: '待办',
  note: '笔记',
};

/** 表单可选类型（不含 note，note 由独立笔记体系处理） */
export const TYPE_OPTIONS_FOR_FORM: { value: LinkType; label: string }[] = [
  { value: 'navigation', label: '导航' },
  { value: 'bookmark', label: '书签' },
  { value: 'todo', label: '待办' },
];

/** 顶部 tab 筛选项（含 all） */
export const TYPE_FILTER_TABS: { value: LinkType | 'all'; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'navigation', label: '导航' },
  { value: 'bookmark', label: '书签' },
  { value: 'todo', label: '待办' },
];

export const PRIORITY_OPTIONS: { value: Priority; label: string; color: string }[] = [
  { value: 'high', label: '高', color: '#ef4444' },
  { value: 'medium', label: '中', color: '#f59e0b' },
  { value: 'low', label: '低', color: '#10b981' },
];

export const STATUS_OPTIONS: { value: 'all' | 'pending' | 'completed'; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'pending', label: '待完成' },
  { value: 'completed', label: '已完成' },
];

export const DUE_DATE_OPTIONS: { value: 'all' | 'today' | 'week' | 'month' | 'overdue'; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'today', label: '今天' },
  { value: 'week', label: '本周' },
  { value: 'month', label: '本月' },
  { value: 'overdue', label: '已过期' },
];

export const SORT_OPTIONS: { value: 'created_at' | 'updated_at' | 'title' | 'priority' | 'due_date'; label: string }[] = [
  { value: 'created_at', label: '创建时间' },
  { value: 'updated_at', label: '更新时间' },
  { value: 'title', label: '标题' },
  { value: 'priority', label: '优先级' },
  { value: 'due_date', label: '截止日期' },
];

export const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

export const PRIORITY_LABEL: Record<Priority, string> = {
  high: '高',
  medium: '中',
  low: '低',
};

export const PRIORITY_COLOR: Record<Priority, string> = {
  high: '#ef4444',
  medium: '#f59e0b',
  low: '#10b981',
};

/** 相对日期格式化：今天/明天/昨天/N天前/N天后/逾期，否则本地日期。 */
export function formatRelativeDate(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(d);
  target.setHours(0, 0, 0, 0);
  const diffDays = Math.round((target.getTime() - today.getTime()) / 86400000);
  if (diffDays === 0) return '今天';
  if (diffDays === 1) return '明天';
  if (diffDays === -1) return '昨天';
  if (diffDays < 0) return `逾期 ${Math.abs(diffDays)} 天`;
  if (diffDays <= 7) return `${diffDays} 天后`;
  return d.toLocaleDateString('zh-CN');
}

/** 完整日期时间 */
export function formatDateTime(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('zh-CN');
}

/** 判断是否已过截止日期（未完成） */
export function isOverdue(iso?: string | null, completed?: boolean | null): boolean {
  if (!iso || completed) return false;
  return new Date(iso).getTime() < Date.now();
}

/** 简单类型图标（内联 SVG，对齐 lucide 语义：导航/书签/待办/链接） */
export function TypeIcon({ type, size = 16, className = '' }: { type: LinkType | 'all'; size?: number; className?: string }) {
  const paths: Record<string, React.ReactNode> = {
    navigation: <><circle cx="12" cy="12" r="10" /><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" /></>,
    bookmark: <path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z" />,
    todo: <><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18M9 16l2 2 4-4" /></>,
    note: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" /></>,
    all: <><circle cx="12" cy="12" r="10" /><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></>,
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      {paths[type] ?? paths.note}
    </svg>
  );
}

/** 通用操作小图标 */
export function Icon({ name, size = 14, className = '' }: { name: 'plus' | 'refresh' | 'logout' | 'search' | 'filter' | 'x' | 'left' | 'right' | 'edit' | 'trash' | 'lock' | 'link' | 'calendar' | 'settings' | 'book' | 'check' | 'circle' | 'flag' | 'tag' | 'external'; size?: number; className?: string }) {
  const paths: Record<string, React.ReactNode> = {
    plus: <><path d="M12 5v14M5 12h14" /></>,
    refresh: <><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" /></>,
    logout: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></>,
    search: <><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></>,
    filter: <><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" /></>,
    x: <><path d="M18 6 6 18M6 6l12 12" /></>,
    left: <path d="m15 18-6-6 6-6" />,
    right: <path d="m9 18 6-6-6-6" />,
    edit: <><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /><path d="m15 5 4 4" /></>,
    trash: <><path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" /><line x1="10" y1="11" x2="10" y2="17" /><line x1="14" y1="11" x2="14" y2="17" /></>,
    lock: <><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></>,
    link: <><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></>,
    calendar: <><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" /></>,
    book: <><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" /></>,
    check: <path d="M20 6 9 17l-5-5" />,
    circle: <circle cx="12" cy="12" r="10" />,
    flag: <><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" /><line x1="4" y1="22" x2="4" y2="15" /></>,
    tag: <><path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" /><circle cx="7.5" cy="7.5" r="1" fill="currentColor" stroke="none" /></>,
    external: <><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></>,
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      {paths[name] ?? null}
    </svg>
  );
}
