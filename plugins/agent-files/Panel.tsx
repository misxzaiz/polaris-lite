/** agent-files 面板：写工具说明 + 服务端审计查看（经只读 bash 读日志） */
import { useCallback, useEffect, useState } from 'react';

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

const ACTION_LABEL: Record<string, string> = {
  write: '写入',
  edit: '编辑',
  patch: '补丁',
};

export function AgentFilesPanel() {
  const [lines, setLines] = useState<AuditLine[] | null>(null);
  const [err, setErr] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const resp = await fetch('/api/tool/exec', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: "powershell -NoProfile -Command \"if (Test-Path '.polaris-lite/files-write-audit.log') { Get-Content '.polaris-lite/files-write-audit.log' -Tail 30 }\"",
          approved: true,
          timeoutMs: 15000,
        }),
      });
      const json = (await resp.json().catch(() => null)) as { stdout?: string; error?: string } | null;
      if (resp.ok && json) {
        const text = String(json.stdout ?? '');
        setLines(
          text
            .split('\n')
            .filter((l) => l.trim().startsWith('{'))
            .map((l) => {
              try { return JSON.parse(l) as AuditLine; } catch { return { at: 0, error: l } as AuditLine; }
            })
            .reverse(),
        );
        setErr('');
      } else {
        setErr(json?.error ?? '读取审计失败');
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const okCount = (lines ?? []).filter((l) => l.ok).length;

  return (
    <div className="cap-panel agent-files" data-testid="agent-files">
      <h3>文件编辑工具</h3>
      <p className="af-hint">
        AI 的 <code>files_write</code> 工具提供三个动作：<b>write</b> 写整文件、<b>edit</b> 精确替换
        （old_string 唯一匹配）、<b>patch</b> 多文件补丁。每次调用都经服务端边界校验并全量审计。
      </p>
      <div className="af-rules">
        <div className="af-rule"><span className="af-k">路径边界</span><span>仅内建 workspace 与已登记工作区根内；realpath 防逃逸</span></div>
        <div className="af-rule"><span className="af-k">二进制</span><span>图片/可执行/数据库等扩展名拒写</span></div>
        <div className="af-rule"><span className="af-k">防盲覆盖</span><span>编辑前校验读取后 mtime，被外部改动过则拒绝</span></div>
        <div className="af-rule"><span className="af-k">上限</span><span>单文件 2MB；审批走对话内确认卡（可「本会话信任」）</span></div>
      </div>
      <div className="af-audit-head">
        <span className="af-audit-title">
          最近审计{lines ? `（${okCount} 成功 / ${(lines ?? []).length - okCount} 失败）` : ''}
        </span>
        <button type="button" className="af-btn" onClick={() => { setExpanded(true); void refresh(); }} disabled={loaded && lines === null}>
          刷新
        </button>
      </div>
      {err && <p className="af-hint af-warn">{err}</p>}
      {expanded && (
        <div className="af-audit">
          {(lines ?? []).length === 0 && <div className="af-hint">暂无记录（AI 尚未调用写工具）</div>}
          {(lines ?? []).map((l, i) => (
            <div key={i} className={`af-line ${l.ok ? 'ok' : 'fail'}`}>
              <span className="af-time">{l.at ? new Date(l.at).toLocaleTimeString() : '--'}</span>
              <span className="af-act">{ACTION_LABEL[l.action ?? ''] ?? l.action ?? '?'}</span>
              <span className="af-path" title={l.path}>{l.path ?? ''}</span>
              <span className="af-st">{l.ok ? 'ok' : `FAIL ${l.code ?? ''}`}</span>
            </div>
          ))}
        </div>
      )}
      <p className="af-hint af-foot">
        整体禁用：<code>PLITE_FILES_WRITE=0</code>。审批模式跟随 Bash 工具的全局配置（confirm/allowlist/yolo）。
      </p>
    </div>
  );
}
