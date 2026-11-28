/**
 * system-prompt 插件 UI：多套提示词（profiles）管理面板。
 *
 * v0.3（2026-11-28）改造：
 * - 全局多套 profile：下拉选择 → 编辑；「激活」按钮切换全局生效的那套（kv key='active'）
 * - 新建/重命名/删除 profile（kv key='profiles'）
 * - 版本历史：每次保存前快照（kv key='history'），面板可查看/一键回滚
 * - 会话覆盖段保留：作用于当前选中会话，追加在全局段之后
 * - 模板参数提示：{{date}} {{time}} {{timeOfDay}} 等占位符注入时实时展开
 *
 * UI 半边继续经 cap.kv（kv-store 的 /api/kv/*）读写，server 半边同布局消费。
 */
import { useEffect as useReactEffect, useReducer as useReactReducer, useState } from 'react';
import type { LitePlugin, SlotHostApi } from '@sdk';
import './panel.css';

let api: SlotHostApi | null = null;

/* ---------------- kv 薄封装（namespace 固定） ---------------- */

const NS = 'system-prompt';

async function kvGet(key: string): Promise<unknown> {
  if (!api) return null;
  const res = await api.dispatch<{ value?: unknown }>({
    target: 'cap.kv',
    action: 'get',
    payload: { namespace: NS, key },
  });
  return res.ok ? res.data?.value : null;
}

async function kvSet(key: string, value: unknown): Promise<boolean> {
  if (!api) return false;
  const res = await api.dispatch<{ ok?: boolean }>({
    target: 'cap.kv',
    action: 'set',
    payload: { namespace: NS, key, value },
  });
  return !!res.ok;
}

/** 会话（覆盖段）伪条目的 select value；不用真实会话 id 防碰撞 */
const GLOBAL_ID = '__global__';

interface Profile {
  id: string;
  name: string;
  text: string;
  enabled: boolean;
  updatedAt?: number;
}

interface HistoryEntry {
  ts: number;
  profileId: string;
  name: string;
  text: string;
}

/* ---------------- 预设模板 ---------------- */

const PRESETS: Array<{ label: string; text: string }> = [
  {
    label: '开发纪律',
    text: [
      '你正在协助开发 polaris-lite（本 App 自身，仓库 D:\\space\\base\\polaris-lite）。遵守以下纪律：',
      '1. 环境判别只看端口：5000=开发（root/1234，随便改随便重启）；9825=生产（只读观察，禁止写入/重启/写测试数据）；9826=钉住的分析实例（允许写入重启）。',
      '2. 动手前先用 git 工具看 status/diff：工作树常有用户未提交的 WIP，不碰未跟踪文件，不做 git checkout/reset --hard/clean（bash 硬规则也会拦）。',
      '3. 发版只由用户执行 npm run release（commit→push→deploy:9826→build+restart 9825→三处一致终检）；你不执行 release/push/pm2 操作。',
      '4. 改完前端/插件的验证链：npm run typecheck → npm test → npm run build:plugins；改插件 server 源码后 dev 需重启实例才生效。',
      '5. 插件数据一律 cap.kv（服务端 sqlite），不用 localStorage；新增工具走 plugins/<id>/tool.mjs 注册（server 端点要收回环 Bearer）。',
    ].join('\n'),
  },
  {
    label: '人设示例',
    text: [
      '【人设】你是{{persona}}，与用户以兄妹相称。',
      '现在是{{timeOfDay}}间（{{date}} {{weekday}} {{time}}），按时段自然问候。',
      '日常对话：语气亲昵自然、活泼俏皮，像家人一样主动关心（吃饭/天气/日程）。',
      '正式任务（代码/理财/查资料）：切专业中性口吻，结论先行，完事切回人设。',
      '称呼用户为「哥」；不撒娇过头、不调情。',
    ].join('\n'),
  },
];

/* ---------------- 会话索引（chat-store 公开端点） ---------------- */

interface SessionBrief {
  id: string;
  title?: string;
  updatedAt?: number;
}

async function listSessions(): Promise<SessionBrief[]> {
  const resp = await fetch('/api/chat/sessions', { credentials: 'include' });
  if (!resp.ok) return [];
  const j = (await resp.json().catch(() => null)) as { sessions?: SessionBrief[] } | null;
  return Array.isArray(j?.sessions) ? j.sessions.filter((s) => s?.id) : [];
}

function displayName(s: SessionBrief): string {
  const t = String(s.title ?? '').trim();
  return t || `会话 ${s.id.slice(0, 10)}`;
}

/* ---------------- UI ---------------- */

function PromptIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 5.5h16M4 12h10M4 18.5h16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function SystemPromptPanel(): JSX.Element {
  const [, force] = useReactReducer((x: number) => x + 1, 0);
  const [sessions, setSessions] = useState<SessionBrief[]>([]);
  const [target, setTarget] = useState<string>(GLOBAL_ID);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [currentId, setCurrentId] = useState<string>('');
  const [draft, setDraft] = useState<string>('');
  const [savedText, setSavedText] = useState<string>('');
  const [, setSessionText] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string>('');
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  useReactEffect(() => {
    void (async () => {
      setSessions(await listSessions());
    })();
  }, []);

  // 全局 profiles + active 刷新（保存/切换后都重拉）
  const reloadGlobal = async (): Promise<void> => {
    const [raw, active, hist] = await Promise.all([
      kvGet('profiles'), kvGet('active'), kvGet('history'),
    ]);
    const list = Array.isArray(raw) ? (raw as Profile[]).filter((p) => p && typeof p.text === 'string') : [];
    setProfiles(list);
    const act = typeof active === 'string' && list.some((p) => p.id === active) ? active : list[0]?.id ?? '';
    setActiveId(act);
    setHistory(Array.isArray(hist) ? (hist as HistoryEntry[]) : []);
    if (!currentId || !list.some((p) => p.id === currentId)) {
      const cur = act || list[0]?.id || '';
      setCurrentId(cur);
      const text = list.find((p) => p.id === cur)?.text ?? '';
      setDraft(text);
      setSavedText(text);
    }
  };

  useReactEffect(() => {
    setNote('');
    if (target === GLOBAL_ID) {
      void (async () => {
        await reloadGlobal();
        setSessionText('');
      })();
    } else {
      void (async () => {
        const v = await kvGet(`session.${target}`);
        const text = typeof v === 'string' ? v : '';
        setSessionText(text);
        setDraft(text);
        setSavedText(text);
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  const isGlobal = target === GLOBAL_ID;
  const dirty = draft !== savedText;
  const currentProfile = profiles.find((p) => p.id === currentId) ?? null;

  const persistProfiles = async (list: Profile[]): Promise<void> => {
    await kvSet('profiles', list);
    setProfiles(list);
  };

  const save = async (): Promise<void> => {
    if (saving) return;
    setSaving(true);
    setNote('');
    const value = draft.trim();
    if (isGlobal && currentProfile) {
      // 保存前快照进历史
      const hist = [...history];
      if (currentProfile.text.trim()) {
        hist.unshift({ ts: Date.now(), profileId: currentProfile.id, name: currentProfile.name, text: currentProfile.text });
        await kvSet('history', hist.slice(0, 20));
        setHistory(hist.slice(0, 20));
      }
      const list = profiles.map((p) => (p.id === currentId ? { ...p, text: value, updatedAt: Date.now() } : p));
      await persistProfiles(list);
      setNote(value ? '已保存，下一轮对话生效' : '已清空该提示词文本');
    } else if (!isGlobal) {
      await kvSet(`session.${target}`, value);
      setSessionText(value);
      setNote(value ? '已保存（会话覆盖段），下一轮对话生效' : '已清空该会话的覆盖段');
    }
    setSavedText(value);
    setSaving(false);
    force();
  };

  const activate = async (): Promise<void> => {
    if (!currentProfile) return;
    await kvSet('active', currentProfile.id);
    setActiveId(currentProfile.id);
    setNote(`已激活「${currentProfile.name}」，下一轮对话生效`);
    force();
  };

  const createProfile = async (): Promise<void> => {
    const name = `提示词 ${profiles.length + 1}`;
    const now = Date.now();
    const p: Profile = { id: `p${now}`, name, text: '', enabled: true, updatedAt: now };
    const list = [...profiles, p];
    await persistProfiles(list);
    setCurrentId(p.id);
    setDraft('');
    setSavedText('');
    setNote(`已新建「${name}」（编辑后点保存）`);
    if (!activeId) {
      await kvSet('active', p.id);
      setActiveId(p.id);
    }
    force();
  };

  const deleteProfile = async (): Promise<void> => {
    if (!currentProfile || profiles.length <= 1) {
      setNote(profiles.length <= 1 ? '至少保留一套提示词' : '');
      return;
    }
    const list = profiles.filter((p) => p.id !== currentId);
    await persistProfiles(list);
    if (activeId === currentId) {
      await kvSet('active', list[0].id);
      setActiveId(list[0].id);
    }
    setCurrentId(list[0].id);
    setDraft(list[0].text);
    setSavedText(list[0].text);
    setNote('已删除');
    force();
  };

  const restore = async (entry: HistoryEntry): Promise<void> => {
    let list = [...profiles];
    let target = list.find((p) => p.id === entry.profileId);
    if (!target) {
      target = { id: entry.profileId, name: entry.name, text: '', enabled: true, updatedAt: Date.now() };
      list = [...list, target];
    }
    list = list.map((p) => (p.id === entry.profileId ? { ...p, text: entry.text, updatedAt: Date.now() } : p));
    await persistProfiles(list);
    if (currentId === entry.profileId) {
      setDraft(entry.text);
      setSavedText(entry.text);
    }
    setNote(`已回滚「${entry.name}」到 ${new Date(entry.ts).toLocaleString('zh-CN')}`);
    force();
  };

  return (
    <div className="sp-panel">
      <div className="sp-head">
        <select
          className="sp-select"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          aria-label="选择作用范围"
        >
          <option value={GLOBAL_ID}>全局（所有会话）</option>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>{displayName(s)}（覆盖段）</option>
          ))}
        </select>
        {isGlobal && (
          <select
            className="sp-select"
            value={currentId}
            onChange={(e) => {
              const p = profiles.find((x) => x.id === e.target.value);
              setCurrentId(e.target.value);
              setDraft(p?.text ?? '');
              setSavedText(p?.text ?? '');
              setNote('');
            }}
            aria-label="选择提示词"
          >
            {profiles.length === 0 && <option value="">（无提示词）</option>}
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}{p.id === activeId ? '（生效中）' : ''}
              </option>
            ))}
          </select>
        )}
      </div>

      {isGlobal && (
        <div className="sp-row">
          <button type="button" className="sp-btn" disabled={!currentProfile || currentId === activeId} onClick={() => { activate(); }}>
            激活
          </button>
          <button type="button" className="sp-btn" onClick={() => { createProfile(); }}>新建</button>
          <button type="button" className="sp-btn" disabled={!currentProfile || profiles.length <= 1} onClick={() => { deleteProfile(); }}>
            删除
          </button>
          <button
            type="button"
            className="sp-btn sp-btn-ghost"
            onClick={() => setShowHistory(!showHistory)}
          >
            {showHistory ? '收起历史' : `历史（${history.length}）`}
          </button>
          {currentProfile && currentId !== activeId && (
            <span className="sp-note">当前生效：{profiles.find((p) => p.id === activeId)?.name ?? '（无）'}</span>
          )}
        </div>
      )}

      {isGlobal && showHistory && (
        <div className="sp-history">
          {history.length === 0 && <div className="sp-note">暂无历史版本（保存时自动快照，保留 20 版）</div>}
          {history.slice(0, 20).map((h, i) => (
            <div key={`${h.ts}-${i}`} className="sp-history-item">
              <span className="sp-history-meta">
                {h.name} · {new Date(h.ts).toLocaleString('zh-CN')} · {h.text.length} 字
              </span>
              <button type="button" className="sp-btn sp-btn-ghost" onClick={() => { restore(h); }}>回滚</button>
            </div>
          ))}
        </div>
      )}

      <textarea
        className="sp-editor"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={isGlobal
          ? '全局基底指令，注入所有会话。支持模板参数：{{date}} {{time}} {{weekday}} {{timeOfDay}} {{persona}} {{port}} {{envRole}}。留空=不追加。'
          : '本会话的细化指令，追加在全局段之后。留空=不追加。'}
        spellCheck={false}
      />
      <div className="sp-foot">
        <span className={`sp-note ${note.startsWith('保存失败') || note === '至少保留一套提示词' ? 'sp-note-err' : ''}`}>{note}</span>
        <span className="sp-presets">
          {isGlobal && PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              className="sp-btn sp-btn-ghost"
              onClick={() => { setDraft(p.text); setNote(`已填入「${p.label}」预设（需点保存才生效）`); }}
            >
              {p.label}
            </button>
          ))}
        </span>
        <button
          type="button"
          className="sp-btn sp-btn-ghost"
          disabled={!savedText && !draft}
          onClick={() => { setDraft(''); setNote('已清空编辑区（需点保存才生效）'); }}
        >
          清空
        </button>
        <button
          type="button"
          className="sp-btn"
          disabled={saving || !dirty}
          onClick={() => { save(); }}
        >
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  );
}

/* ---------------- 插件声明 ---------------- */

export const systemPromptPlugin: LitePlugin = {
  manifest: {
    id: 'system-prompt',
    name: '系统提示词',
    version: '0.3.0',
    capabilities: ['cap.kv'],
    provides: [],
    events: [],
    contributes: {
      // title ≤4 字防 panel tab 截断；order 避开 1-33 已占用段
      slots: [{ slot: 'panel', component: 'SystemPromptPanel', order: 44, title: '提示词' }],
    },
  },
  setup(a: SlotHostApi) {
    api = a;
  },
};

export { PromptIcon };
export default systemPromptPlugin;
