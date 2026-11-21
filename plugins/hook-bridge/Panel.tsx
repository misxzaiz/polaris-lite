/**
 * HookPanel —— 生命周期钩子台（panel 槽）。
 *
 * 功能：
 *  - 规则列表：事件 / matcher / 来源 / handler 类型 / 命令摘要 / 超时（GET /api/hooks/list）；
 *  - warns 区：不支持事件、解析失败等一次性警告（用户能看懂"为什么我的 PreCompact 没生效"）；
 *  - 「从 Claude/ZCode 导入」按钮：GET /api/compat/scan 预览 → POST /api/compat/import 执行
 *    （zcode-compat 端点；插件未装/禁用时按钮隐藏）；
 *  - 空态教学：去哪写 hooks。
 * 只读为主：钩子是"文件即代码"，编辑引导用户改 settings/config 或走导入，不做在线编辑。
 */
import { useCallback, useEffect, useState } from 'react';

interface HookRule {
  event: string;
  matcher?: string;
  scope: string;
  source: string;
  type: string;
  command: string;
  timeoutMs: number;
}

const EVENT_LABEL: Record<string, string> = {
  SessionStart: '会话开始',
  UserPromptSubmit: '用户输入',
  PreToolUse: '工具执行前',
  PermissionRequest: '权限请求',
  PostToolUse: '工具执行后',
  PostToolUseFailure: '工具失败',
  Stop: '回合结束',
};

export function HookPanel() {
  const [rules, setRules] = useState<HookRule[]>([]);
  const [warns, setWarns] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [scanResult, setScanResult] = useState<string | null>(null);
  const [importLog, setImportLog] = useState<string[] | null>(null);
  const [hasCompat, setHasCompat] = useState<boolean | null>(null);
  const [trustPending, setTrustPending] = useState(false);
  const [globalPath, setGlobalPath] = useState('');

  const refresh = useCallback(async () => {
    try {
      const resp = await fetch('/api/hooks/list', { credentials: 'include' });
      const j = (await resp.json().catch(() => null)) as { rules?: HookRule[]; warns?: string[]; trust?: { trusted?: boolean; pending?: boolean }; globalHooksPath?: string } | null;
      setRules(j?.rules ?? []);
      setWarns(j?.warns ?? []);
      setTrustPending(Boolean(j?.trust?.pending));
      setGlobalPath(j?.globalHooksPath ?? '');
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    // 探测 zcode-compat 是否可用（决定导入按钮是否显示）
    fetch('/api/compat/scan', { credentials: 'include' })
      .then((r) => setHasCompat(r.ok))
      .catch(() => setHasCompat(false));
  }, [refresh]);

  const doImport = async () => {
    setBusy(true);
    try {
      const scan = await fetch('/api/compat/scan', { credentials: 'include' }).then((r) => r.json());
      const lines: string[] = [];
      lines.push(`MCP servers: ${scan.mcp?.length ?? 0}，skills: ${scan.skills?.length ?? 0}，hooks 事件: ${scan.hooksEvents?.join(', ') || '无'}，插件: ${scan.plugins?.length ?? 0}`);
      if (Array.isArray(scan.warns) && scan.warns.length) lines.push(`注意：${scan.warns.slice(0, 5).join('；')}`);
      setScanResult(lines.join('\n'));
      const imp = await fetch('/api/compat/import', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }).then((r) => r.json());
      setImportLog(imp.log ?? []);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const confirmTrust = async () => {
    setBusy(true);
    try {
      await fetch('/api/hooks/confirm', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="hk-panel">
      <div className="hk-toolbar">
        <span className="hk-count">{rules.length} 条规则</span>
        {hasCompat && (
          <button className="hk-btn" disabled={busy} onClick={doImport} title="扫描并固化导入 Claude/ZCode 的 MCP/skills/hooks 配置">从 CC/ZC 导入</button>
        )}
      </div>
      {trustPending && (
        <div className="hk-trust">
          <div>工作区级钩子有未确认的变更：当前已跳过执行（防 AI 绕过审批自行放行）。请核对下方 workspace 规则后确认。</div>
          <button className="hk-btn danger" disabled={busy} onClick={confirmTrust}>确认启用当前规则集</button>
        </div>
      )}
      {error && <div className="hk-error">{error}</div>}
      {scanResult && <div className="hk-scan">扫描预览：{scanResult}</div>}
      {importLog && <div className="hk-import">{importLog.map((l, i) => <div key={i}>· {l}</div>)}</div>}
      {warns.length > 0 && (
        <div className="hk-warns">
          {warns.map((w, i) => <div key={i}>[!] {w}</div>)}
        </div>
      )}
      {rules.length === 0 && (
        <div className="hk-empty">
          尚未配置任何钩子。可在 <code>.claude/settings.json</code> / <code>.zcode/config.json</code> 的
          <code>hooks</code> 键下定义，或点上方「从 CC/ZC 导入」。
          支持事件：SessionStart / UserPromptSubmit / PreToolUse / PermissionRequest / PostToolUse / PostToolUseFailure / Stop。
        </div>
      )}
      {globalPath && (
        <div className="hk-globalpath">
          全局钩子（所有工作区通用）：<code>{globalPath}</code>
          ——写入该文件即可对全部会话生效；工作区级钩子跟随各会话绑定的工作区目录。
        </div>
      )}
      {rules.map((r, i) => (
        <div key={i} className="hk-rule">
          <div className="hk-rule-head">
            <span className="hk-event">{EVENT_LABEL[r.event] ?? r.event}</span>
            <span className="hk-badge">{r.scope === 'user' ? '用户级' : '工作区'}</span>
            <span className="hk-badge">{r.type}</span>
            <span className="hk-timeout">{Math.round(r.timeoutMs / 1000)}s</span>
          </div>
          {r.matcher && <div className="hk-matcher">matcher: <code>{r.matcher}</code></div>}
          <div className="hk-cmd">{r.command}</div>
          <div className="hk-src">{r.source}</div>
        </div>
      ))}
      <div className="hk-hint">
        退出码 2 = 阻断（PreToolUse 拒工具 / UserPromptSubmit 拒本轮）；stdout 可返回
        <code>hookSpecificOutput.permissionDecision</code> 与 <code>additionalContext</code>。
        每次执行均记录 <code>hooks-audit.log</code>。
      </div>
    </div>
  );
}
