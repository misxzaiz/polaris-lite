/**
 * video-gen 插件 UI 半边：纯工具型（video 工具在服务端 tool.mjs 注册），
 * 视频卡片由 media-push 的 MediaCard 渲染（rendererType=media, kind=video）。
 */
import type { LitePlugin, SlotHostApi } from '@sdk';

export const videoGenPlugin: LitePlugin = {
  manifest: {
    id: 'video-gen',
    name: '视频生成',
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

export default videoGenPlugin;
