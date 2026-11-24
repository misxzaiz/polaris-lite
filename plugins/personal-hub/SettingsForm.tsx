/**
 * personal-hub 连接设置表单（lite 形态：Polaris 的设置页项收进本面板）。
 * 字段：supabaseUrl / supabaseAnonKey / encryptionKey（可选，用于描述字段加密）。
 */
import { useState } from 'react';
import { getRawPersonalHubConfig, persistConfig, DEFAULT_SUPABASE_URL, DEFAULT_SUPABASE_ANON_KEY } from './Panel';

export function SettingsForm({ onBack }: { onBack: () => void }) {
  const raw = getRawPersonalHubConfig();
  const [supabaseUrl, setUrl] = useState(raw.supabaseUrl ?? '');
  const [supabaseAnonKey, setKey] = useState(raw.supabaseAnonKey ?? '');
  const [encryptionKey, setEncKey] = useState(raw.encryptionKey ?? '');
  const [msg, setMsg] = useState('');

  const save = async () => {
    await persistConfig({ supabaseUrl, supabaseAnonKey, encryptionKey });
    setMsg('已保存');
    setTimeout(() => setMsg(''), 1500);
  };

  return (
    <div className="ph-root" style={{ overflowY: 'auto' }}>
      <div className="ph-topbar">
        <span className="email">个人空间 · 连接设置</span>
        <button className="ph-btn-ghost" onClick={onBack} aria-label="返回">←</button>
      </div>
      <div className="ph-list">
        <div className="ph-settings">
          <div>
            <label className="ph-label">Supabase URL</label>
            <input className="ph-input" value={supabaseUrl} onChange={(e) => setUrl(e.target.value)}
              placeholder={DEFAULT_SUPABASE_URL} autoComplete="off" />
          </div>
          <div>
            <label className="ph-label">Supabase anon key</label>
            <input className="ph-input" value={supabaseAnonKey} onChange={(e) => setKey(e.target.value)}
              placeholder={DEFAULT_SUPABASE_ANON_KEY.slice(0, 24) + '…'} autoComplete="off" />
          </div>
          <div>
            <label className="ph-label">加密密钥（可选）</label>
            <div className="ph-keyrow">
              <input className="ph-input" value={encryptionKey} onChange={(e) => setEncKey(e.target.value)}
                placeholder="留空则不加密；填写后可勾选加密描述" autoComplete="off" />
            </div>
            <div className="note" style={{ marginTop: 4 }}>
              与 Polaris 桌面端通用：同一把密钥即可互认彼此加密的描述字段。换新密钥不会解密旧密文。
            </div>
          </div>
          <div className="ph-row ph-gap2">
            <button className="ph-btn-primary" onClick={() => void save()}>保存</button>
            {msg && <span style={{ fontSize: 11, color: 'var(--plite-success)' }}>{msg}</span>}
          </div>
          <div className="note">
            连接参数保存在本机（cap.config → localStorage）；链接数据在 Supabase 云端，跨设备共享。
          </div>
        </div>
      </div>
    </div>
  );
}
