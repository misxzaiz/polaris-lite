/**
 * ShareEntry：输入行「分享」按钮 + portal 浮层（needs #069 v3 P1 路径 A）。
 *
 * 数据链最短：当前会话 id 在本插件 store（activeId），分享能力直接走 transcript-share
 * 的同源 HTTP（/api/share/create|export|list，会话 cookie 鉴权）——不经 cap 总线、
 * 无跨插件授权面。transcript-share 未启用（PLITE_SHARE=0）时操作报错提示，不阻塞输入区。
 *
 * 浮层能力：链接（token+有效期） / 下载个人版 .md / 下载 AI 分析版（本地导出，
 * 不创建链接）；当前会话活动分享列表 + 吊销。portal 到 body（输入槽 overflow:hidden
 * 会裁掉内联面板，同工作目录浮层先例）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSessionStore } from './store';

const TTL_OPTIONS = [
  { label: '1小时', ms: 60 * 60 * 1000 },
  { label: '24小时', ms: 24 * 60 * 60 * 1000 },
  { label: '7天', ms: 7 * 24 * 60 * 60 * 1000 },
  { label: '30天', ms: 30 * 24 * 60 * 60 * 1000 },
];

interface ShareItem {
  token: string;
  tokenDigest: string;
  sessionId: string;
  remainMs: number;
  live: boolean;
}

const fmtLeft = (ms: number) => {
  if (ms <= 0) return '已过期';
  const h = Math.floor(ms / 3600000);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
};

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function downloadBlob(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function safeName(s: string): string {
  return (s || '对话').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 24) || '对话';
}

export function ShareEntry() {
  const activeId = useSessionStore((s) => s.activeId);
  const title = useSessionStore((s) => s.sessions.find((x) => x.id === s.activeId)?.title);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; bottom: number; maxHeight: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [ttl, setTtl] = useState(24 * 60 * 60 * 1000);
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const [shares, setShares] = useState<ShareItem[]>([]);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  /** 创建分享（新会话 800ms 防抖内可能尚未落盘：SESSION_NOT_FOUND 重试一次） */
  const createShare = useCallback(async (retry = true): Promise<void> => {
    if (!activeId || busy) return;
    setBusy(true);
    setNote('');
    try {
      const res = await fetch('/api/share/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ sessionId: activeId, ttlMs: ttl, live: true }),
      });
      const j = await res.json().catch(() => null);
      if (res.ok && j?.ok) {
        const full = `${location.origin}${j.url}`;
        setCreatedUrl(full);
        const copied = await copyText(full);
        setNote(copied ? '链接已生成并复制到剪贴板' : '链接已生成（复制失败，点链接手动复制）');
        void refreshShares();
        return;
      }
      if (retry && res.status === 404) {
        await new Promise((r) => setTimeout(r, 1200));
        await createShare(false);
        return;
      }
      setNote(`创建失败：${j?.error ?? res.status}`);
    } catch (e) {
      setNote(`创建失败：${String((e as Error)?.message ?? e).slice(0, 80)}`);
    } finally {
      setBusy(false);
    }
  }, [activeId, ttl, busy]);

  const refreshShares = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch('/api/share/list', { credentials: 'include' });
      if (!res.ok) return;
      const j = await res.json();
      const mine = (j?.items ?? []).filter((s: ShareItem) => s.sessionId === activeId).slice(0, 5);
      setShares(mine);
    } catch { /* ignore */ }
  }, [activeId]);

  const revoke = useCallback(async (token: string): Promise<void> => {
    try {
      await fetch('/api/share/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ token }),
      });
      void refreshShares();
    } catch { /* ignore */ }
  }, [refreshShares]);

  /** 本地导出（不创建链接）：format=human|ai */
  const exportAs = useCallback(async (format: 'human' | 'ai'): Promise<void> => {
    if (!activeId) return;
    setBusy(true);
    setNote('');
    try {
      const res = await fetch(`/api/share/export?sessionId=${encodeURIComponent(activeId)}&format=${format}`, { credentials: 'include' });
      const base = safeName(title ?? activeId);
      if (format === 'ai') {
        const j = await res.json().catch(() => null);
        if (!res.ok || !j) {
          setNote(`导出失败：HTTP ${res.status}`);
          return;
        }
        downloadBlob(`${base}.ai.json`, JSON.stringify(j, null, 2), 'application/json');
      } else {
        const text = await res.text();
        if (!res.ok) {
          setNote(`导出失败：HTTP ${res.status}`);
          return;
        }
        downloadBlob(`${base}.md`, text, 'text/markdown');
      }
      setNote('已下载');
    } catch (e) {
      setNote(`导出失败：${String((e as Error)?.message ?? e).slice(0, 80)}`);
    } finally {
      setBusy(false);
    }
  }, [activeId, title]);

  const computePos = useCallback(() => {
    const el = btnRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const gap = 8;
    return {
      left: Math.max(8, Math.min(r.left - 40, window.innerWidth - 348)),
      bottom: Math.max(gap, window.innerHeight - r.top + gap),
      maxHeight: Math.max(200, Math.min(420, r.top - gap * 2)),
    };
  }, []);

  const toggle = useCallback(() => {
    if (open) {
      setOpen(false);
      setPos(null);
      return;
    }
    setCreatedUrl(null);
    setNote('');
    setPos(computePos());
    setOpen(true);
    void refreshShares();
  }, [open, computePos, refreshShares]);

  // 视口变化重新定位（软键盘/旋转）；点空白关闭
  useEffect(() => {
    if (!open) return;
    const update = () => {
      const next = computePos();
      if (next) setPos(next);
    };
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (t && (btnRef.current?.contains(t) || (t as Element).closest?.('.chat-share-pop'))) return;
      setOpen(false);
      setPos(null);
    };
    document.addEventListener('mousedown', onDoc);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      document.removeEventListener('mousedown', onDoc);
    };
  }, [open, computePos]);

  return (
    <>
      <button
        ref={btnRef}
        className="chat-send chat-share-btn"
        onClick={toggle}
        disabled={!activeId}
        title="分享 / 导出当前对话（链接 · 个人版 md · AI 分析版）"
        aria-label="分享当前对话"
        aria-expanded={open}
      >
        <svg viewBox="0 0 24 24" fill="none" width="16" height="16" aria-hidden="true">
          <circle cx="6" cy="12" r="2.4" stroke="currentColor" strokeWidth="1.7" />
          <circle cx="17" cy="6" r="2.4" stroke="currentColor" strokeWidth="1.7" />
          <circle cx="17" cy="18" r="2.4" stroke="currentColor" strokeWidth="1.7" />
          <path d="M8.2 10.8 14.8 7.2M8.2 13.2l6.6 3.6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </svg>
      </button>
      {open && pos && createPortal(
        <div
          className="chat-share-pop"
          role="dialog"
          aria-label="分享当前对话"
          style={{ left: pos.left, bottom: pos.bottom, maxHeight: pos.maxHeight }}
        >
          <div className="chat-picker-head">
            <span className="chat-picker-title">分享当前对话</span>
            <button className="chat-picker-done" onClick={toggle}>完成</button>
          </div>
          <div className="chat-share-body">
            <div className="chat-share-label">网页链接（免登录只读 · 实时刷新）</div>
            <div className="chat-share-ttls">
              {TTL_OPTIONS.map((o) => (
                <button key={o.ms} className={`chat-share-ttl ${ttl === o.ms ? 'on' : ''}`} onClick={() => setTtl(o.ms)}>{o.label}</button>
              ))}
            </div>
            <button className="chat-share-action" disabled={busy || !activeId} onClick={() => void createShare()}>生成并复制链接</button>
            {createdUrl && (
              <a className="chat-share-url" href={createdUrl} target="_blank" rel="noreferrer">{createdUrl}</a>
            )}
            <div className="chat-share-label">导出文件（本地下载，不创建链接）</div>
            <div className="chat-share-row">
              <button className="chat-share-action half" disabled={busy || !activeId} onClick={() => void exportAs('human')}>个人版 .md</button>
              <button className="chat-share-action half" disabled={busy || !activeId} onClick={() => void exportAs('ai')}>AI 分析版</button>
            </div>
            {shares.length > 0 && (
              <>
                <div className="chat-share-label">本会话活动链接</div>
                <div className="chat-share-list">
                  {shares.map((s) => (
                    <div key={s.token} className="chat-share-item">
                      <span className="mono">{s.tokenDigest}</span>
                      <span className="left">{fmtLeft(s.remainMs)}</span>
                      <button className="revoke" onClick={() => void revoke(s.token)}>吊销</button>
                    </div>
                  ))}
                </div>
              </>
            )}
            {note && <div className="chat-share-note">{note}</div>}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
