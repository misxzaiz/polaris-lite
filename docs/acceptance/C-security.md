# 验收报告 C（安全与权限越界）

> 验收对象：polaris-lite cap 总线权限模型、插件能力声明、审计链、事件广播与调试钩子。
> 结论速览：**8 项检查中 5 项存在发现（1 个 P0、3 个 P1、4 个 P2），3 项已检查通过**。权限 gate 的「默认拒绝」语义本身成立，但注册侧无管控、流式旁路、全量广播与调试钩子暴露构成系统性越权面。

---

## 1. CapBus.assertAllowed 是否真的默认拒绝？

**结论：已检查通过（gate 语义本身）。** 但「默认拒绝」只覆盖 dispatch 入口，不覆盖注册入口（见发现 C-1）。

证据（src/core/bus.ts:49-55）：

```ts
/** 权限 gate：插件声明的 capabilities 之外一律拒绝（默认拒绝） */
assertAllowed(pluginId: string, declared: string[] | undefined, target: string): void {
  const allowed = declared ?? [];
  if (!allowed.includes(target)) {
    throw new Error(`plugin ${pluginId} is not granted ${target}`);
  }
}
```

- `declared` 为 `undefined` 时回落到空数组，未声明任何 capabilities 的插件调用任何 target 都会抛错。mock-engine（manifest.capabilities=[]）即属此类，无法经 dispatch 调用任何 cap。
- `dispatch`（bus.ts:57-73）先 `assertAllowed` 再查 handler，顺序正确：未授权插件连「cap 是否存在」都探测不到（错误信息统一为 not granted / unknown cap，不泄露注册表内容）。

**未声明 capabilities 的插件能调用什么？** 什么都不行——经 `SlotHostApi.dispatch` 的所有调用都会被 `assertAllowed` 拒绝。但存在两条不经 gate 的路径：① `register`/`registerStreaming` 对所有持有 bus 引用者开放（见 C-1）；② 事件总线 `listen`/`emit` 完全无权限检查（见 C-5/C-8）。

---

## 2. dispatchStream 与 dispatch 的权限检查是否一致？流式调用有没有绕过 gate 的路径？

**结论：存在 1 个 P1 一致性缺陷 + 1 个 P0 旁路。**

### [P1] createApi 对流式能力的包装绕过了审计与取消语义，且同步应答恒为 ok

证据（src/core/hostRuntime.ts:39-50）：

```ts
dispatch: <T,>(req) => {
  if (runtime.bus.isStreaming(req.target)) {
    return new Promise((resolve) => {
      runtime.bus.dispatchStream(manifest.id, manifest.capabilities, req, () => undefined);
      // 流式调用的同步应答：立即返回 ok，结果经事件流送达
      resolve({ ok: true, data: undefined } as CapResponse<T>);
    });
  }
  return runtime.bus.dispatch(manifest.id, manifest.capabilities, req) as Promise<CapResponse<T>>;
},
```

影响：
- 权限检查本身一致（`dispatchStream` 内部同样先 `assertAllowed`，bus.ts:90），但**失败语义不一致**：非流式 dispatch 被拒时返回 `{ok:false, error}`；流式被拒时宿主仍先 `resolve({ok:true})`，拒绝只以 `stream.error` 事件形式送到一个**被立即丢弃的回调**（`onEvent` 传的是 `() => undefined`）。调用方（chat-lite 的 sendUserMessage）永远拿到 ok，无法感知 gate 拒绝。
- 事件经 `() => undefined` 空回调路径走 `pushStream`，真正到达 chat-lite 的事件是经 `host.broadcastStream` 的另一条链——即**同一次流式调用存在两条事件通路**，审计 entry 仍在，但 streamSubs 里的订阅者集合与实际消费者不一致，取消函数（返回值）被丢弃，无 unsubscribe。

### [P0] installMockChatCapability 由 main.tsx 直接把 cap.ai.chat 注册到总线，注册侧完全没有权限 gate

证据（src/main.tsx:24-34）：

```ts
// 3. 安装 mock 引擎的 cap.ai.chat 流式能力（真实部署时由引擎插件替换）。
installMockChatCapability({
  bus: {
    registerStreaming: (target, handler) =>
      host.bus.registerStreaming(target, async (req, _emit) => {
        await handler(req, (ev) => host.broadcastStream('chat-event', ev));
      }),
    register: (target, handler) => host.bus.register(target, handler),
  },
});
```

