/**
 * voice-radio — 播报控制器（状态机 + 无限段循环 + 三路中断 + 插话/补充 + 可选工具查证）。
 * 自 Polaris radioBroadcastController 移植；AI 通道用 lite 的流式总线，每段一个一次性轮次，
 * 段末（message.done / loop.done / stream.error）下降沿取全文。
 *
 * AI 通道双模（toolsMode 开关，面板可切）：
 *  - off（默认）：cap.ai.chat 直连——纯聊天，最快出稿；
 *  - on：cap.agent.loop 编排——AI 可在生成播报前调用工具（browser 搜索/读正文、
 *    files、MCP 等）查证，查完输出正文。工具卡事件转发到对话流可见。
 *    注意：无工具注册时 agent-loop 直通 cap.ai.chat，行为与 off 一致。
 *
 * 无限播报循环（两个触发点汇聚到 requestNextSegment）：
 *  1. 段级提前量：每句播完 onEnd → maybeAdvanceByLookahead，队列低水位且无段在途时
 *     提前生成下一段（播当前段时后台并行生成，消除段间静默）；
 *  2. 队列播空 onQueueDrained → 无段在途则请求下一段。
 *
 * 插话 / 临时补充（对齐 Polaris P2-2 半双工）：
 *  - interject(text)：播放暂停 → 以插话为 prompt 生成回应段（不计轮次）→ 回复入队时恢复播放；
 *    段在途时插话暂存，收尾后自动响应。
 *  - supplement(text)：立即中断当前在途段（AI interrupt + 清播放队列，不停主循环）→
 *    以补充内容为 prompt 立即请求下一段。
 */
import {
  SEGMENT_LOOKAHEAD_SENTENCES,
  SEGMENT_TIMEOUT_MS,
  MAX_CONSECUTIVE_ERRORS,
  promptForDirection,
  promptForSwitchTopic,
  promptForInterject,
  promptForSupplement,
  TOOL_MODE_SYSTEM_SUFFIX,
  VOICE_DIRECTION_SUFFIX,
  extractVoiceDirection,
  BGM_BY_DIRECTION,
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
  /** 工具查证模式：on = 走 agent-loop 编排（AI 可调工具），off = 纯聊天直连 */
  toolsMode?: boolean;
  /** 背景音乐：on = 服务端合成垫乐循环播放（音量低垫） */
  bgmMode?: boolean;
  /** BGM 风格（calm/upbeat/story/tech；缺省按方向自动映射） */
  bgmStyle?: string;
}

type Listener = (snapshot: RadioSnapshot) => void;

interface ChatEventEnvelope {
  kind: string;
  payload?: Record<string, unknown>;
  source?: string;
}

