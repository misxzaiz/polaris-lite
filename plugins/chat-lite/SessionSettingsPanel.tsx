/**
 * SessionSettingsPanel：会话设置面板（浮层形态）。
 *
 * 为什么是浮层不是内联抽屉：分区（模型/执行/队列/分享）整体高度 ~400px+，内联在
 * 输入条里会被 .shell-input 的 42dvh 上限 + overflow:hidden 裁剪——轻则盖住发送按钮，
 * 重则压成内滚小窗展示不全（2026-11-22 两轮冒烟实测）。浮层锚在输入条上方、用消息区
 * 空间完整展示，与工作目录浮层（chat-ws-pop）同一形态：portal 到 body + absolute
 * 定位（插件 CSS 门禁禁 fixed，宿主满屏布局下 absolute 贴底等价视口定位）。
 *
 * 关闭通道：点「完成」/ 点面板外 / Esc（document 级，焦点无关）。
 * 模型选择浮层：叠在面板同位（bottom 对齐面板底缘），选中不自动关。
 * 数据源：同源 HTTP /api/providers/list（chat-lite 无 cap.model.admin 授权面，走 HTTP 免 grants）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CHANNEL_PANEL_INTENT, CHANNEL_DRAWER_EVENT, CHANNEL_DRAWER_STATE, type AiEngineInfo } from '@sdk';
import { type PendingSend } from './store';
import { ShareDrawerRows } from './ShareDrawer';
import { ChevronRightIcon } from './icons';
import { SRV } from './serverApi';

// ---- 抽屉状态桥（与 workspace-layout/stateBridge 同纪律，chat-lite 就地轻量实现）----
// 通道名经 @sdk 登记；防环纪律：监听方只同步本地订阅者，**不得**再派发。
type Drawer = 'none' | 'sidebar' | 'panel';

function readDrawer(): Drawer {
  if (typeof window === 'undefined') return 'none';
  const w = window as unknown as Record<string, unknown>;
  const d = w[CHANNEL_DRAWER_STATE] as Drawer | undefined;
  return d && ['none', 'sidebar', 'panel'].includes(d) ? d : 'none';
}

/** 订阅抽屉变化（宿主顶栏按钮 / 本面板按钮 / workspace-layout 布局树共享同一状态） */
function subscribeDrawer(fn: (d: Drawer) => void): () => void {
  const onEv = (e: Event): void => {
    const d = (e as CustomEvent<Drawer>).detail;
    if (d && ['none', 'sidebar', 'panel'].includes(d)) fn(d);
  };
  window.addEventListener(CHANNEL_DRAWER_EVENT, onEv);
  return () => window.removeEventListener(CHANNEL_DRAWER_EVENT, onEv);
}

/** 切换抽屉：写通道 + 派发事件（宿主 shellState 监听同步，不再二次派发） */
function toggleDrawer(target: 'sidebar' | 'panel'): void {
  const cur = readDrawer();
  const next: Drawer = cur === target ? 'none' : target;
  const w = window as unknown as Record<string, unknown>;
  w[CHANNEL_DRAWER_STATE] = next;
  window.dispatchEvent(new CustomEvent(CHANNEL_DRAWER_EVENT, { detail: next }));
}

/** 面板直达：展开右栏抽屉并派发面板意图（宿主 SlotOutlet 按 title 切激活）。
 *  通道名经 @sdk 契约常量（CHANNEL_PANEL_INTENT），与 notification-center 的
 *  requestPanel 同一链路；title 必须与目标面板 contributes.slots[].title 一致。 */
function openPanelDirect(title: string): void {
  const w = window as unknown as Record<string, unknown>;
  w[CHANNEL_DRAWER_STATE] = 'panel';
  window.dispatchEvent(new CustomEvent(CHANNEL_DRAWER_EVENT, { detail: 'panel' }));
  window.dispatchEvent(new CustomEvent(CHANNEL_PANEL_INTENT, { detail: { slot: 'panel', title } }));
}

/** /api/providers/list 的 masked 供应商行（面板只取需要的字段） */
interface ProviderEntry {
  id: string;
  name: string;
  hasKey: boolean;
  enabled: boolean;
  isDefault: boolean;
  activeModel: string;
  models: { id: string }[];
}

/** 弹层定位形态（bottom 贴住锚点上方） */
interface PopupPos { left: number; width: number; bottom: number; maxHeight: number }

/* ---------------- 长期记忆分区（自包含：同 ShareDrawerRows 形态，ChatInput 零传参）-----
 * 读写走同源 HTTP（SRV.longMemory，经 serverApi.ts 登记——chat-lite 的唯一跨插件
 * HTTP 出处纪律）。开关语义：关闭=停用注入与写入、记忆保留不清空（文案明示，防
 * 「我关了它怎么还记得」的惊吓时刻）。服务不可达（插件未装/禁用）时整分区隐藏
 * ——「插件被禁用 → 端点消失」是 P0-4 的兜底语义，不算 bug。 */
