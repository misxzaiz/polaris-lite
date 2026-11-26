/**
 * chat-lite 插件：AI 对话 UI（Polaris 四段式对话布局的插件化实现）。
 * 填充 sidebar（会话侧栏）/ stream（消息流）/ input（输入区）三槽；
 * panel 槽留给其它面板插件。会话状态由本插件私有 store 持有（核心零业务），
 * AI 回复经 cap.ai.chat 流式总线驱动。
 *
 * 关键约束（踩过的坑，改动时别退回去）：
 * - 事件按 messageId 精确过滤，否则同会话并发流会串台；
 * - settle 幂等：done / error / 看门狗 / 中断 都可能触发收敛，只允许复位一次；
 * - 任何收敛路径都必须补发 settle，否则输入框永远停在「停止」态；
 * - delta 按帧合并写 store：逐 token 写会让整棵消息树每个 token 重渲染。
 */
import { CHANNEL_FILE_BROWSER_COMPOSE, type LitePlugin, type SlotHostApi, type ChatMessage } from '@sdk';
import { useSessionStore, isToolCard, hasBlocks, setOfflineMode, syncPullNow, markRunnerOwned, type StoreMessage } from './store';
import { useCtxStore, ctxPolicyOf } from './ctxStore';
import type { Attachment } from './attachments';
import { SessionSidebar } from './SessionSidebar';
import { MessageStream } from './MessageStream';
import { ChatInput } from './ChatInput';
import { notifyRootsChanged } from './workspace-prefs';
import { setRunnerGlobalConsumer, startRunnerRun, resolveRunnerApproval, interruptRunnerRun, restoreRunnerRuns, probeRunner, resumeRunnerRun, setRunnerRestoreHandler, findRunningRun } from './runnerBridge';
import { createLiveTurn, attachRunnerLive } from './liveTurn';
import { setRunnerAttach } from './liveOverlay';
import { bindEngineCatalog, loadEngines, supportsSlashSkills, supportsTools } from './engineCatalog';
export type { StreamEnvelope } from './runnerTypes';
import type { StreamEnvelope } from './runnerTypes';
// 插件自带样式：会话侧栏 / 消息流 / 空态 / Markdown / 工具卡（原先散落在宿主 src/styles.css）
import './chat.css';
// 上下文透视：状态条 + 详情抽屉样式（spec docs/context-insight-plan.md）
import './context.css';
import { SRV } from './serverApi';

/** 与 mock-auth 的会话镜像键：经 @sdk 契约登记（暗通道收编） */

/**
 * 看门狗阈值与「delta 合帧 → 落块 → 收敛」的渲染机制已上移 liveTurn.ts
 * （发起端与「页面重开/切回执行中会话」共用同一套渲染器；这里不再保留第二份闭包）。
 */

/**
 * 首条用户消息 → 会话标题（自动命名）：
 * title 仍是默认「新会话」时，用首条用户消息前 40 字做持久标题，随同一轮
 * dirty+防抖 PUT 落盘，多端索引/分享面板/导出文件名全线一致。
 * 口径对齐 transcript-share 的 deriveTitle（去空白、合并换行、截 40 字）。
 * 只在 title === '新会话' 时生效：用户手动改过名（或已是自动名）绝不覆盖。
 */
function autoTitleFrom(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 40);
}

function ensureAutoTitle(sessionId: string, text: string): void {
  const store = useSessionStore.getState();
  const s = store.sessions.find((x) => x.id === sessionId);
  if (!s || s.title !== '新会话') return;
  const t = autoTitleFrom(text);
  if (t) store.renameSession(sessionId, t);
}

/** 空态快捷建议 → 输入框的填写通道（避免为一句「填入草稿」在组件间拉一条状态） */
type ComposeListener = (text: string) => void;
const composeListeners = new Set<ComposeListener>();

/** 订阅「填入输入框」；返回取消订阅（ChatInput 挂载时注册） */
export function onCompose(fn: ComposeListener): () => void {
  composeListeners.add(fn);
  return () => {
    composeListeners.delete(fn);
  };
}

/** 把一段文本填入输入框（不发送），供空态建议复用 */
export function requestCompose(text: string): void {
  if (!hostApi) {
    // 插件尚未装配（理论上不会发生：空态本身由本插件渲染）——退化为直接发送
    void sendUserMessage(text);
    return;
  }
  if (composeListeners.size === 0) {
    void sendUserMessage(text);
    return;
  }
  composeListeners.forEach((fn) => fn(text));
}

/** 断流重试提示（瞬态）：MessageStream 订阅渲染「正在重试 N/10」浮层 */
type RetryListener = (attempt: number, maxAttempts: number, chars: number) => void;
const retryListeners = new Set<RetryListener>();
export function onStreamRetry(fn: RetryListener): () => void {
  retryListeners.add(fn);
  return () => retryListeners.delete(fn);
}
function notifyStreamRetry(attempt: number, maxAttempts: number, chars: number): void {
  for (const fn of retryListeners) fn(attempt, maxAttempts, chars);
}

