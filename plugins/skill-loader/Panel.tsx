/**
 * SkillPanel —— 技能库面板（panel 槽）。
 *
 * 功能：技能列表（来源徽标）/ 详情展开（SKILL.md 全文）/ 重新扫描 / 斜杠用法说明。
 * 只读面板：技能文件即真相（放目录即生效），不做新建/编辑。
 * 数据面：直接 fetch /api/skills/*（同源 cookie），无自注册 cap。
 */
import { useCallback, useEffect, useState } from 'react';

interface SkillRow {
  name: string;
  description: string;
  whenToUse: string;
  source: string;
}

const SOURCE_LABEL: Record<string, string> = {
  native: '原生',
  workspace: '工作区',
  claude: 'Claude',
  zcode: 'ZCode',
  agents: '共享',
};

export function SkillPanel() {
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const resp = await fetch('/api/skills/list', { credentials: 'include' });
      const j = (await resp.json().catch(() => null)) as { skills?: SkillRow[] } | null;
      setSkills(j?.skills ?? []);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const reload = async () => {
    setBusy(true);
    try {
      await fetch('/api/skills/reload', { method: 'POST', credentials: 'include' });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const openDetail = async (name: string) => {
    if (expanded === name) { setExpanded(null); return; }
    setExpanded(name);
    if (!detail[name]) {
      try {
        const resp = await fetch(`/api/skills/read?name=${encodeURIComponent(name)}`, { credentials: 'include' });
        const j = (await resp.json().catch(() => null)) as { ok?: boolean; content?: string } | null;
        setDetail((d) => ({ ...d, [name]: j?.ok ? (j.content ?? '') : '（读取失败）' }));
      } catch {
        setDetail((d) => ({ ...d, [name]: '（读取失败）' }));
      }
    }
  };

  return (
    <div className="sk-panel">
      <div className="sk-toolbar">
        <span className="sk-count">{skills.length} 个技能</span>
        <button className="sk-btn" disabled={busy} onClick={reload}>重新扫描</button>
      </div>
      {error && <div className="sk-error">{error}</div>}
      {skills.length === 0 && (
        <div className="sk-empty">
          尚未发现任何技能。把 <code>SKILL.md</code> 放进以下任一目录即可：
          <code>.polaris-lite/skills/&lt;名&gt;/</code>、<code>.claude/skills/&lt;名&gt;/</code>、
          <code>.zcode/skills/&lt;名&gt;/</code>、<code>.agents/skills/&lt;名&gt;/</code>；
          或用 CC/ZC 导入面板导入。
        </div>
      )}
      {skills.map((s) => (
        <div key={s.name} className="sk-item">
          <div className="sk-item-head" onClick={() => openDetail(s.name)}>
            <span className="sk-name">{s.name}</span>
            <span className="sk-badge">{SOURCE_LABEL[s.source] ?? s.source}</span>
          </div>
          {s.description && <div className="sk-desc">{s.description}</div>}
          {s.whenToUse && <div className="sk-when">何时用：{s.whenToUse}</div>}
          {expanded === s.name && (
            <pre className="sk-body">{detail[s.name] ?? '加载中…'}</pre>
          )}
        </div>
      ))}
      <div className="sk-hint">
        会话里可用 <code>/技能名 参数</code> 直接触发（命中即引导 AI 先读取全文再执行）。
      </div>
    </div>
  );
}
