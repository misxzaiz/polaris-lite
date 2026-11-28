/**
 * ChatSettingsPanel：右栏「设置」面板（panel 槽 Tab，order 35 紧挨通知 34）。
 *
 * 为什么加它：会话设置浮层锚在输入条上方、高度受输入条以上空间限制，分区越多越挤
 * （长期记忆/循环护栏/分享相继加入后已明显局促）。右栏面板给设置一个**全高**的常驻
 * 视图：全部分区 + 「展示分区」编辑器本体也在这里——浮层按配置隐藏分区后，被隐藏
 * 的功能永远在这里找得回来（编辑器不能被配置藏掉，否则配置不可逆）。
 *
 * 与浮层的分工：浮层=输入条旁的快捷入口（分区显隐可配置、高度可拖拽、深链本面板）；
 * 本面板=全量设置。数据层共用 settingsModel hooks（单一出处，防两份实现漂移）；
 * 记忆/循环护栏/分享三块直接复用浮层导出的同款行组件。
 *
 * 模型/工作目录选择不用浮层（浮层锚定输入条，本组件在右栏无输入条锚点）：改为
 * 行内展开列表（同一批按钮/清单样式，手机触达更好）。队列动作从 ./index 导入
 * （依赖 sendUserMessage/interruptChat；函数声明提升，构建与冒烟已验证环安全）。
 */
import { useEffect, useState } from 'react';
import { CHANNEL_PANEL_INTENT, type AiEngineInfo } from '@sdk';
import { useSessionStore } from './store';
import { useEnginesList, useSessionSettingsCore, useTrustMode } from './settingsModel';
import { GuardrailRows, MemoryRows } from './SessionSettingsPanel';
import { ShareDrawerRows } from './ShareDrawer';
import { WorkspacePickerBody } from './WorkspacePickerBody';
import { SRV } from './serverApi';
import { clearPending, editPending, removePendingItem, sendPendingNow } from './index';
import { onPrefsChanged, readSectionPrefs, SETTINGS_SECTION_LIST, writeSectionPrefs, type SettingsSectionPrefs } from './settingsPrefs';
import { ChevronRightIcon } from './icons';

/** /api/providers/list 的 masked 供应商行（与浮层同款字段） */
interface ProviderEntry {
  id: string;
  name: string;
  hasKey: boolean;
  enabled: boolean;
  isDefault: boolean;
  activeModel: string;
  models: { id: string }[];
}

type ExpandKind = null | 'engine' | 'provider' | 'model' | 'option' | 'workspace';

/** 面板直达：派发 panel intent（SlotOutlet 按 title 切激活 tab；本组件就在右栏内，切换即达） */
function switchPanelTab(title: string): void {
  window.dispatchEvent(new CustomEvent(CHANNEL_PANEL_INTENT, { detail: { slot: 'panel', title } }));
}

