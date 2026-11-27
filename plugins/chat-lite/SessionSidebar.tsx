/** 会话侧栏：克制的内容目录 + 行内删除确认 + 会话工作区设置入口 + 多设备同步状态。
 *  v2：手动刷新（立即对账）+ 「执行中」徽标（服务端 loop 运行态，跨设备可见）。
 *  v3（spec v0.2）：冷启动引导进度（x/y）——服务端为权威，本地镜像只是缓存，
 *  空列表 ≠ 无会话；三操作按钮 class 语义化（原共用 chat-session-del 是命名债）。
 *  v4（2026-11-22 移动端优化）：搜索框 + 时间分组（今天/7天内/更早，80+ 会话平铺找不到）；
 *  窄屏行内小图标收进「⋮」动作菜单（触控目标从 22-30px 提到 44px 级）；
 *  触屏长按会话行唤出同一菜单（iOS/安卓原生习惯）。 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSessionStore, acceptServerVersion, forceOverrideServer, refreshNow, isToolCard } from './store';
import { PlusIcon, TrashIcon, FolderIcon, RefreshIcon, PencilIcon, CloseIcon, PinIcon } from './icons';
import { WorkspacePicker } from './WorkspacePicker';

/** 浮层根：宿主 SlotLayout 提供的 fixed 覆盖层（空态 pointer-events:none 放行，子元素恢复 auto）。
 *  侧栏 .chat-sessions 是滚动容器（无限滚动后长列表常滚离顶部），就地 absolute 渲染的
 *  遮罩会随内容滚出视口（「面板留在上面」bug），故动作单/工作区弹层与消息侧动作单
 *  一样经 portal 挂这里锚定视口。 */
function overlayRoot(): HTMLElement | null {
  return document.getElementById('plite-overlay-root');
}
/** 同步状态点：多设备共享的可感知性（offline/conflict 才醒目，idle/syncing 弱化） */
function SyncDot() {
  const status = useSessionStore((s) => s.syncStatus);
  const label = status === 'offline' ? '离线：改动将在恢复连接后同步'
    : status === 'conflict' ? '与服务端存在冲突，请处理'
    : status === 'syncing' ? '同步中…' : '已同步';
  return (
    <span className={`chat-sync-dot chat-sync-${status}`} title={label} aria-label={label}>
      <i />
    </span>
  );
}

/** 冲突提示条：409 后出现，二选一（以服务端为准 / 覆盖服务端） */
function ConflictBanner() {
  const conflicts = useSessionStore((s) => s.conflicts);
  const sessions = useSessionStore((s) => s.sessions);
  const ids = Object.keys(conflicts);
  if (ids.length === 0) return null;
  const titleOf = (id: string) => {
    const s = sessions.find((x) => x.id === id);
    if (!s) return id;
    return s.title !== '新会话' ? s.title : (s.messages[0]?.content?.slice(0, 18) ?? id);
  };
  return (
    <div className="chat-sync-conflict" role="alert">
      {ids.map((id) => (
        <div key={id} className="chat-sync-conflict-item">
          <span>「{titleOf(id)}」在另一台设备有更新。</span>
          <button onClick={() => void acceptServerVersion(id)}>以服务端为准</button>
          <button className="primary" onClick={() => void forceOverrideServer(id)}>覆盖服务端</button>
        </div>
      ))}
    </div>
  );
}

function displayTitle(title: string, firstMessage: string | undefined): string {
  if (title !== '新会话') return title;
  return firstMessage ? firstMessage.slice(0, 18) : title;
}

// ---- 时间分组（P0-4）：列表顺序已按创建时间倒序，桶顺序天然递增 ----
// pinned 桶（2026-11-27）：置顶会话独立成组常驻最前；filtered 沿用 store 的
// sortSessions 结果（置顶组在前），桶内顺序无需再排。
type GroupKey = 'pinned' | 'today' | 'week' | 'older';
const BUCKET_ORDER: GroupKey[] = ['pinned', 'today', 'week', 'older'];
const BUCKET_LABEL: Record<GroupKey, string> = { pinned: '置顶', today: '今天', week: '7 天内', older: '更早' };

