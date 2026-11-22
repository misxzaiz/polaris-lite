# transcript-share v3 分析：输入区入口 + 细节增强 + 双分享形式（仅分析，未实施）

> 日期：2026-11-21 · 依据 needs #069 v2 交付后的用户反馈
> 用户诉求：①分享入口放到输入框下方「目录」chip 附近（右侧 panel 再选会话太麻烦）②能加入更多分析细节③分享形式可选：个人看的 md / 给 AI 分析引擎问题用的④找最佳方案（本文档）
> 方法：两个并行探索代理（输入区机制盘点 + 细节数据源盘点）+ 交叉综合。**本文档仅分析，不含代码改动。**

---

## 一、入口：把分享放进输入行（「目录」chip 旁）

### 1.1 现状事实

- 用户说的"目录"= `ChatInput.tsx:617-630` 的 `chat-ws-btn`（工作目录 chip：FolderIcon + 「默认目录」/目录名 + 关联数），位于按钮行 `.chat-input-btns`（附件 → 调谐 → **目录 chip** → 提示文案 → 新会话 → ContextMeter → 发送）。
- chat-lite 经 manifest 把 `ChatInput` 贡献给宿主 `input` 槽（`plugins/chat-lite/index.ts:104`），**全仓唯一占有者**；`SlotOutlet` 对非 panel 槽多贡献者是顺序堆叠渲染（无 tab），且 `.shell-input` 有 `max-height:42dvh + overflow:hidden`（styles.css:250-263）——往 input 槽塞第二个常驻组件会挤压输入条，浮层必须走 portal（chat-lite 工作目录浮层/ContextMeter 抽屉已是先例）。
- **当前会话 id 的通道现状**：chat-lite 是 activeId 唯一持有者（`store.ts:314 setActive` 静默，无 session-changed 事件）；唯一对外 emit 是 `user.prompt`（仅发送时带 sessionId）；无 localStorage/全局变量暴露。transcript-share 面板现在只能让用户手动选会话——这就是痛点根源。
- 分享服务端已齐备：`cap.tool.transcript` share 动作 + `/api/share/create` 按 sessionId 工作，缺的只是入口与"当前会话"。

### 1.2 三条路径与取舍

| 路径 | 机制 | 改动面 | 风险 |
|---|---|---|---|
| **A. chat-lite 按钮行加分享按钮（推荐）** | `ChatInput.tsx` 按钮行 ws-btn 旁加 ShareIcon；点击用 `store.activeId` 直接 `api.dispatch({target:'cap.tool.transcript', action:'share'})`；结果用 ContextMeter 同款 portal 浮层展示（链接+复制+形式选择） | chat-lite：按钮组件 + capabilities 加 `cap.tool.transcript`（manifest + grants 4 行）；transcript-share **零改动**（handler 已按 sessionId 工作）；浮层样式复用 chat-input.css 体系 | chat-lite→transcript-share 静态耦合（可先 `cap.meta list` 探测可用性，插件未启用则隐藏按钮——detectLoop 先例 index.ts:246-258）；新会话 800ms 防抖内立即分享可能 404（提示重试或先 flush） |
| B. 新增 `active-session-changed` 事件 | chat-lite 在 setActive/createSession emit；transcript-share 面板自动选中 + 可贡献 input 槽小组件 | 4 处声明（两插件 manifest.events + grants）+ 初始快照问题；input 槽堆叠有布局风险 | 改动面最大；时序坑（装配顺序、启动未切换会话） |
| C. window 桥 `__CHAT_LITE_ACTIVE__` getter | 1 行 getter + panel 预选 | 最小 | 绕过 fail-closed 治理（real-engine 注释自认的例外通道）；不解决入口位置 |

### 1.3 推荐组合

- **短期（v3 主目标）：路径 A**。入口即用户诉求位置、数据链最短（activeId 在手）、服务端零改动。按钮旁不做常驻面板，点击弹 portal 浮层（与目录浮层同形态），浮层内完成"选形式 + 选有效期 → 生成 → 复制/下载"。
- **长期（第二个插件需要当前会话时）：路径 B 收口**成正式事件，淘汰 window getter。现在不做（YAGNI + 改动面）。
- 路径 C 仅作 A 落地前的临时验证手段，不保留。

### 1.4 入口交互设计（v3 浮层）

```
[分享icon] 点击 → portal 浮层：
  形式：（● 个人阅读版 md）（○ AI 分析版）   ← 见第三节
  有效期：1h / 24h / 7d / 30d（仅"复制链接"时需要）
  [复制链接] [下载 .md] [复制 AI 版]
  ↓ 已有分享列表（当前会话，可吊销）
```

