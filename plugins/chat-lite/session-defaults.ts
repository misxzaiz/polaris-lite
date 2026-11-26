/**
 * 新会话默认模型配置（chat-lite 私有，独立于会话数据与全局模型默认）。
 *
 * 会话设置面板里「记住当前配置」写入本偏好；createSession 读取后注入新会话，
 * 与工作区偏好（workspace-prefs.ts）同一套口径：
 * - 字段缺省 = 跟随全局默认，不写入 localStorage 的 JSON；
 * - 只存 id，不存展示名——引擎/供应商/模型是否仍有效由 cap.ai.engine 与 providers/list 实时裁定；
 * - localStorage 本地生效、不跨设备（会话字段本身随 JSON 上云，二者口径不同）。
 *
 * 引擎 / 供应商 / 模型 / 自带变体统一为一个 modelRef：
 * 平台只搬运 id，语义由被引擎解释，新增引擎不再带来新的专属字段。
 */
import type { ModelRef } from '@sdk';

const PREFS_KEY = 'chat-lite.session-defaults.v1';

export interface SessionDefaults {
  modelRef?: ModelRef;
}

const EMPTY: SessionDefaults = {};

function cleanRef(ref: ModelRef | undefined): ModelRef | undefined {
  if (!ref) return undefined;
  const out: ModelRef = {};
  if (typeof ref.engineId === 'string') out.engineId = ref.engineId;
  if (typeof ref.providerId === 'string') out.providerId = ref.providerId;
  if (typeof ref.modelId === 'string') out.modelId = ref.modelId;
  if (typeof ref.option === 'string') out.option = ref.option;
  return Object.keys(out).length ? out : undefined;
}

export function loadSessionDefaults(): SessionDefaults {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...EMPTY };
    const j = JSON.parse(raw) as { modelRef?: ModelRef };
    const ref = cleanRef(j.modelRef);
    return ref ? { modelRef: ref } : { ...EMPTY };
  } catch {
    return { ...EMPTY };
  }
}

/** 写入快照并返回落盘后的规范值（空引用不落 JSON） */
export function saveSessionDefaults(next: SessionDefaults): SessionDefaults {
  const ref = cleanRef(next.modelRef);
  const clean: SessionDefaults = ref ? { modelRef: ref } : {};
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(clean));
  } catch { /* 配额/隐私模式：降级为跟随全局（与 workspace-prefs 同口径） */ }
  return clean;
}

/** 取消记住：新会话回到跟随全局默认 */
export function clearSessionDefaults(): SessionDefaults {
  try {
    localStorage.removeItem(PREFS_KEY);
  } catch { /* 忽略 */ }
  return { ...EMPTY };
}
