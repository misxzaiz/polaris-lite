/**
 * 核心视图注册表的注入访问器(P2-2):viewRegistry 留在核心(manifest 解析层),
 * 插件布局树查视图定义(title/组件归属)经此只读通道,不 import 宿主实现。
 */
import type { ViewDefinition } from './viewAccessTypes.ts';

let getter: ((viewType: string) => ViewDefinition | undefined) | null = null;
let lister: (() => ViewDefinition[]) | null = null;

export function setViewAccess(get: (v: string) => ViewDefinition | undefined, list: () => ViewDefinition[]): void {
  getter = get;
  lister = list;
}

export function getViewDef(viewType: string): ViewDefinition | undefined {
  return getter?.(viewType);
}

export function listViewDefs(): ViewDefinition[] {
  return lister?.() ?? [];
}

let resolver: ((viewType: string) => unknown) | null = null;

/** 组件解析注入(核心 externalPlugins.getRuntimeComponent 查表;插件不 import 宿主实现) */
export function setViewResolver(fn: (viewType: string) => unknown): void {
  resolver = fn;
}

export function resolveInjectedView(viewType: string): unknown {
  return resolver?.(viewType);
}
