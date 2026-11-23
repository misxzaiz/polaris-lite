/**
 * voice-radio — TTS 服务端客户端（同源 fetch /api/voice-radio/*，会话 cookie 鉴权）。
 * Key 只在服务端；浏览器侧仅见 configured 布尔与合成结果（base64 dataUrl）。
 */

export interface SynthResult {
  ok: boolean;
  dataUrl?: string;
  sizeBytes?: number;
  cached?: boolean;
  error?: string;
}

export interface VoiceInfo {
  name: string;
  voiceId: string;
  language?: string;
  gender?: string;
}

async function postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const resp = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
    signal,
  });
  const j = (await resp.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!resp.ok) throw new Error(j?.error ?? `HTTP ${resp.status}`);
  return j as T;
}

/** 合成一句（服务端带磁盘缓存；返回 base64 dataUrl 直播） */
export async function synthesizeVoice(args: { text: string; voice: string; style?: string; signal?: AbortSignal }): Promise<SynthResult> {
  try {
    const r = await postJson<SynthResult & { ok: boolean }>('/api/voice-radio/synthesize', { text: args.text, voice: args.voice, style: args.style }, args.signal);
    return r;
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return { ok: false, error: 'aborted' };
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 开播预检：欢迎语现场合成（Key/网络/音色问题在开播前暴露） */
export async function probeVoice(voice: string): Promise<{ ok: boolean; error?: string }> {
  try {
    return await postJson<{ ok: boolean; error?: string }>('/api/voice-radio/probe', { voice });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 预置音色表（失败由调用方用静态兜底） */
export async function listVoices(): Promise<VoiceInfo[]> {
  try {
    const resp = await fetch('/api/voice-radio/voices', { credentials: 'include' });
    if (!resp.ok) return [];
    const j = (await resp.json()) as { voices?: VoiceInfo[] };
    return j.voices ?? [];
  } catch {
    return [];
  }
}

export async function getConfig(): Promise<{ configured: boolean }> {
  try {
    const resp = await fetch('/api/voice-radio/config', { credentials: 'include' });
    if (!resp.ok) return { configured: false };
    return (await resp.json()) as { configured: boolean };
  } catch {
    return { configured: false };
  }
}

export async function saveConfig(patch: { apiKey?: string; baseUrl?: string }): Promise<{ ok: boolean; configured?: boolean; error?: string }> {
  try {
    return await postJson<{ ok: boolean; configured?: boolean }>('/api/voice-radio/config', patch);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
