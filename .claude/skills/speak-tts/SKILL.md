---
name: speak-tts
description: 用户想听语音/把文字念出来时使用本技能（「念一下」「读出来」「用语音说」「给我听」）。调用 speak 工具走 voice-tts 插件（小米 MiMo TTS），音频卡片直接出现在对话里可播放。
---

# 语音合成技能（speak-tts）

## 何时使用
用户说「念」「读出来」「语音」「说给我听」「用声音」等语音意图，或明确想给某人听一段话时。

## 工具调用

调用 `speak` 工具（voice-tts 插件注册）：

```
speak({ text: "要朗读的文本", voice: "mimo_default" })
```

**参数**：
- `text`（必填）：朗读文本，≤2000 字。超长要分多条念或提示截断。
- `voice`（可选）：音色。
- `style`（可选）：风格指令，如「温柔轻快」「沉稳大气」。

## 音色表
| voiceId | 特点 |
|---|---|
| mimo_default | 默认，中英自动 |
| 冰糖 | 中文女，甜 |
| 茉莉 | 中文女，柔（默认推荐） |
| 苏打 | 中文男 |
| 白桦 | 中文男 |
| Mia / Chloe | 英文女 |
| Milo / Dean | 英文男 |

## 上游现状（2026-11-28 配置）
- 小米 MiMo TTS（api.xiaomimimo.com/v1），限时免费
- Key 与「电台」(voice-radio) 插件共用 `.polaris-lite/voice-radio/config.json`，或 env PLITE_MIMO_TTS_KEY
- 时长：约 1-5 秒/句，100 字内秒回

## 注意事项
1. 生成后自动经 media-push 出音频卡（可播放/下载），无需手动推。
2. 适合念：新闻摘要、账单总结、备忘、晚安语。别主动长篇大论念废话。
3. 长文本（>500 字）提醒用户会比较久，或只念关键部分。
4. 出错：NO_API_KEY = 查 voice-radio config；超长 = 拆分或让用户选段。

## 示例
用户：「把今天的记账总结念给我听」
→ 先用 ledger stats 拿数据 → 拼成口语文本 → speak({ text: "今天花了...", voice: "茉莉" })
