/**
 * PersonalHub links 主视图（对齐 Polaris LinksView.tsx）：
 * 搜索 / 类型 tab / 标签 / 优先级 / 状态 / 截止日期筛选 / 排序 / 分页 / 标签聚合 /
 * todo 完成切换 / 加密描述。数据面：Supabase REST（supabase.ts）。
 */
import { useCallback, useEffect, useState } from 'react';
import type { Link, LinkType, Priority, StatusFilter, DueDateFilter, SortField, SortOrder } from './types';
import {
  restSelect, restInsert, restUpdate, restDelete, getPersonalHubConfig,
} from './supabase';
import {
  TYPE_FILTER_TABS, PRIORITY_OPTIONS, STATUS_OPTIONS, DUE_DATE_OPTIONS, SORT_OPTIONS,
  PAGE_SIZE_OPTIONS, formatRelativeDate, formatDateTime, isOverdue,
  TYPE_LABELS, PRIORITY_LABEL, PRIORITY_COLOR, Icon, TypeIcon,
} from './ui';
import { decrypt, encrypt, ENCRYPTED_PLACEHOLDER_FAILED, ENCRYPTED_PLACEHOLDER_NO_KEY } from './crypto';
import { fetchFavicon } from './favicon';

// ── 筛选状态 ────────────────────────────────────────────────────────────────

interface FilterState {
  filterType: LinkType | 'all';
  selectedTags: string[];
  selectedPriorities: Priority[];
  selectedStatus: StatusFilter;
  selectedDueDate: DueDateFilter;
  sortBy: SortField;
  sortOrder: SortOrder;
  searchQuery: string;
  currentPage: number;
  pageSize: number;
}

const DEFAULT_FILTER: FilterState = {
  filterType: 'all',
  selectedTags: [],
  selectedPriorities: [],
  selectedStatus: 'all',
  selectedDueDate: 'all',
  sortBy: 'created_at',
  sortOrder: 'desc',
  searchQuery: '',
  currentPage: 1,
  pageSize: 10,
};

/** 构造 due_date 筛选的 [gte, lt] 区间（基于本地 0 点） */
function dueDateRange(filter: string): { gte?: string; lt?: string } | null {
  if (filter === 'all') return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = 86400000;
  switch (filter) {
    case 'today':
      return { gte: today.toISOString(), lt: new Date(today.getTime() + day).toISOString() };
    case 'week':
      return { gte: today.toISOString(), lt: new Date(today.getTime() + 7 * day).toISOString() };
    case 'month':
      return { gte: today.toISOString(), lt: new Date(today.getTime() + 30 * day).toISOString() };
    case 'overdue':
      return { lt: today.toISOString() };
    default:
      return null;
  }
}

// ── 表单草稿 ────────────────────────────────────────────────────────────────

interface LinkDraft {
  id: string | null;
  title: string;
  url: string;
  description: string;
  type: LinkType;
  tagsText: string;
  priority: Priority;
  due_date: string;
  is_encrypted: boolean;
  icon: string;
  completed: boolean;
}

function emptyDraft(type: LinkType = 'navigation'): LinkDraft {
  return {
    id: null, title: '', url: '', description: '', type, tagsText: '',
    priority: 'medium', due_date: '', is_encrypted: false, icon: '', completed: false,
  };
}

function draftFromLink(link: Link, plainDesc: string, hasKey: boolean): LinkDraft {
  const due = link.due_date ? link.due_date.slice(0, 10) : '';
  return {
    id: link.id,
    title: link.title,
    url: link.url ?? '',
    description: link.is_encrypted ? (hasKey ? plainDesc : '') : (link.description ?? ''),
    type: link.type,
    tagsText: link.tags?.join(', ') ?? '',
    priority: link.priority ?? 'medium',
    due_date: due,
    is_encrypted: !!link.is_encrypted,
    icon: link.icon ?? '',
    completed: !!link.completed,
  };
}