配合 mock-engine/index.ts:19（`capabilities: []`）与 mock-engine/index.ts:38（`host.bus.registerStreaming('cap.ai.chat', ...)`）。

影响：
- mock-engine 的 manifest 声明 `capabilities: []`，却通过 bootstrap 旁路拥有全站对话能力的**提供方**身份。gate 只约束「调用方」，对「注册方」无任何校验——任何拿到 bus 引用的代码都能注册任意 cap，包括冒充 `cap.meta`、`cap.session`（`register` 对重复注册才抛错，首次注册即成真）。
- **谁该为 cap.ai.chat 的注册负责？** 按插件化原则，能力注册应由**引擎插件自身在其 setup 生命周期内**、经受控的 host API 完成，且宿主应校验「manifest 声明了该 cap 的 provider 意图」才放行注册。当前 main.tsx 以「真实部署时由引擎插件替换」为理由代劳，把注册权从插件生命周期挪到了装配脚本，违反「插件不得越权」——不是 mock-engine 越权，而是**宿主为它开了特权通道**。建议：给 manifest 增加 `provides?: string[]`（或复用 capabilities 语义拆分 provide/consume），`registerPlugin` 时校验 `provides ⊆ 声明`，注册动作只允许发生在 `setup(api)` 内经 `api.registerCapability(target, handler)` 完成；main.tsx 退回只做 `registerPlugin`。

---

## 3. 插件间的隔离：chat-lite 能否调用 cap.meta？cap-panel 能否调用 cap.ai.chat？

**结论：均不能（已检查通过）**——按当前 gate 实现与 manifest 声明，跨能力调用会被拒绝。

- chat-lite 声明 `capabilities: ['cap.ai.chat', 'cap.session']`（plugins/chat-lite/index.ts:24）。它 dispatch `cap.meta` 时 `assertAllowed('chat-lite', ['cap.ai.chat','cap.session'], 'cap.meta')` 不命中 → 抛 `plugin chat-lite is not granted cap.meta`。
- cap-panel 声明 `capabilities: ['cap.meta']`（plugins/cap-panel/index.tsx:64）。它 dispatch `cap.ai.chat` 时同理被拒；即使 `cap.ai.chat.interrupt`（mock-engine 注册的非流式 cap，mock-engine/index.ts:76）不在其声明内，同样被拒。

附注（不改变结论）：隔离的前提是插件只通过 `createApi` 产出的 `SlotHostApi` 行事，而 `SlotHostApi` 并未暴露 bus 引用——这点成立。但 `__LITE_DEBUG__.host` 把宿主单例暴露到全局后，任何代码（包括插件模块）都可取 `host.bus` 引用直接 `dispatch` 时伪造 pluginId/declared，或直接 `register`。见 C-6。

---

## 4. host.broadcastStream 的 chat-event 全量广播是否越界？如何收口？

### [P1] chat-event 无差别广播给所有插件，任何插件可监听全部会话的流内容

证据：
- src/main.tsx:30 —— `host.broadcastStream('chat-event', ev)`，所有 delta（含用户 prompt 衍生内容）进公共事件总线；
- src/core/hostRuntime.ts:91-93 —— `broadcastStream` 对该事件名的**所有**订阅者全量转发，无来源/会话过滤；
- src/core/hostRuntime.ts:51-55 —— `listen(event, handler)` 无任何权限检查，任意插件可 `api.listen('chat-event', ...)` 拿到所有会话的增量内容。

chat-lite 虽在消费侧做了 `ev.sessionId !== sessionId` 过滤（plugins/chat-lite/index.ts:80），但那是**消费者自律**，不是总线强制——恶意/无关插件只需不写这个 if，即可旁听全部会话流。

