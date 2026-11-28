/**
 * media-push 渲染器：对话内任意媒体卡（八 kind 分发）+ 伪全屏。
 *
 * chat-lite artifact 块经 CHANNEL_ARTIFACT_RENDERERS(@sdk)['media'] 查表渲染本组件。
 * data 契约：{ url, id, kind, ext, mime, bytes }（kind: image/video/audio/sheet/
 * pdf/text/archive/other）。
 *
 * 交互纪律（docs/media-push-plan.md §7，微调版）：卡片内交互（表格翻页/排序/筛选、
 * 文本续读、归档树）直连本插件 server 半端的 HTTP 端点（cookie 同源门禁），
 * 不经模型、不回对话流——同 pocket-ledger Panel / html-preview Panel 的先例。
 *
 * 伪全屏：Popover top layer（html-preview/fullscreen.ts 三死方案的幸存结论）。
 * 进入时把卡片主视图 DOM 搬进全屏层（组件不卸载，播放进度/表格页码天然保留），
 * 退出时搬回消息流原位。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export interface MediaCardProps {
  callId: string;
  title: string;
  data: {
    url?: string;
    id?: string;
    kind?: string;
    ext?: string;
    mime?: string;
    bytes?: number;
  };
}

const KIND_COLOR: Record<string, string> = {
  image: 'rgba(124, 58, 237, 0.85)',
  video: 'rgba(29, 78, 216, 0.85)',
  audio: 'rgba(14, 116, 144, 0.85)',
  sheet: 'rgba(31, 122, 77, 0.85)',
  pdf: 'rgba(192, 57, 47, 0.85)',
  text: 'rgba(180, 83, 9, 0.85)',
  archive: 'rgba(71, 85, 105, 0.85)',
  other: 'rgba(133, 140, 160, 0.85)',
};

const NUM_RE = /^-?[\d.]+$/;
const fmtBytes = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)}MB` : n > 0 ? `${Math.round(n / 1024)}KB` : '');

/** 表格卡行单元格：数值列右对齐等宽 */
function Td({ v }: { v: string }) {
  const s = String(v ?? '');
  return <td className={NUM_RE.test(s.trim()) ? 'num' : ''}>{s}</td>;
}

/* ==================== Audio 卡：磁带台（自动播放 + 波形进度 + 倍速） ====================
 * 方案 A（原型验证过）：卡片挂载即 play()；被 Autoplay Policy 拒 → 进全局待播队列，
 * 任意 pointerdown/keydown 手势立即开播。localStorage 开关 mediaPush.autoplay。
 * 全局播放队列：多卡排队播（不叠音），每卡结束后放行下一张。
 * 磁带轮/波形/倍速样式见 media-push.css 的 .mp-audio* 族（「电台」同族语言）。
 * ================================================================================ */

const AUDIO_SPEEDS = [1, 1.25, 1.5, 2];
const AUTOPLAY_KEY = 'mediaPush.autoplay';

/** 全局：待播队列 + 手势解锁器（模块级单例，多卡共享） */
const __audioPending: HTMLAudioElement[] = [];
let __audioUnlockBound = false;
function audioGestureUnlock() {
  if (__audioUnlockBound) return;
  __audioUnlockBound = true;
  const fire = () => {
    const el = __audioPending.shift();
    if (el) void el.play().catch(() => { /* 仍被拒就让它留在队列外等手动 */ });
  };
  window.addEventListener('pointerdown', fire, { passive: true });
  window.addEventListener('keydown', fire);
}

function autoplayEnabled(): boolean {
  try { return localStorage.getItem(AUTOPLAY_KEY) !== 'off'; } catch { return true; }
}

