/**
 * phone-agent 插件：AI 工具（cap.tool.phone）+ 手机端点（docs/mobile-app-plan.md §9）。
 *
 * 双角色（同一个浏览器页面里同时生效）：
 * 1. **门面**（桌面/任何设备都有效）：向 agent-loop 注册 cap.tool.phone 工具
 *    （describe 协议），AI 调 exec → POST /api/phone/command → 服务端把指令下发到
 *    目标手机的 SSE 流 → 等结果回传。本插件在桌面浏览器上只是「转发台」。
 * 2. **端点**（手机上）：SSE 连接 /api/phone/events 挂在服务端上，收 command 事件
 *    → 本地执行器（clipboard/notify/files…）→ POST /api/phone/result 回传。
 *
 * 同意模型：首连时服务端回 CONSENT_REQUIRED → UI 出一行确认
 * 「允许这台电脑的 AI 访问本手机」（默认拒绝）→ POST consent { allow:true } 登记。
 * 撤销入口在面板（随时可以「取消允许」把设备除名，AI 立刻不可见）。
 *
 * 能力如实标注：PWA 拿不到系统截屏/后台常驻（iOS 冻结后 SSE 断即离线），
 * describe 里写明，AI 调不到的能力返回结构化降级而不是假装成功。
 */
import { useEffect, useState } from 'react';
import type { CapabilityHandler, LitePlugin, SlotHostApi } from '@sdk';
import './panel.css';

/** 本机支持的执行器（能力清单，注册时上报；平台差异如实声明） */
type Executor = (payload: Record<string, unknown>) => Promise<unknown>;
const EXECUTORS: Record<string, Executor> = {
  'clipboard.read': async () => {
    // Web 剪贴板读取要求页面聚焦（iOS 还要点授权弹窗）——不满足时结构化降级
    if (!navigator.clipboard?.readText) {
      return { ok: false, error: '此浏览器不支持剪贴板读取（需要 HTTPS 或较新浏览器）' };
    }
    try {
      const text = await navigator.clipboard.readText();
      return { ok: true, data: text };
    } catch (e) {
      return { ok: false, error: `剪贴板读取被拒绝：${e instanceof Error ? e.message : String(e)}` };
    }
  },
  'clipboard.write': async (p) => {
    const text = String(p?.text ?? '');
    if (!text) return { ok: false, error: 'text required' };
    try {
      await navigator.clipboard.writeText(text);
      return { ok: true, data: 'written' };
    } catch (e) {
      return { ok: false, error: `剪贴板写入被拒绝：${e instanceof Error ? e.message : String(e)}` };
    }
  },
  notify: async (p) => {
    const title = String(p?.title ?? 'Polaris');
    const body = String(p?.body ?? '');
    if (!('Notification' in window)) return { ok: false, error: '此环境不支持通知' };
    let perm = Notification.permission;
    if (perm === 'default') perm = await Notification.requestPermission();
    if (perm !== 'granted') return { ok: false, error: `通知权限：${perm}` };
    new Notification(title, { body });
    return { ok: true, data: 'notified' };
  },
  'page.snap': async () => {
    // 当前页面文本摘要（手机端点导航到的页面；宿主应用自身 DOM 也有意义——如会话列表）
    const text = document.body?.innerText ?? '';
    const clipped = text.length > 8000 ? text.slice(0, 8000) + '…[truncated]' : text;
    return { ok: true, data: clipped, meta: { url: window.location.href } };
  },
};

const DECLARED_CAPS = Object.keys(EXECUTORS);

