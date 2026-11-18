# Polaris 对话输入框（ChatInput）功能全量盘点

> 为 polaris-lite 输入框改造提供的参照系清单。
> 盘点日期：2026-11-18。来源：实读源码，非文档转述。

## 0. 重要事实：代码实际位置与架构形态

**主仓 `D:\space\base\Polaris\src\components\Chat\` 已不存在**——内置 Chat 已随 chat-desk 插件化出仓（AGENTS.md「功能路由原则」），现居：

```
D:\space\base\Polaris-plugin\plugins\chat-desk\src\host\Chat\input\   ← 输入区 17 个文件，共约 4347 行
```

这个位置事实对 lite 极其重要：**Polaris 的输入框已经不是"宿主内置"，而是一个外部插件内的实现**，它通过 shims 桥（`__POLARIS_APP_CORE__` / `__POLARIS_HOST_INVOKE__`）转发宿主 store 与 invoke，其解耦形态本身就是 lite 可以参考的"插件内输入框"先例。但它的 shims 仍是"宿主单例直连"（转发 zustand hook 实例），不是 cap 总线化的——这是与 lite `SlotHostApi` 约定的核心差距。

### 输入目录文件清单（17 个文件）

| 文件 | 行数 | 职责 |
|---|---|---|
| `ChatInput.tsx` | 2131 | 主组件：状态机、建议系统、发送事务、优化浮层 |
| `AutoResizingTextarea.tsx` | 46 | 自适应高度 textarea（forwardRef） |
| `AttachmentPreview.tsx` | 156 | 附件预览（图片缩略图/文件图标/错误态） |
| `ContextBlockPreview.tsx` | 249 | 上下文块 chip（可折叠核对 + 备注编辑） |
| `ContextChips.tsx` / `ContextChip.tsx` | 27+98 | 通用上下文芯片（file/symbol/commit/diff/workspace/directory 六型，**遗留组件，ChatInput 未用**） |
| `FileSuggestion.tsx` | 487 | 统一建议下拉（10 类条目分组渲染 + 键盘滚动） |
| `chatCommandRouter.ts` | 173 | 本地斜杠命令解析与执行 |
| `contextBlockRegistry.ts` | 185 | 上下文块 kind 注册表 + 发送物化（落盘/降级） |
| `promptHistory.ts` | 126 | ↑↓ 召回纯函数（语义对齐 ZCode） |
| `SnippetParamPanel.tsx` | 95 | 片段变量填写浮窗 |
| `PendingQueueCard.tsx` | 131 | 待发送队列胶囊 |
| `InputBanner.tsx` | 52 | AI 注入横幅（cap.ui.input） |
| `UiSlot.tsx` | 73 | AI 注入插槽（cap.self.mutate，白名单 kind） |
| `deps.ts` | 1 | re-export 上级 deps（宿主桥出口） |
| `ChatInput.stopButton.test.tsx` / `promptHistory.test.ts` / `contextBlockRegistry.test.ts` | 57+111+149 | 单测 |

主入口装配在 `Polaris-plugin/plugins/chat-desk/src/index.tsx:67-86`：`onSend=sendMessage`、`onInterrupt=interruptChat`、`statusBarSlot=<ChatStatusBar>`。

以下行号均相对各文件自身，路径缩写：
- `CI` = `D:\space\base\Polaris-plugin\plugins\chat-desk\src\host\Chat\input\ChatInput.tsx`
- `IN` = 同目录
- `CS` = `D:\space\base\Polaris-plugin\plugins\chat-desk\src\host\conversationStore\`
- `SH` = `D:\space\base\Polaris-plugin\plugins\chat-desk\src\shims\`

---

## 1. 基础输入

| 能力 | 实现位置 | 依赖 | 说明 |
|---|---|---|---|
| 多行自适应增高 | `IN/AutoResizingTextarea.tsx:23-32`（`useLayoutEffect` 重置 auto → clamp scrollHeight） | 无 | maxHeight=200 / minHeight=40（`CI:1776-1777`） |
| Enter 发送 / Shift+Enter 换行 | `CI:1450-1465` | 无 | `e.key==='Enter' && !e.shiftKey` |
| **IME 组词防护** | `CI:1453`（Enter）、`CI:1492`（↑↓） | 无 | `e.nativeEvent.isComposing` 检查——组词中 Enter 是上候选词不是发送；↑↓ 是候选导航不是历史召回。**中文用户必踩点，lite 必搬** |
| 输入长度上限 | `CI:1271-1281` | useToastStore | 200,000 字符，超出 toast 拦截（`input.tooLong`），提示分段或存文件 @引用 |
| 字数显示 | `CI:2056-2058`（statusBarSlot 模式下 `value.length`，仅 ≥sm 屏） + `CI:382-384` 同步到 inputUIStore | useInputUIStore | |
| 占位符动态化 | `CI:1773`：有附件时切换 `input.placeholderWithAttachment` | i18n | |
| 全局聚焦请求 | `CI:327-332` 监听 `eventBus.on('chat:focus-input')`，`setTimeout(0)` 推迟一拍聚焦 | eventBus（宿主桥） | 触发源：useWindowManager 快捷键新建会话（宿主 `src/hooks/useWindowManager.ts:157`） |
| 编辑模式（重发） | `CI:279-286`（进入时填入消息内容并聚焦）、`CI:1621-1632`（提示条 + 取消按钮）、`CI:1404-1412`（onEditSend → store.editAndResend）、流式中拦截（`CI:1408-1411`，防 store 静默拒绝丢改动） | conversationStore（editAndResend）、props（editMode/onCancelEdit/onEditSend） | |
| ESC 三级语义 | `CI:1515-1530`：关建议 → 退出编辑模式 → 中断流式 | props | |
| Tab 选中建议 | `CI:1533-1536` | 无 | |
| 禁用态 | `CI:136-137`（disabled prop）；装配处 `index.tsx:70`：`!currentWorkspace && !activeSessionIsFree`（无工作区且非自由会话） | useWorkspaceStore | |

**无字数/行数硬限制的防抖**：无；唯一上限就是 200k 字符。

## 2. 附件体系

### 2.1 类型与限制（`plugins/chat-desk/src/types/attachment.ts`）

- 数量：maxCount **10**（`:50`）；图片单件 **20MB**（`:52`）；文件单件 **50MB**（`:54`）；总量 **100MB**（`:56`）
- 图片类型白名单：png/jpeg/gif/webp/bmp（`:58`）
- 文本类型白名单 + 代码扩展名白名单约 30 个（`:60-81`），扩展名同时用于文件选择器 `accept`（`CI:1750`）
- 单件校验 `validateAttachment`、整批校验 `validateAttachments`（数量/总量），失败 toast 拦截（`CI:416-438`）
- 附件对象：图片走 base64 data URL（`content`），文本/代码文件走 `textContent` 避免 base64 膨胀（`types/attachment.ts:30-43`）

### 2.2 三种进入方式

| 方式 | 位置 | 细节 |
|---|---|---|
| 粘贴 | `CI:460-488` | 遍历 clipboardData.items：image/* 或 file kind 均收为附件；有文件时 preventDefault |
| 拖拽 | `CI:491-504` + 容器 `CI:1740-1741` | drop + dragOver preventDefault |
| 文件选择器 | `CI:507-519`（回形针按钮 `CI:1784-1791`） | `<input type=file multiple hidden>`，选后清空 value 允许重选同一文件；accept 用 ATTACHMENT_LIMITS 拼接 |

### 2.3 预览与移除

- `IN/AttachmentPreview.tsx`：loading 态（转圈）/ error 态（红框 + 错误信息）/ 图片 64px 缩略图（hover 显删除钮 + 底部文件名）/ 文件图标卡（图标 + 文件名 + 大小）。图片加载失败降级为文件图标（`onError`，`:74-98`）
- 移除：`removeAttachment`（`CI:441-447`），本地 state 即时更新 + 防抖持久化草稿

### 2.4 随消息发送的方式

- onSend 签名携带 `attachments?: Attachment[]`（`CI:136`）→ conversationStore.sendMessage → v2-kernel → 后端 `process_attachments`（`Polaris/src-tauri/src/services/ai_chat_core/attachments.rs:84`）：图片落盘 `.polaris/attachments/` 供模型 Read 工具读取；>30KB 文本与二进制落盘为路径引用。**前端只传 base64/文本，落盘在后端**
- 流式期间入队：附件随队列项保存（`CI:1326-1331`）

## 3. 上下文引用（两套并存）

### 3.1 文本内 @引用（无 chip，正文 token 形态）

| 语法 | 触发检测 | 选中后行为 |
|---|---|---|
| `@` 单独 | `CI:1025-1038` | 弹工作区列表 + 当前工作区文件搜索 |
| `@name` 部分输入 | `CI:991-1022` | 工作区名过滤 + 当前工作区文件搜索 |
| `@workspace:path` | `CI:963-988` | 指定工作区内文件搜索（跨工作区引用） |
| `@/path` | `CI:888-900` | 跨工作区路径建议 |
| `@对话 <查询>` | `CI:904-916` | **历史会话引用**：搜索全引擎历史会话（dialogStorageService.listConversations，`CI:352-374`）→ 选中后 loadConversationMessages → `packForReference` 落盘 `.polaris-handoff/` → 把 `@对话` token 替换为 `@relPath`（`CI:1193-1234`）。落盘工作区优先用源对话自己的 workspacePath（`CI:1201`） |
| `@专家:slug` | `CI:921-960` | 专家提及，注入 `@专家:slug ` 文本 |

文件搜索数据源：`useFileSearch`（`SH/hooks.ts:106-138`）→ `invoke('search_files')`（宿主旧命令路径 `commands/file_explorer.rs:621`，maxResults=10）。**注意：这走的是旧 commands 通道而非 cap 总线**。

### 3.2 ContextBlock（TCB，chip 形态，与附件平行）

- 数据：`InputDraft.contextBlocks`（`CS/types.ts:106-113`），per-session 草稿三通道之一
- 注册表模式：`IN/contextBlockRegistry.ts`——`registerContextBlockKind(kind, {icon, format})`，内置 `marquee-context`（浏览器圈选，`:77`）与 `cap-help`（/cap 能力引用，`:78`）；未注册 kind 降级为 data JSON 文本（`:167-175`，不白屏）
- 写入：外部经 store 的 `addContextBlock`（`CS/createConversationStore.ts:493-507`）；去重语义 `source+dedupeKey` 原位覆盖（`upsertContextBlock`，registry `:88-98`），ChatInput 内 /cap 选中时直接调用（`CI:1179-1185`）
- 展示：`IN/ContextBlockPreview.tsx`——折叠 chip（标题/来源/尺寸摘要）+ 展开核对 + 内联备注编辑（`updateContextBlockNote`）
- **发送物化单点**：`materializeContextBlocks`（registry `:112-132`）——有工作区：全部块落盘 `.polaris-handoff/tcb-<ts>.md`（`invoke('create_file')`，旧命令通道），末尾只追加固定引导句 + `@relPath`；无工作区/失败：末尾追加格式化全文（保底不丢内容）。**契约：引用统一在用户正文之后（末尾包含）**，spec 见 `plans/reference-mapping-spec.md`
- 移除：`removeContextBlock`（`CI:451-457`）

### 3.3 遗留：ContextChips/ContextChip（`IN/ContextChips.tsx`/`ContextChip.tsx`）

六型通用芯片（file/symbol/commit/diff/workspace/directory），从 `@/types/context` 取 label/icon。**ChatInput 当前渲染路径未使用**（数据源随内置浏览器退役），属死代码候选，lite 不必搬。

## 4. 命令路由（斜杠命令）

### 4.1 触发检测（`CI:817-885`）

- 任意位置的词边界 `/`（`(^|[\s(,;]|\[)\/(\S*)$/`），排除 `@/path` 中的 `/`
- 消息首判定 `isMessageStart`（`:829`）——CLI 命令与 /cap 仅消息首生效

### 4.2 命令全景

**A. 本地命令（chatCommandRouter.ts 执行，不进引擎）**——`IN/chatCommandRouter.ts:42-173`：

| 命令 | 行为 | 依赖 |
|---|---|---|
| `/cap [查询] [正文]` | cap 能力协议速查注入：唯一命中→detail 块；多命中→toast 列出；无 token→digest 全量。选中建议时转为轻量引用 chip（`CI:1168-1192`），流式中也收编（`CI:1303-1322`） | cap.help（capCatalogStore 会话级缓存）→ **RouterBus** |
| `/nexus <scenario> <goal>` | 组队派发（拓扑波次） | `invoke('nexus_start_roster')` 旧命令通道 |
| `/agent [slug]` | 设/清当前专家 | useAgentStore + sessionConfigStore + sessionStoreManager |
| `/dispatch [@角色\|slug] 任务` | 派发后台会话 | dispatchFromUser（宿主桥） |
| `/assault <profile> <problem>` | 剥前缀后作普通文本发送 | 纯文本变换 |

返回契约：`{handled:false}` 继续 / `{handled:true}` 清空 / `{handled:true, sendText}` 以 sendText 走普通发送（`chatCommandRouter.ts:35-37`）。sendText 发送时挂着的引用 chips 一并物化追加（`CI:1368-1377`）。

**B. 建议列表命令（`/` 弹出，选中后改写输入）**——`CI:820-875`：

| 类型 | 选中后插入 | 数据源 |
|---|---|---|
| 快捷片段 | 展开模板内容（有变量→SnippetParamPanel 浮窗，`CI:1114-1126` + `IN/SnippetParamPanel.tsx`）；自动变量 `{{workspaceName}}` 等经 `resolveTemplateVariables` 解析（`CI:1075-1081`） | useSnippetStore → cap.prompt_snippet |
| CLI 命令 | `/name ` 原文保留，整条交给 Claude CLI 解析 | cliSlashCommands.ts 静态三级目录（suggest/known/blocked）+ CLI init 事件动态 slash_commands 全集；**仅 claude-code 引擎且消息首**（`CI:827-836`） |
| Skill | `skill-<id> ` | useSkillStore（宿主桥） |
| MCP 插件 | `mcp-<serverId> ` | pluginRegistry + listEnabledPluginMcpServers（`CI:167-176`） |
| /cap 入口 | 转引用 chip（见上） | capCatalogStore（cap.help index） |

**C. 参数补全**：`/agent|/dispatch|/nexus <slug>` 弹专家建议（`CI:736-787`）；`/cap <token>` 弹能力 id/中文短名过滤（`CI:789-812`，懒加载目录）。

**D. CLI 命令拦截**：claude 引擎发送前 `matchBlockedCliCommand` 拦 `/clear` 等破坏会话一致性的命令（`CI:1383-1393`），toast 提示用新建会话代替。

### 4.3 别名机制

无独立别名注册表。等价物：CLI 命令 meta 自带 `aliases`（`host/services/cliSlashCommands.ts:35`）；/cap 支持中文短名匹配（`matchCaps`）；MCP 匹配时剥 `polaris[-_.]` 前缀再比对（`CI:861`）。

## 5. 设置与状态

### 5.1 输入框自身可配置项

| 项 | 位置 | 存储 |
|---|---|---|
| 聊天显示样式（chatDisplay → CSS vars） | `CI:164-165`（`getChatDisplayStyleVars`） | useConfigStore（宿主 config，cap.config） |
| 建议浮窗高度/间距/开关 | `CI:397-413` 读 `inputUIStore.floating.height` 做智能上下定位 | useInputUIStore（宿主，localStorage persist；**AI 可经 cap.ui.input patch 实时调节**，`Polaris/src-tauri/src/services/router/ui_input_capability.rs`） |
| 提示词优化配置（引擎/模式/方向/轮次/Profile/模型） | `CI:548-611` | localStorage（readStoredOptimizeConfig/storeOptimizeConfig） |

### 5.2 引擎/模型选择

不在 ChatInput 内部——经 `statusBarSlot` prop 注入 `ChatStatusBar`（`IN/../common/ChatStatusBar.tsx`）：宽度分级（720/560/420 三档，`:44-50`）决定 profile/model/effort 选择器显隐，agent/permission 收纳进「更多」折叠；含引擎健康指示、ContextMeter 上下文用量条。ChatInput 只留 `flex-1` 中段插槽（`CI:2044-2051`）。

### 5.3 发送按钮状态机（`CI:1564-1585`、`CI:2053-2080`）

- `canSend`（`:1564`）=（有文本 或 有附件 或 有 contextBlocks）且 !disabled
- `hasDraftToSubmit`（`:1567`）= 同源内容判定（不含 disabled）
- 三形态（对齐 ZCode `showStopControl`）：
  - 流式 + 空输入 → 红色中断键独占按钮位
  - 流式 + 有草稿 → **停止键与发送键并排**（发送键点击走 handleSend 的 isStreaming 分支自动入队；U2 修复：原三元替换后紧急出口只剩无提示的 ESC）
  - 空闲 + 有内容 → 发送键
- `isInterrupting`（`CI:187-191`）：按下停止后按钮禁用转圈直到 session_end（5s 兜底）
- ESC 亦触发中断（`CI:1526-1529`）
- 单测：`IN/ChatInput.stopButton.test.tsx`

### 5.4 发送主流程（handleSend，`CI:1264-1446`）

顺序：空输入但有队列→Enter 直发队首（`:1283-1286`）→ 流式中→入队（`:1289-1355`，本地命令忽略、/cap 收编为 chip、引用物化后入队、清空）→ 本地斜杠命令→router（`:1357-1378`）→ CLI 拦截（`:1383-1393`）→ 优化中发送=放弃优化（`:1396-1398`）→ 编辑模式→editAndResend（`:1404-1412`）→ 普通发送（`:1418-1427`，引用物化追加末尾，整段文本一条消息保留换行）→ 统一清空（本地 state + store 草稿 + 优化版本栈 + 历史索引）。

## 6. 粘贴/拖拽行为

见 §2.2。补充：
- 纯文本粘贴不做任何变换（原生行为）
- 拖拽仅接受 `dataTransfer.files`（`:495`），非文件拖拽（如文字/链接）不处理
- 无「粘贴大文本自动转附件」——大文本靠 200k 上限拦截

## 7. 草稿

- **存储位置**：`conversationStore.inputDraft`（`CS/types.ts:106-113`），per-session 内存态（Zustand store 内），**不落盘**——重启即丢
- 同步机制：本地 state 即时 + `useDebouncedCallback(300ms)` 防抖持久化到 store（`CI:290-295`）
- 会话切换：切走时 `cancelPersistDraft()`（防 300ms 窗口内 A 会话草稿写入 B，审计 5.3，`CI:297-305`）；切入时 effect 把 store 草稿同步到本地（`CI:307-320`）
- 附件与 contextBlocks 与文本平行持久化（`CI:292`）
- 发送失败回滚：sendMessage 失败时若草稿为空则恢复原草稿含附件（`CS/createConversationStore.ts:2481-2491`）
- **prompt 历史（≠草稿）落盘**：cap.kv per-workspace（`host/services/kvBacked/promptHistoryService.ts:40` router_dispatch target='cap.kv'，key=`prompt-history:<workspacePath|no-workspace>`，上限 30 条）；加载用代数号防过期覆盖（`CI:236-253`）；提交事务：发送成功才入史、失败回滚（`CI:255-276`）

## 8. 其他值得搬的能力

| 能力 | 位置 | 说明 |
|---|---|---|
| **Prompt 历史 ↑↓ 召回（终端风格）** | `CI:228-276`（状态+持久化）、`CI:1484-1512`（按键接管）、`IN/promptHistory.ts`（纯函数：append 去重只比最后一条、up 聚最旧、down 翻尽退出浏览态） | 空输入或浏览态才接管方向键，不抢多行光标移动；召回值不写草稿（浏览不污染草稿） |
| **待发送队列（流式预输入）** | `IN/PendingQueueCard.tsx` + store `enqueuePending/sendPendingNow/editPending`（`CS/createConversationStore.ts:2089+`） | 流式回复期间输入→入队，session_end/中断后自动逐条发送；胶囊折叠/展开、逐条立即发送/编辑/取消；sending 态锁定防派发竞争 |
| **待发送简报卡片（压缩交接）** | `IN/../compact-handoff/PendingBriefingCard.tsx`（`CI:1590` 挂载） | 简报作为一次性系统上下文（oneTimeSystemPrompt）随下一条消息带出，不进用户气泡 |
| **提示词优化（AI 改写输入）** | `CI:521-691`（配置浮层：引擎 quick/deep × 方向 5 种 × 迭代 1-5 轮 × Profile/模型高级项 + 隐私提示）、三态胶囊（运行中流式预览+取消 / ready 待确认应用+丢弃 / 失败重试）、**版本栈 undo/redo**（`CI:660-683`、`CI:2002-2041`，手改后 redo 禁用防覆盖） | runPromptOptimize → 临时优化会话 → cap.ai.chat（router_dispatch，`host/services/aiChatDispatch.ts:24-32`）；配置持久化 localStorage |
| **下一步建议气泡（--prompt-suggestions）** | `CI:1634-1651`（空输入+非流式+非编辑态展示，点击填入）；生产端 `CS/eventHandler.ts:776`（`prompt_suggestion` AIEvent → store.promptSuggestion） | 引擎事件驱动 |
| **AI 动态横幅（cap.ui.input banner）** | `IN/InputBanner.tsx` + `CI:1731` | tone 四级、可选动作按钮（dispatch 低危白名单）、可清除；后端校验在 `ui_input_capability.rs` |
| **AI 插槽组件（cap.self.mutate）** | `IN/UiSlot.tsx` + `CI:1733-1735`（`slotId="input-extra"`） | 白名单 kind（status-badge/tooltip-label/quick-action），未知 kind 安全降级 null |
| **片段变量浮窗** | `IN/SnippetParamPanel.tsx` + 局部替换逻辑（`CI:1594-1620`：记录触发前光标，展开后只替换 `/xxx` token 保留前后文） | |
| **@专家 提及** | `CI:918-960`（任意位置 `@专家<查询>`） | 注入 `@专家:slug` 文本 |
| **建议浮窗智能定位** | `CI:397-413`：下方空间 < 浮窗高度（可被 AI 调节）时翻转到上方 | |
| **点击外部关闭** | 建议：`CI:1554-1562`（document click）；优化浮层：`CI:527-539`（mousedown + 两 ref contains） | |
| **iOS 安全区补偿** | `CI:2127-2128`：`h-[env(safe-area-inset-bottom)]`（桌面为 0 零副作用） | 移动端友好 |
| **流式中编辑消息防护** | `CI:1406-1411`：流式守卫提前拦截 + toast，防静默丢改动 | |

---

## 9. 依赖图（store / service / cap 汇总）

### 9.1 依赖的 store（全部经 shims 转发或本地）

| store | 来源 | 用途 |
|---|---|---|
| conversationStore（useActiveSession* 一族） | 插件本地（CS/） | 草稿/优化版本栈/待发队列/建议/中断态/发送——**输入框的事实主存** |
| sessionStoreManager | 插件本地 | 会话 id、专家写入 |
| useInputUIStore | 宿主桥 | 字数/附件数/建议模式镜像 + floating 配置 + banner |
| useWorkspaceStore / useConfigStore / useToastStore | 宿主桥 | 工作区列表 / chatDisplay+defaultEngine / toast |
| useSnippetStore / useAgentStore | 插件本地 | 片段 / 专家目录 |
| useSkillStore / usePluginStore / useCapCatalogStore / useCliInfoStore / useModelProfileStore / useUiSlotStore | 宿主桥 | 命令建议各数据源 / 优化 Profile / 插槽 |
| useSessionConfig | 插件本地 session-config | /agent 写入当前专家 |

### 9.2 依赖的 cap（RouterBus）

| cap | 用途 | 调用点 |
|---|---|---|
| **cap.kv** | prompt 历史持久化（get/set） | promptHistoryService.ts:40 |
| **cap.ai.chat** | 提示词优化临时会话（dispatch + dispatch_stream） | aiChatDispatch.ts:24 |
| **cap.help** | /cap 目录（index/describe） | capCatalogStore（宿主桥） |
| **cap.ui.input** | AI 调浮窗参数 + 注入横幅 | 后端 ui_input_capability.rs → inputUIStore |
| **cap.self.mutate** | input-extra 插槽 | UiSlot |
| **cap.prompt_snippet** | 快捷片段 CRUD | snippetService（宿主桥） |

### 9.3 走旧命令通道（非 cap）的 invoke

`search_files`（文件搜索）、`create_file`（TCB 落盘）、`nexus_start_roster`（组队）、dialogStorageService 的会话列表/消息读取（@对话）。均为宿主 `__POLARIS_HOST_INVOKE__` 直连。

---

## 10. 「宿主强耦合」标记（lite 插件化需改造）

以下项依赖 appCoreBridge / store 内部实现 / 旧命令通道，在 lite 的 `SlotHostApi`（cap dispatch / listen / emit / layout）约束下不能原样搬：

1. **conversationStore 全族**（草稿、待发队列、优化版本栈、编辑模式、中断态）——插件本地 Zustand 但深耦合宿主 session 生命周期，lite 需自持等价状态或走会话 cap
2. **useFileSearch → `invoke('search_files')`**——旧命令通道，非 cap；lite 需 cap.fs 搜索类能力或插件自实现
3. **materializeContextBlocks → `invoke('create_file')`**——落盘走旧命令；lite 需 cap.fs 写文件
4. **@对话 → dialogStorageService**（listConversations/getConversationMessages）——历史会话查询直连宿主存储服务；lite 需 cap.history 类能力
5. **promptOptimizeService → cap.ai.chat + sessionStoreManager**——优化临时会话复用宿主会话机制
6. **pluginRegistry / listEnabledPluginMcpServers**——宿主插件系统内部 API
7. **eventBus（chat:focus-input）**——宿主全局事件总线
8. **useInputUIStore / useUiSlotStore**（cap.ui.input / cap.self.mutate 前端真相）——状态真相在宿主 store；lite 若宿主无对应 cap 消费端则不可用
9. **ChatStatusBar 全套**（引擎选择器/健康/ContextMeter）——依赖宿主 engineMetadata/sessionConfig 一大片
10. **/nexus /agent /dispatch 命令**——依赖宿主 agent 系统与 nexus 派发命令
11. **cliSlashCommands 动态目录（cli_init 事件）**——依赖 claude 引擎 init 事件流
12. **useSnippetStore/useSkillStore 数据源**——可走 cap.prompt_snippet，但 store 实例经宿主桥

---

## 11. 三层移植分类

### A. 可直接移植（纯 UI / 纯函数，零宿主依赖）

- AutoResizingTextarea（自适应增高）
- IME isComposing 防护（Enter + ↑↓ 两处）
- Enter/Shift+Enter/ESC 三级语义、Tab 选建议
- 输入长度上限（200k）+ toast 拦截
- 附件校验常量与纯函数（ATTACHMENT_LIMITS/validateAttachment/isTextFile/formatFileSize）
- AttachmentPreview（预览三态 + 移除）
- 附件进入三通道（粘贴/拖拽/选择器）——DOM API 纯前端
- promptHistory 纯函数模块（append/navigate/去重语义）
- 发送按钮状态机（canSend/hasDraftToSubmit/并排停止键 + isInterrupting 反馈）
- 建议浮窗组件 UnifiedSuggestion（分组渲染 + 键盘滚动 + 智能定位）+ 键盘导航
- SnippetParamPanel（片段变量浮窗）+ 局部替换光标逻辑
- 建议框智能上下定位、点击外部关闭
- 安全区补偿、动态 placeholder
- ContextBlockPreview 的 chip 交互形态（数据结构需重定义）
- chatCommandRouter 的**路由形态**（tryHandleSlashCommand 契约：handled/sendText）——命令本身按需裁剪
- 草稿的防抖 + 会话切换取消模式（配什么存储另说）
- 发送失败恢复草稿、流式中编辑防护等**时序防御模式**

### B. 需适配总线（逻辑可搬，但依赖要换成 cap dispatch / 自持状态）

- 附件发送链：前端 base64 → 需 lite 侧定义附件如何进引擎（新 cap 或随消息 payload；Polaris 的后端 process_attachments 是宿主私有）
- Prompt 历史持久化：cap.kv 模式照搬（若 lite 宿主有等价 kv cap；否则 localStorage 降级，牺牲数据根单点）
- 上下文块物化：落盘 `.polaris-handoff/` 需 cap.fs 写文件；无工作区降级全文拼接的模式可原样搬
- 文件搜索建议（@路径）：需 cap.fs 搜索能力或限当前目录遍历
- /cap 命令 + cap.help 目录：cap 总线原生能力，lite 宿主有 RouterBus 即可搬（含引用 chip 转换）
- 快捷片段：cap.prompt_snippet CRUD + / 触发建议
- 提示词优化：需要 cap.ai.chat 类会话能力 + lite 自持版本栈；方向/轮次/浮层 UI 可搬
- 待发送队列：队列 UI 与「流式期间入队、session_end 派发」语义可搬，但 session_end 事件需经 listen 订阅
- 下一步建议气泡：需引擎 prompt_suggestion 事件经 listen 到达
- @对话 历史引用：需 cap.history 或等价会话查询能力
- 编辑模式（editAndResend）：需会话消息编辑能力
- 中断（isInterrupting + session_end 收口）：需引擎中断事件流

### C. 需重新设计（宿主私有域 / 应裁剪）

- ChatStatusBar 全套（引擎/Profile/model/effort/permission 选择器、引擎健康、ContextMeter）——lite 宿主模型完全不同，应按 lite 的会话配置面重新设计，或砍到只剩引擎指示
- /nexus /agent /dispatch 命令——宿主 agent 编排域，lite 无对应物；命令路由保留注册表形态，命令按 lite 插件能力重新注册
- CLI 斜杠命令三级目录 + cli_init 动态建议 + /clear 拦截——claude-code 引擎特化，除非 lite 也跑同形态 CLI
- @专家 提及、专家参数补全——依赖宿主 agentStore
- MCP 服务器建议（`mcp-<id>` 插入）——依赖宿主 pluginRegistry；若 lite 有 MCP 概念可仿形态
- cap.ui.input banner / cap.self.mutate input-extra 插槽——依赖宿主前端 cap 消费端；lite 若无同构 cap 链路则需先立契约
- 压缩交接 PendingBriefingCard（oneTimeSystemPrompt）——宿主 compact-handoff 域
- chatDisplay CSS vars / inputUIStore floating（AI 调节浮窗高度）——宿主主题与配置体系
- 遗留 ContextChips 六型芯片——死代码，不搬

---

## 12. 盘点结论要点（给 analysis.md 的输入）

1. **体量真相**：输入区不是 2131 行单文件，是 17 文件约 4.3k 行的子系统；其中约一半是「建议系统」（@引用 + 斜杠命令共 10 类条目源）。
2. **Polaris 输入框已是插件形态**（chat-desk），但它的解耦靠「shims 转发宿主 store 单例 + invoke 直连」，不是 cap 化——lite 的 SlotHostApi 约束更严，B 层改造量主要在把 shims 依赖换成 cap dispatch/自持状态。
3. **发送事务纪律**（历史提交事务、草稿防抖取消、失败回滚、流式防误清）是大量审计修复沉淀的行为规格，比 UI 更值得原样搬。
4. **引用物化契约**（「末尾包含」+ 落盘 .polaris-handoff + @path 引用 + 无工作区降级全文）是独立可搬的设计，与具体引用源无关。
