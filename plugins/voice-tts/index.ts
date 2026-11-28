/**
 * voice-tts 插件 UI 半边：纯工具型（speak 工具在服务端 tool.mjs 注册），
 * 音频卡片由 media-push 的 MediaCard 渲染（rendererType=media, kind=audio），
 * 本插件前端无自带组件。此入口仅为满足插件构建产物约定（dist/index.js）。
 */
import type { LitePlugin, SlotHostApi } from '@sdk';

export const voiceTtsPlugin: LitePlugin = {
  manifest: {
    id: 'voice-tts',
    name: '语音合成',
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

export default voiceTtsPlugin;