/** describe 协议：工具描述（进 agent-loop 的 tools 数组） */
const DESCRIPTOR = {
  cap: 'cap.tool.phone',
  name: 'phone',
  description:
    '访问用户的手机端点：读/写手机剪贴板、发手机通知、抓取手机当前页面文本。' +
    '手机必须在线（App 处于打开状态）且用户已在手机上确认允许访问；离线或未确认会返回明确错误，' +
    '请把错误转述给用户而不是重试。系统截屏/读相册受平台限制暂不可用。',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: DECLARED_CAPS,
        description: '能力动作：clipboard.read（读手机剪贴板）/ clipboard.write（写手机剪贴板，参数 text）/ notify（发手机通知，参数 title/body）/ page.snap（手机当前页面文本）',
      },
      text: { type: 'string', description: 'clipboard.write 要写入的文本' },
      title: { type: 'string', description: 'notify 通知标题' },
      body: { type: 'string', description: 'notify 通知正文' },
      timeoutMs: { type: 'number', description: '超时毫秒，默认 30000' },
    },
    required: ['action'],
  },
  danger: 'read' as const,
};

// ---- 端点半边：SSE 客户端（仅本机是「被访问的手机」时活动）----
interface PhoneChannelState {
  deviceId: string;
  consented: boolean;
  online: boolean;
}
let channelState: PhoneChannelState | null = null;
let hostApiRef: SlotHostApi | null = null;
const channelListeners = new Set<(s: PhoneChannelState | null) => void>();

function notifyChannel() {
  for (const l of channelListeners) l(channelState);
}

let started = false;
function startChannel(): void {
  if (started || typeof window === 'undefined') return;
  started = true;

  const connect = () => {
    const es = new EventSource('/api/phone/events');
    es.addEventListener('registered', (ev) => {
      const { deviceId } = JSON.parse((ev as MessageEvent).data) as { deviceId: string };
      channelState = { deviceId, consented: false, online: true };
      notifyChannel();
      void register(deviceId);
    });
    es.addEventListener('command', (ev) => {
      const { commandId, action, payload } = JSON.parse((ev as MessageEvent).data) as {
        commandId: string; action: string; payload: Record<string, unknown>;
      };
      void (async () => {
        const exec = EXECUTORS[action];
        let result: unknown;
        if (!exec) {
          result = { ok: false, error: `本机不支持能力：${action}` };
        } else {
          try {
            result = await exec(payload ?? {});
          } catch (e) {
            result = { ok: false, error: e instanceof Error ? e.message : String(e) };
          }
        }
        await fetch('/api/phone/result', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ deviceId: channelState?.deviceId, commandId, ...(result as object) }),
        }).catch(() => undefined);
      })();
    });
    es.addEventListener('ping', () => {
      // 服务端 ping 到达即通道活着；显式心跳让服务端记录 lastSeen
      if (!channelState?.deviceId) return;
      void fetch('/api/phone/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ deviceId: channelState.deviceId }),
      }).catch(() => undefined);
    });
    es.onerror = () => {
      es.close();
      if (channelState) { channelState = { ...channelState, online: false }; notifyChannel(); }
      // 断线重连（宿主重启/休眠恢复）：10s 退避，不爆炸
      window.setTimeout(connect, 10_000);
    };
  };
  connect();
}

async function register(deviceId: string): Promise<void> {
  const res = await fetch('/api/phone/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      deviceId,
      name: /iPhone|iPad|Android|Mobile/i.test(navigator.userAgent) ? '手机' : '浏览器',
      capabilities: DECLARED_CAPS,
    }),
  }).catch(() => null);
  if (!res) return;
  const data = (await res.json().catch(() => null)) as { ok?: boolean; consentRequired?: boolean; consented?: boolean } | null;
  if (data?.consented) {
    channelState = { deviceId, consented: true, online: true };
    notifyChannel();
  }
  // consentRequired → 等用户在面板点「允许」
}

