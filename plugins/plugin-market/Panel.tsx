/**
 * MarketPanel —— 插件商城面板（panel 槽）。
 *
 * 页签：
 *  - 商城：源内插件卡片（版本/描述/安装态/更新提示/安装按钮）；
 *  - 已装：外部插件列表（卸载 + 「刷新页面生效」提示；启停走插件管理面板）；
 *  - 源：源管理（添加本地目录源/删除）+ warns；
 *  - 说明：信任模型（外部插件与宿主同进程、sha256、只装可信来源）。
 *
 * 数据面：/api/market/*（同源 cookie）；安装/卸载后提示刷新页面生效。
 */
import { useCallback, useEffect, useState } from 'react';

interface MarketItem {
  id: string;
  name: string;
  version: string;
  description: string;
  sha256: string;
  tags: string[];
  source: string;
  installed: boolean;
  updatable: boolean;
  localVersion?: string;
}
interface MarketSource {
  name: string;
  type: string;
  ref: string;
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const resp = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = (await resp.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!resp.ok || j === null) throw new Error(j?.error ?? `HTTP ${resp.status}`);
  return j;
}

export function MarketPanel() {
  const [tab, setTab] = useState<'store' | 'installed' | 'sources' | 'about'>('store');
  const [items, setItems] = useState<MarketItem[]>([]);
  const [sources, setSources] = useState<MarketSource[]>([]);
  const [warns, setWarns] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState('');
  const [form, setForm] = useState({ name: '', ref: '' });
  const [armRemove, setArmRemove] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const d = await api<{ items?: MarketItem[]; sources?: MarketSource[]; warns?: string[] }>('/api/market/list');
      setItems(d.items ?? []);
      setSources(d.sources ?? []);
      setWarns(d.warns ?? []);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const install = async (source: string, id: string) => {
    setBusy(id);
    try {
      const r = await api<{ note?: string }>('/api/market/install', { source, id });
      setFlash(`已安装 ${id}${r.note ? `（${r.note}）` : ''}`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const uninstall = async (id: string) => {
    setBusy(id);
    try {
      const r = await api<{ note?: string }>('/api/market/uninstall', { id });
      setFlash(`已卸载 ${id}${r.note ? `（${r.note}）` : ''}`);
      setArmRemove(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const addSource = async () => {
    setBusy('add-source');
    try {
      await api('/api/market/sources', { name: form.name.trim(), type: 'dir', ref: form.ref.trim() });
      setForm({ name: '', ref: '' });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const removeSource = async (name: string) => {
    setBusy(`rm-src-${name}`);
    try {
      await api('/api/market/sources/remove', { name });
      setArmRemove(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const installedItems = items.filter((i) => i.installed);

  return (
    <div className="mk-panel">
      <div className="mk-tabs" role="tablist">
        {(['store', 'installed', 'sources', 'about'] as const).map((k) => (
          <button key={k} role="tab" aria-selected={tab === k}
            className={tab === k ? 'mk-tab active' : 'mk-tab'}
            onClick={() => setTab(k)}>
            {k === 'store' ? '商城' : k === 'installed' ? '已装' : k === 'sources' ? '源' : '说明'}
          </button>
        ))}
      </div>

      {error && <div className="mk-error">{error}</div>}
      {flash && <div className="mk-flash">{flash}</div>}

      {tab === 'store' && (
        <div>
          {items.length === 0 && (
            <div className="mk-empty">商城暂无插件。先在「源」页签添加一个本地目录源（目录内含 index.json 清单与插件包）。</div>
          )}
          {items.map((i) => (
            <div key={`${i.source}/${i.id}`} className="mk-item">
              <div className="mk-item-head">
                <span className="mk-name">{i.name}</span>
                <span className="mk-badge">v{i.version}</span>
                <span className="mk-badge">{i.source}</span>
                {i.installed && (
                  <span className={i.updatable ? 'mk-badge warn' : 'mk-badge ok'}>
                    {i.updatable ? `可更新（本地 v${i.localVersion ?? '?'}）` : '已安装'}
                  </span>
                )}
              </div>
              {i.description && <div className="mk-desc">{i.description}</div>}
              {i.sha256 && <div className="mk-hash">sha256: {i.sha256.slice(0, 16)}…</div>}
              <div className="mk-actions">
                {i.installed ? (
                  i.updatable ? (
                    <button className="mk-btn primary" disabled={busy === i.id} onClick={() => install(i.source, i.id)}>更新</button>
                  ) : null
                ) : (
                  <button className="mk-btn primary" disabled={busy === i.id} onClick={() => install(i.source, i.id)}>安装</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'installed' && (
        <div>
          {installedItems.length === 0 && <div className="mk-empty">尚未安装任何外部插件。</div>}
          {installedItems.map((i) => (
            <div key={i.id} className="mk-item">
              <div className="mk-item-head">
                <span className="mk-name">{i.name}</span>
                <span className="mk-badge ok">v{i.localVersion ?? '?'}</span>
              </div>
              <div className="mk-actions">
                {armRemove === i.id ? (
                  <>
                    <span className="mk-arm">确认卸载？</span>
                    <button className="mk-btn danger" disabled={busy === i.id} onClick={() => uninstall(i.id)}>确认</button>
                    <button className="mk-btn" onClick={() => setArmRemove(null)}>取消</button>
                  </>
                ) : (
                  <button className="mk-btn danger-soft" onClick={() => setArmRemove(i.id)}>卸载</button>
                )}
              </div>
            </div>
          ))}
          {installedItems.length > 0 && <div className="mk-hint">启停请到「插件」管理面板；安装/卸载后刷新页面生效。</div>}
        </div>
      )}

      {tab === 'sources' && (
        <div>
          {sources.map((s) => (
            <div key={s.name} className="mk-item">
              <div className="mk-item-head">
                <span className="mk-name">{s.name}</span>
                <span className="mk-badge">{s.type}</span>
              </div>
              <div className="mk-hash">{s.ref}</div>
              <div className="mk-actions">
                {armRemove === s.name ? (
                  <>
                    <span className="mk-arm">确认删除源？（不影响已装插件）</span>
                    <button className="mk-btn danger" disabled={busy === `rm-src-${s.name}`} onClick={() => removeSource(s.name)}>确认</button>
                    <button className="mk-btn" onClick={() => setArmRemove(null)}>取消</button>
                  </>
                ) : (
                  <button className="mk-btn danger-soft" onClick={() => setArmRemove(s.name)}>删除</button>
                )}
              </div>
            </div>
          ))}
          <div className="mk-form">
            <input className="mk-input" placeholder="源名（如 my-plugins）" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <input className="mk-input" placeholder="本地目录绝对路径（含 index.json）" value={form.ref} onChange={(e) => setForm({ ...form, ref: e.target.value })} />
            <div className="mk-form-actions">
              <button className="mk-btn primary" disabled={busy === 'add-source' || !form.name.trim() || !form.ref.trim()} onClick={addSource}>添加源</button>
            </div>
          </div>
          {warns.length > 0 && <div className="mk-warns">{warns.map((w, i) => <div key={i}>[!] {w}</div>)}</div>}
        </div>
      )}

      {tab === 'about' && (
        <div className="mk-about">
          <p><b>外部插件</b>：从商城安装的插件存放在 <code>&lt;dataDir&gt;/plugins/</code>，与内置插件物理隔离；其 bundle 经 <code>/ext-plugins/</code> 自服务路由加载。</p>
          <p className="mk-warn">[!] 外部插件与宿主**同进程**运行（前端 bundle + server 半边中间件）。请只安装可信来源——安装即信任其全部声明权限（unlistedPolicy=declare）。</p>
          <p>安装校验：sha256 指纹比对 + plugin.json 声明校验 + id 冲突拒绝 + 路径逃逸拒绝。安装/卸载后<b>刷新页面生效</b>（前端半边立即加载；server 半边需重启服务）。</p>
          <p>源格式：目录内 <code>index.json</code>（<code>{'{'}"name":…, "plugins":[{'{'}"id",…,"sha256"…{'}'}]{'}'}</code>）+ 每插件一个同名子目录（<code>plugin.json</code> + <code>plugin.js</code> [+ <code>style.css</code>]）。</p>
        </div>
      )}
    </div>
  );
}
