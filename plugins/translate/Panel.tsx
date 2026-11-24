/**
 * TranslatePanel：翻译面板。
 * - 未配置密钥：内嵌配置表单（App ID + Secret Key，提交到 server 半边存储）；
 * - 已配置：方向切换（自动/中/英/日/韩/法/德/俄/西/文言）+ 输入框 + 结果区（复制）+ 历史（点击回填）。
 * 数据经 index.ts 的 server 代理与 cap.kv 历史层，translate-history-changed 事件驱动刷新。
 */
import { useCallback, useEffect, useState } from 'react';
import {
  callTranslate, fetchTranslateConfig, saveTranslateConfig,
  listHistory, pushHistory, clearHistory, autoTargetLang,
  type HistoryItem, type TranslateConfigStatus,
} from './index';

const LANGS = [
  { code: 'auto', label: '自动' },
  { code: 'zh', label: '中文' },
  { code: 'en', label: '英语' },
  { code: 'jp', label: '日语' },
  { code: 'kor', label: '韩语' },
  { code: 'fra', label: '法语' },
  { code: 'de', label: '德语' },
  { code: 'ru', label: '俄语' },
  { code: 'spa', label: '西班牙语' },
  { code: 'wyw', label: '文言文' },
];

export function TranslatePanel() {
  const [config, setConfig] = useState<TranslateConfigStatus | null>(null);
  const [appIdInput, setAppIdInput] = useState('');
  const [secretInput, setSecretInput] = useState('');
  const [saving, setSaving] = useState(false);

  const [text, setText] = useState('');
  const [to, setTo] = useState('auto');
  const [result, setResult] = useState('');
  const [srcLangNote, setSrcLangNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; err?: boolean }>({ text: '' });
  const [history, setHistory] = useState<HistoryItem[]>([]);

  const refresh = useCallback(async () => {
    const [cfg, hist] = await Promise.all([fetchTranslateConfig(), listHistory()]);
    setConfig(cfg);
    setHistory(hist);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    const fn = () => void refresh();
    window.addEventListener('translate-history-changed', fn);
    return () => window.removeEventListener('translate-history-changed', fn);
  }, [refresh]);

  const flash = (t: string, err = false) => {
    setMsg({ text: t, err });
    if (t) window.setTimeout(() => setMsg({ text: '' }), 2500);
  };

  const submitConfig = async () => {
    if (!appIdInput.trim() || !secretInput.trim()) { flash('App ID 与密钥都不能为空', true); return; }
    setSaving(true);
    try {
      const r = await saveTranslateConfig(appIdInput.trim(), secretInput.trim());
      if (!r.ok) throw new Error(r.error ?? '保存失败');
      flash('已保存，可以开始翻译了');
      setSecretInput('');
      await refresh();
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e), true);
    } finally {
      setSaving(false);
    }
  };

  const doTranslate = async () => {
    const t = text.trim();
    if (!t) { flash('请输入要翻译的内容', true); return; }
    if (busy) return;
    setBusy(true);
    setResult('');
    setSrcLangNote('');
    try {
      const target = to === 'auto' ? autoTargetLang(t) : to;
      const r = await callTranslate(t, target);
      if (!r.ok) throw new Error(r.error ?? '翻译失败');
      setResult(r.result ?? '');
      setSrcLangNote(r.cached ? '（缓存）' : '');
      void pushHistory(t, r.result ?? '', target);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBusy(false);
    }
  };

  const copyResult = async () => {
    if (!result) return;
    try {
      const nav = navigator as Navigator & { clipboard?: { writeText(t: string): Promise<void> } };
      await nav.clipboard?.writeText(result);
      flash('已复制');
    } catch {
      flash('复制失败', true);
    }
  };

  // ── 配置态 ──
  if (config && !config.configured) {
    return (
      <div className="tr-panel" data-testid="translate-panel">
        <div className="tr-config">
          <div className="tr-config-title">配置百度翻译密钥</div>
          <p className="tr-config-hint">
            在<a href="https://fanyi-api.baidu.com/" target="_blank" rel="noreferrer">百度翻译开放平台</a>注册后，
            在「我的服务」里开通「通用文本翻译」，把 App ID 与密钥填到这里。个人版免费，密钥只保存在本机服务端。
          </p>
          <label>
            App ID
            <input value={appIdInput} onChange={(e) => setAppIdInput(e.target.value)} placeholder="百度翻译 App ID" />
          </label>
          <label>
            Secret Key
            <input type="password" value={secretInput} onChange={(e) => setSecretInput(e.target.value)} placeholder="百度翻译密钥" />
          </label>
          <button className="primary" onClick={submitConfig} disabled={saving}>{saving ? '保存中…' : '保存'}</button>
          <div className="tr-msg" data-err={msg.err ? '1' : undefined}>{msg.text}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="tr-panel" data-testid="translate-panel">
      <div className="tr-toolbar">
        <select value={to} onChange={(e) => setTo(e.target.value)} title="目标语言（自动=按内容判断中英互译）">
          {LANGS.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
        </select>
        <button className="primary" onClick={doTranslate} disabled={busy || !text.trim()}>
          {busy ? '翻译中…' : '翻译'}
        </button>
        <span className="tr-count">{text.length} 字</span>
      </div>

      <textarea
        className="tr-input"
        value={text}
        rows={5}
        placeholder="输入要翻译的文本（含中文自动译英，否则译中；也可在上方指定目标语言）"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void doTranslate(); }
        }}
      />

      <div className="tr-msg" data-err={msg.err ? '1' : undefined}>{msg.text}</div>

      {result && (
        <div className="tr-result">
          <div className="tr-result-head">
            <span>译文 {srcLangNote}</span>
            <button onClick={copyResult}>复制</button>
          </div>
          <div className="tr-result-body">{result}</div>
        </div>
      )}

      <div className="tr-hist-head">
        <span>历史（{history.length}）</span>
        {history.length > 0 && <button onClick={() => void clearHistory()}>清空</button>}
      </div>
      <div className="tr-hist">
        {history.length === 0 && <div className="tr-empty">暂无翻译记录</div>}
        {history.map((h) => (
          <button key={h.id} className="tr-hist-item" title={`${h.text}\n${h.result}`}
            onClick={() => { setText(h.text); setResult(h.result); setTo(h.to); }}>
            <span className="tr-hist-text">{h.text}</span>
            <span className="tr-hist-result">{h.result}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export default TranslatePanel;
