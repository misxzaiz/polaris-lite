/**
 * 会话设置的数据层（hooks）：浮层面板（SessionSettingsPanel）与右栏「设置」面板
 * （ChatSettingsPanel）共用同一出处——此前这些推导只活在 ChatInput 里，第二份实现
 * 必然漂移（liveTurn 教训：两份 delta/收敛实现曾让重开路径完全没有消费者）。
 *
 * 数据源全部是模块级权威：useSessionStore（会话/队列/工作区绑定）、engineCatalog
 * （引擎目录）、session-defaults（新会话默认）、SRV.tool（信任模式=服务端裁决模式）、
 * SRV.fs（工作区显示名解析）。本文件零 UI，只出状态与动作。
 *
 * 待发队列的「立即发/编辑」动作在 ./index（依赖 sendUserMessage/interruptChat），
 * 消费方按需从那里导入——本文件不回头 import index，避免无谓的环。
 */
import { useCallback, useEffect, useState } from 'react';
import { type AiEngineInfo } from '@sdk';
import { useSessionStore } from './store';
import { getEngines, loadEngines } from './engineCatalog';
import { clearSessionDefaults, loadSessionDefaults, saveSessionDefaults, type SessionDefaults } from './session-defaults';
import { onRootsChanged } from './workspace-prefs';
import { SRV } from './serverApi';