function MemoryRows(): JSX.Element | null {
  const [info, setInfo] = useState<{ enabled: boolean; count: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const r = await fetch(`${SRV.longMemory}/settings`, { credentials: 'include' });
      if (!r.ok) return;
      const s = await r.json();
      if (s && typeof s.enabled === 'boolean') setInfo({ enabled: !!s.enabled, count: Number(s.count) || 0 });
    } catch { /* 插件未装/禁用：分区隐藏 */ }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const toggle = async (): Promise<void> => {
    if (!info || busy) return;
    setBusy(true);
    try {
      const r = await fetch(`${SRV.longMemory}/settings`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !info.enabled }),
      });
      const next = await r.json().catch(() => null);
      if (next && typeof next.enabled === 'boolean') setInfo({ enabled: !!next.enabled, count: info.count });
    } catch { /* 切换失败：保持原状 */ }
    setBusy(false);
  };

  if (!info) return null;

  return (
    <div className="chat-assistant-row">
      <span className="chat-assistant-key">长期记忆</span>
      <button
        className={`chat-trust-chip ${info.enabled ? 'trusted' : ''}`}
        onClick={() => void toggle()}
        disabled={busy}
        aria-pressed={info.enabled}
        title={info.enabled
          ? '已开启：新对话注入既有记忆，AI 主动记录值得记住的信息。点击关闭（仅停用，记忆保留不清空）'
          : '点击开启：AI 记得你们聊过的偏好/决定/配置选择，并在后续对话中运用'}
      >
        {info.enabled ? `已开启 · ${info.count} 条` : '关闭'}
      </button>
      <span className="chat-row-aux" title="在「记忆」面板查看/编辑/导出/清空记忆条目">仅停用不清空</span>
    </div>
  );
}

/* ---------------- 循环护栏分区（自包含：同 MemoryRows 形态，ChatInput 零传参）-----
 * agent-runner runLoop 的轮数/工具调用次数上限（此前写死 40/80）。读写走同源 HTTP
 * （SRV.agent/guardrail，会话 cookie；agent-runner 已在 serverApi.ts 登记，无新耦合）。
 * 语义：开启 = run 达到上限后注入系统提示词并引导收敛（防失控空转烧 token）；关闭 =
 * 不设上限，跑到模型收敛或用户中断。配置存 kv（agent-runner/guardrail），run 发起时
 * 快照——进行中的 run 不受中途修改影响，下个 run 生效。
 * 服务不可达（agent-runner 未装/禁用）时整分区隐藏（P0-4 兜底语义，同 MemoryRows）。 */
interface GuardrailCfg {
  enabled: boolean;
  maxTurns: number;
  maxToolCalls: number;
  defaults: { maxTurns: number; maxToolCalls: number };
}

