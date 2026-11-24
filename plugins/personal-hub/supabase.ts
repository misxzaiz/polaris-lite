/**
 * Supabase REST 极简客户端（零依赖，对齐 Polaris personalHub supabase.ts 的配置回退语义）。
 *
 * 为什么手写：polaris-lite 插件构建不引 @supabase/supabase-js（宿主无此依赖），
 * 而本插件只用到了 auth（登录/注册/会话）与 links 表 CRUD——直接走 Supabase
 * 官方 REST/GoTrue HTTP API 即可，量小且稳定。
 *
 * 约定：
 * - apikey/Header 恒带 anon key；登录后 Authorization: Bearer <access_token>；
 * - 会话持久化 localStorage（与 Polaris 侧 sb-<ref>-auth-token 同形 key），
 *   多端同浏览器共享；无自动刷新（anon 场景 JWT 1h，过期即要求重登——
 *   Polaris 侧依赖 SDK 自动 refresh，此处为保零依赖降级，见 server 备注）。
 * - PostgREST 约定：Prefer: return=representation 拿写入后的行。
 */
import type { PersonalHubConfig } from './types';
import { loadConfigSync } from './store';

/** Supabase 默认配置（personal-hub 既有项目），用户在设置页留空时回退使用 */
export const DEFAULT_SUPABASE_URL = 'https://nynpqrwsautudqblxoir.supabase.co';
export const DEFAULT_SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im55bnBxcndzYXV0dWRxYmx4b2lyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjI3MDkzMDksImV4cCI6MjA3ODI4NTMwOX0.rz79QkbbSEQPsrSdbYYFL-nuV_MwdAWhf4-gQ0j_fz4';

/** 读取生效的 personalHub 配置（cap.config 持久化，空值回退内置默认）。 */
export function getPersonalHubConfig(): PersonalHubConfig {
  const cfg = loadConfigSync();
  return {
    supabaseUrl: cfg?.supabaseUrl?.trim() || DEFAULT_SUPABASE_URL,
    supabaseAnonKey: cfg?.supabaseAnonKey?.trim() || DEFAULT_SUPABASE_ANON_KEY,
    encryptionKey: cfg?.encryptionKey ?? '',
  };
}

/** 读取原始配置（不回退默认），用于设置页判断用户是否自定义过。 */
export function getRawPersonalHubConfig(): PersonalHubConfig {
  const cfg = loadConfigSync();
  return {
    supabaseUrl: cfg?.supabaseUrl ?? '',
    supabaseAnonKey: cfg?.supabaseAnonKey ?? '',
    encryptionKey: cfg?.encryptionKey ?? '',
  };
}

/** 是否已完成 Supabase 配置（默认值或自定义值任一非空即视为已配置） */
export function isSupabaseConfigured(): boolean {
  const { supabaseUrl, supabaseAnonKey } = getPersonalHubConfig();
  return supabaseUrl.trim().length > 0 && supabaseAnonKey.trim().length > 0;
}

// ── 会话（localStorage 持久化） ─────────────────────────────────────────────

export interface SupabaseSession {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
  user?: { id: string; email?: string };
}

const SESSION_KEY = 'personal-hub.auth.session.v1';

export function loadSession(): SupabaseSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as SupabaseSession;
    return s?.access_token ? s : null;
  } catch {
    return null;
  }
}

export function saveSession(s: SupabaseSession | null): void {
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  } catch { /* ignore */ }
}

// ── HTTP 基座 ───────────────────────────────────────────────────────────────

export class SupabaseHttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function authHeaders(token?: string | null): Record<string, string> {
  const cfg = getPersonalHubConfig();
  const h: Record<string, string> = {
    apikey: cfg.supabaseAnonKey,
    'Content-Type': 'application/json',
  };
  const t = token ?? loadSession()?.access_token;
  if (t) h.Authorization = `Bearer ${t}`;
  return h;
}

async function httpJson<T>(url: string, init: RequestInit & { token?: string | null } = {}): Promise<T> {
  const { token, ...rest } = init;
  const resp = await fetch(url, {
    ...rest,
    headers: { ...authHeaders(token), ...(rest.headers as Record<string, string> | undefined) },
  });
  const text = await resp.text();
  let body: unknown = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    if (body && typeof body === 'object') {
      // GoTrue/PostgREST 错误形态：{ message } | { msg, error_code } | { error, message_description }
      const b = body as { message?: unknown; msg?: unknown; error?: unknown; hint?: unknown };
      const detail = b.message ?? b.msg ?? b.error ?? b.hint;
      if (detail) msg = String(detail);
    } else if (typeof body === 'string' && body) {
      msg = body;
    }
    throw new SupabaseHttpError(resp.status, msg);
  }
  return body as T;
}

// ── GoTrue auth ─────────────────────────────────────────────────────────────

export interface AuthResponse {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  user?: { id: string; email?: string };
  message?: string;
}

