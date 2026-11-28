/**
 * media-push 插件 UI 半边：AI 推送任意文件到对话（八 kind 卡片 + 伪全屏 + 卡内交互）。
 *
 * 职责（对齐 image-push 的产物插件分工）：
 * - 渲染器登记：CHANNEL_ARTIFACT_RENDERERS(@sdk)['media'] = MediaCard
 *   （chat-lite 块渲染查表，本插件不进 chat-lite 源码）；
 * - 产物型工具名登记：push_media 产生的 artifact 让过程块组保持平铺。
 *
 * 服务端半边在 server.mjs（/api/media/* + push_media 工具），双入口由
 * server-registry 登记；工具声明在 tool.mjs（服务端适配器注册表）。
 */
import { CHANNEL_ARTIFACT_RENDERERS, CHANNEL_ARTIFACT_TOOL_NAMES, type LitePlugin, type SlotHostApi } from '@sdk';
import { MediaCard } from './MediaCard';
import './media-push.css';

export const mediaPushPlugin: LitePlugin = {
  manifest: {
    id: 'media-push',
    name: '媒体推送',
    version: '0.1.0',
    capabilities: [],
    provides: [],
    events: [],
    contributes: { slots: [] },
  },
  setup(api: SlotHostApi) {
    void api;
    // artifact 渲染器登记（chat-lite BlockGroup 查表渲染；渲染器自带样式与组件）
    const w = window as unknown as Record<string, unknown>;
    const registry = (w[CHANNEL_ARTIFACT_RENDERERS] ?? {}) as Record<string, unknown>;
    registry['media'] = MediaCard;
    w[CHANNEL_ARTIFACT_RENDERERS] = registry;
    // 产物型工具名登记：push_media 产生的 artifact 让过程块组保持平铺
    const names = (w[CHANNEL_ARTIFACT_TOOL_NAMES] instanceof Set ? w[CHANNEL_ARTIFACT_TOOL_NAMES] : new Set()) as Set<string>;
    names.add('push_media');
    w[CHANNEL_ARTIFACT_TOOL_NAMES] = names;
  },
};

export { MediaCard };

export default mediaPushPlugin;
