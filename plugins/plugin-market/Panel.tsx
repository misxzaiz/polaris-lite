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
  remote?: string | null;
}
interface CcMarket {
  name: string;
  owner: string;
  pluginCount: number;
  installableCount: number;
  plugins: CcPlugin[];
}
interface CcInstalled {
  id: string;
  skills: string[];
  hooksEvents: string[];
  mcpServers: string[];
  scopes: string[];
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

/** 英文判定：无 CJK、含拉丁字母、长度达标（与 translate 插件同口径） */
function isEnglishDesc(text: string): boolean {
  if (!text || text.length < 12) return false;
  if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(text)) return false;
  return /[a-zA-Z]/.test(text);
}

/** 就地翻译一条描述：translate 插件 server 代理，失败静默返回 null */
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

/** 批量预取：一次翻 ≤50 条英文描述（exec_batch），面板挂载时调用；失败静默返回空表 */
async function translateBatch(texts: string[]): Promise<Record<string, string>> {
  const uniq = [...new Set(texts.filter((t) => isEnglishDesc(t)))].slice(0, 50);
  if (!uniq.length) return {};
  try {
    const res = await fetch('/api/translate/translate-batch', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts: uniq, to: 'zh' }),
    });
    const j = (await res.json().catch(() => null)) as { ok?: boolean; results?: (string | null)[] } | null;
    if (!j?.ok || !j.results) return {};
    const map: Record<string, string> = {};
    uniq.forEach((t, i) => { if (j.results?.[i]) map[t] = j.results[i] as string; });
    return map;
  } catch {
    return {};
  }
}

/** 插件描述 + 「译」按钮（译文就地展开；批量预取结果经 props 注入，点按钮才显示） */
function TranslatableDesc({ text, preset }: { text: string; preset?: Record<string, string> }) {
  const [zh, setZh] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ready = zh ?? (preset && preset[text]) ?? null;
  if (!isEnglishDesc(text)) return <div className="mk-desc">{text}</div>;
  const run = async () => {
    if (busy || ready) return;
    setBusy(true);
    const r = preset?.[text] ?? (await translateDesc(text));
    setBusy(false);
    if (r) setZh(r);
  };
  return (
    <div className="mk-desc-wrap">
      <div className="mk-desc">{text}<button className="mk-tr-btn" disabled={busy} onClick={run} title="翻译为中文">{busy ? '…' : ready ? '已译' : '译'}</button></div>
      {ready && <div className="mk-desc zh">{ready}</div>}
    </div>
  );
}

