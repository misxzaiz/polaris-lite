/**
 * ChatInput：输入区（Polaris 对话布局第三段）升级版。
 * 第 1 期能力（参照 Polaris chat-desk 输入区行为规格）：
 * - 自适应增高（min 42 / max 200px）
 * - IME isComposing 防护（Enter 发送 + ↑↓ 历史召回两处；组词回车不再误发）
 * - ESC 三级语义：关建议（未来）→ 清空 → 中断流式
 * - 200k 字符上限拦截
 * - 发送按钮三形态：流式+空输入→停止独占；流式+有草稿→停止与发送并排（发送=入队）；空闲→发送
 * - isInterrupting 反馈（按停止后禁用转圈至流结束，5s 兜底）
 * - per-session 草稿：300ms 防抖持久化 + 会话切换取消（防串会话）+ sessionStorage 落盘
 * - ↑↓ prompt 历史召回（localStorage，空输入/浏览态才接管方向键，不污染草稿）
 */
import { useState, useLayoutEffect, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { sendUserMessage, interruptChat, enqueuePending, clearPending, onCompose } from './index';
import { useSessionStore } from './store';
import {
  type Attachment, validateFile, validateBatch, fileToAttachment, acceptAttr, isImageMime,
} from './attachments';
import { AttachmentStrip } from './AttachmentStrip';
import { useSessionSwipe } from './useSessionSwipe';
import { SwipeIndicator } from './SwipeIndicator';
import { PaperclipIcon, SendIcon, StopIcon, FolderIcon, ChevronRightIcon, PlusIcon } from './icons';
import { WorkspacePickerBody } from './WorkspacePickerBody';
import { onRootsChanged } from './workspace-prefs';
import { ContextMeter } from './ContextMeter';
import './chat-input.css';

const MAX_CHARS = 200_000;
// 增高的 min/max 不再在 JS 里硬编码：直接读 textarea 的计算样式（CSS 里用 dvh 做视口自适应，
// 浏览器会把它解析成当前 px）。这样旧内核兜底与 CSS 天然同口径，消除「JS 42/200 vs CSS 46/120」的错位。

/** prompt 历史（localStorage）：append 去重只比最后一条；up 聚最旧；down 翻尽退出浏览态 */
const HISTORY_KEY = 'chat-lite.prompt-history';
const HISTORY_LIMIT = 30;

function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const list = raw ? (JSON.parse(raw) as string[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function appendHistory(text: string): void {
  const list = loadHistory();
  if (list[list.length - 1] === text) return; // 去重只比最后一条
  list.push(text);
  while (list.length > HISTORY_LIMIT) list.shift();
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
  } catch { /* 存储失败静默 */ }
}

/** per-session 草稿存储（sessionStorage；防抖写入，切会话取消在途写入） */
function draftKey(sessionId: string): string {
  return `chat-lite.draft.${sessionId}`;
}

function loadDraft(sessionId: string): string {
  try {
    return sessionStorage.getItem(draftKey(sessionId)) ?? '';
  } catch {
    return '';
  }
}

function saveDraft(sessionId: string, text: string): void {
  try {
    if (text) sessionStorage.setItem(draftKey(sessionId), text);
    else sessionStorage.removeItem(draftKey(sessionId));
  } catch { /* 静默 */ }
}

export function ChatInput() {
  // 信任模式徽标（完全信任 = yolo；数据源服务端配置，切换即改服务端裁决模式）
  const [trustMode, setTrustMode] = useState<boolean | null>(null);
  const refreshTrust = useCallback(async () => {
    try {
      const r = await fetch('/api/tool/config', { credentials: 'include' });
      if (!r.ok) { setTrustMode(null); return; }
      const j = (await r.json()) as { mode?: string };
      setTrustMode(j.mode === 'yolo');
    } catch { setTrustMode(null); }
  }, []);
  const toggleTrust = useCallback(async () => {
    try {
      const r = await fetch('/api/tool/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ mode: trustMode ? 'confirm' : 'yolo' }),
      });
      if (r.ok) setTrustMode(((await r.json()) as { mode?: string }).mode === 'yolo');
    } catch { /* 配置不可达：保持原态 */ }
  }, [trustMode]);
  useEffect(() => { void refreshTrust(); }, [refreshTrust]);

  const [text, setText] = useState('');
  const [tooLong, setTooLong] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null); // null=非浏览态
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachErr, setAttachErr] = useState('');
  /** 助手面板（工作目录 / 信任模式 / 队列）：默认收起，操作行调谐图标点击内联展开 */
  const [assistantOpen, setAssistantOpen] = useState(false);
  /** 工作目录选择浮层位置（portal 到 body：宿主输入槽 overflow:hidden 会裁掉内联面板） */
  const [pickerPos, setPickerPos] = useState<{ left: number; width: number; bottom: number; maxHeight: number } | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const interruptTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeId = useSessionStore((s) => s.activeId);
  const streaming = useSessionStore((s) =>
    s.sessions.find((x) => x.id === s.activeId)?.messages.some((m) => m.streaming),
  );
  const queueLen = useSessionStore((s) => (s.activeId ? (s.pending[s.activeId]?.length ?? 0) : 0));
  /** 当前会话绑定的工作区（file-browser 登记的根；null=跟随全局默认） */
  const sessionWorkspaceId = useSessionStore((s) => s.sessions.find((x) => x.id === s.activeId)?.workspaceId ?? null);
  /** 关联只读目录（可读不可写，命令仍在主目录执行） */
  const sessionLinkedIds = useSessionStore(
    (s) => s.sessions.find((x) => x.id === s.activeId)?.linkedWorkspaceIds ?? [],
  );
  const setSessionWorkspace = useSessionStore((s) => s.setSessionWorkspace);
  const setSessionLinkedWorkspaces = useSessionStore((s) => s.setSessionLinkedWorkspaces);
  const createSession = useSessionStore((s) => s.createSession);
  /** 工作区显示名（file-browser 维护 names/labels；经全局事件桥同步） */
  const [wsLabel, setWsLabel] = useState<string | null>(null);
  /** 绑定失效（root 被移除/盘符不在）：必须显性提示，不能装作正常 */
  const [wsMissing, setWsMissing] = useState(false);
  const [wsRev, setWsRev] = useState(0);

  const canSend = (text.trim().length > 0 || attachments.length > 0) && !tooLong;

  // 隐形滑切：输入条内非 textarea 区域横向滑动切上一个/下一个会话（零常驻 UI）
  const { swipeProps, feedback } = useSessionSwipe();

  /** 浮层定位：用 bottom 贴住输入条上方（高度由内容决定，避免内容少时留一大片空白）；
      空间不足时用 max-height 收紧，列表在内部滚动，绝不越过视口顶部 */
  const computePickerPos = useCallback(() => {
    const el = barRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const gap = 8;
    return {
      left: Math.max(8, r.left),
      width: Math.min(r.width, 400),
      bottom: Math.max(gap, window.innerHeight - r.top + gap),
      maxHeight: Math.max(180, Math.min(400, r.top - gap * 2)),
    };
  }, []);

  const openPicker = useCallback(() => {
    setAssistantOpen(false); // 抽屉与浮层不同时出现，避免两个面板抢焦点
    setPickerPos(computePickerPos());
  }, [computePickerPos]);

  const closePicker = useCallback(() => setPickerPos(null), []);
  const pickerOpen = pickerPos !== null;

  // 视口变化（软键盘/旋转/窗口缩放）与页面滚动时重新定位
  useEffect(() => {
    if (!pickerOpen) return;
    const update = () => {
      const next = computePickerPos();
      if (next) setPickerPos(next);
    };
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [pickerOpen, computePickerPos]);

  // 点空白关闭（不设遮罩：遮罩会挡住消息流滚动）
  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || barRef.current?.contains(t)) return;
      setPickerPos(null);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [pickerOpen]);

  // 根表变化（登记/改名/删除）时重取名称：file-browser 广播 → index.ts 转成 roots 变更
  useEffect(() => onRootsChanged(() => setWsRev((v) => v + 1)), []);

  // 会话工作区显示名：解析当前绑定
  useEffect(() => {
    if (!sessionWorkspaceId) { setWsLabel(null); setWsMissing(false); return; }
    let alive = true;
    void (async () => {
      try {
        const r = await fetch('/api/fs/roots', { credentials: 'include' });
        const j = (await r.json()) as { roots?: { id: string; label: string }[] };
        const match = j.roots?.find((x) => x.id === sessionWorkspaceId);
        if (!alive) return;
        setWsLabel(match?.label ?? sessionWorkspaceId);
        setWsMissing(!match);
      } catch {
        if (alive) { setWsLabel(sessionWorkspaceId); setWsMissing(false); }
      }
    })();
    return () => { alive = false; };
  }, [sessionWorkspaceId, wsRev]);

  /** 附件统一入口：校验（单件 + 整批）→ 转 Attachment */
  const addFiles = useCallback(async (files: File[]) => {
    setAttachErr('');
    if (files.length === 0) return;
    for (const f of files) {
      const err = validateFile(f);
      if (err) {
        setAttachErr(err);
        return;
      }
    }
    const batchErr = validateBatch(attachments, files);
    if (batchErr) {
      setAttachErr(batchErr);
      return;
    }
    const next: Attachment[] = [];
    for (const f of files) {
      const result = await fileToAttachment(f);
      if ('error' in result) {
        setAttachErr(result.error);
        return;
      }
      next.push(result);
    }
    setAttachments((cur) => [...cur, ...next]);
  }, [attachments]);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((cur) => cur.filter((a) => a.id !== id));
  }, []);

  // 附件三通道之一：粘贴（图片/文件）
  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLDivElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const item of items) {
      const f = item.getAsFile();
      if (f && (isImageMime(f.type) || f.type.startsWith('text/') || f.name.match(/\.(txt|md|json|csv|ts|js|py|log)$/i))) {
        files.push(f);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      void addFiles(files);
    }
  }, [addFiles]);

  // 附件三通道之二：拖拽
  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  }, []);

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const files = [...e.dataTransfer.files];
    if (files.length > 0) void addFiles(files);
  }, [addFiles]);

  // 附件三通道之三：选择器
  const handleFilePicker = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    if (files.length > 0) void addFiles(files);
    e.target.value = ''; // 允许重选同一文件
  }, [addFiles]);

  /** 防抖持久化草稿（300ms）；切会话时由 effect 取消在途定时器防串会话 */
  const persistDraft = useCallback((val: string) => {
    if (!activeId) return;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => saveDraft(activeId, val), 300);
  }, [activeId]);

  // 会话切换：取消在途防抖写入（防 A 会话草稿写进 B），并载入新会话草稿
  useEffect(() => {
    if (draftTimer.current) {
      clearTimeout(draftTimer.current);
      draftTimer.current = null;
    }
    if (activeId) setText(loadDraft(activeId));
    else setText('');
    setHistoryIndex(null);
    return () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
    };
  }, [activeId]);

  // 空态建议「填入输入框」：写入草稿并聚焦到行尾（用户可改两个字再发）
  useEffect(() => onCompose((suggested) => {
    setText(suggested);
    setHistoryIndex(null);
    if (activeId) saveDraft(activeId, suggested);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(suggested.length, suggested.length);
    });
  }), [activeId]);

  // 自适应增高：现代内核走 CSS field-sizing:content（见 chat-input.css）；
  // 旧内核 JS 兜底——高度上/下限读计算样式（CSS 用 dvh，浏览器解析成 px），
  // 与 CSS 天然同口径。scrollHeight 不含边框，需补 border 口径。
  useLayoutEffect(() => {
    if (typeof CSS !== 'undefined' && CSS.supports?.('field-sizing: content')) return;
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const cs = getComputedStyle(ta);
    const min = parseFloat(cs.minHeight) || 42;
    const max = parseFloat(cs.maxHeight) || 200;
    const border = ta.offsetHeight - ta.clientHeight;
    const next = Math.min(Math.max(ta.scrollHeight + border, min), max);
    ta.style.height = `${next}px`;
  }, [text]);

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setTooLong(val.length > MAX_CHARS);
    setText(val);
    setHistoryIndex(null); // 手动输入退出历史浏览态
    persistDraft(val);
  };

  const doSend = () => {
    const t = text.trim();
    const hasContent = t.length > 0 || attachments.length > 0;
    if (!hasContent || tooLong) return;
    const carryAttachments = attachments;
    if (streaming) {
      // 流式中有草稿 → 入队（附件随队列项完整保留，不再压成文本）
      enqueuePending(t, carryAttachments);
      setText('');
      setAttachments([]);
      setHistoryIndex(null);
      if (activeId) saveDraft(activeId, '');
      return;
    }
    if (t) appendHistory(t);
    setText('');
    setAttachments([]);
    setHistoryIndex(null);
    if (activeId) saveDraft(activeId, '');
    void sendUserMessage(t, carryAttachments);
    void refreshTrust(); // 会话内配置可能被审批卡/面板改动：发送时同步徽标
  };

  const doInterrupt = () => {
    if (interrupting) return;
    setInterrupting(true);
    interruptChat();
    // 5s 兜底：引擎 done 事件未到也解除（正常路径由 streaming 变 false 即解除）
    if (interruptTimer.current) clearTimeout(interruptTimer.current);
    interruptTimer.current = setTimeout(() => setInterrupting(false), 5000);
  };

  /** 新增对话：当前会话已是空壳（0 条消息）时不再新建，只聚焦（防连点产生空壳会话） */
  const startNewSession = useCallback(() => {
    const st = useSessionStore.getState();
    const cur = st.sessions.find((s) => s.id === st.activeId);
    if (cur && cur.messages.length === 0) {
      taRef.current?.focus();
      return;
    }
    st.createSession();
    // createSession 后 activeId 已指向新会话；草稿清空由既有 activeId effect 完成
    setText('');
    setHistoryIndex(null);
    requestAnimationFrame(() => taRef.current?.focus());
  }, []);

  /** 相邻会话切换（Alt+←/→ 与切换行共用）：到头即停 */
  const gotoNeighbor = useCallback((dir: 'prev' | 'next') => {
    const st = useSessionStore.getState();
    const idx = st.sessions.findIndex((s) => s.id === st.activeId);
    if (idx < 0) return;
    // sessions[0] 最新：next = 下标-1（更新），prev = 下标+1（更旧）
    const target = st.sessions[dir === 'next' ? idx - 1 : idx + 1];
    if (!target) return;
    st.setActive(target.id);
    requestAnimationFrame(() => taRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!streaming && interrupting) {
      if (interruptTimer.current) clearTimeout(interruptTimer.current);
      setInterrupting(false);
    }
  }, [streaming, interrupting]);

  useEffect(() => () => {
    if (interruptTimer.current) clearTimeout(interruptTimer.current);
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const native = e.nativeEvent;
    // Alt+←/→ 相邻会话切换；Alt+N 新增对话。IME 组词中不接管（候选键可能是 Alt 组合）
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      if (native.isComposing) return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        gotoNeighbor('prev');
        return;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        gotoNeighbor('next');
        return;
      }
      if (e.key.toLowerCase() === 'n') {
        e.preventDefault();
        startNewSession();
        return;
      }
    }
    // ↑↓ 历史召回：空输入或浏览态才接管，不抢多行光标移动；IME 组词中不接管
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      if (native.isComposing) return;
      const browsing = historyIndex !== null;
      const empty = text.length === 0;
      if (!browsing && !empty) return; // 有内容且非浏览态：方向键归光标
      const list = loadHistory();
      if (list.length === 0) return;
      e.preventDefault();
      if (e.key === 'ArrowUp') {
        const cur = browsing ? (historyIndex ?? 0) : list.length; // 首按从最新（栈顶）出发
        const next = Math.max(0, cur - 1);
        setHistoryIndex(next);
        setText(list[next]); // 召回值不写草稿（浏览不污染草稿）
      } else {
        if (!browsing) return;
        const next = (historyIndex ?? 0) + 1;
        if (next >= list.length) {
          setHistoryIndex(null);
          setText('');
        } else {
          setHistoryIndex(next);
          setText(list[next]);
        }
      }
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      if (native.isComposing) return; // IME 组词中的 Enter 是选候选词，不是发送
      e.preventDefault();
      doSend();
      return;
    }
    if (e.key === 'Escape') {
      if (native.isComposing) return; // IME 组词中的 Esc 是取消候选，不清空
      if (pickerOpen) {
        setPickerPos(null); // Esc 先关选择浮层
        return;
      }
      if (assistantOpen) {
        setAssistantOpen(false);
        return;
      }
      if (historyIndex !== null) {
        setHistoryIndex(null);
        setText('');
        return;
      }
      if (text.length > 0) {
        setText('');
        if (activeId) saveDraft(activeId, '');
        return;
      }
      if (streaming) {
        e.preventDefault();
        doInterrupt();
      }
    }
  };

  const showStop = streaming && !interrupting;
  const showBoth = streaming && canSend; // 流式+有草稿：停止与发送并排（发送=入队）

  const placeholder = streaming
    ? '回复生成中，可继续输入并排入队列…'
    : '向 Polaris 提问，或记录一个想法…';
  const trustTitle = trustMode
    ? '信任模式：AI 可直接执行命令（点击关闭）'
    : '审批模式：命令需确认（点击开启信任）';
  const trustLabel = trustMode ? '信任模式' : '审批模式';

  return (
    <div
      ref={barRef}
      className={`chat-input-bar ${assistantOpen ? 'assistant-open' : ''}`}
      data-testid="chat-input"
      onPaste={handlePaste}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      {...swipeProps}
    >
        {/* 左右边缘小悬浮箭头：多会话时可点切/手势反馈（零高度占位） */}
        <SwipeIndicator swipe={feedback} />
        {attachErr && <div className="chat-input-warn">{attachErr}</div>}
        <AttachmentStrip attachments={attachments} onRemove={removeAttachment} />
        <textarea
          ref={taRef}
          className="chat-textarea"
          placeholder={placeholder}
          value={text}
          rows={1}
          enterKeyHint="send"
          onChange={onChange}
          onKeyDown={onKeyDown}
        />
        <input
          ref={fileRef}
          type="file"
          multiple
          accept={acceptAttr()}
          style={{ display: 'none' }}
          onChange={handleFilePicker}
        />
        {/* 助手面板：操作行调谐图标触发，内联展开在按钮行上方（不用浮层，避免被 shell-input 裁剪） */}
        <div
          className={`chat-assistant-drawer ${assistantOpen ? 'open' : ''}`}
          aria-hidden={!assistantOpen}
        >
            <div className="chat-assistant-inner">
              <button
                className="chat-assistant-row chat-row-btn"
                onClick={openPicker}
                title="选择本对话的工作目录（AI 命令在此执行）"
              >
                <span className="chat-assistant-key">工作目录</span>
                <span className={`chat-ws-chip ${sessionWorkspaceId ? 'pinned' : ''} ${wsMissing ? 'invalid' : ''}`}>
                  {sessionWorkspaceId ? (wsMissing ? '已失效' : (wsLabel ?? '…')) : '默认目录'}
                </span>
                {sessionLinkedIds.length > 0 && (
                  <span className="chat-row-aux" title="关联只读目录">+{sessionLinkedIds.length}</span>
                )}
                <span className="chat-assistant-go" aria-hidden="true"><ChevronRightIcon /></span>
              </button>
              {trustMode !== null && (
                <div className="chat-assistant-row">
                  <span className="chat-assistant-key">执行模式</span>
                  <button
                    className={`chat-trust-chip ${trustMode ? 'trusted' : ''}`}
                    onClick={() => void toggleTrust()}
                    title={trustTitle}
                    aria-pressed={trustMode}
                  >
                    {trustLabel}
                  </button>
                </div>
              )}
              <div className="chat-assistant-row">
                <span className="chat-assistant-key">待发队列</span>
                <span className="chat-assistant-val">{queueLen > 0 ? `已排队 ${queueLen} 条` : '无'}</span>
                {queueLen > 0 && (
                  <button className="chat-queue-clear" onClick={clearPending} title="清空待发队列">清空</button>
                )}
              </div>
            </div>
        </div>
        <div className="chat-input-btns">
          <button
            className="chat-send attach"
            onClick={() => fileRef.current?.click()}
            disabled={streaming}
            title="添加附件"
            aria-label="添加附件"
          >
            <PaperclipIcon />
          </button>
          <button
            className={`chat-send tune ${assistantOpen ? 'on' : ''} ${trustMode ? 'trusted' : ''}`}
            onClick={() => { setAssistantOpen((v) => !v); }}
            title={trustMode ? '信任模式已开启：AI 可直接执行命令 · 点击管理' : '工作目录 · 执行模式 · 队列'}
            aria-label="工作目录、执行模式与队列设置"
            aria-expanded={assistantOpen}
          >
            <svg viewBox="0 0 24 24" fill="none" width="16" height="16" aria-hidden="true">
              <path d="M4 7h9M17 7h3M4 17h3M11 17h9" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
              <circle cx="15" cy="7" r="2.2" stroke="currentColor" strokeWidth="1.7" />
              <circle cx="9" cy="17" r="2.2" stroke="currentColor" strokeWidth="1.7" />
            </svg>
            {trustMode === true && <span className="chat-tune-badge" title="信任模式已开启" aria-hidden="true" />}
          </button>
          {/* 当前目录：始终可见，点一下直接选（不必先找到调谐） */}
          <button
            className={`chat-ws-btn ${sessionWorkspaceId ? 'pinned' : ''} ${wsMissing ? 'invalid' : ''}`}
            onClick={openPicker}
            title={
              wsMissing
                ? `绑定的目录已失效，当前回退到默认目录 — 点击重新选择`
                : `工作目录：${wsLabel ?? '默认目录'}（AI 命令在此执行）— 点击切换`
            }
            aria-label="切换工作目录"
          >
            <FolderIcon />
            <span className="chat-ws-btn-label">{sessionWorkspaceId ? (wsMissing ? '已失效' : (wsLabel ?? '…')) : '默认目录'}</span>
            {sessionLinkedIds.length > 0 && <span className="chat-ws-btn-aux">+{sessionLinkedIds.length}</span>}
          </button>
          <span className="chat-input-hint">Enter 发送 · Shift + Enter 换行</span>
          {/* 新增对话：输入框旁一键开新会话（与左侧栏「新会话」等效；空会话防重复） */}
          <button
            className="chat-send new-session"
            onClick={startNewSession}
            title="新增对话（Alt+N）"
            aria-label="新增对话"
          >
            <PlusIcon />
          </button>
          {/* 上下文进度圆圈（spec §5.3 v2）：紧贴发送/停止按钮左侧；点击经 portal 在输入条上方展开详情 */}
          <ContextMeter />
          {showBoth && (
            <button className="chat-send stop" onClick={doInterrupt} disabled={interrupting}><StopIcon />停止</button>
          )}
          {showStop && !showBoth && (
            <button className="chat-send stop" onClick={doInterrupt} disabled={interrupting}>
              <StopIcon />{interrupting ? '停止中…' : '停止'}
            </button>
          )}
          {!streaming && (
            <button className="chat-send" onClick={doSend} disabled={!canSend}>
              <SendIcon />发送
            </button>
          )}
          {streaming && canSend && (
            <button className="chat-send queue" onClick={doSend} disabled={!canSend} title="流式中发送将进入待发队列">
              排队
            </button>
          )}
      </div>
      {/* 工作目录选择浮层：portal 到 body（输入槽 overflow:hidden 会裁掉内联面板）。
          用 absolute 而非 fixed——插件 CSS 门禁禁止 fixed，且这里只需要贴住输入条。 */}
      {pickerPos && createPortal(
        <div
          ref={popRef}
          className="chat-ws-pop"
          role="dialog"
          aria-label="选择工作目录"
          style={{ left: pickerPos.left, bottom: pickerPos.bottom, width: pickerPos.width, maxHeight: pickerPos.maxHeight }}
        >
          <div className="chat-picker-head">
            <span className="chat-picker-title">工作目录</span>
            <button className="chat-picker-done" onClick={closePicker}>完成</button>
          </div>
          <WorkspacePickerBody
            workspaceId={sessionWorkspaceId ?? undefined}
            linkedWorkspaceIds={sessionLinkedIds}
            onPickMain={(id) => {
              // 空态还没有会话：选择本身就是「要在这个目录里干活」的意图，直接建会话并绑定，
              // 否则选择看起来生效了、实际没有落点（用户会以为又丢了）
              const sid = activeId ?? createSession();
              setSessionWorkspace(sid, id);
            }}
            onToggleLinked={(id) => {
              const sid = activeId ?? createSession();
              const cur = useSessionStore.getState().sessions.find((s) => s.id === sid)?.linkedWorkspaceIds ?? [];
              const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id].slice(0, 3);
              setSessionLinkedWorkspaces(sid, next);
            }}
            closeOnPickMain
            onRequestClose={closePicker}
            locked={!!streaming}
          />
        </div>,
        document.body,
      )}
    </div>
  );
}