function AudioDeck({ url, title, bytes }: { url: string; title: string; bytes?: number }) {
  const ref = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [pending, setPending] = useState(false);
  const [speedIdx, setSpeedIdx] = useState(0);
  const [prog, setProg] = useState(0);           // 0..1
  const [t, setT] = useState({ cur: 0, dur: 0 });

  // 波形条高度：按 url 稳定伪随机（不做真实解码，视觉用）
  const barsRef = useRef<number[]>([]);
  if (!barsRef.current.length) {
    let h = 0;
    for (let i = 0; i < url.length; i += 1) h = (h * 31 + url.charCodeAt(i)) >>> 0;
    barsRef.current = Array.from({ length: 42 }, (_, i) => {
      const v = Math.abs(Math.sin((h % 997) + i * 0.7));
      return 6 + Math.min(20, v * 14 + ((h >> i % 16) & 7));
    });
  }

  // 挂载即试播（方案 A 核心）
  useEffect(() => {
    const el = ref.current;
    if (!el || !autoplayEnabled()) return;
    el.play().then(() => {
      setPending(false);
    }).catch(() => {
      // NotAllowedError：进待播队列，等任意手势
      setPending(true);
      audioGestureUnlock();
      __audioPending.push(el);
    });
    return () => {
      const i = __audioPending.indexOf(el);
      if (i >= 0) __audioPending.splice(i, 1);
    };
  }, [url]);

  // 播放事件绑定
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onPlay = () => { setPlaying(true); setPending(false); };
    const onPause = () => setPlaying(false);
    const onEnd = () => setPlaying(false);
    const onTime = () => {
      const d = el.duration && Number.isFinite(el.duration) ? el.duration : 0;
      setT({ cur: el.currentTime, dur: d });
      if (d > 0) setProg(el.currentTime / d);
    };
    el.addEventListener('play', onPlay);
    el.addEventListener('pause', onPause);
    el.addEventListener('ended', onEnd);
    el.addEventListener('timeupdate', onTime);
    return () => {
      el.removeEventListener('play', onPlay);
      el.removeEventListener('pause', onPause);
      el.removeEventListener('ended', onEnd);
      el.removeEventListener('timeupdate', onTime);
    };
  }, []);

  const toggle = () => {
    const el = ref.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => {}); else el.pause();
  };
  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el) return;
    const r = e.currentTarget.getBoundingClientRect();
    const p = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    if (el.duration && Number.isFinite(el.duration)) el.currentTime = p * el.duration;
  };
  const cycleSpeed = () => {
    const next = (speedIdx + 1) % AUDIO_SPEEDS.length;
    setSpeedIdx(next);
    if (ref.current) ref.current.playbackRate = AUDIO_SPEEDS[next];
  };
  const fmtT = (s: number) => {
    if (!Number.isFinite(s)) s = 0;
    const m = Math.floor(s / 60);
    const ss = Math.floor(s % 60);
    return `${m}:${String(ss).padStart(2, '0')}`;
  };
  const barOn = Math.floor(prog * barsRef.current.length);
  const speedLabel = AUDIO_SPEEDS[speedIdx] === 1 ? '1.0' : String(AUDIO_SPEEDS[speedIdx]);

  return (
    <div>
      {pending ? (
        <div className="mp-audio-pending">
          <span className="mp-audio-pending-dot" />
          待播中——碰一下页面任意处立即播放（浏览器手势解锁）
        </div>
      ) : null}
      <div className={`mp-audio${playing ? ' playing' : ''}`}>
        <audio ref={ref} src={url} preload="metadata" />
        <div className="mp-audio-reel" onClick={toggle} role="button" aria-label={playing ? '暂停' : '播放'} tabIndex={0}>
          <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor">
            {playing ? <path d="M6 5h4v14H6zM14 5h4v14h-4z" /> : <path d="M8 5v14l11-7z" />}
          </svg>
        </div>
        <div className="mp-audio-wavebox">
          <div className="mp-audio-rows">
            <span className="mp-audio-name">{title}</span>
            <span className="mp-audio-meta">{fmtT(t.cur)} / {fmtT(t.dur)}{bytes ? ` · ${fmtBytes(bytes)}` : ''}</span>
          </div>
          <div className="mp-audio-waves" onClick={seek}>
            {barsRef.current.map((h, i) => (
              <div key={i} className={`mp-audio-bar${i <= barOn ? ' on' : ''}`} style={{ height: h }} />
            ))}
          </div>
        </div>
        <button className="mp-audio-speed" onClick={cycleSpeed}>{speedLabel}×</button>
      </div>
    </div>
  );
}

/* ==================== Sheet 卡（csv/tsv 切片 + 翻页/排序/筛选） ==================== */

interface SheetRow { header: string[]; total: number; rows: string[][] }

