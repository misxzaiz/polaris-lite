/**
 * image-push 插件 UI 半边：AI 推送电脑图片到对话（图片卡 + 可缩放查看器）。
 *
 * 职责（对齐 html-preview 的产物插件分工）：
 * - 渲染器登记：CHANNEL_ARTIFACT_RENDERERS(@sdk)['image'] = ImageCard
 *   （chat-lite 块渲染查表，本插件不进 chat-lite 源码）；
 * - 产物型工具名登记：push_image 产生的 artifact 让过程块组保持平铺。
 *
 * 服务端半边在 server.mjs（/api/img/* + push_image 工具），双入口由
 * server-registry 登记；工具声明在 tool.mjs（服务端适配器注册表）。
 */
import { CHANNEL_ARTIFACT_RENDERERS, CHANNEL_ARTIFACT_TOOL_NAMES, type LitePlugin, type SlotHostApi } from '@sdk';
import { ImageCard } from './ImageCard';
import './image-push.css';

export const imagePushPlugin: LitePlugin = {
  manifest: {
    id: 'image-push',
    name: '图片推送',
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
    registry['image'] = ImageCard;
    w[CHANNEL_ARTIFACT_RENDERERS] = registry;
    // 产物型工具名登记：push_image 产生的 artifact 让过程块组保持平铺
    const names = (w[CHANNEL_ARTIFACT_TOOL_NAMES] instanceof Set ? w[CHANNEL_ARTIFACT_TOOL_NAMES] : new Set()) as Set<string>;
    names.add('push_image');
    w[CHANNEL_ARTIFACT_TOOL_NAMES] = names;
  },
};

export { ImageCard };

export default imagePushPlugin;
