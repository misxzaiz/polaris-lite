# 上下文透视 + 自动压缩 + Token 速率（spec v0.1，2026-11-20）

> 目标：把「这轮对话还剩多少上下文、烧了多少 token、快满时自动压缩」做成 polaris-lite 的一等能力。
> 参照系：原 Polaris `simple_ai`（`ai/engine/simple_ai/compact.rs` / `chat_loop.rs`）已验证的机制语义，在 polaris-lite 的插件架构上以**纯前端 TS** 重新实现（lite 无 Rust 后端编排）。
> 边界：本 spec 只动 `plugins/`（real-engine / agent-loop / chat-lite）与 `public/grants.json`，**宿主 `src/` 零改动**（契约不变，事件仍走既有 `cap.ai.chat:event` / `cap.agent.loop:event` 通道）。

---

## 1. 需求

| # | 需求 | 来源 |
|---|---|---|
| R1 | 看当前上下文：会话级上下文水位（已用 token / 窗口 / 百分比）、压缩状态可见 | 用户 |
| R2 | 上下文自动压缩：逼近窗口上限时自动摘要压缩历史，不丢最近交互 | 用户 |
| R3 | 看 token 速率：本轮输出 tok/s、最近轮次耗时与用量 | 用户 |
| R4 | 结合 simple_ai 已验证语义（阈值触发、工具配对边界、滚动分段、失败回滚） | 对齐要求 |

## 2. 现状（调研结论）

- **用量缺失**：`real-engine` 解析 SSE 时丢弃了 `usage` 字段（OpenAI 兼容流末帧携带 `usage.prompt_tokens/completion_tokens`），前端完全没有 token 数据。
- **上下文未知**：agent-loop 的 shadow transcript 只在内存里，水位无处可见；chat-lite 只有可见文本历史。
- **无压缩**：长会话只会一路膨胀直到上游 400。
- simple_ai 的成熟语义（照搬指标，不照搬实现）：
  - 触发：`最近一轮 input_tokens ≥ window × 75%`；无 usage 时按字符 ÷4 估算兜底；
  - 压缩范围：`[1, len-keep_recent)`，按工具配对边界回退（不切断 assistant.tool_calls ↔ tool result）；
  - 区间 < 4 条消息跳过；压缩后仍超阈 → 熔断（本会话不再自动压，防死循环）；
  - 摘要请求：非流式、显式 max_tokens、超预算按 turn 边界滚动分段；
  - 失败：恢复原历史（非破坏），绝不丢消息。

## 3. 方案总览（数据流）

```
real-engine（SSE 末帧 usage）
   └─ 流结束时 emit cap.ai.chat:event { kind:'ai.usage', payload:{ sessionId, messageId,
        inputTokens, outputTokens, totalTokens, contextWindow?, model?, durationMs? } }
        ├─→ chat-lite：速率/水位展示（R3）
        └─→ agent-loop：UsageAccumulator.last_input 更新（水位真相源）

agent-loop（shadow transcript 持有者，压缩编排者）
   ├─ 每轮 engineTurn 前：shouldCompact(lastInput|estimate, window) ？
   ├─ 触发 → emit { kind:'context.compacting', payload:{ sessionId, messageId, range:{from,to} } }
   ├─ 非流式摘要请求（走 /api/model-relay，stream:false）
   ├─ 成功 → shadow 替换区间为 [compacted summary]；emit { kind:'context.compacted',
   │          payload:{ sessionId, messageId, summary, removedCount, before/afterTokens } }
   └─ 失败 → 回滚 shadow；emit { kind:'context.compact-failed', … }（下轮按字符估算再试）

chat-lite（纯展示 + 详情面板）
   ├─ 订阅 ai.usage / context.* 事件 → sessionStore 新增 ctx 元数据（不进持久化消息流）
   ├─ 输入区上方 ContextMeter 条：水位环/条 + tok/s + 状态徽标（正常/压缩中/已熔断）
   └─ 点击展开详情：窗口、用量分解（input/output/cache）、最近 N 轮速率、压缩历史
```

## 4. 契约（事件与字段）

### 4.1 `ai.usage`（real-engine → 总线；chat-lite / agent-loop 消费）

