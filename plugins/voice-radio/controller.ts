/**
 * voice-radio — 播报控制器（状态机 + 无限段循环 + 三路中断）。
 * 自 Polaris radioBroadcastController 移植；AI 通道从「kind 会话 + kernel 订阅」
 * 改为 lite 的 cap.ai.chat 流式总线（每段一个一次性轮次，message.done 下降沿取全文）。
 *
 * 无限播报循环（两个触发点汇聚到 requestNextSegment）：
 *  1. 段级提前量：每句播完 onEnd → maybeAdvanceByLookahead，队列低水位且无段在途时
 *     提前生成下一段（播当前段时后台并行生成，消除段间静默）；
 *  2. 队列播空 onQueueDrained → 无段在途则请求下一段。
 */
import {
  SEGMENT_LOOKAHEAD_SENTENCES,
  SEGMENT_TIMEOUT_MS,
  MAX_CONSECUTIVE_ERRORS,
  promptForDirection,
  promptForSwitchTopic,
  sanitizeForSpeech,
  DIRECTION_LABEL,
  shortId,
  type RadioDirection,
  type RadioSnapshot,
  type RadioStatus,
  type StopReason,
} from './core';
import { VoiceRadioPlayer } from './player';
import { probeVoice } from './voiceClient';
import type { SlotHostApi } from '@sdk';

export interface StartOptions {
  direction: RadioDirection;
  voice: string;
  style?: string;
  volume?: number;
  rate?: number;
  /** 轮次上限（播满 N 段自动停止；0/undefined = 无限播） */
  maxRounds?: number;
  /** 时长上限（秒；0/undefined = 不限） */
  maxSeconds?: number;
  providerId?: string;
  modelId?: string;
}

type Listener = (snapshot: RadioSnapshot) => void;

interface ChatEventEnvelope {
  kind: string;
  payload?: Record<string, unknown>;
  source?: string;
}

export class RadioController {
  private api: SlotHostApi | null = null;
  private status: RadioStatus = 'idle';
  private direction: RadioDirection = { kind: 'study', text: '' };
  private voice = '冰糖';
  private style?: string;
  private player = new VoiceRadioPlayer();
  private listeners = new Set<Listener>();

  private consecutiveErrors = 0;
  private segmentIndex = 0;
  private segmentCount = 0;
  private nowPlayingText: string | null = null;
  private lastError: string | null = null;
  private startedAt = 0;
  private maxRounds?: number;
  private maxSeconds?: number;
  private providerId?: string;
  private modelId?: string;

  // 睡眠定时
  private sleepUntil = 0;
  private sleepAfterSegment = false;
  private sleepFading = false;
  private sleepTimer: ReturnType<typeof setInterval> | null = null;
  private paused = false;

  private stopped = false;
  private running = false;
  private stopReason: StopReason | null = null;
  /** 当前在途段的中断柄（stop 时调用） */
  private segmentCancel: (() => void) | null = null;
  private pendingSegment = false;
  /** 段级流式聚合的退订（每段注册、段末退订） */
  private offStream: (() => void) | null = null;
  private lastSegmentSummary = '';
  private topicSwitchPending = false;

  setHostApi(api: SlotHostApi): void {
    this.api = api;
  }

