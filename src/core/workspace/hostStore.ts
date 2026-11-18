/**
 * 宿主侧单例：工作区状态仓 + 视图注册表。
 *
 * 单独成文件是为了让 `main.tsx`（启动期同步恢复）与渲染器引用同一份实例，
 * 同时避免渲染器反过来依赖启动代码。
 */
import { WorkspaceStore, createLocalPersistence } from './store.ts';
import { viewRegistry } from './viewRegistry.ts';

export const workspaceStore = new WorkspaceStore({
  persistence: createLocalPersistence(),
  // 插件下线后它的视图类型就不在注册表里了 → 恢复时被折叠掉，而不是留个黑洞
  isAliveViewType: (viewType) => viewRegistry.has(viewType),
  knownViewTypes: () => viewRegistry.types(),
});

export { viewRegistry };