- 「复制链接」= 现有网页分享（token+有效期+live）。
- 「下载 .md / 复制 AI 版」= **本地导出，不创建分享链接**（新端点 `/api/share/export/:sessionId?format=human|ai`，会话门禁）——很多人要的不是分享出去，而是拿到文件。

---

## 二、可补充的分析细节（按价值/成本排序 Top 5）

### 关键发现（白捡的管道）

**agent-loop 已经把全部编排事件（message.*/tool.*/loop.done/stream.error）每 250ms/64 条批量 POST 到 `/api/chat/sessions/:id/live-event`，服务端只扇出给 SSE、不落盘**（chat-store/server.mjs:333-353 注释"只透传不落盘"）。给这条管道加一个"非 delta 类 kind 追加落盘"，就能白捡完整编排时间线——零客户端改动。

另外两个已确认的数据丢失点：
- **非 bash 工具的完整入参被丢弃**：agent-loop 的 `tool.card` 事件带 `argsJson`（完整参数），但 chat-lite 落卡只存 `command = parsed.command ?? argsJson`，而非 bash 工具 command 为空串（`??` 不回退空串）→ 模型原始 arguments 在持久层丢失，现在只能从 apiCalls 的 sse.toolCalls[].args（cap 2000）间接找回且没和工具卡对齐。
- **上下文压缩摘要全文未落盘**：`context.compacted` 的 summary/tokensBefore/tokensAfter 只变成一行标记文本，压掉了什么无从知晓——这是"AI 遗忘/答非所问"类问题的第一证据。

### Top 5 补充清单

| # | 补充项 | 采哪 | 对 AI 分析引擎的价值 | 成本 |
|---|---|---|---|---|
| 1 | **编排事件时间线落盘**（tool.calls 含完整 arguments、stream.retry{attempt,chars}、tool.approval.resolved{decision,autoRejected}、loop.done{turns}、message.continued{reason}） | chat-store live-event 管道加非 delta 落盘（`<dataDir>/chat-store/events/<id>.jsonl`，护栏照抄 trace store） | 修复 args 丢失；重试/审批决策/跳数全部可见——引擎行为复盘的主证据链 | 低（服务端 ~40 行；注意 chat-store/server.mjs 有未提交 WIP，需小心合并） |
| 2 | **context.* 三件套**（压缩摘要全文 4KB 截断 + 水位快照 usedTokens/window/percent/compacted/exhausted + 熔断标记） | 同上管道（context.* 需加入 mirrorLive 白名单，agent-loop/index.ts:130） | "AI 遗忘/答非所问/重复问"的唯一证据；配合 apiCalls tokens 递增链可定位压缩时机 | 低-中（白名单放开 + 落盘过滤） |
| 3 | **TurnRecord 合并**（steps[]{逐跳 ms,finishReason,textLen}、approvalWaitedMs、turn 级 outcome/error、attachments 文件名、loopTurns） | ai-events IndexedDB `turns`（bySession 索引现成）→ transcript-share 新端点 `/api/share/turns`（或复用 trace 端点加 kind） | "哪一跳慢/卡审批/轮次静默中断"的唯一数据源（HTTP 粒度的 apiCalls 推不出跳序） | 中（IndexedDB 读 + 白名单合并 ~150 行） |
| 4 | **traceTap 补旁路字段**：响应头（x-ratelimit-*/retry-after，诊断 429/限流）、SSE 帧响应侧模型名（json.model）、SSE 中间 error 帧（UPSTREAM_DISCONNECTED 等）、estimated 推断（有帧无 usage） | traceTap.ts 拦截器（res.headers 一次 entries + collectSse 抓 error/model 帧） | "突然中断/变慢变贵"的直接证据；渲染层可免费推导缓存命中率与 tps | 极低（~30 行） |
| 5 | **interactive/artifact 卡渲染补全 + 超时回填**：MD/HTML 渲染 payload（选项）与 answer；交互卡超时路径补 emit answered（interactive-cards/index.ts:93-105），避免分享里永挂 awaiting | render.mjs ~40 行 + interactive-cards 一处 | 人类读者与只看 MD 的 AI 能看到"AI 问了什么、用户选了什么" | 低 |

**明确不采**（评估过、价值/成本不划算）：netTap 的 curl（reqBody 已覆盖且带 cookie 占位噪音）、/api/tool、/api/fs 请求取证（工具卡已覆盖）、upstream url（暴露供应商地址，半敏感）、system prompt 单独采集（reqBody 已含，改为渲染时拆列展示）。响应头 reqHeaders 价值低不采，resHeaders 采（归入 #4）。

### 渲染层免费改进（不新增采集）

