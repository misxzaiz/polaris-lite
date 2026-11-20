/**
 * 工作目录选择器·内容体（无遮罩、无绝对定位），供两处复用：
 * - 输入区抽屉第二级（inline，抽屉定高、本体内滚动）
 * - 会话侧栏弹层（dialog，遮罩由 WorkspacePicker 提供）
 *
 * 交互分层：
 *   list 视图 = 当前目录卡 + 最近使用 + [主目录|关联只读] 列表 + 底部（浏览 / 新对话默认 / 跟随全局）
 *   browse 视图 = 面包屑 + 仅文件夹列表 + 「使用此文件夹」
 *
 * 服务端仍是唯一裁判：登记、白名单、realPath 校验都在 /api/fs/roots* 完成；
 * 本组件不拼路径、不猜 id（旧实现用 path.includes(label) 匹配，同名目录会误绑）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FolderIcon, CheckIcon } from './icons';
import {
  loadWorkspacePrefs, pushRecentWorkspace, saveWorkspacePrefs, onRootsChanged,
} from './workspace-prefs';

export interface RootRow {
  id: string;
  label: string;
  path: string;
  builtin?: boolean;
  missing?: boolean;
}

interface TreeNode {
  name: string;
  isDir: boolean;
  path: string;
  isRoot?: boolean;
  isDrive?: boolean;
  missing?: boolean;
}

export interface WorkspacePickerBodyProps {
  /** 当前会话主目录 root id（undefined = 跟随全局） */
  workspaceId?: string;
  /** 关联只读目录 */
  linkedWorkspaceIds?: string[];
  onPickMain: (workspaceId: string | undefined) => void;
  onToggleLinked: (workspaceId: string) => void;
  /** 选择完成后是否自动收起（抽屉里选主目录后收起；关联多选不收起） */
  closeOnPickMain?: boolean;
  onRequestClose?: () => void;
  /** 生成中禁止切换（本轮 cwd 已定，改了会造成误解） */
  locked?: boolean;
  lockedHint?: string;
}

const LINK_LIMIT = 3;