function GuardrailRows(): JSX.Element | null {
  const [cfg, setCfg] = useState<GuardrailCfg | null>(null);
  const [busy, setBusy] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);

  const load = useCallback(async (): Promise<void> => {
    try {
      const r = await fetch(`${SRV.agent}/guardrail`, { credentials: 'include' });
      if (!r.ok) return;
      const j = await r.json();
      if (j && typeof j.enabled === 'boolean') {
        setCfg({
          enabled: !!j.enabled,
          maxTurns: Number(j.maxTurns) || 40,
          maxToolCalls: Number(j.maxToolCalls) || 80,
          defaults: {
            maxTurns: Number(j.defaults?.maxTurns) || 40,
            maxToolCalls: Number(j.defaults?.maxToolCalls) || 80,
          },
        });
      }
    } catch { /* 插件未装/禁用：分区隐藏 */ }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /** 全量保存（服务端归一化夹紧后回读，以响应为准回填本地态） */
  const save = useCallback(async (next: { enabled: boolean; maxTurns: number; maxToolCalls: number }): Promise<void> => {
    setBusy(true);
    try {
      const r = await fetch(`${SRV.agent}/guardrail`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      const j = await r.json().catch(() => null);
      if (j && typeof j.enabled === 'boolean') {
        setCfg((c) => c && ({
          enabled: !!j.enabled,
          maxTurns: Number(j.maxTurns) || c.maxTurns,
          maxToolCalls: Number(j.maxToolCalls) || c.maxToolCalls,
          defaults: c.defaults,
        }));
      }
    } catch { /* 保存失败：保持原状 */ }
    setBusy(false);
  }, []);

  /** 数字输入：本地即时回显（夹紧上限，下限留给失焦兜底），500ms 防抖落盘——连续点步进器只发一次请求 */
  const editNum = (key: 'maxTurns' | 'maxToolCalls', raw: string, hi: number): void => {
    if (!cfg) return;
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n) || n < 1) return;
    setCfg({ ...cfg, [key]: Math.min(hi, n) });
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void save({ ...cfg, [key]: Math.min(hi, n) }); }, 500);
  };

  /** 失焦兜底：夹紧回合法区间并立即落盘（取消挂起的防抖，避免旧值覆盖新值） */
  const commitNum = (key: 'maxTurns' | 'maxToolCalls', lo: number, hi: number): void => {
    if (!cfg) return;
    const n = Math.max(lo, Math.min(hi, Math.round(cfg[key]) || lo));
    setCfg({ ...cfg, [key]: n });
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    void save({ ...cfg, [key]: n });
  };

  if (!cfg) return null;

  const custom = cfg.maxTurns !== cfg.defaults.maxTurns || cfg.maxToolCalls !== cfg.defaults.maxToolCalls;

  return (
    <>
      <div className="chat-assistant-row">
        <span className="chat-assistant-key">循环护栏</span>
        <button
          className={`chat-trust-chip ${cfg.enabled ? 'trusted' : ''}`}
          onClick={() => void save({ ...cfg, enabled: !cfg.enabled })}
          disabled={busy}
          aria-pressed={cfg.enabled}
          title={cfg.enabled
            ? '已开启：AI 连续工作达到上限（轮数/工具调用次数）后收到系统提示并收敛，防失控空转烧 token。点击关闭（不设次数上限）'
            : '已关闭：AI 可持续调用工具直到任务完成或手动中断（注意 token 消耗失控风险）。点击开启'}
        >
          {cfg.enabled ? `已开启 · ${cfg.maxTurns}轮/${cfg.maxToolCalls}次` : '已关闭（不限）'}
        </button>
        <span className="chat-row-aux" title="达到上限会注入系统提示并引导 AI 给出结论，而不是无限继续">防失控空转</span>
      </div>
      <div className="chat-assistant-row">
        <span className="chat-assistant-key">轮数</span>
        <input
          className="chat-guard-num"
          type="number"
          inputMode="numeric"
          min={1}
          max={1000}
          value={cfg.maxTurns}
          disabled={busy || !cfg.enabled}
          onChange={(e) => editNum('maxTurns', e.target.value, 1000)}
          onBlur={() => commitNum('maxTurns', 1, 1000)}
          title="单次任务最多连续对话轮数（每轮可含多个工具调用）"
        />
        <span className="chat-assistant-key">次数</span>
        <input
          className="chat-guard-num"
          type="number"
          inputMode="numeric"
          min={1}
          max={10000}
          value={cfg.maxToolCalls}
          disabled={busy || !cfg.enabled}
          onChange={(e) => editNum('maxToolCalls', e.target.value, 10000)}
          onBlur={() => commitNum('maxToolCalls', 1, 10000)}
          title="单次任务最多工具调用总次数"
        />
        {custom && (
          <button
            className="chat-model-reset"
            onClick={() => void save({ ...cfg, maxTurns: cfg.defaults.maxTurns, maxToolCalls: cfg.defaults.maxToolCalls })}
            title={`恢复默认（${cfg.defaults.maxTurns} 轮 / ${cfg.defaults.maxToolCalls} 次）`}
          >
            恢复默认
          </button>
        )}
      </div>
    </>
  );
}

