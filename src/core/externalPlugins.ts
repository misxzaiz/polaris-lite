/**
 * 外部插件加载器（宿主与插件完全解耦的关键）。
 *
 * 宿主源码不 import 任何插件；启动时：
 * 1. fetch /plugins/registry.json（外部插件清单，由 build-plugins 脚本生成，可手工增删）；
 * 2. 注入 import map（react/react-dom 指向宿主已加载模块，插件 bundle 以裸 import 引用）；
 * 3. 动态 import() 每个插件的 plugin.js，拿到 LitePlugin 形态后交宿主 runtime 注册。
 */
import type { ComponentType } from 'react';
import type { LitePlugin } from '../core/types';

export interface ExternalPluginEntry {
  id: string;
  /** 插件 bundle 的 URL（相对宿主根） */
  module: string;
  /** 是否启用 */
  enabled?: boolean;
}

export interface PluginRegistryFile {
  plugins: ExternalPluginEntry[];
}

/** 运行时组件注册表：外部插件挂载后按 (pluginId, componentName) 登记组件 */
const runtimeComponents = new Map<string, Map<string, ComponentType>>();

export function registerPluginComponent(pluginId: string, name: string, comp: ComponentType): void {
  if (!runtimeComponents.has(pluginId)) runtimeComponents.set(pluginId, new Map());
  runtimeComponents.get(pluginId)!.set(name, comp);
}

export function getRuntimeComponent(pluginId: string, name: string): ComponentType | undefined {
  return runtimeComponents.get(pluginId)?.get(name);
}

/** 从插件模块提取组件并登记：插件除聚合导出外，所有 PascalCase 命名导出的
 * 函数/组件也自动登记（约定组件名即 SlotDescriptor.component 名） */
function collectComponents(pluginId: string, mod: Record<string, unknown>): void {
  const sources: Record<string, unknown>[] = [];
  for (const key of ['components', 'chatComponents', 'panelComponents', 'pluginComponents']) {
    const agg = mod[key];
    if (agg && typeof agg === 'object') sources.push(agg as Record<string, unknown>);
  }
  // 单个命名导出本身是组件（函数/forwardRef 对象）时直接登记
  for (const [name, value] of Object.entries(mod)) {
    if (typeof value === 'function' || (value && typeof value === 'object' && '$$typeof' in (value as object))) {
      sources.push({ [name]: value });
    }
  }
  for (const comps of sources) {
    for (const [name, comp] of Object.entries(comps)) {
      if (typeof comp === 'function' || (comp && typeof comp === 'object' && '$$typeof' in (comp as object))) {
        registerPluginComponent(pluginId, name, comp as ComponentType);
      }
    }
  }
}

/** 注入 import map：插件 bundle 的裸 import（react 等）由宿主同源 ESM shim 解析。
 * vite 预打包的 react.js 只有 default 导出，插件 bundle 需要命名导出，
 * 故指向 plugins/esm-shim.mjs（重新导出命名成员）。
 */
function installImportMap(): void {
  const existing = document.querySelector('script[type="importmap"]');
  if (existing) return; // 只注入一次
  const importMap = {
    imports: {
      react: '/plugins/esm-shim.mjs',
      'react-dom': '/plugins/esm-shim.mjs',
      'react-dom/client': '/plugins/esm-shim.mjs',
    },
  };
  const script = document.createElement('script');
  script.type = 'importmap';
  script.textContent = JSON.stringify(importMap);
  document.head.appendChild(script);
}

export interface LoadResult {
  loaded: string[];
  failed: { id: string; error: string }[];
}

/** 加载注册表里的全部启用插件并注册进宿主 runtime */
export async function loadExternalPlugins(
  registryUrl: string,
  register: (plugin: LitePlugin) => Promise<void>,
): Promise<LoadResult> {
  installImportMap();

  const res = await fetch(registryUrl);
  if (!res.ok) throw new Error(`plugin registry fetch failed: ${res.status}`);
  const registry = (await res.json()) as PluginRegistryFile;

  const loaded: string[] = [];
  const failed: { id: string; error: string }[] = [];

  for (const entry of registry.plugins ?? []) {
    if (entry.enabled === false) continue;
    try {
      const url = new URL(entry.module, window.location.origin).href;
      // 插件若有独立 CSS 产物（vite lib 模式会拆出 style.css），按约定注入 link
      const cssUrl = url.replace(/plugin\.js$/, 'style.css');
      if (!document.querySelector(`link[data-plugin-css="${entry.id}"]`)) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.dataset.pluginCss = entry.id;
        link.href = cssUrl;
        document.head.appendChild(link);
      }
      const mod = (await import(/* @vite-ignore */ url)) as Record<string, unknown>;
      const plugin = (mod.default ?? mod.plugin) as LitePlugin | undefined;
      if (!plugin?.manifest) {
        failed.push({ id: entry.id, error: 'module has no default plugin export' });
        continue;
      }
      collectComponents(plugin.manifest.id, mod);
      await register(plugin);
      loaded.push(plugin.manifest.id);
    } catch (err) {
      failed.push({ id: entry.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { loaded, failed };
}
