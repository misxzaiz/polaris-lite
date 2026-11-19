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
import { sendUserMessage, interruptChat, enqueuePending, clearPending, onCompose } from './index';
import { useSessionStore } from './store';
import {
  type Attachment, validateFile, validateBatch, fileToAttachment, acceptAttr, isImageMime,
} from './attachments';
import { AttachmentStrip } from './AttachmentStrip';
import { PaperclipIcon, SendIcon, StopIcon } from './icons';
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
  /** 助手抽屉（工作区 / 信任模式 / 队列）：默认收起，把手点击或上拉展开 */
  const [assistantOpen, setAssistantOpen] = useState(false);
  /**
   * 展开编辑器：长文本时把 textarea 增高到输入区允许的上限（受 .shell-input 的 42dvh 约束）。
   * 不用 fixed 浮层——插件 CSS 门禁禁止 position:fixed（会逃出窗格盖住分隔条/抽屉），
   * 且宿主暂无 cap.ui.overlay 能力。沿用同一个 textarea，草稿/IME/发送逻辑全部复用。
   */
  const [expanded, setExpanded] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const grabberRef = useRef<HTMLDivElement>(null);
  const dragStartY = useRef<number | null>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const interruptTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeId = useSessionStore((s) => s.activeId);
  const streaming = useSessionStore((s) =>
    s.sessions.find((x) => x.id === s.activeId)?.messages.some((m) => m.streaming),
  );
  const queueLen = useSessionStore((s) => (s.activeId ? (s.pending[s.activeId]?.length ?? 0) : 0));
  /** 当前会话绑定的工作区（file-browser 登记的根；null=跟随全局默认） */
  const sessionWorkspaceId = useSessionStore((s) => s.sessions.find((x) => x.id === s.activeId)?.workspaceId ?? null);
  /** 工作区显示名（file-browser 维护 names/labels；经全局事件桥同步） */
  const [wsLabel, setWsLabel] = useState<string | null>(null);

  const canSend = (text.trim().length > 0 || attachments.length > 0) && !tooLong;

  // 会话工作区显示名：roots 变化（登记/改名/删除）时由 file-browser 广播；这里解析当前绑定
  useEffect(() => {
    if (!sessionWorkspaceId) { setWsLabel(null); return; }
    let alive = true;
    void (async () => {
      try {
        const r = await fetch('/api/fs/roots', { credentials: 'include' });
        const j = (await r.json()) as { roots?: { id: string; label: string }[] };
        const match = j.roots?.find((x) => x.id === sessionWorkspaceId);
        if (alive) setWsLabel(match?.label ?? sessionWorkspaceId);
      } catch { if (alive) setWsLabel(sessionWorkspaceId); }
    })();
    return () => { alive = false; };
  }, [sessionWorkspaceId]);

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

  // 助手抽屉手势：上拉展开、下拉收起；轻微移动视为点击（切换）。
  // 用 pointer 事件 + setPointerCapture，触屏/鼠标一致；不 preventDefault 以免妨碍正常滚动。
  const onGrabberDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    dragStartY.current = e.clientY;
    (e.currentTarget as HTMLDivElement).setPointerCapture?.(e.pointerId);
  }, []);
  const onGrabberUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (dragStartY.current === null) return;
    const dy = dragStartY.current - e.clientY; // 正值=上拉
    dragStartY.current = null;
    if (Math.abs(dy) < 6) setAssistantOpen((v) => !v); // 点击切换
    else setAssistantOpen(dy > 0); // 上拉展开 / 下拉收起
  }, []);

  /** 展开/收起编辑器：同一 textarea，只需切状态并聚焦（光标位置由浏览器自动保留） */
  const toggleEditor = useCallback(() => {
    setExpanded((v) => !v);
    requestAnimationFrame(() => taRef.current?.focus());
  }, []);

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
  }, [text, expanded]);

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
    if (expanded) setExpanded(false); // 发送后收起编辑器
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
      if (native.isComposing) return; // IME 组词中的 Esc 是取消候选，不收起编辑器
      if (expanded) {
        setExpanded(false);
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
      className={`chat-input-bar ${assistantOpen ? 'assistant-open' : ''} ${expanded ? 'editor-expanded' : ''}`}
      data-testid="chat-input"
      onPaste={handlePaste}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
        {/* 把手：点击切换助手抽屉，上拉展开 / 下拉收起 */}
        <div
          ref={grabberRef}
          className="chat-assistant-grabber"
          onPointerDown={onGrabberDown}
          onPointerUp={onGrabberUp}
          role="button"
          tabIndex={0}
          aria-label="展开或收起助手面板（工作区、信任模式、队列）"
          aria-expanded={assistantOpen}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setAssistantOpen((v) => !v); } }}
        >
          <span className="chat-grabber-bar" />
          <span className="chat-grabber-label">工作区 · 模式 · 队列</span>
        </div>
        {/* 助手抽屉：收纳工作区 / 信任模式 / 队列，主行不再被 chip 挤占 */}
        <div className={`chat-assistant-drawer ${assistantOpen ? 'open' : ''}`} aria-hidden={!assistantOpen}>
          <div className="chat-assistant-inner">
            {wsLabel && (
              <div className="chat-assistant-row">
                <span className="chat-assistant-key">工作区</span>
                <span className="chat-ws-chip pinned" title="当前会话绑定的工作区（AI 命令在此目录内执行）">
                  {wsLabel}
                </span>
              </div>
            )}
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

        {attachErr && <div className="chat-input-warn">{attachErr}</div>}
        <AttachmentStrip attachments={attachments} onRemove={removeAttachment} />
        <textarea
          ref={taRef}
          className={`chat-textarea ${expanded ? 'expanded' : ''}`}
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
        <div className="chat-input-btns">
          <button
            className={`chat-send expand ${expanded ? 'on' : ''}`}
            onClick={toggleEditor}
            title={expanded ? '收起编辑器（Esc）' : '展开编辑器（长文本更好编辑）'}
            aria-label={expanded ? '收起编辑器' : '展开编辑器'}
            aria-pressed={expanded}
          >
            <svg viewBox="0 0 24 24" fill="none" width="16" height="16" aria-hidden="true">
              {expanded
                ? <path d="M9 3v6H3M15 21v-6h6M3 15h6v6M21 9h-6V3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                : <path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />}
            </svg>
          </button>
          <span className="chat-input-hint">Enter 发送 · Shift + Enter 换行</span>
          <button
            className="chat-send attach"
            onClick={() => fileRef.current?.click()}
            disabled={streaming}
            title="添加附件"
            aria-label="添加附件"
          >
            <PaperclipIcon />
          </button>
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
          {streaming && (
            <button className="chat-send queue" onClick={doSend} disabled={!canSend} title="流式中发送将进入待发队列">
              排队
            </button>
          )}
      </div>
    </div>
  );
}
