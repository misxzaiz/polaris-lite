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
import { KEY_MOCK_AUTH_SESSION, type AuthStatusResult, CapabilityHandler, LitePlugin, SlotHostApi } from '@sdk';
import './auth.css';

const SESSION_KEY = KEY_MOCK_AUTH_SESSION;
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

/**
 * 总线鉴权的服务端兜底（单飞 + 3s 缓存）。
 *
 * 背景：壳层镜像（sessionStorage）是异步补齐的——首次带 cookie 打开页面时，
 * 各面板的 dispatch 可能早于 mock-auth 的启动对齐完成，导致"明明已登录却被拒"。
 * 镜像不可用时问一次服务端，并把结果回填镜像，既修竞态也修"清过 sessionStorage"的场景。
 */
const SERVER_AUTH_TTL_MS = 3000;
let serverAuthCache: { at: number; authed: boolean } | null = null;
let serverAuthInflight: Promise<boolean> | null = null;

export function invalidateServerAuth(): void {
  serverAuthCache = null;
}

async function serverAuthenticated(): Promise<boolean> {
  if (serverAuthCache && Date.now() - serverAuthCache.at < SERVER_AUTH_TTL_MS) return serverAuthCache.authed;
  if (serverAuthInflight) return serverAuthInflight;
  const p = (async () => {
    const s = await serverStatus();
    const authed = s?.status === 'authenticated';
    serverAuthCache = { at: Date.now(), authed };
    // 服务端已登录但本地镜像缺失 → 回填（壳层门禁与欢迎语都用它）
    if (authed && !readSession() && s?.user) {
      writeSession({
        user: { id: `u-${s.user.name}`, name: s.user.name, roles: ['owner'] },
        token: `server-${Date.now().toString(36)}`,
        issuedAt: Date.now(),
      });
      notifyChanged();
    }
    return authed;
  })();
  serverAuthInflight = p;
  try {
    return await p;
  } finally {
    serverAuthInflight = null;
  }
}

function createAuthHandler(): CapabilityHandler {
  return (req) => {
    switch (req.action) {
      case 'status':
        // 同步返回本地镜像（壳层门禁需要同步判定）；服务端权威校验在登录/中继 401 处执行，
        // 启动时另有 reconcile（见 setup）把镜像与服务端对齐。
        return currentStatus();
      case 'logout': {
        // 服务端删会话 + 清 cookie；前端清镜像
        void fetch('/api/auth/logout', { method: 'POST' }).finally(() => {
          clearSession();
          invalidateServerAuth();
          notifyChanged();
        });
        return { ok: true };
      }
      case 'check': {
        const allowed = !!readSession();
        return { allowed, reason: allowed ? undefined : '未登录' };
      }
      default:
        return { ok: false, error: { code: 'AUTH_UNKNOWN_ACTION', message: `unknown action: ${req.action}` } };
    }
  };
}

function AuthBrand() {
  return (
    <div className="auth-brand" aria-label="Polaris Lite">
      <span className="auth-brand-mark" aria-hidden="true">
        <svg viewBox="0 0 32 32" fill="none">
          <path d="M16 2.5 18.8 13.2 29.5 16 18.8 18.8 16 29.5 13.2 18.8 2.5 16 13.2 13.2 16 2.5Z" stroke="currentColor" strokeWidth="1.1" />
          <path d="M16 9.5 17.35 14.65 22.5 16 17.35 17.35 16 22.5 14.65 17.35 9.5 16 14.65 14.65 16 9.5Z" fill="currentColor" fillOpacity="0.2" />
        </svg>
      </span>
      <span className="auth-brand-name">POLARIS</span>
      <span className="auth-brand-edition">Lite · Private Intelligence</span>
    </div>
  );
}

