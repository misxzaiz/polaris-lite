/**
 * mock-auth 插件：权限验证插件（cap.auth 提供方，可替换）。
 *
 * 登录/登出/会话校验全部**委托宿主内嵌 auth 路由**（/api/auth/*，服务端会话 + HttpOnly cookie）：
 * - 中继（/api/model-relay）只认该 cookie 会话——同一份服务端鉴权覆盖页面与模型调用；
 * - sessionStorage 仅作 UI 镜像（壳层门禁 useAuthGate 与欢迎语使用），服务端为准；
 * - owner（首登=注册，仅一次）上收服务端 .polaris-lite/auth-owner.json（sha256+salt）；
 * - 状态变化经 auth-changed 广播。
 */
import { useState } from 'react';
import md5 from 'md5';
import type { AuthStatusResult, CapabilityHandler, LitePlugin, SlotHostApi } from '@/core/types';
import './auth.css';

const SESSION_KEY = 'mock-auth.session.v1';
/** 与宿主 server/auth-session.mjs 的 TTL 保持一致（12h） */
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
let hostApi: SlotHostApi | null = null;

interface StoredSession {
  user: { id: string; name: string; roles: string[] };
  token: string;
  issuedAt: number;
}

function tokenDigest(token: string): string {
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

function readSession(): StoredSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as StoredSession) : null;
  } catch {
    return null;
  }
}

function writeSession(s: StoredSession): void {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
}

function clearSession(): void {
  sessionStorage.removeItem(SESSION_KEY);
}

function currentStatus(): AuthStatusResult {
  const s = readSession();
  if (!s) return { status: 'unauthenticated', user: null };
  return {
    status: 'authenticated',
    user: s.user,
    tokenDigest: tokenDigest(s.token),
    expiresAt: s.issuedAt + SESSION_TTL_MS,
  };
}

function notifyChanged(): void {
  hostApi?.emit('auth-changed', { status: currentStatus().status });
}

/** 服务端状态查询（鉴权权威）：与本地镜像不一致时以服务端为准 */
async function serverStatus(): Promise<{ status: string; user?: { name: string } } | null> {
  try {
    const res = await fetch('/api/auth/status', { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as { status: string; user?: { name: string } };
  } catch {
    return null;
  }
}

function createAuthHandler(): CapabilityHandler {
  return (req) => {
    const payload = (req.payload ?? {}) as { username?: string; password?: string; permission?: string };
    switch (req.action) {
      case 'status':
        // 同步返回本地镜像（壳层门禁用）；服务端权威校验由 LoginForm 的
        // /api/auth/status 双查与 /api/model-relay 的 401 兜底执行
        return currentStatus();
      case 'login': {
        const username = (payload.username ?? '').trim();
        const password = payload.password ?? '';
        if (!username) {
          return { ok: false, error: { code: 'AUTH_INVALID_CREDENTIALS', message: '用户名不能为空' } };
        }
        if (password.length < 4) {
          return { ok: false, error: { code: 'AUTH_INVALID_CREDENTIALS', message: '密码至少 4 位' } };
        }
        // 凭据校验/注册人判定/会话签发全部在宿主 /api/auth/login（服务端权威）
        return { pendingServer: true, username };
      }
      case 'logout': {
        // 服务端删会话 + 清 cookie；前端清镜像
        void fetch('/api/auth/logout', { method: 'POST' }).finally(() => {
          clearSession();
          notifyChanged();
        });
        return { ok: true };
      }
      case 'check': {
        const s = readSession();
        const allowed = !!s;
        return { allowed, reason: allowed ? undefined : '未登录' };
      }
      case 'server-status': {
        // 供异步流程获取服务端权威状态（V3 修复：不单信本地镜像）
        return { pending: true };
      }
      default:
        return { ok: false, error: { code: 'AUTH_UNKNOWN_ACTION', message: `unknown action: ${req.action}` } };
    }
  };
}

function LoginForm() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      // 密码先 MD5 再传输/提交（前端加密；服务端存同算法哈希比对）
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: md5(password) }),
      });
      const data = (await res.json()) as { ok?: boolean; status?: string; user?: { name: string }; error?: { message?: string } };
      if (!res.ok || data.ok === false || data.status !== 'authenticated') {
        setError(data.error?.message ?? '登录失败');
        setBusy(false);
        return;
      }
      // 服务端会话已签发（cookie）。镜像到 sessionStorage 供壳层门禁/欢迎语。
      writeSession({
        user: { id: `u-${data.user!.name}`, name: data.user!.name, roles: ['user'] },
        token: `server-${Date.now().toString(36)}`,
        issuedAt: Date.now(),
      });
      notifyChanged();
      // 壳层 useAuthGate 收到 auth-changed 后自动放行
    } catch (e) {
      setError(e instanceof Error ? e.message : '登录失败');
    }
    setBusy(false);
  };

  // 已登录（session 镜像）时显示欢迎 + 修改账号密码 + 登出按钮
  const sess = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(SESSION_KEY) : null;
  if (sess) {
    const parsed = JSON.parse(sess) as StoredSession;
    const logout = async () => {
      await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
      clearSession();
      notifyChanged();
    };
    return (
      <div className="auth-login">
        <div className="auth-title">已登录</div>
        <div className="auth-sub">{parsed.user.name} · {tokenDigest(parsed.token)}</div>
        <ChangeCredentialsForm />
        <button className="auth-submit" onClick={logout}>登出</button>
      </div>
    );
  }

  return (
    <div className="auth-login">
      <div className="auth-title">登录 Polaris Lite</div>
      <div className="auth-sub">首登将注册为管理员（仅此一次）；之后请使用注册人账号登录</div>
      <input
        className="auth-input"
        placeholder="用户名"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
      />
      <input
        className="auth-input"
        type="password"
        placeholder="密码"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
      />
      {error && <div className="auth-error">{error}</div>}
      <button className="auth-submit" onClick={submit} disabled={busy || !username || password.length < 4}>
        {busy ? '登录中…' : '登录'}
      </button>
    </div>
  );
}

