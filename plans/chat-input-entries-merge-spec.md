# 输入行三入口整合方案：附件(1) + 工作目录(3) 并入调谐面板(2)

> 状态：方案（按你的要求仅理解与设计，不直接实施）
> 位置：polaris-lite `plugins/chat-lite/ChatInput.tsx` + `chat-input.css`

## 现状（读码）

输入按钮行 `chat-input-btns` 从左到右：
1. **附件** `chat-send.attach` → `fileRef.click()` 触发隐藏 file input（多选附件，选中后进 `chat-attach-strip` 预览条）
2. **调谐** `chat-send.tune` → 切换 `assistantOpen` 抽屉（内含：工作目录行、执行模式行、待发队列）
3. **工作目录 chip** `chat-ws-btn` → `openPicker()` 打开目录选择浮层（pickerPos 浮层，与抽屉互斥：openPicker 会先 setAssistantOpen(false)）

抽屉里已经有一份「工作目录」行（`chat-assistant-row` 里的 ws-chip，点击同样 openPicker）——也就是说**工作目录现在有两个入口**（抽屉内 + 按钮行 chip），本身就有冗余。

## 整合设计

目标形态：按钮行只留 **调谐(2) + 目录chip(3) + 新会话 + 发送**；附件入口收进调谐抽屉，成为第一行。

### 抽屉新增「附件」行

在 `chat-assistant-inner` 顶部加一行（与「工作目录」行同构）：

```
[附件]  <已选 N 个 / 未选择>        [选择文件…]
```

- 点击「选择文件…」→ `fileRef.current?.click()`（复用现有 fileRef 与 handleFilePicker，无新逻辑）
- 已选附件时显示数量 + 首个文件名省略；预览/移除仍走现有 `chat-attach-strip`（它在输入框上方，与抽屉不冲突）
- `streaming` 时禁用（与现在 attach 按钮的 disabled 语义一致）

### 按钮行变化

- **删除**独立附件按钮（1）
- 调谐按钮（2）title 更新为「附件 · 工作目录 · 执行模式 · 队列」
- 工作目录 chip（3）**保留在按钮行**——它是高频入口且带状态显示（pinned/失效/关联数），符合「始终可见、点一下直接选」的既有注释意图；抽屉里的工作目录行保留作为二级说明入口（也可二选一，见取舍）

### 交互细节

- 抽屉已打开时点调谐按钮关闭；附件行在抽屉内，不影响 picker 互斥逻辑（openPicker 仍会关抽屉）
- 附件行需要 `fileRef` 与附件状态（已有：`fileRef` 在本组件，attach 列表在父级/store）——都在 ChatInput 作用域内，无跨组件改动
- 移动端（≤768px）抽屉 max-height 180px 现在装 4 行可能紧张 → 建议同步调到 240px（既有断点里 `.chat-input-btns { min-height: 42px }` 同文件，改动局部）

## 取舍说明（为什么不把目录 chip 也删掉）

- chip 常显当前目录与失效态，是「AI 命令在哪执行」的关键状态提示；收进抽屉会变成「点开才知道」
- 若你更想要**极致收拢**（按钮行只剩 调谐+发送+新会话），可把 chip 也删、只在抽屉留目录行——代价是失去常显状态。两个形态都成立，默认方案保留 chip。

## 改动面

| 文件 | 改动 |
|---|---|
| `ChatInput.tsx` | 删按钮行附件 button；抽屉顶部加附件行（复用 fileRef/handleFilePicker/附件状态）；调谐 title 文案更新 |
| `chat-input.css` | 抽屉加 `.chat-assistant-row` 附件行样式（基本复用现有 row/chip 样式，可能加一个 `.chat-attach-pick` 小按钮样式）；移动端 max-height 180→240 |
| 不动 | handleFilePicker、attach strip、picker 浮层、store |

风险低：纯 UI 收拢，无状态/协议变化；唯一注意点是附件行点击后抽屉保持打开（让用户看到已选数量），由 attach strip 自身的变化体现。
