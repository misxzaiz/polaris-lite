# AI 引擎契约（ai-engine）v1

与 `plugin-contract.md` / `server-gateway-contract.md` 并列。本文描述**已实施**的机制。

## 1. 目标

1. 引擎即插件：新增引擎 = 新增插件 + 声明元数据 + 注册自己的 cap，宿主与消费方零改动。
2. 核心零业务：`src/core/` 与 `server/` 不认识任何具体引擎 id、厂商、模型或端点。
3. 形态差异留在引擎内部：适配应用供应商、自带目录与凭据、混合、其它协议（CLI/MCP/A2A）都走同一公共面。
4. 统一流事件协议：文本增量 / 思考 / 工具 / 用量 / 重试 / 完成 / 错误走同一种事件流（词汇表见 `plugins/engine-kit/vocabulary.ts`）。

## 2. 角色

- **引擎插件**：声明 `manifest.aiEngine`，注册 `cap.ai.chat.<engineId>` / `.interrupt`（可选 `.models`），自行适配厂商与协议。
- **核心协议设施**（`src/core/aiEngine.ts`）：注册唯一的 `cap.ai.chat`、`cap.ai.chat.interrupt` 与只读自省 `cap.ai.engine`；按 `payload.engineId` 把调用转发到 namespaced cap，把事件注入 `engineId` 后广播。它只认命名约定与元数据形状。
- **消费方**（chat-lite / agent-loop / voice-radio / starter-suggestions / translate 等）：只声明 `cap.ai.chat`，不认识具体引擎；会话设置 UI 从 `cap.ai.engine` 动态拉取引擎与模型目录。

## 3. Manifest 声明

```ts
aiEngine: {
  id: string;                 // 对应 cap.ai.chat.<id>
  displayName: string;
  kind?: 'chat' | 'agent';
  modelSource: 'app' | 'builtin' | 'hybrid' | 'none';
  models?: { id: string; label?: string }[];  // 静态目录；动态目录优先
  features?: {
    supportsTools?: boolean;  // true 时编排走服务端 agent-runner；false 走引擎直连
    slashSkills?: boolean;    // false 时不做 /slash 技能展开
  };
  default?: boolean;          // 未指定 engineId 时的默认引擎，至多一个
}
```

`features.supportsTools` 的分派语义（2026-11-26 后端编排化后）：

- `true` → chat-lite 发消息优先走服务端 agent-runner（断联续跑：执行在服务端，
  页面只订阅 SSE）；runner 拒发（并发满 / 引擎无服务端适配器 / 无可用模型）时
  回落引擎直连通道，由引擎给出用户可见错误。
- `false` → 直接走引擎直连（cap.ai.chat.<id>），不进服务端编排。

`modelSource` 决定 UI 控件：

| 取值 | 语义 | UI |
|---|---|---|
| `app` | 从应用供应商取 provider/model，key 不出后端 | 供应商 + 模型二级选择 |
| `builtin` | 引擎自带目录与凭据 | 引擎模型目录选择 |
| `hybrid` | 优先 app 的 provider/model，否则回落自带（直连/自带 key 归此类） | 供应商 + 模型，引擎内部处理回落 |
| `none` | 无模型概念 | 隐藏模型行 |

构建期（`plugins/build-plugins.mjs`）校验：id 唯一且合法、id 与 `provides` 的 namespaced cap 对应、`modelSource` 枚举合法、默认引擎至多一个。

## 4. Cap 契约

### 4.1 `cap.ai.chat`（流式，核心注册）

- `action: 'start'`，`payload` 至少含 `{ sessionId, messageId, prompt }`；可选 `engineId`、`option`（引擎自解释）、`providerId`/`modelId`（适配应用供应商的引擎用）、`history`、`attachments`、`messages`/`tools`。
- 未给 `engineId` → 使用 manifest 标 `default` 的引擎；没有默认值时用第一个注册引擎。
- 事件以 `cap.ai.chat:event` 广播，载荷保留引擎原始 `kind`/`payload`，并注入 `engineId`；`source` 由宿主按 `cap.ai.chat` 提供方注入，插件无法伪造。

