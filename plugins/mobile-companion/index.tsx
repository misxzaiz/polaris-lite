/**
 * mobile-companion 插件：手机 App 化伴侣（docs/mobile-app-plan.md P0+P1）。
 *
 * 职责（全部是「手机作为客户端」的辅助，不含 AI 调用手机——那是 phone-agent）：
 * 1. Service Worker 注册（缓存壳，离线时打开 App 不是恐龙页）；
 * 2. 安装引导：Android 捕获 beforeinstallprompt 出「安装」气泡；iOS 无事件，出一次性
 *    「分享 → 添加到主屏幕」指引条（localStorage 记忆已隐藏）；
 * 3. 服务器地址设置：standalone 窗口没有地址栏，宿主 IP 变了（DHCP）在这里改——
 *    语义=跳转重载 origin（location.assign），不做「仅切 API base」跨域形态；
 * 4. 连接状态：轮询 /api/auth/status 判宿主可达性，不可达时顶栏出提示（依赖缓存壳）。
 *
 * 面板（panel 槽）「手机」Tab 集中呈现：安装状态 / 服务器地址 / 连接状态。
 */
import { useEffect, useState } from 'react';
import type { CapabilityHandler, LitePlugin, SlotHostApi } from '@sdk';
import './panel.css';

const HIDE_IOS_GUIDE_KEY = 'mobile-companion.ios-guide-hidden.v1';
const STATUS_POLL_MS = 30_000;

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    // iOS Safari 的 standalone 判定（navigator.standalone 非标准但 iOS 唯一途径）
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  // iPadOS 13+ 伪装 Mac：附加触点判定
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (/Mac/.test(ua) && navigator.maxTouchPoints > 1);
}

/** SW 注册（生产一次性；dev 下无 sw-manifest 产物，注册失败静默） */
async function registerSW(): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch {
    // dev / 旧宿主无 sw.js → 不影响功能
  }
}

/** 当前 origin 的 host:port（设置面板默认值） */
function currentHost(): string {
  if (typeof window === 'undefined') return '';
  return window.location.host;
}