// ---- 门面半边：cap.tool.phone（桌面/手机上都注册；执行在服务端路由）----
function createPhoneHandler(): CapabilityHandler {
  return async (req) => {
    const payload = (req.payload ?? {}) as { action?: string; text?: string; title?: string; body?: string; timeoutMs?: number; deviceId?: string };
    switch (req.action) {
      case 'describe':
        return { descriptor: DESCRIPTOR };
      case 'exec': {
        const action = String(payload.action ?? '');
        if (!action) return { ok: false, error: 'action required' };
        const resp = await fetch('/api/phone/command', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            action,
            payload: { text: payload.text, title: payload.title, body: payload.body },
            timeoutMs: payload.timeoutMs,
            deviceId: payload.deviceId,
          }),
        });
        const json = (await resp.json().catch(() => null)) as
          | { ok?: boolean; data?: unknown; error?: string; code?: string; truncated?: boolean }
          | null;
        if (!resp.ok || !json) {
          return { ok: false, error: json?.error ?? `HTTP ${resp.status}`, code: json?.code };
        }
        return json;
      }
      default:
        return { ok: false, error: `unknown action: ${req.action}` };
    }
  };
}

// ---- UI：面板（手机上=同意管理；桌面=设备状态说明）----
export function PhoneAgentPanel() {
  const [state, setState] = useState<PhoneChannelState | null>(channelState);
  const [, forceTick] = useState(0);
  useEffect(() => {
    const l = (s: PhoneChannelState | null) => { setState(s); forceTick((t) => t + 1); };
    channelListeners.add(l);
    return () => { channelListeners.delete(l); };
  }, []);

  const consent = async (allow: boolean) => {
    if (!state?.deviceId) return;
    await fetch('/api/phone/consent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ deviceId: state.deviceId, allow, name: /iPhone|iPad|Android|Mobile/i.test(navigator.userAgent) ? '手机' : '浏览器' }),
    });
    // 重新走 register 让服务端接受能力上报
    await register(state.deviceId);
  };

  return (
    <div className="pa-panel" data-testid="pa-panel">
      <h3>AI 访问本机</h3>
      <div className="pa-hint">
        允许后，电脑上的 AI 可以读写本机剪贴板、发送通知、读取当前页面文本（工具 cap.tool.phone）。
        手机需保持应用打开才在线；撤销后 AI 立即失去访问。
      </div>
      {state?.consented ? (
        <div className="pa-consented">
          <div className="pa-ok">已允许 · 设备 {state.deviceId.slice(0, 10)}{state.online ? ' · 在线' : ' · 离线'}</div>
          <button className="pa-btn pa-danger" onClick={() => void consent(false)}>取消允许</button>
        </div>
      ) : state ? (
        <div className="pa-consent-row" data-testid="pa-consent-row">
          <span>允许这台电脑的 AI 访问本机？</span>
          <button className="pa-btn" onClick={() => void consent(true)}>允许</button>
          <button className="pa-btn pa-ghost" onClick={() => void consent(false)}>拒绝</button>
        </div>
      ) : (
        <div className="pa-hint">连接通道建立中…</div>
      )}
      {hostApiRef === null && null /* hostApi 引用只用于事件，不渲染 */}
    </div>
  );
}

export const phoneAgentPlugin: LitePlugin = {
  manifest: {
    id: 'phone-agent',
    name: '手机端点',
    version: '0.1.0',
    capabilities: ['cap.auth', 'cap.meta'],
    provides: ['cap.tool.phone'],
    events: ['tool-registered', 'auth-changed'],
    contributes: {
      slots: [{ slot: 'panel', component: 'PhoneAgentPanel', order: 13, title: '端点' }],
    },
  },
  setup(api: SlotHostApi) {
    hostApiRef = api;
    api.registerCapability.register('cap.tool.phone', createPhoneHandler());
    api.emit('tool-registered', { cap: 'cap.tool.phone', name: DESCRIPTOR.name });
    // 端点半边：登录后才挂通道（auth-changed 后也尝试；EventSource 带 cookie）
    void api.dispatch({ target: 'cap.auth', action: 'status' }).then((r) => {
      const st = r.data as { status?: string } | undefined;
      if (st?.status === 'authenticated') startChannel();
    }).catch(() => undefined);
    api.listen('auth-changed', (payload) => {
      const p = payload as { status?: string } | null;
      if (p?.status === 'authenticated') startChannel();
    });
  },
};

export default phoneAgentPlugin;
