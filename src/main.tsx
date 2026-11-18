/**
 * polaris-lite 启动装配：安装核心能力 → 加载授权表 → 从外部注册表加载插件 → 渲染四槽布局。
 *
 * 宿主与插件完全解耦：本文件不 import 任何插件源码；插件由 /plugins/registry.json
 * 声明、权限由 /grants.json 收紧，运行时动态加载（见 core/externalPlugins.ts、core/policy.ts）。
 * 新增/下线插件只改注册表与插件包，宿主代码零改动；调整权限只改授权表。
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { host } from '@/core/hostRuntime';
import { SlotLayout } from '@/core/SlotLayout';
import { installMetaCapability } from '@/core/metaCapability';
import { loadExternalPlugins } from '@/core/externalPlugins';
import '@/plite-tokens.css';
import '@/styles.css';

/** 可见的启动告警条（仅 console 会让「插件没装成功」变成静默故障） */
function showBootNotice(title: string, lines: string[]): void {
  if (lines.length === 0) return;
  const box = document.createElement('div');
  box.className = 'plite-load-warning';
  box.textContent = `${title}：${lines.join('；')}`;
  document.body.appendChild(box);
}

async function bootstrap(): Promise<void> {
  // 关键：把主应用的 React 实例暴露给插件 ESM shim（插件 bundle 的 "react" 裸导入
  // 经 import map 解析到 plugins/esm-shim.mjs，必须与主应用同一实例，否则插件组件
  // hooks 全部失效、渲染为空）。
  (window as unknown as Record<string, unknown>).__POLARIS_LITE_REACT__ = (
    await import('react')
  ).default ?? (window as unknown as Record<string, unknown>).__POLARIS_LITE_REACT__;

  // 1. 安装核心内建能力（meta 是核心自有 cap，不属于任何业务插件）
  installMetaCapability(host.bus, () => host.policyTable());

  // 2. 外部注册：registry 决定「装哪些」，grants 决定「能干什么」（发现失败不阻断壳渲染）
  const { loaded, failed, policyWarnings } = await loadExternalPlugins(
    '/plugins/registry.json',
    '/grants.json',
    (plugin, policy) => host.registerPlugin(plugin, policy),
  );
  if (failed.length) {
    console.warn('[polaris-lite] some plugins failed to load:', failed);
    showBootNotice('插件加载失败', failed.map((f) => `${f.id}（${f.error}）`));
  }
  if (policyWarnings.length) {
    console.warn('[polaris-lite] policy warnings:', policyWarnings);
    showBootNotice('权限告警', policyWarnings);
  }
  console.info(`[polaris-lite] ${loaded.length} external plugin(s) loaded:`, loaded);

  // 3. 渲染四槽布局壳
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <SlotLayout />
    </StrictMode>,
  );
}

void bootstrap().catch((err) => {
  // 装配链任何一步失败都不能静默——否则 UI 空白且无日志（验收教训）
  console.error('[polaris-lite] bootstrap failed:', err);
});
