---
name: draw-image
description: 用户想生成/画出图片时使用本技能（「画个xx」「生成一张图」「来张xx的图」）。调用 draw 工具走 image-gen 插件文生图，产物图片卡片直接出现在对话里。
---

# 文生图技能（draw-image）

## 何时使用
用户说「画」「生成图片」「来张图」「帮我画个 xx」等生图意图时。

## 工具调用

调用 `draw` 工具（image-gen 插件注册，服务端执行域）：

```
draw({ prompt: "画面描述", n: 1 })
```

**参数**：
- `prompt`（必填）：画面描述。默认自动丰富为高质量 prompt：主体 + 场景 + 光线 + 风格。用户给了明确风格就直接用。
- `size`（可选）：尺寸字符串，一般不传用上游默认。
- `n`（可选）：张数 1-4，默认 1。

## 上游现状（2026-11-28 配置）
- 主上游：agnes 平台（apihub.agnes-ai.com/v1），模型 agnes-image-2.5-flash，免费档
- 配置位置：`.polaris-lite/image-gen/config.json`（或 env PLITE_IMAGE_GEN_URL/KEY/MODEL）
- 备选：智谱 cogview-4（换 config 即可，约 0.06 元/张）

## 注意事项
1. **慢**：agnes 免费档高峰期一张图约 1-3 分钟，工具会同步等待，属正常。
2. prompt 是中文直接写即可，agnes 会自己理解；给英文也行。
3. 生成后自动经 media-push 出图片卡（可缩放/下载/全屏），无需再手动推。
4. 出错常见：HTTP 5xx = 上游拥堵，提示用户稍后再试；NOT_CONFIGURED = 配置丢了，查 config.json。
5. 敏感内容（nsfw 等）上游会拒绝，提前跟用户说明。

## 示例
用户：「画一只戴墨镜的柴犬」
→ draw({ prompt: "一只戴墨镜的柴犬，夏日海滩，阳光，高对比度摄影风格" })
