/**
 * PersonalHub 登录/注册卡片（对齐 Polaris LoginCard.tsx，走 GoTrue REST）。
 */
import { useState } from 'react';
import { authSignIn, authSignUp, saveSession, authUser, SupabaseHttpError } from './supabase';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function LoginCard({ onSignedIn }: { onSignedIn: (u: { id: string; email?: string }) => void }) {
  const [tab, setTab] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setInfo(null);

    if (!EMAIL_RE.test(email)) {
      setError('邮箱格式不正确');
      return;
    }
    if (password.length < 6) {
      setError('密码长度至少 6 位');
      return;
    }

    setLoading(true);
    try {
      if (tab === 'register') {
        if (password !== confirmPassword) {
          setError('两次输入的密码不一致');
          return;
        }
        await authSignUp(email, password);
        setInfo('注册成功，请查收邮件验证链接后登录');
        setTab('login');
      } else {
        const res = await authSignIn(email, password);
        if (res.access_token) {
          saveSession({
            access_token: res.access_token,
            refresh_token: res.refresh_token ?? '',
            expires_at: res.expires_at,
            user: res.user,
          });
          const u = res.user?.id ? { id: res.user.id, email: res.user.email } : await authUser(res.access_token);
          if (u) onSignedIn(u);
        } else {
          setError('登录失败');
        }
      }
    } catch (err) {
      const msg = err instanceof SupabaseHttpError ? err.message : String((err as Error)?.message ?? err);
      setError(msg || '操作失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="ph-center">
      <div className="ph-login">
        <div>
          <h2>个人空间</h2>
          <p className="sub">登录以同步你的导航、书签与待办</p>
        </div>

        <div className="ph-login-tabs" role="tablist">
          {(['login', 'register'] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              className={tab === t ? 'active' : ''}
              onClick={() => { setTab(t); setError(null); setInfo(null); }}
            >
              {t === 'login' ? '登录' : '注册'}
            </button>
          ))}
        </div>

        <form onSubmit={(e) => void handleSubmit(e)}>
          <div>
            <label className="ph-label">邮箱</label>
            <input
              className="ph-input" type="email" value={email} disabled={loading}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com" autoComplete="email"
            />
          </div>
          <div>
            <label className="ph-label">密码</label>
            <input
              className="ph-input" type="password" value={password} disabled={loading}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="至少 6 位"
              autoComplete={tab === 'login' ? 'current-password' : 'new-password'}
            />
          </div>
          {tab === 'register' && (
            <div>
              <label className="ph-label">确认密码</label>
              <input
                className="ph-input" type="password" value={confirmPassword} disabled={loading}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="再次输入密码" autoComplete="new-password"
              />
            </div>
          )}

          {error && <div className="ph-error">{error}</div>}
          {info && <div className="ph-info">{info}</div>}

          <button type="submit" className="ph-btn-primary" disabled={loading} style={{ width: '100%' }}>
            {loading ? '处理中...' : tab === 'login' ? '登录' : '注册'}
          </button>
        </form>
      </div>
    </div>
  );
}
