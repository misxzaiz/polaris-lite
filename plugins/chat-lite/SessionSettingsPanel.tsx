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
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { type PendingSend } from './store';
import { ShareDrawerRows } from './ShareDrawer';
import { ChevronRightIcon } from './icons';

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

interface SessionSettingsPanelProps {
  // ---- 模型（会话级覆盖；undefined=跟随全局默认）----
  providerId: string | undefined;
  modelId: string | undefined;
  onSetSessionModel: (providerId: string | undefined, modelId: string | undefined) => void;
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
    providerId, modelId, onSetSessionModel,
    workspaceId, wsLabel, wsMissing, linkedCount, onOpenWorkspacePicker,
    trustMode, trustTitle, trustLabel, onToggleTrust,
    queueLen, queueItems, onClearPending, onSendPendingNow, onEditPending, onRemovePendingItem,
    barRef, popRef, wsPopRef, onDone, escRef,
  } = props;

  // ---- 供应商列表（打开浮层时现拉，payload 小、免陈旧）----
  const [providers, setProviders] = useState<ProviderEntry[] | null>(null);
  const [defaultProviderId, setDefaultProviderId] = useState<string | null>(null);
  const [providersErr, setProvidersErr] = useState(false);
  /** 模型选择浮层：null=关；provider=选供应商；model=选模型 */
  const [modelPop, setModelPop] = useState<null | 'provider' | 'model'>(null);
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
      const r = await fetch('/api/providers/list', { credentials: 'include', cache: 'no-store' });
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

  const openModelPop = (kind: 'provider' | 'model') => {
    setModelPos(computeModelPos());
    setModelPop(kind);
    void loadProviders();
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
        <div className="chat-picker-head">
          <span className="chat-picker-title">会话设置</span>
          <button className="chat-picker-done" onClick={onDone}>完成</button>
        </div>
        <div className="chat-settings-body">
          {/* ===== 模型（会话级覆盖）===== */}
          <div className="chat-assistant-sec">模型</div>
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
          aria-label={modelPop === 'provider' ? '选择模型供应商' : '选择模型'}
          style={{ left: modelPos.left, bottom: modelPos.bottom, width: modelPos.width, maxHeight: modelPos.maxHeight }}
        >
          <div className="chat-picker-head">
            <span className="chat-picker-title">{modelPop === 'provider' ? '选择供应商（会话级）' : '选择模型（会话级）'}</span>
            <button className="chat-picker-done" onClick={() => setModelPop(null)}>完成</button>
          </div>
          <div className="chat-model-list">
            {providersErr ? (
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