/**
 * 重开/切回一个执行中的会话时，挂渲染器用的公共钩子：
 * - 旁听通道（ai-events 取证）与发起端同口径；
 * - 登录过期同样收敛回登录视图。
 */
function restoredHooks() {
  return {
    onRetry: notifyStreamRetry,
    onEvent: (envelope: StreamEnvelope): void => {
      try { hostApi?.emit('cap.ai.chat.runner:event', envelope); } catch { /* 旁听失败不影响渲染 */ }
    },
    onAuthExpired: (): void => {
      void hostApi?.dispatch({ target: 'cap.auth', action: 'logout' }).finally(() => window.location.reload());
    },
  };
}

let hostApi: SlotHostApi | null = null;
let msgCounter = 0;

function nextMsgId(): string {
  msgCounter += 1;
  return `m-${Date.now().toString(36)}-${msgCounter.toString(36)}`;
}

export function getChatHost(): SlotHostApi | null {
  return hostApi;
}

export const chatLitePlugin: LitePlugin = {
  manifest: {
    id: 'chat-lite',
    name: '对话',
    version: '0.3.0',
    capabilities: ['cap.ai.chat', 'cap.ai.chat.interrupt', 'cap.ai.engine', 'cap.meta', 'cap.hook.bridge', 'cap.auth'],
    /** 依赖 AI 引擎提供的流式能力：宿主据此让引擎先于对话 UI 装配 */
    requires: ['cap.ai.chat'],
    // user.prompt：发送时对外广播用户输入原文，供 ai-events 等旁听插件按 messageId 归到同一轮
    // interactive.*：interactive-cards 的交互卡事件；artifact.created：html-preview 等产物插件
    // workspace-renamed：file-browser 改名广播，输入区目录名据此即时同步（不再停留在旧名）
    // mode-changed：standalone-mode 的运行模式广播（独立档切换本地会话镜像，docs/mobile-app-plan.md §10）
    // auth-changed：登录成功立即对账（否则新设备首登要等 30s 轮询才有会话列表）
    events: ['cap.ai.chat:event', 'cap.ai.chat.runner:event', 'user.prompt', 'interactive.created', 'interactive.answered', 'artifact.created', 'workspace-renamed', 'mode-changed', 'auth-changed'],
    contributes: {
      slots: [
        { slot: 'sidebar', component: 'SessionSidebar', order: 1 },
        { slot: 'stream', component: 'MessageStream', order: 1 },
        { slot: 'input', component: 'ChatInput', order: 1 },
      ],
    },
  },
  setup(api) {
    hostApi = api;
    bindEngineCatalog(api);
    void loadEngines(); // 引擎清单自省（失败静默；面板打开时会重试）
    // 跨插件输入注入通道（file-browser「发到对话」等使用；经本函数保证走合法发送路径）
    (window as unknown as Record<string, unknown>)[CHANNEL_FILE_BROWSER_COMPOSE] = (text: string) => requestCompose(text);
    // 交互卡事件是 interactive-cards 直发（不走 cap.agent.loop:event 流通道），必须挂全局监听。
    // 事件载荷带 sessionId/messageId（agent-loop ask 时透传），按「会话+消息」双过滤落块，
    // 与流事件同一防串台纪律；store 查不到目标消息时自然 no-op（无主事件丢弃）。
    const onInteractive = (created: boolean) => (envelope: unknown): void => {
      const ev = envelope as { source?: string; payload?: Record<string, unknown> };
      const inner = (ev?.payload ?? {}) as {
        sessionId?: string; messageId?: string; callId?: string;
        kind?: 'question' | 'form' | 'confirm'; title?: string;
        payload?: Record<string, unknown>; answer?: Record<string, unknown>;
      };
      const sid = inner.sessionId;
      const aid = inner.messageId;
      const callId = inner.callId;
      if (!sid || !aid || !callId) return; // 无定位信息：无法归块，丢弃
      const st = useSessionStore.getState();
      const msg = st.sessions.find((s) => s.id === sid)?.messages.find((m) => m.id === aid);
      // 块消息挂卡：assistant 流式消息 blocks:[] 已初始化，首轮事件（先于任何
      // thinking/delta 落块）就可能带卡——曾用 hasBlocks（要求已有块）把关，
      // 结果「开场即发卡」的插件卡被静默丢弃（goal-keeper /goal 登记卡实测丢失）。
      // 这里放宽为「有 blocks 数组即可挂」；纯文本消息（无 blocks 字段）仍丢弃。
      const blocks = (msg as { blocks?: { type: string; card?: { callId: string } }[] }).blocks;
      if (!msg || !Array.isArray(blocks)) return;
      const exists = blocks.some((b) => b.type === 'interactive' && b.card?.callId === callId);
      if (created || !exists) {
        if (exists) return; // created 重复：幂等跳过
        st.appendAssistantBlock(sid, aid, {
          type: 'interactive',
          card: {
            callId,
            kind: inner.kind ?? 'question',
            title: inner.title ?? '请确认',
            payload: inner.payload ?? {},
            status: created ? 'awaiting' : 'answered',
            ...(created ? {} : { answer: inner.answer ?? {} }),
          },
        });
        return;
      }
      // answered：回填答案与状态
      st.patchAssistantInteractiveBlock(sid, aid, callId, {
        answer: inner.answer ?? {},
        status: 'answered',
      });
    };
    api.listen('interactive.created', onInteractive(true));
    api.listen('interactive.answered', onInteractive(false));

    // 独立档数据面（docs/mobile-app-plan.md §10.4）：standalone-mode 广播模式变化 →
    // 切换会话同步层。standalone（宿主不可达）时暂停服务端轮询/推送，会话变更只落
    // IndexedDB 本地镜像（手机独立使用不丢）；恢复连接档时自动对账+补偿上传。
    api.listen('mode-changed', (payload) => {
      const p = payload as { status?: string } | null;
      if (p?.status === 'standalone') setOfflineMode(true);
      else if (p?.status === 'connected') setOfflineMode(false);
    });
    // 通用产物事件（html-preview 等产物插件直发）：一次性落块，无回填流；
    // 渲染器由产物插件经 CHANNEL_ARTIFACT_RENDERERS(@sdk) 登记，chat-lite 只认
    // {rendererType, callId, title, data} 契约——第二个产物插件起零改动。
    api.listen('artifact.created', (envelope: unknown) => {
      const ev = envelope as { source?: string; payload?: Record<string, unknown> };
      const inner = (ev?.payload ?? {}) as {
        sessionId?: string; messageId?: string; callId?: string;
        rendererType?: string; title?: string; data?: Record<string, unknown>;
      };
      const sid = inner.sessionId;
      const aid = inner.messageId;
      const callId = inner.callId;
      if (!sid || !aid || !callId || !inner.rendererType) return; // 无定位/无渲染器：丢弃
      const st = useSessionStore.getState();
      const msg = st.sessions.find((s) => s.id === sid)?.messages.find((m) => m.id === aid);
      if (!msg || !hasBlocks(msg)) return;
      if (msg.blocks.some((b) => b.type === 'artifact' && b.card.callId === callId)) return; // 幂等
      st.appendAssistantBlock(sid, aid, {
        type: 'artifact',
        card: {
          callId,
          rendererType: inner.rendererType,
          title: inner.title ?? '产物',
          status: 'ready',
          data: inner.data ?? {},
        },
      });
    });
    // 工作区根改名/登记/删除：广播到输入区与选择器（原先只发不收，目录名会停在旧值）
    api.listen('workspace-renamed', () => notifyRootsChanged());
    // 登录成功立即对账（auth-changed 由 mock-auth 在状态翻转时发出；登出也发，401 空拉无害）
    api.listen('auth-changed', () => syncPullNow());
    // ---- 上下文透视（spec §5.3）：ctxStore 单写者由事件驱动，UI 只读 ----
    // 服务端 runner 通道（SSE）与 cap 总线双源合一：同一处理函数复用，
    // 否则 runner 会话的输入框 token/缓存/水位透视失去数据源。
    // （声明先于 setRunnerGlobalConsumer 使用——TDZ：块级 const 不能先用后定义）
    const onCtxEvent = (envelope: unknown): void => {
      const ev = envelope as { kind?: string; payload?: Record<string, unknown> };
      const kind = ev.kind ?? '';
      const p = (ev.payload ?? {}) as { sessionId?: string; messageId?: string } & Record<string, unknown>;
      if (!p.sessionId) return;
      const store = useCtxStore.getState();
      if (kind === 'ai.usage') {
        const u = p as { inputTokens?: number; outputTokens?: number; durationMs?: number; cachedTokens?: number; cacheCreationTokens?: number; estimated?: boolean; model?: string; contextWindow?: number };
        useCtxStore.getState().applyUsage({ ...u, sessionId: p.sessionId });
        return;
      }
      if (kind === 'context.snapshot') store.applySnapshot(p as never);
      else if (kind === 'context.compacting') store.applyCompacting(p.sessionId);
      else if (kind === 'context.compacted') {
        store.applyCompacted(p as never);
        // 压缩卡片落进 assistant 消息流（用户在对话里直接可见；幂等：重复事件不重复落块）
        const sid = p.sessionId;
        const aid = p.messageId;
        if (aid) {
          const st = useSessionStore.getState();
          const msg = st.sessions.find((s) => s.id === sid)?.messages.find((m) => m.id === aid);
          if (msg && hasBlocks(msg)) {
            const marker = `[已压缩上下文 ${String(p.removedMessages ?? '?')} 条消息 → 摘要（${String(p.tokensBefore ?? '?')} → ${String(p.tokensAfter ?? '?')} tokens）]`;
            const dup = msg.blocks.some((b) => b.type === 'text' && b.text.includes('[已压缩上下文'));
            if (!dup) st.appendAssistantBlock(sid, aid, { type: 'text', text: marker });
          }
        }
      } else if (kind === 'context.compact-failed') {
        store.applyCompactFailed(p.sessionId, String((p as { reason?: string }).reason ?? 'unknown'));
        // 失败提示同样落块（非破坏语义：历史完整保留，用户知道发生了什么）
        const sid = p.sessionId;
        const aid = p.messageId;
        if (aid) {
          const st = useSessionStore.getState();
          const msg = st.sessions.find((s) => s.id === sid)?.messages.find((m) => m.id === aid);
          if (msg && hasBlocks(msg)) {
            const marker = `[上下文压缩失败：${String((p as { reason?: string }).reason ?? 'unknown')}；历史已完整保留，将继续以当前上下文继续对话]`;
            const dup = msg.blocks.some((b) => b.type === 'text' && b.text.includes('[上下文压缩失败'));
            if (!dup) st.appendAssistantBlock(sid, aid, { type: 'text', text: marker });
          }
        }
      }
    };
    // ai.usage：引擎流末发出（输入/输出 token、缓存命中、耗时、速率分母）
    // context.*：服务端 runner 编排事件（水位快照 / 压缩生命周期）——同一通道。
    api.listen('cap.ai.chat:event', onCtxEvent);
    // runner 通道的全局消费者：ai.usage / context.* 水位透视（不随会话切换，
    // 与上面 cap 总线的 onCtxEvent 同一处理函数——双源合一）。
    setRunnerGlobalConsumer(onCtxEvent);

    // ---- 服务端编排（B1）刷新恢复：页面加载后对服务端 running 表对账， ----
    // 执行中的会话重建 SSE 订阅（事件日志重放 → UI 追平）；服务端继续执行不受刷新影响。
    // 恢复时必须**同时**挂上渲染器并把消息复位成 streaming：否则重开后工具卡不实时
    // （事件没人接），输入框还会显示「已结束」而不是「停止」。
    setRunnerRestoreHandler((att) => attachRunnerLive(att, restoredHooks()));
    // 切进一个正在执行的会话（另一台设备发起 / 重开后落到别的会话）同样接实时流
    setRunnerAttach(async (sessionId) => {
      const att = await findRunningRun(sessionId);
      if (!att) return false;
      return attachRunnerLive(att, restoredHooks());
    });
    // 延迟到 sync bootstrap 之后再做（会话列表就绪才有遍历对象）；探活失败静默跳过。
    setTimeout(() => {
      void probeRunner().then((ok) => {
        if (!ok) return;
        const ids = useSessionStore.getState().sessions.map((s) => s.id);
        void restoreRunnerRuns(ids);
      });
    }, 3000);
  },
};