/** 顶栏可达性监听：不可达时把提示条挂 body（纯 DOM，不引 react-dom 依赖）；恢复后自动移除 */
function ReachabilityWatch() {
  const [reachable, setReachable] = useState(true);
  useEffect(() => {
    let alive = true;
    const probe = async () => {
      try {
        const res = await fetch('/api/auth/status', { cache: 'no-store' });
        if (alive) setReachable(res.ok);
      } catch {
        if (alive) setReachable(false);
      }
    };
    void probe();
    const timer = window.setInterval(probe, STATUS_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void probe();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  useEffect(() => {
    let el = document.getElementById('mc-offline-layer');
    if (reachable) {
      el?.remove();
      return;
    }
    if (!el) {
      el = document.createElement('div');
      el.id = 'mc-offline-layer';
      document.body.appendChild(el);
    }
    el.textContent = '';
    // 简化挂载：纯 DOM 提示条（不引 react-dom/client 的 createPortal——插件 bundle 不应依赖）
    const banner = document.createElement('div');
    banner.className = 'mc-offline-banner';
    banner.setAttribute('data-testid', 'mc-offline-banner');
    const span = document.createElement('span');
    span.textContent = '连不上电脑——请检查电脑是否开机、是否同一网络';
    const btn = document.createElement('button');
    btn.textContent = '重试';
    btn.addEventListener('click', () => window.location.reload());
    banner.append(span, btn);
    el.append(banner);
    return () => {
      el?.remove();
    };
  }, [reachable]);
  return null;
}

/** 安装引导：Android Chrome 捕获 beforeinstallprompt；iOS 一次性指引条 */
function InstallGuide() {
  const [deferred, setDeferred] = useState<{ prompt: () => Promise<void> } | null>(null);
  const [showIOS, setShowIOS] = useState(false);
  const standalone = isStandalone();

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault(); // 阻止 Chrome 自动迷你条，改用自定义气泡
      setDeferred(e as unknown as { prompt: () => Promise<void> });
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    // iOS：未 standalone + 未隐藏过 → 显示指引
    if (isIOS() && !standalone && !localStorage.getItem(HIDE_IOS_GUIDE_KEY)) {
      setShowIOS(true);
    }
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, [standalone]);

  const install = async () => {
    if (!deferred) return;
    await deferred.prompt();
    setDeferred(null);
  };

  const hideIOS = () => {
    localStorage.setItem(HIDE_IOS_GUIDE_KEY, '1');
    setShowIOS(false);
  };

  if (standalone && !deferred) {
    return <div className="mc-hint">已在 App 模式中运行</div>;
  }
  return (
    <>
      {deferred && (
        <div className="mc-install-bubble" data-testid="mc-install-bubble">
          <span>安装到手机，像原生 App 一样使用</span>
          <button onClick={install}>安装</button>
          <button className="mc-ghost" onClick={() => setDeferred(null)}>暂不</button>
        </div>
      )}
      {showIOS && (
        <div className="mc-install-bubble" data-testid="mc-ios-guide">
          <span>用 iOS「分享」→「添加到主屏幕」安装本应用</span>
          <button className="mc-ghost" onClick={hideIOS}>知道了</button>
        </div>
      )}
      {!deferred && !showIOS && !standalone && (
        <div className="mc-hint">浏览器菜单里选「添加到主屏幕 / 安装应用」即可安装</div>
      )}
    </>
  );
}

/** 服务器地址设置（standalone 无地址栏的唯一改址入口） */
function ServerAddressForm() {
  const [host, setHost] = useState(currentHost());
  const [err, setErr] = useState('');

  const apply = () => {
    const v = host.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!/^[\w.-]+:\d{2,5}$/.test(v)) {
      setErr('格式：IP:端口 或 域名:端口，如 192.168.1.100:9825');
      return;
    }
    // 语义=跳转重载 origin：cookie/会话/SW 作用域随新 origin 重新建立
    window.location.assign(`http://${v}/`);
  };

  return (
    <div className="mc-addr">
      <div className="mc-addr-label">电脑服务地址</div>
      <div className="mc-hint">当前：{currentHost() || '—'}</div>
      <input
        className="mc-input"
        placeholder="192.168.1.100:9825"
        value={host}
        onChange={(e) => { setHost(e.target.value); setErr(''); }}
        onKeyDown={(e) => { if (e.key === 'Enter') apply(); }}
      />
      {err && <div className="mc-err">{err}</div>}
      <button className="mc-btn" onClick={apply}>连接</button>
      <div className="mc-hint">修改后页面会跳转到新地址并要求重新登录（电脑换了 IP 时用）。</div>
    </div>
  );
}

/** panel 槽主面板 */
export function MobileCompanionPanel() {
  return (
    <div className="mc-panel" data-testid="mc-panel">
      <h3>手机与连接</h3>
      <InstallGuide />
      <ServerAddressForm />
    </div>
  );
}

function createCompanionHandler(): CapabilityHandler {
  return () => ({ ok: true });
}

export const mobileCompanionPlugin: LitePlugin = {
  manifest: {
    id: 'mobile-companion',
    name: '手机伴侣',
    version: '0.1.0',
    capabilities: [],
    provides: ['cap.mobile.companion'],
    events: [],
    contributes: {
      slots: [{ slot: 'panel', component: 'MobileCompanionPanel', order: 12, title: '手机' }],
    },
  },
  setup(api: SlotHostApi) {
    void registerSW();
    api.registerCapability.register('cap.mobile.companion', createCompanionHandler());
  },
};

/** 顶层挂载的可达性监听（ReachabilityWatch）由宿主渲染——经组件导出给 SlotLayout 以外使用 */
export { ReachabilityWatch };

export default mobileCompanionPlugin;
