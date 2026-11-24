/**
 * VoiceRadioPanel：AI 电台面板（无限播报）。
 * 三 Tab：畅听（配置/播报中）/ 音色 / 设置（语音服务 Key）。
 * 播放循环在 controller（cap.ai.chat 段循环 + player 句级流水线）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { radioController } from './controller';
import {
  DIRECTION_LABEL,
  MIMO_VOICES,
  normalizeVoiceId,
  type DirectionKind,
  type RadioSnapshot,
} from './core';
import { getConfig, listVoices, saveConfig, type VoiceInfo } from './voiceClient';
import './panel.css';

type Tab = 'listen' | 'voices' | 'settings';

const DIRECTIONS: DirectionKind[] = ['study', 'story', 'tech', 'news', 'custom'];

const fmtDuration = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
};

/** 进度信息（累计时长 + 句/段 + 上限剩余） */
function ProgressInfo({ snap }: { snap: RadioSnapshot }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const active = snap.status === 'playing' || snap.status === 'generating';
  const elapsed = active && snap.startedAt > 0 ? Date.now() - snap.startedAt : 0;
  const remainSec = snap.sleepUntil > 0 ? Math.max(0, snap.sleepUntil - Date.now()) : null;
  return (
    <div className="vr-progress">
      <span>{fmtDuration(elapsed)}</span>
      <span className="vr-dot">·</span>
      <span>{snap.segmentCount} 句</span>
      <span className="vr-dot">·</span>
      <span>第 {snap.segmentIndex} 段</span>
      {remainSec !== null && (
        <>
          <span className="vr-dot">·</span>
          <span className="vr-sleep-left">定时剩 {fmtDuration(remainSec)}</span>
        </>
      )}
    </div>
  );
}

/** 字幕跟读：全文滚动文稿，当前句高亮 + 自动居中 */
function TranscriptView({ snap }: { snap: RadioSnapshot }) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const t = snap.transcript;
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const cur = box.querySelector<HTMLElement>('.vr-line.playing');
    if (cur) cur.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [snap.transcript?.currentIndex, snap.transcript?.lines.length]);
  if (!t || t.lines.length === 0) return null;
  return (
    <div className="vr-transcript" ref={boxRef} aria-label="字幕跟读">
      {t.lines.map((line, i) => (
        <p
          key={line.id}
          className={`vr-line ${i === t.currentIndex ? (line.status === 'playing' ? 'playing' : 'near') : ''} ${line.status === 'done' ? 'done' : ''} ${line.status === 'failed' ? 'failed' : ''}`}
        >
          {line.text}
        </p>
      ))}
    </div>
  );
}

