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
import { sendUserMessage, interruptChat, enqueuePending, clearPending } from './index';
import { useSessionStore } from './store';
import {
  type Attachment, validateFile, validateBatch, fileToAttachment, acceptAttr, isImageMime,
} from './attachments';
import { AttachmentStrip } from './AttachmentStrip';
import './chat-input.css';

const MAX_CHARS = 200_000;
const MAX_HEIGHT = 200;
const MIN_HEIGHT = 42;

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
  const [text, setText] = useState('');
  const [tooLong, setTooLong] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null); // null=非浏览态
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachErr, setAttachErr] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const interruptTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeId = useSessionStore((s) => s.activeId);
  const streaming = useSessionStore((s) =>
    s.sessions.find((x) => x.id === s.activeId)?.messages.some((m) => m.streaming),
  );
  const queueLen = useSessionStore((s) => (s.activeId ? (s.pending[s.activeId]?.length ?? 0) : 0));

  const canSend = (text.trim().length > 0 || attachments.length > 0) && !tooLong;

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

  // 自适应增高：现代内核走 CSS field-sizing:content（见 chat-input.css）；
  // 旧内核 JS 兜底——scrollHeight 不含 2px 边框，需补边框口径，与 CSS min/max 42/200 对齐
  useLayoutEffect(() => {
    if (typeof CSS !== 'undefined' && CSS.supports?.('field-sizing: content')) return;
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const border = ta.offsetHeight - ta.clientHeight;
    const next = Math.min(Math.max(ta.scrollHeight + border, MIN_HEIGHT), MAX_HEIGHT);
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

  return (
    <div
      className="chat-input-bar"
      data-testid="chat-input"
      onPaste={handlePaste}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {attachErr && <div className="chat-input-warn">{attachErr}</div>}
      {queueLen > 0 && (
        <div className="chat-queue-hint">
          <span>已排队 {queueLen} 条，本次回复结束后自动发送</span>
          <button className="chat-queue-clear" onClick={clearPending} title="清空待发队列">清空</button>
        </div>
      )}
      <AttachmentStrip attachments={attachments} onRemove={removeAttachment} />
      <textarea
        ref={taRef}
        className="chat-textarea"
        placeholder={streaming ? '流式回复中…可输入排队（Enter 入队）' : '输入消息，Enter 发送，Shift+Enter 换行，↑↓ 召回历史'}
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
          className="chat-send attach"
          onClick={() => fileRef.current?.click()}
          disabled={streaming}
          title="添加附件"
        >
          📎
        </button>
        {showBoth && (
          <button className="chat-send stop" onClick={doInterrupt} disabled={interrupting}>停止</button>
        )}
        {showStop && !showBoth && (
          <button className="chat-send stop" onClick={doInterrupt} disabled={interrupting}>
            {interrupting ? '停止中…' : '停止'}
          </button>
        )}
        {!streaming && (
          <button className="chat-send" onClick={doSend} disabled={!canSend}>
            发送
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