export function ChatSettingsPanel(): JSX.Element {
  const core = useSessionSettingsCore();
  const { trustMode, trustTitle, trustLabel, toggleTrust } = useTrustMode();
  const engines = useEnginesList(0);

  // ---- 行内展开（替代浮层的锚定弹层）：engine/provider/model/option/workspace ----
  const [expand, setExpand] = useState<ExpandKind>(null);
  const toggleExpand = (kind: Exclude<ExpandKind, null>): void => {
    setExpand((cur) => {
      const next = cur === kind ? null : kind;
      if (next === 'provider' || next === 'model') void loadProviders();
      return next;
    });
  };

  // ---- 供应商列表（点开供应商/模型清单时现拉，payload 小、免陈旧）----
  const [providers, setProviders] = useState<ProviderEntry[] | null>(null);
  const [defaultProviderId, setDefaultProviderId] = useState<string | null>(null);
  const [providersErr, setProvidersErr] = useState(false);
  const loadProviders = async (): Promise<void> => {
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

  // ---- 展示分区偏好（编辑器本体；全量视图不受此配置影响）----
  const [sectionPrefs, setSectionPrefs] = useState<SettingsSectionPrefs>(() => readSectionPrefs());
  useEffect(() => onPrefsChanged(() => setSectionPrefs(readSectionPrefs())), []);

  // ---- 名称解析：会话覆盖优先，缺省跟随全局默认（显示实际生效值，不是空白）----
  const activeEntry = core.sessionProviderId ? (providers?.find((p) => p.id === core.sessionProviderId) ?? null) : null;
  const sourceEntry = activeEntry ?? providers?.find((p) => p.id === defaultProviderId) ?? null;
  const providerName = core.sessionProviderId ? (activeEntry?.name ?? core.sessionProviderId) : null;
  const effectiveModel = core.sessionModelId ?? sourceEntry?.activeModel ?? null;

  // 引擎形态完全由注册表声明决定（与浮层同一口径）
  const currentEngine = engines.find((e) => e.id === core.sessionEngineId);
  const modelSource = currentEngine?.modelSource ?? 'app';
  const engineModels = currentEngine?.models ?? [];
  const engineDisabled = engines.length === 0 || currentEngine?.available === false;

  /** 目标会话 id：动作发生时才落点（空态选择本身就是「要在这里干活」的意图）——
      绝不在渲染期 createSession（否则空态打开面板就会静默建会话） */
  const sidOf = (): string => core.activeId ?? core.createSession();
  const setRef = core.setSessionModelRef;
  const queueEmpty = core.queueLen === 0;

  return (
    <div className="chat-setpage">
      <div className="chat-setpage-head">
        <span className="chat-setpage-title">设置</span>
        <span className="chat-setpage-sub" title={core.sessionTitle}>{core.sessionTitle}</span>
      </div>

      {/* ===== 模型（会话级覆盖）===== */}
      <div className="chat-assistant-sec">模型</div>
      <div className="chat-assistant-row">
        <span className="chat-assistant-key">AI 引擎</span>
        <button
          className={`chat-ws-chip chat-model-chip ${core.sessionEngineId ? 'pinned' : ''}`}
          onClick={() => toggleExpand('engine')}
          disabled={engines.length === 0}
          title={engines.length === 0 ? '没有已注册的 AI 引擎插件' : `${currentEngine?.displayName ?? '默认引擎'}（点击切换）`}
        >
          {currentEngine?.displayName ?? '默认'}
        </button>
        {engineDisabled && <span className="chat-row-aux" title="当前引擎不可用">不可用</span>}
      </div>
      {expand === 'engine' && (
        <div className="chat-setpage-list">
          <button
            className={`chat-model-row ${!core.sessionEngineId ? 'sel' : ''}`}
            onClick={() => setRef(sidOf(), { engineId: undefined })}
            title="跟随全局默认引擎"
          >
            <span className="chat-model-name">默认（跟随全局）</span>
            {!core.sessionEngineId && <span className="chat-model-current">当前</span>}
          </button>
          {engines.map((e: AiEngineInfo) => (
            <button
              key={e.id}
              className={`chat-model-row ${core.sessionEngineId === e.id ? 'sel' : ''}`}
              disabled={e.available === false}
              onClick={() => setRef(sidOf(), { engineId: e.id })}
              title={e.available === false ? '该引擎当前不可用' : `模型来源：${e.modelSource}`}
            >
              <span className="chat-model-name">{e.displayName}</span>
              <span className="chat-model-meta">{e.modelSource}</span>
              {core.sessionEngineId === e.id && <span className="chat-model-current">当前</span>}
            </button>
          ))}
        </div>
      )}
      {modelSource === 'none' ? (
        <div className="chat-assistant-row">
          <span className="chat-assistant-key">模型</span>
          <span className="chat-assistant-val">该引擎无模型概念</span>
        </div>
      ) : modelSource === 'builtin' ? (
        <>
          <div className="chat-assistant-row">
            <span className="chat-assistant-key">模型</span>
            <button
              className={`chat-ws-chip chat-model-chip ${core.sessionOption ? 'pinned' : ''}`}
              onClick={() => toggleExpand('option')}
              title="选择本对话使用的引擎模型（清单由引擎插件提供）"
            >
              {core.sessionOption ?? '默认'}
            </button>
            {core.sessionOption && (
              <button className="chat-model-reset" onClick={() => setRef(sidOf(), { option: undefined })} title="清除选择，回到引擎默认模型">
                恢复默认
              </button>
            )}
          </div>
          {expand === 'option' && (
            <div className="chat-setpage-list">
              <button
                className={`chat-model-row ${!core.sessionOption ? 'sel' : ''}`}
                onClick={() => setRef(sidOf(), { option: undefined })}
                title="使用引擎默认模型"
              >
                <span className="chat-model-name">引擎默认</span>
                {!core.sessionOption && <span className="chat-model-current">当前</span>}
              </button>
              {engineModels.map((m) => (
                <button
                  key={m.id}
                  className={`chat-model-row ${core.sessionOption === m.id ? 'sel' : ''}`}
                  onClick={() => setRef(sidOf(), { option: m.id })}
                >
                  <span className="chat-model-name">{m.label ?? m.id}</span>
                  {core.sessionOption === m.id && <span className="chat-model-current">当前</span>}
                </button>
              ))}
              {engineModels.length === 0 && <div className="chat-model-empty">引擎未提供模型清单：保持默认，或稍后重试</div>}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="chat-assistant-row">
            <span className="chat-assistant-key">供应商</span>
            <button
              className={`chat-ws-chip chat-model-chip ${core.sessionProviderId ? 'pinned' : ''}`}
              onClick={() => toggleExpand('provider')}
              title="选择本对话使用的模型供应商（会话级，不影响其他对话）"
            >
              {providerName ?? '默认'}
            </button>
            <span className="chat-assistant-key">模型</span>
            <button
              className={`chat-ws-chip chat-model-chip ${core.sessionModelId ? 'pinned' : ''}`}
              onClick={() => toggleExpand('model')}
              title="选择本对话使用的模型（会话级；未指定时跟随所选供应商默认）"
            >
              {effectiveModel ?? '默认'}
            </button>
            {(core.sessionProviderId || core.sessionModelId) && (
              <button
                className="chat-model-reset"
                onClick={() => setRef(sidOf(), { providerId: undefined, modelId: undefined })}
                title="清除会话级覆盖，回到跟随全局默认"
              >
                恢复默认
              </button>
            )}
          </div>
          {expand === 'provider' && (
            <div className="chat-setpage-list">
              {providersErr ? (
                <div className="chat-model-empty">供应商列表获取失败：请稍后重试</div>
              ) : !providers ? (
                <div className="chat-model-empty">加载中…</div>
              ) : (
                <>
                  <button
                    className={`chat-model-row ${!core.sessionProviderId ? 'sel' : ''}`}
                    onClick={() => setRef(sidOf(), { providerId: undefined, modelId: undefined })}
                    title="使用全局默认供应商及其默认模型"
                  >
                    <span className="chat-model-name">跟随全局默认</span>
                    {!core.sessionProviderId && <span className="chat-model-current">当前</span>}
                  </button>
                  {providers.map((p) => (
                    <button
                      key={p.id}
                      className={`chat-model-row ${core.sessionProviderId === p.id ? 'sel' : ''}`}
                      onClick={() => setRef(sidOf(), { providerId: p.id, modelId: undefined })}
                      title="只切供应商：模型用该供应商的默认（activeModel）"
                    >
                      <span className="chat-model-name">{p.name || p.id}</span>
                      <span className="chat-model-meta">{p.activeModel || p.models[0]?.id || ''}</span>
                      {core.sessionProviderId === p.id && <span className="chat-model-current">当前</span>}
                    </button>
                  ))}
                </>
              )}
            </div>
          )}
          {expand === 'model' && (
            <div className="chat-setpage-list">
              {providersErr ? (
                <div className="chat-model-empty">供应商列表获取失败：请稍后重试</div>
              ) : !providers ? (
                <div className="chat-model-empty">加载中…</div>
              ) : sourceEntry ? (
                sourceEntry.models.map((m) => (
                  <button
                    key={m.id}
                    className={`chat-model-row ${effectiveModel === m.id ? 'sel' : ''}`}
                    onClick={() => setRef(sidOf(), { providerId: sourceEntry.id, modelId: m.id })}
                  >
                    <span className="chat-model-name">{m.id}</span>
                    {effectiveModel === m.id && <span className="chat-model-current">当前</span>}
                  </button>
                ))
              ) : (
                <div className="chat-model-empty">没有可用模型：请先在「模型供应商管理」配置并启用供应商</div>
              )}
            </div>
          )}
        </>
      )}

      {/* 新会话默认（与浮层同语义：已记住=再点取消；全空快照=跟随全局） */}
      <button
        type="button"
        className={`chat-assistant-row chat-row-btn chat-default-row ${core.defaultsActive ? 'on' : ''}`}
        onClick={core.toggleSessionDefaults}
        disabled={!core.activeId}
        title={core.defaultsActive ? '点击取消记住：新会话恢复跟随全局默认' : '记住上面的引擎/模型配置，作为新会话默认'}
      >
        <span className="chat-assistant-key">新会话默认</span>
        <span className={`chat-ws-chip ${core.defaultsActive ? 'pinned' : ''}`}>
          {core.defaultsActive ? '已记住当前配置' : core.hasAnyDefault ? '更新为当前配置' : '记住当前配置'}
        </span>
        <span className="chat-row-aux">
          {core.defaultsActive ? '新会话沿用' : core.hasAnyDefault ? '另有默认' : '跟随全局'}
        </span>
      </button>

      {/* ===== 执行：工作目录（行内展开选择器）+ 执行模式 + 循环护栏 ===== */}
      <div className="chat-assistant-sec">执行</div>
      <button
        className="chat-assistant-row chat-row-btn"
        onClick={() => toggleExpand('workspace')}
        title="选择本对话的工作目录（AI 命令在此执行）"
      >
        <span className="chat-assistant-key">工作目录</span>
        <span className={`chat-ws-chip ${core.sessionWorkspaceId ? 'pinned' : ''} ${core.wsMissing ? 'invalid' : ''}`}>
          {core.sessionWorkspaceId ? (core.wsMissing ? '已失效' : (core.wsLabel ?? '…')) : '默认目录'}
        </span>
        {core.sessionLinkedIds.length > 0 && (
          <span className="chat-row-aux" title="关联只读目录">+{core.sessionLinkedIds.length}</span>
        )}
        <span className="chat-assistant-go" aria-hidden="true"><ChevronRightIcon /></span>
      </button>
      {expand === 'workspace' && (
        <div className="chat-setpage-list chat-setpage-ws">
          <WorkspacePickerBody
            workspaceId={core.sessionWorkspaceId ?? undefined}
            linkedWorkspaceIds={core.sessionLinkedIds}
            onPickMain={(id) => core.setSessionWorkspace(sidOf(), id)}
            onToggleLinked={(id) => {
              const cur = useSessionStore.getState().sessions.find((s) => s.id === sidOf())?.linkedWorkspaceIds ?? [];
              const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id].slice(0, 3);
              core.setSessionLinkedWorkspaces(sidOf(), next);
            }}
            closeOnPickMain={false}
          />
        </div>
      )}
      {trustMode !== null && (
        <div className="chat-assistant-row">
          <span className="chat-assistant-key">执行模式</span>
          <button
            className={`chat-trust-chip ${trustMode ? 'trusted' : ''}`}
            onClick={() => void toggleTrust()}
            title={trustTitle}
            aria-pressed={trustMode}
          >
            {trustLabel}
          </button>
        </div>
      )}
      {/* 循环护栏：与浮层同一行组件（导出复用，防两份实现漂移） */}
      <GuardrailRows />

      {/* ===== 记忆 ===== */}
      <div className="chat-assistant-sec">记忆</div>
      <MemoryRows />

      {/* ===== 待发队列 ===== */}
      <div className="chat-assistant-sec">待发队列</div>
      {queueEmpty ? (
        <div className="chat-assistant-row">
          <span className="chat-assistant-key">待发队列</span>
          <span className="chat-assistant-val">无</span>
        </div>
      ) : (
        <div className="chat-queue-list">
          <div className="chat-assistant-row">
            <span className="chat-assistant-key">待发队列（{core.queueLen}）</span>
            <span className="chat-assistant-val" />
            <button className="chat-queue-clear" onClick={() => clearPending()} title="清空待发队列">清空</button>
          </div>
          {core.queueItems.map((it) => (
            <div key={it.id} className="chat-queue-item">
              <span className="chat-queue-text" title={it.text}>{it.text}</span>
              <span className="chat-queue-acts">
                <button className="chat-queue-act" onClick={() => sendPendingNow(it.id)} title="立即发送（跳过排队顺序）">立即发</button>
                <button className="chat-queue-act" onClick={() => editPending(it.id)} title="取回输入框编辑">编辑</button>
                <button className="chat-queue-act danger" onClick={() => removePendingItem(it.id)} title="删除">删除</button>
              </span>
            </div>
          ))}
        </div>
      )}

      {/* ===== 通知：本面板就在右栏，直接切 tab 即达 ===== */}
      <div className="chat-assistant-sec">通知</div>
      <button
        className="chat-assistant-row chat-row-btn"
        onClick={() => switchPanelTab('通知')}
        title="打开通知中心：历史、未读与全部已读"
      >
        <span className="chat-assistant-key">通知中心</span>
        <span className="chat-row-aux">历史 / 未读 / 全部已读</span>
        <span className="chat-assistant-go" aria-hidden="true"><ChevronRightIcon /></span>
      </button>

      {/* ===== 分享 ===== */}
      <div className="chat-assistant-sec">分享</div>
      <ShareDrawerRows />

      {/* ===== 展示分区（编辑器本体）：只约束输入条旁的浮层；本面板恒为全量视图 ===== */}
      <div className="chat-assistant-sec">展示分区</div>
      <div className="chat-setpage-hint">配置输入条旁「会话设置」浮层展示哪些分区；本面板始终展示全部，隐藏的分区随时在这里找回。</div>
      {SETTINGS_SECTION_LIST.map((s) => (
        <div key={s.id} className="chat-assistant-row">
          <span className="chat-assistant-key">{s.label}</span>
          <button
            className={`chat-trust-chip ${sectionPrefs[s.id] ? 'trusted' : ''}`}
            onClick={() => {
              const next = { ...sectionPrefs, [s.id]: !sectionPrefs[s.id] };
              setSectionPrefs(next);
              writeSectionPrefs(next);
            }}
            aria-pressed={sectionPrefs[s.id]}
            title={s.desc}
          >
            {sectionPrefs[s.id] ? '展示' : '隐藏'}
          </button>
          <span className="chat-row-aux" title={s.desc}>{s.desc}</span>
        </div>
      ))}
      <button
        className="chat-assistant-row chat-row-btn"
        onClick={() => {
          const all: SettingsSectionPrefs = {
            model: true, execute: true, memory: true, queue: true, notify: true, share: true,
          };
          setSectionPrefs(all);
          writeSectionPrefs(all);
        }}
        title="全部分区恢复展示"
      >
        <span className="chat-assistant-key">恢复默认</span>
        <span className="chat-row-aux">全部展示</span>
      </button>
    </div>
  );
}
