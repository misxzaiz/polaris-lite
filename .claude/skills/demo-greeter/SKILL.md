---
name: demo-greeter
description: 演示用技能：生成一句带当天日期的问候语，用于验证 skill-loader 的发现与 read_skill 读取链路。
when_to_use: 当用户要求"打个招呼"、"测试技能"，或需要演示技能加载流程时使用。
---

# demo-greeter

这是一个用于测试 skill-loader 的示例技能。

## 使用步骤

1. 获取当前日期（格式 YYYY-MM-DD）。
2. 按以下格式生成问候语：`你好！今天是 {date}，来自 demo-greeter 技能的问候。`
3. 将问候语直接回复给用户。

## 注意事项

- 本技能仅用于验证技能发现与读取链路，无任何副作用。
- SKILL.md 通过 YAML frontmatter 声明 name / description / when_to_use 三个字段。