interface SessionSettingsPanelProps {
  // ---- 会话标题（头部展示；未设置=「新会话」时回退用户第一句）----
  sessionTitle: string;
  // ---- AI 引擎（会话级：undefined=默认引擎；列表来自 cap.ai.engine 注册表）----
  engineId: string | undefined;
  engines: AiEngineInfo[];
  onSetSessionEngine: (engineId: string | undefined) => void;
  /** 自带目录引擎的模型/变体（语义由引擎解释；缺省用引擎默认） */
  option: string | undefined;
  onSetSessionOption: (option: string | undefined) => void;
  // ---- 模型（会话级覆盖；undefined=跟随全局默认）----
  providerId: string | undefined;
  modelId: string | undefined;
  onSetSessionModel: (providerId: string | undefined, modelId: string | undefined) => void;
  // ---- 新会话默认（模型分区底部：把引擎/供应商/模型/自带变体快照为新建会话默认）----
  /** 当前会话配置 == 已记住的默认（无会话时为 false） */
  defaultsActive: boolean;
  /** 已记住任意一项默认（用于区分「跟随全局」与「另有默认」） */
  hasAnyDefault: boolean;
  /** 无会话时禁用：还没有可记忆的配置 */
  hasSession: boolean;
  onToggleDefaults: () => void;
  // ---- 工作区 ----
  workspaceId: string | null;
  wsLabel: string | null;
  wsMissing: boolean;
  linkedCount: number;
  onOpenWorkspacePicker: () => void;
  // ---- 执行模式 ----
  trustMode: boolean | null;
  trustTitle: string;
  trustLabel: string;
  onToggleTrust: () => void;
  // ---- 待发队列 ----
  queueLen: number;
  queueItems: PendingSend[];
  onClearPending: () => void;
  onSendPendingNow: (id: string) => void;
  onEditPending: (id: string) => void;
  onRemovePendingItem: (id: string) => void;
  // ---- 定位与关闭协作（宿主输入条锚点、各浮层 ref 均在 ChatInput）----
  barRef: React.RefObject<HTMLDivElement>;
  /** 面板浮层根（ChatInput 持有：工作目录浮层按它定位、点它内部不算面板外） */
  popRef: React.RefObject<HTMLDivElement>;
  /** 工作目录选择浮层根（点它内部不算面板外） */
  wsPopRef: React.RefObject<HTMLDivElement>;
  /** 关闭面板（完成 / 点外 / Esc 共用） */
  onDone: () => void;
  /** Esc 分级退出注册：面板内模型浮层打开时返回 true 表示已消费（ChatInput 的 Esc 链先调它） */
  escRef: React.MutableRefObject<() => boolean>;
}