```ts
interface AiUsagePayload {
  sessionId: string;
  messageId: string;        // assistant 消息 id（agent-loop 直传模式 = assistantId）
  inputTokens: number;      // usage.prompt_tokens（≈ 当前上下文大小，压缩触发基准）
  outputTokens: number;     // usage.completion_tokens
  totalTokens: number;      // usage.total_tokens（缺省时 input+output）
  durationMs: number;       // 本轮流式耗时（首字节→done），速率分母
  model?: string;           // 响应模型名（上游回显）
  contextWindow?: number;   // 模型能力表 maxInputTokens>0 时携带
}
```

- 事件名：挂在既有 `cap.ai.chat:event` 流通道内，`kind: 'ai.usage'`——**不新增事件名**，grants 无需扩列（消费方已授权这两个通道）。
- 无 usage 的供应商（流里始终没出现 usage）：real-engine 以 `估算 tokens = Σ消息字符÷4` 兜底发出，`estimated: true` 标记。

### 4.2 `context.compacting` / `context.compacted` / `context.compact-failed`（agent-loop → 总线）

```ts
interface CompactingPayload { sessionId: string; messageId: string; estimatedTokens: number; window: number; }
interface CompactedPayload {
  sessionId: string; messageId: string;
  summary: string;          // 摘要全文（UI 可展开查看）
  removedMessages: number;  // 被压掉的消息条数
  tokensBefore: number; tokensAfter: number;  // 估算口径
  at: number;               // 时间戳
}
interface CompactFailedPayload { sessionId: string; messageId: string; reason: string; }
```

- 同样走 `cap.agent.loop:event` 流通道（agent-loop 的 emit 本就经宿主镜像到此），**不新增事件名**。
- 压缩摘要本身也作为一条 text 块落进 assistant 消息流（复用 `appendAssistantBlock`），用户在对话里能看到「上下文已压缩（N 条 → 摘要）」卡片。

### 4.3 配置（会话级，chat-lite store 持有，dispatch 时带给 agent-loop）

```ts
interface ContextPolicy {
  autoCompact: boolean;     // 默认 true
  threshold: number;        // 0.75（窗口占比），0.5–0.95
  keepRecent: number;       // 6 条，最小 2
}
```

- 持久化在 `chat-lite.sessions.v1` 会话对象上（`ctxPolicy?` 字段，旧数据缺省 = 默认值）。
- UI 第一版只暴露「自动压缩开关 + 阈值滑条」，放在上下文详情面板内（不新开面板 tab）。

## 5. 实现拆解

### 5.1 real-engine（`plugins/real-engine/index.ts`）

1. `streamHandler` 内记录 `startedAt`；SSE 解析循环捕获 `json.usage`（最后一条非空 usage 为准，兼容 `stream_options.include_usage` 的末帧）。
2. 流正常结束（`message.done` 前）emit `ai.usage`：
   - `inputTokens = usage.prompt_tokens`；`outputTokens = usage.completion_tokens`；`totalTokens = usage.total_tokens ?? input+output`；
   - `contextWindow = activeCaps(provider)?.maxInputTokens > 0 ? … : undefined`；
   - `durationMs = Date.now() - startedAt`。
3. 上游不回 usage：按本次发送的 `messages` 估算（字符 ÷4，`estimated: true`）。
4. 中断路径（cancelled）不 emit usage（数据不完整，避免污染水位）。

### 5.2 agent-loop（`plugins/agent-loop/index.ts`）

1. **UsageAccumulator**（对齐 compact.rs 语义）：
   - `setup` 时 `api.listen('cap.ai.chat:event', ev => { if kind==='ai.usage' → acc.add(payload) })`（按 sessionId 分桶）；
   - `lastInput` 优先取真实 usage，否则 `estimateTokens(shadow)`。