- apiCalls 渲染拆列：从 reqBody 解出 `messages[0].content`（system prompt 单列）与 `tools[].function.name`（工具清单单列）——reqBody 是一大坨 JSON 的现状对 AI 与人都不友好（render.mjs:53-55）。
- 派生指标：缓存命中率（cached/prompt）、tps、每跳 tokens 增长、重试次数——全部可从现有 sse.usage 免费推导。

---

## 三、双分享形式：个人阅读版 vs AI 分析版

### 3.1 设计原则

- 两种形式服务两种读者，**同源同数据、不同投影**：个人版做减法（叙事可读），AI 版做加法（结构完整 + 分析任务书）。
- server 侧一个 formatter 层输出两种投影，入口浮层与 export 端点共用。

### 3.2 形式 1：个人阅读版（human.md）

目标读者：发微信/存档/给人看。**做减法**：

```markdown
# 标题（自动推导）
> 11-21 · 6 条消息 · 3 轮 · 4 次工具 · 22.7k tokens · 12s

## 对话
**用户** 18:07
帮我看看这个报错

**AI** 18:07
（正文）

  · 工具 bash `ls -la` ✓ 120ms          ← 工具卡一行式：名称/命令摘要/状态/耗时
  · 工具 files `read a.txt` ✓ 45ms

**AI** 18:08
（正文）

---
### 附：模型调用一览
| # | 时间 | 模型 | 耗时 | tokens | 结果 |
|---|---|---|---|---|---|
| 1 | 18:07 | nex-n2.6 | 2.1s | 4691→39 | stop |
| 2 | 18:08 | nex-n2.6 | 2.7s | 4900→57 | tool_calls |
```

- 思考块默认省略（或 `<details>` 折叠一行摘要）；无 JSON 代码块；SSE 帧不出现；请求体不出现。
- 失败/重试才展开一句话说明（"第 2 次请求重试 1 次（断流）"）。

### 3.3 形式 2：AI 分析版（engine-analysis）

目标读者：另一个 AI，任务是"检查对话问题、优化 AI 引擎"。**做加法 + 自带任务书**。载体建议 **JSON 为主**（schema 稳定、程序可断言；MD 版可后续加）：

```jsonc
{
  "schema": "plite-transcript-ai-v1",
  "analysisGuide": {                          // 分析任务书：告诉分析 AI 看什么
    "goal": "复盘本对话的引擎行为，定位工具选择/参数/重试/上下文/成本问题",
    "checklist": [
      "工具选择与参数是否合理（对照 tool.calls.arguments 与工具卡结果）",
      "是否存在循环重试/重复调用（stream.retry 与同参数重复调用）",
      "上下文管理：压缩时机是否合理、压缩摘要是否丢失关键信息（context.compacted.summary）",
      "成本与延迟异常（每跳 tokens 增长、缓存命中率、慢跳）",
      "失败与中断的根因（SSE error 帧、HTTP 状态、审批拒绝）"
    ],
    "knownLimits": ["reqBody 256KB 截断", "stdout 16KB 截断", "浏览器发起侧才有轨迹"]
  },
  "meta": { sessionId, title, createdAt, capturedAt, schema 版本 },
  "stats": {                                  // 派生指标（免费推导）
    totalTokens, cacheHitRate, tps均值, 跳数, 重试次数, 压缩次数, 审批次数与决策分布
  },
  "messages": [ ... 现有结构 ],
  "apiCalls": [ ... 全量（含 reqBody/sse） ],
  "events": [ ... 新增：编排事件时间线（Top1/Top2 落地后） ],
  "turns": [ ... 新增：逐跳 timing（Top3 落地后） ]
}
```

- **redaction 保持硬边界**（两形式都过 redactJson）；`knownLimits` 让分析 AI 知道数据截断边界，避免误判"没有发生"。
- 出口路由：`/api/share/export/:sessionId?format=human|ai`（会话门禁，本地导出）+ 分享 token 侧 `/share/:token/markdown?fmt=human`（或 ai.json 独立路径）——具体路由在实施时定，原则：**human 默认，AI 版显式选择**。

### 3.4 形式选择 UI

入口浮层（§1.4）单选形式；「复制链接」打开的分享页右上角也提供双格式下载按钮（human.md / ai.json）。

---

## 四、推荐实施切分（待拍板，本文档不含实施）

| 阶段 | 内容 | 改动面 | 说明 |
|---|---|---|---|
| **P1 入口 + 双形式** | 路径 A 按钮 + 浮层（形式/有效期选择）+ `/api/share/export` 端点 + render 拆 human/ai 两种投影 | chat-lite（按钮+capabilities 4 行）、transcript-share（export 端点 + formatter 层 + 浮层） | 用户感知最强，先做 |
| **P2 细节增强** | Top5 按 **4 → 1 → 3 → 2 → 5** 顺序（4 极低成本先行；1 需小心 chat-store WIP 文件；3 依赖 ai-events IndexedDB 读取） | traceTap ~30 行 / chat-store ~40 行 / transcript-share ~150 行 / interactive-cards 1 处 | 每项独立可交付 |
| **P3 通用化** | active-session-changed 事件收口（路径 B），淘汰临时手段 | 4 处声明 | 等第二个消费方出现再做 |

