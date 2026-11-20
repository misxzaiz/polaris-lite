/**
 * browser-lite 插件：AI 网页操作工具 + 浏览器控制台面板（UI 半边）。
 *
 * 三件事（对齐 file-browser 的三角色模式，spec: docs/browser-lite-plan.md）：
 * 1. AI 通道：提供 cap.tool.browser（describe 协议 + 动作转发 /api/browser/dispatch），
 *    会话绑定在服务端（agentKey := sessionId，loop 自动注入，模型无感）；
 * 2. 面板：panel 槽「浏览器」——标签列表（含归属会话）/ 搜索 / 打开 URL / AI 日志 /
 *    screencast 内嵌实时画面；
 * 3. 截图 artifact：screenshot 动作服务端落盘后 emit artifact.created，
 *    chat-lite 通用 artifact 块渲染（ShotCard），本插件零 chat-lite 依赖。
 *
 * 安全约定：服务端是裁决者（门禁/围栏/审计全在 server.mjs）；本半边只做协议转发
 * 与 UI。跨会话隔离靠服务端归属校验——本半边无法伪造 agentKey（dispatch 的 sessionId
 * 由 agent-loop 注入，面板动作不带 sessionId）。
 */
import type { CapabilityHandler, LitePlugin, SlotHostApi } from '@sdk';
import { BrowserPanel, setPanelApi } from './Panel';
import { ShotCard } from './ShotCard';
import './panel.css';

let hostApi: SlotHostApi | null = null;

/** 工具描述（agent-loop discoverTools 经 describe 拉取；单工具多 action，ledger 同构） */
const DESCRIPTOR = {
  cap: 'cap.tool.browser',
  name: 'browser',
  description:
    '驱动系统 Chrome 浏览器：搜索网页、阅读正文、点击/填表/按键/滚动、截图、等待条件、查看打开的标签。' +
    '每个 AI 会话绑定自己的标签——acquire 后续操作自动路由到本会话标签，不会动到其他会话打开的标签。' +
    '动作：acquire(打开/获取本会话标签) navigate(导航/搜索词) search(结构化搜索,返回 title/url/snippet) ' +
    'read(正文抽取) click(label/index/selector 定位) fill(填表) press_key(按键) scroll(滚动) ' +
    'find(页内查找) screenshot(截图,卡片可见) wait(等待 selector/urlPattern/下载完成/对话框) ' +
    'watch(拉取页面事件) tabs(列出当前全部标签及归属) close(关本会话标签) history(浏览历史)。' +
    '首次调用任何动作会自动打开并绑定标签；之后缺省作用于本会话标签。' +
    '优先用结构化交互工具（click/fill），少用 evaluate。',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: '要执行的动作',
        enum: ['acquire', 'navigate', 'search', 'read', 'click', 'fill', 'press_key', 'scroll', 'find', 'screenshot', 'wait', 'watch', 'tabs', 'close', 'history'],
      },
      url: { type: 'string', description: '目标 URL 或搜索词（acquire/navigate/read）' },
      query: { type: 'string', description: '搜索词（search/navigate）' },
      engine: { type: 'string', enum: ['bing', 'baidu', 'duckduckgo', 'google'], description: '搜索引擎（默认 bing）' },
      limit: { type: 'number', description: 'search 返回条数上限（默认 8）' },
      label: { type: 'string', description: '元素可见文本（click/fill 定位）' },
      selector: { type: 'string', description: 'CSS 选择器（click/fill 定位）' },
      index: { type: 'number', description: '候选元素序号（click 定位）' },
      value: { type: 'string', description: '填入值（fill 必填）' },
      keys: { type: 'string', description: '按键（press_key），如 Enter/Escape/Control+a' },
      amount: { type: 'number', description: '滚动像素（scroll，默认 600）' },
      direction: { type: 'string', enum: ['down', 'up'], description: '滚动方向（默认 down）' },
      selector_wait: { type: 'string', description: 'wait：等待出现的 CSS 选择器' },
      urlPattern: { type: 'string', description: 'wait：URL 正则' },
      downloadComplete: { type: 'boolean', description: 'wait：等待下载完成' },
      timeoutMs: { type: 'number', description: 'wait 超时（默认 15000，上限 60000）' },
      fullPage: { type: 'boolean', description: 'screenshot：截整页' },
      mode: { type: 'string', enum: ['reuse', 'create', 'require_new'], description: 'acquire 模式：reuse=复用绑定标签(默认)/create=总是新建/require_new=开独立窗口' },
      closeAll: { type: 'boolean', description: 'close：true=关闭本会话全部标签' },
      historyAction: { type: 'string', enum: ['list', 'back', 'forward'], description: 'history 动作' },
    },
    required: ['action'],
  },
  danger: 'write' as const,
};