function bucketOf(ts: number): Exclude<GroupKey, 'pinned'> {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  if (ts >= startOfDay.getTime()) return 'today';
  if (ts >= Date.now() - 7 * 86_400_000) return 'week';
  return 'older';
}

function MoreIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="5" r="1.6" fill="currentColor" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" />
      <circle cx="12" cy="19" r="1.6" fill="currentColor" />
    </svg>
  );
}

export function SessionSidebar() {
  const sessions = useSessionStore((s) => s.sessions);
  const activeId = useSessionStore((s) => s.activeId);
  const syncStatus = useSessionStore((s) => s.syncStatus);
  const bootstrap = useSessionStore((s) => s.bootstrap);
  const runningLoops = useSessionStore((s) => s.runningLoops);
  const setActive = useSessionStore((s) => s.setActive);
  const createSession = useSessionStore((s) => s.createSession);
  const deleteSession = useSessionStore((s) => s.deleteSession);
  const renameSession = useSessionStore((s) => s.renameSession);
  const togglePinSession = useSessionStore((s) => s.togglePinSession);
  const setSessionWorkspace = useSessionStore((s) => s.setSessionWorkspace);
  const setSessionLinkedWorkspaces = useSessionStore((s) => s.setSessionLinkedWorkspaces);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  /** 行内重命名（悬浮铅笔按钮或双击标题；Enter/失焦保存，Esc 取消） */
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  /** 正在设置工作区的会话 id（弹层） */
  const [wsPickerFor, setWsPickerFor] = useState<string | null>(null);
  /** 手动刷新进行中（按钮旋转/禁用态） */
  const [refreshing, setRefreshing] = useState(false);
  /** 会话搜索词（P0-4） */
  const [query, setQuery] = useState('');
  /** 动作菜单打开中的会话 id（窄屏 ⋮ / 长按唤出） */
  const [menuFor, setMenuFor] = useState<string | null>(null);
  /** 长按计时器 + 长按生效时间戳（吞掉随后 600ms 内的 click，否则松手即切会话；自过期防残留） */
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressedUntil = useRef(0);

  const pickedSession = sessions.find((s) => s.id === wsPickerFor);
  const menuSession = sessions.find((s) => s.id === menuFor);

  const startRename = (id: string) => {
    const s = sessions.find((x) => x.id === id);
    if (!s) return;
    setRenaming({ id, value: s.title });
  };
  const saveRename = () => {
    if (!renaming) return;
    const v = renaming.value.trim();
    const s = sessions.find((x) => x.id === renaming.id);
    if (s && v && v !== s.title) renameSession(renaming.id, v);
    setRenaming(null);
  };

  const doRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try { await refreshNow(); } finally { setRefreshing(false); }
  };

  // ---- 搜索过滤（P0-4）：标题 + 首条消息全文，客户端过滤零成本 ----
  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!q) return sessions;
    return sessions.filter((s) => `${s.title} ${s.messages[0]?.content ?? ''}`.toLowerCase().includes(q));
  }, [sessions, q]);

  // ---- 时间分组（无搜索词时）：今天 / 7 天内 / 更早（按创建时间，与排序口径一致） ----
  const grouped = useMemo(() => {
    const map: Record<GroupKey, typeof sessions> = { pinned: [], today: [], week: [], older: [] };
    for (const s of filtered) map[s.pinned ? 'pinned' : bucketOf(s.createdAt)].push(s);
    return map;
  }, [filtered]);

  const clearPress = () => {
    if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null; }
  };

  // ---- 无限滚动（2026-11-22）：长列表不全量渲染，触底自动追加一批 ----
  // 行级全局切片：把「已显示总数」额度按桶顺序分摊（前面的桶用满才轮到后面）。
  // 搜索词 / 会话数量变化时重置；纯前端切片，不动同步层。
  const PAGE = 20;
  const [visibleCount, setVisibleCount] = useState(PAGE);
  useEffect(() => { setVisibleCount(PAGE); }, [q, sessions.length]);

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) setVisibleCount((v) => v + PAGE);
    }, { root: el.closest('.chat-sessions'), rootMargin: '160px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  /** 对各桶做行级切片：全局可见额度按顺序分配 */
  const capBuckets = (lists: (typeof sessions)[]): (typeof sessions)[] => {
    let budget = visibleCount;
    return lists.map((list) => {
      const take = list.slice(0, budget);
      budget -= take.length;
      return take;
    });
  };
  const cappedGrouped = useMemo(
    () => capBuckets(BUCKET_ORDER.map((b) => grouped[b])),
    [grouped, visibleCount],
  );
  const totalVisible = cappedGrouped.reduce((n, l) => n + l.length, 0);
  const hasMore = totalVisible < filtered.length;
  /** 触屏长按会话行 → 动作菜单（与 ⋮ 同一菜单；P1-8 的重命名入口即菜单第一项） */
  const onRowPointerDown = (id: string, e: React.PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    clearPress();
    pressTimer.current = setTimeout(() => {
      longPressedUntil.current = Date.now() + 600;
      setMenuFor(id);
    }, 500);
  };
  const onRowPointerUp = () => clearPress();
  const onRowClick = (id: string) => {
    if (Date.now() < longPressedUntil.current) return; // 长按松手随行的 click 不切会话
    setActive(id);
  };

  const renderRow = (s: (typeof sessions)[number]) => {
    const run = runningLoops[s.id];
    const stale = run ? Date.now() - run.lastBeat > 20_000 : false;
    // 本机流式（直连引擎通道，无服务端 loop）：本机可见的「生成中」弱标记。
    // 与 run 徽标互斥：runner 编排会话有权威徽标，直连会话用本地呼吸点。
    const streamingLocal = !run && s.messages.some((m) => !isToolCard(m) && m.streaming);
    const isRenaming = renaming?.id === s.id;
    return (
      <div
        key={s.id}
        className={`chat-session-item ${s.id === activeId ? 'active' : ''}${s.pinned ? ' pinned' : ''}`}
        onClick={() => onRowClick(s.id)}
        onPointerDown={(e) => onRowPointerDown(s.id, e)}
        onPointerUp={onRowPointerUp}
        onPointerLeave={onRowPointerUp}
        onPointerCancel={onRowPointerUp}
        onContextMenu={(e) => e.preventDefault()}
      >
        {s.pinned && <span className="chat-session-pinmark" title="已置顶" aria-hidden="true"><PinIcon filled /></span>}
        <span className="title" onDoubleClick={() => startRename(s.id)}>
          {isRenaming ? (
            <input
              className="chat-rename-input"
              value={renaming.value}
              autoFocus
              onFocus={(e) => e.target.select()}
              aria-label="重命名会话"
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setRenaming({ id: s.id, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); saveRename(); }
                else if (e.key === 'Escape') { e.preventDefault(); setRenaming(null); }
              }}
              onBlur={saveRename}
            />
          ) : (
            <>
              {displayTitle(s.title, s.messages[0]?.content)}
              {s.workspaceId && <span className="chat-session-ws" title={`工作区：${s.workspaceId}`}>⌂</span>}
            </>
          )}
        </span>
        {run && (
          <span
            className={`chat-run-badge${stale ? ' stale' : ''}`}
            title={stale
              ? '执行端心跳超时，即将回收'
              : `${run.device} 发起 · 已执行 ${Math.max(1, Math.round((Date.now() - run.startedAt) / 1000))}s`}
          >
            <i className="chat-run-dot" />执行中
          </span>
        )}
        {streamingLocal && (
          <span className="chat-run-badge local" title="本机正在生成回复（直连引擎，其他设备不可见）">
            <i className="chat-run-dot" />生成中
          </span>
        )}
        {confirmId === s.id ? (
          <span className="chat-session-confirm" onClick={(e) => e.stopPropagation()}>
            <span>删除？</span>
            <button className="danger" onClick={() => { deleteSession(s.id); setConfirmId(null); }}>确认</button>
            <button onClick={() => setConfirmId(null)}>取消</button>
          </span>
        ) : (
          <>
            {!isRenaming && <span className="chat-session-count">{s.messages.length}</span>}
            {/* 桌面：行内三图标（hover 浮现）；窄屏：CSS 隐藏图标、显示 ⋮（44px 命中区） */}
            <span className="chat-session-actions">
              {!isRenaming && (
                <button
                  className="chat-session-act chat-session-pin"
                  title={s.pinned ? '取消置顶' : '置顶（常驻列表最前）'}
                  aria-label={`${s.pinned ? '取消置顶' : '置顶'} ${displayTitle(s.title, s.messages[0]?.content)}`}
                  onClick={(e) => { e.stopPropagation(); togglePinSession(s.id); }}
                >
                  <PinIcon filled={s.pinned} />
                </button>
              )}
              {!isRenaming && (
                <button
                  className="chat-session-act chat-session-rename"
                  title="重命名（双击标题同效）"
                  aria-label={`重命名会话 ${displayTitle(s.title, s.messages[0]?.content)}`}
                  onClick={(e) => { e.stopPropagation(); startRename(s.id); }}
                >
                  <PencilIcon />
                </button>
              )}
              <button
                className="chat-session-act chat-session-folder"
                title="设置工作区"
                aria-label={`设置工作区 ${displayTitle(s.title, s.messages[0]?.content)}`}
                onClick={(e) => { e.stopPropagation(); setWsPickerFor(s.id); }}
              >
                <FolderIcon />
              </button>
              <button
                className="chat-session-act chat-session-trash"
                title="删除会话"
                aria-label={`删除会话 ${displayTitle(s.title, s.messages[0]?.content)}`}
                onClick={(e) => { e.stopPropagation(); setConfirmId(s.id); }}
              >
                <TrashIcon />
              </button>
            </span>
            <button
              type="button"
              className="chat-session-kebab"
              aria-label={`会话操作 ${displayTitle(s.title, s.messages[0]?.content)}`}
              aria-haspopup="menu"
              onClick={(e) => { e.stopPropagation(); setMenuFor(s.id); }}
            >
              <MoreIcon />
            </button>
          </>
        )}
      </div>
    );
  };

  return (
    <div className="chat-sessions" data-testid="session-sidebar">
      <div className="chat-sessions-head">
        <span>对话目录</span>
        <span className="chat-sessions-head-right">
          <SyncDot />
          <button
            className={`chat-sessions-refresh${refreshing ? ' spinning' : ''}`}
            title={refreshing ? '对账中…' : '立即刷新（对账服务端）'}
            aria-label="刷新会话列表"
            disabled={refreshing || syncStatus === 'offline'}
            onClick={() => void doRefresh()}
          >
            <RefreshIcon />
          </button>
          {/* 冷启动引导期显示 x/y（本地是缓存、服务端为权威——裸数字 00 会误导为「全丢了」） */}
          {bootstrap ? `${bootstrap.done}/${bootstrap.total}` : String(sessions.length).padStart(2, '0')}
        </span>
      </div>
      <ConflictBanner />
      <button className="chat-session-new" onClick={() => createSession()}>
        <PlusIcon /><span>新会话</span>
      </button>

      {sessions.length > 0 && (
        <input
          className="chat-session-search"
          type="search"
          placeholder="搜索会话…"
          aria-label="搜索会话"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}

      {sessions.length === 0 && (
        <div className="chat-sessions-empty">
          {bootstrap && bootstrap.total > 0 ? (
            <>
              <strong>正在同步会话…</strong>
              <span>{bootstrap.done}/{bootstrap.total} 条记录从服务端加载，</span>
              <span>列表马上就好。</span>
            </>
          ) : (
            <>
              <strong>尚无对话记录</strong>
              <span>从一个想法开始，<br />这里会留下你的思考轨迹。</span>
            </>
          )}
        </div>
      )}

      {sessions.length > 0 && filtered.length === 0 && (
        <div className="chat-sessions-empty"><strong>无匹配会话</strong><span>换个关键词试试。</span></div>
      )}

      {q ? (
        <div className="chat-session-list">{filtered.slice(0, visibleCount).map(renderRow)}</div>
      ) : (
        cappedGrouped.map((rows, i) =>
          rows.length > 0 ? (
            <div className="chat-session-group-wrap" key={BUCKET_ORDER[i]}>
              <div className="chat-session-group">{BUCKET_LABEL[BUCKET_ORDER[i]]}</div>
              <div className="chat-session-list">{rows.map(renderRow)}</div>
            </div>
          ) : null,
        )
      )}
      {hasMore && (
        <div className="chat-session-sentinel" ref={sentinelRef} aria-hidden="true" />
      )}

      {/* 窄屏会话动作菜单（⋮ / 长按唤出）：底部 sheet，触控目标 44px 级。
          删除仍走行内两步确认（选删除后菜单关闭、该行原地出确认条）。 */}
      {menuSession && (() => {
        const root = overlayRoot();
        return root ? createPortal(
        <div className="chat-sheet-mask" onClick={() => setMenuFor(null)}>
          <div className="chat-sheet" role="menu" aria-label="会话操作" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="chat-sheet-topbar" aria-label="返回" onClick={() => setMenuFor(null)}>
              <span className="chat-sheet-topbar-back">‹</span>
              <span className="chat-sheet-topbar-title">会话操作</span>
              <CloseIcon />
            </button>
            <div className="chat-sheet-title">{displayTitle(menuSession.title, menuSession.messages[0]?.content)}</div>
            <button
              type="button"
              className="chat-sheet-item"
              role="menuitem"
              onClick={() => { togglePinSession(menuSession.id); setMenuFor(null); }}
            >
              <PinIcon filled={menuSession.pinned} /><span>{menuSession.pinned ? '取消置顶' : '置顶'}</span>
            </button>
            <button
              type="button"
              className="chat-sheet-item"
              role="menuitem"
              onClick={() => { startRename(menuSession.id); setMenuFor(null); }}
            >
              <PencilIcon /><span>重命名</span>
            </button>
            <button
              type="button"
              className="chat-sheet-item"
              role="menuitem"
              onClick={() => { setWsPickerFor(menuSession.id); setMenuFor(null); }}
            >
              <FolderIcon /><span>设置工作目录</span>
            </button>
            <button
              type="button"
              className="chat-sheet-item danger"
              role="menuitem"
              onClick={() => { setConfirmId(menuSession.id); setMenuFor(null); }}
            >
              <TrashIcon /><span>删除会话</span>
            </button>
            <button type="button" className="chat-sheet-cancel" onClick={() => setMenuFor(null)}>取消</button>
          </div>
        </div>,
        root,
        ) : null;
      })()}

      {pickedSession && (() => {
        const root = overlayRoot();
        return root ? createPortal(
        <WorkspacePicker
          session={pickedSession}
          onPick={(workspaceId) => { setSessionWorkspace(pickedSession.id, workspaceId); setWsPickerFor(null); }}
          onToggleLinked={(id) => {
            const cur = pickedSession.linkedWorkspaceIds ?? [];
            const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id].slice(0, 3);
            setSessionLinkedWorkspaces(pickedSession.id, next);
          }}
          onClose={() => setWsPickerFor(null)}
        />,
        root,
        ) : null;
      })()}
    </div>
  );
}