// StreamEnvelope 已上移 plugins/chat-lite/runnerTypes.ts（runnerBridge 与本文件共用同一形状；
// 服务端 agent-runner 的 SSE 事件同构，渲染层零改动）。

/** 由 ChatInput / 快捷建议 / 队列泵调用：发送用户消息并触发流式回复 */
export async function sendUserMessage(text: string, attachments?: Attachment[]): Promise<void> {
  const api = hostApi;
  const hasAttachments = !!attachments && attachments.length > 0;
  if (!api || (!text.trim() && !hasAttachments)) return;
  const store = useSessionStore.getState();
  let sessionId = store.activeId;
  if (!sessionId) sessionId = store.createSession();
  const sid: string = sessionId;

  // /name 斜杠命令（P2，plans/extension-capability-pure-plugin-plan.md §2.2）：
  // `/deploy args...` → 若 skill-loader 的技能索引里有名为 deploy 的技能，则把正文替换为
  // read_skill 的参数化形态（$ARGUMENTS/$1/$2 由 skill-loader exec 时替换）。
  // 非斜杠输入 / 未命中技能 / 能力未装 → 原文直发，零行为变化。
  let effectiveText = text;

  // UserPromptSubmit 钩子（P1 补全）：hook-bridge 可拒绝本轮发送（deny → 提示且不入会话）。
  try {
    const hp = await api.dispatch<{ decision?: string; reason?: string }>({
      target: 'cap.hook.bridge',
      action: 'onPrompt',
      payload: { sessionId: sid, prompt: text },
    });
    if (hp.data?.decision === 'deny') {
      const reason = hp.data.reason ? '（原因：' + hp.data.reason + '）' : '';
      // 拦截原因落会话（user 原文 + assistant notice 块），用户能看到为什么没发出去
      store.appendMessage(sessionId, { id: 'u-' + Date.now(), role: 'user', content: text, createdAt: Date.now() } as never);
      const nid = 'a-' + Date.now();
      store.appendMessage(sessionId, { id: nid, role: 'assistant', streaming: false, blocks: [], createdAt: Date.now(), endedAt: Date.now() } as never);
      store.appendAssistantBlock(sessionId, nid, { type: 'notice', text: '[生命周期钩子] 本轮输入已被 UserPromptSubmit 钩子拦截' + reason + '。输入未发送给 AI。' });
      return;
    }
  } catch { /* 钩子桥未装：正常发送 */ }
  // /name 斜杠技能展开由引擎声明的 features.slashSkills 决定：宿主侧技能体系
  // （read_skill）不存在的引擎应显式关掉该能力，原文直发让引擎自己的技能机制处理。
  // 这里不认识任何具体引擎 id。
  const slashEngineId = useSessionStore.getState().sessions.find((s) => s.id === sessionId)?.modelRef?.engineId;
  const slashMatch = supportsSlashSkills(slashEngineId)
    ? /^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(text.trim())
    : null;
  if (slashMatch) {
    try {
      // 技能存在性由 skill-loader 的 /api/skills/read 校验（404=不存在）。
      const skillName = slashMatch[1];
      const args = (slashMatch[2] ?? '').trim();
      const resp = await fetch(`${SRV.skills}/read?name=${encodeURIComponent(skillName)}`, { credentials: 'include' });
      if (resp.ok) {
        const j = (await resp.json().catch(() => null)) as { ok?: boolean } | null;
        if (j?.ok) {
          effectiveText = args
            ? `请按技能「${skillName}」执行（参数：${args}）。先用 read_skill 读取该技能全文再遵循执行。`
            : `请按技能「${skillName}」执行。先用 read_skill 读取该技能全文再遵循执行。`;
        }
      }
    } catch { /* 探测失败：原文直发 */ }
  }

  // 上下文 = 本次提问之前的全部消息（排除工具卡；blocks 模式的 assistant 文本取块拼接）。
  // 协议上下文由 agent-loop 的 shadow transcript 自持，此处只喂可见文本。
  const history = store.sessions
    .find((s) => s.id === sid)
    ?.messages.filter((m) => !m.streaming && !isToolCard(m) && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({
      role: m.role,
      content: hasBlocks(m)
        ? m.blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n') || m.content
        : m.content,
    }));

  // 新消息即过期：本会话挂着的审批（块内/旧版独立卡）直接置为拒绝（Polaris 语义；loop 侧 120s 超时兜底）
  store.expirePendingApprovals(sid);

  store.appendMessage(sid, {
    id: nextMsgId(),
    role: 'user',
    content: text,
    createdAt: Date.now(),
  } satisfies ChatMessage);

  // 首条用户消息自动命名会话（title 仍是「新会话」才生效），随同一轮防抖 PUT 落盘
  ensureAutoTitle(sid, text);

  const assistantId = nextMsgId();

  // 对外广播用户输入原文（ai-events 旁听：按 messageId=assistantId 归到同一轮次）。
  // 取证是旁路职责：这里绝不因为 emit 失败而影响发送；附件只报名字，不带 base64 原文。
  try {
    api.emit('user.prompt', {
      sessionId: sid,
      messageId: assistantId,
      text,
      at: Date.now(),
      ...(hasAttachments ? { attachments: attachments!.map((a) => a.name) } : {}),
    });
  } catch {
    /* 无监听者或取证插件未启用：静默跳过 */
  }

  store.appendMessage(sid, {
    id: assistantId,
    role: 'assistant',
    content: '',
    blocks: [], // blocks 模式：文本/工具块按事件序追加（content 为其镜像，供历史映射与兼容消费）
    createdAt: Date.now(),
    streaming: true,
  } as unknown as ChatMessage);

  // 编排能力开关来自引擎插件声明（features.supportsTools），不是写死的引擎 id。
  // 支持工具编排的引擎一律走服务端 runner（唯一执行者）；不支持的走引擎直达。
  const sendingSession = useSessionStore.getState().sessions.find((s) => s.id === sid);
  const engineId = sendingSession?.modelRef?.engineId;
  const toolCapable = supportsTools(engineId);

  // ---- 本轮渲染器（liveTurn）：delta 合帧 / 工具卡 / 看门狗 / 收敛集中在一处 ----
  // 页面重开或切回执行中的会话时，liveTurn.attachRunnerLive 复用同一实现，
  // 所以本函数不再自己持有闭包（两份实现会漂：重开路径曾因此完全没有消费者）。
  let offCap: (() => void) | undefined;
  const turn = createLiveTurn({
    sessionId: sid,
    assistantId,
    hooks: {
      onRetry: notifyStreamRetry,
      onSettle: () => {
        offCap?.();
        sendNextPending(); // 流结束：自动派发队列下一条（若有）
      },
      onAuthExpired: () => {
        // 会话过期（服务端 401）：经 cap.auth 登出（权限插件清理自己的会话镜像），再回登录视图
        void hostApi?.dispatch({ target: 'cap.auth', action: 'logout' }).finally(() => window.location.reload());
      },
      // 旁听层（ai-events 取证）：服务端事件投到专用总线通道，形状保持 envelope 原样
      onEvent: (envelope) => {
        try { api.emit('cap.ai.chat.runner:event', envelope); } catch { /* 旁听失败不影响渲染 */ }
      },
    },
  });

  // 引擎直达事件仍走 cap.ai.chat:event（不支持工具编排的引擎）；
  // 服务端 runner 事件由 liveTurn 的全局消费者按 sessionId 路由到同一个渲染器。
  offCap = api.listen('cap.ai.chat:event', turn.dispatch);


  const session = sendingSession ?? store.sessions.find((s) => s.id === sid);
  const modelRef = session?.modelRef;

  // ---- 服务端编排优先（B1）：仅支持工具编排的引擎走 /api/agent/start；
  // 不支持的引擎（如 CLI 自持工具的引擎）直接走 cap.ai.chat，由核心分派器路由。 ----
  if (toolCapable) {
    const runnerStarted = await startRunnerRun({
      sessionId: sid,
      messageId: assistantId,
      prompt: effectiveText,
      history: history ?? [],
      engineId,
      providerId: modelRef?.providerId,
      modelId: modelRef?.modelId,
      // 自带目录引擎的模型选择（如 CLI 模型）——平台只搬运，服务端适配器自行解释
      option: modelRef?.option,
      // 会话绑定工作区 + 关联只读目录（服务端据此解析 bash cwd / files 默认根 / system prompt）
      workspaceId: session?.workspaceId,
      linkedWorkspaceIds: session?.linkedWorkspaceIds,
      ctxPolicy: ctxPolicyOf(sid),
      ...(hasAttachments && attachments ? { attachments } : {}),
    });
    if (runnerStarted) {
      // 会话档单一权威化：编排接入服务端后，该会话的消息权威=服务端 runner
      //（直写 chat-store）；本端只订阅 SSE 渲染，消息变更不推服务端。
      markRunnerOwned(sid);
      return; // 事件经 SSE → setRunnerConsumer 消费；本端不重复派发
    }
    // runner 拒发（并发满/引擎无服务端适配器/无供应商）：回落引擎直连通道，
    // 由引擎自身给出用户可见的错误或降级对话——不静默丢消息。
  }

  await api.dispatch({
    target: 'cap.ai.chat',
    action: 'start',
    payload: {
      sessionId: sid,
      messageId: assistantId,
      prompt: effectiveText,
      history,
      // 引擎选择：核心分派器按 engineId 路由到 cap.ai.chat.<id>；option 由引擎自行解释
      ...(engineId ? { engineId } : {}),
      ...(modelRef?.option ? { option: modelRef.option } : {}),
      ...(modelRef?.providerId ? { providerId: modelRef.providerId } : {}),
      ...(modelRef?.modelId ? { modelId: modelRef.modelId } : {}),
      // 会话绑定的文件工作区（agent-loop 据此设置 bash cwd 与 system prompt；缺省=默认 workspace）
      ...(session?.workspaceId ? { workspaceId: session.workspaceId } : {}),
      // 关联只读目录：files 工具可读、bash 不在此执行（服务端仍按登记根白名单校验）
      ...((session?.linkedWorkspaceIds?.length ?? 0) > 0 ? { linkedWorkspaceIds: session!.linkedWorkspaceIds } : {}),
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    },
  });
}

