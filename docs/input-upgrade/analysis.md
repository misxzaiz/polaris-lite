# polaris-lite 对话输入框改造分析（仅分析，不实施）

> 日期：2026-11-18。依据：[polaris-input-inventory.md](polaris-input-inventory.md)（Polaris chat-desk 输入区 17 文件 ~4.3k 行实读盘点）+ polaris-lite chat-lite 现状（ChatInput.tsx 46 行）。
> 结论先行：**大部分能力只改 chat-lite 插件即可；少部分需在 lite 宿主新增 2~3 个 cap 契约；还有一批明确不搬。**

## 1. 关键事实修正

- Polaris 的输入框**已经是插件**（chat-desk），不再是主仓内置。它的解耦方式是 shims 转发宿主 store 单例 + invoke 直连旧命令通道——不是 cap 化。lite 的 `SlotHostApi`（cap dispatch/listen/emit/layout）约束更严格，所以「参考」主要是搬行为规格与纯 UI，而不是搬依赖方式。
- 体量：输入区是约 4.3k 行子系统，其中约一半是「建议系统」（@引用 6 种语法 + 斜杠命令 10 类条目源）。lite 改造应分阶段，不要一次照抄。

## 2. 差距表（lite 现状 → Polaris 能力，逐项归属判定）

归属符号：**[P]** 只改 chat-lite 插件；**[P+]** 改 chat-lite + 另一插件（引擎侧）；**[H]** 需 lite 宿主新增契约；**[X]** 明确不搬。

### 2.1 基础输入（全部 [P]）

| 能力 | Polaris 出处 | lite 判定 |
|---|---|---|
| 自适应增高（max 200/min 40） | AutoResizingTextarea.tsx:23-32 | [P] 纯 UI，直接搬 |
| **IME isComposing 防护**（Enter/↑↓ 两处） | CI:1453/1492 | [P] **必搬**——lite 现在的 Enter 发送在中文输入法组词时会把候选确认当发送，属现存 bug |
| Enter 发送/Shift+Enter 换行（已有） | CI:1450-1465 | 已有 |
| ESC 三级语义（关建议→退编辑→中断） | CI:1515-1530 | [P] 中断分支接现有 interruptChat |
| 200k 字符上限 + toast 拦截 | CI:1271-1281 | [P] 自持 |
| 动态 placeholder（有附件时切换） | CI:1773 | [P] |
| 全局聚焦（chat:focus-input） | CI:327-332 | [P] 插件内自建聚焦事件或暂缓——lite 无 eventBus，可先用 document CustomEvent，零宿主改动 |

### 2.2 附件体系（[P+]，重逻辑在引擎插件）

| 能力 | Polaris 出处 | lite 判定 |
|---|---|---|
| 校验常量（10 件/图 20MB/文 50MB/总量 100MB/白名单） | types/attachment.ts:50-81 | [P] 纯函数直接搬 |
| 三通道进入（粘贴/拖拽/选择器） | CI:460-519 | [P] DOM API 纯前端 |
| 预览三态 + 移除 | AttachmentPreview.tsx | [P] 纯 UI |
| 图片 base64 / 文本直存双形态 | types/attachment.ts:30-43 | [P] 前端形态照搬 |
| 随消息进引擎 | 后端 process_attachments 落盘 | **[P+]** lite 无此后端；附件内容作为 payload 一部分随 `cap.ai.chat` 的 messages/payload 传入，**由 real-engine 插件在 streamHandler 里解析**（如拼进 prompt 或后续落盘）——改的是 real-engine，不是宿主 |

> 附件链路是唯一需要「跨插件对齐」的项：chat-lite 负责收集与校验，real-engine 负责消费。建议在 payload 里新增 `attachments?: {name,mime,size,content|textContent}[]` 字段即可，两插件同版本发布。

### 2.3 上下文引用（分层）

