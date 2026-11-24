/**
 * voice-radio — 句级播放器（预取流水线 + 代际打断 + MediaSession 锁屏）。
 * 自 Polaris voiceBroadcastPlayer 移植；音频用浏览器原生 <audio>（手机锁屏/熄屏可播的关键）。
 */
import {
  PREFETCH_DEPTH,
  SYNTH_TIMEOUT_MS,
  SYNTH_MAX_RETRIES,
  type QueueItem,
  type RadioTranscript,
} from './core';
import { synthesizeVoice } from './voiceClient';
import { shortId } from './core';

/** MediaSession 最小类型（避免依赖较新 DOM lib 类型） */
interface MediaSessionLike {
  metadata: unknown;
  playbackState: string;
  setActionHandler: (action: 'play' | 'pause' | 'stop', handler: (() => void) | null) => void;
}

export interface PlayerCallbacks {
  /** 开始播放某句 */
  onStart?: (text: string) => void;
  /** 一句播放结束 */
  onEnd?: () => void;
  /** 队列已空且无在途合成（段尾触发，控制器据此请求下一段） */
  onQueueDrained?: () => void;
  /** 合成失败（单句跳过，不中断整体） */
  onSynthError?: (item: QueueItem, error: string) => void;
  /** 队列空但仍有在途合成（generating 子状态） */
  onPendingSynth?: (count: number) => void;
  /** 锁屏 MediaSession stop 手势 → 转交控制器三路中断 */
  onStopRequest?: () => void;
}

export class VoiceRadioPlayer {
  private queue: QueueItem[] = [];
  /** 代际：stop() 时 ++，晚到音频 / 晚到 onended 校验用 */
  private generation = 0;
  private audio: HTMLAudioElement | null = null;
  private current: QueueItem | null = null;
  private pendingSynths = new Map<string, AbortController>();
  private callbacks: PlayerCallbacks = {};
  private voice = '冰糖';
  private style?: string;
  private volume = 1;
  private rate = 1;
  /** 锁屏会话标题（话题名） */
  private mediaTitle: string | null = null;
  /** BGM 循环音频（独立元素，低音量与人声并行；不参与代际/队列） */
  private bgmAudio: HTMLAudioElement | null = null;
  private bgmVolume = 0.14;

  setCallbacks(cb: PlayerCallbacks): void {
    this.callbacks = { ...this.callbacks, ...cb };
  }

