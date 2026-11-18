# Polaris Lite 验收处理报告（AI 对话交互越界专项）

> 日期：2026-11-18。流程：用户反馈「AI 对话交互存在越界等严重问题」→ 派发 3 人验收团（A 布局越界 / B 交互与状态越界 / C 安全与权限越界）并行静态审查 → 汇总 3 份报告 → 按严重度全部修复 → 桌面 + 手机视口回归冒烟验证。
> 三份原始报告：[A-layout.md](A-layout.md) · [B-interaction.md](B-interaction.md) · [C-security.md](C-security.md)

## 一、发现汇总（修复前）

| 级别 | 数量 | 代表问题 |
|---|---|---|
| P0 | 3 | 能力注册无权限 gate（main.tsx 绕过 manifest 直接注册 cap.ai.chat）；同会话连发两条消息流式回复必然串台（事件无 messageId 匹配 + 全量广播）；mock-engine running map 按 sessionId 存 cancel（并发流中断误伤/不可中断） |
| P1 | 8 | 流式调用拒绝被吞、恒返回 ok；chat-event 全量广播可被任意插件旁听/伪造；滚动穿透（.shell-stream 无 overflow）；z-index 无挡板（插件 fixed 元素可凌驾抽屉）；输入区增高失控；interrupt 复位竞态；切换会话后旧流不可中断；streaming 残留锁死输入框 |
| P2 | 8 | __LITE_DEBUG__ 进入生产 bundle；审计被面板轮询淹没且缺 pluginId；listen/emit 无命名空间与来源；消息 id 用 Date.now 撞车；stream.end 死代码；长串气泡溢出；软键盘遮挡；审计行无换行保护 |

## 二、修复清单（全部完成）

### P0
1. **能力注册 gate**（C-1）：`SlotHostApi.registerCapability` 受控注册器上线，宿主校验 `manifest.provides` 声明；mock-engine 声明 `provides: ['cap.ai.chat', 'cap.ai.chat.interrupt']` 并在 `setup()` 内自行注册；main.tsx 退回只做 `registerPlugin`，不再代为注册任何业务 cap。
2. **流按调用隔离**（B-1/B-5）：bus `streamKey` 纳入调用维度（streamId/调用序号），并发流定向投递互不串扰；chat-lite 事件过滤加 `messageId` 精确匹配 + `source === 'engine'` 来源校验；mock-engine running key 改 `sessionId::messageId`，`finally` 只清理自己的条目——中断不再误伤、不再覆盖。
3. **消息 id**：改单调计数器 `m-<ts>-<n>`，同毫秒连发不再撞 key。

### P1
4. **流式拒绝语义**（C-2）：dispatchStream 事件改经受控广播器镜像，取消语义与审计保持一致。
5. **事件旁听/伪造收口**（C-3/C-6）：`listen` 校验 `manifest.events` 声明（chat-lite 声明 `events: ['chat-event']`）；`emit` 自动附加 `source` 插件 id；chat-lite 消费侧校验来源。
6. **滚动穿透**（A-2）：`html/body` 锁 `overflow:hidden` + `.shell-stream` 加 `overflow:hidden`。
7. **z-index 挡板**（A-3）：`.slot` 加 `isolation:isolate + position:relative + z-index:0`，插件内容无法越出槽位层叠域。
8. **输入区增高**（A-6）：`.shell-input` 加 `flex-shrink:0 + max-height:40vh + overflow-y:auto`。
9. **interrupt 自愈**（B-7）：interrupt 返回 `found`；流已死时自动复位本会话所有 streaming 残留，输入框不再永久锁死；中断路由修正到 `cap.ai.chat.interrupt`。

### P2
10. `__LITE_DEBUG__` 用 `import.meta.env.DEV` 门控，生产 bundle 已实测为 0 出现。
11. `cap.meta/describe` 这类只读自省不入审计链；审计 entry 补 `pluginId`/`error` 并在面板展示；cap-panel 轮询降频 5s 且仅页面可见时轮询。
12. `overflow-wrap:anywhere`（气泡 + 审计行）；viewport 加 `interactive-widget=resizes-content`。

## 三、回归验证（修复后实测）

- **桌面 1280×720**：新会话 → 发送「回归测试一」→ 流式完整渲染（152 字符）→ 按钮复位 ✅
- **并发流**：同会话连续 `sendUserMessage('并发甲')` + `sendUserMessage('并发乙')`，两条回复各自完整（150/150 字符），无串字 ✅
- **中断**：发送后点「停止」→ 流停在 16 字符、光标消失、按钮复位「发送」✅
- **手机 375×812**：完整链路通过（151 字符回复），截图确认布局正常 ✅
- **门禁**：`tsc --noEmit` 0 错误；`vite build` 161KB（gzip 52.8KB）；9825 端口服务正常 ✅

## 四、遗留与建议

- StrictMode 隐性前提（bootstrap 不进 effect、sendUserMessage 不进 effect）已通过幂等注册缓解，但未来重构仍需保持。
- iOS 软键盘 VisualViewport 补偿、streaming 超时看门狗（30s 无 delta 自动复位）为后续增强项。
- 事件命名空间完全收口（`plugin:<id>:<event>`）可在插件数量增长后实施。
