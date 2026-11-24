/**
 * personal-hub 配置存取（cap.config 持久化；面板设置页与 supabase.ts 共用）。
 *
 * 与 pocket-ledger 的 store.ts 同构：面板侧经 SlotHostApi.dispatch 走 cap.config
 * （浏览器 localStorage 键空间），多端打开同一账号各自持有（Supabase 是真正的
 * 共享数据面，配置只是连接参数）。
 *
 * 同步读：supabase.ts 的 getPersonalHubConfig() 在渲染路径里频繁被调（卡片解密、
 * 表单构造），不能每次都 await dispatch——模块加载后缓存一份，写入时同步更新。
 */
import type { SlotHostApi } from '@sdk';
import type { PersonalHubConfig } from './types';

export const NS = 'personal-hub';
export const CFG_KEY = 'config';

let api: SlotHostApi | null = null;
let cache: Partial<PersonalHubConfig> | null = null;
let loaded = false;

export function setHostApi(a: SlotHostApi | null): void {
  api = a;
}

/** 同步读缓存（模块初始化后即有值；未加载前返回空对象 → 回退默认连接参数） */
export function loadConfigSync(): Partial<PersonalHubConfig> {
  return cache ?? {};
}

export async function loadConfig(): Promise<Partial<PersonalHubConfig>> {
  if (!api) return cache ?? {};
  try {
    const res = await api.dispatch<{ value?: Partial<PersonalHubConfig> | null }>({
      target: 'cap.config',
      action: 'get',
      payload: { namespace: NS, key: CFG_KEY },
    });
    if (res.ok && res.data?.value && typeof res.data.value === 'object') {
      cache = res.data.value;
    }
  } catch { /* 网络抖动时沿用缓存 */ }
  loaded = true;
  return cache ?? {};
}

export async function saveConfig(cfg: Partial<PersonalHubConfig>): Promise<void> {
  cache = { ...(cache ?? {}), ...cfg };
  await api?.dispatch({
    target: 'cap.config',
    action: 'set',
    payload: { namespace: NS, key: CFG_KEY, value: cache },
  });
}

/** 是否已执行过一次异步加载（面板首屏以此决定「加载中」还是「未配置」） */
export function isConfigLoaded(): boolean {
  return loaded;
}
