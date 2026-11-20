/**
 * hook-bridge 插件：生命周期钩子（Claude Code / ZCode hooks 兼容）。
 *
 * 职责（plans/extension-capability-pure-plugin-plan.md §2.3）：
 * 1. cap.hook.bridge（agent-loop / chat-lite 调用）：
 *    - preToolUse  {sessionId, toolName, toolInput} → {decision:'allow'|'deny', reason?, updatedInput?, additionalContext?}
 *    - postToolUse {sessionId, toolName, toolInput, success} → fire-and-forget，additionalContext 沉淀到 kv
 *    - onPrompt    {sessionId, prompt} → {decision, reason?}（UserPromptSubmit）
 *    - onSessionStart {sessionId} / onTurnEnd {sessionId} → 观测型
 * 2. server 半边 /api/hooks/*：钩子配置归一（CC settings.json#hooks + ZC config.json#hooks）+
 *    进程执行器（stdin JSON → stdout JSON → 退出码 0 放行 / 2 阻断）。
 *
 * 事件交集（Claude ⊖ ZCode，7 个）→ 内部事件：
 *    SessionStart→session.start  UserPromptSubmit→prompt.submit  PreToolUse→tool.before
 *    PermissionRequest→（P1 只读不采信）  PostToolUse→tool.after  PostToolUseFailure→tool.error  Stop→turn.end
 * Claude 独有事件（PreCompact/SubagentStop/Notification…）解析时忽略 + 一次性 warn。
 *
 * 安全模型：PLITE_HOOKS=0 一键禁用；workspace 级钩子来源首启需确认（kv 指纹）；
 * 每次执行写 <dataDir>/hooks-audit.log；进程 timeout 默认 60s。
 */
import type { CapabilityHandler, LitePlugin, SlotHostApi } from '@sdk';
import { HookPanel } from './Panel';
import './panel.css';

function createHookBridgeHandler(): CapabilityHandler {
  return async (req) => {
    const payload = (req.payload ?? {}) as Record<string, unknown>;
    try {
      if (req.action === 'preToolUse') {
        const resp = await fetch('/api/hooks/pre-tool-use', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const j = (await resp.json().catch(() => null)) as { decision?: string; reason?: string; updatedInput?: unknown; additionalContext?: string } | null;
        if (!resp.ok) return { decision: 'allow' }; // 服务不可用不阻塞工具
        return {
          decision: j?.decision ?? 'allow',
          reason: j?.reason,
          updatedInput: j?.updatedInput,
          additionalContext: j?.additionalContext,
        };
      }
      if (req.action === 'postToolUse') {
        // fire-and-forget：不阻塞 loop；失败静默（审计在服务端）
        void fetch('/api/hooks/post-tool-use', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }).catch(() => undefined);
        return { ok: true };
      }
      if (req.action === 'onPrompt') {
        const resp = await fetch('/api/hooks/prompt-submit', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const j = (await resp.json().catch(() => null)) as { decision?: string; reason?: string } | null;
        if (!resp.ok) return { decision: 'allow' };
        return { decision: j?.decision ?? 'allow', reason: j?.reason };
      }
      if (req.action === 'onSessionStart' || req.action === 'onTurnEnd') {
        const path = req.action === 'onSessionStart' ? '/api/hooks/session-start' : '/api/hooks/turn-end';
        void fetch(path, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }).catch(() => undefined);
        return { ok: true };
      }
      return { ok: false, error: `unknown action: ${req.action}` };
    } catch (err) {
      // 钩子桥故障永远不阻塞主流程（fail-open），错误已由服务端审计
      return { decision: 'allow', error: err instanceof Error ? err.message : String(err) };
    }
  };
}

export const hookBridgePlugin: LitePlugin = {
  manifest: {
    id: 'hook-bridge',
    name: '生命周期钩子桥',
    version: '0.2.0',
    capabilities: ['cap.meta'],
    provides: ['cap.hook.bridge'],
    events: ['user.prompt'],
    contributes: {
      slots: [{ slot: 'panel', component: 'HookPanel', order: 23, title: '钩子' }],
    },
  },
  setup(api: SlotHostApi) {
    api.registerCapability.register('cap.hook.bridge', createHookBridgeHandler());
  },
};

export { HookPanel };
export default hookBridgePlugin;
