/**
 * article-sources — 开源文章源导航插件（外部插件，仅查询）。
 *
 * 面板：分类浏览开源文章源（博客平台/中文社区/聚合工具/自建方案）+ 关键词过滤。
 * Skill：随包 SKILL.md（安装后可由面板一键写入工作区，AI 下轮对话可见）。
 * MCP：随包 stdio server，提供 sources_sections / sources_get / sources_search。
 *
 * 无 server 半边、无网络抓取、无保存动作；数据为静态知识库。
 */
import { useMemo, useState } from 'react';
import type { LitePlugin, SlotHostApi } from '@sdk';
import { AS_DOCS, AS_VERSION, type AsDoc, type AsSection } from './knowledge';
import './style.css';

let api: SlotHostApi | null = null;

const SECTIONS: { key: AsSection | 'all'; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'blog', label: '博客平台' },
  { key: 'cn', label: '中文社区' },
  { key: 'agg', label: '聚合工具' },
  { key: 'diy', label: '自建方案' },
];

const SKILL_PATH = '.claude/skills/article-sources/SKILL.md';
const SKILL_CONTENT = [
  '---',
  'name: article-sources',
  'description: 开源文章源知识库：博客平台(WordPress/Ghost/WriteFreely/Typecho)、中文社区(掘金/博客园/少数派/V2EX/知乎)、聚合工具(RSSHub/FreshRSS/Miniflux/Huginn)、自建聚合方案。回答「找文章源/聚合方案/RSS 搭建」类问题先查这里。',
  '---',
  '',
  '# article-sources：开源文章源知识库',
  '',
  '本技能由外部插件 article-sources 提供。用法：',
  '',
  '1. 优先用 MCP 工具 sources_search（关键词）或 sources_get（按 id）取条目；',
  '2. 面板里也能人工浏览同一份知识库（article-sources 面板）；',
  '3. 覆盖主题：开放博客平台及其 RSS/API、中文内容社区及反爬强度、',
  '   RSSHub/FreshRSS/Miniflux/Huginn 等聚合工具、自建文章聚合站架构、公众号无官方 API 的现实。',
  '',
  '本知识库为静态整理，条目可能过时；实际接入前请验证源站可用性与版权条款。',
  '',
].join('\n');

function ArticleSourcesPanel() {
  const [section, setSection] = useState<AsSection | 'all'>('all');
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(AS_DOCS[0]?.id ?? null);
  const [skillState, setSkillState] = useState<'idle' | 'ok' | 'fail'>('idle');
  const [busy, setBusy] = useState(false);

  const docs = useMemo(() => {
    const q = query.trim().toLowerCase();
    return AS_DOCS.filter((d) => {
      const secOk = section === 'all' || d.section === section;
      if (!secOk) return false;
      if (!q) return true;
      return `${d.id} ${d.title} ${d.summary} ${d.body}`.toLowerCase().includes(q);
    });
  }, [section, query]);

  const installSkill = async () => {
    setBusy(true);
    try {
      const r = await fetch('/api/files-write/exec', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action: 'write', path: SKILL_PATH, content: SKILL_CONTENT, sessionId: 'article-sources-panel' }),
      });
      const j = await r.json().catch(() => null);
      setSkillState(r.ok && j?.ok ? 'ok' : 'fail');
    } catch {
      setSkillState('fail');
    }
    setBusy(false);
  };

  return (
    <div className="as-panel article-sources-panel">
      <div className="as-head">
        <h3>文章源导航</h3>
        <p>开源文章源知识库 v{AS_VERSION} · {AS_DOCS.length} 条 · 仅查询</p>
      </div>

      <div className="as-toolbar">
        <div className="as-tabs">
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              type="button"
              className={`as-tab ${section === s.key ? 'active' : ''}`}
              onClick={() => setSection(s.key)}
            >
              {s.label}
            </button>
          ))}
        </div>
        <input
          className="as-search"
          placeholder="搜索文章源…（如 RSS、掘金、聚合）"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="as-list">
        {docs.length === 0 && <div className="as-empty">没有匹配的条目</div>}
        {docs.map((d) => {
          const open = openId === d.id;
          return (
            <div key={d.id} className={`as-item ${open ? 'open' : ''}`}>
              <button type="button" className="as-item-head" onClick={() => setOpenId(open ? null : d.id)}>
                <span className="as-item-title">{d.title}</span>
                <span className="as-item-summary">{d.summary}</span>
                <span className="as-item-id">{d.id}</span>
              </button>
              {open && <pre className="as-item-body">{d.body}</pre>}
            </div>
          );
        })}
      </div>

      <div className="as-foot">
        <div className="as-skill">
          <span>
            AI 通道：把本知识库写成工作区技能（.claude/skills/article-sources/SKILL.md），
            下轮对话 AI 即可引用；也可用随包 MCP 工具 sources_search / sources_get 直接检索。
          </span>
          <button type="button" disabled={busy} onClick={installSkill}>
            {busy ? '写入中…' : skillState === 'ok' ? '已写入 ✓' : '写入 AI 技能'}
          </button>
        </div>
        {skillState === 'fail' && <div className="as-error">技能写入失败：检查 files-write 写面是否可用。</div>}
      </div>
    </div>
  );
}

export { ArticleSourcesPanel };

export const articleSourcesPlugin: LitePlugin = {
  manifest: {
    id: 'article-sources',
    name: '文章源导航',
    version: AS_VERSION,
    capabilities: [],
    contributes: {
      slots: [{ slot: 'panel', component: 'ArticleSourcesPanel', order: 42, title: '文章源导航' }],
    },
  },
  setup(hostApi) {
    api = hostApi;
  },
};

export default articleSourcesPlugin;