// ===== 消息操作（P0/P1）：复制口径 / 重发 / 编辑重答 / 重新生成 =====

/** assistant 消息的可见正文：text 块拼接（与发送历史同一口径），缺省回退 content 镜像。
 *  思考/工具卡/轻提示不进正文；[运行提示] 空闲软提示与流错误也是 text 块，随正文一并复制。 */
export function assistantVisibleText(m: StoreMessage): string {
  if (isToolCard(m)) return m.content;
  if (hasBlocks(m)) return m.blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n') || m.content;
  return m.content;
}

/** 会话是否有在途流（本端 UI 视角） */
function isSessionStreaming(sid: string): boolean {
  return useSessionStore.getState().sessions
    .find((s) => s.id === sid)?.messages.some((m) => !isToolCard(m) && m.streaming) ?? false;
}

/** 重发：任意历史用户消息，追加新一轮。不截断、不改协议——shadow 是追加式语义，天然兼容。 */
export function resendMessage(sessionId: string, msgId: string): void {
  const st = useSessionStore.getState();
  const msg = st.sessions.find((s) => s.id === sessionId)?.messages.find((m) => m.id === msgId);
  if (!msg || isToolCard(msg) || msg.role !== 'user' || !msg.content.trim()) return;
  // 流式中不并发开流：走既有排队机制（流结束后自动派发），与「排队」按钮同语义
  if (isSessionStreaming(sessionId)) {
    enqueuePending(msg.content);
    return;
  }
  if (st.activeId !== sessionId) st.setActive(sessionId);
  void sendUserMessage(msg.content);
}

