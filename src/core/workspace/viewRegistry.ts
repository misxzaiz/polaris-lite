/**
 * 视图注册表：`viewType → 插件组件` 的唯一映射。
 *
 * 与槽位注册表（slotRegistry）的分工：
 * - 槽位贡献（`contributes.slots`）回答「填哪个固定位置」，是存量插件用的老契约；
 * - 视图贡献（`contributes.views`）回答「我有哪些可被摆放的界面」，是布局树用的新契约。
 *
 * 两者共存的必要性：布局树里的叶子只有 `viewType` 字符串，宿主必须能把它解析成
 * 真实组件，同时**不能认识任何具体插件**。注册表就是那道边界——它只存字符串到
 * 组件的映射，宿主代码里不会出现 `if (viewType === 'chat-lite.chat')` 这类分支。
 *
 * 三条硬规则（评审结论，违反会让「自由布局」变成事故）：
 * 1. `viewType` 必须形如 `<pluginId>.<local>`：避免两个插件都叫 `chat` 撞名，
 *    也避免 `"` / `/` 这类字符被拼进 `aria-controls` 或选择器。
 * 2. `title` 必填。没有名字的控件无法拥有可访问名，读屏用户会听到一串 viewType。
 * 3. 同一个 `pluginId` 不允许注册第二个同 `viewType` 的视图（后到者被拒并告警）。
 */
import type { AnchorId } from './schema.ts';
import { ANCHOR_IDS, ID_PATTERN } from './schema.ts';

export interface ViewDefinition {
  /** 全局唯一的视图类型名，必须形如 `<pluginId>.<local>` */
  viewType: string;
  pluginId: string;
  /** 插件模块里的组件导出名 */
  component: string;
  /** 用户可见名（tab 文本 / 无标题时的可访问名） */
  title: string;
  /** 打开时的默认落位锚点，缺省 'panel' */
  defaultAnchor?: AnchorId;
}

export interface ViewRegistrationResult {
  registered: string[];
  rejected: { viewType: string; reason: string }[];
}

/** 从 manifest.contributes.views 的原始项（未知形状）解析成 ViewDefinition */
export function normalizeViewDefinition(pluginId: string, raw: unknown): ViewDefinition | { error: string } {
  if (typeof raw !== 'object' || raw === null) return { error: '视图声明必须是对象' };
  const r = raw as Record<string, unknown>;
  const viewType = typeof r.viewType === 'string' ? r.viewType : undefined;
  const component = typeof r.component === 'string' ? r.component : undefined;
  const title = typeof r.title === 'string' ? r.title.trim() : '';
  if (!viewType || !ID_PATTERN.test(viewType)) return { error: `viewType 不合法：${String(r.viewType)}` };
  if (!viewType.startsWith(`${pluginId}.`)) return { error: `viewType 必须以 "${pluginId}." 开头` };
  if (!component) return { error: '缺少 component（插件内导出名）' };
  if (!title) return { error: '缺少 title（无标题的视图无法拥有可访问名）' };
  const anchor = r.defaultAnchor;
  if (anchor !== undefined && !(ANCHOR_IDS as readonly string[]).includes(anchor as string)) {
    return { error: `defaultAnchor 不合法：${String(anchor)}（auth 不是锚点）` };
  }
  return {
    viewType,
    pluginId,
    component,
    title,
    defaultAnchor: anchor as AnchorId | undefined,
  };
}

export class ViewRegistry {
  private views = new Map<string, ViewDefinition>();
  private subs = new Set<() => void>();

  register(def: ViewDefinition): boolean {
    const existing = this.views.get(def.viewType);
    if (existing) return false;
    this.views.set(def.viewType, def);
    this.notify();
    return true;
  }

  /** 批量注册 manifest 里的视图声明；返回被拒项供启动告警 */
  registerFromManifest(pluginId: string, rawViews: unknown): ViewRegistrationResult {
    const registered: string[] = [];
    const rejected: { viewType: string; reason: string }[] = [];
    if (!Array.isArray(rawViews)) {
      if (rawViews !== undefined) rejected.push({ viewType: '(manifest)', reason: 'contributes.views 必须是数组' });
      return { registered, rejected };
    }
    for (const raw of rawViews) {
      const parsed = normalizeViewDefinition(pluginId, raw);
      if ('error' in parsed) {
        rejected.push({ viewType: String((raw as Record<string, unknown>)?.viewType ?? '(unknown)'), reason: parsed.error });
        continue;
      }
      if (this.register(parsed)) registered.push(parsed.viewType);
      else rejected.push({ viewType: parsed.viewType, reason: 'viewType 已被注册（重复声明）' });
    }
    return { registered, rejected };
  }

  get(viewType: string): ViewDefinition | undefined {
    return this.views.get(viewType);
  }

  has(viewType: string): boolean {
    return this.views.has(viewType);
  }

  list(): ViewDefinition[] {
    return [...this.views.values()].sort((a, b) => a.viewType.localeCompare(b.viewType));
  }

  /** 已知视图类型集合（校验器用） */
  types(): Set<string> {
    return new Set(this.views.keys());
  }

  unregisterPlugin(pluginId: string): void {
    let changed = false;
    for (const [type, def] of this.views) {
      if (def.pluginId === pluginId) {
        this.views.delete(type);
        changed = true;
      }
    }
    if (changed) this.notify();
  }

  subscribe(fn: () => void): () => void {
    this.subs.add(fn);
    return () => {
      this.subs.delete(fn);
    };
  }

  private notify(): void {
    this.subs.forEach((fn) => fn());
  }
}

/** 全局单例（宿主与插件共享同一份清单；插件只能经 cap.ui.layout 读） */
export const viewRegistry = new ViewRegistry();
