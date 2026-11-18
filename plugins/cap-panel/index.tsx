/**
 * cap-panel 插件：填充 panel 槽的示例业务面板。
 * 展示总线能力清单与审计尾部——证明「面板即插件、经总线看核心」。
 *
 * 验收修复（C-5 P2）：轮询降频至 5s 且仅在页面可见时轮询（describe 已不入审计链）；
 * 审计展示补 pluginId 与错误信息。
 */
import { useEffect, useState } from 'react';
import type { LitePlugin, SlotHostApi } from '@/core/types';

let api: SlotHostApi | null = null;

interface AuditItem {
  time: number;
  target: string;
  action: string;
  ok: boolean;
  pluginId: string;
  error?: string;
}

export function CapPanel() {
  const [caps, setCaps] = useState<string[]>([]);
  const [audit, setAudit] = useState<AuditItem[]>([]);

  useEffect(() => {
    const hostApi = api;
    if (!hostApi) return;
    let alive = true;
    const refresh = async () => {
      const res = await hostApi.dispatch<{ capabilities: string[]; audit: AuditItem[] }>({
        target: 'cap.meta',
        action: 'describe',
      });
      if (alive && res.ok && res.data) {
        setCaps(res.data.capabilities);
        setAudit(res.data.audit);
      }
    };
    void refresh();
    // 仅在页面可见时轮询，且降频至 5s（避免审计/性能被面板自身拖累）
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  return (
    <div className="cap-panel" data-testid="cap-panel">
      <h3>总线能力</h3>
      <div className="cap-list">
        {caps.map((c) => (
          <div key={c} className="cap-item">
            <code>{c}</code>
          </div>
        ))}
      </div>
      <h3 style={{ marginTop: 16 }}>审计尾部</h3>
      <ul className="cap-audit">
        {audit.slice(-8).reverse().map((a, i) => (
          <li key={`${a.time}-${i}`}>
            <span className={`cap-status ${a.ok ? '' : 'fail'}`}>{a.ok ? 'ok' : 'deny'}</span>{' '}
            {a.target} · {a.action}
            {a.pluginId ? ` · ${a.pluginId}` : ''}
            {a.error ? ` · ${a.error}` : ''}
          </li>
        ))}
      </ul>
    </div>
  );
}

export const capPanelPlugin: LitePlugin = {
  manifest: {
    id: 'cap-panel',
    name: '能力面板',
    version: '0.1.0',
    capabilities: ['cap.meta'],
    contributes: { slots: [{ slot: 'panel', component: 'CapPanel', order: 1 }] },
  },
  setup(hostApi) {
    api = hostApi;
  },
};

export default capPanelPlugin;