/** 截断重答共用路径：截断 msgId 及其后全部 → 按同一提示词重新提交。
 *  服务端 runner 每次 start 以可见历史重建 shadow，无需复位；新消息以新 id 入列
 *  （user.prompt 广播/钩子语义与手打重发完全一致）。 */
async function resubmitFrom(sid: string, userMsgId: string, prompt: string): Promise<void> {
  const store = useSessionStore.getState();
  store.expirePendingApprovals(sid);
  store.truncateMessagesBefore(sid, userMsgId);
  await sendUserMessage(prompt);
}

/** 编辑重答：仅对最后一轮用户消息开放（文本可改）。截断该轮回复并以新文本重新提交。 */
export async function editResendLast(sessionId: string, msgId: string, newText: string): Promise<void> {
  const st = useSessionStore.getState();
  const session = st.sessions.find((s) => s.id === sessionId);
  const msg = session?.messages.find((m) => m.id === msgId);
  if (!session || !msg || isToolCard(msg) || msg.role !== 'user') return;
  const text = newText.trim();
  if (!text) return;
  const idx = session.messages.findIndex((m) => m.id === msgId);
  // 仅最后一轮：之后不允许再有任何用户消息（更早的消息只有「回填」）
  if (session.messages.slice(idx + 1).some((m) => !isToolCard(m) && m.role === 'user')) return;
  if (isSessionStreaming(sessionId)) return;
  await resubmitFrom(sessionId, msgId, text);
}