/** 段请求种类（决定 prompt 与轮次计数） */
type SegmentKind = 'normal' | 'switch' | 'interject' | 'supplement';

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
  private toolsMode = false;
  private bgmMode = false;
  private bgmStyle = 'auto';

  // 睡眠定时
  private sleepUntil = 0;
  private sleepAfterSegment = false;
  private sleepFading = false;
  private sleepTimer: ReturnType<typeof setInterval> | null = null;
  private paused = false;

  private stopped = false;
  private running = false;
  private stopReason: StopReason | null = null;
  /** 当前在途段的中断柄（stop/中断补充时调用） */
  private segmentCancel: (() => void) | null = null;
  private pendingSegment = false;
  /** 段级流式聚合的退订（每段注册、段末退订） */
  private offStream: (() => void) | null = null;
  private lastSegmentSummary = '';
  private topicSwitchPending = false;
  /** 待响应插话（段在途时暂存，收尾后响应） */
  private queueInterject: string | null = null;
  /** 当前在途段是否插话回应（回复入队时恢复播放、不计轮次） */
  private interjectActive = false;

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
    this.toolsMode = opts.toolsMode === true;
    this.bgmMode = opts.bgmMode === true;
    this.bgmStyle = opts.bgmStyle || 'auto';
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
    this.queueInterject = null;
    this.interjectActive = false;

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

    // 背景音乐：fire-and-forget 拉取垫乐循环（失败静默——BGM 是增强不是依赖）
    if (this.bgmMode) {
      void this.startBgm();
    }

    // 进入主循环：请求第一段
    this.requestNextSegment();
  }

  /** 拉取（服务端缓存）并启动 BGM 循环 */
  private async startBgm(): Promise<void> {
    try {
      const style = this.bgmStyle && this.bgmStyle !== 'auto'
        ? this.bgmStyle
        : BGM_BY_DIRECTION[this.direction.kind];
      const resp = await fetch(`/api/voice-radio/bgm?style=${encodeURIComponent(style)}`, { credentials: 'include' });
      const j = (await resp.json().catch(() => null)) as { ok?: boolean; dataUrl?: string } | null;
      if (j?.ok && j.dataUrl && this.running && !this.stopped) {
        this.player.startBgm(j.dataUrl);
      }
    } catch { /* BGM 失败不影响播报 */ }
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
    this.abortSegment();

    this.nowPlayingText = null;
    this.consecutiveErrors = 0;
    this.lastError = wasError ? this.lastError : null;
    this.clearSleepTimer();
    this.sleepUntil = 0;
    this.sleepAfterSegment = false;
    this.sleepFading = false;
    this.paused = false;
    this.queueInterject = null;
    this.interjectActive = false;

    this.setStatus('idle');
    this.emit();
  }

  /**
   * 中断当前在途段（不停播报主循环）：「立即中断补充」的前半步。
   * - 退订本段流事件 + interrupt 当前轮次 + 清播放队列（代际+1，丢掉未播句）；
   * - running/stopped 不动 → afterSegmentFinished 收尾后自然继续主循环。
   */
  private abortSegment(): void {
    this.unbindStream();
    const cancel = this.segmentCancel;
    this.segmentCancel = null;
    cancel?.();
    this.pendingSegment = false;
    this.interjectActive = false;
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
    if (!this.canInterrupt()) return;
    this.direction = { kind: direction.kind, text };
    this.topicSwitchPending = true;
    this.lastSegmentSummary = '';
    this.player.setOptions({ mediaTitle: `${DIRECTION_LABEL[direction.kind]} · ${text}` });
    this.emit();
    if (!this.pendingSegment) this.requestNextSegment();
  }

  /**
   * 插话（临时补充，半双工，对齐 Polaris P2-2）：暂停当前播放 → 以插话为请求生成
   * 回应段（不计轮次）→ 回复入队时恢复播放。段在途时暂存，收尾后自动响应。
   */
  interject(text: string): void {
    const trimmed = text.trim();
    if (!trimmed || !this.canInterrupt()) return;
    if (this.pendingSegment) {
      // 在途段未完：暂存插话，收尾衔接点以后续请求消费
      this.queueInterject = trimmed;
      return;
    }
    this.queueInterject = trimmed;
    this.requestNextSegment();
  }

  /**
   * 立即中断补充：中止当前在途段（AI 流 + 未播队列立即停），马上以补充内容为
   * 请求生成下一段。与 interject 的区别：不播完当前段等收尾，立即掉头。
   */
  supplement(text: string): void {
    const trimmed = text.trim();
    if (!trimmed || !this.canInterrupt()) return;
    // 无条件中断：在途 AI 段（若有）abort + 播放器代际+1 清队列（未播句立即静音，
    // 在途合成一并中止）。注意 pendingSegment 为 false 时队列里仍可能堆着未播句
    // （合成/播放滞后于生成），必须同样清掉——否则补充内容会排在旧内容后面。
    this.abortSegment();
    this.player.stop();
    this.paused = false;
    this.queueInterject = null;
    this.lastSegmentSummary = ''; // 补充内容重新起头，不续旧摘要
    this.emit();
    this.requestNextSegmentWithPrompt(promptForSupplement(trimmed), 'supplement');
  }

  /** 播报中是否可打断（idle/error/stopping 不可） */
  private canInterrupt(): boolean {
    if (this.stopped || !this.running) return false;
    if (this.status === 'stopping' || this.status === 'idle' || this.status === 'error') return false;
    return true;
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

    // 插话优先（半双工）：请求发出即暂停当前播放，回复到达（finishOk）时恢复
    if (this.queueInterject) {
      const text = this.queueInterject;
      this.queueInterject = null;
      this.player.pause();
      this.paused = true;
      this.requestNextSegmentWithPrompt(promptForInterject(text), 'interject');
      return;
    }

    const kind: SegmentKind = this.topicSwitchPending ? 'switch' : 'normal';
    const prompt = this.buildNextSegmentPrompt();
    this.requestNextSegmentWithPrompt(prompt, kind);
  }

  private requestNextSegmentWithPrompt(prompt: string, kind: SegmentKind): void {
    const systemPrompt = promptForDirection(this.direction.kind, this.direction.text)
      + VOICE_DIRECTION_SUFFIX
      + (this.toolsMode ? TOOL_MODE_SYSTEM_SUFFIX : '');
    this.setStatus('generating');
    this.runSegment(prompt, systemPrompt, kind);
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
   * 执行一次段生成。toolsMode=on 走 cap.agent.loop（AI 可先调工具查证再出稿），
   * off 走 cap.ai.chat 直连。每段独立 sessionId 隔离；事件按 sessionId+messageId 防串台。
   * 下降沿：message.done / loop.done / stream.error → 清洗入队。
   */
  private runSegment(prompt: string, systemPrompt: string, kind: SegmentKind): void {
    const api = this.api;
    if (!api) return;
    const sessionId = shortId('radio-s');
    const messageId = shortId('radio-m');
    const useLoop = this.toolsMode;
    let text = '';
    let settled = false;
    this.pendingSegment = true;
    if (kind === 'interject') this.interjectActive = true;

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
      // AI 自行配音：剥离首行 [voice:…] 语气标注，作为本段合成 style；
      // 无标注（模型未遵守/旧格式）时回退全局 style，行为不变。
      const extracted = extractVoiceDirection(sanitizeForSpeech(text));
      const clean = extracted.text;
      const segStyle = extracted.style || this.style;
      if (!clean.trim()) {
        this.consecutiveErrors++;
        this.checkErrorThreshold('段文本为空');
      } else {
        this.consecutiveErrors = 0;
        this.lastSegmentSummary = clean.slice(0, 120);
        if (this.interjectActive) {
          // 插话回应：不计轮次；恢复半双工播放
          this.interjectActive = false;
          this.player.resume();
          this.paused = false;
        } else {
          this.segmentIndex++;
        }
        this.player.enqueueSegment(clean, segStyle);
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
      if (this.interjectActive) {
        // 插话请求失败：恢复播放不滞留暂停
        this.interjectActive = false;
        this.player.resume();
        this.paused = false;
      }
      this.consecutiveErrors++;
      this.checkErrorThreshold(msg);
      this.emit();
      this.afterSegmentFinished();
    };

    const eventChannel = useLoop ? 'cap.agent.loop:event' : 'cap.ai.chat:event';
    const off = api.listen(eventChannel, (raw) => {
      const ev = (raw ?? {}) as ChatEventEnvelope;
      const inner = (ev.payload ?? {}) as { sessionId?: string; messageId?: string; delta?: string; message?: string; interrupted?: boolean };
      // 防串台：只消费本段轮次的事件
      if (inner.sessionId && inner.sessionId !== sessionId) return;
      if (inner.messageId && inner.messageId !== messageId) return;
      if (ev.kind === 'message.delta' && inner.delta) {
        text += inner.delta;
      } else if (ev.kind === 'message.reasoning' || ev.kind === 'tool.card' || ev.kind === 'tool.result') {
        // 思考流/工具卡不进正文；工具卡事件由对话流自行渲染（电台字幕只显示正文）
      } else if (ev.kind === 'loop.done' || ev.kind === 'message.done') {
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
      void api.dispatch({
        target: useLoop ? 'cap.agent.loop' : 'cap.ai.chat.interrupt',
        action: 'interrupt',
        payload: { sessionId, messageId },
      }).catch(() => undefined);
      off();
    };

    void api
      .dispatch({
        target: useLoop ? 'cap.agent.loop' : 'cap.ai.chat',
        action: 'start',
        payload: {
          sessionId,
          messageId,
          // 首条 system 消息带方向模板（+工具纪律附录）；real-engine/agent-loop 均支持 system role
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
      this.abortSegment();
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