export function SessionSettingsPanel(props: SessionSettingsPanelProps) {
  const {
    sessionTitle,
    engineId, engines, onSetSessionEngine, option, onSetSessionOption,
    providerId, modelId, onSetSessionModel,
    defaultsActive, hasAnyDefault, hasSession, onToggleDefaults,
    workspaceId, wsLabel, wsMissing, linkedCount, onOpenWorkspacePicker,
    trustMode, trustTitle, trustLabel, onToggleTrust,
    queueLen, queueItems, onClearPending, onSendPendingNow, onEditPending, onRemovePendingItem,
    barRef, popRef, wsPopRef, onDone, escRef,
  } = props;

  // ---- 供应商列表（打开浮层时现拉，payload 小、免陈旧）----
  const [providers, setProviders] = useState<ProviderEntry[] | null>(null);
  const [defaultProviderId, setDefaultProviderId] = useState<string | null>(null);
  const [providersErr, setProvidersErr] = useState(false);
  /** 选择浮层：null=关；engine=选引擎；provider/model=应用供应商模型；option=自带目录模型 */
  const [modelPop, setModelPop] = useState<null | 'engine' | 'provider' | 'model' | 'option'>(null);
  /** 面板定位（贴输入条上方）与模型浮层定位（叠面板同位）——两个状态分开，
   *  否则 resize 时两个跟随 listener 会互相覆盖对方的定位口径 */
  const [panelPos, setPanelPos] = useState<PopupPos | null>(null);
  const [modelPos, setModelPos] = useState<PopupPos | null>(null);
  const modelPopRef = useRef<HTMLDivElement>(null);

  // ---- 面板定位：贴住输入条上方（挂载即定位 + 视口变化跟随）----
  useEffect(() => {
    const update = () => {
      const bar = barRef.current?.getBoundingClientRect();
      if (!bar) return;
      const gap = 8;
      setPanelPos({
        left: Math.max(8, bar.left),
        width: Math.min(bar.width, 520),
        bottom: Math.max(gap, window.innerHeight - bar.top + gap),
        maxHeight: Math.max(200, bar.top - gap * 2),
      });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [barRef]);

  const loadProviders = async () => {
    setProviders(null);
    setProvidersErr(false);
    try {
      const r = await fetch(`${SRV.providers}/list`, { credentials: 'include', cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { configs?: ProviderEntry[]; activeId?: string | null };
      setProviders((j.configs ?? []).filter((c) => c.enabled && c.hasKey));
      setDefaultProviderId(j.activeId ?? null);
    } catch {
      setProvidersErr(true);
    }
  };

  /** 模型浮层定位：与面板同位叠放（bottom 对齐面板底缘，顶到可用空间上限） */
  const computeModelPos = (): PopupPos | null => {
    const bar = barRef.current?.getBoundingClientRect();
    if (!bar) return null;
    const gap = 8;
    return {
      left: Math.max(8, bar.left),
      width: Math.min(bar.width, 520),
      bottom: Math.max(gap, window.innerHeight - bar.top + gap),
      maxHeight: Math.max(180, bar.top - gap * 2),
    };
  };

  // ---- 抽屉状态（头部左右展开按钮的高亮源）----
  const [drawer, setDrawerState] = useState<Drawer>(readDrawer);
  useEffect(() => subscribeDrawer(setDrawerState), []);

  // ---- 通知未读数（notification-center 广播 notifications-changed；无插件时静默为 0）----
  const [notifUnread, setNotifUnread] = useState(0);
  useEffect(() => {
    let alive = true;
    const read = async (): Promise<void> => {
      try {
        const raw = localStorage.getItem('plite.slot.active.panel');
        void raw; // 激活键与本行无关；读 inbox 走 kv HTTP（与面板同源）
        const r = await fetch(`${SRV.kv}/get?namespace=notification-center&key=inbox`, { credentials: 'include' });
        if (!r.ok) return;
        const j = (await r.json()) as { value?: { read?: boolean }[] | null };
        const list = Array.isArray(j.value) ? j.value : [];
        if (alive) setNotifUnread(list.filter((n) => !n.read).length);
      } catch { /* 无数据/未登录：保持 0 */ }
    };
    void read();
    const onChanged = (): void => { void read(); };
    window.addEventListener('notifications-changed', onChanged);
    return () => {
      alive = false;
      window.removeEventListener('notifications-changed', onChanged);
    };
  }, []);

  const openModelPop = (kind: 'engine' | 'provider' | 'model' | 'option') => {
    setModelPos(computeModelPos());
    setModelPop(kind);
    if (kind === 'provider' || kind === 'model') void loadProviders();
  };

  // 点空白关闭（面板与模型浮层共用一处理：浮层内部 / 输入条 / 工作目录浮层内的点击不算外）
  // + Esc 关闭（document 级：点过 chip 后焦点不在 textarea，textarea Esc 链收不到）。
  // Esc 分级：先收模型浮层，再收面板。
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || modelPopRef.current?.contains(t)) return;
      if (barRef.current?.contains(t) || wsPopRef.current?.contains(t)) return;
      if (modelPop) { setModelPop(null); return; }
      onDone();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (modelPop) { setModelPop(null); return; }
      onDone();
    };
    const update = () => {
      if (modelPop) setModelPos(computeModelPos());
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [modelPop, popRef, modelPopRef, barRef, wsPopRef, onDone]);

  // Esc 分级退出（textarea 焦点链）：模型浮层打开时先收它（返回 true 让 ChatInput 停手）
  useEffect(() => {
    escRef.current = () => {
      if (modelPop) { setModelPop(null); return true; }
      return false;
    };
    return () => { escRef.current = () => false; };
  }, [modelPop, escRef]);

  // ---- 名称解析：会话覆盖优先，缺省跟随全局默认（显示实际生效值，不是空白）----
  const activeEntry = providerId ? (providers?.find((p) => p.id === providerId) ?? null) : null;
  const sourceEntry = activeEntry ?? providers?.find((p) => p.id === defaultProviderId) ?? null;
  const providerName = providerId ? (activeEntry?.name ?? providerId) : null;
  const effectiveModel = modelId ?? sourceEntry?.activeModel ?? null;

  // 引擎形态完全由注册表声明决定：没有写死的引擎 id，也没有专属字段。
  const currentEngine = engines.find((e) => e.id === engineId);
  const modelSource = currentEngine?.modelSource ?? 'app'; // 默认引擎按「适配应用供应商」处理
  const engineModels = currentEngine?.models ?? [];
  const engineDisabled = engines.length === 0 || currentEngine?.available === false;

  if (!panelPos) return null;

  return createPortal(
    <>
      {/* 面板本体：chat-ws-pop 同款卡片（absolute + body 定位） */}
      <div
        ref={popRef}
        className="chat-ws-pop chat-settings-pop"
        role="dialog"
        aria-label="会话设置"
        style={{ left: panelPos.left, bottom: panelPos.bottom, width: panelPos.width, maxHeight: panelPos.maxHeight }}
      >
        <div className="chat-picker-head chat-settings-head">
          <span className="chat-picker-title">会话设置</span>
          {/* 会话标题展示：未设置（「新会话」）时回退用户第一句（SessionSidebar displayTitle 同款口径） */}
          <span className="chat-pop-title" title={sessionTitle}>{sessionTitle}</span>
          {/* 左右侧栏展开按钮：段控形态（图标+文字），热区更大、含义自解释。
              经 window 抽屉通道与宿主顶栏按钮/布局树共享同一状态；点已展开侧再点即收起 */}
          <button
            type="button"
            className={`side-toggle ${drawer === 'sidebar' ? 'on' : ''}`}
            onClick={() => toggleDrawer('sidebar')}
            title={drawer === 'sidebar' ? '收起左侧边栏' : '展开左侧边栏'}
            aria-label={drawer === 'sidebar' ? '收起左侧边栏' : '展开左侧边栏'}
            aria-pressed={drawer === 'sidebar'}
          >
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true">
              <rect x="3" y="4" width="7" height="16" rx="1.5" stroke="currentColor" strokeWidth="1.8" />
              <line x1="13" y1="12" x2="21" y2="12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              <path d="M18.2 8.6 L21.6 12 L18.2 15.4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </svg>
            <span>左栏</span>
          </button>
          <button
            type="button"
            className={`side-toggle ${drawer === 'panel' ? 'on' : ''}`}
            onClick={() => toggleDrawer('panel')}
            title={drawer === 'panel' ? '收起右侧边栏' : '展开右侧边栏'}
            aria-label={drawer === 'panel' ? '收起右侧边栏' : '展开右侧边栏'}
            aria-pressed={drawer === 'panel'}
          >
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true">
              <rect x="14" y="4" width="7" height="16" rx="1.5" stroke="currentColor" strokeWidth="1.8" />
              <line x1="11" y1="12" x2="3" y2="12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              <path d="M5.8 8.6 L2.4 12 L5.8 15.4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </svg>
            <span>右栏</span>
          </button>
          <button className="chat-picker-done" onClick={onDone}>完成</button>
        </div>
        <div className="chat-settings-body">
          {/* ===== 模型（会话级覆盖）===== */}
          <div className="chat-assistant-sec">模型</div>
          {/* AI 引擎行：列表来自 cap.ai.engine（各引擎插件的 manifest 声明），
              chat-lite 不认识任何具体引擎 id；默认引擎即「跟随全局」。 */}
          <div className="chat-assistant-row">
            <span className="chat-assistant-key">AI 引擎</span>
            <button
              className={`chat-ws-chip chat-model-chip ${engineId ? 'pinned' : ''}`}
              onClick={() => openModelPop('engine')}
              disabled={engines.length === 0}
              title={engines.length === 0
                ? '没有已注册的 AI 引擎插件'
                : `${currentEngine?.displayName ?? '默认引擎'}（点击切换）`}
            >
              {currentEngine?.displayName ?? '默认'}
            </button>
            {engineDisabled && <span className="chat-row-aux" title="当前引擎不可用">不可用</span>}
          </div>
          {modelSource === 'none' ? (
            <div className="chat-assistant-row">
              <span className="chat-assistant-key">模型</span>
              <span className="chat-assistant-val">该引擎无模型概念</span>
            </div>
          ) : modelSource === 'builtin' ? (
            /* 自带目录引擎：模型清单由引擎自己暴露（CLI health / 静态声明），无供应商概念 */
            <div className="chat-assistant-row">
              <span className="chat-assistant-key">模型</span>
              <button
                className={`chat-ws-chip chat-model-chip ${option ? 'pinned' : ''}`}
                onClick={() => openModelPop('option')}
                title="选择本对话使用的引擎模型（清单由引擎插件提供）"
              >
                {option ?? '默认'}
              </button>
              {option && (
                <button
                  className="chat-model-reset"
                  onClick={() => onSetSessionOption(undefined)}
                  title="清除选择，回到引擎默认模型"
                >
                  恢复默认
                </button>
              )}
            </div>
          ) : (
          <div className="chat-assistant-row">
            <span className="chat-assistant-key">供应商</span>
            <button
              className={`chat-ws-chip chat-model-chip ${providerId ? 'pinned' : ''}`}
              onClick={() => openModelPop('provider')}
              title="选择本对话使用的模型供应商（会话级，不影响其他对话）"
            >
              {providerName ?? '默认'}
            </button>
            <span className="chat-assistant-key">模型</span>
            <button
              className={`chat-ws-chip chat-model-chip ${modelId ? 'pinned' : ''}`}
              onClick={() => openModelPop('model')}
              title="选择本对话使用的模型（会话级；未指定时跟随所选供应商默认）"
            >
              {effectiveModel ?? '默认'}
            </button>
            {(providerId || modelId) && (
              <button
                className="chat-model-reset"
                onClick={() => onSetSessionModel(undefined, undefined)}
                title="清除会话级覆盖，回到跟随全局默认"
              >
                恢复默认
              </button>
            )}
          </div>
          )}

          {/* 新会话默认：把上面的 modelRef（引擎/供应商/模型/自带变体）快照为新建会话默认。
              全空时快照即「跟随全局」，仍可显式记住；再点一次取消回到跟随全局。
              与工作区「设为新对话默认」同一形态：本地偏好，新会话继承后随会话 JSON 上云。 */}
          <button
            type="button"
            className={`chat-assistant-row chat-row-btn chat-default-row ${defaultsActive ? 'on' : ''}`}
            onClick={onToggleDefaults}
            disabled={!hasSession}
            title={defaultsActive
              ? '点击取消记住：新会话恢复跟随全局默认'
              : '记住上面的引擎/模型配置，作为新会话默认'}
          >
            <span className="chat-assistant-key">新会话默认</span>
            <span className={`chat-ws-chip ${defaultsActive ? 'pinned' : ''}`}>
              {defaultsActive ? '已记住当前配置' : hasAnyDefault ? '更新为当前配置' : '记住当前配置'}
            </span>
            <span className="chat-row-aux">
              {defaultsActive ? '新会话沿用' : hasAnyDefault ? '另有默认' : '跟随全局'}
            </span>
          </button>

          {/* ===== 执行：工作目录（打开现有选择浮层，浮层不自动关）+ 执行模式 ===== */}
          <div className="chat-assistant-sec">执行</div>
          <button
            className="chat-assistant-row chat-row-btn"
            onClick={onOpenWorkspacePicker}
            title="选择本对话的工作目录（AI 命令在此执行）"
          >
            <span className="chat-assistant-key">工作目录</span>
            <span className={`chat-ws-chip ${workspaceId ? 'pinned' : ''} ${wsMissing ? 'invalid' : ''}`}>
              {workspaceId ? (wsMissing ? '已失效' : (wsLabel ?? '…')) : '默认目录'}
            </span>
            {linkedCount > 0 && (
              <span className="chat-row-aux" title="关联只读目录">+{linkedCount}</span>
            )}
            <span className="chat-assistant-go" aria-hidden="true"><ChevronRightIcon /></span>
          </button>
          {trustMode !== null && (
            <div className="chat-assistant-row">
              <span className="chat-assistant-key">执行模式</span>
              <button
                className={`chat-trust-chip ${trustMode ? 'trusted' : ''}`}
                onClick={() => void onToggleTrust()}
                title={trustTitle}
                aria-pressed={trustMode}
              >
                {trustLabel}
              </button>
            </div>
          )}
          {/* 循环护栏（agent-runner runLoop 上限配置；服务不可达时整分区隐藏） */}
          <GuardrailRows />

          {/* ===== 长期记忆：全局开关（long-memory 插件 HTTP；不可达=分区隐藏）===== */}
          <div className="chat-assistant-sec">记忆</div>
          <MemoryRows />

          {/* ===== 待发队列 ===== */}
          <div className="chat-assistant-sec">待发队列</div>
          {queueLen === 0 ? (
            <div className="chat-assistant-row">
              <span className="chat-assistant-key">待发队列</span>
              <span className="chat-assistant-val">无</span>
            </div>
          ) : (
            <div className="chat-queue-list">
              <div className="chat-assistant-row">
                <span className="chat-assistant-key">待发队列（{queueLen}）</span>
                <span className="chat-assistant-val" />
                <button className="chat-queue-clear" onClick={onClearPending} title="清空待发队列">清空</button>
              </div>
              {queueItems.map((it) => (
                <div key={it.id} className="chat-queue-item">
                  <span className="chat-queue-text" title={it.text}>{it.text}</span>
                  <span className="chat-queue-acts">
                    <button className="chat-queue-act" onClick={() => onSendPendingNow(it.id)} title="立即发送（跳过排队顺序）">立即发</button>
                    <button className="chat-queue-act" onClick={() => onEditPending(it.id)} title="取回输入框编辑">编辑</button>
                    <button className="chat-queue-act danger" onClick={() => onRemovePendingItem(it.id)} title="删除">删除</button>
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* ===== 消息通知：通知中心入口行（面板直达：点开右栏并停到「通知」Tab）===== */}
          <div className="chat-assistant-sec">通知</div>
          <button
            className="chat-assistant-row chat-row-btn chat-notify-row"
            onClick={() => openPanelDirect('通知')}
            title="打开通知中心：历史、未读与全部已读"
          >
            <span className="chat-notif-ico" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none">
                <path d="M18 8a6 6 0 1 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M10.3 21a2 2 0 0 0 3.4 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
              {notifUnread > 0 && <span className="chat-notif-badge">{notifUnread > 99 ? '99+' : notifUnread}</span>}
            </span>
            <span className="chat-assistant-key">消息通知</span>
            <span className="chat-notif-sum">{notifUnread > 0 ? `${notifUnread} 条未读` : '无未读'}</span>
            <span className="chat-assistant-go" aria-hidden="true"><ChevronRightIcon /></span>
          </button>

          {/* ===== 分享（needs #069 v3）：网页链接（token+有效期）+ 本地导出（个人版 md / AI 分析版）。
              同源 HTTP 直连 transcript-share server 半边，无跨插件 cap 授权面。 ===== */}
          <div className="chat-assistant-sec">分享</div>
          <ShareDrawerRows />
        </div>
      </div>

      {/* 模型选择浮层：与面板同位叠放（同 bottom 锚点），关闭后回到面板 */}
      {modelPop && modelPos && createPortal(
        <div
          ref={modelPopRef}
          className="chat-ws-pop chat-model-pop"
          role="dialog"
          aria-label={modelPop === 'engine' ? '选择 AI 引擎' : modelPop === 'provider' ? '选择模型供应商' : '选择模型'}
          style={{ left: modelPos.left, bottom: modelPos.bottom, width: modelPos.width, maxHeight: modelPos.maxHeight }}
        >
          <div className="chat-picker-head">
            <span className="chat-picker-title">
              {modelPop === 'engine' ? '选择 AI 引擎（会话级）' : modelPop === 'provider' ? '选择供应商（会话级）' : '选择模型（会话级）'}
            </span>
            <button className="chat-picker-done" onClick={() => setModelPop(null)}>完成</button>
          </div>
          <div className="chat-model-list">
            {modelPop === 'engine' ? (
              <>
                <button
                  className={`chat-model-row ${!engineId ? 'sel' : ''}`}
                  onClick={() => onSetSessionEngine(undefined)}
                  title="跟随全局默认引擎"
                >
                  <span className="chat-model-name">默认（跟随全局）</span>
                  {!engineId && <span className="chat-model-current">当前</span>}
                </button>
                {engines.map((e) => (
                  <button
                    key={e.id}
                    className={`chat-model-row ${engineId === e.id ? 'sel' : ''}`}
                    disabled={e.available === false}
                    onClick={() => onSetSessionEngine(e.id)}
                    title={e.available === false ? '该引擎当前不可用' : `模型来源：${e.modelSource}`}
                  >
                    <span className="chat-model-name">{e.displayName}</span>
                    <span className="chat-model-meta">{e.modelSource}</span>
                    {engineId === e.id && <span className="chat-model-current">当前</span>}
                  </button>
                ))}
                {engines.length === 0 && (
                  <div className="chat-model-empty">没有已注册的 AI 引擎插件</div>
                )}
              </>
            ) : modelPop === 'option' ? (
              <>
                <button
                  className={`chat-model-row ${!option ? 'sel' : ''}`}
                  onClick={() => onSetSessionOption(undefined)}
                  title="使用引擎默认模型"
                >
                  <span className="chat-model-name">引擎默认</span>
                  {!option && <span className="chat-model-current">当前</span>}
                </button>
                {engineModels.map((m) => (
                  <button
                    key={m.id}
                    className={`chat-model-row ${option === m.id ? 'sel' : ''}`}
                    onClick={() => onSetSessionOption(m.id)}
                  >
                    <span className="chat-model-name">{m.label ?? m.id}</span>
                    {option === m.id && <span className="chat-model-current">当前</span>}
                  </button>
                ))}
                {engineModels.length === 0 && (
                  <div className="chat-model-empty">引擎未提供模型清单：保持默认，或稍后重试</div>
                )}
              </>
            ) : providersErr ? (
              <div className="chat-model-empty">供应商列表获取失败：请稍后重试</div>
            ) : !providers ? (
              <div className="chat-model-empty">加载中…</div>
            ) : modelPop === 'provider' ? (
              <>
                <button
                  className={`chat-model-row ${!providerId ? 'sel' : ''}`}
                  onClick={() => onSetSessionModel(undefined, undefined)}
                  title="使用全局默认供应商及其默认模型"
                >
                  <span className="chat-model-name">跟随全局默认</span>
                  {!providerId && <span className="chat-model-current">当前</span>}
                </button>
                {providers.map((p) => (
                  <button
                    key={p.id}
                    className={`chat-model-row ${providerId === p.id ? 'sel' : ''}`}
                    onClick={() => onSetSessionModel(p.id, undefined)}
                    title="只切供应商：模型用该供应商的默认（activeModel）"
                  >
                    <span className="chat-model-name">{p.name || p.id}</span>
                    <span className="chat-model-meta">{p.activeModel || p.models[0]?.id || ''}</span>
                    {providerId === p.id && <span className="chat-model-current">当前</span>}
                  </button>
                ))}
              </>
            ) : sourceEntry ? (
              sourceEntry.models.map((m) => (
                <button
                  key={m.id}
                  className={`chat-model-row ${effectiveModel === m.id ? 'sel' : ''}`}
                  onClick={() => onSetSessionModel(sourceEntry.id, m.id)}
                >
                  <span className="chat-model-name">{m.id}</span>
                  {effectiveModel === m.id && <span className="chat-model-current">当前</span>}
                </button>
              ))
            ) : (
              <div className="chat-model-empty">没有可用模型：请先在「模型供应商管理」配置并启用供应商</div>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>,
    document.body,
  );
}
