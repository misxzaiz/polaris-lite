/**
 * git-panel 面板组件（v2 原型落地方案）。
 *
 * 结构（对齐 docs/plugin-contract.md：slot 贡献 + .gp- 前缀样式 + 宿主 token）：
 * - 工作区选择器：cap.tool.fs roots（复用 file-browser 根表，不自造路径体系），
 *   选择结果经 cap.kv 持久化（namespace=git-panel），多端同步；
 * - 三个互斥视图（变更/历史/分支），各自自带顶栏，切换整屏覆盖无残留；
 * - 移动端：api.layout.isMobile 感知，操作条固定底部（原型 v2 形态）；
 * - 性能：status 2s TTL 缓存 + 写动作后精准刷新 + 列表虚拟化阈值（>120 文件截断展示）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LitePlugin, SlotHostApi } from '@sdk';
import { bindHost, git, type GitBranch, type GitLogEntry, type GitStatus, type GitStatusFile } from './bridge';
import './panel.css';

const NS = 'git-panel';
const STATUS_TTL_MS = 2000;
const LIST_HARD_CAP = 120; // 超过则截断渲染（虚拟滚动的降级，避免长列表卡顿）

type TabKey = 'changes' | 'history' | 'branches';
type Roots = { id: string; label: string; path: string; builtin?: boolean; missing?: boolean }[];

interface KvResp { value?: { activeRootId?: string } | null }

let hostApi: SlotHostApi | null = null;

/** diff/numstat 等脏活收进 model；此处仅保留展示状态。 */
function fileKind(f: GitStatusFile): 'staged' | 'unstaged' | 'untracked' {
  if (f.untracked) return 'untracked';
  return f.staged ? 'staged' : 'unstaged';
}