| 能力 | Polaris 出处 | lite 判定 |
|---|---|---|
| 引用本会话历史消息 chips | —（Polaris 无此形态） | [P] lite 特色：消息在 useSessionStore（核心 store，插件可 import），chips 只是「发送时额外带哪些消息 id」——payload 里带 `contextMessageIds`，引擎把它拼进 history。纯插件 |
| 引用工作区文件（@路径搜索） | CI:888-1038，invoke('search_files') | **[H]** 需要 `cap.fs.search/read`——或第一期**降级**为手选文件附件（同 2.2 通道），零宿主改动 |
| @对话（历史会话引用） | CI:904-916 + dialogStorageService | [X→H*] 第一期不做（lite 无 cap.history）；后续若做需宿主立 `cap.history` 契约 |
| ContextBlock TCB（chip 注册表+末尾物化落盘） | contextBlockRegistry.ts | [P-] **形态可搬、能力裁剪**：注册表模式 + 「末尾包含」契约 + 无工作区降级全文拼接——这三条设计原样搬；落盘那步第一期不做（无 cap.fs），降级路径就是主路径 |
| 遗留 ContextChips 六型芯片 | ContextChips.tsx | [X] Polaris 侧已是死代码候选，不搬 |

### 2.4 命令路由（[P] 为主）

| 能力 | Polaris 出处 | lite 判定 |
|---|---|---|
| tryHandleSlashCommand 契约（handled/sendText） | chatCommandRouter.ts:35-37 | [P] 路由形态原样搬；lite 内建命令注册表 |
| 词边界 `/` 触发 + isMessageStart | CI:817-885 | [P] 照搬 |
| 命令建议列表框架（分组/键盘导航/智能定位/外点关闭） | FileSuggestion.tsx + CI:397-413 | [P] 组件与交互搬空，条目源按 lite 裁剪 |
| /cap 能力速查 | capCatalogStore → cap.help | [P] lite 有 RouterBus；声明 `capabilities:['cap.help']`（若 lite 有该 cap；无则第一期砍） |
| 片段命令 + 变量浮窗 + 局部替换 | SnippetParamPanel + CI:1594-1620 | [P→H*] 交互全可搬；数据源若无 cap.prompt_snippet 则 localStorage 自持（后续再 cap 化） |
| /nexus /agent /dispatch | agent 域 | [X] lite 无对应编排域，注册表留空位 |
| CLI 三级目录 + /clear 拦截 | cliSlashCommands + CI:1383-1393 | [X] claude 引擎特化，不搬 |

### 2.5 状态与设置（[P] 为主）

| 能力 | Polaris 出处 | lite 判定 |
|---|---|---|
| 发送按钮三形态（流式+草稿时停止/发送并排）+ isInterrupting | CI:1564-1585 + 单测 | [P] 状态机原样搬（含单测思维）；接入现有 session_end≈message.done 语义 |
| 草稿 per-session + 300ms 防抖 + 切会话取消 + 失败回滚 | CI:290-320 | [P] **行为规格照搬**（这是审计沉淀的时序纪律）；存储用插件内 Zustand/sessionStorage |
| ↑↓ prompt 历史召回 | promptHistory.ts 纯函数 + CI:1484-1512 | [P-] 纯函数直接搬；落盘降级 localStorage（Polaris 走 cap.kv，lite 无此 cap——后续可加） |
| 待发送队列（流式预输入） | PendingQueueCard + store | [P] 队列语义可搬；session_end 派发改为 listen('chat-event') 的 message.done 驱动 |
| 编辑重发模式 | CI:279-286/1404-1412 | [P] 消息在 lite 核心store，插件可做 editAndResend（引擎侧消息以 id 定位，payload 带 replaceMessageId） |
| 输入区设置（模型/供应商选择 popover） | ChatStatusBar（宿主大耦合） | [P 重新设计] 不搬 ChatStatusBar；lite 已有 model-admin 的 cap.config 供应商数据——chat-lite 加 `capabilities:['cap.config']` 声明读 providers，输入框旁挂一个轻量「当前模型」选择 popover，**零宿主改动** |
| 提示词优化（AI 改写） | CI:521-691 + 优化会话 | [P-] 可搬浮层与版本栈 undo/redo（纯 UI 亮点）；优化调用走已有 cap.ai.chat 开一个临时 message——第一期可缓（价值/成本比中等） |
| 下一步建议气泡 | prompt_suggestion 事件 | [X→H*] 依赖引擎侧生产事件，第一期不做 |
| AI banner / input-extra 插槽 | cap.ui.input / cap.self.mutate | [X] 依赖宿主前端 cap 消费端，lite 未立契约，不做 |

