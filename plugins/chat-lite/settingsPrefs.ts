/**
 * 会话设置的本地偏好：分区显隐 + 浮层高度（per-device，localStorage）。
 *
 * 为什么放 localStorage 不上云：这是「这台设备这块屏幕」的 UI 偏好（手机想收起
 * 分享、桌面想全开），跨端同步反而互相干扰——与 plite.slot.active.* 同一存储纪律。
 *
 * 分区配置只约束**浮层**（输入条上方的快捷面板）；右栏「设置」面板是全量视图 +
 * 编辑器本体，永远展示全部分区——保证被隐藏的功能永远找得回来（编辑器在右栏）。
 * 变更经自定义事件广播（storage 事件只跨文档触发，同文档写不上——SlotOutlet
 * 用户自定义顺序的同款兜底），浮层与编辑器即时互相同步。
 */

export type SettingsSectionId = 'model' | 'execute' | 'memory' | 'queue' | 'notify' | 'share';

export interface SettingsSectionMeta {
  id: SettingsSectionId;
  label: string;
  desc: string;
}

/** 分区清单（固定展示顺序；配置只管显隐不管排序——排序复杂度不值得） */
export const SETTINGS_SECTION_LIST: SettingsSectionMeta[] = [
  { id: 'model', label: '模型', desc: 'AI 引擎 / 供应商 / 模型 / 新会话默认' },
  { id: 'execute', label: '执行', desc: '工作目录 / 执行模式 / 循环护栏' },
  { id: 'memory', label: '记忆', desc: '长期记忆开关' },
  { id: 'queue', label: '待发队列', desc: '排队消息的查看与编辑' },
  { id: 'notify', label: '通知', desc: '通知中心入口与未读数' },
  { id: 'share', label: '分享', desc: '会话分享链接与本地导出' },
];

export type SettingsSectionPrefs = Record<SettingsSectionId, boolean>;

const SECTIONS_KEY = 'plite.chat-settings.sections.v1';
/** 浮层拖拽后的固定高度（px；null=自适应现状） */
export const PANEL_HEIGHT_KEY = 'plite.chat-settings.height.v1';
/** 同文档偏好变更广播（storage 事件不触发同文档，自定义事件兜底） */
const PREFS_EVENT = 'plite-chat-settings-prefs';

const DEFAULT_PREFS: SettingsSectionPrefs = {
  model: true,
  execute: true,
  memory: true,
  queue: true,
  notify: true,
  share: true,
};

export function readSectionPrefs(): SettingsSectionPrefs {
  if (typeof window === 'undefined') return { ...DEFAULT_PREFS };
  try {
    const raw = window.localStorage.getItem(SECTIONS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_PREFS };
    const out = { ...DEFAULT_PREFS };
    for (const s of SETTINGS_SECTION_LIST) {
      const v = (parsed as Record<string, unknown>)[s.id];
      if (typeof v === 'boolean') out[s.id] = v;
    }
    return out;
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function writeSectionPrefs(next: SettingsSectionPrefs): void {
  try {
    window.localStorage.setItem(SECTIONS_KEY, JSON.stringify(next));
  } catch { /* 持久化失败不阻断（会话内仍生效） */ }
  window.dispatchEvent(new CustomEvent(PREFS_EVENT));
}

export function readPanelHeight(): number | null {
  if (typeof window === 'undefined') return null;
  try {
    const n = Number(window.localStorage.getItem(PANEL_HEIGHT_KEY));
    return Number.isFinite(n) && n >= 200 ? Math.round(n) : null;
  } catch {
    return null;
  }
}

export function writePanelHeight(px: number | null): void {
  try {
    if (px === null) window.localStorage.removeItem(PANEL_HEIGHT_KEY);
    else window.localStorage.setItem(PANEL_HEIGHT_KEY, String(Math.round(px)));
  } catch { /* 静默 */ }
}

/** 订阅偏好变更（同文档事件 + 跨文档 storage 双通道）；返回取消函数 */
export function onPrefsChanged(fn: () => void): () => void {
  const onLocal = (): void => fn();
  const onStorage = (e: StorageEvent): void => {
    if (e.key === SECTIONS_KEY || e.key === PANEL_HEIGHT_KEY) fn();
  };
  window.addEventListener(PREFS_EVENT, onLocal);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(PREFS_EVENT, onLocal);
    window.removeEventListener('storage', onStorage);
  };
}
