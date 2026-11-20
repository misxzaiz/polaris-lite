/**
 * 外部插件加载器（宿主与插件完全解耦的关键）。
 *
 * 启动流程分三阶段（顺序即正确性）：
 * 1. **导入**：fetch registry.json 与 grants.json → 逐个动态 import 插件模块 →
 *    解析有效权限（manifest ∩ grants）→ 登记组件。**不执行 setup**。
 * 2. **排序**：按 manifest.requires 做拓扑排序，让「能力提供方」先于「消费者」装配。
 *    此前顺序靠 build-plugins.mjs 里的 order 注释维持（real-engine 必须先于 mock-engine），
 *    一旦增删插件就会静默错序；现在由声明驱动，缺失依赖会在启动告警里点名。
 * 3. **装配**：按序 registerPlugin（此时才跑 setup）。
 *
 * 宿主源码不 import 任何插件；插件只能看到 @sdk 契约与运行时注入的 SlotHostApi。
 */
import type { ComponentType } from 'react';
import type { LitePlugin } from '../core/types';
import { loadGrants, resolvePolicy, type EffectivePolicy } from './policy';

export interface ExternalPluginEntry {
  id: string;
  /** 插件 bundle 的 URL（相对宿主根） */
  module: string;
  /**
   * 插件的 CSS 产物 URL（相对宿主根）。由构建脚本按「dist 里是否真有 style.css」写入：
   * 有才登记，没有就不登记。宿主据此决定是否注入 <link>——
   * 以前是无条件按约定拼出 style.css 路径，让没有样式的插件吃一个 404 再靠 onerror 移除节点。
   */
  style?: string;
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
  /** 授权/依赖相关告警（未登记插件、被收紧的权限、缺失依赖），由调用方在 UI 暴露 */
  policyWarnings: string[];
}

interface StagedPlugin {
  plugin: LitePlugin;
  policy: EffectivePolicy;
}

/** 加载注册表里的全部启用插件并注册进宿主 runtime（权限按 grants.json 收紧） */
export async function loadExternalPlugins(
  registryUrl: string,
  grantsUrl: string,
  register: (plugin: LitePlugin, policy: EffectivePolicy) => Promise<void>,
): Promise<LoadResult> {
  installImportMap();

  // 注册表本身拉不到时**不要抛**：抛出去会让 bootstrap 在 createRoot 之前中断，
  // 用户得到一整页纯白，而恰恰此时最需要「壳还在、告警可见、能重试」。
  // 返回一个 failed 项即可——调用方会显示告警条，并跳过孤儿视图折叠。
  let registry: PluginRegistryFile;
  try {
    // no-store：registry/module URL 携带产物 hash 版本号，缓存语义必须「每次校验源」——
    // 否则浏览器磁盘缓存启发式会吃掉旧 registry（module URL 不更新），改版后表现为「改了没生效」
    const res = await fetch(registryUrl, { cache: 'no-store' });
    if (!res.ok) throw new Error(`plugin registry fetch failed: ${res.status}`);
    registry = (await res.json()) as PluginRegistryFile;
  } catch (err) {
    return {
      loaded: [],
      failed: [{ id: 'registry', error: err instanceof Error ? err.message : String(err) }],
      policyWarnings: [],
    };
  }
  // 授权表拉取失败 → 走 unlisted 兜底（按 manifest 放行并告警），不 brick 应用
  const grants = await loadGrants(grantsUrl);

  const loaded: string[] = [];
  const failed: { id: string; error: string }[] = [];
  const policyWarnings: string[] = [];
  if (!grants) policyWarnings.push(`授权表 ${grantsUrl} 不可用：插件权限按 manifest 自声明放行`);

  // ---------- 阶段 1：导入 + 权限解析（不执行 setup） ----------
  const staged: StagedPlugin[] = [];
  for (const entry of registry.plugins ?? []) {
    if (entry.enabled === false) continue;
    try {
      const url = new URL(entry.module, window.location.origin).href;
      // 插件若有独立 CSS 产物（vite lib 模式会拆出 style.css），构建脚本会在 plugin.json 里
      // 登记 style 字段；没登记就说明没有样式，不再盲拼地址吃 404。
      const cssUrl = entry.style ? new URL(entry.style, window.location.origin).href : null;
      if (cssUrl && !document.querySelector(`link[data-plugin-css="${entry.id}"]`)) {
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
      const policy = resolvePolicy(plugin.manifest, grants);
      if (!policy.listed) {
        policyWarnings.push(`插件 ${plugin.manifest.id} 未在 grants.json 登记，已按 manifest 自声明放行`);
      }
      if (policy.denied.length > 0) {
        policyWarnings.push(
          `插件 ${policy.pluginId} 有 ${policy.denied.length} 项权限未被授权：${policy.denied
            .map((d) => `${d.field}/${d.item}`)
            .join('、')}`,
        );
      }
      collectComponents(plugin.manifest.id, mod);
      staged.push({ plugin, policy });
    } catch (err) {
      failed.push({ id: entry.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // ---------- 阶段 2：按 requires 拓扑排序（提供方先装配） ----------
  const providerOf = new Map<string, string>();
  for (const s of staged) {
    for (const cap of s.policy.provides) providerOf.set(cap, s.plugin.manifest.id);
  }
  const byId = new Map(staged.map((s) => [s.plugin.manifest.id, s]));
  const state = new Map<string, 'visiting' | 'done'>();
  const ordered: StagedPlugin[] = [];

  const visit = (s: StagedPlugin): void => {
    const id = s.plugin.manifest.id;
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') {
      policyWarnings.push(`插件 ${id} 存在循环依赖（requires），已按当前顺序装配`);
      return;
    }
    state.set(id, 'visiting');
    for (const cap of s.plugin.manifest.requires ?? []) {
      const pid = providerOf.get(cap);
      if (!pid) {
        policyWarnings.push(`插件 ${id} 依赖的能力 ${cap} 无任何已加载插件提供`);
        continue;
      }
      const dep = byId.get(pid);
      if (dep && dep !== s) visit(dep);
    }
    state.set(id, 'done');
    ordered.push(s);
  };
  for (const s of staged) visit(s);

  // ---------- 阶段 3：按序装配（此处才执行 setup） ----------
  for (const s of ordered) {
    try {
      await register(s.plugin, s.policy);
      loaded.push(s.plugin.manifest.id);
    } catch (err) {
      failed.push({ id: s.plugin.manifest.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { loaded, failed, policyWarnings };
}
