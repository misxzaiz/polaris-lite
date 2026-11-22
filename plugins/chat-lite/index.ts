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
import { CHANNEL_FILE_BROWSER_COMPOSE, KEY_MOCK_AUTH_SESSION, type LitePlugin, type SlotHostApi, type ChatMessage } from '@sdk';
import { useSessionStore, isToolCard, hasBlocks, setOfflineMode, syncPullNow, CARD_STORE_CAP, type StoreMessage, type ToolCardData, type ToolCardMessage } from './store';
import { useCtxStore, ctxPolicyOf } from './ctxStore';
import type { Attachment } from './attachments';
import { SessionSidebar } from './SessionSidebar';
import { MessageStream } from './MessageStream';
import { ChatInput } from './ChatInput';
import { notifyRootsChanged } from './workspace-prefs';
// 插件自带样式：会话侧栏 / 消息流 / 空态 / Markdown / 工具卡（原先散落在宿主 src/styles.css）
import './chat.css';
// 上下文透视：状态条 + 详情抽屉样式（spec docs/context-insight-plan.md）
import './context.css';

/** 与 mock-auth 的会话镜像键：经 @sdk 契约登记（暗通道收编） */

/**
 * 看门狗只是「疑似卡住」的软提示阈值，不是超时上限，更不是收敛信号。
 * 无人值守场景下，模型长思考 / reasoning / provider 慢都能几十秒无 delta，
 * 因此这里刻意取大值，且超时后只提示、不收敛（收敛只认 message.done / stream.error / 用户停止）。
 * 流式阶段：慢首 token 兜底；工具阶段：多轮审批 + bash 的静默兜底。
 */
const STREAM_IDLE_TIMEOUT_MS = 120_000;
const TOOL_PHASE_TIMEOUT_MS = 600_000;

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
    capabilities: ['cap.ai.chat', 'cap.ai.chat.interrupt', 'cap.agent.loop', 'cap.meta', 'cap.hook.bridge'],
    /** 依赖 AI 引擎提供的流式能力：宿主据此让引擎先于对话 UI 装配 */
    requires: ['cap.ai.chat'],
    // user.prompt：发送时对外广播用户输入原文，供 ai-events 等旁听插件按 messageId 归到同一轮
    // interactive.*：interactive-cards 的交互卡事件；artifact.created：html-preview 等产物插件
    // workspace-renamed：file-browser 改名广播，输入区目录名据此即时同步（不再停留在旧名）
    // mode-changed：standalone-mode 的运行模式广播（独立档切换本地会话镜像，docs/mobile-app-plan.md §10）
    // auth-changed：登录成功立即对账（否则新设备首登要等 30s 轮询才有会话列表）
    events: ['cap.ai.chat:event', 'cap.agent.loop:event', 'user.prompt', 'interactive.created', 'interactive.answered', 'artifact.created', 'workspace-renamed', 'mode-changed', 'auth-changed'],
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
    // ai.usage：real-engine 流末发出（输入/输出 token、缓存命中、耗时、速率分母）
    api.listen('cap.ai.chat:event', (envelope) => {
      const ev = envelope as { kind?: string; payload?: Record<string, unknown> };
      if (ev.kind !== 'ai.usage' || !ev.payload) return;
      const p = ev.payload as { sessionId?: string; inputTokens?: number; outputTokens?: number; durationMs?: number; cachedTokens?: number; cacheCreationTokens?: number; estimated?: boolean; model?: string; contextWindow?: number };
      if (!p.sessionId) return;
      useCtxStore.getState().applyUsage({ ...p, sessionId: p.sessionId });
    });
    // context.*：agent-loop 编排事件（水位快照 / 压缩生命周期）
    api.listen('cap.agent.loop:event', (envelope) => {
      const ev = envelope as { kind?: string; payload?: Record<string, unknown> };
      const kind = ev.kind ?? '';
      const p = (ev.payload ?? {}) as { sessionId?: string; messageId?: string } & Record<string, unknown>;
      if (!p.sessionId) return;
      const store = useCtxStore.getState();
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
    });
  },
};

/** agent-loop 可用性缓存（每次发送时经 cap.meta 刷新，避免装配顺序竞态） */
let loopAvailable: boolean | null = null;

