/**
 * chat-store 插件（UI 半边）：对话会话服务端同步的宿主侧标记。
 *
 * 本插件**不提供任何 UI 与 cap**——它存在的意义：
 * 1. 在插件清单/注册表里占位，使服务端半边（server.mjs）随宿主装配；
 * 2. 会话数据源在 chat-lite 的 store.ts 内直连 /api/chat/sessions*（同源 fetch，
 *    与 ChatInput 调 /api/tool/config 同模式），不经过 cap 总线——会话存取是
 *    chat-lite 的私有数据面，不构成跨插件能力。
 *
 * spec：docs/chat-multi-device-sync-plan.md
 */
import type { LitePlugin } from '@sdk';

export const chatStorePlugin: LitePlugin = {
  manifest: {
    id: 'chat-store',
    name: '会话存储',
    version: '0.1.0',
    capabilities: [],
    provides: [],
    events: [],
    contributes: { slots: [] },
  },
  setup() {
    /* 无 UI 装配；服务端半边由 server-registry.mjs 装配 */
  },
};

export default chatStorePlugin;
