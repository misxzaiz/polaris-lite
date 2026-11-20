/**
 * 会话相邻切换的纯函数层（chat-input-session-nav-plan §5.2）。
 *
 * 顺序口径收口在这里：store 的 sessions 数组是「新会话头插（[0] 最新）」，
 * deleteSession 保序、持久化原样恢复——相邻切换就是下标 ±1。
 * 若未来引入拖拽排序/置顶，只需改本文件的排序函数，UI 与键盘层不动。
 *
 * 入参用结构化最小类型（id/title/messages.streaming），不绑定 store 的
 * StoreMessage 联合——纯函数不认识工具卡/块消息，只读它需要的三样。
 */
export interface NavSessionLike {
  id: string;
  title: string;
  messages?: { content?: string; streaming?: boolean }[];
}

export interface NavInfo {
  /** 上一个（更旧）会话 id；到头为 null */
  prev: string | null;
  /** 下一个（更新）会话 id；已是最新为 null */
  next: string | null;
  canPrev: boolean;
  canNext: boolean;
  /** 当前会话标题的展示口径：与侧栏同规则（title 或首条消息前 18 字） */
  label: string;
  /** 当前会话是否有消息在流式生成（呼吸点） */
  streaming: boolean;
}

/** 与 SessionSidebar.displayTitle 同口径：非默认标题优先，否则首条消息截 18 字 */
export function sessionLabel(s: NavSessionLike): string {
  if (s.title !== '新会话') return s.title;
  const first = s.messages?.[0]?.content;
  return first ? first.slice(0, 18) : s.title;
}

/**
 * 计算当前会话的相邻会话。
 * 「← 往回翻历史（更旧），→ 往最新走」：next 是更新的一方（下标-1），prev 是更旧的一方（下标+1）。
 * 到头即停（不循环）：循环会让人迷失「现在在第几个」。
 */
export function neighbors(sessions: NavSessionLike[], activeId: string | null): NavInfo {
  const idx = sessions.findIndex((s) => s.id === activeId);
  const empty: NavInfo = { prev: null, next: null, canPrev: false, canNext: false, label: '', streaming: false };
  if (idx < 0) return empty;
  const cur = sessions[idx];
  const prev = sessions[idx + 1] ?? null;
  const next = sessions[idx - 1] ?? null;
  return {
    prev: prev?.id ?? null,
    next: next?.id ?? null,
    canPrev: !!prev,
    canNext: !!next,
    label: sessionLabel(cur),
    streaming: cur.messages?.some((m) => m.streaming) ?? false,
  };
}