export function MarketPanel() {
  const [tab, setTab] = useState<'store' | 'cc' | 'installed' | 'sources' | 'about'>('store');
  const [items, setItems] = useState<MarketItem[]>([]);
  const [sources, setSources] = useState<MarketSource[]>([]);
  const [ccMarkets, setCcMarkets] = useState<CcMarket[]>([]);
  const [ccInstalled, setCcInstalled] = useState<CcInstalled[]>([]);
  const [ccQuery, setCcQuery] = useState('');
  const [warns, setWarns] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState('');
  const [needsReload, setNeedsReload] = useState(false);
  const [form, setForm] = useState({ name: '', type: 'cc-marketplace', ref: '' });
  const [armRemove, setArmRemove] = useState<string | null>(null);
  const [ccPage, setCcPage] = useState(0);
  const [trMap, setTrMap] = useState<Record<string, string>>({});
  const CC_PAGE_SIZE = 30;

  const refresh = useCallback(async () => {
    try {
      const d = await api<{ items?: MarketItem[]; sources?: MarketSource[]; ccMarkets?: CcMarket[]; ccInstalled?: CcInstalled[]; warns?: string[] }>('/api/market/list');
      setItems(d.items ?? []);
      setSources(d.sources ?? []);
      setCcMarkets(d.ccMarkets ?? []);
      setCcInstalled(d.ccInstalled ?? []);
      setWarns(d.warns ?? []);
      setError('');
      // 批量预取英文描述译文（商城 JS 插件 + CC 插件一次一批；失败静默，不影响面板）
      const descs = [
        ...(d.items ?? []).map((i) => i.description),
        ...(d.ccMarkets ?? []).flatMap((m) => m.plugins.map((p) => p.description)),
      ].filter(Boolean);
      void translateBatch(descs).then(setTrMap);
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
      await api('/api/market/sources', { name: form.name.trim(), type: form.type, ref: form.ref.trim() });
      setForm({ name: '', type: form.type, ref: '' });
      setFlash(form.type === 'cc-marketplace' ? 'CC 商城源已添加，商城 tab 即可浏览/安装' : '源已添加');
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
  const ccInstalledIds = new Set(ccInstalled.map((c) => c.id));
  const ccFiltered = ccQuery.trim()
    ? ccAll.filter((p) => `${p.id} ${p.description}`.toLowerCase().includes(ccQuery.trim().toLowerCase()))
    : ccAll;
  // 搜索词变化时回到第一页
  const ccQueryKey = ccQuery.trim();
  const [lastQueryKey, setLastQueryKey] = useState(ccQueryKey);
  if (ccQueryKey !== lastQueryKey) { setLastQueryKey(ccQueryKey); setCcPage(0); }

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
            <div className="mk-empty">
              商城暂无 JS 插件。想装什么？
              <br />· <b>Claude Code 的技能/钩子/MCP 插件</b> → 切到「CC」页签（开箱即用，本机已有 {ccMarkets.reduce((n, m) => n + m.installableCount, 0)} 个可装）
              <br />· 自制 JS 插件 → 在「源」页签添加本地目录源（内含 index.json 清单与插件包）
            </div>
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
              {i.description && <TranslatableDesc text={i.description} preset={trMap} />}
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
            Claude Code 插件商城。安装 = 导入其<b>声明型资源</b>（skills → 技能面板、hooks → 钩子桥、
            stdio mcpServers → MCP 桥），<b>不运行外部 JS</b>。可在「源」页签添加更多 CC 商城源（填 GitHub 仓库 owner/repo，自动 clone）。
          </div>
          {ccMarkets.length === 0 && <div className="mk-empty">未发现 CC 商城。可在「源」页签添加（类型选 CC 商城，如 anthropics/claude-plugins-official）。</div>}
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
          {ccAll.length > 0 && (
            <input className="mk-input" type="search" placeholder="搜索 CC 插件（id/描述）…" value={ccQuery} onChange={(e) => setCcQuery(e.target.value)} />
          )}
          {(() => {
            const installable = ccFiltered.filter((p) => p.installable || p.remote);
            const shown = installable.slice(ccPage * CC_PAGE_SIZE, (ccPage + 1) * CC_PAGE_SIZE);
            const pages = Math.max(1, Math.ceil(installable.length / CC_PAGE_SIZE));
            return (
              <>
                {shown.map((p) => {
                  const installed = ccInstalledIds.has(p.id);
                  const isRemote = !p.installable && !!p.remote;
                  return (
                    <div key={`${p.market}/${p.id}`} className="mk-item">
                      <div className="mk-item-head">
                        <span className="mk-name">{p.id}</span>
                        <span className="mk-badge">{p.market}</span>
                        {installed && <span className="mk-badge ok">已导入</span>}
                        {isRemote && <span className="mk-badge" title="安装时自动从 GitHub clone 到本机">远程自动拉取</span>}
                      </div>
                      {p.description && <TranslatableDesc text={p.description} preset={trMap} />}
                      <div className="mk-actions">
                        <button className="mk-btn primary" disabled={busy === `cc-${p.id}`} title={isRemote ? '将自动 clone 该插件仓库后导入' : ''} onClick={() => installCc(p.market, p.id, 'global')}>{installed ? '重新导入（全局）' : '导入（全局）'}</button>
                        <button className="mk-btn" disabled={busy === `cc-${p.id}`} title={isRemote ? '将自动 clone 该插件仓库后导入' : '仅导入到当前激活的项目工作区'} onClick={() => installCc(p.market, p.id, 'project')}>导入（项目）</button>
                      </div>
                    </div>
                  );
                })}
                {installable.length === 0 && (
                  <div className="mk-empty">没有匹配的插件{ccQuery.trim() ? `（搜索词：${ccQuery.trim()}）` : ''}。</div>
                )}
                {pages > 1 && (
                  <div className="mk-form-actions" style={{ justifyContent: 'center', paddingTop: 6 }}>
                    <button className="mk-btn" disabled={ccPage === 0} onClick={() => setCcPage(0)}>« 首页</button>
                    <button className="mk-btn" disabled={ccPage === 0} onClick={() => setCcPage(ccPage - 1)}>‹ 上一页</button>
                    <span style={{ fontSize: 11, opacity: 0.7, alignSelf: 'center' }}>第 {ccPage + 1} / {pages} 页（共 {installable.length} 个）</span>
                    <button className="mk-btn" disabled={ccPage >= pages - 1} onClick={() => setCcPage(ccPage + 1)}>下一页 ›</button>
                    <button className="mk-btn" disabled={ccPage >= pages - 1} onClick={() => setCcPage(pages - 1)}>末页 »</button>
                  </div>
                )}
              </>
            );
          })()}
        </div>
      )}

      {tab === 'installed' && (
        <div>
          {ccInstalled.length > 0 && (
            <>
              <div className="mk-hint">CC 商城导入的声明型资源（技能/钩子/MCP 名称不翻译，原文即 id）：</div>
              {ccInstalled.map((c) => (
                <div key={c.id} className="mk-item">
                  <div className="mk-item-head">
                    <span className="mk-name">{c.id}</span>
                    {(c.scopes ?? []).map((s) => <span key={s} className="mk-badge ok">{s === 'project' ? '项目级' : '全局'}</span>)}
                  </div>
                  <div className="mk-desc">
                    {(c.skills ?? []).length > 0 && <div>技能：{c.skills.join('、')}</div>}
                    {(c.mcpServers ?? []).length > 0 && <div>MCP：{c.mcpServers.join('、')}</div>}
                    {(c.hooksEvents ?? []).length > 0 && <div>钩子事件已并入（见「钩子」面板）</div>}
                  </div>
                </div>
              ))}
            </>
          )}
          {installedItems.length > 0 && installedItems.map((i) => (
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
          {ccInstalled.length === 0 && installedItems.length === 0 && <div className="mk-empty">尚未安装任何外部插件或导入任何 CC 资源。</div>}
          {installedItems.length > 0 && <div className="mk-hint">JS 插件启停请到「插件」管理面板；安装/卸载后点上方「⟳ 重载应用」生效。CC 导入的技能可在「技能」面板查看，钩子/MCP 分别在「钩子」「MCP」面板。</div>}
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
            <div className="mk-form-row">
              <label style={{ fontSize: 11, opacity: 0.7 }}>类型</label>
              <select className="mk-input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                <option value="cc-marketplace">CC 商城（GitHub 仓库，推荐）</option>
                <option value="dir">本地目录（自制 JS 插件清单）</option>
                <option value="http">HTTP 清单（远程 index.json URL）</option>
              </select>
            </div>
            <input className="mk-input" placeholder="源名（如 my-plugins）" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <input
              className="mk-input"
              placeholder={form.type === 'cc-marketplace' ? 'GitHub 仓库 owner/repo（如 anthropics/claude-plugins-official）' : form.type === 'http' ? '清单 index.json 的 http(s) URL（插件包按 <id>/ 相对同目录）' : '本地目录绝对路径（含 index.json）'}
              value={form.ref}
              onChange={(e) => setForm({ ...form, ref: e.target.value })}
            />
            {form.type === 'http' && (
              <div className="mk-hint">http 源：清单为 JSON（plugins 数组，每项含 id/sha256），plugin.js/plugin.json 按 &lt;id&gt;/ 子路径寻址；安装时强校验 sha256。外部 JS 与宿主同进程，只装可信来源。</div>
            )}
            {form.type === 'cc-marketplace' && (
              <div className="mk-hint">添加后自动 clone 商城仓库（本机 ~/.claude 已有则直接复用）；其技能/钩子/MCP 型插件即可在「CC」页签导入。</div>
            )}
            <div className="mk-form-actions">
              <button className="mk-btn primary" disabled={busy === 'add-source' || !form.name.trim() || !form.ref.trim()} onClick={addSource}>添加源</button>
            </div>
          </div>
          {warns.length > 0 && <div className="mk-warns">{warns.map((w, i) => <div key={i}>[!] {w}</div>)}</div>}
        </div>
      )}

      {tab === 'about' && (
        <div className="mk-about">
          <p><b>两类商城源</b>：</p>
          <p>① <b>CC 商城</b>（推荐）：Claude Code 插件仓库。安装 = 导入其<b>声明型资源</b>——skills → 技能面板、hooks → 钩子桥、stdio mcpServers → MCP 桥，<b>不运行外部 JS</b>，安全面最小。支持全局/项目两种作用域。源地址填 GitHub 仓库（owner/repo），自动 clone（本机 ~/.claude 已有的直接复用）。</p>
          <p>② <b>本地目录源</b>：自制 JS 插件清单（index.json + plugin.json/plugin.js）。安装会<b>运行外部代码</b>——bundle 与宿主同进程，经 sha256 校验 + id 冲突拒绝 + 路径逃逸拒绝，只装可信来源。</p>
          <p><b>生效时机</b>：CC 声明型导入——skills 即刻生效，hooks/mcpServers 下轮会话生效；JS 插件——刷新页面生效（server 半边需重启）。</p>
          <p className="mk-warn">[!] 只添加可信来源。来源不明的仓库/目录可能包含恶意指令或代码。</p>
        </div>
      )}
    </div>
  );
}
