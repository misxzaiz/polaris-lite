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
interface CcPlugin {
  id: string;
  description: string;
  installable: boolean;
}
interface CcMarket {
  name: string;
  owner: string;
  pluginCount: number;
  installableCount: number;
  plugins: CcPlugin[];
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
  const [tab, setTab] = useState<'store' | 'cc' | 'installed' | 'sources' | 'about'>('store');
  const [items, setItems] = useState<MarketItem[]>([]);
  const [sources, setSources] = useState<MarketSource[]>([]);
  const [ccMarkets, setCcMarkets] = useState<CcMarket[]>([]);
  const [ccQuery, setCcQuery] = useState('');
  const [warns, setWarns] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState('');
  const [needsReload, setNeedsReload] = useState(false);
  const [form, setForm] = useState({ name: '', ref: '' });
  const [armRemove, setArmRemove] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const d = await api<{ items?: MarketItem[]; sources?: MarketSource[]; ccMarkets?: CcMarket[]; warns?: string[] }>('/api/market/list');
      setItems(d.items ?? []);
      setSources(d.sources ?? []);
      setCcMarkets(d.ccMarkets ?? []);
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
      await api('/api/market/install', { source, id });
      setFlash(`已安装 ${id}，重载后可用`);
      setNeedsReload(true);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const installCc = async (market: string, id: string, target: 'global' | 'project') => {
    setBusy(`cc-${id}`);
    try {
      const r = await api<{ parts?: number; log?: string[]; note?: string; scope?: string; project?: string }>('/api/market/install', { source: market, id, target });
      const scopeNote = r.scope === 'project' ? `项目级（${r.project}）` : '全局';
      setFlash(`已导入 CC 插件 ${id}（${scopeNote}，${r.parts ?? '?'} 项：${(r.log ?? []).join('；') || '无资源'}）。skills 即刻生效；hooks/mcp 下轮会话生效。`);
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
      await api('/api/market/uninstall', { id });
      setFlash(`已卸载 ${id}，重载后移除`);
      setNeedsReload(true);
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
  const ccAll = ccMarkets.flatMap((m) => m.plugins.map((p) => ({ ...p, market: m.name })));
  const ccFiltered = ccQuery.trim()
    ? ccAll.filter((p) => `${p.id} ${p.description}`.toLowerCase().includes(ccQuery.trim().toLowerCase()))
    : ccAll;

  return (
    <div className="mk-panel">
      <div className="mk-tabs" role="tablist">
        {(['store', 'cc', 'installed', 'sources', 'about'] as const).map((k) => (
          <button key={k} role="tab" aria-selected={tab === k}
            className={tab === k ? 'mk-tab active' : 'mk-tab'}
            onClick={() => setTab(k)}>
            {k === 'store' ? '商城' : k === 'cc' ? 'CC' : k === 'installed' ? '已装' : k === 'sources' ? '源' : '说明'}
          </button>
        ))}
      </div>

      {error && <div className="mk-error">{error}</div>}
      {flash && (
        <div className="mk-flash">
          {flash}
          {needsReload && (
            <button type="button" className="mk-btn primary mk-reload-btn" onClick={() => window.location.reload()}>
              ⟳ 重载应用
            </button>
          )}
        </div>
      )}

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

      {tab === 'cc' && (
        <div>
          <div className="mk-hint">
            Claude Code 插件商城（本机 ~/.claude/plugins/marketplaces/）。安装 = 导入其<b>声明型资源</b>
            （skills → 技能面板、hooks → 钩子桥、stdio mcpServers → MCP 桥），<b>不运行外部 JS</b>。
            仅本地已 checkout 的插件可安装；远程条目需先在 Claude Code 侧安装/clone。
          </div>
          {ccMarkets.length === 0 && <div className="mk-empty">未发现 CC 商城（~/.claude/plugins/marketplaces/ 不存在或为空）。</div>}
          {ccMarkets.map((m) => (
            <div key={m.name} className="mk-item">
              <div className="mk-item-head">
                <span className="mk-name">{m.name}</span>
                <span className="mk-badge">{m.owner}</span>
                <span className="mk-badge">{m.pluginCount} 插件</span>
                <span className="mk-badge ok">{m.installableCount} 可装</span>
              </div>
            </div>
          ))}
          {ccMarkets.length > 0 && (
            <input className="mk-input" type="search" placeholder="搜索 CC 插件（id/描述）…" value={ccQuery} onChange={(e) => setCcQuery(e.target.value)} />
          )}
          {ccFiltered.slice(0, 60).map((p) => (
            <div key={`${p.market}/${p.id}`} className="mk-item">
              <div className="mk-item-head">
                <span className="mk-name">{p.id}</span>
                <span className="mk-badge">{p.market}</span>
                {!p.installable && <span className="mk-badge warn">远程（未 checkout）</span>}
              </div>
              {p.description && <div className="mk-desc">{p.description}</div>}
              <div className="mk-actions">
                {p.installable && (
                  <>
                    <button className="mk-btn primary" disabled={busy === `cc-${p.id}`} onClick={() => installCc(p.market, p.id, 'global')}>导入（全局）</button>
                    <button className="mk-btn" disabled={busy === `cc-${p.id}`} title="仅导入到当前激活的项目工作区" onClick={() => installCc(p.market, p.id, 'project')}>导入（项目）</button>
                  </>
                )}
              </div>
            </div>
          ))}
          {ccFiltered.length > 60 && <div className="mk-hint">共 {ccFiltered.length} 条，仅显示前 60——请用搜索缩小范围。</div>}
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
          {installedItems.length > 0 && <div className="mk-hint">启停请到「插件」管理面板；安装/卸载后点上方「⟳ 重载应用」生效。</div>}
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
