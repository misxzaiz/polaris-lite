/**
 * app-updater 插件的 AI 工具声明（open_panel）：把面板内嵌进 AI 对话。
 *
 * 动机（2026-11-29 用户需求）：AI 对话中直接展示可操作的面板（如版本面板），
 * 而不是让用户自己去右侧面板区找。实现走现成的 artifact 通道：
 * 工具 emit `artifact.created`（rendererType=viewType）→ chat-lite 的 ArtifactSlot
 * 按 CHANNEL_ARTIFACT_RENDERERS 注册表取组件 → 面板本体渲染在消息流里。
 *
 * 面板组件是否可内嵌由**前端**决定：插件在 setup 时把面板组件注册进
 * CHANNEL_ARTIFACT_RENDERERS（见 index.tsx）。本工具只负责 emit 事件，
 * 若目标面板没注册内嵌渲染器，ArtifactSlot 会渲染兜底提示（不崩不空白）。
 * 因此 SUPPORTED 里只放已确认注册了内嵌渲染器的面板。
 */
export function registerOpenPanelTool(registry) {
  registry.registerTool({
    name: 'open_panel',
    descriptor: {
      type: 'function',
      function: {
        name: 'open_panel',
        description:
          '把一个操作面板直接内嵌到 AI 对话中展示，用户可在对话里直接查看和操作（无需跳转右侧面板区）。' +
          '适合「需要用户看/操作某个面板」的场景，如查版本、看部署状态。面板卡片与右侧面板是同一组件同一数据源。',
        parameters: {
          type: 'object',
          properties: {
            panelId: {
              type: 'string',
              description: '面板 id。目前支持：app-updater.version（版本面板：更新检查/部署状态/回滚）',
            },
          },
          required: ['panelId'],
        },
      },
    },
    // 只 emit 一个渲染事件，无破坏面：免审批
    noApproval: true,
    async invoke({ args, run, call, host }) {
      const panelId = String(args.panelId ?? '').trim();
      const SUPPORTED = {
        'app-updater.version': '版本面板',
      };
      if (!SUPPORTED[panelId]) {
        return {
          ok: false,
          stdout: '',
          stderr: `[open_panel] 不支持的面板：${panelId || '(空)'}（可用：${Object.keys(SUPPORTED).join(' / ')}）`,
        };
      }
      host.emit(run, 'artifact.created', {
        sessionId: run.sessionId,
        messageId: run.assistantId,
        callId: call.id,
        rendererType: panelId,
        title: SUPPORTED[panelId],
        data: { viewType: panelId },
      });
      return {
        ok: true,
        stdout: `[面板已内嵌] ${SUPPORTED[panelId]} 已渲染在对话中，用户可直接操作。`,
        stderr: '',
      };
    },
  });
}