2. **shouldCompact**：`!compactExhausted(session) && lastInput ≥ window × threshold`；`window = payload.contextWindow ?? 200_000`（real-engine 带来者优先，模型能力表其次，默认 200K 与 simple_ai 对齐）。`threshold/keepRecent` 从 chat-lite 透传的 `ctxPolicy` 读，缺省 0.75/6。
3. **compactShadow(sessionId, assistantId, emit)**（simple_ai 语义移植，纯 TS）：
   - `selectRange(shadow, keepRecent)`：`end = len - keepRecent`；保留区首条是孤儿 tool → 整组回退；区间尾是孤儿 assistant(tool_calls) → 回退；`end-1 < 4` → 跳过；
   - 序列化区间（tool 结果保头 60% / 尾 40%，各 ≤1000 字符；args ≤200 字符）；
   - 非流式摘要请求：POST `/api/model-relay`，`{ providerId, body:{ model, stream:false, messages:[{role:'system',content:COMPACT_INSTRUCTION},{role:'user',content:historyText}], max_tokens:2048 } }`——复用既有中继（key 在服务端），不新增端点；
   - 响应截断（finish=length 或 content 空但 reasoning 存在）→ max_tokens 4096 + 抑制思考指令重试一次；
   - 区间估算超 `window×0.5` → 按 turn 边界滚动分段（最多 12 段），逐段摘要合并（首段普通摘要，后续段带 `<existing_summary>` 合并）；
   - 成功：`shadow.splice(start, end-start, { role:'user', content:'[compacted summary]\n'+summary })`；emit `context.compacted`；
   - 失败：shadow 回滚（替换前先留快照），emit `context.compact-failed`；
   - 压缩后 `resetLast()`；若下一轮真实 usage 仍超阈 → `compactExhausted=true` 熔断（会话级，直到新会话）。
4. **触发时机**：主循环每轮 `engineTurn` 之前检查（与 simple_ai chat_loop 相同位置——先压缩再请求，摘要请求自身不进 shadow）。
5. **上下文可见性**：每轮结束后 emit `context.snapshot`（估算水位），payload：
   ```ts
   { sessionId, messageId, usedTokens, window, percent, messages: shadow.length, compacted: boolean }
   ```
   —— chat-lite 的 ContextMeter 直接消费（无 usage 供应商也有估算值可显示）。

### 5.3 chat-lite（`plugins/chat-lite/`）——v2 改造（2026-11-20 用户反馈）

> v1 的全宽状态条占掉输入区一整行（用户反馈「占用空间过多」）；窗口分母也不跟随
> 供应商「输入 tokens」配置（用户改 1m 不生效）。两项均已在 v2 修复。

1. **store**：新增非持久化字段 `ctx: Record<sessionId, CtxState>`：
   ```ts
   interface CtxState {
     usedTokens?: number; window?: number; percent?: number;
     lastUsage?: AiUsagePayload;            // 最近一轮（速率展示）
     rateTps?: number;                      // outputTokens / durationMs*1000
     history: { at: number; inputTokens: number; outputTokens: number; tps: number; estimated?: boolean }[];
     compacting?: boolean; compacted?: CompactedPayload[]; compactFailed?: string;
     exhausted?: boolean;
   }
   ```
   action：`applyUsage(payload)`、`applySnapshot(payload)`、`applyCompacting/Compacted/Failed`。写路径单一（都由事件驱动），UI 只读。
2. **订阅**（`setup`）：`cap.ai.chat:event` 与 `cap.agent.loop:event` 里按 kind 分发到上述 action（会话 id 过滤同现有纪律）。
3. **ContextMeter v2 组件**（`ContextMeter.tsx` + `context.css`）：
   - 形态：**24px 进度圆圈**（SVG 环 + 环内百分比数字），嵌在输入区按钮行最左（放在下面，占位极小）；
     水位色阶同 v1（>阈值 warning、≥90% danger、正常 accent）；压缩中外圈旋转段提示；
     hover title 显示 `上下文 x% · used/window · tok/s`；
   - **点击圆圈 → 详情抽屉在上方展开**：portal 到 body（宿主 `.shell-input` overflow:hidden 会裁内联面板——
     与工作目录浮层同一条教训），absolute 定位贴住圆圈顶上方，透明点击幕 + ESC 关闭；
   - 详情抽屉：窗口/阈值、**窗口来源**（供应商输入 tokens / 默认 200k）、最近 8 轮用量与速率小表、
     压缩记录（时间、压掉条数、前后 token、摘要全文可折叠）、策略开关（自动压缩 on/off + 阈值滑条，写回 store 的 `ctxPolicy`）；
