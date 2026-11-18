/**
 * 信任策略（宿主侧授权表）。
 *
 * 问题：如果「能力授权」只看插件自己 manifest 里的 capabilities，那声明权 = 授权权，
 * 任何插件都能给自己签发 cap.meta / cap.ai.chat —— 这道 gate 就只是装饰。
 *
 * 解法（信任模型 B：可信但需明示的一方插件）：
 * - `public/grants.json` 是宿主侧授权表（随代码评审、进版本控制）；
 * - manifest 只是「申请」，实际生效权限 = manifest ∩ grants；
 * - grants 里没有登记的插件按 manifest 自声明放行，但标记 `listed=false`，
 *   由宿主在启动时告警（不 brick 应用，同时保持可发现）。
 *
 * 未在 grants 中出现的权限不会生效，且会被记录到 `denied` 供面板/日志追溯。
 */
import type { LiteManifest } from './types';

export interface PluginGrant {
  capabilities?: string[];
  provides?: string[];
  events?: string[];
}

export interface GrantsFile {
  version?: number;
  /** 未登记插件的兜底策略：declare=按 manifest 放行并告警（默认）；deny=一律零权限 */
  unlistedPolicy?: 'declare' | 'deny';
  plugins?: Record<string, PluginGrant>;
}

export interface EffectivePolicy {
  pluginId: string;
  /** 是否在 grants.json 中登记 */
  listed: boolean;
  capabilities: string[];
  provides: string[];
  events: string[];
  /** manifest 申请了但未被授权（= 被收紧掉的）项 */
  denied: { field: 'capabilities' | 'provides' | 'events'; item: string }[];
}

const EMPTY: string[] = [];

function intersect(declared: string[] | undefined, granted: string[] | undefined, field: EffectivePolicy['denied'][number]['field'], denied: EffectivePolicy['denied']): string[] {
  const d = declared ?? EMPTY;
  const g = granted ?? EMPTY;
  const out: string[] = [];
  for (const item of d) {
    if (g.includes(item)) out.push(item);
    else denied.push({ field, item });
  }
  // 授权表里有、manifest 没申请的，不生效（申请与授权必须双向一致）
  return out;
}

export function resolvePolicy(manifest: LiteManifest, grants: GrantsFile | null): EffectivePolicy {
  const pluginId = manifest.id;
  const grant = grants?.plugins?.[pluginId];
  const denied: EffectivePolicy['denied'] = [];

  if (!grant) {
    const policy = grants?.unlistedPolicy ?? 'declare';
    if (policy === 'deny') {
      return {
        pluginId,
        listed: false,
        capabilities: [],
        provides: [],
        events: [],
        denied: [
          ...(manifest.capabilities ?? []).map((item) => ({ field: 'capabilities' as const, item })),
          ...(manifest.provides ?? []).map((item) => ({ field: 'provides' as const, item })),
          ...(manifest.events ?? []).map((item) => ({ field: 'events' as const, item })),
        ],
      };
    }
    return {
      pluginId,
      listed: false,
      capabilities: [...(manifest.capabilities ?? EMPTY)],
      provides: [...(manifest.provides ?? EMPTY)],
      events: [...(manifest.events ?? EMPTY)],
      denied,
    };
  }

  return {
    pluginId,
    listed: true,
    capabilities: intersect(manifest.capabilities, grant.capabilities, 'capabilities', denied),
    provides: intersect(manifest.provides, grant.provides, 'provides', denied),
    events: intersect(manifest.events, grant.events, 'events', denied),
    denied,
  };
}

/** 拉取授权表；失败返回 null（调用方据此走 unlisted 兜底并告警） */
export async function loadGrants(url: string): Promise<GrantsFile | null> {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as GrantsFile;
  } catch {
    return null;
  }
}
