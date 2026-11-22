# 模型能力自动识别 + 输出越界闭环 实施方案

## Context

polaris-lite 的 agent 体验有两个实测确认的痛点：①能力表靠手填（生产仅 1 个模型手工填了 4 个字段），且内置表过期（glm-4 4096）、聚合别名不识别；②`finish_reason='length'` 截断后只落提示等用户手发「继续」，半截 tool_calls 被静默丢弃。已用生产供应商（MOSI/nex-n2.6，只读）实测验证了每个识别信号：error-reveal 测输出上限（60ms 拿到 131072）、models.dev 后缀匹配命中聚合别名、tools/vision 实测可用、思考吃预算实锤、effort 参数不被遵守而 `thinking.budget_tokens` 是真旋钮、prefill 续写与 `stream_options.include_usage` 均可用。本方案把验证过的信号落成功能，全部插件侧、宿主零改动。

用户已确认：识别**全自动**（单模型预算 ≤120 token 封顶）；effort 行为差分探针**本轮做、按钮触发**。

## A. 能力自动识别

### A1. 服务端探针扩展 — `server/providers-api.mjs`（probe 路由 175-202 重构）

每模型新增探针（全部实测过）：
- **outputLimit（输出上限，权威）**：发 `max_tokens: 999999999` + "hi" → 400 且消息匹配 `/between 1 and (\d+)/i`、`/at most (\d+)/i`、`/limit\D*(\d{3,})/i` → 记 revealed 值；200 → 记 'lenient'（宽松网关，用目录值）。严格网关零成本，宽松网关几个 token。
- **tools**：极小 `get_weather` function + `tool_choice:'required'`（400 退 'auto'）→ 2xx 且回 tool_calls = true；报错含 tool/function = false；其余 null。
- **thinkingBasics**：`max_tokens:64` + 引思考 prompt → `reasoning_tokens` 占满且 content 空 → `reasoningEatsBudget:true`；`thinking:{type:'disabled'}` → 400 → `canDisable:false`。
- **vision/effort**：vision 保留现有探针；effort 仅记 accepted（不再声称"支持 low"）。
- **deep 差分（`deep:true` 才跑，按钮触发）**：effort `[low,high] × 2 reps × ≤2000 token` 比 reasoning_tokens 中位数（high > low×1.5 → honored:true）+ `budget_tokens` 128/4096 各 1 次验证 knob。约 8k token/模型。
- 模型间并发 3（现为串行）；超时沿用 PROBE_TIMEOUT_MS。

ProbeFacts 契约扩展：`probes[id] = { vision, effort, outputLimit, tools, thinking: { eatsBudget, canDisable, honored?, knob? } }`。

### A2. models.dev 目录合并 — 新增 `plugins/model-admin/catalog.mjs`（或 server 侧小模块）

- 服务端拉 `https://models.dev/api.json`，缓存 `dataDir/modelsdev-cache.json`（TTL 7 天，拉取失败离线降级）。
- 匹配：exact id → **后缀匹配**（`mid.split('/').pop()`，实测 `nex-agi/nex-n2.6` 命中）→ 取 `limit.context/limit.output、tool_call、reasoning、modalities、reasoning_options`。
- 合并顺序（`plugins/model-admin/detect.ts` mergeCaps 扩展）：**manual 不动 > reveal > probe > catalog > builtin**。目录值只作初值（实测目录限值输出/输入两个方向都会错）。

### A3. 能力表 schema — `plugins/model-admin/index.ts` ModelCapabilities（20-31）

新增 `tools?: boolean|null; canDisableThinking?: boolean|null; reasoningEatsBudget?: boolean|null; detectedAt?: number`；effort 仅在 deep 差分 honored 时写入。

### A4. 自动触发 — `plugins/model-admin/index.ts` save case（105-111）

save 成功后 fire-and-forget 跑浅层 probe（免费层 + 基础探针，≤120 token/模型），结果整包 `/api/providers/save` 写回（沿用现 probe handler 147-149 的写回路径）+ `broadcastChange`（real-engine:726 监听自动刷新）。probe handler 重构为 `runProbe(config, {deep})` 供手动/自动共用。

### A5. Panel — `plugins/model-admin/Panel.tsx`

capBadges（187-196、337-346）加 tools/思考徽章；chip 行显示 `detectedAt`（"上次识别 x 前"）；「更多」菜单加「深度识别」（deep:true）；报告区展示 reveal 上限与差分结论。