async function detectLoop(): Promise<boolean> {
  if (!hostApi) return false;
  if (loopAvailable !== null) return loopAvailable;
  try {
    const res = await hostApi.dispatch<{ capabilities?: string[] }>({ target: 'cap.meta', action: 'list' });
    loopAvailable = (res.data?.capabilities ?? []).includes('cap.agent.loop');
    console.log('[chat-lite] detectLoop:', loopAvailable, 'caps:', (res.data?.capabilities ?? []).join(','));
  } catch (e) {
    console.log('[chat-lite] detectLoop error:', String(e).slice(0, 100));
    loopAvailable = false;
  }
  return loopAvailable;
}

interface StreamEnvelope {
  kind: string;
  payload?: {
    sessionId?: string;
    messageId?: string;
    delta?: string;
    message?: string;
    interrupted?: boolean;
    finishReason?: string;
    /** 截断提示（agent-loop 发；finish_reason=length 落可见提示块，不静默） */
    reason?: string;
    text?: string;
    /** message.continued：自动续写进度（agent-loop 发；burst 计数） */
    max?: number;
    /** message.done（length 截断）：聚合中被截断的半截工具调用数（不再静默丢弃） */
    partialToolCalls?: number;
    /** stream.retry：断流自动重试进度（real-engine 发，agent-loop 透传） */
    attempt?: number;
    maxAttempts?: number;
    chars?: number;
    // 工具卡事件（cap.agent.loop:event；source='agent-loop' 宿主注入不可伪造）
    callId?: string;
    name?: string;
    command?: string;
    argsJson?: string;
    status?: 'done' | 'error' | 'denied';
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    durationMs?: number;
    truncated?: boolean;
    decision?: 'once' | 'always' | 'trust' | 'deny';
    autoRejected?: boolean;
    turns?: number;
  };
  source?: string;
}

