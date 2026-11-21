/**
 * SharePanel：对话分享管理面板。
 * 左侧选会话（/api/chat/sessions 索引），右侧管理该会话的活动分享
 * （生成 / 续期 / 吊销 / 打开 / 复制链接）。数据面全部同源 fetch。
 */
import { useCallback, useEffect, useState } from 'react';

interface SessionItem {
  id: string;
  title: string;
  msgCount?: number;
  lastMsgPreview?: string;
  updatedAt: number;
}

interface ShareItem {
  tokenDigest: string;
  token?: string; // create 响应里有完整 token；list 只有摘要
  sessionId: string;
  createdAt: number;
  expiresAt: number;
  remainMs: number;
  live: boolean;
}

const TTL_OPTIONS = [
  { label: '1 小时', ms: 60 * 60 * 1000 },
  { label: '24 小时', ms: 24 * 60 * 60 * 1000 },
  { label: '7 天', ms: 7 * 24 * 60 * 60 * 1000 },
  { label: '30 天', ms: 30 * 24 * 60 * 60 * 1000 },
];

const fmtLeft = (ms: number) => {
  if (ms <= 0) return '已过期';
  const h = Math.floor(ms / 3600000);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
};

export function SharePanel() {
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [sel, setSel] = useState<string>('');
  const [shares, setShares] = useState<ShareItem[]>([]);
  const [ttl, setTtl] = useState<number>(24 * 60 * 60 * 1000);
  const [live, setLive] = useState<boolean>(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string>('');
  const [created, setCreated] = useState<{ token: string; url: string } | null>(null);

  const loadSessions = useCallback(async () => {
    try {
      const r = await fetch('/api/chat/sessions', { credentials: 'include' });
      if (!r.ok) return;
      const j = await r.json();
      setSessions((j?.sessions ?? []).slice(0, 100));
    } catch { /* 离线不炸面板 */ }
  }, []);

  const loadShares = useCallback(async () => {
    try {
      const r = await fetch('/api/share/list', { credentials: 'include' });
      if (!r.ok) return;
      const j = await r.json();
      setShares(j?.items ?? []);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    void loadSessions();
    void loadShares();
  }, [loadSessions, loadShares]);

  const create = useCallback(async () => {
    if (!sel || busy) return;
    setBusy(true);
    setNote('');
    try {
      const r = await fetch('/api/share/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ sessionId: sel, ttlMs: ttl, live }),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.ok) {
        setNote(`创建失败：${j?.error ?? r.status}`);
      } else {
        setCreated({ token: j.token, url: j.url });
        setNote('已创建');
        void loadShares();
      }
    } catch (e) {
      setNote(`创建失败：${String((e as Error)?.message ?? e)}`);
    } finally {
      setBusy(false);
    }
  }, [sel, ttl, live, busy, loadShares]);

  const revoke = useCallback(async (token: string) => {
    try {
      await fetch('/api/share/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ token }),
      });
      if (created && created.token === token) setCreated(null);
      void loadShares();
    } catch { /* ignore */ }
  }, [created, loadShares]);

  const refreshItem = useCallback(async (token: string, ttlMs: number) => {
    try {
      await fetch('/api/share/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ token, ttlMs }),
      });
      void loadShares();
    } catch { /* ignore */ }
  }, [loadShares]);

  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNote('已复制');
    } catch {
      setNote('复制失败（浏览器拦截）');
    }
  }, []);

  const selShares = shares.filter((s) => s.sessionId === sel);

  return (
    <div className="pl-share" data-testid="transcript-share">
      <div className="pl-share-body">
        <div className="pl-section-title">会话</div>
        <select
          className="pl-share-select"
          value={sel}
          onChange={(e) => setSel(e.target.value)}
          size={Math.min(10, Math.max(3, sessions.length))}
        >
          {sessions.length === 0 && <option value="">（无会话）</option>}
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title} · {s.msgCount ?? 0} 条
            </option>
          ))}
        </select>

        <div className="pl-section-title">有效期</div>
        <div className="pl-share-ttls">
          {TTL_OPTIONS.map((o) => (
            <button
              key={o.ms}
              className={`pl-share-ttl ${ttl === o.ms ? 'active' : ''}`}
              onClick={() => setTtl(o.ms)}
            >{o.label}</button>
          ))}
          <button
            className={`pl-share-ttl ${live ? 'active' : ''}`}
            onClick={() => setLive(!live)}
            title="分享页每 3 秒拉取最新快照"
          >{live ? '实时' : '静态'}</button>
        </div>

        <button className="pl-share-create" disabled={!sel || busy} onClick={() => void create()}>
          {busy ? '创建中…' : '生成分享链接'}
        </button>
        {created && (
          <div className="pl-share-created">
            <div className="pl-share-url-row">
              <a href={created.url} target="_blank" rel="noreferrer">{created.url}</a>
              <button onClick={() => void copy(`${location.origin}${created.url}`)}>复制</button>
            </div>
          </div>
        )}
        {note && <div className="pl-share-note">{note}</div>}

        {selShares.length > 0 && (
          <>
            <div className="pl-section-title">该会话的活动分享</div>
            <div className="pl-share-list">
              {selShares.map((s) => (
                <div key={s.tokenDigest} className="pl-share-item">
                  <div className="pl-share-item-main">
                    <span className="mono">{s.tokenDigest}</span>
                    <span className="pl-share-left">{fmtLeft(s.remainMs)}</span>
                    {s.live && <span className="pl-share-livebadge">实时</span>}
                  </div>
                  <div className="pl-share-item-ops">
                    <button onClick={() => void refreshItem(s.token ?? '', ttl)}>续期</button>
                    <button className="danger" onClick={() => void revoke(s.token ?? '')}>吊销</button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
        <div className="pl-share-tip">
          分享页含全过程（消息 + 工具调用入参摘要/输出/耗时/失败），免登录只读、已脱敏。
          AI 可用 transcript 工具直接读取同源转录。
        </div>
      </div>
    </div>
  );
}