/** 重新生成：替换最后一条 assistant 回复（同提示词重答）。仅当末条是 assistant 且空闲。 */
export async function regenerateLast(sessionId: string): Promise<void> {
  const st = useSessionStore.getState();
  const session = st.sessions.find((s) => s.id === sessionId);
  if (!session || isSessionStreaming(sessionId)) return;
  const n = session.messages.length;
  const last = session.messages[n - 1];
  const prev = session.messages[n - 2];
  if (!last || isToolCard(last) || last.role !== 'assistant' || last.streaming) return;
  if (!prev || isToolCard(prev) || prev.role !== 'user') return;
  await resubmitFrom(sessionId, prev.id, prev.content);
}

/** 中断当前会话在途流；loop 存在时中断整个编排（引擎流+工具+审批），否则直接打断引擎 */
export function interruptChat(): void {
  const api = hostApi;
  const sessionId = useSessionStore.getState().activeId;
  if (!api || !sessionId) return;
  // 在途 assistant 消息 id：loop 用它立即回执 message.done{interrupted}（UI 即刻收敛）
  const streamingMsg = useSessionStore
    .getState()
    .sessions.find((s) => s.id === sessionId)
    ?.messages.find((m) => !isToolCard(m) && m.streaming);
  const messageId = streamingMsg?.id;

  const doInterrupt = async (): Promise<{ ok: boolean; data?: { found?: boolean } }> => {
    // 服务端编排通道：中断 run（服务端 abort 上游流 + 挂起审批 deny 收敛）
    if (await interruptRunnerRun(sessionId)) return { ok: true, data: { found: true } };
    // 无服务端 run：直接打断引擎直通流（standalone/非工具引擎）
    const engineId = useSessionStore.getState().sessions.find((s) => s.id === sessionId)?.modelRef?.engineId;
    return api.dispatch<{ found?: boolean }>({
      target: 'cap.ai.chat.interrupt',
      action: 'interrupt',
      // engineId 决定中断哪个引擎的 running 表；缺省时核心扇出到所有已注册引擎
      payload: { sessionId, ...(messageId ? { messageId } : {}), ...(engineId ? { engineId } : {}) },
    });
  };

  void doInterrupt()
    .then((res) => {
      // 自愈：引擎已无此流（found=false 或调用失败）时复位残留 streaming 标志，
      // 避免输入框被残留状态永久锁死；复位后同样要让队列继续流动。
      if (!res.ok || res.data?.found === false) {
        const cur = useSessionStore.getState();
        cur.sessions
          .find((s) => s.id === sessionId)
          ?.messages.filter((m) => !isToolCard(m) && m.streaming)
          .forEach((m) => cur.updateMessage(sessionId, m.id, { streaming: false }));
        sendNextPending();
      }
    })
    .catch(() => undefined);
}