**收口建议（按订阅者声明过滤）**：
1. manifest 增加事件订阅声明，如 `events?: { subscribe?: string[] }`（或复用 capabilities：`cap.event.chat-event`）；
2. `createApi` 的 `listen` 先 `assertAllowed(manifest.id, manifest.capabilities, 'cap.event.' + event)` 再挂订阅；
3. `broadcastStream(event, payload, meta)` 携带 `{sourcePluginId, sessionId}` 元数据，总线按「订阅者声明 + 会话归属」二次过滤；
4. 流式事件优先走 bus.ts 自己的 `streamSubs`（按 streamKey 隔离，bus.ts:83、110-113），而不是拆到宿主公共事件总线——现状里 `dispatchStream` 的定向通道和 `chat-event` 广播通道并存，本身就是收口机会。

---

## 5. window.__LITE_DEBUG__ 调试钩子，生产构建是否应移除？

### [P2] __LITE_DEBUG__ 暴露 host 单例与 sendUserMessage，且进入了生产 bundle

证据：
- src/main.tsx:43-47 —— `(window as ...).__LITE_DEBUG__ = { host, sendUserMessage };`，注释自述「调试钩子（冒烟用）」；
- 构建产物实测：dist/assets/index-DJ0wJAkh.js 中 `__LITE_DEBUG__` 出现 1 次，**生产构建未移除**（vite.config.ts 未配置 define/terser/drop，package.json build 即 `tsc --noEmit && vite build`）。

影响：`host` 是 HostRuntime 单例，持有 `bus`（可 register 任意 cap、篡改审计读取）、`slots`、`listeners`、全部插件 manifest。任何注入脚本/浏览器扩展/被 xss 的依赖都可通过 `window.__LITE_DEBUG__.host.bus` 绕过全部 gate（注册假 cap、以任意 pluginId+declared 调 dispatch、清空审计——audit 数组虽是 private，但可通过 `tailAudit` 之外…… 注：tailAudit 只读，但 bus 引用本身足以注册/调用任意能力）。

建议：用 `import.meta.env.DEV` 包裹；或抽 `installDebugHook()` 并在 `vite.config.ts` 配置生产替换为空实现；至少 `if (import.meta.env.PROD) return`。

---

## 6. 审计：500 条上限 + cap-panel 每 2s 轮询 describe，是否可被噪音淹没？entry 信息是否足够？

### [P2] 轮询自身污染审计流；审计条目缺 pluginId 展示与请求载荷，定位能力不足

证据：
- src/core/bus.ts:22 —— `audit: { time; target; action; ok }[]`，>500 shift（bus.ts:118）；
- src/core/bus.ts:116 —— `auditEntry` **实际写入了 pluginId**：`{ time, target, req.action, ok: false, pluginId }`，但 TypeScript 类型注解（bus.ts:22）未声明该字段；
- plugins/cap-panel/index.tsx:29 —— `setInterval(refresh, 2000)`，每 2s 一次 `cap.meta/describe`，每次都会 `auditEntry` 入链（metaCapability 的 handler 无任何豁免）。

影响：
- cap-panel 自己每 2s 产生 1 条审计，挂机 16.7 分钟即可单独填满 500 条窗口，把真实调用（含 deny 记录）挤出环形缓冲。轮询面板恰好是审计的最大制造者，形成「观测行为摧毁观测数据」的自反问题。
- 展示层丢信息：cap-panel 的 audit state 类型（index.tsx:12、19）不含 pluginId，渲染也只有 `{a.target} · {a.action}`（index.tsx:51）——即使总线记了 pluginId，面板上看不到是谁发起的。
- 无请求载荷/错误详情：deny 时无法区分「未声明」与「cap 不存在」，ok 时无法回溯 payload（审计不可作为追责依据）。

建议：
1. `describe` 这类只读自省动作不入审计链，或审计分「管理面/数据面」两级缓冲（对齐 Polaris 的 `should_audit_dispatch_ok` 思路）；
2. 类型补 `pluginId` 字段并在 cap-panel 渲染；entry 增加 `error?: string`、`reqId`，payload 可选脱敏摘要；
3. cap-panel 改推送/长轮询，或轮询间隔退避 + 仅在窗口聚焦时轮询。

---

## 7. SlotHostApi.listen/emit 无命名空间，插件可监听/发射任意事件名，是否需要收敛？

### [P2] listen/emit 无命名空间、无声明校验，构成跨插件伪造事件通道

证据（src/core/hostRuntime.ts:51-58）：

