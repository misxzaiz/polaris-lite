/**
 * 宿主注入点(P2-2):布局树深处需要的锚点渲染/品牌渲染回调。
 * 核心在 layout-root 容器装配时经 LayoutRootProps 注入;插件不认识 SlotOutlet/Brand。
 */
import type { ReactNode } from 'react';
import type { AnchorId } from '../sdk/schema.ts';

export type AnchorRenderer = (anchor: AnchorId) => ReactNode;

export interface LayoutDeps {
  renderAnchor: AnchorRenderer;
  renderBrand: () => ReactNode;
}

let deps: LayoutDeps | null = null;

/** 由 WorkspaceTree 顶层组件装配时写入(核心单实例,先于任何叶子渲染) */
export function setLayoutDeps(d: LayoutDeps): void {
  deps = d;
}

/** 深处叶子取用;未注入时给出可诊断的占位(不静默白屏) */
export function renderAnchor(anchor: AnchorId): ReactNode {
  if (!deps) return <div data-missing="layout-deps">布局注入缺失：{anchor}</div>;
  return deps.renderAnchor(anchor);
}

export function renderBrand(): ReactNode {
  if (!deps) return null;
  return deps.renderBrand();
}