## 3. 需要宿主新增的契约（全量盘点后仅 0~2 个）

| 契约 | 必要性 | 建议 |
|---|---|---|
| cap.fs（search/read/write） | 文件引用搜索、TCB 落盘 | **第一期不建**：附件走手选、TCB 走全文拼接降级路径。第二期若确需工作区文件引用再立（形态可对齐 Polaris cap.fs：read/search/write 三动作） |
| cap.history | @对话历史会话引用 | 第一期不做 |
| cap.kv | prompt 历史落盘 | 第一期 localStorage 降级；lite 若已有 config-manager 的 kv 思想可后续泛化 |

**结论：第一期 100% 只改 chat-lite 插件（+ real-engine 侧附件消费对齐），宿主零改动。**

## 4. 阶段路线（建议 4 期，每期可独立上线回归）

### 第 1 期：基础体验对齐（全 [P]，估 2~3 天）
自适应增高、**IME 防护（修现存 bug）**、ESC 三级、200k 上限、动态 placeholder、发送按钮三形态 + isInterrupting、草稿（防抖/切会话取消/失败回滚）、per-session 存储。
**验收**：中文输入法组词回车不再误发；切会话草稿不串；流式中空/非空输入的按钮形态与 Polaris 一致。

### 第 2 期：附件链路（[P+]，估 2 天）
校验常量 + 三通道 + 预览三态 + 随消息发送；payload 扩 `attachments[]`；real-engine 侧解析拼 prompt。
**验收**：粘贴/拖拽/选择器三通道；图片随消息到达模型（模型能描述图片内容即通）。

### 第 3 期：命令与建议（[P]，估 2~3 天）
tryHandleSlashCommand 契约 + 词边界触发 + 建议浮窗框架（分组/键盘/定位）+ ↑↓ 历史召回（localStorage）+ 待发送队列。命令注册表首发：内部命令（/clear 之类 lite 等价物）+ /cap（若 cap.help 在）+ 片段（localStorage 版）。
**验收**：`/` 弹建议、键盘可选、↑↓ 召回不污染草稿、流式中输入入队并在流结束后自动发送。

### 第 4 期：会话内引用 + 模型选择（[P]，估 2 天）
引用本会话历史消息 chips（contextMessageIds）；模型选择 popover（读 cap.config providers）。
**验收**：chips 引用的消息内容确实进入模型上下文；popover 切模型后下一次对话生效。

**后续可选**（需要契约，另立 spec）：cap.fs（文件引用/TCB 落盘）、cap.kv（历史落盘）、提示词优化完整版、@对话。

## 5. 明确不搬清单（X，含理由）

| 项 | 理由 |
|---|---|
| ChatStatusBar 全套 | 宿主引擎体系大耦合；lite 用轻量 popover 替代 |
| /nexus /agent /dispatch、@专家 | lite 无 agent 编排域 |
| CLI 三级目录 + cli_init + /clear 拦截 | claude-code 引擎特化 |
| 遗留 ContextChips 六型 | Polaris 侧死代码 |
| cap.ui.input banner / cap.self.mutate 插槽 | 需先在 lite 立前端 cap 消费端契约，ROI 低 |
| PendingBriefingCard（压缩交接） | 宿主 compact-handoff 域，lite 无此机制 |
| shims 依赖方式 | 与 lite SlotHostApi 约束冲突——搬行为不搬依赖 |

## 6. 风险与边界

1. **体量控制**：Polaris 输入区 4.3k 行的教训——建议系统占一半。lite 第 3 期实现时建议列表只做「单一分组、单一来源」起步，注册表留扩展位，防止 2k 行巨型组件在 lite 复现。
2. **两插件版本对齐**：附件字段（payload.attachments）是 chat-lite 与 real-engine 间的软契约，两插件需同版本发布；registry.json 无版本锁定，须在 CHANGELOG 注明。
3. **测试**：发送按钮状态机（stopButton.test）、promptHistory、附件校验三块在 Polaris 有单测，lite 实施时照搬测试思维（现 vitest 环境可用）。
4. **行为规格优先于 UI**：盘点第 12 节结论——「发送事务纪律」（历史提交事务、草稿防抖取消、失败回滚、流式防误清）是大量审计修复沉淀的规格，实施时必须逐条对齐，UI 样式反而不是重点。
