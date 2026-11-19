# 工具卡排序 bug 根因 + Polaris 工具折叠设计分析（仅分析，未实施）

> 用户反馈：AI 输出结束后，工具调用卡显示在最下面（答案之下）。
> 参考：Polaris-plugin `chat-desk` 的块系统与折叠实现（已实读源码）。

---

## 一、lite 排序 bug 根因（已实锤）

chat-lite 当前把一次编排的所有输出塞进**一条 assistant 消息**：

- `sendUserMessage` 时先创建唯一 assistant 消息（`assistantId`）；
- 所有轮次的 `message.delta`（第 0 轮的工具前文本 + 第 1 轮的最终回答）都 `pushDelta` 追加到**这同一条消息**的 content；
- 工具卡是**独立消息**，在 `tool.card` 事件到达时 `appendMessage` 追加到消息列表末尾。

消息列表实际顺序：

```
[user, assistant(第0轮文本+第1轮最终回答都挤在这), toolCard]
```

- 第 0 轮模型通常只发 tool_calls 不发文本（我此前的 E2E 恰好都是这种）→ 看起来正常；
- 一旦模型在调工具**前后都输出了文本**（先说"我来看一下"，执行后再给答案），最终回答全部追加到**位于卡片上方**的那条 assistant 消息里 → **卡片沉底**。

根因是结构性的：**线性消息列表无法表达「文本→工具→文本」的交错序列**。工具卡作为独立消息，注定只能在 assistant 消息之前或之后，不能插入中间。

---

## 二、Polaris 的解法：块（ContentBlock）而非多消息

### 2.1 数据结构（chat-desk 实测源码）

Polaris 的一条 assistant 消息 = `message.blocks: ContentBlock[]`，**按事件到达顺序追加**：

| 事件 | store 动作（createConversationStore/eventHandler.ts） |
|---|---|
| `thinking` 增量 | `appendThinkingBlock`（有 thinking 缓冲，落块时机见下） |
| `token`/`assistant_message` 增量 | `appendTextBlock`（有 text 缓冲，段落 `\n\n` 或超时 flush） |
| `tool_call_start` | `appendToolCallBlock(callId, tool, args)` —— **追加 tool_call 块到当前位置**，并幂等（同 callId 重发只回填 input 不重复建块） |
| `tool_call_end` | 按 callId（缺失时回退"最后一个 running 块"）更新 result/status/duration |

**关键细节：类型切换点强制 flush 缓冲**——`appendToolCallBlock` 开头先 flush thinking 缓冲再 flush 文本缓冲，保证 `thinking→text→tool_call` 块时序不倒挂（C2 spec 教训）。这就是排序不乱的机制保证。

### 2.2 渲染：AssistantBubble → renderBlocksWithGrouping

`AssistantBubble.tsx` 对**单条消息的 blocks 数组**调用 `renderBlocksWithGrouping(blocks, isStreaming)`——折叠是在「一条消息内部」做的，消息边界保持干净。

### 2.3 折叠分组规则（tool-calls/blockGrouping.tsx，216 行，定稿于 plans/tool-block-collapse-behavior-fix.md）

`identifyCollapsibleBlockGroups(blocks)`：

- **连续 thinking + tool_call 块归为一个折叠组**；
- **仅非空 text 块打断分组**（文本自身平铺显示不被吞）；
- 空文本块与面板类块（plugin_card/question/form 等）**不打断也不进组**——组索引可跨越面板块，面板"穿透"渲染在组外侧，避免面板穿插产生多条折叠条。

### 2.4 折叠态机（CollapsibleBlockGroupRenderer）

| 阶段 | 形态 |
|---|---|
| 流式期间 | **平铺**（不渲染汇总条包装，避免"组壳套卡片"双层视觉；edit/write 工具卡流式期默认展开看 diff） |
| 流式结束 | `useEffect` 监听 isStreaming 翻 false → **自动折叠为一条汇总条**：Layers 图标 + 「思考 N」紫 chip + 「工具 N」蓝 chip + 总块数 + chevron，零可见块 |
| 用户点击汇总条 | 展开为原块平铺 + 底部轻量「收起」按钮 |

### 2.5 单卡折叠（ToolCallBlockRenderer）

- edit/write 工具流式期默认展开、结束自动收起；
- 折叠头：状态图标 + 工具名 + 一行摘要 + **失败摘要（取 error 首行 ≤80 字符）** + 耗时（**仅 >1s 才显示**，秒级完成不占位）；
- 输出区 `max-h` 滚动 + 「展开全部」toggle + 复制按钮 ×2（命令/输出）；
- 文件路径可点击跳编辑器（lite 无编辑器，可砍）。

### 2.6 审批生命周期

无定时器；**发新消息 / 历史恢复时 pending → expired**（发新消息语义已在 lite 实现）。

---

## 三、lite 纯插件适配方案（与 Polaris 同构的最小子集）

全部改动落在 chat-lite + agent-loop 插件，**宿主零改动**：

### 3.1 数据层（chat-lite/store.ts）
assistant 消息增加可选 `blocks`：

```ts
type AsstBlock =
  | { type: 'text'; text: string }
  | { type: 'tool'; card: ToolCardData };   // 复用现有 ToolCardData

interface AssistantWithBlocks extends ChatMessage {
  role: 'assistant';
  blocks?: AsstBlock[];
}
```

- 旧持久化会话无 `blocks` → 按现有 content 渲染（向后兼容，不迁移）；
- 新会话走 blocks：`message.delta` → 追加/创建**末尾 text 块**；`tool.card` → flush 当前 text 块 + 追加 tool 块。

### 3.2 事件层（agent-loop）
给 `message.delta` 增加 `turn` 字段（或发 `turn.start` 事件）——chat-lite 收到新一轮 delta 时**关闭当前 text 块**，下一 delta 开新块。这是把"轮次边界"显式传给 UI 的最小改动（此前 turn 只在 loop 内部可见）。

### 3.3 渲染层（chat-lite 新增 blockGrouping 收敛版）
- `identifyGroups(blocks)`：连续 tool 块归组（lite 没有 thinking 块，比 Polaris 还简单）；**非空 text 打断**；
- 组渲染态机照抄 Polaris：流式平铺 → 结束自动折叠汇总条（「工具 N · 全部完成/有失败」+ chevron）→ 点击展开 + 底部收起；
- 单卡折叠头照现有 ToolCard（已实现），补两个 Polaris 细节：失败摘要取 error 首行 ≤80 字、耗时仅 >1s 显示（后者已做）。

### 3.4 排序正确性
blocks 按事件序追加 → 「文本→工具→文本」天然保序；卡片永远出现在它的真实执行位置，不会再沉底。

### 3.5 改动量预估
- store.ts：+blocks 类型与 append/updateTextBlock 助手（~40 行）
- index.ts：handleEnvelope 按 blocks 写入重写 pushDelta/flushDelta（~60 行）
- 新 blockGrouping.tsx 收敛版（~80 行）+ MessageStream 渲染分支改造（~20 行）
- agent-loop/index.ts：delta 事件加 turn 字段（~10 行）
- 总计 ~210 行，纯插件，不动宿主与 SDK 契约（ChatMessage 类型本地扩展同前例）

### 3.6 顺带建议（同批可做）
- 失败卡折叠头显示 error 首行（Polaris errorSummary 模式）
- 审批卡 resolved 后收敛为一行回执（Polaris ShieldCheck/ShieldX 语义，lite 用文字）
