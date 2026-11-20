/**
 * McpPanel —— MCP 管理台（panel 槽）。
 *
 * 页签：
 *  - 服务器：server 列表（状态徽标/来源/工具数）+ 工具明细（mcp__server__tool 全名 + 门控开关）
 *    + 增删改表单（删除两段式确认，学 model-admin）；
 *  - 说明：MCP 是什么、安全提示（新增 server = 允许 AI 调用外部进程）、CLI 引擎透传说明。
 *
 * 数据面：cap.mcp.admin（list/add/remove/gate）——本插件自注册，面板只走 cap 总线。
 */
import { useCallback, useEffect, useState } from 'react';
import type { SlotHostApi } from '@sdk';

let api: SlotHostApi | null = null;
export function setMcpPanelApi(a: SlotHostApi | null): void { api = a; }

interface McpTool {
  name: string;
  server: string;
  tool: string;
  description: string;
  gated: boolean;
}
interface McpServer {
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
  status: string;
  tools: McpTool[];
  toolError?: string;
  source: string;
}

async function admin<T>(action: string, payload?: Record<string, unknown>): Promise<T> {
  if (!api) throw new Error('面板未就绪');
  const r = await api.dispatch<T>({ target: 'cap.mcp.admin', action, payload: payload ?? {} });
  if (!r.ok) {
    // bus 失败返回 {ok:false, error:{code,message}}（error 是对象）——取 message 而非整个对象，
    // 否则 new Error(对象) 的 message 变成 '[object Object]'。
    const err = (r as { error?: { message?: string } | string }).error;
    const msg = typeof err === 'string' ? err : (err?.message ?? 'cap 调用失败');
    throw new Error(msg);
  }
  return r.data as T;
}

export function McpPanel() {
  const [tab, setTab] = useState<'servers' | 'about'>('servers');
  const [servers, setServers] = useState<McpServer[]>([]);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [armDelete, setArmDelete] = useState<string | null>(null);
  const [form, setForm] = useState<{ name: string; command: string; args: string }>({ name: '', command: '', args: '' });
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const d = await admin<{ servers?: McpServer[] }>('list');
      setServers(d.servers ?? []);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const addServer = async () => {
    if (!form.name.trim() || !form.command.trim()) return;
    setBusy(true);
    try {
      const args = form.args.split('\n').map((s) => s.trim()).filter(Boolean);
      await admin('add', { name: form.name.trim(), command: form.command.trim(), args, enabled: true });
      setForm({ name: '', command: '', args: '' });
      setShowForm(false);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const removeServer = async (name: string) => {
    setBusy(true);
    try {
      await admin('remove', { name });
      setArmDelete(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleGate = async (tool: string, currentGated: boolean) => {
    setBusy(true);
    try {
      await admin('gate', { tool, enabled: currentGated }); // 当前被关→enabled=true 放开
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mcp-panel">
      <div className="mcp-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'servers'} className={tab === 'servers' ? 'mcp-tab active' : 'mcp-tab'} onClick={() => setTab('servers')}>服务器</button>
        <button role="tab" aria-selected={tab === 'about'} className={tab === 'about' ? 'mcp-tab active' : 'mcp-tab'} onClick={() => setTab('about')}>说明</button>
      </div>

      {error && <div className="mcp-error">{error}</div>}

      {tab === 'servers' && (
        <div className="mcp-servers">
          {servers.length === 0 && !showForm && (
            <div className="mcp-empty">
              尚未配置任何 MCP server。可在下方新增，或用 zcode-compat 面板从 Claude/ZCode 配置导入。
            </div>
          )}
          {servers.map((s) => (
            <div key={s.name} className="mcp-server">
              <div className="mcp-server-head" onClick={() => setExpanded(expanded === s.name ? null : s.name)}>
                <span className={`mcp-dot ${s.status}`}>{s.status === 'connected' ? '[ok]' : s.status === 'error' ? '[err]' : '[--]'}</span>
                <span className="mcp-server-name">{s.name}</span>
                <span className="mcp-badge">{s.source}</span>
                <span className="mcp-count">{s.tools.length} 工具</span>
              </div>
              <div className="mcp-server-cmd">{s.command} {s.args.join(' ')}</div>
              {s.toolError && <div className="mcp-server-err">{s.toolError}</div>}
              {expanded === s.name && (
                <div className="mcp-tools">
                  {s.tools.length === 0 && <div className="mcp-tool-none">（无工具或未连接）</div>}
                  {s.tools.map((t) => (
                    <div key={t.name} className="mcp-tool">
                      <code className="mcp-tool-name">{t.name}</code>
                      <span className="mcp-tool-desc">{t.description}</span>
                      <button
                        className={t.gated ? 'mcp-gate off' : 'mcp-gate'}
                        disabled={busy}
                        onClick={() => toggleGate(t.name, t.gated)}
                        title={t.gated ? '已关闭，点击启用' : '已启用，点击关闭'}
                      >
                        {t.gated ? '已关' : '启用'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="mcp-server-actions">
                {armDelete === s.name ? (
                  <>
                    <span className="mcp-arm-text">确认删除？</span>
                    <button className="mcp-btn danger" disabled={busy} onClick={() => removeServer(s.name)}>确认</button>
                    <button className="mcp-btn" onClick={() => setArmDelete(null)}>取消</button>
                  </>
                ) : (
                  <button className="mcp-btn danger-soft" onClick={() => setArmDelete(s.name)}>删除</button>
                )}
              </div>
            </div>
          ))}
          {showForm ? (
            <div className="mcp-form">
              <input className="mcp-input" placeholder="名称（字母数字_-）" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <input className="mcp-input" placeholder="command（如 node）" value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} />
              <textarea className="mcp-input" placeholder="args 每行一个（路径可用 ${WORKSPACE}）" value={form.args} onChange={(e) => setForm({ ...form, args: e.target.value })} rows={3} />
              <div className="mcp-form-actions">
                <button className="mcp-btn primary" disabled={busy || !form.name.trim() || !form.command.trim()} onClick={addServer}>保存</button>
                <button className="mcp-btn" onClick={() => setShowForm(false)}>取消</button>
              </div>
            </div>
          ) : (
            <button className="mcp-btn primary wide" onClick={() => setShowForm(true)}>+ 新增 server</button>
          )}
        </div>
      )}

      {tab === 'about' && (
        <div className="mcp-about">
          <p><b>MCP（Model Context Protocol）</b>：把外部工具服务器接入 AI 会话的标准协议。这里配置的每个 server 的工具会以 <code>mcp__服务器名__工具名</code> 出现在 AI 的工具列表中。</p>
          <p className="mcp-warn">[!] 新增 server = 允许 AI 调用其进程。只添加可信来源；来自仓库的 .mcp.json 首次导入时务必核对命令内容。</p>
          <p>stdio server 由宿主按需拉起（15s 启动超时，崩溃自动回收）；http/sse 传输暂不支持。启用的 server 会同步透传给 CodeBuddy CLI 引擎。</p>
          <p>配置落盘：<code>&lt;dataDir&gt;/mcp-servers.json</code>；门控与调用均记录审计日志。</p>
        </div>
      )}
    </div>
  );
}
