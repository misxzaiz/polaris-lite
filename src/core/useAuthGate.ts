/**
 * useAuthGate：壳层门禁 hook（P1 壳层拦截方案）。
 *
 * - mount 时经总线查询 cap.auth status（bootstrap 已 await 插件加载，首帧时 handler 必在）；
 * - 订阅 auth-changed 事件驱动重查（不轮询）；
 * - 无 cap.auth 提供方时按 FAIL_OPEN_WITHOUT_PROVIDER 开关放行（默认 fail-open，可切 fail-closed）；
 * - single-flight：同一时刻只保留一个在途 status 查询；querySeq 丢弃迟到旧响应。
 */
import { useCallback, useEffect, useState } from 'react';
import { host } from './hostRuntime';
import { CAP_AUTH } from './types';

export type GateState = 'pending' | 'authenticated' | 'unauthenticated' | 'open-no-provider';

/** 无权限插件时的策略：true=放行（开发工作台默认），false=锁死（生产可切） */
const FAIL_OPEN_WITHOUT_PROVIDER = true;

interface AuthStatusResult {
  status: 'authenticated' | 'unauthenticated';
  user: { id: string; name: string; roles: string[] } | null;
  tokenDigest?: string;
  expiresAt?: number;
}

let inFlight: Promise<void> | null = null;
let querySeq = 0;

export function useAuthGate(): { state: GateState; refresh: () => void } {
  const [state, setState] = useState<GateState>('pending');

  const query = useCallback(() => {
    const seq = ++querySeq;
    // single-flight：若已有在途查询，等它结束后再发起新查询
    const run = async () => {
      const res = await host.bus.dispatch('core', ['cap.auth'], { target: CAP_AUTH, action: 'status' });
      if (seq !== querySeq) return; // 迟到旧响应，丢弃
      if (!res.ok) {
        // unknown cap = 无权限插件提供方
        setState(FAIL_OPEN_WITHOUT_PROVIDER ? 'open-no-provider' : 'unauthenticated');
        console.warn('[polaris-lite] cap.auth 提供方未启用，壳层按 ' + (FAIL_OPEN_WITHOUT_PROVIDER ? 'fail-open' : 'fail-closed') + ' 处理');
        return;
      }
      const result = res.data as AuthStatusResult | undefined;
      setState(result?.status === 'authenticated' ? 'authenticated' : 'unauthenticated');
    };
    if (inFlight) {
      void inFlight.then(() => {
        if (seq === querySeq) return run();
      });
    } else {
      inFlight = run().finally(() => {
        if (seq === querySeq) inFlight = null;
      });
    }
  }, []);

  useEffect(() => {
    query();
    // 订阅 auth-changed（核心内部订阅，免 events 校验）
    const off = host.subscribe('auth-changed', () => query());
    return () => {
      off();
    };
  }, [query]);

  const refresh = useCallback(() => query(), []);
  return { state, refresh };
}