/** 工具块事件处理（仅 loop 模式；块内嵌于 assistant 消息，按 callId 幂等建块/更新） */
function handleToolEvent(
  kind: string,
  inner: NonNullable<StreamEnvelope['payload']>,
  sid: string,
  assistantId: string,
  armPhaseWatchdog: () => void,
): void {
  const st = useSessionStore.getState();
  // 工具阶段（执行/审批）无 delta 流，用长看门狗并逐事件续期，避免误杀在途编排
  armPhaseWatchdog();
  // patchCard 路径不过 trimCard（appendAssistantBlock 才过）——argsJson 在此手动裁剪
  const capArgs = (raw?: string): string | undefined =>
    raw ? (raw.length > CARD_STORE_CAP ? `${raw.slice(0, CARD_STORE_CAP)}…[已截断]` : raw) : undefined;
  const patchCard = (callId: string, patch: (card: ToolCardData) => ToolCardData): void => {
    // 新版：块内嵌于 assistant 消息；旧版（历史会话）：独立 tool 卡消息
    const msg = st.sessions.find((s) => s.id === sid)?.messages.find((m) => m.id === assistantId);
    if (msg && hasBlocks(msg)) {
      const blk = msg.blocks.find((b) => b.type === 'tool' && b.card.callId === callId);
      st.patchAssistantToolBlock(sid, assistantId, callId, patch(blk && blk.type === 'tool' ? blk.card : ({} as ToolCardData)));
      return;
    }
    const legacy = st.sessions.find((s) => s.id === sid)?.messages.find((m) => m.id === `card-${callId}`) as ToolCardMessage | undefined;
    if (legacy) {
      st.updateMessage(sid, legacy.id, { tool: patch(legacy.tool) } as Partial<StoreMessage>);
    }
  };

  if (kind === 'tool.card' || kind === 'tool.approval.required') {
    const callId = inner.callId ?? '';
    const msg = st.sessions.find((s) => s.id === sid)?.messages.find((m) => m.id === assistantId);
    const exists = msg && hasBlocks(msg) && msg.blocks.some((b) => b.type === 'tool' && b.card.callId === callId);
    if (!exists) {
      // 新块（tool.card 先到即建 running 卡）。
      // command 兜底（2026-11-21）：旧版 loop 对语义工具发空串 command——`?? ` 不会
      // 跳过空串，摘要永远空白；改用 `||` 让空串落到 argsJson（ArgsBlock 可折叠细看）。
      st.appendAssistantBlock(sid, assistantId, {
        type: 'tool',
        card: {
          callId,
          name: inner.name ?? 'tool',
          command: inner.command || inner.argsJson,
          argsJson: inner.argsJson,
          status: kind === 'tool.card' ? 'running' : 'awaiting',
        },
      });
      return;
    }
    if (kind === 'tool.approval.required') {
      patchCard(callId, (c) => ({
        ...c,
        status: 'awaiting',
        // 审批事件同样带 display 摘要与原始参数（建卡先于审批到达时在此补齐细节）
        ...(inner.command ? { command: inner.command } : {}),
        ...(inner.argsJson ? { argsJson: capArgs(inner.argsJson) } : {}),
      }));
    }
    return;
  }
  if (kind === 'tool.approval.resolved') {
    patchCard(inner.callId ?? '', (c) => ({
      ...c,
      status: inner.decision === 'deny' ? 'denied' : 'resolved',
      decision: inner.decision,
      // 超时自动拒绝单独标注，便于用户回看时区分「我拒绝的」与「无人值守超时」
      stderr: inner.autoRejected ? '无人值守：120s 无审批，已自动拒绝' : c.stderr,
    }));
    return;
  }
  if (kind === 'tool.result') {
    patchCard(inner.callId ?? '', (c) => ({
      ...c,
      status: inner.status ?? 'error',
      // 终态摘要回填（2026-11-21）：loop 在 tool.result 里带 display 摘要——
      // 建卡阶段没收到 command（旧会话/异常路径）时在这里补齐
      ...(inner.command ? { command: inner.command } : {}),
      stdout: inner.stdout,
      stderr: inner.stderr,
      exitCode: inner.exitCode,
      durationMs: inner.durationMs,
      truncated: inner.truncated,
    }));
    return;
  }
  // 注：interactive.created/answered 不走本通道（interactive-cards 直发普通事件，
  // 非 loop 流转发），监听挂在 setup 里——见 setup 的 onInteractive。
}

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
  const slashMatch = /^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (slashMatch) {
    try {
      // 技能存在性由 skill-loader 的 /api/skills/read 校验（404=不存在）。
      const skillName = slashMatch[1];
      const args = (slashMatch[2] ?? '').trim();
      const resp = await fetch(`/api/skills/read?name=${encodeURIComponent(skillName)}`, { credentials: 'include' });
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

  // loop 模式探测：cap.agent.loop 存在（已启用）则走编排通道，否则回落纯引擎
  const useLoop = await detectLoop();

  // ---- delta 按帧合并（写入 assistant 末尾 text 块；content 镜像由 store 同步） ----
  let buf = '';
  let frame = 0;
  const flushDelta = (): void => {
    if (frame) {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
      frame = 0;
    }
    if (!buf) return;
    const chunk = buf;
    buf = '';
    useSessionStore.getState().appendAssistantBlock(sid, assistantId, { type: 'text', text: chunk });
  };
  const pushDelta = (delta: string): void => {
    buf += delta;
    if (frame) return;
    frame = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(flushDelta)
      : (setTimeout(flushDelta, 16) as unknown as number);
  };

  // ---- 思考流按帧合并（reasoning_content → thinking 块）----
  // 推理模型的思考可能先于正文持续 30s+；把它落成可见块，用户才知道 AI「在动」。
  let rbuf = '';
  let rframe = 0;
  const flushReasoning = (): void => {
    if (rframe) {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rframe);
      rframe = 0;
    }
    if (!rbuf) return;
    const chunk = rbuf;
    rbuf = '';
    useSessionStore.getState().appendAssistantBlock(sid, assistantId, { type: 'thinking', text: chunk });
  };
  const pushReasoning = (delta: string): void => {
    rbuf += delta;
    if (rframe) return;
    rframe = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(flushReasoning)
      : (setTimeout(flushReasoning, 16) as unknown as number);
  };

  // ---- 幂等收敛 + 看门狗 ----
  // 两个 timer 必须独立：流式阶段每帧 delta 会续期短看门狗，若与工具阶段共用一个变量，
  // 工具执行期间偶发的一段模型文本会把长看门狗切回 30s → 误杀在途编排。
  let settled = false;
  let streamWatchdog: ReturnType<typeof setTimeout> | null = null;
  let phaseWatchdog: ReturnType<typeof setTimeout> | null = null;
  let unbind: (() => void) | undefined;
  let idleHintShown = false; // 每条流只提示一次，避免长思考期间反复追加相同文本

  const clearWatchdogs = (): void => {
    if (streamWatchdog) { clearTimeout(streamWatchdog); streamWatchdog = null; }
    if (phaseWatchdog) { clearTimeout(phaseWatchdog); phaseWatchdog = null; }
  };

  /** 真收敛：仅由 message.done / stream.error / 用户主动停止触发；看门狗永不调用 */
  const settle = (): void => {
    if (settled) return;
    settled = true;
    clearWatchdogs();
    flushDelta();
    flushReasoning();
    useSessionStore.getState().updateMessage(sid, assistantId, {
      streaming: false,
      // 收敛时刻：done/error/停止三路统一落，UI 据此显示本轮耗时（endedAt - createdAt）
      endedAt: Date.now(),
    });
    unbind?.();
    sendNextPending(); // 流结束：自动派发队列下一条（若有）
  };

  /**
   * 软提示：超时只告诉用户「仍在等待」，绝不 settle / unbind。
   * 收敛权交给后端权威信号（message.done / stream.error）和用户「停止」——
   * 这样模型长思考或后台长编排期间静默再久，结果到达后仍会被订阅到并落块。
   */
  const showIdleHint = (label: string): void => {
    if (settled || idleHintShown) return;
    idleHintShown = true;
    useSessionStore.getState().appendAssistantBlock(sid, assistantId, {
      type: 'text',
      text: `[运行提示] ${label}暂无新内容，任务可能仍在后台执行；结果到达后会自动更新。如需中止请点「停止」。`,
    });
  };

  /** 流式阶段看门狗：仅慢首 token / 长思考兜底；进入工具阶段后让位 */
  const armWatchdog = (): void => {
    if (phaseWatchdog) return; // 已进入工具阶段：流式看门狗长期让位
    if (streamWatchdog) clearTimeout(streamWatchdog);
    streamWatchdog = setTimeout(() => {
      if (settled) return;
      streamWatchdog = null;
      showIdleHint(`已 ${STREAM_IDLE_TIMEOUT_MS / 1000}s`);
    }, STREAM_IDLE_TIMEOUT_MS);
  };

  /** 工具阶段看门狗：每个 tool.* 事件续期；超时同样只提示不收敛 */
  const armPhaseWatchdog = (): void => {
    if (streamWatchdog) { clearTimeout(streamWatchdog); streamWatchdog = null; }
    if (phaseWatchdog) clearTimeout(phaseWatchdog);
    phaseWatchdog = setTimeout(() => {
      if (settled) return;
      phaseWatchdog = null;
      showIdleHint(`工具阶段已 ${TOOL_PHASE_TIMEOUT_MS / 1000}s`);
    }, TOOL_PHASE_TIMEOUT_MS);
  };

  const handleEnvelope = (payload: unknown): void => {
    const envelope = payload as StreamEnvelope;
    // 来源由宿主取「该 cap 的提供方插件 id」后注入，插件无法伪造；
    // 无来源的事件一律不认（避免核心内部广播被误当流式事件处理）。
    if (!envelope.source) return;
    const inner = envelope.payload ?? {};
    // 精确匹配：会话 + 消息 双重过滤（并发流不串台；loop 的内部轮次 messageId 不同不会误入）
    if (inner.sessionId && inner.sessionId !== sid) return;
    if (inner.messageId && inner.messageId !== assistantId) return;

    // 工具块事件（loop 模式专属）
    if (envelope.kind.startsWith('tool.')) {
      handleToolEvent(envelope.kind, inner, sid, assistantId, armPhaseWatchdog);
      return;
    }

    if (envelope.kind === 'message.reasoning' && inner.delta) {
      armWatchdog(); // 思考流也是活跃信号：长思考期间看门狗持续续期（只软提示不收敛）
      pushReasoning(inner.delta);
    } else if (envelope.kind === 'stream.retry') {
      // 引擎断流自动重试（2026-11-20「突然中断」修复）：页面上可见
      // 「正在重试 N/10」——不写 store（瞬态，重试成功/失败都不留痕在历史），
      // 经重试提示通道通知 MessageStream 渲染瞬态浮层。
      notifyStreamRetry(inner.attempt ?? 0, inner.maxAttempts ?? 10, inner.chars ?? 0);
      armWatchdog(); // 重试也是活跃信号：退避等待期间不让看门狗误报
    } else if (envelope.kind === 'message.truncated') {
      // finish_reason=length 截断且自动续写已耗尽：落 truncated 块（带「继续」按钮兜底）
      useSessionStore.getState().appendAssistantBlock(sid, assistantId, {
        type: 'truncated',
        text: inner.text ?? '回复因达到输出上限被截断',
      });
    } else if (envelope.kind === 'message.continued') {
      // 自动续写进行中（burst N/max）：轻提示块，不打断流式渲染
      armWatchdog();
      useSessionStore.getState().appendAssistantBlock(sid, assistantId, {
        type: 'notice',
        text: `[已自动续写 ${inner.attempt ?? '?'}/${inner.max ?? 3}${inner.reason === 'tool-truncated' ? ' · 工具参数被截断，已引导重试' : inner.reason === 'reasoning-exhausted' ? ' · 思考耗尽预算，已引导直出结论' : ''}]`,
      });
    } else if (envelope.kind === 'message.delta' && inner.delta) {
      armWatchdog();
      pushDelta(inner.delta);
    } else if (envelope.kind === 'message.done') {
      settle();
    } else if (envelope.kind === 'stream.error') {
      flushDelta();
      const detail = (inner as { message?: string }).message ?? '';
      // 会话过期（服务端 401）：清本地镜像并回到登录视图（自动跳登录，无需手动登出）
      if (detail.includes('登录已过期') || detail.includes('SESSION_REQUIRED')) {
        sessionStorage.removeItem(KEY_MOCK_AUTH_SESSION);
        window.location.reload();
        return;
      }
      // 错误信息作为独立 text 块追加（blocks 模式渲染以块为准）
      useSessionStore.getState().appendAssistantBlock(sid, assistantId, {
        type: 'text',
        text: `${detail || '流式请求失败'}`,
      });
      settle();
    }
  };

  // 双通道订阅：普通模式收 cap.ai.chat:event（引擎直达）；
  // loop 模式收 cap.agent.loop:event（loop 转发）。loop 的内部轮次 messageId 不同，不会串台。
  const off = api.listen('cap.ai.chat:event', handleEnvelope);
  const offLoop = useLoop ? api.listen('cap.agent.loop:event', handleEnvelope) : null;
  unbind = () => {
    off();
    offLoop?.();
  };
  armWatchdog(); // 首个 delta 之前就无响应（上游挂住）也能收敛

  await api.dispatch({
    target: useLoop ? 'cap.agent.loop' : 'cap.ai.chat',
    action: 'start',
    payload: {
      sessionId: sid,
      messageId: assistantId,
      prompt: effectiveText,
      history,
      // 会话绑定的文件工作区（agent-loop 据此设置 bash cwd 与 system prompt；缺省=默认 workspace）
      ...(store.sessions.find((s) => s.id === sid)?.workspaceId
        ? { workspaceId: store.sessions.find((s) => s.id === sid)!.workspaceId }
        : {}),
      // 关联只读目录：files 工具可读、bash 不在此执行（服务端仍按登记根白名单校验）
      ...((store.sessions.find((s) => s.id === sid)?.linkedWorkspaceIds?.length ?? 0) > 0
        ? { linkedWorkspaceIds: store.sessions.find((s) => s.id === sid)!.linkedWorkspaceIds }
        : {}),
      // 会话级模型覆盖（会话设置面板写入；缺省=跟随全局默认，引擎行为不变）
      ...((store.sessions.find((s) => s.id === sid)?.providerId || store.sessions.find((s) => s.id === sid)?.modelId)
        ? {
            providerId: store.sessions.find((s) => s.id === sid)!.providerId,
            modelId: store.sessions.find((s) => s.id === sid)!.modelId,
          }
        : {}),
      // 会话级上下文压缩策略（agent-loop 据此触发自动压缩；spec §4.3）
      ...(useLoop ? { ctxPolicy: ctxPolicyOf(sid) } : {}),
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

/** 截断重答共用路径：shadow 复位（loop 模式）→ 截断 msgId 及其后全部 → 按同一提示词重新提交。
 *  用户消息以新 id 重新入列（user.prompt 广播/钩子语义与手打重发完全一致）；代价：shadow 复位
 *  丢弃压缩摘要，上下文按可见历史重播——与刷新页面同代价，仅截断路径发生。 */
async function resubmitFrom(sid: string, userMsgId: string, prompt: string): Promise<void> {
  const useLoop = await detectLoop();
  if (useLoop && hostApi) {
    try {
      await hostApi.dispatch({ target: 'cap.agent.loop', action: 'reset', payload: { sessionId: sid } });
    } catch { /* loop 不可用：直通模式无 shadow，无需复位 */ }
  }
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
    if (await detectLoop()) {
      const res = await api.dispatch<{ found?: boolean }>({
        target: 'cap.agent.loop',
        action: 'interrupt',
        payload: { sessionId, ...(messageId ? { messageId } : {}) },
      });
      // loop 没有在途轮次（found=false）时回落打断引擎直通流
      if (res.ok && res.data?.found !== false) return res;
    }
    return api.dispatch<{ found?: boolean }>({
      target: 'cap.ai.chat.interrupt',
      action: 'interrupt',
      payload: { sessionId },
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
 * 轻量监听：只处理 delta/reasoning/continued/truncated/done/error 六类事件，
 * 不带 sendUserMessage 的完整看门狗机制（超时软兜底复位 streaming）。
 */
export function resumeTruncated(sessionId: string, messageId: string): void {
  const api = hostApi;
  if (!api) return;
  const st = useSessionStore.getState();
  const msg = st.sessions.find((s) => s.id === sessionId)?.messages.find((m) => m.id === messageId);
  if (!msg || isToolCard(msg) || msg.streaming) return; // 幂等：流式中不重复触发
  st.updateMessage(sessionId, messageId, { streaming: true });

  const finish = (): void => {
    useSessionStore.getState().updateMessage(sessionId, messageId, { streaming: false });
  };
  const timer = setTimeout(() => {
    cleanup();
    finish();
  }, RESUME_TIMEOUT_MS);
  const off = api.listen('cap.agent.loop:event', (payload: unknown) => {
    const envelope = payload as StreamEnvelope;
    if (!envelope.source) return;
    const inner = envelope.payload ?? {};
    if (inner.sessionId && inner.sessionId !== sessionId) return;
    if (inner.messageId && inner.messageId !== messageId) return;
    if (envelope.kind === 'message.delta' && inner.delta) {
      useSessionStore.getState().appendAssistantBlock(sessionId, messageId, { type: 'text', text: inner.delta });
    } else if (envelope.kind === 'message.reasoning' && inner.delta) {
      useSessionStore.getState().appendAssistantBlock(sessionId, messageId, { type: 'thinking', text: inner.delta });
    } else if (envelope.kind === 'message.continued') {
      useSessionStore.getState().appendAssistantBlock(sessionId, messageId, { type: 'notice', text: `[已自动续写 ${inner.attempt ?? '?'}/${inner.max ?? 3}]` });
    } else if (envelope.kind === 'message.truncated') {
      useSessionStore.getState().appendAssistantBlock(sessionId, messageId, { type: 'truncated', text: inner.text ?? '回复因达到输出上限被截断' });
    } else if (envelope.kind === 'message.done') {
      cleanup();
      finish();
    } else if (envelope.kind === 'stream.error') {
      useSessionStore.getState().appendAssistantBlock(sessionId, messageId, { type: 'text', text: inner.message ?? '流式请求失败' });
      cleanup();
      finish();
    }
  });
  const cleanup = (): void => {
    off();
    clearTimeout(timer);
  };
  void api.dispatch({
    target: 'cap.agent.loop',
    action: 'resume',
    payload: { sessionId, messageId },
  }).catch(() => {
    cleanup();
    finish();
  });
}

/** 审批决策回填（ToolCard 按钮调用；仅 loop 模式会出现审批卡） */
export function resolveApproval(callId: string, decision: 'once' | 'always' | 'trust' | 'deny'): void {
  const api = hostApi;
  const sessionId = useSessionStore.getState().activeId;
  if (!api || !sessionId || !callId) return;
  void api
    .dispatch({ target: 'cap.agent.loop', action: 'resolveApproval', payload: { sessionId, callId, decision } })
    .catch(() => undefined);
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