/** 修改注册人账号/密码（仅登录态可用；旧密码校验在服务端） */
function ChangeCredentialsForm() {
  const [newUsername, setNewUsername] = useState('');
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const logoutAndReload = async () => {
    if (hostApi) {
      // 经总线登出（服务端清 cookie 会话 + 插件清镜像 + 广播）
      await hostApi.dispatch({ target: 'cap.auth', action: 'logout' });
    }
    window.location.reload();
  };

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setErr('');
    setMsg('');
    try {
      const res = await fetch('/api/auth/change-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newUsername, oldPassword: md5(oldPassword), newPassword: md5(newPassword) }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: { message?: string } };
      if (!res.ok || data.ok === false) {
        setErr(data.error?.message ?? '修改失败');
      } else {
        setMsg('修改成功，请用新账号密码重新登录');
        // 服务端已清除所有会话；前端同步清理回到登录视图
        sessionStorage.removeItem(SESSION_KEY);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : '修改失败');
    }
    setBusy(false);
  };

  return (
    <div className="auth-chg">
      <div className="auth-chg-title">账号安全（登出 / 修改凭据）</div>
      <button className="auth-submit" onClick={logoutAndReload}>登出</button>
      <input
        className="auth-input"
        placeholder="新用户名"
        value={newUsername}
        onChange={(e) => setNewUsername(e.target.value)}
      />
      <input
        className="auth-input"
        type="password"
        placeholder="旧密码"
        value={oldPassword}
        onChange={(e) => setOldPassword(e.target.value)}
      />
      <input
        className="auth-input"
        type="password"
        placeholder="新密码（至少 4 位）"
        value={newPassword}
        onChange={(e) => setNewPassword(e.target.value)}
      />
      {err && <div className="auth-error">{err}</div>}
      {msg && <div className="auth-msg">{msg}</div>}
      <button
        className="auth-submit"
        onClick={submit}
        disabled={busy || !newUsername || !oldPassword || newPassword.length < 4}
      >
        {busy ? '提交中…' : '确认修改'}
      </button>
    </div>
  );
}

export const mockAuthPlugin: LitePlugin = {
  manifest: {
    id: 'mock-auth',
    name: '演示登录',
    version: '0.4.0',
    capabilities: ['cap.auth'],
    provides: ['cap.auth'],
    events: [],
    contributes: {
      slots: [
        { slot: 'auth', component: 'LoginForm', order: 0 },
        { slot: 'panel', component: 'ChangeCredentialsPanel', order: 3 },
      ],
    },
  },
  setup(api: SlotHostApi) {
    hostApi = api;
    api.registerCapability.register('cap.auth', createAuthHandler());
    // 接口级检查：受保护 cap 在总线层先过登录校验。
    // 走 SlotHostApi 一等契约（宿主按 manifest.provides 校验资格），不再依赖 window 全局后门——
    // 后者在 bootstrap 时序上永远晚于插件 setup，guard 实际从未安装（已修）。
    api.registerAuthGuard?.(() => {
      const s = readSession();
      if (!s) return false;
      const expired = s.issuedAt + SESSION_TTL_MS < Date.now();
      return !expired; // 镜像判断；服务端权威校验由 /api/model-relay 自身执行
    });
  },
};

/** panel 槽版本：修改凭据表单（登录后可见） */
function ChangeCredentialsPanel() {
  return (
    <div className="cap-panel model-admin">
      <h3>账号安全</h3>
      <ChangeCredentialsForm />
    </div>
  );
}

export const components = { LoginForm, ChangeCredentialsPanel };
export default mockAuthPlugin;
