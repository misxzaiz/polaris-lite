/**
 * plite-guide — polaris-lite 使用说明插件（外部插件示例第二弹）。
 *
 * 面板：分节展示规范知识库（概览/架构/插件/UI/服务端/AI/商城/运维），
 *       支持关键词过滤；面板本身即「可交互的说明书」。
 * Skill：随包 SKILL.md（安装后由面板一键写入工作区，AI 下轮对话可见）。
 * MCP：随包 stdio server，提供 guide_sections / guide_get / guide_search 三个工具，
 *      AI 可直接检索本知识库。
 *
 * 无 server 半边、无危险权限；数据均为静态知识库。
 */
import { useMemo, useState } from 'react';
import type { LitePlugin, SlotHostApi } from '@sdk';
import { GUIDE_DOCS, GUIDE_VERSION, type GuideDoc } from './knowledge';
import './style.css';

let api: SlotHostApi | null = null;

const SECTIONS: { key: GuideDoc['section'] | 'all'; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'overview', label: '概览' },
  { key: 'architecture', label: '架构' },
  { key: 'plugin', label: '插件' },
  { key: 'ui', label: 'UI' },
  { key: 'server', label: '服务端' },
  { key: 'ai', label: 'AI' },
  { key: 'market', label: '商城' },
  { key: 'ops', label: '运维' },
];

const SKILL_PATH = '.claude/skills/plite-guide/SKILL.md';
const SKILL_CONTENT = [
  '---',
  'name: plite-guide',
  'description: polaris-lite 规范与使用说明知识库：架构/插件契约/UI 布局/服务端网关/AI 引擎/商城与外部插件/运维命令。回答 polaris-lite 本项目相关问题前先查这里。',
  '---',
  '',
  '# plite-guide：polaris-lite 项目知识库',
  '',
  '本技能由外部插件 plite-guide 提供。回答本项目问题时的用法：',
  '',
  '1. 优先用 MCP 工具 guide_search（关键词）或 guide_get（按 id）取权威摘要；',
  '2. 面板里也能人工浏览同一份知识库（plite-guide 面板）；',
  '3. 覆盖主题：核心零业务边界、插件双入口、cap 总线与信任模型、槽位/视图/容器、',
  '   工作区布局树、服务端网关 /api/cap、AI 引擎契约、商城三类源与四通道（面板/Skill/MCP/Hook）、',
  '   端口与环境纪律（5000 dev / 9825 生产 / 9826 分析）、构建与发版命令。',
  '',
  '权威源文件：docs/plugin-contract.md、docs/server-gateway-contract.md、docs/ai-engine-contract.md、',
  'docs/baseline.md、docs/brief.md、README.md。知识库与其冲突时以源文件与代码门禁为准。',
  '',
].join('\n');

function GuidePanel() {
  const [section, setSection] = useState<GuideDoc['section'] | 'all'>('all');
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(GUIDE_DOCS[0]?.id ?? null);
  const [skillState, setSkillState] = useState<'idle' | 'ok' | 'fail'>('idle');
  const [busy, setBusy] = useState(false);

  const docs = useMemo(() => {
    const q = query.trim().toLowerCase();
    return GUIDE_DOCS.filter((d) => {
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
        body: JSON.stringify({ action: 'write', path: SKILL_PATH, content: SKILL_CONTENT, sessionId: 'plite-guide-panel' }),
      });
      const j = await r.json().catch(() => null);
      setSkillState(r.ok && j?.ok ? 'ok' : 'fail');
    } catch {
      setSkillState('fail');
    }
    setBusy(false);
  };

  return (
    <div className="pg-panel">
      <div className="pg-head">
        <h3>polaris-lite 使用说明</h3>
        <p>规范知识库 v{GUIDE_VERSION} · {GUIDE_DOCS.length} 篇 · 面板/AI 双通道</p>
      </div>

      <div className="pg-toolbar">
        <div className="pg-tabs">
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              type="button"
              className={`pg-tab ${section === s.key ? 'active' : ''}`}
              onClick={() => setSection(s.key)}
            >
              {s.label}
            </button>
          ))}
        </div>
        <input
          className="pg-search"
          placeholder="搜索规范…（如 sha256、槽位、http 源）"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="pg-list">
        {docs.length === 0 && <div className="pg-empty">没有匹配的条目</div>}
        {docs.map((d) => {
          const open = openId === d.id;
          return (
            <div key={d.id} className={`pg-item ${open ? 'open' : ''}`}>
              <button type="button" className="pg-item-head" onClick={() => setOpenId(open ? null : d.id)}>
                <span className="pg-item-title">{d.title}</span>
                <span className="pg-item-summary">{d.summary}</span>
                <span className="pg-item-id">{d.id}</span>
              </button>
              {open && <pre className="pg-item-body">{d.body}</pre>}
            </div>
          );
        })}
      </div>

      <div className="pg-foot">
        <div className="pg-skill">
          <span>
            AI 通道：把本知识库写成工作区技能（.claude/skills/plite-guide/SKILL.md），
            下轮对话 AI 即可引用；也可用随包 MCP 工具 guide_search / guide_get 直接检索。
          </span>
          <button type="button" disabled={busy} onClick={installSkill}>
            {busy ? '写入中…' : skillState === 'ok' ? '已写入 ✓' : '写入 AI 技能'}
          </button>
        </div>
        {skillState === 'fail' && <div className="pg-error">技能写入失败：检查 files-write 写面是否可用。</div>}
      </div>
    </div>
  );
}

export { GuidePanel };

export const pliteGuidePlugin: LitePlugin = {
  manifest: {
    id: 'plite-guide',
    name: '使用说明',
    version: GUIDE_VERSION,
    capabilities: [],
    contributes: {
      slots: [{ slot: 'panel', component: 'GuidePanel', order: 41, title: '使用说明' }],
    },
  },
  setup(hostApi) {
    api = hostApi;
  },
};

export default pliteGuidePlugin;
