/**
 * voice-radio 插件：AI 无限语音电台（自 Polaris Radio Broadcast 移植，纯插件实现）。
 *
 * 职责：
 * - panel 槽：电台面板（畅听/音色/设置 三 Tab）；
 * - 播报循环：controller.ts 经 cap.ai.chat 流式总线逐段生成文本（方向 system 模板 +
 *   接续 prompt），player.ts 切句 → /api/voice-radio/synthesize 合成 → 原生 <audio>
 *   连续播放；段级低水位提前生成，实现「播当前段时后台生成下一段」的无限播报；
 * - 手机后台/熄屏：原生 <audio> 播放 + MediaSession metadata/actionHandlers
 *   （锁屏通知栏显示话题与当前句，耳机/通知栏 play/pause/stop 可用）；
 * - server 半边（server.mjs）：MiMo TTS 服务端代理（Key 只在服务端）+ 磁盘缓存 + 串行单飞。
 *
 * 裁剪（相对 Polaris 全量）：内容库回听/音色设计/音色克隆/插话/语音停止口令后置；
 * 保留方向预设、无限连续、倍速、音量、睡眠定时、换台、模型选择、锁屏控制。
 */
import type { LitePlugin, SlotHostApi } from '@sdk';
import { radioController } from './controller';
import { setRadioHost, VoiceRadioPanel } from './Panel';
import './panel.css';

export const voiceRadioPlugin: LitePlugin = {
  manifest: {
    id: 'voice-radio',
    name: 'AI 电台',
    version: '0.1.0',
    capabilities: ['cap.kv', 'cap.ai.chat', 'cap.ai.chat.interrupt', 'cap.model.admin'],
    provides: [],
    events: ['cap.ai.chat:event'],
    contributes: {
      slots: [{ slot: 'panel', component: 'VoiceRadioPanel', order: 33, title: '电台' }],
    },
  },
  setup(api: SlotHostApi) {
    setRadioHost(api);
    radioController.setHostApi(api);
  },
};

export { VoiceRadioPanel };
export default voiceRadioPlugin;
