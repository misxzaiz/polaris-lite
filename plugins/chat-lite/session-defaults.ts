/**
 * 新会话默认模型配置（chat-lite 私有，独立于会话数据与全局模型默认）。
 *
 * 会话设置面板里「记住当前配置」写入本偏好；createSession 读取后注入新会话，
 * 与工作区偏好（workspace-prefs.ts）同一套口径：
 * - 字段缺省（undefined）= 跟随全局默认，不写入 localStorage 的 JSON；
 * - 只存 id，不存展示名——供应商/模型是否仍有效由 /api/providers/list 实时裁定；
 * - localStorage 本地生效、不跨设备（会话字段本身随 JSON 上云，二者口径不同）。
 *
 * 四项一起快照（引擎 / 供应商 / 模型 / CodeBuddy 模型）：只选了引擎没选模型时，
 * modelId=undefined 即「新会话的模型跟随全局」，这正是用户要的表达，无需逐项 pin。
 */

const PREFS_KEY = 'chat-lite.session-defaults.v1';

export interface SessionDefaults {
  /** 'codebuddy'=新会话直连 CLI；缺省=默认引擎（real-engine/runner） */
  engineId?: 'codebuddy';
  /** 新会话默认供应商；缺省=跟随全局 activeId */
  providerId?: string;
  /** 新会话默认模型；缺省=跟随供应商 activeModel */
  modelId?: string;
  /** CodeBuddy 引擎的 CLI 模型；缺省=CLI 默认 */
  codebuddyModel?: string;
}

const EMPTY: SessionDefaults = {};

export function loadSessionDefaults(): SessionDefaults {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...EMPTY };
    const j = JSON.parse(raw) as Partial<SessionDefaults>;
    return {
      engineId: j.engineId === 'codebuddy' ? 'codebuddy' : undefined,
      providerId: typeof j.providerId === 'string' ? j.providerId : undefined,
      modelId: typeof j.modelId === 'string' ? j.modelId : undefined,
      codebuddyModel: typeof j.codebuddyModel === 'string' ? j.codebuddyModel : undefined,
    };
  } catch {
    return { ...EMPTY };
  }
}

/** 写入快照并返回落盘后的规范值（undefined 字段不落 JSON） */
export function saveSessionDefaults(next: SessionDefaults): SessionDefaults {
  const clean: SessionDefaults = {
    ...(next.engineId === 'codebuddy' ? { engineId: 'codebuddy' as const } : {}),
    ...(typeof next.providerId === 'string' ? { providerId: next.providerId } : {}),
    ...(typeof next.modelId === 'string' ? { modelId: next.modelId } : {}),
    ...(typeof next.codebuddyModel === 'string' ? { codebuddyModel: next.codebuddyModel } : {}),
  };
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
