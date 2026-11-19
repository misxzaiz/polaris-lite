/**
 * ai-events 插件：对话取证。
 *
 * 两条互补的取证线：
 * 1. 轮次（事件旁听）：`cap.agent.loop:event` / `cap.ai.chat:event` → 每轮一条
 *    TurnRecord（跳数、工具、审批、耗时）。
 * 2. 请求（fetch 拦截）：拦住同源 `/api/*`，留住模型收到的 messages/tools/参数
 *    与上游返回的 SSE 原文，可一键复制 curl 复现。
 *
 * 只读：不写 chat-lite 的任何状态，不接管审批 UI，不改变请求行为。
 *
 * 已知边界（面板上有说明，不掩饰）：
 * - 用户输入原文不经过事件通道，只能靠轮次次序辨认；
 * - 上游 API Key 只在服务端，curl 里用 $API_KEY 占位。
 */
import type { LitePlugin } from '@sdk';
import { installNetTap } from './netTap';
import { TimelinePanel } from './Panel';
import { ingest, startWatchdog } from './turnStore';
import './ai-events.css';

export const aiEventsPlugin: LitePlugin = {
  manifest: {
    id: 'ai-events',
    name: '对话取证',
    version: '0.2.0',
    capabilities: [],
    provides: [],
    // listen 是 fail-closed：这两个事件名必须同时出现在 manifest 与 grants.json
    events: ['cap.agent.loop:event', 'cap.ai.chat:event'],
    contributes: {
      // panel 的 order 2/3/6 已被模型/Bash/文件占用；4 字以内否则 tab 会截断
      slots: [{ slot: 'panel', component: 'TimelinePanel', order: 7, title: '取证' }],
    },
  },
  setup(api) {
    api.listen('cap.agent.loop:event', ingest);
    api.listen('cap.ai.chat:event', ingest);
    // 孤儿兜底常驻：插件不卸载，所以不需要保存清理句柄
    startWatchdog();
    // 网络取证：只包一层 fetch，不阻断、不改变任何调用行为
    installNetTap();
  },
};

export { TimelinePanel };

export default aiEventsPlugin;