/** 续写兜底超时：正常由 loop 的 message.done 收敛；悬死流 5 分钟后复位 streaming（软兜底） */
const RESUME_TIMEOUT_MS = 300_000;

/**
 * 截断续写兜底（truncated 块「继续」按钮）：不新增用户消息，直接续开同一 assistant
 * 消息——shadow 尾是 assistant 半截 prefill（agent-loop resume 动作语义，MOSI 实测支持）。
 * 渲染复用 liveTurn（与常规流同一套 delta/工具/收敛实现），仅多一个 5 分钟软兜底。
 */
export function resumeTruncated(sessionId: string, messageId: string): void {
  const st = useSessionStore.getState();
  const msg = st.sessions.find((s) => s.id === sessionId)?.messages.find((m) => m.id === messageId);
  if (!msg || isToolCard(msg) || msg.streaming) return; // 幂等：流式中不重复触发
  st.updateMessage(sessionId, messageId, { streaming: true });

  // 与常规流同一套渲染器：续写只是「同一个 assistant 消息再来一段」，
  // 不应有第二份 delta/工具/收敛实现（旧实现在这里另挂了一个 consumer，
  // 会把 liveTurn 的全局消费者顶掉）。
  let timer: ReturnType<typeof setTimeout> | null = null;
  const turn = createLiveTurn({
    sessionId,
    assistantId: messageId,
    hooks: { onSettle: () => { if (timer) { clearTimeout(timer); timer = null; } } },
  });
  // 软兜底：服务端没回执时 5 分钟后强制收敛（与旧实现同阈值）
  timer = setTimeout(() => { turn.settle(); }, RESUME_TIMEOUT_MS);

  void resumeRunnerRun(sessionId, messageId)
    .then((runId) => { if (!runId) turn.settle(); })
    .catch(() => turn.settle());
}

