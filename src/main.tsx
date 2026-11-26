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
import { installAiEngineInfrastructure } from '@/core/aiEngine';
import { viewRegistry } from '@/core/workspace/viewRegistry';
import { pushNotice } from '@/core/shellState';
import { getRuntimeComponent, loadExternalPlugins } from '@/core/externalPlugins';
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

  // react-dom 同理：插件经 import map 的 shim 取 createPortal 时必须与宿主同一实例，
  // 否则 portal 出来的子树与主应用不共享 reconciler（hooks 失效、点击无响应）。
  const reactDomMod = await import('react-dom');
  (window as unknown as Record<string, unknown>).__POLARIS_LITE_REACT_DOM__ =
    (reactDomMod as unknown as { default?: unknown }).default ?? reactDomMod;

  // react-dom/client 的 createRoot/hydrateRoot 一并暴露：shim 在 dev 下拉不到
  // /node_modules/.vite/deps/react-dom_client.js（dev server 对它做 SPA HTML fallback），
  // 插件自挂 UI（如 notification-center 的 toast host）依赖它。
  (window as unknown as Record<string, unknown>).__POLARIS_LITE_REACT_DOM_CLIENT__ =
    await import('react-dom/client');

  // 1. 安装核心内建能力（meta 是核心自有 cap；布局能力已随 workspace-layout 插件走,P2-2）
  //    meta 传入视图/槽位注册表：describe 返回 views 与 slots 清单（自省型面板的免授权数据源）
  installMetaCapability(host.bus, () => host.policyTable(), viewRegistry, host.slots);
  //    AI 引擎注册表 + 通用分派器同样是核心协议设施：消费方只认 cap.ai.chat，
  //    分派器按 payload.engineId 路由到各引擎插件注册的 cap.ai.chat.<id>。
  //    插件 setup 还没跑，故这里传延迟求值函数，自省时再读 manifest。
  installAiEngineInfrastructure(host.bus, () => host.getPluginIds().map((id) => host.getManifest(id)));

  // 2. 外部注册：registry 决定「装哪些」，grants 决定「能干什么」（发现失败不阻断壳渲染）
  //    workspace-layout 插件的 setup 注册 cap.ui.layout；restore/prune 在其 LayoutRoot
    //    容器 wiring 时进行（SlotLayout 渲染前,插件已全部装配完,时序等价旧流程）。
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

  // 3. 插件装配健康位：布局插件的孤儿视图折叠依赖它（加载失败必须跳过 prune,
  //    否则失败插件的「未注册视图」会被判死并落盘——用户修好插件也回不来了）。
  host.setPluginLoadHealth(failed.length === 0);

  // 3.5 layout-root 容器 wiring（P2-2 必修包修4）:在渲染前、全部插件 setup 后调用。
  //    此前放在 SlotLayout 渲染体内（wiredRef 锁存,setup 被静默跳过时无重试无告警）——
  //    移到装配链后时序确定,且 wire 缺失（容器声明了但 setup 未挂通道）可以当众报出。
  //    通道名 = @sdk CHANNEL_LAYOUT_WIRE,宿主侧就地字面量对齐（arch 门禁:核心不 import 插件）。
  {
    const container = host.slots.resolveContainer('layout-root');
    if (container) {
      const wire = (window as unknown as Record<string, unknown>)['__PLITE_LAYOUT_WIRE__'] as
        | ((args: unknown) => void)
        | undefined;
      if (typeof wire === 'function') {
        wire({
          registerView: (def: { viewType: string; pluginId: string; component: string; title: string; defaultAnchor?: 'sidebar' | 'stream' | 'input' | 'panel' }) =>
            viewRegistry.register(def),
          getView: (viewType: string) => viewRegistry.get(viewType),
          listViews: () => viewRegistry.list(),
          resolveComponent: (viewType: string) => {
            const def = viewRegistry.get(viewType);
            return def ? getRuntimeComponent(def.pluginId, def.component) : undefined;
          },
          pluginsFailed: !host.isPluginLoadHealthy,
        });
      } else {
        showBootNotice('布局容器异常', [
          `${container.pluginId} 声明了 layout-root 容器但 setup 未挂载 wiring 通道——本次启动回退固定四槽`,
        ]);
      }
    }
  }

  // 4. 渲染壳层（布局主体委托 layout-root 容器;无插件时回退固定四槽）
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