export function GitPanel() {
  const [roots, setRoots] = useState<Roots>([]);
  const [rootId, setRootId] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>('changes');
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [log, setLog] = useState<GitLogEntry[]>([]);
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string>('');
  const [search, setSearch] = useState('');
  const statusAt = useRef(0);
  const rootIdRef = useRef<string | null>(null);
  rootIdRef.current = rootId;

  const say = useCallback((m: string) => {
    setToast(m);
    window.setTimeout(() => setToast(''), 1800);
  }, []);

  /** 工作区根列表（复用 file-browser 的 cap.tool.fs，不自造根体系） */
  const loadRoots = useCallback(async () => {
    if (!hostApi) return;
    const res = await hostApi.dispatch<{ roots?: Roots }>({ target: 'cap.tool.fs', action: 'roots' });
    if (res.ok && res.data?.roots) {
      setRoots(res.data.roots);
      setRootId((cur) => cur ?? res.data!.roots![0]?.id ?? null);
    }
  }, []);

  /** 记忆选择（cap.kv，服务端 sqlite 持久化，多端同步） */
  useEffect(() => {
    if (!hostApi) return;
    void hostApi.dispatch<KvResp>({ target: 'cap.kv', action: 'get', payload: { namespace: NS, key: 'activeRoot' } })
      .then((r) => { const id = r.data?.value?.activeRootId; if (id) setRootId(id); })
      .then(loadRoots);
  }, [loadRoots]);

  const switchRoot = useCallback((id: string) => {
    setRootId(id);
    setSelected(new Set());
    statusAt.current = 0;
    if (hostApi) void hostApi.dispatch({ target: 'cap.kv', action: 'set', payload: { namespace: NS, key: 'activeRoot', value: { activeRootId: id } } });
  }, []);

  /** status 读取（TTL 缓存；force=写动作后精准刷新） */
  const refreshStatus = useCallback(async (force = false) => {
    const rid = rootIdRef.current;
    if (!rid || busy) return;
    if (!force && Date.now() - statusAt.current < STATUS_TTL_MS) return;
    statusAt.current = Date.now();
    try {
      const [st, lg, br] = await Promise.all([
        git<GitStatus>('get_status', rid),
        git<GitLogEntry[]>('get_log', rid, { limit: 50 }),
        git<GitBranch[]>('get_branches', rid),
      ]);
      setStatus(st); setLog(lg); setBranches(br);
    } catch (e) {
      say(`[x] ${(e as Error).message}`);
    }
  }, [busy, say]);

  useEffect(() => {
    if (rootId) void refreshStatus(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootId]);

  const toggleSel = useCallback((path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }, []);

  /** 写动作统一入口：走 cap.git（服务端串行 + 审计），成功后 force 刷新 */
  const runWrite = useCallback(async (action: string, params: Record<string, unknown>, okMsg: string) => {
    if (!rootIdRef.current || busy) return;
    setBusy(true);
    try {
      await git(action, rootIdRef.current, params);
      say(okMsg);
      setSelected(new Set());
      statusAt.current = 0;
      await refreshStatus(true);
    } catch (e) {
      say(`[x] ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [busy, refreshStatus, say]);

  const all = useMemo(() => status?.files ?? [], [status]);
  const selFiles = useMemo(() => all.filter((f) => selected.has(f.path)), [all, selected]);
  const selAllStaged = selFiles.length > 0 && selFiles.every((f) => f.staged || f.untracked);

  const groups = useMemo(() => ({
    staged: all.filter((f) => fileKind(f) === 'staged'),
    unstaged: all.filter((f) => fileKind(f) === 'unstaged'),
    untracked: all.filter((f) => fileKind(f) === 'untracked'),
  }), [all]);

  const cap = <T,>(list: T[]): T[] => (list.length > LIST_HARD_CAP ? list.slice(0, LIST_HARD_CAP) : list);
  const filteredLog = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return cap(log);
    return cap(log.filter((c) => `${c.message} ${c.sha} ${c.author}`.toLowerCase().includes(q)));
  }, [log, search]);

  const curRoot = roots.find((r) => r.id === rootId);

  return (
    <div className={`gp-root${hostApi?.layout.isMobile ? ' gp-mobile' : ''}`} data-testid="git-panel">
      {/* ── 视图：变更（自带顶栏，互斥覆盖） ── */}
      <section className={`gp-view${tab === 'changes' ? ' on' : ''}`}>
        <header className="gp-head">
          <div className="gp-head-main">
            <div className="gp-title">变更</div>
            <div className="gp-sub">
              <select className="gp-root-sel" value={rootId ?? ''} onChange={(e) => switchRoot(e.target.value)} aria-label="工作区">
                {roots.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
              </select>
              {status && <> · [b] {status.branch} · <span className="gp-ab">[up]{status.ahead} [dn]{status.behind}</span></>}
            </div>
          </div>
          <button className="gp-icon" onClick={() => void refreshStatus(true)} disabled={busy} aria-label="刷新">[r]</button>
        </header>
        <div className="gp-body">
          <div className="gp-summary">
            <div className="gp-sum s"><b>{groups.staged.length}</b><span>已暂存</span></div>
            <div className="gp-sum u"><b>{groups.unstaged.length}</b><span>未暂存</span></div>
            <div className="gp-sum"><b>{groups.untracked.length}</b><span>未跟踪</span></div>
          </div>
          {status == null && <div className="gp-empty">{busy ? '读取中...' : '选择工作区以查看变更'}</div>}
          {(['staged', 'unstaged', 'untracked'] as const).map((k) => groups[k].length > 0 && (
            <div key={k}>
              <div className="gp-grp">
                {k === 'staged' ? '已暂存' : k === 'unstaged' ? '未暂存' : '未跟踪'}
                {k !== 'staged' && groups[k].length > 0 && (
                  <span className="gp-lnk" onClick={() => void runWrite('batch_stage', { filePaths: groups[k].map((f) => f.path) }, '[ok] 已暂存')}>全部暂存 [dn]</span>
                )}
              </div>
              {cap(groups[k]).map((f) => (
                <div key={f.path} className={`gp-file${selected.has(f.path) ? ' sel' : ''}`} onClick={() => toggleSel(f.path)}>
                  <span className="gp-box">{selected.has(f.path) ? '[ok]' : ''}</span>
                  <span className="gp-fi">
                    <span className="gp-fn">{f.path}</span>
                  </span>
                  <span className={`gp-tag ${k === 'staged' ? 's' : k === 'untracked' ? 'u' : 'm'}`}>
                    {k === 'staged' ? '已暂存' : k === 'untracked' ? '新增' : '修改'}
                  </span>
                </div>
              ))}
            </div>
          ))}
          {status != null && all.length === 0 && <div className="gp-empty">工作区干净，没有待处理的变更</div>}
        </div>
      </section>

      {/* ── 视图：历史 ── */}
      <section className={`gp-view${tab === 'history' ? ' on' : ''}`}>
        <header className="gp-head">
          <div className="gp-head-main">
            <div className="gp-title">历史</div>
            <div className="gp-sub">{curRoot?.label ?? '—'} · 提交记录</div>
          </div>
        </header>
        <div className="gp-search"><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索提交信息 / sha / 作者" /></div>
        <div className="gp-body">
          {filteredLog.map((c) => (
            <div key={c.sha} className="gp-commit">
              <span className="gp-dot" />
              <span className="gp-ci">
                <div className="gp-cm">{c.message}</div>
                <div className="gp-cs"><span>{c.sha}</span><span>{c.author}</span><span className="gp-ct">{new Date(c.at * 1000).toLocaleString()}</span></div>
              </span>
            </div>
          ))}
          {filteredLog.length === 0 && <div className="gp-empty">没有匹配的提交</div>}
        </div>
      </section>

      {/* ── 视图：分支 ── */}
      <section className={`gp-view${tab === 'branches' ? ' on' : ''}`}>
        <header className="gp-head">
          <div className="gp-head-main">
            <div className="gp-title">分支</div>
            <div className="gp-sub">{curRoot?.label ?? '—'} · {branches.length} 本地</div>
          </div>
        </header>
        <div className="gp-body">
          {branches.map((b) => (
            <div key={b.name} className="gp-row" onClick={() => { if (!b.current) void runWrite('checkout_branch', { name: b.name }, `[b] 已切换到 ${b.name}`); }}>
              <span className="gp-bn">{b.name}</span>
              {b.current ? <span className="gp-cur">当前</span> : <span className="gp-go">切换 &gt;</span>}
            </div>
          ))}
          {branches.length === 0 && <div className="gp-empty">读取分支失败或空仓库</div>}
        </div>
      </section>

      {/* ── 底部 tab（移动端主导航；桌面端同样适用，简化层级） ── */}
      <nav className="gp-tabbar">
        {([['changes', '[c]', '变更'], ['history', '[h]', '历史'], ['branches', '[b]', '分支']] as const).map(([k, ic, label]) => (
          <button key={k} className={`gp-tab${tab === k ? ' on' : ''}`} onClick={() => setTab(k)}>
            <span className="gp-ic">{ic}</span>{label}
            {k === 'changes' && all.length > 0 && <span className="gp-dot">{all.length}</span>}
          </button>
        ))}
      </nav>

      {/* ── 底部操作条（选中文件后弹出） ── */}
      {selFiles.length > 0 && (
        <div className="gp-abar">
          <div className="gp-ab-in">
            <button className="gp-btn ghost" disabled={busy} onClick={() => void runWrite('batch_unstage', { filePaths: selFiles.map((f) => f.path) }, '[u] 已取消暂存')}>[u]</button>
            <button className="gp-btn pri" disabled={busy} onClick={() => {
              if (selAllStaged) void runWrite('commit_changes', { message: window.prompt('提交信息') ?? '', stageAll: false }, '[ok] 已提交');
              else void runWrite('batch_stage', { filePaths: selFiles.map((f) => f.path) }, '[ok] 已暂存');
            }}>{busy ? '...' : selAllStaged ? '提交所选' : '暂存所选'}</button>
          </div>
          <div className="gp-ab-hint">已选 {selFiles.length} 个文件</div>
        </div>
      )}

      {toast && <div className="gp-toast">{toast}</div>}
    </div>
  );
}

export const gitPanelPlugin: LitePlugin = {
  manifest: {
    id: 'git-panel',
    name: 'Git',
    version: '0.1.0',
    capabilities: ['cap.git', 'cap.tool.fs', 'cap.kv'],
    provides: [],
    events: ['git-operation'],
    requires: ['cap.git'],
    contributes: {
      slots: [{ slot: 'panel', component: 'GitPanel', order: 26, title: 'Git' }],
    },
  },
  setup(api: SlotHostApi) {
    hostApi = api;
    bindHost(api);
    api.listen('git-operation', () => {
      // 写动作事件兜底刷新（服务端审计广播；一期面板以本地 force 刷新为主）
    });
  },
};

export default gitPanelPlugin;
