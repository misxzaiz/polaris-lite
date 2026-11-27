/**
 * system-prompt 插件：用户自定义系统提示词（全局 + 会话两级）。
 *
 * 架构（对齐 docs 讨论结论 2026-11-27）：
 * - 提示词存 kv-store（namespace='system-prompt'）——服务端 sqlite 持久化，多端一致；
 *   · key='global'：全局基底段，作用于所有会话；
 *   · key=`session.<id>`：会话段，与全局段拼接（全局在前、会话在后细化）；
 * - server 半边把 { get(sessionId) } 注册进 adapter-registry 的 service 表
 *   （id='system-prompt'）——agent-runner 的 seedShadow 经 registry.getService 取用，
 *   不认识本插件的存储布局（与 kv-store / chat-store 的 service 模式同构）；
 * - 追加而非替换：runner 把用户段拼在内置 system prompt 之后（环境纪律保留在前）。
 *
 * UI 半边只贡献一个 panel 槽位：选会话 → 编辑 → 保存。会话列表来自 chat-store
 * 的公开索引 GET /api/chat/sessions（只读，不依赖 chat-lite 内部 store）。
 */
import { useEffect as useReactEffect, useReducer as useReactReducer, useState } from 'react';
import type { LitePlugin, SlotHostApi } from '@sdk';
import './panel.css';

let api: SlotHostApi | null = null;

/* ---------------- kv 薄封装（namespace 固定） ---------------- */

const NS = 'system-prompt';

async function kvGet(key: string): Promise<string | null> {
  if (!api) return null;
  const res = await api.dispatch<{ value?: unknown }>({
    target: 'cap.kv',
    action: 'get',
    payload: { namespace: NS, key },
  });
  const v = res.ok ? res.data?.value : null;
  return typeof v === 'string' ? v : null;
}

async function kvSet(key: string, value: string): Promise<boolean> {
  if (!api) return false;
  const res = await api.dispatch<{ ok?: boolean }>({
    target: 'cap.kv',
    action: 'set',
    payload: { namespace: NS, key, value },
  });
  return !!res.ok;
}

/** 全局（所有会话）伪条目的 select value；不用真实会话 id 防碰撞 */
const GLOBAL_ID = '__global__';

/** UI 选中项 → kv key */
function kvKeyOf(target: string): string {
  return target === GLOBAL_ID ? 'global' : `session.${target}`;
}

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

/* ---------------- UI ---------------- */

function PromptIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 5.5h16M4 12h10M4 18.5h16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** 会话显示名：标题缺省回退 id 前 10 字（与侧栏「新会话」语义不冲突，这里只作选择参考） */
function displayName(s: SessionBrief): string {
  const t = String(s.title ?? '').trim();
  return t || `会话 ${s.id.slice(0, 10)}`;
}

export function SystemPromptPanel(): JSX.Element {
  const [, force] = useReactReducer((x: number) => x + 1, 0);
  const [sessions, setSessions] = useState<SessionBrief[]>([]);
  const [target, setTarget] = useState<string>(GLOBAL_ID);
  const [text, setText] = useState<string>('');
  const [draft, setDraft] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string>('');

  // 加载会话索引；面板打开即拉（会话增删靠手动刷新按钮，不订阅 SSE——轻量优先）
  useReactEffect(() => {
    void (async () => {
      const list = await listSessions();
      setSessions(list);
    })();
  }, []);

  // 选中目标变化：读对应提示词进编辑器（全局或会话）
  useReactEffect(() => {
    setNote('');
    void (async () => {
      const v = await kvGet(kvKeyOf(target));
      setText(v ?? '');
      setDraft(v ?? '');
    })();
  }, [target]);

  const isGlobal = target === GLOBAL_ID;
  const dirty = draft !== text;

  const save = async (): Promise<void> => {
    if (saving) return;
    setSaving(true);
    setNote('');
    const value = draft.trim();
    const ok = await kvSet(kvKeyOf(target), value);
    setSaving(false);
    if (ok) {
      setText(value);
      setNote(value ? '已保存，下一轮对话生效' : `已清空${isGlobal ? '全局' : '该会话'}的提示词`);
    } else {
      setNote('保存失败（cap.kv 不可用？）');
    }
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
          {sessions.length === 0 && <option value="">（暂无会话）</option>}
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>{displayName(s)}</option>
          ))}
        </select>
        <button
          type="button"
          className="sp-btn"
          disabled={saving || !dirty}
          onClick={() => void save()}
        >
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
      <textarea
        className="sp-editor"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={isGlobal
          ? '全局基底指令，注入所有会话（如：回答始终用中文；先给结论再展开…）。留空=不追加。'
          : '本会话的细化指令，追加在全局段之后（如：回答用英文；你是资深 DBA…）。留空=不追加。'}
        spellCheck={false}
      />
      <div className="sp-foot">
        <span className={`sp-note ${note.startsWith('保存失败') ? 'sp-note-err' : ''}`}>{note}</span>
        <button
          type="button"
          className="sp-btn sp-btn-ghost"
          disabled={!text}
          onClick={() => { setDraft(''); setNote('已清空编辑区（需点保存才生效）'); }}
        >
          清空
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
    version: '0.2.0',
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
