/**
 * vision 插件 UI 半边：纯工具型（look 工具在服务端 tool.mjs 注册），
 * 前端无渲染器、无面板——识别结果是纯文本直接回模型，不产 artifact。
 * 此入口仅为满足插件构建产物约定（dist/index.js）。
 */
import type { LitePlugin, SlotHostApi } from '@sdk';

export const visionPlugin: LitePlugin = {
  manifest: {
    id: 'vision',
    name: '图片识别',
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

export default visionPlugin;
