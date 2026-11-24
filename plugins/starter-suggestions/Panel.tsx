/**
 * StarterSuggestionsPanel：开场建议管理面板。
 * 列表/启停/新增/编辑/删除 + AI 生成一批 + 重置为内置池。
 * 数据经 index.ts 的 kv 层（与 AI 工具同键空间），suggestions-changed 事件驱动刷新。
 */
import { useCallback, useEffect, useState } from 'react';
import { loadPool, savePool, getPanelHostApi } from './index';
import { SUGGESTIONS, CATEGORY_LABEL, type CategoryId, type StarterSuggestion } from '../shared/suggestion-types';

/**
 * cap.ai.chat 一次性调用：dispatch 只回「投递成功」，正文走 cap.ai.chat:event 流式收集
 * （对齐 voice-radio controller 的下降沿收敛：message.done / loop.done / stream.error）。
 * 独立 sessionId/messageId 防串台；超时兜底收敛，避免面板永远停在「生成中」。
 */
async function requestAiOnce(prompt: string, timeoutMs = 90_000): Promise<string> {
  const hostApi = getPanelHostApi();
  if (!hostApi) throw new Error('宿主 API 未就绪（插件尚未 setup）');

  const sessionId = `ss-gen-${Date.now().toString(36)}`;
  const messageId = `ss-msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  return new Promise<string>((resolve, reject) => {
    let text = '';
    let settled = false;
    let off: () => void = () => undefined;
    const finishOk = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      off();
      resolve(text);
    };
    const finishFail = (msg: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      off();
      reject(new Error(msg));
    };
    const timer = setTimeout(() => finishFail(text ? '生成超时（已收到部分内容）' : '生成超时：AI 无响应'), timeoutMs);

    off = hostApi.listen('cap.ai.chat:event', (raw) => {
      const ev = (raw ?? {}) as { kind?: string; payload?: { sessionId?: string; messageId?: string; delta?: string; message?: string; interrupted?: boolean } };
      const inner = ev.payload ?? {};
      // 防串台：只消费本次生成轮次的事件
      if (inner.sessionId && inner.sessionId !== sessionId) return;
      if (inner.messageId && inner.messageId !== messageId) return;
      if (ev.kind === 'message.delta' && inner.delta) {
        text += inner.delta;
      } else if (ev.kind === 'message.reasoning' || ev.kind === 'tool.card' || ev.kind === 'tool.result') {
        // 思考流/工具卡不进正文
      } else if (ev.kind === 'loop.done' || ev.kind === 'message.done') {
        if (inner.interrupted) { finishFail('已中断'); return; }
        finishOk();
      } else if (ev.kind === 'stream.error') {
        finishFail(inner.message ?? '流式请求失败');
      }
    });

    void hostApi
      .dispatch({ target: 'cap.ai.chat', action: 'start', payload: { sessionId, messageId, prompt, history: [] } })
      .catch((err: unknown) => finishFail(err instanceof Error ? err.message : String(err)));
  });
}

const CATEGORIES: CategoryId[] = ['explore', 'tools', 'code', 'write', 'think', 'play'];
const SOURCE_LABEL: Record<StarterSuggestion['source'], string> = { builtin: '内置', ai: 'AI', user: '手动' };

type Draft = { label: string; prompt: string; category: CategoryId };
const EMPTY_DRAFT: Draft = { label: '', prompt: '', category: 'explore' };

export function StarterSuggestionsPanel() {
  const [items, setItems] = useState<StarterSuggestion[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null); // null=无编辑，'new'=新增
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [msg, setMsg] = useState<{ text: string; err?: boolean }>({ text: '' });
  const [generating, setGenerating] = useState(false);

  const refresh = useCallback(async () => {
    const pool = await loadPool();
    setItems(pool.items);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // AI 工具增删后：suggestions-changed → 即时刷新（index.ts emit 时同步派发 DOM 事件）
  useEffect(() => {
    const fn = () => void refresh();
    window.addEventListener('suggestions-changed', fn);
    return () => window.removeEventListener('suggestions-changed', fn);
  }, [refresh]);

  const flash = (text: string, err = false) => {
    setMsg({ text, err });
    if (text) window.setTimeout(() => setMsg({ text: '' }), 2500);
  };

  const startEdit = (s: StarterSuggestion) => {
    setEditingId(s.id);
    setDraft({ label: s.label, prompt: s.prompt, category: s.category });
  };

  const submitDraft = async () => {
    const label = draft.label.trim();
    const prompt = draft.prompt.trim();
    if (!label || !prompt) { flash('标题与提示词都不能为空', true); return; }
    if (editingId === 'new') {
      const item: StarterSuggestion = {
        id: `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        label, prompt, category: draft.category,
        enabled: true, source: 'user', createdAt: new Date().toISOString(), uses: 0,
      };
      await savePool([...items, item]);
      flash('已添加');
    } else if (editingId) {
      const next = items.map((s) => (s.id === editingId ? { ...s, label, prompt, category: draft.category } : s));
      await savePool(next);
      flash('已保存');
    }
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
    void refresh();
  };

  const toggleEnabled = async (s: StarterSuggestion) => {
    await savePool(items.map((x) => (x.id === s.id ? { ...x, enabled: !x.enabled } : x)));
    void refresh();
  };

  const remove = async (s: StarterSuggestion) => {
    if (!window.confirm(`删除这条建议？\n${s.label}`)) return;
    await savePool(items.filter((x) => x.id !== s.id));
    flash('已删除');
    void refresh();
  };

  const resetBuiltin = async () => {
    if (!window.confirm('重置为内置 30 条？当前所有自定义/AI 建议都会被清除。')) return;
    await savePool(SUGGESTIONS.map((s0, i) => ({
      id: `b-${String(i + 1).padStart(3, '0')}`,
      label: s0.label,
      prompt: s0.prompt,
      category: s0.category,
      enabled: true,
      source: 'builtin' as const,
      createdAt: new Date().toISOString(),
    })));
    flash('已重置为内置池');
    void refresh();
  };

  /** 让 AI 生成一批：cap.ai.chat 流式总线（dispatch 只回投递确认，正文经 :event 事件流收集，对齐 voice-radio）；JSON 数组白名单校验入池 */
  const generateWithAi = async () => {
    if (generating) return;
    setGenerating(true);
    setMsg({ text: '' });
    try {
      const existing = items.map((s) => s.label).slice(0, 30);
      const instruction =
        '请为 AI 对话产品的新会话首页生成 5 条「开场建议」。要求：覆盖不同使用场景（探索/工具/编程/写作/思考/趣味任选），' +
        '每条含 label（短标题，不超过20字）和 prompt（用户点击后发给 AI 的完整提示词，不超过200字，具体可执行）。' +
        `已有建议（不要重复）：${JSON.stringify(existing)}。` +
        '只返回 JSON 数组，不要任何其他文字：[{"label":"...","prompt":"...","category":"explore|tools|code|write|think|play"}]';
      const text = await requestAiOnce(instruction);
      const match = text.match(/\[[\s\S]*\]/);
      if (!match) throw new Error('AI 未返回有效 JSON 数组');
      const arr = JSON.parse(match[0]) as unknown;
      if (!Array.isArray(arr)) throw new Error('AI 返回的不是数组');
      const next = [...items];
      let added = 0;
      for (const raw of arr) {
        const o = (raw ?? {}) as Record<string, unknown>;
        const label = typeof o.label === 'string' ? o.label.trim().slice(0, 40) : '';
        const prompt = typeof o.prompt === 'string' ? o.prompt.trim().slice(0, 500) : '';
        const category = CATEGORIES.includes(o.category as CategoryId) ? (o.category as CategoryId) : 'explore';
        if (!label || !prompt) continue;
        if (next.some((s) => s.prompt === prompt)) continue;
        next.push({
          id: `ai-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          label, prompt, category, enabled: true, source: 'ai',
          createdAt: new Date().toISOString(), uses: 0,
        });
        added += 1;
      }
      if (!added) throw new Error('没有可用的新建议（可能全部重复或格式不合格）');
      await savePool(next.slice(0, 200));
      flash(`AI 已生成 ${added} 条`);
      void refresh();
    } catch (err) {
      flash(`生成失败：${err instanceof Error ? err.message : String(err)}`, true);
    } finally {
      setGenerating(false);
    }
  };

  const editing = editingId === 'new' || (editingId && items.find((s) => s.id === editingId));

  return (
    <div className="ss-panel" data-testid="starter-suggestions">
      <div className="ss-toolbar">
        <button className="primary" onClick={() => { setEditingId('new'); setDraft(EMPTY_DRAFT); }}>+ 新增</button>
        <button onClick={generateWithAi} disabled={generating}>{generating ? '生成中…' : 'AI 生成'}</button>
        <button onClick={resetBuiltin}>重置内置</button>
        <span className="ss-count">{items.length} 条</span>
      </div>

      {editing && (
        <div className="ss-form">
          <label>
            标题（≤40 字）
            <input
              value={draft.label}
              maxLength={40}
              onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
              placeholder="例：帮我规划一次周末出行"
            />
          </label>
          <label>
            完整提示词（≤500 字）
            <textarea
              value={draft.prompt}
              maxLength={500}
              rows={3}
              onChange={(e) => setDraft((d) => ({ ...d, prompt: e.target.value }))}
              placeholder="点击后填入输入框的完整提示词"
            />
          </label>
          <div className="ss-form-row">
            <label>
              分类
              <select value={draft.category} onChange={(e) => setDraft((d) => ({ ...d, category: e.target.value as CategoryId }))}>
                {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
              </select>
            </label>
            <div className="ss-form-btns" style={{ alignSelf: 'flex-end' }}>
              <button onClick={() => { setEditingId(null); setDraft(EMPTY_DRAFT); }}>取消</button>
              <button className="primary" onClick={submitDraft}>保存</button>
            </div>
          </div>
        </div>
      )}

      <div className="ss-msg" data-err={msg.err ? '1' : undefined}>{msg.text}</div>

      <div className="ss-body">
        {items.length === 0 && <div className="ss-empty">建议池为空，点「重置内置」或「新增」开始</div>}
        {items.map((s) => (
          <div key={s.id} className={`ss-item${s.enabled ? '' : ' off'}`}>
            <span className={`ss-dot dot-${s.category}`} aria-hidden="true" />
            <div className="ss-item-main">
              <div className="ss-item-label">
                {s.label}
                <span className={`ss-tag${s.source === 'ai' ? ' ai' : ''}`}>{SOURCE_LABEL[s.source]}</span>
                {s.source !== 'builtin' && (
                  <span className="ss-tag">{CATEGORY_LABEL[s.category]}</span>
                )}
              </div>
              <div className="ss-item-prompt" title={s.prompt}>{s.prompt}</div>
            </div>
            <div className="ss-actions">
              <button title={s.enabled ? '停用' : '启用'} onClick={() => void toggleEnabled(s)}>{s.enabled ? '停用' : '启用'}</button>
              <button onClick={() => startEdit(s)}>编辑</button>
              <button onClick={() => void remove(s)}>删除</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default StarterSuggestionsPanel;
