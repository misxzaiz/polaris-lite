/** agent-files 面板：写工具状态一览（数据源 = 服务端审计尾行，经只读 bash 读日志） */
import { useEffect, useState } from 'react';

interface AuditLine {
  at: number;
  user?: string;
  sessionId?: string;
  action?: string;
  path?: string;
  ok?: boolean;
  code?: string;
  error?: string;
}

export function AgentFilesPanel() {
  const [lines, setLines] = useState<AuditLine[]>([]);
  const [err, setErr] = useState('');
  const [expanded, setExpanded] = useState(false);

  useEffect(() => { void refresh(); }, []);

  const refresh = async () => {
    // 审计在服务端落盘；面板经只读 bash 读日志尾几行（免新增端点）
    try {
      const resp = await fetch('/api/tool/exec', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'powershell -NoProfile -Command "Get-Content \'.polaris-lite/files-write-audit.log\' -Tail 12"', approved: true }),
      });
      const json = (await resp.json().catch(() => null)) as { stdout?: string; error?: string } | null;
      if (resp.ok && json) {
        const text = String(json.stdout ?? '');
        setLines(text.split('\n').filter(Boolean).map((l) => {
          try { return JSON.parse(l) as AuditLine; } catch { return { at: 0, error: l }; }
        }));
        setErr('');
      } else {
        setErr(json?.error ?? '读取审计失败');
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="p-3 space-y-2 text-xs">
      <div className="flex items-center justify-between">
        <span className="font-medium text-text-secondary">文件编辑工具（files_write）</span>
        <button type="button" onClick={() => void refresh()} className="text-primary hover:text-primary/80">刷新</button>
      </div>
      <p className="text-text-muted leading-relaxed">
        AI 的 write / edit / patch 调用经服务端边界校验后全量审计。
        路径锁定在内建 workspace 与已登记工作区根内；二进制文件拒写；
        读取后已被外部修改的文件会被拒绝编辑（防盲覆盖）。
        可用 <code className="font-mono">PLITE_FILES_WRITE=0</code> 整体禁用。
      </p>
      {err && <p className="text-danger">{err}</p>}
      <div>
        <button type="button" onClick={() => setExpanded((v) => !v)} className="text-text-secondary hover:text-text-primary">
          {expanded ? '收起' : '展开'}最近审计（{lines.length}）
        </button>
        {expanded && (
          <div className="mt-1 space-y-0.5 max-h-56 overflow-auto rounded border border-border-subtle bg-background-elevated p-1.5 font-mono text-[10px]">
            {lines.length === 0 && <div className="text-text-muted">暂无记录</div>}
            {lines.map((l, i) => (
              <div key={i} className={l.ok ? 'text-text-secondary' : 'text-danger'}>
                {new Date(l.at).toLocaleTimeString()} {l.action} {l.path ?? ''} {l.ok ? 'ok' : `FAIL ${l.code ?? ''}`}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
