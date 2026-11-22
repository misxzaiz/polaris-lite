/**
 * 布局插件的装配单例(P2-2,迁自 src/core/workspace/hostStore.ts):
 * workspaceStore(树权威)由本插件创建并持有;宿主不再持有布局状态。
 * 视图存活判定经 viewAccess 注入(核心 viewRegistry 查表)——宿主装配时调用
 * configureHostStore() 完成 wiring,时序先于任何 restore()。
 */
import { WorkspaceStore, createLocalPersistence } from './store.ts';
import { getViewDef, listViewDefs } from './viewAccess.ts';

export const workspaceStore = new WorkspaceStore({
  persistence: createLocalPersistence(),
  // 插件下线后它的视图类型就不在注册表里了 → 恢复时被折叠掉，而不是留个黑洞
  isAliveViewType: (viewType) => !!getViewDef(viewType),
  knownViewTypes: () => new Set(listViewDefs().map((v) => v.viewType)),
});