/** 信任模式（完全信任=yolo）：数据源服务端 tool-exec 配置，切换即改裁决模式 */
export function useTrustMode(): {
  trustMode: boolean | null;
  trustTitle: string;
  trustLabel: string;
  toggleTrust: () => Promise<void>;
  /** 主动重取（发送时同步：会话内配置可能被审批卡/另一处面板改动） */
  refreshTrust: () => Promise<void>;
} {
  const [trustMode, setTrustMode] = useState<boolean | null>(null);
  const refreshTrust = useCallback(async (): Promise<void> => {
    try {
      const r = await fetch(`${SRV.tool}/config`, { credentials: 'include' });
      if (!r.ok) { setTrustMode(null); return; }
      const j = (await r.json()) as { mode?: string };
      setTrustMode(j.mode === 'yolo');
    } catch { setTrustMode(null); }
  }, []);
  const toggleTrust = useCallback(async (): Promise<void> => {
    try {
      const r = await fetch(`${SRV.tool}/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ mode: trustMode ? 'confirm' : 'yolo' }),
      });
      if (r.ok) setTrustMode(((await r.json()) as { mode?: string }).mode === 'yolo');
    } catch { /* 配置不可达：保持原态 */ }
  }, [trustMode]);
  useEffect(() => { void refreshTrust(); }, [refreshTrust]);
  const trustTitle = trustMode
    ? '完全信任（yolo）：AI 命令免审批直接执行。点击切换回审批模式'
    : '审批模式：AI 危险命令需确认后执行。点击开启完全信任';
  const trustLabel = trustMode ? '信任模式' : '审批模式';
  return { trustMode, trustTitle, trustLabel, toggleTrust, refreshTrust };
}

/** 引擎目录：只来自 cap.ai.engine（插件声明）。dep 变化（如面板打开）时刷新一次 */
export function useEnginesList(dep?: unknown): AiEngineInfo[] {
  const [engines, setEngines] = useState<AiEngineInfo[]>(() => getEngines());
  useEffect(() => {
    void loadEngines().then(setEngines);
  }, [dep]);
  return engines;
}

/** 会话设置核心数据：会话身份 / 模型引用 / 新会话默认 / 工作区 / 待发队列 */
export function useSessionSettingsCore() {
  const activeId = useSessionStore((s) => s.activeId);
  /** 会话标题：未设置（「新会话」）时回退用户第一句，与侧栏 displayTitle 同口径 */
  const sessionTitle = useSessionStore((s) => {
    const cur = s.sessions.find((x) => x.id === s.activeId);
    if (!cur) return '会话设置';
    return cur.title !== '新会话' ? cur.title : (cur.messages[0]?.content?.slice(0, 18) ?? '新会话');
  });
  /** 当前会话绑定的工作区（file-browser 登记的根；null=跟随全局默认） */
  const sessionWorkspaceId = useSessionStore((s) => s.sessions.find((x) => x.id === s.activeId)?.workspaceId ?? null);
  /** 关联只读目录（可读不可写，命令仍在主目录执行） */
  const sessionLinkedIds = useSessionStore(
    (s) => s.sessions.find((x) => x.id === s.activeId)?.linkedWorkspaceIds ?? [],
  );
  /** 会话级模型引用（引擎 / 供应商 / 模型 / 自带变体统一一组 id） */
  const sessionModelRef = useSessionStore((s) => s.sessions.find((x) => x.id === s.activeId)?.modelRef);
  const sessionProviderId = sessionModelRef?.providerId;
  const sessionModelId = sessionModelRef?.modelId;
  const sessionEngineId = sessionModelRef?.engineId;
  const sessionOption = sessionModelRef?.option;
  const setSessionModelRef = useSessionStore((s) => s.setSessionModelRef);
  const setSessionWorkspace = useSessionStore((s) => s.setSessionWorkspace);
  const setSessionLinkedWorkspaces = useSessionStore((s) => s.setSessionLinkedWorkspaces);
  const createSession = useSessionStore((s) => s.createSession);
  /** 待发队列（流式预输入；串行派发） */
  const queueItems = useSessionStore((s) => (s.activeId ? (s.pending[s.activeId] ?? []) : []));

  /** 新会话默认配置（「记住当前配置」写入；createSession 读取注入） */
  const [sessionDefaults, setSessionDefaults] = useState<SessionDefaults>(() => loadSessionDefaults());
  const defaultRef = sessionDefaults.modelRef;
  const hasAnyDefault = !!defaultRef && Object.keys(defaultRef).length > 0;
  const defaultsActive = !!activeId && !!defaultRef
    && defaultRef.engineId === sessionEngineId
    && defaultRef.providerId === sessionProviderId
    && defaultRef.modelId === sessionModelId
    && defaultRef.option === sessionOption;
  const toggleSessionDefaults = useCallback(() => {
    const cur = loadSessionDefaults();
    const cr = cur.modelRef ?? {};
    const same = !!activeId
      && cr.engineId === sessionEngineId
      && cr.providerId === sessionProviderId
      && cr.modelId === sessionModelId
      && cr.option === sessionOption;
    const next = same
      ? clearSessionDefaults()
      : saveSessionDefaults({ modelRef: {
          ...(sessionEngineId ? { engineId: sessionEngineId } : {}),
          ...(sessionProviderId ? { providerId: sessionProviderId } : {}),
          ...(sessionModelId ? { modelId: sessionModelId } : {}),
          ...(sessionOption ? { option: sessionOption } : {}),
        } });
    setSessionDefaults(next);
  }, [activeId, sessionEngineId, sessionProviderId, sessionModelId, sessionOption]);

  /** 工作区显示名（file-browser 维护 names/labels；根表变更广播时重取） */
  const [wsLabel, setWsLabel] = useState<string | null>(null);
  /** 绑定失效（root 被移除/盘符不在）：必须显性提示，不能装作正常 */
  const [wsMissing, setWsMissing] = useState(false);
  const [wsRev, setWsRev] = useState(0);
  useEffect(() => onRootsChanged(() => setWsRev((v) => v + 1)), []);
  useEffect(() => {
    if (!sessionWorkspaceId) { setWsLabel(null); setWsMissing(false); return; }
    let alive = true;
    void (async () => {
      try {
        const r = await fetch(`${SRV.fs}/roots`, { credentials: 'include' });
        const j = (await r.json()) as { roots?: { id: string; label: string }[] };
        const match = j.roots?.find((x) => x.id === sessionWorkspaceId);
        if (!alive) return;
        setWsLabel(match?.label ?? sessionWorkspaceId);
        setWsMissing(!match);
      } catch {
        if (alive) { setWsLabel(sessionWorkspaceId); setWsMissing(false); }
      }
    })();
    return () => { alive = false; };
  }, [sessionWorkspaceId, wsRev]);

  return {
    activeId, sessionTitle,
    sessionEngineId, sessionProviderId, sessionModelId, sessionOption, setSessionModelRef,
    defaultsActive, hasAnyDefault, toggleSessionDefaults,
    sessionWorkspaceId, wsLabel, wsMissing, sessionLinkedIds,
    setSessionWorkspace, setSessionLinkedWorkspaces, createSession,
    queueItems, queueLen: queueItems.length,
  };
}