export function WorkspacePickerBody({
  workspaceId,
  linkedWorkspaceIds,
  onPickMain,
  onToggleLinked,
  closeOnPickMain = true,
  onRequestClose,
  locked = false,
  lockedHint = '本轮生成中，结束后可切换',
}: WorkspacePickerBodyProps) {
  const [roots, setRoots] = useState<RootRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState<'main' | 'linked'>('main');
  const [view, setView] = useState<'list' | 'browse'>('list');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  /** 浏览态：当前绝对路径（''=顶层：盘符 + 已登记根） */
  const [dir, setDir] = useState('');
  const [nodes, setNodes] = useState<TreeNode[]>([]);
  const [roamBlocked, setRoamBlocked] = useState(false);
  const [browseLoading, setBrowseLoading] = useState(false);
  /** 导航在途（立即置位，只用于挡住重复点击，不触发任何视觉变化） */
  const [navBusy, setNavBusy] = useState(false);
  /** 请求序号：后发先至时丢弃旧响应，避免连点回退到上一层 */
  const seqRef = useRef(0);
  const busyTimerRef = useRef<number | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [prefs, setPrefs] = useState(() => loadWorkspacePrefs());

  const refreshRoots = useCallback(async () => {
    try {
      const r = await fetch('/api/fs/roots', { credentials: 'include' });
      const j = (await r.json().catch(() => null)) as { roots?: RootRow[] } | null;
      setRoots(j?.roots ?? []);
    } catch {
      setRoots([]);
    } finally {
      setLoaded(true);
    }
  }, []);

  // 首次加载 + 根表变化（改名/登记/删除由 file-browser 广播）时同步
  useEffect(() => { void refreshRoots(); }, [refreshRoots]);
  useEffect(() => onRootsChanged(() => { void refreshRoots(); setPrefs(loadWorkspacePrefs()); }), [refreshRoots]);

  const current = useMemo(() => roots.find((r) => r.id === workspaceId), [roots, workspaceId]);
  const linked = linkedWorkspaceIds ?? [];
  const recent = useMemo(
    () => prefs.recentWorkspaceIds
      .map((id) => roots.find((r) => r.id === id))
      .filter((r): r is RootRow => !!r && !r.missing)
      .slice(0, 3),
    [prefs.recentWorkspaceIds, roots],
  );

  /** 当前目录卡的状态：绑定失效必须说出来，不能静默回默认 */
  const currentMissing = !!workspaceId && loaded && !current;
  const currentName = workspaceId
    ? (current?.label ?? '已失效的目录')
    : '默认目录';
  const currentPath = workspaceId
    ? (current?.path ?? '（该目录已不在登记表中，本轮会回退到默认目录）')
    : '内建 workspace（跟随全局工作区）';

  const pickMain = (id: string | undefined) => {
    if (locked) { setErr(lockedHint); return; }
    onPickMain(id);
    if (id) pushRecentWorkspace(id);
    if (closeOnPickMain) onRequestClose?.();
  };

  const toggleLink = (id: string) => {
    if (locked) { setErr(lockedHint); return; }
    onToggleLinked(id);
  };

  const toggleDefault = () => {
    if (locked) { setErr(lockedHint); return; }
    if (!workspaceId) { setErr('先选一个具体目录，再设为新对话默认'); return; }
    const on = prefs.defaultWorkspaceId === workspaceId;
    const next = saveWorkspacePrefs({ defaultWorkspaceId: on ? undefined : workspaceId });
    setPrefs(next);
    setErr('');
  };

  /**
   * 浏览：逐层列目录（仅文件夹）；sessionRoam 关闭时只剩顶层根可选。
   *
   * 防闪三条：
   * 1. 面包屑 / 底部路径**先**跟着点击走（乐观更新），不等网络；
   * 2. **不清空旧列表**——旧行留在原地，只用延迟 150ms 的忙碌态做提示。
   *    本地目录通常几十毫秒就回来，清空重建会看到「塌陷再弹回」的一闪；
   * 3. 请求带序号，后发先至时丢旧响应（连点两层不会回退到错的目录）。
   */
  const loadDir = useCallback(async (next: string) => {
    const seq = ++seqRef.current;
    setErr('');
    setDir(next);
    setNavBusy(true);
    if (listRef.current) listRef.current.scrollTop = 0;
    if (busyTimerRef.current !== null) window.clearTimeout(busyTimerRef.current);
    busyTimerRef.current = window.setTimeout(() => {
      if (seqRef.current === seq) setBrowseLoading(true);
    }, 150);
    try {
      const r = await fetch(`/api/fs/tree?dir=${encodeURIComponent(next)}`, { credentials: 'include' });
      const j = (await r.json().catch(() => null)) as { nodes?: TreeNode[]; sessionRoam?: boolean } | null;
      if (seq !== seqRef.current) return;
      if (!r.ok) {
        // 漫游被禁用：留在顶层，让用户从已登记根里选，或用手输路径兜底
        setRoamBlocked(true);
        setDir('');
        const top = await fetch('/api/fs/tree', { credentials: 'include' });
        const tj = (await top.json().catch(() => null)) as { nodes?: TreeNode[] } | null;
        if (seq !== seqRef.current) return;
        setNodes((tj?.nodes ?? []).filter((n) => n.isDir));
        setErr(next ? '当前环境只允许浏览已登记目录，可用「输入路径」直接登记' : '');
        return;
      }
      setRoamBlocked(false);
      setNodes((j?.nodes ?? []).filter((n) => n.isDir));
    } catch {
      if (seq === seqRef.current) setErr('目录读取失败');
    } finally {
      if (seq === seqRef.current) {
        if (busyTimerRef.current !== null) { window.clearTimeout(busyTimerRef.current); busyTimerRef.current = null; }
        setBrowseLoading(false);
        setNavBusy(false);
      }
    }
  }, []);

  // 卸载时清掉延迟计时器，避免对已卸载组件 setState
  useEffect(() => () => { if (busyTimerRef.current !== null) window.clearTimeout(busyTimerRef.current); }, []);

  const enterBrowse = () => {
    setView('browse');
    // 进入浏览的第一帧先拿「已登记根」垫着：否则列表是空的，等接口回来才长出内容，
    // 这一下空白就是最容易被注意到的那种闪。真实响应到达后按 path 覆盖。
    if (nodes.length === 0 && roots.length > 0) {
      setNodes(roots.map((r) => ({
        name: r.label, isDir: true, path: r.path, isRoot: true, missing: r.missing,
      })));
    }
    void loadDir('');
  };

  /** 把浏览到的目录一步登记并绑定（服务端返回后按 path 精确匹配，不用 label 猜） */
  const useCurrentDir = async () => {
    if (!dir) { setErr('请先进入一个文件夹'); return; }
    setBusy(true);
    setErr('');
    try {
      const r = await fetch('/api/fs/roots/from-path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ path: dir }),
      });
      const j = (await r.json().catch(() => null)) as { roots?: RootRow[]; error?: string } | null;
      if (!r.ok) { setErr(j?.error ?? '登记失败'); return; }
      const list = j?.roots ?? [];
      setRoots(list);
      const norm = (s: string) => s.replace(/[\\/]+$/, '').toLowerCase();
      const match = list.find((x) => norm(x.path) === norm(dir));
      if (match) {
        pickMain(match.id);
        setView('list');
      } else {
        setErr('已登记，但未能定位该目录，请从列表中选择');
        setView('list');
      }
    } catch {
      setErr('登记请求失败');
    } finally {
      setBusy(false);
    }
  };

  /** 面包屑：按分隔符切段，点某段回到该层 */
  const crumbs = useMemo(() => {
    if (!dir) return [] as { label: string; path: string }[];
    const parts = dir.split(/[\\/]/).filter(Boolean);
    const sep = dir.includes('\\') ? '\\' : '/';
    const out: { label: string; path: string }[] = [];
    parts.forEach((p, i) => {
      const path = i === 0 ? `${parts[0]}${sep}` : `${out[i - 1].path}${out[i - 1].path.endsWith(sep) ? '' : sep}${p}`;
      out.push({ label: p, path });
    });
    return out;
  }, [dir]);

  if (view === 'browse') {
    return (
      <div className="wpb wpb-browse" data-testid="workspace-browse">
        <div className="wpb-browse-head">
          <button className="wpb-back" onClick={() => { setView('list'); setErr(''); }}>返回</button>
          <div className="wpb-crumbs">
            <button className="wpb-crumb" onClick={() => void loadDir('')}>根</button>
            {crumbs.map((c) => (
              <button key={c.path} className="wpb-crumb" onClick={() => void loadDir(c.path)}>{c.label}</button>
            ))}
          </div>
        </div>
        <div
          ref={listRef}
          className={`wpb-list ${browseLoading ? 'is-busy' : ''}`}
          aria-busy={navBusy}
        >
          {nodes.map((n) => (
            <button
              key={n.path}
              className={`wpb-row wpb-dir ${n.missing ? 'missing' : ''}`}
              onClick={() => void loadDir(n.path)}
              disabled={n.missing}
              title={n.path}
            >
              <FolderIcon />
              <span className="wpb-row-name">{n.name}{n.isDrive ? '' : n.isRoot ? ' · 已登记' : ''}</span>
            </button>
          ))}
          {/* 只有「慢到需要提示」时才出现，且只在列表本来就空时占位——不会顶掉已渲染的行 */}
          {browseLoading && nodes.length === 0 && <div className="wpb-empty">读取中…</div>}
          {!navBusy && nodes.length === 0 && <div className="wpb-empty">没有子文件夹</div>}
        </div>
        <div className="wpb-foot">
          <span className="wpb-foot-path" title={dir}>{dir || (roamBlocked ? '仅可浏览已登记目录' : '选一个文件夹')}</span>
          <button className="wpb-primary" onClick={() => void useCurrentDir()} disabled={!dir || busy || locked}>
            {busy ? '登记中…' : '使用此文件夹'}
          </button>
        </div>
        {err && <div className="wpb-err">{err}</div>}
      </div>
    );
  }

  return (
    <div className="wpb" data-testid="workspace-picker-body">
      <div className={`wpb-current ${currentMissing ? 'invalid' : ''}`}>
        <div className="wpb-current-line">
          <span className="wpb-current-name" title={currentPath}>{currentName}</span>
          <span className="wpb-current-tag">仅本对话</span>
        </div>
        <div className="wpb-current-path" title={currentPath}>{currentPath}</div>
        {currentMissing && <div className="wpb-warn">该目录已失效，本轮会回退到默认目录，请重新选择。</div>}
      </div>

      {recent.length > 0 && (
        <div className="wpb-recent">
          <span className="wpb-label">最近</span>
          {recent.map((r) => (
            <button
              key={r.id}
              className={`wpb-chip ${r.id === workspaceId ? 'on' : ''}`}
              onClick={() => pickMain(r.id)}
              disabled={locked}
              title={r.path}
            >
              {r.label}
            </button>
          ))}
        </div>
      )}

      <div className="wpb-tabs" role="tablist">
        <button
          role="tab" aria-selected={tab === 'main'}
          className={`wpb-tab ${tab === 'main' ? 'on' : ''}`}
          onClick={() => setTab('main')}
        >主目录</button>
        <button
          role="tab" aria-selected={tab === 'linked'}
          className={`wpb-tab ${tab === 'linked' ? 'on' : ''}`}
          onClick={() => setTab('linked')}
        >关联只读{linked.length > 0 ? ` ${linked.length}` : ''}</button>
      </div>

      <div className="wpb-list">
        {tab === 'main' && (
          <>
            <button
              className={`wpb-row ${!workspaceId ? 'active' : ''}`}
              onClick={() => pickMain(undefined)}
              disabled={locked}
            >
              <span className="wpb-row-name">跟随全局默认</span>
              <span className="wpb-row-path">内建 workspace / 全局工作区</span>
              {!workspaceId && <span className="wpb-check"><CheckIcon /></span>}
            </button>
            {roots.map((r) => (
              <button
                key={r.id}
                className={`wpb-row ${workspaceId === r.id ? 'active' : ''} ${r.missing ? 'missing' : ''}`}
                onClick={() => pickMain(r.id)}
                disabled={r.missing || locked}
                title={r.path}
              >
                <span className="wpb-row-name">{r.label}</span>
                <span className="wpb-row-path">{r.missing ? '目录不存在' : r.path}</span>
                {workspaceId === r.id && <span className="wpb-check"><CheckIcon /></span>}
              </button>
            ))}
            {loaded && roots.length === 0 && <div className="wpb-empty">还没有可选的目录，可从「浏览文件夹」添加。</div>}
          </>
        )}

        {tab === 'linked' && (
          <>
            <div className="wpb-note">可读、不可写；命令仍在主目录执行。</div>
            {roots.map((r) => {
              const on = linked.includes(r.id);
              const isMain = r.id === workspaceId;
              const full = !on && linked.length >= LINK_LIMIT;
              return (
                <button
                  key={r.id}
                  className={`wpb-row ${on ? 'active' : ''} ${r.missing || isMain || full ? 'disabled' : ''}`}
                  onClick={() => !isMain && !full && !r.missing && toggleLink(r.id)}
                  disabled={isMain || full || r.missing || locked}
                  title={isMain ? '这是主目录' : r.path}
                >
                  <span className="wpb-row-name">{r.label}</span>
                  <span className="wpb-row-path">{isMain ? '主目录 · 已在执行范围' : r.missing ? '目录不存在' : r.path}</span>
                  {on && <span className="wpb-check"><CheckIcon /></span>}
                </button>
              );
            })}
            {linked.length >= LINK_LIMIT && <div className="wpb-note">最多关联 {LINK_LIMIT} 个目录</div>}
          </>
        )}
      </div>

      <div className="wpb-foot">
        <button className="wpb-ghost" onClick={enterBrowse} disabled={locked}>浏览文件夹…</button>
        <button
          className={`wpb-default ${prefs.defaultWorkspaceId && prefs.defaultWorkspaceId === workspaceId ? 'on' : ''}`}
          onClick={toggleDefault}
          disabled={!workspaceId || locked}
          title={workspaceId ? '设为新对话的默认目录' : '先选一个具体目录'}
        >
          {prefs.defaultWorkspaceId && prefs.defaultWorkspaceId === workspaceId ? '已设为新对话默认' : '设为新对话默认'}
        </button>
      </div>
      {err && <div className="wpb-err">{err}</div>}
    </div>
  );
}