### 4.2 `cap.ai.chat.interrupt`

- `payload: { sessionId, messageId?, engineId? }`。
- 指定 `engineId` → 只中断该引擎；缺省 → 扇出到所有已注册引擎（各引擎按自己的 running 表判定，无流即 `found=false`）。

### 4.3 `cap.ai.engine`（只读自省）

- `list` → `{ engines: AiEngineInfo[], defaultEngineId? }`
- `describe` / `models`（`payload.engineId`）→ 单个引擎信息 / 模型目录
- 引擎若提供 `cap.ai.chat.<id>.models`，其返回的 `{ available, models }` 覆盖 manifest 静态声明；例如 CLI 引擎的模型清单随版本动态变化。

## 5. 协议 / 传输

契约只约束**入站 payload + 出站事件流**，不约束引擎内部如何产生事件：

- `inproc`：直接实现 `StreamCapabilityHandler`（real / mock）。
- `server-proxy`：引擎前端壳 fetch 自己 server 半边的私有端点、解析 SSE、emit 同构事件（codebuddy CLI 的直连兜底通道）。
- `external`：未来 MCP/A2A/CLI Agent 可只写 server 半边 + 通用前端代理，协议不进总线。

SSE 读、重连、中断映射、usage 方言、tool_calls 聚合沉淀在 `engine-kit`，各引擎复用；消费方不得为某一家重写。

### 5.1 服务端引擎适配器（agent-runner 执行域）

`features.supportsTools: true` 的引擎还需在 server 半边注册**服务端适配器**，
供 agent-runner 的编排循环调用（与前端 `cap.ai.chat.<id>` 分派对称）：

```ts
registry.registerEngine({
  id: 'real' | 'codebuddy' | ...,
  kind: 'chat' | 'agent',
  default?: boolean,
  systemHint?: string,            // runner 追加进 system prompt 的引擎提示（可选）
  resolveModel(modelRef): { provider, activeModel } | null,
  contextWindow(model): number,
  runTurn({ model, messages, tools, signal, onDelta, onReasoning, onRetry })
    → { text, toolCalls, finishReason, partialToolCalls, usage, lastUsage },
  complete?({ model, system, user, maxTokens, signal })  // 压缩摘要用（chat 型）
});
```

- `kind: 'chat'`（real）：runner 驱动每一步工具循环，`runTurn` 只跑一轮模型调用，
  返回的 `toolCalls` 由 runner 审批/执行。
- `kind: 'agent'`（codebuddy）：引擎自带工具循环，`runTurn` 内部跑完整轮
  （spawn CLI 到收敛），返回的 `toolCalls` 带 `result` 字段（已在引擎内执行完），
  runner 直接采用不再审批/派发；runner 对 agent 型引擎不注入宿主工具表
  （工具语义由适配器的 `systemHint` 声明）。
- `modelRef.option`（自带目录引擎的模型）随 start payload 透传给 `resolveModel`。
- runner 零引擎知识：只按 `engineId` 查 `server/adapter-registry.mjs` 通用注册表；
  `server/` 宿主仍不认识任何具体引擎 id。

## 6. 会话模型

会话字段收敛为 `modelRef: { engineId?, providerId?, modelId?, option? }`（核心 `ChatSession` 契约）。`option` 是自带目录引擎的模型/变体，语义由引擎解释。引擎选择由此一个字段驱动，不再有专属字段。

## 7. 生命周期一致

前端清单 `plugins/plugin-list.mjs` 是 `enabled` 的唯一来源；`server-registry.mjs` 按同一份清单决定是否挂载 server 半边。前端禁用的插件，其服务端端点也必须不可用，避免绕过插件生命周期的暗通道。
