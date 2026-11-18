# polaris-lite 对话输入框改造总纲（brief-input-upgrade）

> 目标：参考 Polaris 的 ChatInput（约 2131 行 + 辅助文件），把 polaris-lite chat-lite 插件的输入区从 46 行的"裸 textarea"升级为功能完整的输入框。**本阶段仅分析，不实施**。

## 现状（lite 侧）

`plugins/chat-lite/ChatInput.tsx`（46 行）当前只有：
- 裸 textarea（Enter 发送 / Shift+Enter 换行）
- 发送/停止按钮二态
- 无附件、无上下文 chips、无 slash 命令、无设置、无草稿、无自适应增高

依赖约束（不可违反）：
- chat-lite 是**外部插件**：不能 import Polaris 主仓的 store/service，一切能力经 `SlotHostApi`（cap dispatch / listen / emit / layout）或自持状态实现
- 布局承诺不破坏：输入区仍在四槽壳的 input 槽位
- 可替换性：对话插件整体可被替换（chat-lite ↔ 未来其他对话 UI），输入框能力也应尽量内聚在插件内

## 参照系（Polaris 侧）

由盘点 agent 实读 Polaris 源码产出功能清单 → `polaris-input-inventory.md`（含文件:行号、依赖 store/service/cap、宿主强耦合标记、三层移植分类：可直接移植 / 需适配总线 / 需重新设计）。

## 分析产物要求

最终文档需回答：
1. **功能清单**：Polaris 输入框到底有什么（按类别：基础输入/附件/chips/命令路由/设置/粘贴拖拽/草稿/其他）
2. **差距表**：lite 现状 vs Polaris，逐项标注「移植难度」与「依赖形态」（纯 UI / 需 cap / 需新契约）
3. **适配设计**：宿主强耦合项在 lite 插件体系下的替代形态（如附件→自持状态 or 新 cap？chips→引用会话内消息 or 文件？命令路由→插件内注册表 or 宿主契约？）
4. **新契约提案**：若需新增 cap（如 cap.ai.attachments、cap.context），给出契约草案
5. **阶段路线**：建议的 2~4 个交付阶段（每阶段可独立上线、可回归）
6. **风险与边界**：哪些 Polaris 能力明确**不搬**（过度设计/依赖桌面端/破坏可替换性），理由

## 产物

- `docs/input-upgrade/polaris-input-inventory.md`（Polaris 侧盘点，盘点 agent 产出）
- `docs/input-upgrade/analysis.md`（差距+适配+契约+路线+风险，主会话综合产出）