export function VoiceRadioPanel() {
  const [tab, setTab] = useState<Tab>('listen');
  const [snap, setSnap] = useState<RadioSnapshot>(() => radioController.getSnapshot());

  // 配置表单
  const [kind, setKind] = useState<DirectionKind>('study');
  const [directionText, setDirectionText] = useState('经济学基础');
  const [voice, setVoice] = useState('冰糖');
  const [volume, setVolume] = useState(1);
  const [rate, setRate] = useState(1);
  const [maxRounds, setMaxRounds] = useState('');
  const [maxSeconds, setMaxSeconds] = useState('');
  const [providerId, setProviderId] = useState('');
  const [modelId, setModelId] = useState('');
  const [busy, setBusy] = useState(false);
  /** 工具查证模式：on = AI 可先调工具（browser/MCP 等）查资料再播报；off = 纯聊天直连 */
  const [toolsMode, setToolsMode] = useState(false);
  /** 背景音乐：on = 播报时低音量垫乐循环 */
  const [bgmMode, setBgmMode] = useState(true);
  /** 插话/临时补充输入 */
  const [interjectText, setInterjectText] = useState('');

  // 模型选择
  const [providers, setProviders] = useState<Array<{ id: string; name: string; activeModel: string; models: { id: string }[] }>>([]);

  // 音色
  const [voices, setVoices] = useState<VoiceInfo[]>([]);

  // 语音服务配置
  const [keyConfigured, setKeyConfigured] = useState<boolean | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [keyNote, setKeyNote] = useState('');

  // 偏好持久化（cap.kv；失败静默用默认值）
  useEffect(() => {
    const api = radioHost;
    if (!api) return;
    void api
      .dispatch<{ value?: Record<string, unknown> }>({ target: 'cap.kv', action: 'get', payload: { namespace: 'voice-radio', key: 'prefs' } })
      .then((r) => {
        const p = r.data?.value;
        if (!p || typeof p !== 'object') return;
        if (typeof p.kind === 'string') setKind(p.kind as DirectionKind);
        if (typeof p.directionText === 'string') setDirectionText(p.directionText);
        if (typeof p.voice === 'string') setVoice(normalizeVoiceId(p.voice));
        if (typeof p.volume === 'number') setVolume(p.volume);
        if (typeof p.rate === 'number') setRate(p.rate);
        if (typeof p.maxRounds === 'string') setMaxRounds(p.maxRounds);
        if (typeof p.maxSeconds === 'string') setMaxSeconds(p.maxSeconds);
        if (typeof p.providerId === 'string') setProviderId(p.providerId);
        if (typeof p.modelId === 'string') setModelId(p.modelId);
        if (typeof p.toolsMode === 'boolean') setToolsMode(p.toolsMode);
        if (typeof p.bgmMode === 'boolean') setBgmMode(p.bgmMode);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const api = radioHost;
    if (!api) return;
    const prefs = { kind, directionText, voice, volume, rate, maxRounds, maxSeconds, providerId, modelId, toolsMode, bgmMode };
    void api.dispatch({ target: 'cap.kv', action: 'set', payload: { namespace: 'voice-radio', key: 'prefs', value: prefs } }).catch(() => undefined);
  }, [kind, directionText, voice, volume, rate, maxRounds, maxSeconds, providerId, modelId, toolsMode, bgmMode]);

  // 控制器订阅
  useEffect(() => {
    const off = radioController.subscribe(setSnap);
    return () => {
      off();
    };
  }, []);

  // 模型供应商列表（masked；cap.model.admin）
  useEffect(() => {
    const api = radioHost;
    if (!api) return;
    void api
      .dispatch<{ configs?: Array<{ id: string; name: string; activeModel: string; models: { id: string }[]; enabled: boolean; hasKey: boolean }> }>({
        target: 'cap.model.admin',
        action: 'list',
      })
      .then((r) => {
        const list = (r.data?.configs ?? []).filter((c) => c.enabled && c.hasKey);
        setProviders(list);
        if (list.length > 0 && !list.some((c) => c.id === providerId)) {
          const def = list.find((c) => c.id === 'default') ?? list[0];
          setProviderId(def.id);
          setModelId(def.activeModel || def.models[0]?.id || '');
        }
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 音色表 + Key 状态
  useEffect(() => {
    void listVoices().then((v) => {
      if (v.length > 0) setVoices(v);
    });
    void getConfig().then((c) => setKeyConfigured(c.configured));
  }, []);

  const voiceChoices = voices.length > 0
    ? voices.map((v) => ({ id: v.voiceId, label: v.name, desc: [v.language, v.gender].filter(Boolean).join(' · ') }))
    : MIMO_VOICES.map((v) => ({ id: v.id, label: v.label, desc: v.desc }));

  const isActive = snap.status !== 'idle' && snap.status !== 'error';
  const [showConfig, setShowConfig] = useState(false);
  const showPlaying = isActive && !showConfig;

  const roundsInvalid = maxRounds !== '' && (!/^\d+$/.test(maxRounds) || Number(maxRounds) < 1);
  const secondsInvalid = maxSeconds !== '' && (!/^\d+$/.test(maxSeconds) || Number(maxSeconds) < 1);

  const handleStart = useCallback(async () => {
    if (busy) return;
    const text = directionText.trim() || DIRECTION_LABEL[kind];
    setBusy(true);
    try {
      await radioController.start({
        direction: { kind, text },
        voice: normalizeVoiceId(voice),
        volume,
        rate,
        maxRounds: maxRounds && /^\d+$/.test(maxRounds) ? Number(maxRounds) : undefined,
        maxSeconds: maxSeconds && /^\d+$/.test(maxSeconds) ? Number(maxSeconds) * 60 : undefined,
        providerId: providerId || undefined,
        modelId: modelId || undefined,
        toolsMode,
        bgmMode,
      });
    } finally {
      setBusy(false);
    }
  }, [busy, directionText, kind, voice, volume, rate, maxRounds, maxSeconds, providerId, modelId, toolsMode, bgmMode]);

  const handleStop = useCallback(() => {
    void radioController.stop('manual');
  }, []);

  const handlePauseResume = useCallback(() => {
    if (snap.paused) radioController.resume();
    else radioController.pause();
  }, [snap.paused]);

  /** 插话：半双工——暂停当前播报，AI 回应后自动续播（不计轮次） */
  const handleInterject = useCallback(() => {
    const t = interjectText.trim();
    if (!t) return;
    radioController.interject(t);
    setInterjectText('');
  }, [interjectText]);

  /** 立即中断补充：中止当前段与未播队列，马上以补充内容继续 */
  const handleSupplement = useCallback(() => {
    const t = interjectText.trim();
    if (!t) return;
    radioController.supplement(t);
    setInterjectText('');
  }, [interjectText]);

  const cycleSpeed = useCallback(() => {
    const steps = [1, 1.25, 1.5, 2, 0.75];
    const next = steps[(steps.indexOf(rate) + 1) % steps.length] ?? 1;
    setRate(next);
    radioController.setRate(next);
  }, [rate]);

  const handleSleep = useCallback((opts: { minutes?: number; afterSegment?: boolean } | null) => {
    radioController.sleep(opts);
  }, []);

  const handleSaveKey = useCallback(async () => {
    const key = apiKeyInput.trim();
    if (!key) return;
    setKeyNote('保存中…');
    const r = await saveConfig({ apiKey: key });
    if (r.ok) {
      setKeyConfigured(true);
      setApiKeyInput('');
      setKeyNote('已保存（Key 不回显，可随时更换）');
    } else {
      setKeyNote(`保存失败：${r.error ?? '未知错误'}`);
    }
  }, [apiKeyInput]);

  return (
    <div className="vr-root" data-testid="voice-radio">
      <nav className="vr-tabs" role="tablist" aria-label="电台页签">
        {([
          { key: 'listen', label: '畅听' },
          { key: 'voices', label: '音色' },
          { key: 'settings', label: '设置' },
        ] as const).map(({ key, label }) => (
          <button
            key={key}
            role="tab"
            type="button"
            aria-selected={tab === key}
            className={`vr-tab ${tab === key ? 'active' : ''}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </nav>

      {/* ===== 畅听 ===== */}
      {tab === 'listen' && (
        <div className="vr-body">
          {/* 播报中视图 */}
          {showPlaying && (
            <div className="vr-playing">
              <button type="button" className="vr-link" onClick={() => setShowConfig(true)}>
                查看配置（不中断播报）
              </button>
              <div className="vr-topic">
                <span className="vr-topic-label">{DIRECTION_LABEL[snap.direction.kind]} · </span>
                {snap.direction.text}
              </div>

              {snap.transcript && snap.transcript.lines.length > 0 ? (
                <TranscriptView snap={snap} />
              ) : (
                <div className="vr-nowplaying">
                  <div className="vr-nowplaying-label">
                    {snap.status === 'generating' ? '内容生成中…' : snap.status === 'starting' ? '准备中…' : '正在朗读'}
                  </div>
                  {snap.nowPlayingText}
                </div>
              )}

              <ProgressInfo snap={snap} />

              {snap.error && <div className="vr-error">{snap.error}</div>}

              <div className="vr-controls">
                <button type="button" className="vr-btn" onClick={handlePauseResume}>
                  {snap.paused ? '继续' : '暂停'}
                </button>
                <button type="button" className="vr-btn danger" onClick={handleStop}>
                  停止
                </button>
              </div>

              {/* 插话 / 立即中断补充 */}
              <div className="vr-interject">
                <input
                  className="vr-input"
                  value={interjectText}
                  onChange={(e) => setInterjectText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleInterject();
                  }}
                  placeholder="插话：说点什么，AI 回应后继续播报…"
                  aria-label="插话"
                />
                <div className="vr-interject-btns">
                  <button type="button" className="vr-btn" onClick={handleInterject} disabled={!interjectText.trim()}>
                    插话
                  </button>
                  <button type="button" className="vr-btn danger" onClick={handleSupplement} disabled={!interjectText.trim()} title="立即中断当前内容，马上讲这条补充">
                    立即中断补充
                  </button>
                </div>
              </div>

              <div className="vr-chiprow">
                <button type="button" className="vr-chip" onClick={cycleSpeed} title="点击切换倍速">
                  {rate}x
                </button>
                <span className="vr-vline" aria-hidden />
                <button type="button" className={`vr-chip ${snap.sleepUntil > 0 ? 'active' : ''}`} onClick={() => handleSleep({ minutes: 15 })}>
                  15m
                </button>
                <button type="button" className={`vr-chip ${snap.sleepUntil > 0 ? 'active' : ''}`} onClick={() => handleSleep({ minutes: 30 })}>
                  30m
                </button>
                <button type="button" className={`vr-chip ${snap.sleepAfterSegment ? 'active' : ''}`} onClick={() => handleSleep({ afterSegment: true })}>
                  播完本段
                </button>
                {(snap.sleepUntil > 0 || snap.sleepAfterSegment) && (
                  <button type="button" className="vr-link" onClick={() => handleSleep(null)}>
                    取消定时
                  </button>
                )}
              </div>
            </div>
          )}

          {/* 配置视图（含播报中查看配置） */}
          {!showPlaying && (
            <div className="vr-config">
              {isActive && (
                <>
                  <button type="button" className="vr-link" onClick={() => setShowConfig(false)}>
                    返回播报
                  </button>
                  <div className="vr-warn">播报进行中，修改将应用于下次播报</div>
                </>
              )}

              {/* ① 内容 */}
              <div className="vr-section">
                <div className="vr-section-title">内容</div>
                <div className="vr-chiprow">
                  {DIRECTIONS.map((k) => (
                    <button key={k} type="button" aria-pressed={kind === k} className={`vr-chip ${kind === k ? 'active' : ''}`} onClick={() => setKind(k)}>
                      {DIRECTION_LABEL[k]}
                    </button>
                  ))}
                </div>
                <input
                  className="vr-input"
                  value={directionText}
                  onChange={(e) => setDirectionText(e.target.value)}
                  placeholder="如：经济学基础、王阳明传、今日要闻…"
                  aria-label="播报内容"
                />
                {isActive && (
                  <button
                    type="button"
                    className="vr-btn accent wide"
                    onClick={() => radioController.switchTopic({ kind, text: directionText.trim() || DIRECTION_LABEL[kind] })}
                  >
                    立即换台（不停播）
                  </button>
                )}
              </div>

              {/* ② 声音 */}
              <div className="vr-section">
                <div className="vr-section-title">声音</div>
                <select
                  className="vr-select"
                  value={voice}
                  onChange={(e) => setVoice(e.target.value)}
                  aria-label="音色"
                >
                  {voiceChoices.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                      {v.desc ? ` — ${v.desc}` : ''}
                    </option>
                  ))}
                </select>
                <div className="vr-slider-row">
                  <span className="vr-slider-label">音量</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={volume}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setVolume(v);
                      radioController.setVolume(v);
                    }}
                    aria-label="音量"
                  />
                  <span className="vr-slider-val">{Math.round(volume * 100)}%</span>
                </div>
              </div>

              {/* ③ 模型 */}
              <div className="vr-section">
                <div className="vr-section-title">模型</div>
                <select
                  className="vr-select"
                  value={`${providerId}|${modelId}`}
                  onChange={(e) => {
                    const [pid, mid] = e.target.value.split('|');
                    setProviderId(pid);
                    setModelId(mid);
                  }}
                  aria-label="模型"
                >
                  {providers.length === 0 && <option value="|">跟随全局默认</option>}
                  {providers.map((p) => (
                    <optgroup key={p.id} label={p.name}>
                      {(p.models.length > 0 ? p.models : [{ id: p.activeModel }]).map((m) => (
                        <option key={m.id} value={`${p.id}|${m.id}`}>
                          {p.name} / {m.id}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <p className="vr-hint">播报中修改将在下次播报生效；默认跟随全局默认供应商。</p>
              </div>

              {/* ④ 控制 */}
              <div className="vr-section">
                <div className="vr-section-title">控制</div>
                <div className="vr-grid2">
                  <input
                    className={`vr-input ${roundsInvalid ? 'invalid' : ''}`}
                    type="number"
                    min={1}
                    value={maxRounds}
                    onChange={(e) => setMaxRounds(e.target.value)}
                    placeholder="播 N 轮"
                    aria-label="播放轮次上限"
                  />
                  <input
                    className={`vr-input ${secondsInvalid ? 'invalid' : ''}`}
                    type="number"
                    min={1}
                    value={maxSeconds}
                    onChange={(e) => setMaxSeconds(e.target.value)}
                    placeholder="播 N 分钟"
                    aria-label="播放时长上限"
                  />
                </div>
                <p className="vr-hint">填「播 N 轮」= 播满 N 段后自动停止；填「播 N 分钟」按时长兜底。都不填则无限连续播报。</p>
                {/* 工具查证模式（可开关；默认关） */}
                <label className="vr-switch-row">
                  <span className="vr-switch-label">工具查证模式</span>
                  <input
                    type="checkbox"
                    checked={toolsMode}
                    onChange={(e) => setToolsMode(e.target.checked)}
                    aria-label="工具查证模式"
                  />
                </label>
                <p className="vr-hint">
                  开启后 AI 在生成播报前可调用工具（browser 搜索/读网页、MCP、文件等）核实或补充资料，再继续播报；
                  播报节奏会变慢（工具调用需要时间）。关闭即为纯聊天直连，出稿最快。
                </p>
                {/* 背景音乐（可开关；默认开） */}
                <label className="vr-switch-row">
                  <span className="vr-switch-label">背景音乐</span>
                  <input
                    type="checkbox"
                    checked={bgmMode}
                    onChange={(e) => setBgmMode(e.target.checked)}
                    aria-label="背景音乐"
                  />
                </label>
                <p className="vr-hint">
                  开启后播报时自动垫低音量背景乐（按方向自动匹配风格：学习=舒缓、新闻=明快、故事=叙事、技术=电子），
                  服务端一次合成循环播放，不额外消耗 TTS 额度。AI 还会为每段自动选择播报语气。
                </p>
              </div>

              {isActive && (
                <div className="vr-section">
                  <div className="vr-section-title">正在朗读</div>
                  <div className="vr-controls">
                    <button type="button" className="vr-btn" onClick={handlePauseResume}>
                      {snap.paused ? '继续' : '暂停'}
                    </button>
                    <button type="button" className="vr-btn danger" onClick={handleStop}>
                      停止
                    </button>
                  </div>
                </div>
              )}

              {snap.status === 'error' && snap.error && <div className="vr-error">{snap.error}</div>}

              <button
                type="button"
                className="vr-btn accent wide big"
                onClick={handleStart}
                disabled={isActive || busy || roundsInvalid || secondsInvalid}
              >
                {snap.status === 'error' ? '重试' : isActive ? '播报中…' : '开始播报'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* ===== 音色 ===== */}
      {tab === 'voices' && (
        <div className="vr-body">
          <div className="vr-section">
            <div className="vr-section-title">预置音色</div>
            <div className="vr-voice-list">
              {voiceChoices.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  className={`vr-voice-item ${normalizeVoiceId(voice) === v.id ? 'active' : ''}`}
                  onClick={() => setVoice(v.id)}
                >
                  <span className="vr-voice-name">{v.label}</span>
                  <span className="vr-voice-desc">{v.desc}</span>
                </button>
              ))}
            </div>
            <p className="vr-hint">点选即设为播报音色；当前音色：{normalizeVoiceId(voice)}</p>
          </div>
        </div>
      )}

      {/* ===== 设置 ===== */}
      {tab === 'settings' && (
        <div className="vr-body">
          <div className="vr-section">
            <div className="vr-section-title">语音服务（小米 MiMo TTS）</div>
            <p className="vr-hint">
              合成走服务端代理，API Key 只保存在服务端（环境变量 PLITE_MIMO_TTS_KEY 或此处保存到数据目录）。
              当前状态：{keyConfigured === null ? '查询中…' : keyConfigured ? '已配置' : '未配置'}
            </p>
            <input
              className="vr-input"
              type="password"
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
              placeholder={keyConfigured ? '已配置（输入新 Key 可更换）' : '填入 MiMo API Key'}
              aria-label="MiMo API Key"
              autoComplete="off"
            />
            <button type="button" className="vr-btn accent wide" onClick={handleSaveKey} disabled={!apiKeyInput.trim()}>
              保存 Key
            </button>
            {keyNote && <p className="vr-hint">{keyNote}</p>}
            <p className="vr-hint">
              Key 来源：小米 MiMo 开放平台（api.xiaomimimo.com），mimo-v2.5-tts 模型限时免费。
              未配置时开播预检会直接报错，不会空跑 AI 生成。
            </p>
          </div>
          <div className="vr-section">
            <div className="vr-section-title">说明</div>
            <p className="vr-hint">
              无限播报：AI 按方向连续生成 150~350 字/段，切句合成后连续播放；当前段播放时后台并行生成下一段。
              手机浏览器/WebView 下锁屏与熄屏通常可继续播放（MediaSession + 原生音频）；若被系统回收，回到页面点「继续上次」重开同方向即可。
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/** 宿主 API 引用（index.ts setup 时注入；面板经此走 cap.kv / cap.model.admin） */
let radioHost: import('@sdk').SlotHostApi | null = null;
export function setRadioHost(api: import('@sdk').SlotHostApi | null): void {
  radioHost = api;
}
