/**
 * SkillPanel —— 技能库面板（panel 槽）。
 *
 * 功能：技能列表（来源徽标）/ 详情展开（SKILL.md 全文）/ 重新扫描 / 斜杠用法说明。
 * 只读面板：技能文件即真相（放目录即生效），不做新建/编辑。
 * 数据面：直接 fetch /api/skills/*（同源 cookie），无自注册 cap。
 * 英文描述就地翻译：点「译」按钮 → translate 插件 server 代理（失败静默，不打断面板）。
 */
import { useCallback, useEffect, useState } from 'react';

interface SkillRow {
  name: string;
  description: string;
  whenToUse: string;
  source: string;
}

/** 英文判定：无 CJK、含拉丁字母、长度达标（与 translate 插件同口径） */
function isEnglishDesc(text: string): boolean {
  if (!text || text.length < 12) return false;
  if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(text)) return false;
  return /[a-zA-Z]/.test(text);
}

/** 就地翻译一条描述：百度代理优先，失败静默返回 null（面板不打断） */
async function translateDesc(text: string): Promise<string | null> {
  try {
    const res = await fetch('/api/translate/translate', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, to: 'zh' }),
    });
    const j = (await res.json().catch(() => null)) as { ok?: boolean; result?: string } | null;
    return j?.ok && j.result ? j.result : null;
  } catch {
    return null;
  }
}

/** 单条描述 + 「译」按钮（译文就地展开在原文下方；不弹层不切面板）。variant 控制外层 class（desc/when） */
function TranslatableDesc({ text, variant = 'desc' }: { text: string; variant?: 'desc' | 'when' }) {
  const [zh, setZh] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!isEnglishDesc(text)) {
    return variant === 'when'
      ? <div className="sk-when">何时用：{text}</div>
      : <div className="sk-desc">{text}</div>;
  }
  const run = async () => {
    if (busy || zh) return;
    setBusy(true);
    const r = await translateDesc(text);
    setBusy(false);
    if (r) setZh(r);
  };
  return (
    <div className="sk-desc-wrap">
      {variant === 'when'
        ? <div className="sk-when">何时用：{text}<button className="sk-tr-btn" disabled={busy} onClick={run} title="翻译为中文">{busy ? '…' : zh ? '已译' : '译'}</button></div>
        : <div className="sk-desc">{text}<button className="sk-tr-btn" disabled={busy} onClick={run} title="翻译为中文">{busy ? '…' : zh ? '已译' : '译'}</button></div>}
      {zh && <div className={`sk-desc zh ${variant === 'when' ? 'when-zh' : ''}`}>{zh}</div>}
    </div>
  );
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
          {s.description && <TranslatableDesc text={s.description} />}
          {s.whenToUse && <TranslatableDesc text={s.whenToUse} variant="when" />}
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
