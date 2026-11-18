# 输入区 + 模型面板 UI 重设计 brief（ui-redesign）

## 实测几何（1440x900，已登录）
- shell grid: 260px sidebar / 1fr stream / 300px panel；.shell-input 高 111px @ y789
- chat-input-bar 宽仅 165px（塌缩），textarea 165x42，style.height=77px 但 clientHeight=40（JS 42..200 自适应 vs CSS max-height:140 冲突）
- 按钮 x=994 起：📎/停止/排队/发送；面板 .shell-panel 300x900；.slot-tabbar 299x55（三 tab：能力面板/模型供应商管理/演示登录），「模型供应商管理」折两行
- 空态 stream 仅两行居中文本，与输入区之间大片留黑

## 已知根因
1. plugins/chat-lite/chat-input.css:3 把 .chat-input-bar 覆盖为 flex-direction:column（基础样式 styles.css:309 横向 flex; align-items:flex-end），textarea flex:1 在纵向布局只分高度不分宽度 → 宽度塌缩
2. ChatInput.tsx useLayoutEffect 设 height=clamp(scrollHeight,42,200)，CSS .chat-textarea max-height:140px + 无 box-sizing 声明（全局 * 有 border-box）→ 77/40 矛盾
3. .slot-tab flex:1 + 12.5px 中文 6 字 → 折行；tab 名取 manifest.name 无省略
4. ma-cap-grid 两列在 300px 面板贴边；ma-form input width:100% 但卡片内控件无统一高度/box-sizing 收口
5. 识别能力按钮无 busy 态；结果 ma-detect 是裸 pre，中英混排断行乱
6. 删除供应商无确认；模型 chips 徽标 10px 密集

## 主题 token（现有 9 个）
--bg #0f1117 / --bg-panel #161923 / --bg-hover #1e2230 / --border #262b3a / --text #e6e8ef / --text-dim #8b90a0 / --accent #5b8cff / --accent-soft rgba(91,140,255,.16) / --radius 8px；danger #ff7a7a success #4cc38a warning #ffb84d（硬编码散落）

## 约束
- 纯 CSS，不引 UI 框架；保持既有 class 名（chat-*、ma-*、slot-tab 等）不破坏插件契约
- 插件 CSS 只能改插件目录（chat-input.css / panel.css）+ 宿主 styles.css 的壳层部分
- 参照 Polaris 原版视觉气质（深色、蓝色 accent、卡片式面板），但更轻
