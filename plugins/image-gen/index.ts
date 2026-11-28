/**
 * image-gen 插件 UI 半边：纯工具型（draw 工具在服务端 tool.mjs 注册），
 * 图片卡片由 media-push 的 MediaCard 渲染（rendererType=media, kind=image）。
 */
import type { LitePlugin, SlotHostApi } from '@sdk';

export const imageGenPlugin: LitePlugin = {
  manifest: {
    id: 'image-gen',
    name: '图片生成',
    version: '0.1.0',
    capabilities: [],
    provides: [],
    events: [],
    contributes: { slots: [] },
  },
  setup(api: SlotHostApi) {
    void api;
  },
};

export default imageGenPlugin;