function LoginForm() {
  const [mode, setMode] = useState<'password' | 'tempToken'>('password');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [tempToken, setTempToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const applyServerSession = (data: { user?: { name: string }; expiresAt?: number }) => {
    // 服务端会话已签发（cookie）。镜像到 sessionStorage 供壳层门禁/欢迎语使用。
    const ttl = 12 * 60 * 60 * 1000;
    writeSession({
      user: { id: `u-${data.user!.name}`, name: data.user!.name, roles: ['owner'] },
      token: `server-${Date.now().toString(36)}`,
      issuedAt: data.expiresAt ? data.expiresAt - ttl : Date.now(),
    });
    notifyChanged();
    invalidateServerAuth();
    // 壳层 useAuthGate 收到 auth-changed 后自动放行
  };

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      // 密码直接经 HTTPS/同源 POST 提交；服务端用 scrypt 加盐哈希存储。
      // （此前前端先做 md5，等于把"可重放的静态凭据"当密码用，且 md5 对安全性零收益）
      // 临时凭证模式：服务端校验 tempToken 后签发同样的会话 cookie（权限等同密码登录）。
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mode === 'tempToken' ? { tempToken: tempToken.trim() } : { username, password }),
      });
      const data = (await res.json()) as { ok?: boolean; status?: string; user?: { name: string }; expiresAt?: number; error?: { message?: string } };
      if (!res.ok || data.ok === false || data.status !== 'authenticated') {
        setError(data.error?.message ?? '登录失败');
        setBusy(false);
        return;
      }
      applyServerSession(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : '登录失败');
    }
    setBusy(false);
  };

  const canSubmit = mode === 'tempToken' ? tempToken.trim().length >= 16 : !!username && password.length >= 4;

  // 已登录（session 镜像）时显示欢迎 + 修改账号密码 + 登出按钮
  const sess = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(SESSION_KEY) : null;
  if (sess) {
    const parsed = JSON.parse(sess) as StoredSession;
    const logout = async () => {
      await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
      clearSession();
      invalidateServerAuth();
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
      <AuthBrand />
      <div className="auth-title">欢迎回来</div>
      <div className="auth-sub">进入你的私人智能空间。首次登录将创建唯一管理员账号。</div>
      {mode === 'password' ? (
        <>
          <label className="auth-field">
            <span>账号</span>
            <input
              className="auth-input"
              placeholder="用户名"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
            />
          </label>
          <label className="auth-field">
            <span>密码</span>
            <input
              className="auth-input"
              type="password"
              placeholder="至少 4 位字符"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
            />
          </label>
        </>
      ) : (
        <label className="auth-field">
          <span>临时凭证</span>
          <input
            className="auth-input"
            placeholder="粘贴签发的临时凭证 Token"
            autoComplete="off"
            spellCheck={false}
            value={tempToken}
            onChange={(e) => setTempToken(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
          />
          <span className="auth-temp-hint">在「账号 → 临时凭证」面板签发；有效期与账号密码登录相同（12 小时会话）。</span>
        </label>
      )}
      {error && <div className="auth-error">{error}</div>}
      <button className="auth-submit" onClick={submit} disabled={busy || !canSubmit}>
        {busy ? '正在验证…' : '进入 Polaris'}
      </button>
      <button
        type="button"
        className="auth-switch"
        onClick={() => { setMode(mode === 'password' ? 'tempToken' : 'password'); setError(''); }}
      >
        {mode === 'password' ? '使用临时凭证登录' : '返回账号密码登录'}
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
        body: JSON.stringify({ newUsername, oldPassword, newPassword }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: { message?: string } };
      if (!res.ok || data.ok === false) {
        setErr(data.error?.message ?? '修改失败');
      } else {
        setMsg('修改成功，请用新账号密码重新登录');
        // 服务端已清除所有会话；前端同步清理并回登录视图
        sessionStorage.removeItem(SESSION_KEY);
        invalidateServerAuth();
        notifyChanged();
        window.location.reload();
        return;
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
    // 插件身份名（开发者视角）：说明这是 mock 实现，任意账号可登录。
    // 用户可见的面板名由下面 contributes.slots[].title 单独给出，不暴露「演示」字样。
    name: '演示登录',
    version: '0.4.0',
    capabilities: ['cap.auth'],
    provides: ['cap.auth'],
    events: ['auth-changed'],
    contributes: {
      slots: [
        { slot: 'auth', component: 'LoginForm', order: 0 },
        // title 面向用户：点开是「账号安全」改密/改号表单，故按内容命名为「账号」，
        // 不与插件名「演示登录」绑定（换成真实 SSO 插件时本面板语义不变）。
        { slot: 'panel', component: 'ChangeCredentialsPanel', order: 4, title: '账号' },
        // 临时访问凭证：给 AI/本机脚本签发短时效 Bearer token（账号 Tab 内）
        { slot: 'panel', component: 'TempCredentialPanel', order: 9, title: '临时凭证' },
      ],
    },
  },
  setup(api: SlotHostApi) {
    hostApi = api;
    api.registerCapability.register('cap.auth', createAuthHandler());
    // 接口级检查：受保护 cap 在总线层先过登录校验。
    // 走 SlotHostApi 一等契约（宿主按 manifest.provides 校验资格），不再依赖 window 全局后门——
    // 后者在 bootstrap 时序上永远晚于插件 setup，guard 实际从未安装（已修）。
    api.registerAuthGuard?.(async () => {
      const s = readSession();
      // 镜像有效 → 直接放行（快路径，不打网络）
      if (s && s.issuedAt + SESSION_TTL_MS > Date.now()) return true;
      // 镜像缺失/过期 → 以服务端为准（单飞 + 短 TTL 缓存）
      return await serverAuthenticated();
    });

    // 启动对齐（服务端为权威）：多标签页、清过 sessionStorage、服务重启后会话仍有效等场景，
    // 以 /api/auth/status 修正本地镜像，避免「服务端已登录但界面停在登录页」或反向的假登录态。
    void serverStatus().then((s) => {
      if (!s) return; // 服务端不可达：保持现状，不误清
      const mirror = readSession();
      if (s.status === 'authenticated' && !mirror && s.user) {
        writeSession({
          user: { id: `u-${s.user.name}`, name: s.user.name, roles: ['owner'] },
          token: `server-${Date.now().toString(36)}`,
          issuedAt: Date.now(),
        });
        notifyChanged();
      } else if (s.status !== 'authenticated' && mirror) {
        clearSession();
        notifyChanged();
      }
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

/**
 * 临时访问凭证面板（账号 Tab）：
 * 给 AI / 外部脚本签发短时效 Bearer token，用于无 cookie 环境访问 127.0.0.1 的本地 API
 * （/api/fs/*、/api/tool/exec 等）。服务端签发（/api/auth/temp-credential，默认 30 分钟、
 * 可选 5 分钟 ~ 24 小时、仅回环 IP、重启即失效），本面板做「选时长签发 + 展示 + 复制
 * 现成调用示例 + 吊销 + 列出在效凭证」。
 */
interface TempTokenItem { tokenDigest: string; expiresAt: number; remainMs: number }

const TEMP_TTL_CHOICES = [
  { label: '5 分钟', ms: 5 * 60 * 1000 },
  { label: '30 分钟', ms: 30 * 60 * 1000 },
  { label: '2 小时', ms: 2 * 60 * 60 * 1000 },
  { label: '8 小时', ms: 8 * 60 * 60 * 1000 },
  { label: '24 小时', ms: 24 * 60 * 60 * 1000 },
];

function TempCredentialPanel() {
  const [token, setToken] = useState('');
  const [expiresAt, setExpiresAt] = useState(0);
  const [ttlMs, setTtlMs] = useState(30 * 60 * 1000);
  const [items, setItems] = useState<TempTokenItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState('');

  const issue = async () => {
    if (busy) return;
    setBusy(true);
    setErr('');
    try {
      const res = await fetch('/api/auth/temp-credential', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttlMs }),
      });
      const data = (await res.json()) as { ok?: boolean; token?: string; expiresAt?: number; error?: { message?: string } };
      if (!res.ok || data.ok === false || !data.token) {
        setErr(data.error?.message ?? '签发失败');
      } else {
        setToken(data.token);
        setExpiresAt(data.expiresAt ?? Date.now() + ttlMs);
        void refreshList();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : '签发失败');
    }
    setBusy(false);
  };

  const refreshList = async () => {
    try {
      const res = await fetch('/api/auth/temp-credential/list', { cache: 'no-store' });
      const data = (await res.json()) as { ok?: boolean; items?: TempTokenItem[] };
      if (res.ok && data.ok) setItems(data.items ?? []);
    } catch { /* 面板内非关键信息，失败静默 */ }
  };

  const revoke = async (tok?: string) => {
    setErr('');
    try {
      const res = await fetch('/api/auth/temp-credential/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: tok ?? token }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: { message?: string } };
      if (!res.ok || data.ok === false) {
        setErr(data.error?.message ?? '吊销失败');
        return;
      }
      if (!tok) { setToken(''); setExpiresAt(0); }
      void refreshList();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '吊销失败');
    }
  };

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(''), 1400);
    } catch {
      setCopied('');
    }
  };

  const remainMin = expiresAt ? Math.max(0, Math.ceil((expiresAt - Date.now()) / 60000)) : 0;
  const curlExample = token
    ? `curl -H "Authorization: Bearer ${token}" http://127.0.0.1:9825/api/fs/roots`
    : '';

  return (
    <div className="cap-panel model-admin">
      <h3>临时访问凭证</h3>
      <div className="auth-chg">
        <div className="auth-temp-desc">
          给 AI 或本机脚本发一把「临时钥匙」：可选 5 分钟 ~ 24 小时有效期、仅限 127.0.0.1 本机访问、重启即失效；
          泄露也不会波及你的登录账号。携带方式：<code>Authorization: Bearer &lt;token&gt;</code>。
        </div>
        <label className="auth-field">
          <span>有效期</span>
          <select
            className="auth-input"
            value={ttlMs}
            onChange={(e) => setTtlMs(Number(e.target.value))}
            data-testid="temp-ttl-select"
          >
            {TEMP_TTL_CHOICES.map((c) => (
              <option key={c.ms} value={c.ms}>{c.label}</option>
            ))}
          </select>
        </label>
        <button className="auth-submit" onClick={issue} disabled={busy}>
          {busy ? '签发中…' : token ? '重新签发' : `签发临时凭证（${TEMP_TTL_CHOICES.find((c) => c.ms === ttlMs)?.label ?? '30 分钟'}）`}
        </button>
        {err && <div className="auth-error">{err}</div>}
        {token && (
          <>
            <div className="auth-temp-token" data-testid="temp-token">{token}</div>
            <div className="auth-temp-meta">剩余约 {remainMin} 分钟 · 重启服务后失效</div>
            <button className="auth-submit auth-temp-copy" onClick={() => void copy(token, 'token')}>
              {copied === 'token' ? '已复制' : '复制 Token'}
            </button>
            <div className="auth-temp-desc">调用示例（列工作区）：</div>
            <pre className="auth-temp-curl">{curlExample}</pre>
            <button className="auth-submit auth-temp-copy" onClick={() => void copy(curlExample, 'curl')}>
              {copied === 'curl' ? '已复制' : '复制 curl 示例'}
            </button>
            <button className="auth-submit auth-temp-copy" onClick={() => void revoke()}>
              吊销当前凭证
            </button>
          </>
        )}
        <div className="auth-temp-desc">在效凭证（本页签发的可见摘要）：</div>
        {items.length === 0 ? (
          <div className="auth-temp-meta">暂无在效凭证</div>
        ) : (
          <ul className="auth-temp-list">
            {items.map((it) => (
              <li key={it.tokenDigest} className="auth-temp-item">
                <code>{it.tokenDigest}</code>
                <span>剩 {Math.max(0, Math.ceil(it.remainMs / 60000))} 分钟</span>
                <button
                  type="button"
                  className="auth-temp-revoke"
                  onClick={() => { setToken(''); void revoke(it.tokenDigest); }}
                  title="按摘要吊销需整段 token；此处仅展示，吊销以「吊销当前凭证」为准"
                  disabled
                >
                  已在效
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export const components = { LoginForm, ChangeCredentialsPanel, TempCredentialPanel };
export default mockAuthPlugin;
