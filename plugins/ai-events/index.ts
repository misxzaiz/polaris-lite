/**
 * ai-events 插件：对话轮次取证。
 *
 * 只旁听、不改对话行为：
 * - 订阅 `cap.agent.loop:event`（编排全链路：工具卡/审批/结果/跳数）与
 *   `cap.ai.chat:event`（无编排的直连模式兜底）；
 * - 按 `(sessionId, assistantMessageId)` 聚合为一条 TurnRecord，结束后落 IndexedDB；
 * - 面板只读展示与导出，不写 chat-lite 的任何状态，也不接管审批 UI。
 *
 * 缺口（面板上有对应提示，不掩饰）：
 * - 用户输入原文不经过事件通道（chat-lite 不发事件），只能靠会话尾号辨认轮次；
 * - provider / model / token 不在现有事件里，需要引擎侧补字段（另一期）。
 */
import type { LitePlugin } from '@sdk';
import { TimelinePanel } from './Panel';
import { ingest, startWatchdog } from './turnStore';
import './ai-events.css';

export const aiEventsPlugin: LitePlugin = {
  manifest: {
    id: 'ai-events',
    name: '对话事件',
    version: '0.1.0',
    capabilities: [],
    provides: [],
    // listen 是 fail-closed：这两个事件名必须同时出现在 manifest 与 grants.json
    events: ['cap.agent.loop:event', 'cap.ai.chat:event'],
    contributes: {
      // panel 的 order 2/3/6 已被模型/Bash/文件占用；4 字以内否则 tab 会截断
      slots: [{ slot: 'panel', component: 'TimelinePanel', order: 7, title: '事件' }],
    },
  },
  setup(api) {
    api.listen('cap.agent.loop:event', ingest);
    api.listen('cap.ai.chat:event', ingest);
    // 孤儿兜底常驻：插件不卸载，所以不需要保存清理句柄
    startWatchdog();
  },
};

export { TimelinePanel };

export default aiEventsPlugin;