/** 审批决策回填（ToolCard 按钮调用；服务端编排挂起审批，任意在线设备先到先得） */
export function resolveApproval(callId: string, decision: 'once' | 'always' | 'trust' | 'deny'): void {
  const sessionId = useSessionStore.getState().activeId;
  if (!sessionId || !callId) return;
  void resolveRunnerApproval(sessionId, callId, decision).catch(() => undefined);
}

// ===== 待发送队列（流式预输入）：流结束后自动逐条发送，附件随队列项完整保留 =====

/** 入队一条待发消息（流式中的 Enter / 「排队」按钮） */
export function enqueuePending(text: string, attachments: Attachment[] = []): void {
  const st = useSessionStore.getState();
  const sid = st.activeId;
  if (!sid || (!text.trim() && attachments.length === 0)) return;
  st.enqueue(sid, {
    id: `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    text: text.trim(),
    attachments,
    createdAt: Date.now(),
  });
}

/** 派发队首一条（含附件）；返回是否真的派发了。队列串行：下一条由 settle 再触发。 */
export function sendNextPending(): boolean {
  const st = useSessionStore.getState();
  const sid = st.activeId;
  if (!sid) return false;
  const next = st.shiftPending(sid);
  if (!next) return false;
  void sendUserMessage(next.text, next.attachments);
  return true;
}

/** 「全部发送」：第一条立即发，其余在其 settle 后接着发（保持串行，不并发抢占） */
export function flushPendingAll(): void {
  sendNextPending();
}

/** 删除指定队列项 */
export function removePendingItem(itemId: string): void {
  const st = useSessionStore.getState();
  if (st.activeId) st.removePending(st.activeId, itemId);
}

/** 立即发送指定队列项：先中断当前在途流（停止生成），再从队列摘除该项直发。
 *  其余队列项仍按新流的 settle 串行派发。 */
export function sendPendingNow(itemId: string): void {
  const st = useSessionStore.getState();
  const sid = st.activeId;
  if (!sid) return;
  const item = (st.pending[sid] ?? []).find((it) => it.id === itemId);
  if (!item) return;
  st.removePending(sid, itemId);
  interruptChat();
  void sendUserMessage(item.text, item.attachments);
}

/** 编辑队列项：从队列摘除并回填输入框（用户改完再发送/排队；附件保留随队列出栈的语义改为随编辑回填） */
export function editPending(itemId: string): void {
  const st = useSessionStore.getState();
  const sid = st.activeId;
  if (!sid) return;
  const item = (st.pending[sid] ?? []).find((it) => it.id === itemId);
  if (!item) return;
  st.removePending(sid, itemId);
  requestCompose(item.text);
}

/** 清空当前会话待发队列 */
export function clearPending(): void {
  const st = useSessionStore.getState();
  if (st.activeId) st.clearPending(st.activeId);
}

export const chatComponents = { SessionSidebar, MessageStream, ChatInput };

export default chatLitePlugin;