  getSnapshot(): RadioSnapshot {
    return {
      status: this.status,
      direction: this.direction,
      segmentCount: this.segmentCount,
      segmentIndex: this.segmentIndex,
      nowPlayingText: this.nowPlayingText,
      error: this.lastError,
      startedAt: this.startedAt,
      transcript: this.player.getTranscript(),
      sleepUntil: this.sleepUntil,
      sleepAfterSegment: this.sleepAfterSegment,
      stopReason: this.stopReason,
      paused: this.paused,
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    this.listeners.forEach((l) => l(snapshot));
  }

  private setStatus(status: RadioStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit();
  }

  /** 开始播报：预检 → 装回调 → 进主循环。Promise 在预检结束（可播或失败）时 resolve。 */
  async start(opts: StartOptions): Promise<void> {
    if (this.status !== 'idle' && this.status !== 'error') return;
    if (!opts.direction.text.trim()) {
      this.lastError = '请填写播报方向';
      this.setStatus('error');
      this.emit();
      return;
    }

    this.stopped = false;
    this.running = true;
    this.paused = false;
    this.consecutiveErrors = 0;
    this.segmentIndex = 0;
    this.segmentCount = 0;
    this.nowPlayingText = null;
    this.lastError = null;
    this.direction = opts.direction;
    this.voice = opts.voice;
    this.style = opts.style;
    this.maxRounds = opts.maxRounds && opts.maxRounds > 0 ? opts.maxRounds : undefined;
    this.maxSeconds = opts.maxSeconds && opts.maxSeconds > 0 ? opts.maxSeconds : undefined;
    this.providerId = opts.providerId || undefined;
    this.modelId = opts.modelId || undefined;
    this.startedAt = Date.now();
    this.stopReason = null;
    this.sleepUntil = 0;
    this.sleepAfterSegment = false;
    this.sleepFading = false;
    this.clearSleepTimer();

    // 上一轮残留（error 态重试）：清播放器，从零开始
    this.player.stop();
    this.segmentCancel = null;
    this.pendingSegment = false;
    this.lastSegmentSummary = '';
    this.topicSwitchPending = false;

    this.player.setCallbacks({
      onStart: (text) => {
        this.nowPlayingText = text;
        this.segmentCount++;
        this.emit();
        this.setStatus('playing');
      },
      onEnd: () => {
        this.nowPlayingText = null;
        this.maybeAdvanceByLookahead();
        this.emit();
      },
      onSynthError: (_item, error) => {
        this.consecutiveErrors++;
        this.checkErrorThreshold(error);
        this.emit();
      },
      onQueueDrained: () => {
        this.handleQueueDrained();
      },
      onPendingSynth: () => {
        if (!this.stopped && this.running) this.setStatus('generating');
      },
      onStopRequest: () => {
        void this.stop('manual');
      },
    });
    this.player.setOptions({
      voice: this.voice,
      style: this.style,
      ...(opts.rate !== undefined ? { rate: opts.rate } : {}),
      mediaTitle: `${DIRECTION_LABEL[opts.direction.kind]} · ${opts.direction.text}`,
    });
    this.player.setVolume(opts.volume ?? 1);

    this.setStatus('starting');

    // 预检：TTS 服务可用性（未配 Key / 上游 401 等直接进 error，避免空跑 AI）
    const probe = await probeVoice(this.voice);
    if (!probe.ok) {
      this.lastError = probe.error ?? '语音服务预检失败';
      this.running = false;
      this.setStatus('error');
      this.emit();
      return;
    }

    // 进入主循环：请求第一段
    this.requestNextSegment();
  }

  /** 停止播报：三路中断（AI 流 + 播放器 + 在途段），幂等，回 idle */
  async stop(reason: StopReason = 'manual'): Promise<void> {
    if (this.status === 'idle') return;
    if (this.status === 'stopping') return;
    this.stopReason = this.status === 'error' ? 'error' : reason;
    const wasError = this.status === 'error';
    this.setStatus('stopping');
    this.stopped = true;
    this.running = false;

    // 路 1：播放器（代际 + 清队列 + 中止合成 + 停音频）
    this.player.stop();

    // 路 2：AI 生成中断（退订本段流事件 + 通知引擎 interrupt）
    this.unbindStream();
    const cancel = this.segmentCancel;
    this.segmentCancel = null;
    cancel?.();
    this.pendingSegment = false;

    this.nowPlayingText = null;
    this.consecutiveErrors = 0;
    this.lastError = wasError ? this.lastError : null;
    this.clearSleepTimer();
    this.sleepUntil = 0;
    this.sleepAfterSegment = false;
    this.sleepFading = false;
    this.paused = false;

    this.setStatus('idle');
    this.emit();
  }

  /** 播放暂停（AI 保持生成；移动端熄屏场景用） */
  pause(): void {
    if (this.status !== 'playing' && this.status !== 'generating') return;
    this.player.pause();
    this.paused = true;
    this.emit();
  }

  /** 恢复播放 */
  resume(): void {
    if (this.status !== 'playing' && this.status !== 'generating') return;
    this.player.resume();
    this.paused = false;
    this.emit();
  }

  /** 播放倍速（即时生效） */
  setRate(rate: number): void {
    this.player.setRate(rate);
  }

  setVolume(v: number): void {
    this.player.setVolume(v);
  }

  /** 睡眠定时：{minutes} 到点淡出停止；{afterSegment} 播完本段停；null 取消 */
  sleep(opts: { minutes?: number; afterSegment?: boolean } | null): void {
    if (this.status === 'idle') return;
    if (opts === null) {
      this.sleepUntil = 0;
      this.sleepAfterSegment = false;
      this.sleepFading = false;
      this.clearSleepTimer();
      this.emit();
      return;
    }
    if (opts.afterSegment) {
      this.sleepAfterSegment = true;
      if (this.player.queueLength === 0 && !this.player.hasPendingSynth && !this.pendingSegment) {
        this.tryGracefulStop();
      }
    } else if (opts.minutes && opts.minutes > 0) {
      this.sleepUntil = Date.now() + opts.minutes * 60_000;
      this.sleepFading = false;
      this.startSleepTimer();
    }
    this.emit();
  }

  /** 换台（播报中切换方向，不停声；旧话题摘要清空不续接） */
  switchTopic(direction: RadioDirection): void {
    const text = direction.text.trim();
    if (!text) return;
    if (this.stopped || !this.running) return;
    if (this.status === 'stopping' || this.status === 'idle' || this.status === 'error') return;
    this.direction = { kind: direction.kind, text };
    this.topicSwitchPending = true;
    this.lastSegmentSummary = '';
    this.player.setOptions({ mediaTitle: `${DIRECTION_LABEL[direction.kind]} · ${text}` });
    this.emit();
    if (!this.pendingSegment) this.requestNextSegment();
  }

  private startSleepTimer(): void {
    if (this.sleepTimer) return;
    this.sleepTimer = setInterval(() => {
      if (this.sleepUntil === 0 || this.sleepFading || this.stopped) {
        if (this.stopped || this.sleepUntil === 0) this.clearSleepTimer();
        return;
      }
      if (Date.now() >= this.sleepUntil) {
        this.sleepFading = true;
        this.clearSleepTimer();
        void this.player.fadeOut(3000).then(() => {
          if (!this.stopped) void this.stop('sleep');
        });
      }
    }, 1000);
  }

  private clearSleepTimer(): void {
    if (this.sleepTimer) {
      clearInterval(this.sleepTimer);
      this.sleepTimer = null;
    }
  }

  // ================================================================
  // 无限段循环
  // ================================================================

  private handleQueueDrained(): void {
    if (this.stopped || !this.running) return;
    if (this.status === 'stopping' || this.status === 'idle') return;
    if (this.reachedLimit()) {
      this.tryGracefulStop();
      return;
    }
    if (this.pendingSegment) {
      this.setStatus('generating');
      return;
    }
    this.requestNextSegment();
  }

  private maybeAdvanceByLookahead(): void {
    if (this.stopped || !this.running) return;
    if (this.status === 'stopping' || this.status === 'idle' || this.status === 'error') return;
    if (this.reachedLimit()) return;
    if (this.pendingSegment) return;
    if (this.player.pendingCount <= SEGMENT_LOOKAHEAD_SENTENCES) {
      this.requestNextSegment();
    }
  }

  private requestNextSegment(): void {
    if (this.stopped || !this.running) return;
    if (this.status === 'stopping' || this.status === 'error') return;
    if (this.pendingSegment) return;
    if (this.reachedLimit()) {
      this.tryGracefulStop();
      return;
    }
    if (!this.api) {
      this.lastError = '宿主能力不可用';
      this.running = false;
      this.setStatus('error');
      this.emit();
      return;
    }

    const prompt = this.buildNextSegmentPrompt();
    const systemPrompt = promptForDirection(this.direction.kind, this.direction.text);
    this.setStatus('generating');
    this.runSegment(prompt, systemPrompt);
  }

  private afterSegmentFinished(): void {
    if (this.stopped || !this.running) return;
    if (this.status === 'stopping' || this.status === 'error' || this.status === 'idle') return;
    if (this.pendingSegment) return;
    if (this.player.queueLength === 0 && !this.player.hasPendingSynth) {
      if (this.reachedLimit()) {
        this.tryGracefulStop();
        return;
      }
      this.requestNextSegment();
    }
  }

  private reachedLimit(): boolean {
    if (this.maxRounds && this.segmentIndex >= this.maxRounds) return true;
    if (this.maxSeconds && this.startedAt > 0 && Date.now() - this.startedAt >= this.maxSeconds * 1000) return true;
    if (this.sleepAfterSegment) return true;
    if (this.sleepUntil > 0 && Date.now() >= this.sleepUntil) return true;
    return false;
  }

  private tryGracefulStop(): void {
    if (this.stopped || !this.running) return;
    if (this.player.queueLength > 0 || this.player.hasPendingSynth || this.pendingSegment) return;
    const reason: StopReason =
      this.sleepUntil > 0 || this.sleepAfterSegment
        ? 'sleep'
        : this.maxRounds && this.segmentIndex >= this.maxRounds
          ? 'max-rounds'
          : 'max-seconds';
    void this.stop(reason);
  }

  /**
   * 执行一次段生成：cap.ai.chat 流式（一次性轮次，独立 sessionId 隔离）。
   * message.delta 累积全文；message.done / stream.error 为下降沿 → 清洗入队。
   */
  private runSegment(prompt: string, systemPrompt: string): void {
    const api = this.api;
    if (!api) return;
    const sessionId = shortId('radio-s');
    const messageId = shortId('radio-m');
    let text = '';
    let settled = false;
    this.pendingSegment = true;

    const timeout = setTimeout(() => {
      if (settled) return;
      settleFail('段生成超时');
    }, SEGMENT_TIMEOUT_MS);

    const finishOk = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      this.unbindStream();
      this.segmentCancel = null;
      this.pendingSegment = false;
      const clean = sanitizeForSpeech(text);
      if (!clean.trim()) {
        this.consecutiveErrors++;
        this.checkErrorThreshold('段文本为空');
      } else {
        this.consecutiveErrors = 0;
        this.lastSegmentSummary = clean.slice(0, 120);
        this.segmentIndex++;
        this.player.enqueueSegment(clean);
      }
      this.emit();
      this.afterSegmentFinished();
    };

    const settleFail = (msg: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      this.unbindStream();
      this.segmentCancel = null;
      this.pendingSegment = false;
      this.consecutiveErrors++;
      this.checkErrorThreshold(msg);
      this.emit();
      this.afterSegmentFinished();
    };

    const off = api.listen('cap.ai.chat:event', (raw) => {
      const ev = (raw ?? {}) as ChatEventEnvelope;
      const inner = (ev.payload ?? {}) as { sessionId?: string; messageId?: string; delta?: string; message?: string; interrupted?: boolean };
      // 防串台：只消费本段轮次的事件
      if (inner.sessionId && inner.sessionId !== sessionId) return;
      if (inner.messageId && inner.messageId !== messageId) return;
      if (ev.kind === 'message.delta' && inner.delta) {
        text += inner.delta;
      } else if (ev.kind === 'message.reasoning') {
        // 思考流不进正文（Polaris 同语义：思考不是播报内容）
      } else if (ev.kind === 'message.done') {
        if (inner.interrupted) {
          settleFail('已中断');
          return;
        }
        finishOk();
      } else if (ev.kind === 'stream.error') {
        settleFail(inner.message ?? '流式请求失败');
      }
    });
    this.offStream = off;

    this.segmentCancel = () => {
      void api.dispatch({ target: 'cap.ai.chat.interrupt', action: 'interrupt', payload: { sessionId, messageId } }).catch(() => undefined);
      off();
    };

    void api
      .dispatch({
        target: 'cap.ai.chat',
        action: 'start',
        payload: {
          sessionId,
          messageId,
          // 首条 system 消息带方向模板：real-engine history 直传支持 system role
          history: [{ role: 'system', content: systemPrompt }],
          prompt,
          ...(this.providerId ? { providerId: this.providerId } : {}),
          ...(this.modelId ? { modelId: this.modelId } : {}),
        },
      })
      .then((res) => {
        if (!res.ok) settleFail(res.error?.message ?? '播报请求未受理');
      })
      .catch((e: unknown) => settleFail(e instanceof Error ? e.message : String(e)));
  }

  private unbindStream(): void {
    this.offStream?.();
    this.offStream = null;
  }

  private checkErrorThreshold(detail: string): void {
    if (this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      this.lastError = `连续失败 ${this.consecutiveErrors} 次，已停止播报（最后错误：${detail}）`;
      this.running = false;
      this.unbindStream();
      this.segmentCancel = null;
      this.pendingSegment = false;
      this.setStatus('error');
    }
  }

  private buildNextSegmentPrompt(): string {
    if (this.topicSwitchPending) {
      this.topicSwitchPending = false;
      return promptForSwitchTopic(this.direction.text);
    }
    if (this.segmentIndex === 0) {
      return `请开始${this.direction.text}的第一次播报。`;
    }
    return `请接续上一段，继续${this.direction.text}的播报。上一段结尾：${this.lastSegmentSummary}`;
  }
}

/** 全局单例控制器（同一时刻只运行一个播报会话） */
export const radioController = new RadioController();