function SheetView({ id, url, ext }: { id: string; url: string; ext: string }) {
  const [meta, setMeta] = useState<{ header: string[]; totalRows: number } | null>(null);
  const [page, setPage] = useState<SheetRow | null>(null);
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState<{ col: number; dir: 'asc' | 'desc' } | null>(null);
  const [kw, setKw] = useState('');
  const [err, setErr] = useState('');
  const kwRef = useRef('');
  const limit = 50;

  const load = useCallback(async (off: number, s: { col: number; dir: 'asc' | 'desc' } | null, filter: string) => {
    const qs = new URLSearchParams({ offset: String(off), limit: String(limit) });
    if (s) { qs.set('sort', String(s.col)); qs.set('dir', s.dir); }
    if (filter) { qs.set('filter', filter); qs.set('filterCol', '0'); /* 全列筛选在下方做兜底 */ }
    try {
      const r = await fetch(`/api/media/${id}/table?${qs}`, { credentials: 'include' });
      const j = await r.json();
      if (!j.ok) { setErr(String(j.error ?? 'load failed')); return; }
      setErr('');
      setOffset(off);
      setPage({ header: j.header, total: j.total, rows: j.rows });
      if (j.header && !meta) setMeta({ header: j.header, totalRows: j.total });
    } catch (e) {
      setErr(`表格数据加载失败（${(e as Error).message}）——插件服务端半边可能已停用`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => { load(0, null, ''); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);

  if (ext === 'xlsx') {
    return (
      <div>
        <div className="mp-pdf-info" style={{ marginBottom: 8 }}>xlsx 暂不支持在线翻页，可下载后查看（csv/tsv 支持在线交互）。</div>
        <a className="mp-dl-btn" href={url} download>下载 xlsx</a>
      </div>
    );
  }

  const onTh = (i: number) => {
    const s = sort && sort.col === i ? { col: i, dir: sort.dir === 'asc' ? 'desc' as const : 'asc' as const } : { col: i, dir: 'asc' as const };
    setSort(s);
    load(0, s, kwRef.current);
  };
  const onFilter = (v: string) => {
    setKw(v); kwRef.current = v;
    load(0, sort, v);
  };
  const onErr = err ? <div className="mp-err">{err}</div> : null;
  if (!page) return <>{onErr}<div className="mp-code-trunc">加载中…</div></>;

  const cur = offset;
  const prev = () => load(Math.max(0, cur - limit), sort, kwRef.current);
  const next = () => load(cur + limit, sort, kwRef.current);

  return (
    <div>
      <div className="mp-tbl-wrap">
        <table className="mp-tbl">
          <thead>
            <tr>{(page.header ?? []).map((h, i) => (
              <th key={i} onClick={() => onTh(i)}>
                {h}{sort && sort.col === i ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
              </th>
            ))}</tr>
          </thead>
          <tbody>
            {(page.rows ?? []).map((r, ri) => (
              <tr key={ri}>{r.map((c, ci) => <Td key={ci} v={c} />)}</tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mp-sheet-foot">
        <input
          className="mp-filter"
          placeholder="筛选首列…"
          value={kw}
          onChange={(e) => onFilter(e.target.value)}
        />
        <span className="gap" />
        <button className="mp-pgbtn" disabled={cur === 0} onClick={prev} aria-label="上一页">‹</button>
        <span className="mp-pginfo">{cur + 1}-{Math.min(cur + limit, page.total)} / {page.total}</span>
        <button className="mp-pgbtn" disabled={cur + limit >= page.total} onClick={next} aria-label="下一页">›</button>
      </div>
      {onErr}
    </div>
  );
}

/* ==================== 文本卡（截断预览 + 续读） ==================== */

function TextView({ id }: { id: string }) {
  const [state, setState] = useState<{ text: string; total: number } | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`/api/media/${id}/text?limit=${256 * 1024}`, { credentials: 'include' });
        const j = await r.json();
        if (j.ok) setState({ text: j.text, total: j.total });
        else setState({ text: String(j.error ?? 'load failed'), total: 0 });
      } catch (e) { setState({ text: `加载失败（${(e as Error).message}）`, total: 0 }); }
    })();
  }, [id]);
  if (!state) return <div className="mp-code-trunc">加载中…</div>;
  const truncated = state.total > state.text.length;
  return (
    <div className="mp-code">
      <div className="mp-code-head">
        <span>文本预览</span>
        <button
          className="mp-code-copy"
          onClick={() => { if (navigator.clipboard) navigator.clipboard.writeText(state.text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {}); }}
        >{copied ? '已复制' : '复制'}</button>
      </div>
      <div className="mp-code-body">{state.text}</div>
      {truncated ? <div className="mp-code-trunc">… 已截断（前 {Math.round(state.text.length / 1024)}KB / 共 {fmtBytes(state.total)}，防 DOM 爆炸；全量请下载）</div> : null}
    </div>
  );
}

/* ==================== 归档卡（目录树 + 下载） ==================== */

interface ZipEntry { name: string; size: number; dir: boolean }

function ArchiveView({ id }: { id: string }) {
  const [entries, setEntries] = useState<ZipEntry[] | null>(null);
  const [total, setTotal] = useState(0);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`/api/media/${id}/meta`, { credentials: 'include' });
        const j = await r.json();
        if (j.ok && Array.isArray(j.entries)) { setEntries(j.entries); setTotal(Number(j.totalEntries ?? j.entries.length)); }
        else setEntries([]);
      } catch { setEntries([]); }
    })();
  }, [id]);
  if (!entries) return <div className="mp-code-trunc">读取目录…</div>;
  if (!entries.length) return <div className="mp-code-trunc">目录读取失败或为空（rar 等非 zip 不支持列目录），可下载查看。</div>;

  // 按 / 分层折叠：目录为一层、其中文件平铺
  const dirs = new Map<string, ZipEntry[]>();
  for (const e of entries) {
    const i = e.name.indexOf('/');
    if (i < 0) { const a = dirs.get('') ?? []; a.push(e); dirs.set('', a); continue; }
    const d = e.name.slice(0, i);
    const a = dirs.get(d) ?? []; a.push(e); dirs.set(d, a);
  }
  return (
    <div>
      <div className="mp-tree">
        {[...dirs.entries()].map(([d, list]) => (
          <div key={d || '__root__'}>
            {d ? (
              <div className="mp-tree-dir" onClick={() => setOpen((o) => ({ ...o, [d]: !o[d] }))}>
                {open[d] ? '▾' : '▸'} {d}/
              </div>
            ) : null}
            {(d === '' || open[d]) ? (
              <div className="mp-tree-kids">
                {list.map((e, i) => (
                  <div key={i} className="mp-tree-row">
                    <span>{e.name.slice(d ? d.length + 1 : 0)}</span>
                    <span className="mp-tree-sz">{e.dir ? '' : fmtBytes(e.size)}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>
      {total > entries.length ? <div className="mp-code-trunc">… 共 {total} 项，显示前 {entries.length}（截断策略）</div> : null}
    </div>
  );
}

/* ==================== 主组件 ==================== */

export function MediaCard({ callId, title, data }: MediaCardProps) {
  const url = String(data?.url ?? '');
  const id = String(data?.id ?? '');
  const kind = String(data?.kind ?? '');
  const ext = String(data?.ext ?? '');
  const bytes = Number(data?.bytes ?? 0);
  const mime = String(data?.mime ?? '');

  // 伪全屏：popover 元素 + 主视图 DOM 搬运（Esc / Android 返回键收口）
  const fsRef = useRef<HTMLDivElement | null>(null);
  const mainRef = useRef<HTMLDivElement | null>(null);
  const openRef = useRef(false);
  const poppedByBack = useRef(false);
  const restoreParent = useRef<{ parent: HTMLElement; next: Node | null } | null>(null);

  const closeFs = useCallback(() => {
    const el = fsRef.current;
    if (el) {
      try { el.hidePopover(); } catch { /* 幂等容错 */ }
      el.removeAttribute('popover');
    }
    // 主视图搬回消息流原位（组件不卸载：播放进度/表格状态保留）
    const main = mainRef.current;
    const rp = restoreParent.current;
    if (main && rp) {
      try { rp.parent.insertBefore(main, rp.next); } catch { rp.parent.appendChild(main); }
      restoreParent.current = null;
    }
    if (!poppedByBack.current && history.state?.pliteMediaFs) history.back();
    poppedByBack.current = false;
    openRef.current = false;
  }, []);

  const openFs = useCallback(() => {
    const el = fsRef.current;
    const main = mainRef.current;
    if (!el || !main) return;
    if (typeof (el as unknown as { showPopover?: unknown }).showPopover !== 'function') return;
    restoreParent.current = { parent: main.parentElement!, next: main.nextSibling };
    const stage = el.querySelector('.mp-fs-stage');
    try {
      el.setAttribute('popover', 'manual');
      el.showPopover();
      stage?.appendChild(main);
      history.pushState({ pliteMediaFs: true }, '');
    } catch { return; }
    openRef.current = true;
  }, []);

  useEffect(() => {
    const onPop = () => { if (openRef.current) { poppedByBack.current = true; closeFs(); } };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && openRef.current) closeFs(); };
    window.addEventListener('popstate', onPop);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('popstate', onPop); window.removeEventListener('keydown', onKey); };
  }, [closeFs]);

  if (!url) {
    return <div className="mp-missing">媒体推送缺少 url（{title}）</div>;
  }

  // ---- 主视图（全屏时整个被搬走） ----
  let body: React.ReactNode = null;
  if (kind === 'image') {
    body = <div className="mp-media"><img className="mp-img" src={url} alt={title} loading="lazy" decoding="async" /></div>;
  } else if (kind === 'video') {
    body = <div className="mp-media"><video className="mp-video" src={url} controls preload="metadata" playsInline /></div>;
  } else if (kind === 'audio') {
    body = <AudioDeck url={url} title={title} bytes={bytes} />;
  } else if (kind === 'sheet') {
    body = id ? <SheetView id={id} url={url} ext={ext} /> : <a className="mp-dl-btn" href={url} download>下载</a>;
  } else if (kind === 'pdf') {
    body = (
      <div className="mp-pdf">
        <div className="mp-pdf-icon">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="rgba(192,57,47,0.9)" strokeWidth="1.6" strokeLinecap="round"><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M14 3h7v7" /><path d="M10 13v4M9.5 13h1.5a1.5 1.5 0 0 1 0 3H9.5" /></svg>
        </div>
        <div className="mp-pdf-info">PDF 文档{mime ? ` · ${fmtBytes(bytes)}` : ''}</div>
        <a className="mp-dl-btn" href={url} download>下载</a>
      </div>
    );
  } else if (kind === 'text') {
    body = id ? <TextView id={id} /> : <a className="mp-dl-btn" href={url} download>下载</a>;
  } else if (kind === 'archive') {
    body = (
      <div>
        {id ? <ArchiveView id={id} /> : null}
        <div style={{ marginTop: 8 }}><a className="mp-dl-btn" href={url} download>下载</a></div>
      </div>
    );
  } else {
    body = (
      <div className="mp-pdf">
        <div className="mp-pdf-info">未知类型（{mime || ext || 'bin'}）· {fmtBytes(bytes)}</div>
        <a className="mp-dl-btn" href={url} download>下载</a>
      </div>
    );
  }

  const kindLabel = kind.toUpperCase();
  return (
    <>
      <figure className="mp-card" data-callid={callId} data-kind={kind}>
        <div className="mp-head">
          <i className="mp-dot" style={{ background: KIND_COLOR[kind] ?? KIND_COLOR.other }} />
          <span className="mp-title">{title}</span>
          <span className="mp-meta">{kindLabel}{bytes ? ` · ${fmtBytes(bytes)}` : ''}</span>
          <button className="mp-full-btn" onClick={openFs}>全屏</button>
        </div>
        <div ref={mainRef} className="mp-body">{body}</div>
      </figure>
      <div ref={fsRef} className="mp-fs" aria-label={title}>
        <div className="mp-fs-bar">
          <i className="mp-dot" style={{ background: KIND_COLOR[kind] ?? KIND_COLOR.other }} />
          <span className="mp-title">{title}</span>
          <span className="mp-meta">{kindLabel}{bytes ? ` · ${fmtBytes(bytes)}` : ''}</span>
          <button className="mp-fs-close" onClick={closeFs}>退出全屏</button>
        </div>
        <div className="mp-fs-stage" />
      </div>
    </>
  );
}
