/**
 * ShareDrawerRows：调谐抽屉里的「分享」行组（needs #069 v3 入口重构）。
 *
 * 位置：与「工作目录 / 执行模式 / 待发队列」并排，作为抽屉的内联行——
 * 不新增独立按钮、不用 portal 浮层（抽屉本身内联展开，不受 shell-input 裁剪影响）。
 *
 * 数据链：当前会话 id 在本插件 store（activeId）；分享能力直接走 transcript-share
 * 的同源 HTTP（/api/share/create|export|list，会话 cookie 鉴权）——不经 cap 总线、
 * 无跨插件授权面。transcript-share 未启用（PLITE_SHARE=0）时操作报错提示，不阻塞输入区。
 */
import { useCallback, useEffect, useState } from 'react';
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

export function ShareDrawerRows() {
  const activeId = useSessionStore((s) => s.activeId);
  const title = useSessionStore((s) => s.sessions.find((x) => x.id === s.activeId)?.title);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [ttl, setTtl] = useState(24 * 60 * 60 * 1000);
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const [shares, setShares] = useState<ShareItem[]>([]);

  const refreshShares = useCallback(async (): Promise<void> => {
    if (!activeId) return;
    try {
      const res = await fetch('/api/share/list', { credentials: 'include' });
      if (!res.ok) return;
      const j = await res.json();
      setShares((j?.items ?? []).filter((s: ShareItem) => s.sessionId === activeId).slice(0, 5));
    } catch { /* ignore */ }
  }, [activeId]);

  // 抽屉展开即刷新当前会话的活动链接（挂载即拉，activeId 变化重拉）
  useEffect(() => {
    void refreshShares();
  }, [refreshShares]);

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
  }, [activeId, ttl, busy, refreshShares]);

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
      setNote(`已下载 ${base}${format === 'ai' ? '.ai.json' : '.md'}`);
    } catch (e) {
      setNote(`导出失败：${String((e as Error)?.message ?? e).slice(0, 80)}`);
    } finally {
      setBusy(false);
    }
  }, [activeId, title]);

  return (
    <>
      <div className="chat-assistant-row">
        <span className="chat-assistant-key">链接有效期</span>
        <span className="chat-share-ttls">
          {TTL_OPTIONS.map((o) => (
            <button key={o.ms} className={`chat-share-ttl ${ttl === o.ms ? 'on' : ''}`} onClick={() => setTtl(o.ms)}>{o.label}</button>
          ))}
        </span>
      </div>
      <div className="chat-assistant-row">
        <span className="chat-assistant-key">网页链接</span>
        <span className="chat-share-acts">
          <button className="chat-share-chip" disabled={busy || !activeId} onClick={() => void createShare()} title="生成免登录只读链接（token+有效期，实时刷新）并复制">
            {busy ? '生成中…' : '生成并复制'}
          </button>
          {createdUrl && (
            <a className="chat-share-url" href={createdUrl} target="_blank" rel="noreferrer" title={createdUrl}>打开</a>
          )}
        </span>
      </div>
      <div className="chat-assistant-row">
        <span className="chat-assistant-key">导出文件</span>
        <span className="chat-share-acts">
          <button className="chat-share-chip" disabled={busy || !activeId} onClick={() => void exportAs('human')} title="本地下载个人阅读版 Markdown（不创建链接）">个人版 .md</button>
          <button className="chat-share-chip" disabled={busy || !activeId} onClick={() => void exportAs('ai')} title="本地下载 AI 分析版 JSON（含 API 轨迹/编排事件/逐跳轮次 + 分析任务书）">AI 分析版</button>
        </span>
      </div>
      <div className="chat-assistant-row">
        <span className="chat-assistant-key">预览</span>
        <span className="chat-share-acts">
          <button
            className="chat-share-chip"
            disabled={!activeId}
            onClick={() => { window.open(`/api/share/export?sessionId=${encodeURIComponent(activeId ?? '')}&format=human-html`, '_blank'); }}
            title="新开标签页预览个人阅读版排版（渲染后的效果，页面内可下载 .md）"
          >个人版效果</button>
          <button
            className="chat-share-chip"
            disabled={!activeId}
            onClick={() => { window.open(`/api/share/export?sessionId=${encodeURIComponent(activeId ?? '')}&format=html`, '_blank'); }}
            title="新开标签页预览分享页完整效果（含 API 轨迹与编排事件；会话门禁快照，不创建链接）"
          >网页完整版</button>
        </span>
      </div>
      {shares.length > 0 && (
        <div className="chat-assistant-row">
          <span className="chat-assistant-key">活动链接（{shares.length}）</span>
          <span className="chat-share-list">
            {shares.map((s) => (
              <span key={s.token} className="chat-share-item">
                <span className="mono" title={s.token}>{s.tokenDigest}</span>
                <span className="left">{fmtLeft(s.remainMs)}</span>
                <button className="chat-share-revoke" onClick={() => void revoke(s.token)} title="吊销该链接">吊销</button>
              </span>
            ))}
          </span>
        </div>
      )}
      {note && (
        <div className="chat-assistant-row">
          <span className="chat-assistant-key">状态</span>
          <span className="chat-assistant-val chat-share-note">{note}</span>
        </div>
      )}
    </>
  );
}
