/**
 * 工作区契约聚合（P2-2）：cap.ui.layout 常量留核心（契约串,与 CAP_AUTH 同层）,
 * viewRegistry 是 manifest→组件解析层（与 slotRegistry 平级,留核心）。
 * 布局树实现/store/归属校验已迁 plugins/workspace-layout。
 */
export { CAP_UI_LAYOUT, CAP_UI_LAYOUT_GLOBAL } from './layoutCapConstants';
export { viewRegistry } from './viewRegistry';
export type { ViewRegistry as ViewRegistryClass } from './viewRegistry';
