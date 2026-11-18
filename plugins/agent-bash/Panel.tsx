/** agent-bash 面板：审批模式与白名单管理（数据源 = 服务端 /api/tool/config） */
import { useEffect, useState } from 'react';
import type { SlotHostApi } from '@sdk';

let api: SlotHostApi | null = null;
export function setPanelApi(a: SlotHostApi | null): void { api = a; }

interface ToolConfig {
  enabled: boolean;
  mode: 'confirm' | 'allowlist' | 'yolo';
  allowPrefixes: string[];
  hardOff?: boolean;
}

const MODE_HINT: Record<ToolConfig['mode'], string> = {
  confirm: '每条命令先在对话里出审批卡（允许一次 / 总是允许该前缀 / 拒绝）',
  allowlist: '白名单前缀自动放行，其余进审批',
  yolo: '全自动执行（危险命令仍会被硬拦截）',
};

export function AgentBashPanel() {
  const [cfg, setCfg] = useState<ToolConfig | null>(null);
  const [prefix, setPrefix] = useState('');
  const [err, setErr] = useState('');

  const refresh = async () => {
    if (!api) return;
    const res = await api.dispatch<{ config: ToolConfig | null }>({ target: 'cap.tool.bash', action: 'getConfig' });
    setCfg(res.data?.config ?? null);
  };

  useEffect(() => { void refresh(); }, []);

  const setMode = async (mode: ToolConfig['mode']) => {
    const res = await api?.dispatch({ target: 'cap.tool.bash', action: 'setMode', payload: { command: mode } });
    if (res?.ok) await refresh();
    else setErr('切换失败（服务端配置不可写？）');
  };

  const addPrefix = async () => {
    const p = prefix.trim();
    if (!p) return;
    const res = await api?.dispatch({ target: 'cap.tool.bash', action: 'addPrefix', payload: { command: p } });
    if (res?.ok) { setPrefix(''); await refresh(); }
  };

  const removePrefix = async (p: string) => {
    const res = await api?.dispatch({ target: 'cap.tool.bash', action: 'removePrefix', payload: { command: p } });
    if (res?.ok) await refresh();
  };

  if (!cfg) {
    return (
      <div className="cap-panel agent-bash" data-testid="agent-bash">
        <h3>Bash 工具</h3>
        <p className="ab-hint">{err || '配置加载中…（服务端 /api/tool/config 不可达时工具不可用）'}</p>
      </div>
    );
  }

  return (
    <div className="cap-panel agent-bash" data-testid="agent-bash">
      <h3>Bash 工具</h3>
      {cfg.hardOff && <p className="ab-hint ab-warn">已被环境变量 PLITE_TOOL_EXEC=0 整体禁用（公网部署形态）。</p>}
      <p className="ab-hint">AI 可用 bash 读写文件、跑脚本、装依赖——衍生一切一次性能力。审批模式由服务端强制裁决。</p>
      <div className="ab-modes">
        {(['confirm', 'allowlist', 'yolo'] as const).map((m) => (
          <label key={m} className={`ab-mode ${cfg.mode === m ? 'active' : ''}`}>
            <input type="radio" checked={cfg.mode === m} onChange={() => void setMode(m)} />
            <span className="ab-mode-name">{m}</span>
            <span className="ab-mode-hint">{MODE_HINT[m]}</span>
          </label>
        ))}
      </div>
      {cfg.mode !== 'yolo' && (
        <>
          <label className="ab-label">前缀白名单（allowlist 模式自动放行；confirm 模式「总是允许」也会追加到这里）</label>
          <div className="ab-addrow">
            <input value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="如: node, git status, ls" />
            <button className="ab-btn" onClick={() => void addPrefix()} disabled={!prefix.trim()}>添加</button>
          </div>
          {cfg.allowPrefixes.length > 0 && (
            <div className="ab-prefixes">
              {cfg.allowPrefixes.map((p) => (
                <span key={p} className="ab-prefix">
                  <code>{p}</code>
                  <button className="ab-x" title="移除" onClick={() => void removePrefix(p)}>×</button>
                </span>
              ))}
            </div>
          )}
        </>
      )}
      <p className="ab-hint ab-foot">危险命令（rm -rf、curl|sh、改配置存储等）无条件拒绝，任何模式都不可豁免。</p>
    </div>
  );
}