function url(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/auth/v1${path}`;
}

export async function authSignUp(email: string, password: string): Promise<AuthResponse> {
  const cfg = getPersonalHubConfig();
  return httpJson<AuthResponse>(url(cfg.supabaseUrl, '/signup'), {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export async function authSignIn(email: string, password: string): Promise<AuthResponse> {
  const cfg = getPersonalHubConfig();
  return httpJson<AuthResponse>(url(cfg.supabaseUrl, '/token?grant_type=password'), {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export async function authUser(token?: string | null): Promise<{ id: string; email?: string } | null> {
  const cfg = getPersonalHubConfig();
  try {
    const u = await httpJson<{ id?: string; email?: string } | null>(url(cfg.supabaseUrl, '/user'), { token });
    return u?.id ? { id: u.id, email: u.email } : null;
  } catch {
    return null;
  }
}

export async function authRefresh(refreshToken: string): Promise<AuthResponse> {
  const cfg = getPersonalHubConfig();
  return httpJson<AuthResponse>(url(cfg.supabaseUrl, '/token?grant_type=refresh_token'), {
    method: 'POST',
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
}

// ── PostgREST links CRUD ────────────────────────────────────────────────────

export interface RestQuery {
  select?: string;
  eq?: Record<string, string | number | boolean>;
  contains?: Record<string, string[]>;
  inMap?: Record<string, (string | number | boolean)[]>;
  isNotNull?: string[];
  or?: string;
  /** PostgREST 组合筛选：and=(col.op.v,col.op.v) */
  and?: string;
  order?: { field: string; ascending?: boolean };
  range?: { from: number; to: number };
  count?: boolean;
}

function restUrl(path: string, q: RestQuery = {}): string {
  const cfg = getPersonalHubConfig();
  const u = new URL(`${cfg.supabaseUrl.replace(/\/+$/, '')}/rest/v1${path}`);
  u.searchParams.set('select', q.select ?? '*');
  for (const [k, v] of Object.entries(q.eq ?? {})) u.searchParams.set(k, `eq.${v}`);
  for (const [k, v] of Object.entries(q.contains ?? {})) u.searchParams.set(k, `cs.{${v.join(',')}}`);
  for (const [k, v] of Object.entries(q.inMap ?? {})) u.searchParams.set(k, `in.(${v.join(',')})`);
  for (const col of q.isNotNull ?? []) u.searchParams.set(col, 'not.is.null');
  if (q.or) u.searchParams.set('or', q.or);
  if (q.and) u.searchParams.set('and', `(${q.and})`);
  if (q.order) u.searchParams.set('order', `${q.order.field}.${q.order.ascending ? 'asc' : 'desc'}`);
  return u.toString();
}

export interface RestResult<T> {
  data: T[];
  count: number | null;
}

export async function restSelect<T>(table: string, q: RestQuery = {}): Promise<RestResult<T>> {
  const headers: Record<string, string> = {};
  if (q.count) headers.Prefer = 'count=exact';
  if (q.range) headers.Range = `${q.range.from}-${q.range.to}`;
  const u = restUrl(`/${table}`, q);
  const resp = await fetch(u, { headers: { ...authHeaders(), ...headers } });
  const text = await resp.text();
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try {
      const j = JSON.parse(text) as { message?: string; msg?: string; error?: string; hint?: string };
      msg = String(j.message ?? j.msg ?? j.error ?? j.hint ?? msg);
    } catch { /* keep */ }
    throw new SupabaseHttpError(resp.status, msg);
  }
  const data = (text ? JSON.parse(text) : []) as T[];
  const cr = resp.headers.get('content-range');
  let count: number | null = null;
  if (cr) {
    const m = /\/(\d+)$/.exec(cr);
    if (m) count = Number(m[1]);
  }
  return { data, count };
}

export async function restInsert<T>(table: string, row: Record<string, unknown>): Promise<T> {
  const cfg = getPersonalHubConfig();
  return httpJson<T>(`${cfg.supabaseUrl.replace(/\/+$/, '')}/rest/v1/${table}`, {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(row),
  });
}

export async function restUpdate<T>(table: string, match: Record<string, string>, patch: Record<string, unknown>): Promise<T[]> {
  const cfg = getPersonalHubConfig();
  const u = new URL(`${cfg.supabaseUrl.replace(/\/+$/, '')}/rest/v1/${table}`);
  for (const [k, v] of Object.entries(match)) u.searchParams.set(k, `eq.${v}`);
  return httpJson<T[]>(u.toString(), {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(patch),
  });
}

export async function restDelete(table: string, match: Record<string, string>): Promise<void> {
  const cfg = getPersonalHubConfig();
  const u = new URL(`${cfg.supabaseUrl.replace(/\/+$/, '')}/rest/v1/${table}`);
  for (const [k, v] of Object.entries(match)) u.searchParams.set(k, `eq.${v}`);
  await httpJson<unknown>(u.toString(), { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
}