/** 构造写入 DB 的数据（含加密描述、tags 转数组、todo 字段） */
function buildLinkData(d: LinkDraft, cipherDesc: string | null): Record<string, unknown> {
  const data: Record<string, unknown> = {
    title: d.title.trim(),
    type: d.type,
    icon: d.icon || null,
    is_encrypted: d.is_encrypted,
  };
  data.description = d.is_encrypted ? cipherDesc : (d.description || null);
  if (d.type !== 'todo') data.url = d.url.trim() || null;

  const tags = d.tagsText ? d.tagsText.split(',').map((t) => t.trim()).filter(Boolean) : [];
  if (tags.length > 0) data.tags = tags;

  if (d.type === 'todo') {
    data.priority = d.priority;
    data.due_date = d.due_date ? new Date(d.due_date).toISOString() : null;
  }
  return data;
}

// ── 主视图 ──────────────────────────────────────────────────────────────────

export function LinksView({ user, onSignOut, onOpenSettings }: {
  user: { id: string; email?: string };
  onSignOut: () => void;
  onOpenSettings: () => void;
}) {
  const [filter, setFilter] = useState<FilterState>(DEFAULT_FILTER);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  const [links, setLinks] = useState<Link[]>([]);
  const [plainDescs, setPlainDescs] = useState<Map<string, string>>(new Map());
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [availableTags, setAvailableTags] = useState<string[]>([]);
  const [draft, setDraft] = useState<LinkDraft | null>(null);
  const [detailLink, setDetailLink] = useState<Link | null>(null);
  const [saving, setSaving] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const encKey = getPersonalHubConfig().encryptionKey.trim();
  const totalPages = Math.max(1, Math.ceil(totalCount / filter.pageSize));

  // 搜索 500ms 防抖（对齐 Polaris useDebounce）
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchQuery), 500);
    return () => clearTimeout(t);
  }, [searchQuery]);

  const patch = useCallback((p: Partial<FilterState>) => setFilter((prev) => ({ ...prev, ...p })), []);

  const fetchTags = useCallback(async () => {
    try {
      const { data } = await restSelect<{ tags?: string[] | null }>('links', {
        select: 'tags',
        eq: { user_id: user.id },
        isNotNull: ['tags'],
      });
      const counts: Record<string, number> = {};
      for (const item of data) for (const tag of item.tags ?? []) counts[tag] = (counts[tag] ?? 0) + 1;
      setAvailableTags(Object.entries(counts).sort(([, a], [, b]) => b - a).map(([tag]) => tag));
    } catch (e) {
      // 标签聚合失败不阻塞列表
      console.warn('[personal-hub] fetchTags failed:', e);
    }
  }, [user.id]);

  const decryptInPlace = useCallback(async (rows: Link[]): Promise<Map<string, string>> => {
    const map = new Map<string, string>();
    if (!encKey) return map;
    await Promise.all(rows.map(async (r) => {
      if (r.is_encrypted && r.description) {
        try {
          const plain = await decrypt(r.description, encKey);
          if (plain) map.set(r.id, plain);
        } catch { /* 占位符兜底 */ }
      }
    }));
    return map;
  }, [encKey]);

  const fetchLinks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const eq: Record<string, string | number | boolean> = { user_id: user.id };
      if (filter.filterType !== 'all') eq.type = filter.filterType;
      if ((filter.filterType === 'todo' || filter.filterType === 'all')) {
        if (filter.selectedStatus === 'pending') eq.completed = false;
        else if (filter.selectedStatus === 'completed') eq.completed = true;
      }

      const q: Parameters<typeof restSelect>[1] = {
        select: '*',
        eq,
        count: true,
        order: { field: filter.sortBy, ascending: filter.sortOrder === 'asc' },
        range: {
          from: (filter.currentPage - 1) * filter.pageSize,
          to: (filter.currentPage - 1) * filter.pageSize + filter.pageSize - 1,
        },
      };

      if (filter.selectedTags.length > 0) q.contains = { tags: filter.selectedTags };
      if (filter.filterType === 'todo' || filter.filterType === 'all') {
        if (filter.selectedPriorities.length > 0) q.inMap = { priority: filter.selectedPriorities };
        const range = dueDateRange(filter.selectedDueDate);
        if (range) {
          // PostgREST 区间筛选：and=(due_date.gte.x,due_date.lt.y)
          const parts: string[] = [];
          if (range.gte) parts.push(`due_date.gte.${range.gte}`);
          if (range.lt) parts.push(`due_date.lt.${range.lt}`);
          q.and = parts.join(',');
        }
      }

      const term = debouncedSearch.trim();
      if (term) {
        // 搜索：title/description ilike + tags contains（修正源码错误的 cs 语义）
        q.or = `title.ilike.%${term}%,description.ilike.%${term}%,tags.cd.{${term}}`;
      }

      const { data, count } = await restSelect<Link>('links', q);
      setLinks(data);
      setTotalCount(count ?? data.length);
      setPlainDescs(await decryptInPlace(data));
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, [user.id, filter, debouncedSearch, decryptInPlace]);

  // 筛选/排序/分页变化触发 refetch
  useEffect(() => { void fetchLinks(); }, [fetchLinks]);
  // 首次 + 用户变化时拉标签
  useEffect(() => { void fetchTags(); }, [fetchTags]);

  const refresh = useCallback(async () => {
    await Promise.all([fetchTags(), fetchLinks()]);
  }, [fetchTags, fetchLinks]);

  const handleSave = async () => {
    if (!draft) return;
    if (!draft.title.trim()) {
      setError('标题不能为空');
      return;
    }
    setError(null);
    setSaving(true);
    try {
      let cipherDesc: string | null = null;
      if (draft.is_encrypted && draft.description && encKey) {
        try { cipherDesc = await encrypt(draft.description, encKey); } catch { cipherDesc = null; }
      }
      const linkData = buildLinkData(draft, cipherDesc);
      if (draft.id) {
        await restUpdate('links', { id: draft.id }, linkData);
      } else {
        await restInsert('links', { ...linkData, user_id: user.id });
      }
      setDraft(null);
      await refresh();
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('确定删除这条记录吗？')) return;
    try {
      await restDelete('links', { id });
      await refresh();
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  };

  const handleToggleComplete = async (link: Link) => {
    try {
      await restUpdate('links', { id: link.id }, { completed: !link.completed });
      setLinks((prev) => prev.map((l) => (l.id === link.id ? { ...l, completed: !l.completed } : l)));
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  };

  const startEdit = (link: Link) => {
    setDetailLink(null);
    setDraft(draftFromLink(link, plainDescs.get(link.id) ?? '', encKey.length > 0));
  };

  const setFilterType = (t: LinkType | 'all') => {
    // 切换到非 todo 类型时清空 todo 专属筛选（对齐 Polaris useLinkFilter 修正）
    if (t !== 'todo') {
      patch({ filterType: t, selectedPriorities: [], selectedStatus: 'all', selectedDueDate: 'all', currentPage: 1 });
    } else {
      patch({ filterType: t, currentPage: 1 });
    }
  };

  const hasActiveFilters =
    filter.selectedTags.length > 0 || filter.selectedPriorities.length > 0 ||
    filter.selectedStatus !== 'all' || filter.selectedDueDate !== 'all' || debouncedSearch.trim().length > 0;
  const activeFiltersCount =
    (filter.selectedTags.length > 0 ? 1 : 0) + (filter.selectedPriorities.length > 0 ? 1 : 0) +
    (filter.selectedStatus !== 'all' ? 1 : 0) + (filter.selectedDueDate !== 'all' ? 1 : 0) +
    (debouncedSearch.trim().length > 0 ? 1 : 0);

  const plainFor = (link: Link): string => {
    if (!link.description) return '';
    if (!link.is_encrypted) return link.description;
    if (!encKey) return ENCRYPTED_PLACEHOLDER_NO_KEY;
    return plainDescs.get(link.id) ?? ENCRYPTED_PLACEHOLDER_FAILED;
  };

  return (
    <>
      {/* 顶栏 */}
      <div className="ph-topbar">
        <span className="email">{user.email ?? '个人空间'}</span>
        <div className="ph-row ph-gap1 ph-shrink0">
          <button className="ph-btn-ghost" onClick={() => void refresh()} disabled={loading} title="刷新">
            <Icon name="refresh" size={14} className={loading ? 'ph-spin' : ''} />
          </button>
          <button className="ph-btn-ghost" onClick={onOpenSettings} title="连接设置">
            <Icon name="settings" size={14} />
          </button>
          <button className="ph-btn-ghost danger" onClick={onSignOut} title="登出">
            <Icon name="logout" size={14} />
          </button>
        </div>
      </div>

      {/* 搜索栏 */}
      <div className="ph-search">
        <Icon name="search" size={13} />
        <input
          className="ph-input"
          value={searchQuery}
          onChange={(e) => { setSearchQuery(e.target.value); patch({ currentPage: 1 }); }}
          placeholder="搜索标题、描述、标签..."
        />
        {searchQuery && (
          <button className="ph-btn-ghost clear" onClick={() => setSearchQuery('')} aria-label="清空搜索">
            <Icon name="x" size={12} />
          </button>
        )}
      </div>

      {/* 类型 tab + 新增 */}
      <div className="ph-toolbar">
        <div className="ph-type-tabs">
          {TYPE_FILTER_TABS.map((t) => (
            <button
              key={t.value}
              className={filter.filterType === t.value ? 'active' : ''}
              onClick={() => setFilterType(t.value)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button
          className={`ph-filter-btn ${hasActiveFilters ? 'on' : ''}`}
          onClick={() => setShowAdvanced((v) => !v)}
        >
          <Icon name="filter" size={12} /> 筛选
          {activeFiltersCount > 0 && <span className="cnt">{activeFiltersCount}</span>}
        </button>
        <button
          className="ph-add-btn"
          onClick={() => setDraft(emptyDraft(filter.filterType === 'all' ? 'navigation' : filter.filterType))}
        >
          <Icon name="plus" size={12} /> 新增
        </button>
      </div>

      {/* 高级筛选面板 */}
      {showAdvanced && (
        <div className="ph-advanced">
          <div className="head">
            <span className="ph-sec-title" style={{ margin: 0 }}>高级筛选</span>
            <button onClick={() => { setFilter(DEFAULT_FILTER); setSearchQuery(''); }}>重置</button>
          </div>
          {availableTags.length > 0 && (
            <div className="grp">
              {availableTags.slice(0, 12).map((tag) => (
                <button
                  key={tag}
                  className={`ph-chip ${filter.selectedTags.includes(tag) ? 'active' : ''}`}
                  onClick={() => patch({
                    selectedTags: filter.selectedTags.includes(tag)
                      ? filter.selectedTags.filter((t) => t !== tag)
                      : [...filter.selectedTags, tag],
                    currentPage: 1,
                  })}
                >
                  {tag}
                </button>
              ))}
            </div>
          )}
          {(filter.filterType === 'todo' || filter.filterType === 'all') && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
              <div>
                <div className="ph-sec-title">优先级</div>
                <div className="grp">
                  {PRIORITY_OPTIONS.map((p) => (
                    <button
                      key={p.value}
                      className={`ph-chip ${filter.selectedPriorities.includes(p.value) ? 'active' : ''}`}
                      style={filter.selectedPriorities.includes(p.value) ? { background: p.color, borderColor: p.color } : undefined}
                      onClick={() => patch({
                        selectedPriorities: filter.selectedPriorities.includes(p.value)
                          ? filter.selectedPriorities.filter((x) => x !== p.value)
                          : [...filter.selectedPriorities, p.value],
                        currentPage: 1,
                      })}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="ph-sec-title">状态</div>
                <div className="grp">
                  {STATUS_OPTIONS.map((s) => (
                    <button
                      key={s.value}
                      className={`ph-chip ${filter.selectedStatus === s.value ? 'active' : ''}`}
                      onClick={() => patch({ selectedStatus: s.value, currentPage: 1 })}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="ph-sec-title">截止</div>
                <div className="grp">
                  {DUE_DATE_OPTIONS.map((d) => (
                    <button
                      key={d.value}
                      className={`ph-chip ${filter.selectedDueDate === d.value ? 'active' : ''}`}
                      onClick={() => patch({ selectedDueDate: d.value, currentPage: 1 })}
                    >
                      {d.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 排序 + 结果数 */}
      <div className="ph-sortbar">
        <span className="total">共 {totalCount} 条</span>
        <div className="opts">
          {SORT_OPTIONS.map((s) => (
            <button
              key={s.value}
              className={filter.sortBy === s.value ? 'active' : ''}
              onClick={() => setFilter((prev) => ({
                ...prev,
                sortBy: s.value,
                sortOrder: prev.sortBy === s.value ? (prev.sortOrder === 'asc' ? 'desc' : 'asc') : 'desc',
                currentPage: 1,
              }))}
              title={s.label}
            >
              {s.label}{filter.sortBy === s.value && (filter.sortOrder === 'asc' ? ' ↑' : ' ↓')}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="ph-error" style={{ margin: '8px 12px 0' }}>{error}</div>}

      {/* 列表 */}
      <div className="ph-list">
        {links.length === 0 && !loading ? (
          <div className="ph-center">暂无记录，点击「新增」添加</div>
        ) : (
          links.map((link) => {
            const description = plainFor(link);
            const overdue = isOverdue(link.due_date, link.completed);
            const tags = (link.tags ?? []).slice(0, 4);
            return (
              <div key={link.id} className="ph-card" onClick={() => setDetailLink(link)}>
                <div className="head">
                  <div className="ico">
                    {link.icon
                      ? <img src={link.icon} alt="" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                      : <TypeIcon type={link.type} size={16} />}
                  </div>
                  <div className="ph-grow">
                    <div className="ph-row ph-gap2">
                      {link.type === 'todo' && (
                        <input
                          type="checkbox"
                          checked={!!link.completed}
                          onChange={() => void handleToggleComplete(link)}
                          onClick={(e) => e.stopPropagation()}
                        />
                      )}
                      <span className={`title ${link.completed ? 'done' : ''}`}>{link.title}</span>
                      {link.is_encrypted ? <span className="ph-shrink0" style={{ color: 'var(--text-faint)', display: 'inline-flex' }}><Icon name="lock" size={11} /></span> : null}
                    </div>
                    {description && <p className="desc">{description}</p>}
                    {link.url && (
                      <span
                        className="url"
                        onClick={(e) => { e.stopPropagation(); window.open(link.url ?? '', '_blank', 'noopener'); }}
                      >
                        <Icon name="external" size={10} /><span>{link.url}</span>
                      </span>
                    )}
                    <div className="meta">
                      {tags.map((tag) => <span key={tag} className="ph-tag">{tag}</span>)}
                      {(link.tags?.length ?? 0) > 4 && <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>+{(link.tags?.length ?? 0) - 4}</span>}
                      {link.priority && (
                        <span className="ph-pri" style={{ backgroundColor: PRIORITY_COLOR[link.priority] }}>
                          {PRIORITY_LABEL[link.priority]}
                        </span>
                      )}
                      {link.due_date && (
                        <span className={`ph-due ${overdue ? 'over' : ''}`}>
                          <Icon name="calendar" size={10} />{formatRelativeDate(link.due_date)}
                        </span>
                      )}
                      <span className="ph-type-label">{TYPE_LABELS[link.type]}</span>
                    </div>
                  </div>
                  <div className="ops" onClick={(e) => e.stopPropagation()}>
                    <button className="ph-btn-ghost" onClick={() => startEdit(link)} title="编辑">
                      <Icon name="edit" size={12} />
                    </button>
                    <button className="ph-btn-ghost danger" onClick={() => void handleDelete(link.id)} title="删除">
                      <Icon name="trash" size={12} />
                    </button>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* 分页 */}
      {totalCount > 0 && (
        <div className="ph-pager">
          <select
            className="ph-select"
            value={filter.pageSize}
            onChange={(e) => patch({ pageSize: Number(e.target.value), currentPage: 1 })}
          >
            {PAGE_SIZE_OPTIONS.map((s) => <option key={s} value={s}>{s} 条/页</option>)}
          </select>
          <div className="pg-btns">
            <span>{filter.currentPage} / {totalPages}</span>
            <button className="ph-btn-ghost" disabled={filter.currentPage <= 1}
              onClick={() => patch({ currentPage: Math.max(1, filter.currentPage - 1) })}>
              <Icon name="left" size={12} />
            </button>
            <button className="ph-btn-ghost" disabled={filter.currentPage >= totalPages}
              onClick={() => patch({ currentPage: Math.min(totalPages, filter.currentPage + 1) })}>
              <Icon name="right" size={12} />
            </button>
          </div>
        </div>
      )}

      {/* 详情浮层 */}
      {detailLink && (
        <DetailDialog
          link={detailLink}
          plainDesc={plainFor(detailLink)}
          onClose={() => setDetailLink(null)}
          onEdit={startEdit}
        />
      )}

      {/* 编辑/新增 抽屉 */}
      {draft && (
        <FormDialog
          draft={draft}
          onChange={setDraft}
          onClose={() => setDraft(null)}
          onSave={() => void handleSave()}
          saving={saving}
          hasKey={encKey.length > 0}
        />
      )}
    </>
  );
}

// ── 详情浮层 ────────────────────────────────────────────────────────────────

function DetailDialog({ link, plainDesc, onClose, onEdit }: {
  link: Link;
  plainDesc: string;
  onClose: () => void;
  onEdit: (link: Link) => void;
}) {
  return (
    <div className="ph-overlay">
      <div className="ov-head">
        <span className="t">{link.title}</span>
        <div className="ph-row ph-gap1">
          <button className="ph-btn-ghost" style={{ fontSize: 11, color: 'var(--accent-bright)' }} onClick={() => onEdit(link)}>编辑</button>
          <button className="ph-btn-ghost" onClick={onClose} aria-label="关闭"><Icon name="x" size={14} /></button>
        </div>
      </div>
      <div className="ov-body">
        <section>
          <h4 className="ph-sec-title">基本信息</h4>
          <div className="ph-kv"><span className="k">类型</span><span className="v">{TYPE_LABELS[link.type]}</span></div>
          {link.url && (
            <div className="ph-kv">
              <span className="k">URL</span>
              <span className="v">
                <a href={link.url} onClick={(e) => { e.preventDefault(); window.open(link.url ?? '', '_blank', 'noopener'); }}>
                  <Icon name="external" size={10} /> {link.url}
                </a>
              </span>
            </div>
          )}
          {(link.tags?.length ?? 0) > 0 && (
            <div className="ph-kv">
              <span className="k">标签</span>
              <span className="v ph-row ph-gap1" style={{ flexWrap: 'wrap' }}>
                {link.tags!.map((t) => <span key={t} className="ph-tag"><Icon name="tag" size={9} /> {t}</span>)}
              </span>
            </div>
          )}
          {link.priority && (
            <div className="ph-kv"><span className="k">优先级</span><span className="v ph-row ph-gap1"><Icon name="flag" size={11} />{PRIORITY_LABEL[link.priority]}</span></div>
          )}
          {link.due_date && (
            <div className="ph-kv"><span className="k">截止</span><span className="v ph-row ph-gap1"><Icon name="calendar" size={11} />{formatRelativeDate(link.due_date)} · {formatDateTime(link.due_date)}</span></div>
          )}
          {link.type === 'todo' && (
            <div className="ph-kv">
              <span className="k">状态</span>
              <span className="v ph-row ph-gap1">
                <Icon name={link.completed ? 'check' : 'circle'} size={12} />
                {link.completed ? '已完成' : '待完成'}
              </span>
            </div>
          )}
        </section>
        {plainDesc && (
          <section>
            <div className="ph-row" style={{ justifyContent: 'space-between' }}>
              <h4 className="ph-sec-title" style={{ margin: 0 }}>描述</h4>
              {link.is_encrypted ? <span style={{ fontSize: 10, color: 'var(--text-faint)' }}><Icon name="lock" size={10} /> 已加密</span> : null}
            </div>
            <p style={{ margin: '6px 0 0', fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{plainDesc}</p>
          </section>
        )}
        <section>
          <h4 className="ph-sec-title">时间</h4>
          <div className="ph-kv"><span className="k">创建</span><span className="v">{formatDateTime(link.created_at)}</span></div>
          <div className="ph-kv"><span className="k">更新</span><span className="v">{formatDateTime(link.updated_at)}</span></div>
        </section>
      </div>
      <div className="ov-foot">
        {link.url && (
          <a
            href={link.url}
            onClick={(e) => { e.preventDefault(); window.open(link.url ?? '', '_blank', 'noopener'); }}
            className="ph-btn-outline"
            style={{ flex: 1, color: 'var(--accent-bright)', borderColor: 'var(--accent)' }}
          >
            访问链接
          </a>
        )}
        <button className="ph-btn-outline" style={{ flex: 1 }} onClick={onClose}>关闭</button>
      </div>
    </div>
  );
}

// ── 编辑/新增表单浮层 ───────────────────────────────────────────────────────

function FormDialog({ draft, onChange, onClose, onSave, saving, hasKey }: {
  draft: LinkDraft;
  onChange: (d: LinkDraft) => void;
  onClose: () => void;
  onSave: () => void;
  saving: boolean;
  hasKey: boolean;
}) {
  const [iconLoading, setIconLoading] = useState(false);
  const isEdit = !!draft.id;
  const isTodo = draft.type === 'todo';

  const fetchIcon = async () => {
    if (!draft.url.trim()) return;
    try {
      setIconLoading(true);
      const icon = await fetchFavicon(draft.url);
      if (icon) onChange({ ...draft, icon });
    } finally {
      setIconLoading(false);
    }
  };

  return (
    <div className="ph-overlay">
      <div className="ov-head">
        <span className="t">{isEdit ? '编辑' : '新增'}</span>
        <button className="ph-btn-ghost" onClick={onClose} style={{ fontSize: 11 }}>取消</button>
      </div>
      <div className="ov-body">
        <div className="ph-form">
          <div>
            <label className="ph-label">标题 *</label>
            <input className="ph-input" value={draft.title} onChange={(e) => onChange({ ...draft, title: e.target.value })} />
          </div>
          <div>
            <label className="ph-label">类型</label>
            <select className="ph-select" style={{ width: '100%' }} value={draft.type}
              onChange={(e) => onChange({ ...draft, type: e.target.value as LinkType })}>
              {TYPE_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          {!isTodo && (
            <div>
              <label className="ph-label">URL</label>
              <input className="ph-input" value={draft.url} placeholder="https://"
                onChange={(e) => onChange({ ...draft, url: e.target.value })}
                onBlur={() => { if (!isEdit && draft.url.trim()) void fetchIcon(); }} />
            </div>
          )}
          {!isTodo && (
            <div>
              <label className="ph-label">图标</label>
              <div className="ph-icon-row">
                <div className="ph-icon-prev">
                  {draft.icon ? <img src={draft.icon} alt="" /> : <Icon name="link" size={12} />}
                </div>
                <input className="ph-input" value={draft.icon} placeholder="图标 URL（自动抓取或手动填写）"
                  onChange={(e) => onChange({ ...draft, icon: e.target.value })} />
                <button className="ph-btn-outline ph-shrink0" disabled={iconLoading || !draft.url.trim()} onClick={() => void fetchIcon()}>
                  <Icon name="refresh" size={12} className={iconLoading ? 'ph-spin' : ''} /> 抓取
                </button>
              </div>
            </div>
          )}
          <div>
            <label className="ph-label">标签（逗号分隔）</label>
            <input className="ph-input" value={draft.tagsText} placeholder="vue, react, 工具"
              onChange={(e) => onChange({ ...draft, tagsText: e.target.value })} />
          </div>
          {isTodo && (
            <>
              <div>
                <label className="ph-label">优先级</label>
                <select className="ph-select" style={{ width: '100%' }} value={draft.priority}
                  onChange={(e) => onChange({ ...draft, priority: e.target.value as Priority })}>
                  {PRIORITY_OPTIONS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
              </div>
              <div>
                <label className="ph-label">截止日期</label>
                <input className="ph-input" type="date" value={draft.due_date}
                  onChange={(e) => onChange({ ...draft, due_date: e.target.value })} />
              </div>
            </>
          )}
          <div>
            <label className="ph-label">描述</label>
            <textarea className="ph-input" rows={4} value={draft.description}
              onChange={(e) => onChange({ ...draft, description: e.target.value })} />
            <label className="ph-checkline" style={{ marginTop: 6 }}>
              <input type="checkbox" checked={draft.is_encrypted} disabled={!hasKey}
                onChange={(e) => onChange({ ...draft, is_encrypted: e.target.checked })} />
              <span style={{ opacity: hasKey ? 1 : 0.5 }}>
                加密描述 {!hasKey && '（需先在连接设置中配置加密密钥）'}
              </span>
            </label>
          </div>
        </div>
      </div>
      <div className="ov-foot">
        <button className="ph-btn-primary" style={{ width: '100%' }} onClick={onSave} disabled={saving}>
          {saving ? '保存中...' : '保存'}
        </button>
      </div>
    </div>
  );
}

const TYPE_OPTIONS = TYPE_FILTER_TABS.filter((t) => t.value !== 'all');