```ts
listen: (event, handler) => {
  if (!runtime.listeners.has(event)) runtime.listeners.set(event, new Set());
  runtime.listeners.get(event)!.add(handler);
  return () => runtime.listeners.get(event)?.delete(handler);
},
emit: (event, payload) => {
  runtime.listeners.get(event)?.forEach((fn) => fn(payload));
},
```

影响：
- 任何插件可监听任意事件名（如 'chat-event' 旁听，见 C-4），也可 `emit('chat-event', 伪造 {kind:'message.delta', sessionId, delta})` **向 chat-lite 注入伪造的 AI 回复内容**——chat-lite 对事件无来源校验（index.tsx:72-95 直接消费 payload），这是一个完整的欺骗链。
- emit 也不做来源标注，接收方无法区分事件来自哪个插件。

建议：与 C-4 合并治理——事件名加插件命名空间（`plugin:<id>:<event>`）或声明式 `events.emit/subscribe` 清单并在 createApi 处 assertAllowed；`emit` 自动附加 `source: manifest.id`，接收方可校验。

---

## 8. 其余已检查项

- **auditEntry 落 ok 前的默认 false**（bus.ts:116 `ok: false` + dispatch 成功后置 true，bus.ts:64/97）：已检查通过，deny/error 均会留下 ok=false 记录，审计方向正确。
- **register 重复注册防护**（bus.ts:27、32 抛 `already registered`）：已检查通过，可防意外覆盖既有 cap（但挡不住首次恶意注册，见 C-1）。
- **streamKey 按 pluginId+target+action 隔离订阅**（bus.ts:127-129）：已检查通过，定向流通道内不同插件/动作互不串扰（前提是事件不旁路到广播，见 C-4）。
- **幂等注册插件**（hostRuntime.ts:20 `if (this.plugins.has(id)) return`）：已检查通过，防重复 setup。

---

## 发现汇总

| 编号 | 级别 | 标题 | 位置 |
|---|---|---|---|
| C-1 | P0 | 能力注册无权限 gate，main.tsx 越过插件 manifest 直接注册 cap.ai.chat | src/main.tsx:24-34; src/core/bus.ts:26-34; plugins/mock-engine/index.ts:19,38 |
| C-2 | P1 | createApi 流式包装：拒绝被吞、恒返回 ok、事件双通路、取消函数被丢弃 | src/core/hostRuntime.ts:39-50 |
| C-3 | P1 | chat-event 全量广播，任意插件可旁听所有会话流内容 | src/main.tsx:30; src/core/hostRuntime.ts:51-58,91-93 |
| C-4 | P2 | __LITE_DEBUG__ 暴露 host 单例且未从生产构建移除 | src/main.tsx:43-47; dist/assets/index-DJ0wJAkh.js |
| C-5 | P2 | 审计可被 cap-panel 2s 轮询淹没；entry 缺 pluginId 展示与载荷定位 | src/core/bus.ts:22,115-120; plugins/cap-panel/index.tsx:29 |
| C-6 | P2 | listen/emit 无命名空间与来源校验，可伪造 chat-event 注入会话内容 | src/core/hostRuntime.ts:51-58; plugins/chat-lite/index.ts:72-95 |

**优先修复顺序**：C-1（注册侧 gate + provides 声明）→ C-3/C-6（事件总线收口）→ C-2（流式拒绝语义统一）→ C-4（调试钩子）→ C-5（审计治理）。

## 修复建议最小集（不改架构）

1. `CapBus.register/registerStreaming` 增加 `ownerPluginId` 参数，由 HostRuntime 在 `createApi` 暴露受控的 `api.registerCapability`，并在注册时校验 `manifest.capabilities`（或新增 `provides`）包含该 target；
2. main.tsx 删除 installMockChatCapability 直连，改为 mock-engine 在 `setup(api)` 内自注册，bootstrap 只 `registerPlugin`；
3. `createApi.listen` 增加 `assertAllowed`（事件名映射为 `cap.event.<name>` 或独立 events 声明）；`emit` 附带 `source: manifest.id`；
4. `__LITE_DEBUG__` 用 `import.meta.env.DEV` 门控；
5. 审计 entry 类型补 `pluginId`，`cap.meta/describe` 不入审计；cap-panel 展示 pluginId 并降低轮询频率。
