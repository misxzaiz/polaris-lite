/**
 * bgm.mjs — 语音电台背景音乐离线合成（纯 Node，零依赖，零出网）。
 *
 * 思路：不是"AI 谱曲"（MiMo 无音乐模型），而是按风格用确定性算法生成
 * 和弦垫（pad）+ 简单琶音的循环乐段，16bit PCM WAV 直出 base64 dataUrl。
 * 音色用减法合成思路：正弦+轻微失谐叠加，ADSR 包络，低通感靠谐波衰减近似。
 *
 * 时长 BGM_LOOP_SECONDS 秒、44100Hz、单声道（体积/流量友好，垫乐无需立体声）。
 * 确定性：同 style+seed 每次生成完全一致 → 服务端按 key 磁盘缓存即可。
 */

/** 简单可复现 PRNG（mulberry32） */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 风格参数表：BPM、和弦进行（半音根音偏移，C 大调基准）、音色亮度、琶音密度 */
const STYLES = {
  calm:   { bpm: 66,  root: 48, chords: [0, 5, 7, 5],   bright: 0.35, arp: 0.25, swing: 0.0 },
  upbeat: { bpm: 96,  root: 53, chords: [0, 7, 5, 7],   bright: 0.55, arp: 0.55, swing: 0.12 },
  story:  { bpm: 72,  root: 45, chords: [0, 3, 8, 3],   bright: 0.3,  arp: 0.35, swing: 0.05 },
  tech:   { bpm: 84,  root: 50, chords: [0, 10, 5, 7],  bright: 0.5,  arp: 0.45, swing: 0.0 },
};

/** 三和弦（大/小）按根音半音与调式推导；这里用固定音程叠置保证不入错调 */
function chordNotes(rootMidi, kind) {
  // kind: 0 大三 1 小三 2 挂留（sus2 感）
  if (kind === 1) return [rootMidi, rootMidi + 3, rootMidi + 7];
  if (kind === 2) return [rootMidi, rootMidi + 2, rootMidi + 7];
  return [rootMidi, rootMidi + 4, rootMidi + 7];
}

function midiToFreq(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}

/** 单音符振荡：基频 + 2/3 次谐波（谐波幅度随 bright 提高），软限幅 */
function osc(sample, freq, bright, amp) {
  const w = 2 * Math.PI * freq;
  const s = Math.sin(w * sample)
    + bright * 0.5 * Math.sin(2 * w * sample)
    + bright * 0.22 * Math.sin(3 * w * sample);
  return s * amp;
}

/** ADSR 包络（attack/decay/release 线性近似） */
function env(t, dur, a = 0.35, r = 0.6) {
  if (t < a) return t / a;
  if (t > dur - r) return Math.max(0, (dur - t) / r);
  return 1;
}

/**
 * 合成一段 BGM，返回 { wavBase64, seconds }。
 * @param {string} style calm|upbeat|story|tech
 * @param {number} seconds 循环时长（秒）
 * @param {number} seed 确定性种子
 */
export function renderBgm(style, seconds, seed = 1) {
  const cfg = STYLES[style] ?? STYLES.calm;
  const rate = 44100;
  const total = Math.floor(rate * seconds);
  const beat = 60 / cfg.bpm;           // 一拍秒数
  const barBeats = 4;                  // 4/4 拍
  const barDur = beat * barBeats;
  const bars = Math.max(1, Math.round(seconds / barDur));
  const rand = rng(seed * 7919 + style.length * 131);

  const buf = new Float64Array(total);
  const chordKinds = [0, 1, 0, 2];

  // ── 和弦垫：每小节一个和弦，整小节延音 + 慢包络 ──
  for (let b = 0; b < bars; b++) {
    const start = Math.floor(b * barDur * rate);
    const end = Math.min(total, Math.floor((b + 1) * barDur * rate) + Math.floor(0.8 * rate)); // 越界淡出重叠
    const root = cfg.root + cfg.chords[b % cfg.chords.length];
    const notes = chordNotes(root, chordKinds[b % chordKinds.length]);
    for (const n of notes) {
      const f = midiToFreq(n);
      const amp = 0.06;
      for (let i = start; i < end; i++) {
        const t = (i - start) / rate;
        const seg = (i - start) / (end - start);
        // 小节内慢起慢落，避免循环点爆音
        const e = Math.min(1, seg / 0.18) * Math.min(1, (1 - seg) / 0.22);
        buf[i] += osc(t, f, cfg.bright * 0.5, amp * e);
        // 低八度根音加固
        if (n === notes[0]) buf[i] += osc(t, f / 2, cfg.bright * 0.2, amp * 0.7 * e);
      }
    }
  }

  // ── 琶音/节奏点：八分音符网格上按概率点缀，增加"电台感" ──
  const stepDur = beat / 2;
  const steps = Math.floor(seconds / stepDur);
  for (let s = 0; s < steps; s++) {
    if (rand() > cfg.arp) continue;
    const b = Math.floor((s * stepDur) / barDur) % bars;
    const root = cfg.root + cfg.chords[b % cfg.chords.length] + 12; // 高八度
    const notes = chordNotes(root, chordKinds[b % chordKinds.length]);
    const n = notes[Math.floor(rand() * notes.length)];
    const f = midiToFreq(n);
    const start = Math.floor(s * stepDur * rate);
    const dur = Math.floor(stepDur * 0.9 * rate);
    const amp = 0.035 + rand() * 0.02;
    for (let i = start; i < Math.min(total, start + dur); i++) {
      const t = (i - start) / rate;
      const e = env(t, dur / rate, 0.01, 0.25);
      buf[i] += osc(t, f, cfg.bright, amp * e);
    }
  }

  // ── 轻噪声铺底（极低电平，掩盖数字静默感）──
  for (let i = 0; i < total; i++) buf[i] += (rand() - 0.5) * 0.0035;

  // 软限幅 + 写 WAV
  let peak = 0;
  for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(buf[i]));
  const norm = peak > 0 ? Math.min(1, 0.72 / peak) : 1;

  const bytesPerSample = 2;
  const dataSize = total * bytesPerSample;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + dataSize, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * bytesPerSample, 28);
  wav.writeUInt16LE(bytesPerSample, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < total; i++) {
    const v = Math.max(-1, Math.min(1, buf[i] * norm));
    wav.writeInt16LE(Math.round(v * 32767), 44 + i * bytesPerSample);
  }
  return { wavBase64: wav.toString('base64'), seconds };
}
