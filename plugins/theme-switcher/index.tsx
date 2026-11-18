/**
 * theme-switcher 插件：侧栏底部的主题切换控件。
 *
 * 主题本体是宿主能力（hostApi.theme.setMode 写 <html data-theme> 并持久化），
 * 本插件只贡献 UI——这是「一切皆插件」的又一次验证：连主题开关都不是核心的。
 * 宿主令牌（plite-tokens.css）描述浅色/深色两套值，插件 CSS 只消费令牌。
 */
import { useState } from 'react';
import type { LitePlugin, SlotHostApi } from '@sdk';
import './theme.css';

let api: SlotHostApi | null = null;

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="4.2" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M12 3v2.4M12 18.6V21M3 12h2.4M18.6 12H21M5.6 5.6l1.7 1.7M16.7 16.7l1.7 1.7M18.4 5.6l-1.7 1.7M7.3 16.7l-1.7 1.7"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M20 13.2A8.2 8.2 0 0 1 10.8 4a8.4 8.4 0 1 0 9.2 9.2Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ThemeSwitcher() {
  const [mode, setMode] = useState<'light' | 'dark'>(() => api?.theme.mode ?? 'light');

  const choose = (next: 'light' | 'dark') => {
    if (next === mode) return;
    api?.theme.setMode(next);
    setMode(next);
  };

  return (
    <div className="theme-switcher" role="radiogroup" aria-label="界面主题">
      <span className="theme-switcher-label">界面主题</span>
      <div className="theme-switcher-options">
        <button
          type="button"
          role="radio"
          aria-checked={mode === 'light'}
          className={`theme-option ${mode === 'light' ? 'active' : ''}`}
          onClick={() => choose('light')}
        >
          <SunIcon />
          <span>浅色</span>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={mode === 'dark'}
          className={`theme-option ${mode === 'dark' ? 'active' : ''}`}
          onClick={() => choose('dark')}
        >
          <MoonIcon />
          <span>深色</span>
        </button>
      </div>
    </div>
  );
}

export const themeSwitcherPlugin: LitePlugin = {
  manifest: {
    id: 'theme-switcher',
    name: '界面主题',
    version: '0.1.0',
    // 主题是宿主原生 API（非 cap），无需 capabilities/provides；
    // 仅声明槽位贡献，grants.json 登记空授权（unlistedPolicy: declare）
    contributes: {
      slots: [{ slot: 'sidebar', component: 'ThemeSwitcher', order: 90 }],
    },
  },
  setup(hostApi) {
    api = hostApi;
  },
};

export default themeSwitcherPlugin;