## B. 输出越界闭环（核心）

### B1. real-engine — `plugins/real-engine/index.ts`

- 请求组装（534-545）：加 `stream_options:{include_usage:true}`（中继 `server/relay-core.mjs:80` 原样转发已确认）；若 400 且错误含 stream_options → 去掉重试一次（方言守卫，内存记忆）。
- **max_tokens 兜底**：`caps.maxOutputTokens<=0` 时发 8192，不再裸奔（严格网关拒 → 进自愈）。
- **400 自愈**：`!resp.ok`（547-557）且消息匹配限值正则 → 解析上限 → dispatch `cap.model.admin` 新 action `noteProbe`（写回 maxOutputTokens，detected='probe'）→ 修正值重试一次。
- **半截工具调用上报**：`!broke` 分支（633-644）`finishReason==='length' && toolAcc.size>0` → `message.done` payload 加 `partialToolCalls: n`（聚合结果照旧不作为 tool.calls 发出）。

### B2. agent-loop — `plugins/agent-loop/index.ts`

- engineTurn resolve 类型（340/369）加 `partialToolCalls`。
- 主循环收尾（686-698）重构：`finishReason==='length'` 进续写分支，burst 计数 `MAX_AUTO_CONTINUE=3`（per assistantId）：
  - `partialToolCalls>0` → push 合成 user nudge「（系统：工具参数被单次输出上限截断，未执行；请重新调用，参数过长请精简或分批。）」→ continue；
  - text 空（思考吃光预算，`reasoningEatsBudget` 模型常见）→ push nudge「（系统：思考耗尽单次预算未产出正文，请直接给结论减少铺垫。）」→ continue；
  - 有半截正文 → prefill 续写（shadow 尾已是 assistant，MOSI 实测支持）直接下一轮 → continue；
  - 每次 emit `message.continued {attempt, reason}`；burst 耗尽 → 现有 `message.truncated` + break。

### B3. chat-lite 兜底 UX

- `plugins/chat-lite/store.ts:59-64` 块类型加 `truncated`；`plugins/chat-lite/index.ts:580-586` 改落 truncated 块；`plugins/chat-lite/BlockGroup.tsx` 渲染「继续」按钮 → dispatch `cap.agent.loop` 新 action `resume`（照 resolveApproval 模式，chat-lite/index.ts:688-696）→ agent-loop handler 校验会话空闲后从 shadow 现状续开同一 assistantId。
- `message.continued` → 渲染小字提示「[已自动续写 N/3]」（text 块，不打断流式渲染）。

### B4. 被动校准

- 400 且消息含 context/input limit → 解析 → `noteProbe` 写回 `maxInputTokens`（压缩窗口修正）。输出侧 length 观测**不回写**（观测值是 floor 不是 max，防止把上限写死）。

## 测试与验证

- `tests/cap-detect.test.mjs`（纯函数直跑，照 context-compact.test.mjs 模板）：mergeModelCaps 新 ProbeFacts 合并顺序（manual 保护、reveal>catalog）。
- `tests/providers-probe.test.mjs`（回环 mock 上游 + `policyOptions:{allowPrivate:true}`，照 server.test.mjs 282-333 模板）：mock `/models` 与 chat/completions 各应答（400 限值文案/200 tool_calls/64-token 思考占满/bogus 400），断言 probe 输出与写回。
- `tests/auto-continue.test.mjs`（源码契约断言，照 stream-retry.test.mjs 模板）：burst 上限、nudge 文案、partialToolCalls 两端契约、include_usage、400 自愈重试。
- 三个新文件追加进 `package.json` scripts.test 显式列表。
- **冒烟（dev 5000，root/1234，生产只读不动）**：dev 播种 nex-n2.6 → 保存后自动识别应得出 outputLimit≈131072、tools=true、vision=true、eatsBudget=true、canDisable=false（与实测一致）→ 长输出触发 length → 自动续写 ≤3 次 → burst 耗尽后「继续」按钮兜底。
- 验收门：`npm run typecheck && npm test && npm run build:plugins`。

## 实施顺序

A1 探针 → A2 目录合并 → A3/A4 schema+自动触发 → A5 Panel → B1 real-engine → B2 agent-loop → B3 chat-lite → B4 被动校准 → 测试 → 冒烟。每步独立可验证，A 完成即消除截断主因，B 完成后"手动继续"退役为按钮兜底。