**风险与依赖**：
- chat-store/server.mjs 当前有未提交 WIP（他人改动），Top1/Top2 动它需要先协调合并。
- 非 bash 工具 argsJson 丢失是**数据面缺陷**，Top1 落地后自然修复（tool.calls 事件里有全文）；若等不及可单独小修 chat-lite 落卡回退逻辑（`command || argsJson`）——但那也是动 chat-lite。
- 路径 A 的 chat-lite→transcript-share dispatch 依赖：探测不可用即隐藏按钮，不阻塞 chat-lite 主流程。

---

## 五、实施记录（2026-11-21，P1+P2 全部落地，commit 01fbc50）

按本文档方案实施，全部完成：

- **P1**：chat-lite `ShareEntry.tsx`（按钮+portal 浮层：链接/个人版 md/AI 分析版/吊销）；`/api/share/export` 端点；render 双投影（`renderHumanMarkdown` / `buildAiAnalysis`，schema `plite-transcript-ai-v1` + `deriveStats`）；`/markdown` 改个人版、新增 `/ai`；网页工具栏三链接。**实施时简化**：入口按钮走同源 HTTP 而非 cap 总线 dispatch——chat-lite 无需 grants/manifest 改动，耦合面更小（方案 §1.2 路径 A 的加强版）。
- **P2**：#4 traceTap 补 resHeaders/响应侧模型名/error 帧/estimated；#1 live-event 镜像捕获（traceTap 拦 POST body，**chat-store 零改动**——比方案更优，绕开了 chat-store WIP 文件冲突）→ `/api/share/events` → events JSONL；#2 agent-loop mirrorLive 白名单放开 `context.*`；#3 `turnsBridge.ts` 读 ai-events IndexedDB（bySession 复合索引，60s 节流）→ `/api/share/turns`；#5 交互卡超时补 emit + interactive/artifact 渲染补全。
- **验证**：transcript-share 12/12、全仓 307/307；dev 5000 真实对话 E2E——events 捕获 `context.snapshot`（白名单放开生效）、turns 自动同步 2 条、human md 统计头（4 条消息 · 2 轮 · 10 次工具 · 53.3k tokens）、AI 版 stats 推导 cacheHitRate=0.788（真实 usage）；9825 已更新。
- **commit 纪律**：agent-loop/interactive-cards 为混合文件（用户 WIP + 我的 hunks），采用备份→重置→重放→提交→恢复流程，用户 WIP 完整保留在工作树未提交。

## 六、入口位置修正（commit 5315e15）

用户反馈：不要在输入框下新增独立按钮——放进**调谐抽屉**（展开后有工作目录/执行模式/待发队列的那个）里。

- `ShareEntry`（按钮+portal 浮层）→ `ShareDrawerRows`（抽屉内联行组），与工作目录/执行模式/待发队列同款 `chat-assistant-row` 行结构：
  - 「链接有效期」行（1h/24h/7d/30d chips）
  - 「网页链接」行（生成并复制 + 打开链接）
  - 「导出文件」行（个人版 .md / AI 分析版）
  - 「活动链接（N）」行（摘要+剩余时长+吊销，有链接时才出现）
  - 「状态」行（操作反馈，有消息时才出现）
- 数据链与授权面不变（同源 HTTP）；portal/定位/点空白关闭逻辑全部移除（抽屉内联展开，无裁剪问题）。
- 浏览器 E2E：抽屉六行齐全、生成链接/活动列表/吊销实测通过；9825 已更新。

## 七、分享前预览（commit 后续追加）

用户需求：分享前先看效果。实现：`/api/share/export` 新增 `format=html`——与正式分享页**同一渲染器**的会话门禁静态快照（`live:false`），**不创建 token、不落任何状态**（预览 N 次列表仍为空，测试断言保证）。ShareDrawer 抽屉新增「预览」行（"网页版效果"按钮，新开标签页）。原则：看到什么分享出去就是什么。

## 八、个人版「点开显示不对」修复（commit 后续追加）

根因：个人版按钮直接下载 .md 文件，点开是未渲染的 markdown 原文。修复：新增 `renderHumanHtml`（个人版投影的服务端直渲染 HTML，无 JS、暗色自适应）+ `format=human-html`；ShareDrawer「预览」行拆双 chip（个人版效果 / 网页完整版）；human-html 页面工具栏内含「下载 .md / AI 分析版」——**下载意图与预览意图分离**：想看效果点预览，要文件点下载。