  setOptions(opts: { voice?: string; style?: string; rate?: number; mediaTitle?: string }): void {
    if (opts.voice !== undefined) this.voice = opts.voice;
    if (opts.style !== undefined) this.style = opts.style;
    if (opts.rate !== undefined) this.setRate(opts.rate);
    if (opts.mediaTitle !== undefined) this.mediaTitle = opts.mediaTitle;
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.audio) this.audio.volume = this.volume;
  }

  /** 开启/更换 BGM（dataUrl 循环播放，音量固定低垫）。url 为空则停止 BGM。 */
  startBgm(url: string): void {
    this.stopBgm();
    try {
      const a = new Audio(url);
      a.loop = true;
      a.volume = this.bgmVolume;
      a.preload = 'auto';
      this.bgmAudio = a;
      void a.play().catch(() => { /* 自动播放被拒：随人声播放后再启动 */ });
    } catch { /* 忽略 */ }
  }

  stopBgm(): void {
    if (this.bgmAudio) {
      try { this.bgmAudio.pause(); } catch { /* 忽略 */ }
      this.bgmAudio = null;
    }
  }

  /** BGM 跟随人声暂停/恢复（半双工插话时静音垫乐） */
  private syncBgmPlayback(playing: boolean): void {
    if (!this.bgmAudio) return;
    try {
      if (playing) void this.bgmAudio.play().catch(() => {});
      else this.bgmAudio.pause();
    } catch { /* 忽略 */ }
  }

  setRate(rate: number): void {
    this.rate = Math.max(0.5, Math.min(4, rate));
    if (this.audio) this.audio.playbackRate = this.rate;
  }

  get queueLength(): number {
    return this.queue.length;
  }

  get hasPendingSynth(): boolean {
    return this.pendingSynths.size > 0;
  }

  /** 队列中尚未就绪可播的句数（段级提前量用） */
  get pendingCount(): number {
    return this.queue.filter((q) => q.status === 'pending' || q.status === 'synthesizing').length;
  }

  get currentText(): string | null {
    return this.current?.text ?? null;
  }

  /** 字幕跟读文稿（队列即文稿） */
  getTranscript(): RadioTranscript | null {
    if (this.queue.length === 0 && !this.current) return null;
    const currentId = this.current?.id;
    const currentIndex = currentId ? this.queue.findIndex((q) => q.id === currentId) : -1;
    return {
      lines: this.queue.map((q) => ({ id: q.id, text: q.text, status: q.status })),
      currentIndex,
    };
  }

  /** 淡出当前音频（睡眠定时到点；线性降音量后暂停） */
  async fadeOut(ms = 3000): Promise<void> {
    const audio = this.audio;
    if (!audio || ms <= 0) return;
    const startVolume = audio.volume;
    const step = 50;
    const steps = Math.max(1, Math.floor(ms / step));
    for (let i = 1; i <= steps; i++) {
      await new Promise((r) => setTimeout(r, step));
      if (this.audio !== audio) return; // 期间已 stop/换句：放弃淡出
      audio.volume = Math.max(0, startVolume * (1 - i / steps));
    }
    if (this.audio === audio) audio.pause();
  }

  /** 加入一段清洗后的文本：切句后逐句预取。segStyle = 本段 AI 语气标注（[voice:…]），
   *  为空时回退会话级 style。 */
  enqueueSegment(text: string, segStyle?: string): void {
    if (!text || !text.trim()) return;
    const sentences = text
      .split(/(?<=[。！？!?；;\n])/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (sentences.length === 0) return;
    const style = (segStyle ?? this.style)?.trim() || undefined;
    for (const sentence of sentences) {
      this.queue.push({ id: shortId('q'), text: sentence, url: null, status: 'pending', gen: this.generation, synthAttempts: 0, style });
    }
    this.pump();
  }

  /** 清空队列 + 中止在途合成（stop 路径） */
  private clear(): void {
    this.queue = [];
    this.pendingSynths.forEach((abort) => abort.abort());
    this.pendingSynths.clear();
  }

  /** 停止播放：代际 +1、清队列、中止合成、暂停当前音频 */
  stop(): void {
    this.generation++;
    this.clear();
    if (this.audio) {
      this.audio.pause();
      this.audio.onended = null;
      this.audio.onerror = null;
      this.audio = null;
    }
    this.current = null;
    this.stopBgm();
    this.syncPlaybackState('paused');
    this.callbacks.onQueueDrained?.();
  }

  /** 播放暂停（不中断队列与合成；移动端锁屏保活靠音频元素持续出声） */
  pause(): void {
    this.audio?.pause();
    this.syncBgmPlayback(false);
    this.syncPlaybackState('paused');
  }

  /** 恢复播放 */
  resume(): void {
    if (this.current && this.current.url && this.audio) {
      void this.audio.play().catch(() => { /* 恢复失败：下一句播自然接管 */ });
      this.syncBgmPlayback(true);
      this.syncPlaybackState('playing');
    }
  }

  /** 流水线主循环 */
  private pump(): void {
    if (!this.current) {
      const head = this.queue.find((q) => q.status !== 'done' && q.status !== 'failed');
      if (!head) {
        if (this.hasPendingSynth) this.callbacks.onPendingSynth?.(this.pendingSynths.size);
        else this.callbacks.onQueueDrained?.();
        return;
      }
      if (head.status === 'ready') this.playItem(head);
      else if (head.status === 'pending') this.synthesize(head);
    }
    this.prefetch();
  }

  /** 预取：合成线领先播放线 PREFETCH_DEPTH */
  private prefetch(): void {
    const inFlight = this.queue.filter((q) => q.status === 'synthesizing').length;
    let need = PREFETCH_DEPTH - inFlight;
    if (need <= 0) return;
    for (const item of this.queue) {
      if (need <= 0) break;
      if (item.status === 'pending') {
        this.synthesize(item);
        need--;
      }
    }
  }

  /** 合成失败统一收口：未达重试上限 → 重置 pending；已达 → failed + onSynthError */
  private markSynthFailed(item: QueueItem, reason: string): void {
    const attempts = item.synthAttempts ?? 0;
    if (attempts < SYNTH_MAX_RETRIES) {
      item.synthAttempts = attempts + 1;
      item.status = 'pending';
      return;
    }
    item.status = 'failed';
    this.callbacks.onSynthError?.(item, reason);
  }

  /** 合成一项（带代际 + 超时 + Abort） */
  private synthesize(item: QueueItem): void {
    if (item.status !== 'pending') return;
    item.status = 'synthesizing';
    const abort = new AbortController();
    this.pendingSynths.set(item.id, abort);
    const gen = item.gen;
    const timer = setTimeout(() => {
      if (gen !== this.generation) return;
      this.pendingSynths.delete(item.id);
      if (item.status === 'synthesizing') {
        this.markSynthFailed(item, '合成超时');
        this.pump();
      }
    }, SYNTH_TIMEOUT_MS);

    synthesizeVoice({ text: item.text, voice: this.voice, style: item.style ?? this.style, signal: abort.signal })
      .then((res) => {
        clearTimeout(timer);
        if (abort.signal.aborted) return;
        this.pendingSynths.delete(item.id);
        if (gen !== this.generation) return; // 旧代结果丢弃
        if (res.ok && res.dataUrl) {
          item.url = res.dataUrl;
          item.status = 'ready';
        } else {
          this.markSynthFailed(item, res.error ?? '合成失败');
        }
        this.pump();
      })
      .catch((e: unknown) => {
        clearTimeout(timer);
        if (abort.signal.aborted) return;
        this.pendingSynths.delete(item.id);
        if (gen !== this.generation) return;
        this.markSynthFailed(item, e instanceof Error ? e.message : String(e));
        this.pump();
      });
  }

  /** 播放队头 ready 项 */
  private playItem(item: QueueItem): void {
    if (item.status !== 'ready' || !item.url) return;
    this.current = item;
    item.status = 'playing';

    const audio = new Audio(item.url);
    // 手机后台/熄屏播放三件套（对齐 Polaris voiceBroadcastPlayer，纯 Web 标准）：
    // - preload='auto'：句间切换零等待（上一句 ended → 下一句立即出声，音频元素
    //   不停摆，Android WebView/Chrome 不会因「无可播放媒体」回收进程）；
    // - playsInline：iOS Safari/WebView 内联播放（不加会自动全屏接管）；
    // - MediaSession（applyMediaSession）：锁屏通知栏标题/作者 + 耳机/通知栏控制。
    audio.preload = 'auto';
    // playsInline：iOS Safari/WebView 内联播放（不加会自动全屏接管）。
    // TS DOM lib（ES2020）未收录该属性，按标准属性名+webkit 前缀兜底设置。
    try { (audio as HTMLAudioElement & { playsInline?: boolean }).playsInline = true; } catch { /* 忽略 */ }
    try { audio.setAttribute('playsinline', ''); audio.setAttribute('webkit-playsinline', ''); } catch { /* 忽略 */ }
    this.audio = audio;
    audio.volume = this.volume;
    audio.playbackRate = this.rate;
    const gen = item.gen;
    this.applyMediaSession(item);

    audio.onplay = () => {
      if (gen !== this.generation) {
        audio.pause();
        return;
      }
      this.syncBgmPlayback(true);
      this.callbacks.onStart?.(item.text);
    };

    audio.onended = () => {
      if (gen !== this.generation) return;
      if (this.current === item) this.current = null;
      item.status = 'done';
      if (this.audio === audio) this.audio = null;
      this.callbacks.onEnd?.();
      this.pump();
    };

    audio.onerror = () => {
      if (gen !== this.generation) return;
      if (this.current === item) this.current = null;
      item.status = 'failed';
      if (this.audio === audio) this.audio = null;
      this.callbacks.onSynthError?.(item, '音频播放失败');
      this.pump();
    };

    audio.play().catch(() => {
      if (gen !== this.generation) return;
      if (this.current === item) this.current = null;
      item.status = 'failed';
      if (this.audio === audio) this.audio = null;
      this.callbacks.onSynthError?.(item, '音频播放失败');
      this.pump();
    });
  }

  /**
   * 锁屏 / 系统媒体会话：每句播放时刷新 metadata（话题 + 当前句摘要），
   * 注册 play/pause/stop 手势。stop 手势转交控制器三路中断。
   * 环境不支持（老内核）静默跳过。这是手机锁屏/熄屏播放 + 通知栏控制的关键。
   */
  private applyMediaSession(item: QueueItem): void {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    try {
      const ms = (navigator as unknown as { mediaSession?: MediaSessionLike }).mediaSession;
      if (!ms) return;
      const MediaMetadataCtor = (
        globalThis as { MediaMetadata?: new (init: { title: string; artist: string; album: string }) => unknown }
      ).MediaMetadata;
      if (MediaMetadataCtor) {
        ms.metadata = new MediaMetadataCtor({
          title: this.mediaTitle ?? 'AI 电台',
          artist: item.text.slice(0, 40),
          album: 'polaris-lite 电台',
        });
      }
      ms.playbackState = 'playing';
      ms.setActionHandler('play', () => { void this.audio?.play().catch(() => {}); });
      ms.setActionHandler('pause', () => { this.audio?.pause(); });
      ms.setActionHandler('stop', () => { this.callbacks.onStopRequest?.(); });
    } catch {
      // 个别内核 setActionHandler 抛错：降级为仅展示，不阻塞播放
    }
  }

  /** 播放结束/暂停时同步 MediaSession 状态（锁屏按钮态正确） */
  private syncPlaybackState(state: 'playing' | 'paused'): void {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    try {
      const ms = (navigator as unknown as { mediaSession?: MediaSessionLike }).mediaSession;
      if (ms) ms.playbackState = state;
    } catch { /* 忽略 */ }
  }
}
