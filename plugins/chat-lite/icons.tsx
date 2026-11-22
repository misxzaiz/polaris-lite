/** 统一的 1.5px 细线图标；不使用 emoji 或平台相关的彩色字符。 */
import type { ReactNode } from 'react';

function Icon({ children, size = 18 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      {children}
    </svg>
  );
}

const stroke = { stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

export function PolarisMark({ size = 28 }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="M12 2 14.1 9.9 22 12 14.1 14.1 12 22 9.9 14.1 2 12 9.9 9.9 12 2Z" {...stroke} strokeWidth={1.2} />
      <path d="M12 7.5 13.05 10.95 16.5 12 13.05 13.05 12 16.5 10.95 13.05 7.5 12 10.95 10.95 12 7.5Z" fill="currentColor" fillOpacity={0.2} stroke="none" />
    </Icon>
  );
}

export function PlusIcon() {
  return <Icon><path d="M12 5v14M5 12h14" {...stroke} /></Icon>;
}

export function TrashIcon() {
  return <Icon size={16}><path d="M4 7h16M9 7V4h6v3M7 7l.7 13h8.6L17 7M10 11v5M14 11v5" {...stroke} /></Icon>;
}

export function ArrowUpRightIcon() {
  return <Icon size={17}><path d="M6 18 18 6M8 6h10v10" {...stroke} /></Icon>;
}

export function PaperclipIcon() {
  return <Icon><path d="m8.5 12.5 6.8-6.8a3 3 0 0 1 4.2 4.2l-8.3 8.3a5 5 0 0 1-7.1-7.1l8.1-8.1" {...stroke} /></Icon>;
}

export function SendIcon() {
  return <Icon size={17}><path d="m4 4 17 8-17 8 3-8-3-8ZM7 12h14" {...stroke} /></Icon>;
}

export function QueueIcon() {
  return <Icon size={17}><path d="M4 6h16M4 12h16M4 18h10" {...stroke} /></Icon>;
}

export function StopIcon() {
  return <Icon size={15}><rect x="6" y="6" width="12" height="12" rx="1.5" {...stroke} /></Icon>;
}

export function CloseIcon() {
  return <Icon size={14}><path d="m6 6 12 12M18 6 6 18" {...stroke} /></Icon>;
}

export function FolderIcon() {
  return <Icon size={15}><path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h4l2 2.5h8a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 18.5H5A1.5 1.5 0 0 1 3.5 17Z" {...stroke} /></Icon>;
}

export function FileIcon() {
  return <Icon size={24}><path d="M6 3h8l4 4v14H6V3ZM14 3v5h4M9 13h6M9 17h4" {...stroke} /></Icon>;
}

export function UserIcon() {
  return <Icon size={16}><circle cx="12" cy="8" r="3.25" {...stroke} /><path d="M5.5 20c.5-4 2.8-6 6.5-6s6 2 6.5 6" {...stroke} /></Icon>;
}

export function CopyIcon() {
  return <Icon size={14}><rect x="8" y="8" width="11" height="11" rx="2" {...stroke} /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" {...stroke} /></Icon>;
}

export function CheckIcon() {
  return <Icon size={14}><path d="m5 12 4 4L19 6" {...stroke} /></Icon>;
}

/** 行尾「可进入」指示（替代 › 这类平台相关符号字符） */
export function ChevronRightIcon() {
  return <Icon size={14}><path d="m9 5 7 7-7 7" {...stroke} /></Icon>;
}

/** 「换一批」刷新图标 */
export function RefreshIcon() {
  return <Icon size={13}><path d="M20 12a8 8 0 1 1-2.34-5.66" {...stroke} /><path d="M20 4v4h-4" {...stroke} /></Icon>;
}

// ===== 消息操作条图标（P0/P1 消息操作） =====

/** 编辑（铅笔） */
export function EditIcon() {
  return <Icon size={13}><path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3Z" {...stroke} /></Icon>;
}

/** 重发（追加新一轮的回环箭头） */
export function ResendIcon() {
  return <Icon size={13}><path d="M5 9h11a4 4 0 0 1 0 8H8" {...stroke} /><path d="m9 5-4 4 4 4" {...stroke} /></Icon>;
}

/** 重新生成（循环箭头） */
export function RegenIcon() {
  return <Icon size={13}><path d="M20 12a8 8 0 1 1-2.34-5.66" {...stroke} /><path d="M20 4v4h-4" {...stroke} /></Icon>;
}

/** 回填输入框（下箭头入托盘） */
export function BackfillIcon() {
  return <Icon size={13}><path d="M12 4v10m0 0 4-4m-4 4-4-4" {...stroke} /><path d="M5 19h14" {...stroke} /></Icon>;
}

/** 跳到本条开头（上箭头） */
export function JumpIcon() {
  return <Icon size={13}><path d="M12 19V5m0 0-6 6m6-6 6 6" {...stroke} /></Icon>;
}

/** 侧栏重命名（小铅笔） */
export function PencilIcon() {
  return <Icon size={14}><path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3Z" {...stroke} /></Icon>;
}
