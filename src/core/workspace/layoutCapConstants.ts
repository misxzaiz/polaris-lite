/**
 * cap.ui.layout 契约常量（P2-2 留核心;与 types.ts 的 CAP_AUTH 同层）。
 * 实现侧同名字面量在 plugins/workspace-layout/layoutCap.ts（@sdk 侧同步登记,值一致）。
 */
export const CAP_UI_LAYOUT = 'cap.ui.layout';
/** 二级权限：可重排/关闭**他人**视图、可整体替换布局（预设/透视） */
export const CAP_UI_LAYOUT_GLOBAL = 'cap.ui.layout.global';
