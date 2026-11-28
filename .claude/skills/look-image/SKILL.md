---
name: look-image
description: 用户想识别/理解图片内容时使用本技能（「看看这图」「图里是什么」「帮我读图」「识别一下」）。调用 look 工具走 vision 插件（视觉模型识别），返回文字描述，图片本身不进对话流。
---

# 图片识别技能（look-image）

## 何时使用
用户给图片路径/截图并问「这是什么」「图里有什么」「帮我看看」「识别文字/图表/二维码」时。
图片来源常是：浏览器截图（browser-shots 目录）、工作区文件、用户给的路径。

## 工具调用

调用 `look` 工具（vision 插件注册）：

```
look({ path: "图片路径", prompt: "想了解什么" })
```

**参数**：
- `path`（必填）：图片绝对路径或相对工作区路径。PNG/JPEG/WebP/GIF/BMP，≤25MB。
- `prompt`（可选）：问图什么。缺省 = 详细描述全图。识别文字就写「提取图中全部文字」。

## 上游现状（2026-11-28 配置）
- 自动从 providers.json 选视觉模型（capabilities.vision），多模型自动回退
- 当前主用：glm-5.3-flash（Local 9850 网关）；另有 nex-n2.6 等 13 个候选
- env PLITE_VISION_MODEL=providerId/modelId 可强制指定

## 注意事项
1. **结果只有文字**——图不会出现在对话。用户想看图本身，另用 push_media 推送。
2. prompt 越具体识别越好：「读出表格里所有数字」远好于「这是什么」。
3. 实测识别质量：截图里的 UI 结构、中文标题、点赞数等小字都能认（glm-5.3-flash 很稳）。
4. 出错：NOT_IMAGE = 魔数嗅探不是图（可能被改了扩展名）；NO_VISION_MODEL = providers.json 里没有带 vision 的模型。
5. 与浏览器联动：browser screenshot 先存文件 → look 读。截图默认落 .polaris-lite/browser-shots/。

## 示例
用户：「看看我刚才的截图里报错写了啥」
→ look({ path: ".polaris-lite/browser-shots/xxx.jpg", prompt: "提取图中所有报错文字" })
