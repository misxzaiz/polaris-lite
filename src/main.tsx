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
import { installLayoutCapability } from '@/core/workspace/layoutCap';
import { registerHostSlotViews } from '@/core/workspace/hostViews';
import { workspaceStore, viewRegistry } from '@/core/workspace/hostStore';
import { pushNotice } from '@/core/shellState';
import { loadExternalPlugins } from '@/core/externalPlugins';
import '@/plite-tokens.css';
import '@/styles.css';

/** 可见的启动告警（渲染在壳层第一行；仅 console 会让「插件没装成功」变成静默故障） */
function showBootNotice(title: string, lines: string[]): void {
  pushNotice(title, lines);
}

async function bootstrap(): Promise<void> {
  // 关键：把主应用的 React 实例暴露给插件 ESM shim（插件 bundle 的 "react" 裸导入
  // 经 import map 解析到 plugins/esm-shim.mjs，必须与主应用同一实例，否则插件组件
  // hooks 全部失效、渲染为空）。
  (window as unknown as Record<string, unknown>).__POLARIS_LITE_REACT__ = (
    await import('react')
  ).default ?? (window as unknown as Record<string, unknown>).__POLARIS_LITE_REACT__;

  // 1. 安装核心内建能力（meta 与 layout 都是核心自有 cap，不属于任何业务插件）
  installMetaCapability(host.bus, () => host.policyTable());
  // 布局能力走总线：授权、归属校验、审计都复用既有机制，不开第二写通道
  installLayoutCapability(host.bus, { store: workspaceStore, registry: viewRegistry });
  // 宿主槽位视图（host.slot.<anchor>）：把四个锚点原有的槽位内容变成可被布局树引用的视图，
  // 否则预设一旦给锚点写了 children，面板里的槽位面板就整片消失。必须在 restore 之前注册。
  registerHostSlotViews();

  // 2. 先恢复工作区布局，再加载插件——顺序不能反。
  //    插件在 setup() 里就会调 cap.ui.layout 装配自己的视图；若 restore 放在插件之后，
  //    restore 会整体替换树，把这些「刚打开」的视图全部抹掉（表现为 open 返回 ok 但界面没有）。
  //    此阶段只做「读 + 校验」，折叠死视图留给插件加载后的 pruneDeadViews()。
  workspaceStore.restore();

  // 3. 外部注册：registry 决定「装哪些」，grants 决定「能干什么」（发现失败不阻断壳渲染）
  const { loaded, failed, policyWarnings } = await loadExternalPlugins(
    '/plugins/registry.json',
    '/grants.json',
    (plugin, policy) => host.registerPlugin(plugin, policy),
  );
  if (failed.length) {
    console.warn('[polaris-lite] some plugins failed to load:', failed);
    showBootNotice('插件加载失败', failed.map((f) => `${f.id}（${f.error}）`));
  }
  const allWarnings = [...policyWarnings, ...host.getViewWarnings()];
  if (allWarnings.length) {
    console.warn('[polaris-lite] policy warnings:', allWarnings);
    showBootNotice('权限告警', allWarnings);
  }
  console.info(`[polaris-lite] ${loaded.length} external plugin(s) loaded:`, loaded);

  // 4. 视图注册表已齐 → 折叠孤儿视图（插件下线/禁用后留下的空洞）。
  //    但有插件加载失败时**必须跳过**：那些插件的视图此刻只是「未注册」，
  //    prune 会把它们判成死视图删掉并立刻落盘——用户修好插件也回不来了。
  if (failed.length === 0) {
    workspaceStore.pruneDeadViews();
  } else {
    console.warn('[polaris-lite] 有插件加载失败，跳过孤儿视图折叠，避免误删它们的布局位');
  }

  // 5. 渲染壳层（内部按工作区树渲染四个锚点）
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <SlotLayout />
    </StrictMode>,
  );
}

/**
 * 装配链失败时的兜底界面。
 * 只 console.error 是不够的：用户看到的是一整页纯白，连「出了什么问题」都不知道，
 * 也无法重试。这里用纯 DOM + 内联样式渲染（不依赖 React 与 CSS 是否加载成功）。
 */
function renderBootFailure(err: unknown): void {
  const root = document.getElementById('root');
  if (!root) return;
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  root.textContent = '';

  const box = document.createElement('div');
  box.setAttribute('role', 'alert');
  box.style.cssText = [
    'min-height:100vh',
    'display:flex',
    'flex-direction:column',
    'align-items:center',
    'justify-content:center',
    'gap:14px',
    'padding:32px',
    'box-sizing:border-box',
    'font-family:system-ui,-apple-system,Segoe UI,sans-serif',
    'background:#fff',
    'color:#1a1a1a',
    'text-align:center',
  ].join(';');

  const title = document.createElement('div');
  title.textContent = '应用启动失败';
  title.style.cssText = 'font-size:17px;font-weight:600;letter-spacing:0.02em';

  const detail = document.createElement('div');
  detail.textContent = message;
  detail.style.cssText = 'font-size:13px;line-height:1.6;color:#666;max-width:560px;word-break:break-word';

  const retry = document.createElement('button');
  retry.type = 'button';
  retry.textContent = '重新加载';
  retry.style.cssText =
    'margin-top:6px;padding:8px 18px;border:1px solid #d8d8d8;border-radius:8px;background:#fff;color:#1a1a1a;font-size:13px;cursor:pointer';
  retry.addEventListener('click', () => window.location.reload());

  box.append(title, detail, retry);
  root.appendChild(box);
}

void bootstrap().catch((err) => {
  // 装配链任何一步失败都不能静默——否则 UI 空白且无日志（验收教训）
  console.error('[polaris-lite] bootstrap failed:', err);
  renderBootFailure(err);
});
