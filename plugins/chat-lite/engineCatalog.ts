/**
 * chat-lite 的引擎目录视图：只从 cap.ai.engine 读取已注册引擎的声明式元数据。
 *
 * 这里没有任何具体引擎 id / 厂商 / 模型 / 端点——"有哪些引擎、各自什么形态"
 * 完全由引擎插件的 manifest.aiEngine 决定。新增引擎时本文件与消费方零改动。
 */
import type { AiEngineInfo, SlotHostApi } from '@sdk';

let hostApi: SlotHostApi | null = null;
let cached: AiEngineInfo[] = [];

export function bindEngineCatalog(api: SlotHostApi): void {
  hostApi = api;
}

/** 拉一次注册表（面板打开/发送前调用；失败保留上一次快照，不让 UI 因自省失败而崩） */
export async function loadEngines(): Promise<AiEngineInfo[]> {
  if (!hostApi) return cached;
  try {
    const res = await hostApi.dispatch<{ engines?: AiEngineInfo[] }>({
      target: 'cap.ai.engine',
      action: 'list',
    });
    if (res.ok && Array.isArray(res.data?.engines)) cached = res.data.engines;
  } catch {
    /* 自省是旁路能力：失败时继续用上次快照（或空列表） */
  }
  return cached;
}

export function getEngines(): AiEngineInfo[] {
  return cached;
}

export function getEngine(engineId: string | undefined): AiEngineInfo | undefined {
  if (!engineId) return undefined;
  return cached.find((e) => e.id === engineId);
}

/** 引擎显示名（未指定 engineId 时显示「默认」） */
export function displayEngineName(engineId: string | undefined): string {
  return getEngine(engineId)?.displayName ?? '默认';
}

/** 能力开关的通用读法：缺省按支持处理，避免新引擎因漏声明被降级 */
export function supportsTools(engineId: string | undefined): boolean {
  return getEngine(engineId)?.features?.supportsTools !== false;
}
export function supportsSlashSkills(engineId: string | undefined): boolean {
  return getEngine(engineId)?.features?.slashSkills !== false;
}