4. **发送链路**：`sendUserMessage` 的 dispatch payload 带上会话 `ctxPolicy`（agent-loop 读）。

### 5.3.1 上下文窗口适配（v2 新增）

分母（window）解析链，三级优先：
1. **真实 usage 携带**：real-engine `emitUsage` 从模型能力表 `capabilities.maxInputTokens` 取（>0 才携带）；
2. **agent-loop 首轮预解析**：会话无 ai.usage 时主动 `cap.model.admin/resolveActive` 读当前模型
   `maxInputTokens`（不再等流结束，供应商改 1m 立即生效）；每条 ai.usage 到达后以真实值覆盖；
3. **默认 200k**（与 simple_ai DEFAULT_CONTEXT_WINDOW 对齐）。

「输入 tokens」字段的解析（`plugins/model-admin/tokens.ts` + `server/provider-store.mjs` 双实现）：
- 宽松接受 `1m / 1M / 200k / 128000 / 1,000,000`；非法字面量归 0（=未知），**绝不剥后缀吞成错误值**；
- 根因修复：面板旧实现 `replace(/\D/g,'')` 把「1m」剥成「1」存成 1 个 token——服务端 normalize 同样只认
  `Number()`，等于第二道闸也放行；现两端统一走 `parseTokenCount`；
- 显示统一走 `formatTokenCount`（1M / 200k / 65.5k），能力徽标与悬浮提示同源。

### 5.4 grants / 构建

- **不新增事件名、不新增 cap**：全部复用 `cap.ai.chat:event` / `cap.agent.loop:event`，`public/grants.json` 零改动（消费方 chat-lite、ai-events 已有这两条授权）。
- `check:plugins` 静态校验天然通过（manifest 不变）。
- CSS 遵守插件门禁：只用 `var(--*)` token、不碰 `:root/html/body/#root/.shell-*/.slot-*`、不 `position:fixed`（详情抽屉用 absolute，参照 WorkspacePicker）。

## 6. 验收

| # | 断言 |
|---|---|
| A1 | 真实供应商流结束后，ContextMeter 显示本轮 input/output tok、tok/s，数值与上游 usage 一致 |
| A2 | 无 usage 供应商：显示估算值且带「估算」标记，不报错 |
| A3 | 造长会话（或调低 threshold 至 0.01）触发自动压缩：对话流出现压缩卡片，shadow 区间被摘要替换，下一轮请求 messages 变短 |
| A4 | 压缩不切断工具配对：压缩后 shadow 里不存在孤儿 tool / 孤儿 assistant(tool_calls) |
| A5 | 摘要请求失败：历史完整保留，UI 显示压缩失败原因，下轮可重试；连续无效后熔断不再空转 |
| A6 | 刷新页面：会话消息不丢；ctx 元数据允许丢失（重新首轮流后恢复） |
| A7 | `npm run typecheck`、`npm run check:plugins`、`npm test` 全绿；`npm run build:plugins` 产物非空 |
| A8 | 宿主 `src/` diff 为空（核心零改动） |

## 7. 风险与取舍

- **纯前端压缩 vs simple_ai 的 Rust 检查点**：lite 无服务端归档目录约定，压缩检查点（压缩前原始历史）第一版只写 `sessionStorage`（会话级、关页即弃），明确不支持「回查压缩前原文」——这是 lite 形态的取舍，不伪装成功能。
- **多轮工具会话的 shadow 与可见历史偏差**：shadow 含 tool 消息，可见流只有文本/卡片。水位以 shadow 估算为准（真实），ContextMeter 文案标注「含工具上下文」。
- **速率口径**：tok/s = 本轮 outputTokens / 流式耗时；流式耗时从引擎 emit 首个 delta 起算会偏小，这里用「请求发出→message.done」全程，与用户体感一致（simple_ai 亦无更细口径）。
- **熔断后**：不静默——ContextMeter 显示「自动压缩已熔断（压缩无效）」，用户可手动新建会话或关闭自动压缩。
