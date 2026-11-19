/**
 * html-preview 插件 UI 半边：AI 生成 HTML 交互面板（移植自 Polaris 主仓
 * interactive-component v2.1.0，按 docs/html-preview-plan.md 六项改进重做）。
 *
 * 职责：
 * - cap.tool.render：describe 动作向 agent-loop 提供工具描述；render 动作
 *   POST /api/preview/render（服务端扫描+落盘）→ 只回 previewId 引用 →
 *   emit artifact.created（chat-lite 通用 artifact 块渲染）；
 * - 渲染器登记：__PLITE_ARTIFACT_RENDERERS__['html-preview'] = PreviewCard
 *   （chat-lite 块渲染查表，本插件不进 chat-lite 源码）；
 * - panel 槽：预览应用架（服务端落盘实读，刷新不丢）。
 *
 * 服务端半边在 server.mjs（/api/preview/*），双入口由 server-registry 登记。
 */
import type { CapabilityHandler, LitePlugin, SlotHostApi } from '@sdk';
import { PreviewCard } from './PreviewCard';
import { HtmlPreviewPanel } from './Panel';
import './panel.css';

const DESCRIPTOR = {
  cap: 'cap.tool.render',
  name: 'render',
  description:
    '生成一个自包含 HTML 交互面板并保存为可运行预览。适合小游戏、可玩原型、' +
    '交互图表、工具页面、教具演示：可内联 CSS/JS、用 canvas/WebGL/AudioContext/' +
    'requestAnimationFrame。约束：必须自包含——不引 CDN、不 fetch、不外链 ' +
    '<script src>（入库扫描会拒绝）；模型/贴图用 base64 DataURL；无 localStorage' +
    '（沙箱内不可用，进度存内存变量）。改动已有面板时传 basePreviewId（同组版本递增）。' +
    '返回 previewId 引用，用户在对话卡片与「预览」面板中查看运行。',
  parameters: {
    type: 'object',
    properties: {
      html: { type: 'string', description: '完整 HTML 文档或片段（内联 CSS/JS；≤2MB）' },
      title: { type: 'string', description: '面板标题（给用户看）' },
      basePreviewId: { type: 'string', description: '可选；基于哪个旧版本迭代（版本归组递增）' },
    },
    required: ['html'],
  },
  danger: 'write' as const,
};

let hostApi: SlotHostApi | null = null;

function createHandler(): CapabilityHandler {
  return async (req) => {
    const payload = (req.payload ?? {}) as Record<string, unknown>;
    switch (req.action) {
      case 'describe':
        return { descriptor: DESCRIPTOR };
      case 'render': {
        // 转发服务端（扫描+落盘都在那里）；只透传 html/title/basePreviewId
        let result: Record<string, unknown>;
        try {
          const resp = await fetch('/api/preview/render', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
              html: payload.html,
              ...(payload.title ? { title: payload.title } : {}),
              ...(payload.basePreviewId ? { basePreviewId: payload.basePreviewId } : {}),
            }),
          });
          const json = (await resp.json().catch(() => null)) as Record<string, unknown> | null;
          if (!resp.ok || !json) {
            return { ok: false, error: (json?.error as string) ?? `HTTP ${resp.status}` };
          }
          result = json;
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
        // 通用 artifact 事件：chat-lite 按 sessionId/messageId 落块，
        // rendererType 查渲染表 → PreviewCard（本插件不进 chat-lite 源码）
        hostApi?.emit('artifact.created', {
          callId: String(result.previewId ?? ''),
          rendererType: 'html-preview',
          title: String(result.title ?? '交互面板'),
          data: {
            previewId: result.previewId,
            url: result.url,
            versionLabel: result.versionLabel,
          },
          ...(payload.sessionId ? { sessionId: String(payload.sessionId) } : {}),
          ...(payload.messageId ? { messageId: String(payload.messageId) } : {}),
        });
        // 面板实时刷新（插件内自有事件，对齐原版 APPS_CHANGED_EVENT 模式）：
        // Panel 监听后重拉 /api/preview/list——AI 每次落盘一个新预览，应用架立即出现
        window.dispatchEvent(new CustomEvent('hp-previews-changed'));
        return { ok: true, previewId: result.previewId, url: result.url, versionLabel: result.versionLabel, title: result.title };
      }
      default:
        return { ok: false, error: `unknown action: ${req.action}` };
    }
  };
}

export const htmlPreviewPlugin: LitePlugin = {
  manifest: {
    id: 'html-preview',
    name: '预览',
    version: '0.1.0',
    capabilities: [],
    provides: ['cap.tool.render'],
    events: ['artifact.created'],
    contributes: {
      slots: [{ slot: 'panel', component: 'HtmlPreviewPanel', order: 5, title: '预览' }],
    },
  },
  setup(api: SlotHostApi) {
    hostApi = api;
    api.registerCapability.register('cap.tool.render', createHandler());
    // artifact 渲染器登记（chat-lite BlockGroup 查表渲染；渲染器自带样式与组件）
    const w = window as unknown as Record<string, unknown>;
    const registry = (w.__PLITE_ARTIFACT_RENDERERS__ ?? {}) as Record<string, unknown>;
    registry['html-preview'] = PreviewCard;
    w.__PLITE_ARTIFACT_RENDERERS__ = registry;
  },
};

export { PreviewCard, HtmlPreviewPanel };

export default htmlPreviewPlugin;
