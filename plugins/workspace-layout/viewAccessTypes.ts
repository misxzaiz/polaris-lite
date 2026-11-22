/** 视图定义的最小形状(与核心 viewRegistry 的 ViewDefinition 同构;插件不 import 宿主实现) */
export interface ViewDefinition {
  viewType: string;
  pluginId: string;
  component: string;
  title: string;
  defaultAnchor?: import('../sdk/schema.ts').AnchorId;
}

/** 布局能力消费的最小注册表接口(核心 viewRegistry 满足它) */
export interface ViewRegistry {
  get(viewType: string): ViewDefinition | undefined;
  list(): ViewDefinition[];
  types(): Set<string>;
  has(viewType: string): boolean;
}