/** AI 动作白名单键（safeBrowserArgs 与服务端 dispatchAction 的参数面保持一致） */
export const BROWSER_ARG_KEYS = [
  'action', 'url', 'query', 'engine', 'limit', 'label', 'selector', 'index', 'value', 'keys',
  'amount', 'direction', 'selector_wait', 'urlPattern', 'downloadComplete', 'timeoutMs',
  'fullPage', 'mode', 'closeAll', 'historyAction', 'kinds', 'sinceSeq', 'title', 'newWindow',
] as const;

/** 白名单透传（agent-loop 侧防参数注入面扩张；与 safeArgs/safeLedgerArgs 同纪律） */
export function safeBrowserArgs(raw: string): Record<string, unknown> {
  try {
    const p = JSON.parse(raw || '{}') as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of BROWSER_ARG_KEYS) {
      if (p[key] !== undefined && p[key] !== null) out[key] = p[key];
    }
    return out;
  } catch {
    return {};
  }
}

/** 服务端 dispatch 响应（含截图引用——shotId/url 给 artifact 通道） */
interface BrowserDispatchResult {
  ok?: boolean;
  error?: string;
  shotId?: string;
  url?: string;
  tabId?: string;
  pageUrl?: string;
  [k: string]: unknown;
}

/** 面板动作也走这里（panel:* 动作不带 sessionId → 服务端不归属校验，人可操作任何标签） */
export async function callBrowserApi(action: string, params: Record<string, unknown> = {}): Promise<BrowserDispatchResult> {
  const resp = await fetch('/api/browser/dispatch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ action, ...params }),
  });
  const json = (await resp.json().catch(() => null)) as { ok?: boolean; result?: BrowserDispatchResult; error?: string } | null;
  if (!resp.ok || !json) {
    return { ok: false, error: json?.error ?? `HTTP ${resp.status}` };
  }
  // 服务端成功响应是 {ok:true, result:{...引擎载荷}}；引擎载荷本身无 ok 字段
  // （如 search 返回 {tabId,url,results}）——这里补 ok，让 agent-loop 的 br.ok 判定成立。
  return { ok: true, ...(json.result ?? {}) };
}

function createBrowserHandler(): CapabilityHandler {
  return async (req) => {
    const payload = (req.payload ?? {}) as Record<string, unknown>;
    switch (req.action) {
      case 'describe':
        return { descriptor: DESCRIPTOR };
      default: {
        // AI 动作：sessionId 由 agent-loop 注入（服务端以此为 agentKey 做绑定与归属校验）
        const r = await callBrowserApi(req.action, {
          ...payload,
          ...(typeof payload.sessionId === 'string' && payload.sessionId ? { sessionId: payload.sessionId } : {}),
        });
        // 截图动作：emit artifact.created（chat-lite 通用 artifact 块渲染 ShotCard）
        if (req.action === 'screenshot' && r.ok && r.shotId) {
          const sid = typeof payload.sessionId === 'string' ? payload.sessionId : undefined;
          const mid = typeof payload.messageId === 'string' ? payload.messageId : undefined;
          hostApi?.emit('artifact.created', {
            callId: String(r.shotId),
            rendererType: 'browser-lite-shot',
            title: '浏览器截图',
            data: { shotId: r.shotId, url: r.url, tabId: r.tabId },
            ...(sid ? { sessionId: sid } : {}),
            ...(mid ? { messageId: mid } : {}),
          });
        }
        return r;
      }
    }
  };
}

export const browserLitePlugin: LitePlugin = {
  manifest: {
    id: 'browser-lite',
    name: '浏览器',
    version: '0.1.0',
    capabilities: [],
    provides: ['cap.tool.browser'],
    events: ['tool-registered', 'artifact.created'],
    contributes: {
      slots: [{ slot: 'panel', component: 'BrowserPanel', order: 10, title: '浏览器' }],
    },
  },
  setup(api: SlotHostApi) {
    hostApi = api;
    setPanelApi(api);
    api.registerCapability.register('cap.tool.browser', createBrowserHandler());
    api.emit('tool-registered', { cap: 'cap.tool.browser', name: DESCRIPTOR.name });
    // 截图渲染器登记：chat-lite 的 BlockGroup 经 __PLITE_ARTIFACT_RENDERERS__ 查表渲染
    const w = window as unknown as Record<string, unknown>;
    const registry = (w.__PLITE_ARTIFACT_RENDERERS__ ?? {}) as Record<string, unknown>;
    registry['browser-lite-shot'] = ShotCard;
    w.__PLITE_ARTIFACT_RENDERERS__ = registry;
  },
};

export { BrowserPanel, ShotCard };

export default browserLitePlugin;
