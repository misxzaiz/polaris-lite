/**
 * PersonalHubPanel：个人空间面板入口（panel 槽）。
 *
 * 状态机（对齐 Polaris PersonalHubPanel）：
 * - 配置未加载 → 加载中
 * - 已加载未配置 Supabase → 配置表单（lite 无全局设置页，配置内嵌本面板）
 * - 已配置未登录 → LoginCard
 * - 已登录 → LinksView
 */
import { useCallback, useEffect, useState } from 'react';
import { loadConfig, saveConfig, isConfigLoaded } from './store';
import { isSupabaseConfigured, getRawPersonalHubConfig, loadSession, saveSession, authUser, DEFAULT_SUPABASE_URL, DEFAULT_SUPABASE_ANON_KEY } from './supabase';
import { LoginCard } from './LoginCard';
import { LinksView } from './LinksView';
import { SettingsForm } from './SettingsForm';
import { Icon } from './ui';
import './panel.css';

export function PersonalHubPanel() {
  const [, force] = useState(0);
  const [view, setView] = useState<'main' | 'settings'>('main');
  const [ready, setReady] = useState(isConfigLoaded());
  const [user, setUser] = useState<{ id: string; email?: string } | null>(null);
  const [authChecked, setAuthChecked] = useState(false);

  // 首次装配：读配置 → 校验会话
  useEffect(() => {
    let alive = true;
    (async () => {
      await loadConfig();
      if (!alive) return;
      setReady(true);
      if (isSupabaseConfigured()) {
        const sess = loadSession();
        if (sess?.access_token) {
          const u = await authUser(sess.access_token);
          if (alive) { setUser(u); setAuthChecked(true); }
          return;
        }
      }
      if (alive) { setUser(null); setAuthChecked(true); }
    })();
    return () => { alive = false; };
  }, []);

  const signOut = useCallback(() => {
    saveSession(null);
    setUser(null);
    force((v) => v + 1);
  }, []);

  if (!ready) {
    return <div className="ph-center">加载中...</div>;
  }

  if (view === 'settings') {
    return (
      <div className="ph-root">
        <SettingsForm
          onBack={() => {
            setView('main');
            // 配置可能刚从无到有，重查会话
            if (isSupabaseConfigured()) {
              const sess = loadSession();
              if (sess?.access_token) authUser(sess.access_token).then(setUser);
            }
          }}
        />
      </div>
    );
  }

  if (!isSupabaseConfigured()) {
    return (
      <div className="ph-root">
        <div className="ph-center">
          <Icon name="book" size={28} />
          <div>个人空间未配置</div>
          <div style={{ maxWidth: 280, fontSize: 11 }}>
            填写 Supabase URL 与 anon key 后即可同步你的导航、书签与待办。
          </div>
          <button className="ph-btn-outline" onClick={() => setView('settings')}>
            <Icon name="settings" size={12} /> 配置连接
          </button>
        </div>
      </div>
    );
  }

  if (!authChecked) {
    return <div className="ph-center">加载中...</div>;
  }

  if (!user) {
    return (
      <div className="ph-root">
        <div className="ph-topbar">
          <span className="email">个人空间</span>
          <button className="ph-btn-ghost" title="配置连接" onClick={() => setView('settings')}>
            <Icon name="settings" size={14} />
          </button>
        </div>
        <LoginCard onSignedIn={(u) => setUser(u)} />
      </div>
    );
  }

  return (
    <div className="ph-root">
      <LinksView user={user} onSignOut={signOut} onOpenSettings={() => setView('settings')} />
    </div>
  );
}

/** SettingsForm 持久化入口（避免 store 与面板循环依赖，集中在此注入） */
export async function persistConfig(cfg: Parameters<typeof saveConfig>[0]): Promise<void> {
  await saveConfig(cfg);
}

export { getRawPersonalHubConfig, DEFAULT_SUPABASE_URL, DEFAULT_SUPABASE_ANON_KEY };

