/**
 * standalone-mode 插件：独立档 B 的模式判定与广播（docs/mobile-app-plan.md §10）。
 *
 * 手机独立使用的运行模式开关（纯插件实现，宿主零改动）：
 * - 探测宿主可达性（/api/phone/hello 与 /api/auth/status 双探针）：
 *   reachable=true → connected（连接档，一切照旧）；false → standalone（独立档）；
 * - 独立档语义（v1）：顶栏出「独立模式（未连接电脑）」提示条；chat/工具全部走既有
 *   网络调用——宿主不可达时它们自己会报错（AI 调用会失败，UI 如实提示）。
 *   本地会话/本地直连引擎（B 档完整数据面）属后续演进，本插件先立模式契约骨架：
 *   cap.mode { status } + mode-changed 事件，让其他插件（chat-lite/real-engine）
 *   将来按此切换数据源，不需要再动宿主。
 * - 探测策略：启动 + visibilitychange 回前台各探一次；间隔 30s 轮询；
 *   不可达判定保守（连续 2 次失败才切 standalone，防 Wi-Fi 抖动误切）。
 */
import { useEffect, useState } from 'react';
import { CHANNEL_REAL_ENGINE_DIRECT, type CapabilityHandler, type LitePlugin, type SlotHostApi } from '@sdk';

type ModeStatus = 'connected' | 'standalone' | 'unknown';

let currentMode: ModeStatus = 'unknown';
const modeListeners = new Set<(m: ModeStatus) => void>();

function notifyMode(): void {
  for (const l of modeListeners) l(currentMode);
}

async function probeHost(): Promise<boolean> {
  try {
    const res = await fetch('/api/phone/hello', { cache: 'no-store' });
    return res.ok;
  } catch {
    // phone-agent 不可用（未启用/旧宿主）→ 退回 auth status 探针
    try {
      const res = await fetch('/api/auth/status', { cache: 'no-store' });
      return res.ok;
    } catch {
      return false;
    }
  }
}

function startProbe(api: SlotHostApi): void {
  let failStreak = 0;
  const probe = async () => {
    const ok = await probeHost();
    if (ok) {
      failStreak = 0;
      if (currentMode !== 'connected') {
        currentMode = 'connected';
        api.emit('mode-changed', { status: currentMode });
        notifyMode();
      }
    } else {
      failStreak += 1;
      if (failStreak >= 2 && currentMode !== 'standalone') {
        currentMode = 'standalone';
        api.emit('mode-changed', { status: currentMode });
        notifyMode();
      }
    }
  };
  void probe();
  window.setInterval(probe, 30_000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void probe();
  });
}

function createModeHandler(): CapabilityHandler {
  return (req) => {
    switch (req.action) {
      case 'status':
        return { status: currentMode };
      default:
        return { ok: false, error: `unknown action: ${req.action}` };
    }
  };
}

/** 顶栏提示条（standalone 时挂 body，纯 DOM；恢复连接自动消失） */
export function ModeBanner() {
  const [mode, setMode] = useState<ModeStatus>(currentMode);
  useEffect(() => {
    const l = (m: ModeStatus) => setMode(m);
    modeListeners.add(l);
    return () => { modeListeners.delete(l); };
  }, []);

  useEffect(() => {
    let el = document.getElementById('sm-mode-layer');
    if (mode !== 'standalone') {
      el?.remove();
      return;
    }
    if (!el) {
      el = document.createElement('div');
      el.id = 'sm-mode-layer';
      document.body.appendChild(el);
    }
    el.textContent = '';
    const banner = document.createElement('div');
    banner.className = 'sm-banner';
    banner.setAttribute('data-testid', 'sm-banner');
    banner.textContent = '独立模式 · 未连接电脑（聊天与工具需要电脑在线，AI 调用暂不可用）';
    el.append(banner);
    return () => { el?.remove(); };
  }, [mode]);

  return null;
}

/** 独立档直连配置操作（real-engine 暴露的受限桥；面板按钮触发） */
interface DirectBridge {
  save: () => Promise<{ ok: boolean; message: string }>;
  clear: () => void;
  has: () => boolean;
}
function directBridge(): DirectBridge | null {
  if (typeof window === 'undefined') return null;
  const b = (window as unknown as Record<string, unknown>)[CHANNEL_REAL_ENGINE_DIRECT];
  return typeof b === 'object' && b !== null ? (b as DirectBridge) : null;
}

/** panel 槽主面板：当前模式 + 说明 + 独立档直连配置管理 */
export function StandaloneModePanel() {
  const [mode, setMode] = useState<ModeStatus>(currentMode);
  const [hasDirect, setHasDirect] = useState(false);
  const [directMsg, setDirectMsg] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const l = (m: ModeStatus) => setMode(m);
    modeListeners.add(l);
    setHasDirect(directBridge()?.has() ?? false);
    return () => { modeListeners.delete(l); };
  }, []);
  const label = mode === 'connected' ? '已连接电脑' : mode === 'standalone' ? '独立模式（未连接电脑）' : '探测中…';

  const saveDirect = async () => {
    const b = directBridge();
    if (!b || busy) return;
    setBusy(true);
    setDirectMsg('');
    const r = await b.save();
    setHasDirect(b.has());
    setDirectMsg(r.message);
    setBusy(false);
  };
  const clearDirect = () => {
    const b = directBridge();
    if (!b) return;
    b.clear();
    setHasDirect(false);
    setDirectMsg('已清除本机直连配置');
  };

  return (
    <div className="sm-panel" data-testid="sm-panel">
      <h3>运行模式</h3>
      <div className="sm-status" data-mode={mode}>{label}</div>
      <div className="sm-hint">
        连接档：完整功能（AI、工具、多设备会话同步）。独立档：手机独立打开应用，
        宿主侧能力（bash/文件/浏览器工具）不可用，恢复连接后自动回到连接档。
      </div>
      <div className="sm-direct" data-testid="sm-direct">
        <div className="sm-direct-title">独立模式直连配置</div>
        <div className="sm-hint">
          连接电脑时点「保存到本机」，把当前供应商的直连凭据存到本机——之后没有电脑也能直接与该供应商对话。
          部分供应商不允许浏览器直连（CORS），离线时会明确提示。清除后独立模式不可用。
        </div>
        <div className="sm-direct-row">
          <span className={hasDirect ? 'sm-ok' : 'sm-none'} data-testid="sm-direct-state">
            {hasDirect ? '本机已保存直连配置' : '本机未保存'}
          </span>
          <button className="sm-btn" onClick={saveDirect} disabled={busy}>{busy ? '保存中…' : '保存到本机'}</button>
          {hasDirect && <button className="sm-btn sm-danger" onClick={clearDirect}>清除</button>}
        </div>
        {directMsg && <div className="sm-hint" data-testid="sm-direct-msg">{directMsg}</div>}
      </div>
    </div>
  );
}

export const standaloneModePlugin: LitePlugin = {
  manifest: {
    id: 'standalone-mode',
    name: '运行模式',
    version: '0.1.0',
    capabilities: ['cap.meta'],
    provides: ['cap.mode'],
    events: ['mode-changed'],
    contributes: {
      slots: [{ slot: 'panel', component: 'StandaloneModePanel', order: 14, title: '模式' }],
    },
  },
  setup(api: SlotHostApi) {
    api.registerCapability.register('cap.mode', createModeHandler());
    startProbe(api);
  },
};

export default standaloneModePlugin;
