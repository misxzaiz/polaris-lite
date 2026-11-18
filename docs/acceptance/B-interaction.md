# 验收报告 B（交互与状态越界）

> 验收对象：polaris-lite 对话链路（plugins/chat-lite、plugins/mock-engine、src/core/sessionStore、src/core/bus、src/core/hostRuntime）。
> 验收标准：对话交互不得出现状态串扰、竞态、重复消费、中断误伤。
> 结论摘要：**8 项中 5 项存在问题（2 项 P0、3 项 P1），3 项已检查通过**。核心风险集中在：cap.ai.chat 的流式事件走「全宿主广播 + 按 sessionId 弱过滤」，同会话并发流必然串台；StrictMode 双挂载造成重复订阅；interrupt 只按 sessionId 取消，会误伤/漏停；message.done 与 stream.end 双路径触发 unbind 前的时序缝隙。

---

## 逐项发现

### 1. 连续快速发送两条消息：两个流式回复会串台

**[P0] 同会话并发两条流必然串台；跨会话仅靠 sessionId 弱过滤，且 messageId 完全未校验**

证据（plugins/chat-lite/index.ts:72-95）：

```ts
const off = api.listen('chat-event', (payload) => {
  const envelope = payload as { kind: string; payload?: Record<string, unknown> };
  const ev = { kind: envelope.kind, ...(envelope.payload ?? {}) };
  if (ev.sessionId && ev.sessionId !== sessionId) return;   // 只过滤 sessionId
  if (ev.kind === 'message.delta' && ev.delta) {
    ...
    s.updateMessage(sessionId!, assistantId, { content: (msg?.content ?? '') + ev.delta });
```

证据（src/core/hostRuntime.ts:91-93，全量广播）：

```ts
broadcastStream(event: string, payload: unknown): void {
  this.listeners.get(event)?.forEach((fn) => fn(payload));
}
```

影响分析：
- **同会话连发两条**（如经 `__LITE_DEBUG__.sendUserMessage` 连调两次，ChatInput 在流式时会禁发，但调试入口和未来其他入口不受限）：两次 `sendUserMessage` 各自 `api.listen('chat-event', ...)`，两条流的事件都带同一个 `sessionId`，监听器 A 收到流 B 的 `message.delta` 时 `ev.sessionId === sessionId` 通过过滤，却把 delta 追加到自己的 `assistantId` 上——**两个流式回复互相串字**。`messageId` 在事件里存在（mock-engine 有发），但 chat-lite 完全没有用它做匹配。
- **跨会话**：`if (ev.sessionId && ev.sessionId !== sessionId) return;` 这一行能挡住「携带 sessionId 且不同」的事件；但 mock-engine 的路径里 sessionId 恒有值，所以跨会话串台在当前 mock 下被侥幸挡住。一旦某个引擎事件漏带 sessionId（`ev.sessionId` 为 undefined，过滤条件为假、放行），所有会话的所有在途监听器都会消费这条事件。契约上 `sessionId` 是可选字段（types.ts 相关事件 payload 未强约束），属于脆弱依赖。
- 另外 `sendUserMessage` 里 `const userMsg.id = m-${Date.now().toString(36)}`、`assistantId = m-${(Date.now()+1).toString(36)}`（index.ts:47、54）：同毫秒内两次调用会产生相同 id（`Date.now()` 相同 → `+1` 后仍可能与另一对的 base 撞车，例：第一次调用 base=T，assistantId=T+1；第二次调用 base=T，user id=T，与第一次 assistantId 同为 `m-(T+1).toString(36)` 的概率取决于毫秒抖动；至少同一次事件循环内两次调用 user id 必撞 assistant 槽位场景）。更直接的场景：**同毫秒连发两条**，第二次的 userMsg.id 等于第一次的 assistantId → sessionStore 里两个消息同 key，React `key={m.id}` 重复、updateMessage 会同时命中两条。

建议修复：
1. 事件匹配至少加 `ev.messageId === assistantId`（引擎已在 payload 里带 messageId）。
2. `hostRuntime.broadcastStream` 或 listen 层提供「按 streamKey/调用维度」的定向投递，而不是全宿主广播后靠消费者自觉过滤。
3. 消息 id 改用 `crypto.randomUUID()` 或单调递增计数器，弃用 `Date.now()` 拼接。

---

### 2. StrictMode 双挂载：sendUserMessage/listen 是否重复订阅或双份流

**[P1] StrictMode 使 bootstrap 双跑、mock 引擎二次注册抛错被吞、chat-event 监听器集合依赖组件卸载清理——当前代码恰好无重复订阅，但依赖两个偶然条件**

证据（src/main.tsx:37-41）：`<StrictMode><SlotLayout /></StrictMode>`，而 `bootstrap()` 在模块顶层 `void bootstrap()` 执行——React 18 StrictMode 双挂载只影响组件挂载，不会重跑模块级 `bootstrap()`，所以插件注册与 `installMockChatCapability` 只执行一次。

但存在两个真实风险点：

a) **幂等保护是「静默 return」而非报错**（src/core/hostRuntime.ts:18-21 `if (this.plugins.has(id)) return;`；plugins/mock-engine/index.ts 经 main.tsx:26-34 二次 register 会直接 `throw new Error('cap cap.ai.chat already registered')`，bus.ts:27）。若未来把 bootstrap 挪进组件 effect（常见重构），StrictMode 双跑会让第二次 `installMockChatCapability` 抛异常，且该异常发生在 `void bootstrap()` 的 promise 链中，**无人 catch，控制台只出现 unhandled rejection，UI 表现为「引擎静默失联」**。

b) **listen 的订阅与清理链路**：`sendUserMessage` 的 `api.listen`（hostRuntime.ts:51-55）把 handler 放进 `runtime.listeners` 的 Set；`SlotOutlet`/`ChatInput` 渲染不订阅 chat-event，唯一订阅点是 `sendUserMessage` 调用时。StrictMode 双挂载不会重复调用 `sendUserMessage`（它在事件回调里，不在 effect 里），因此当前**无重复订阅、无双份流**。但 ChatInput→send 链路若日后被包进 effect（例如「自动重发草稿」类需求），双份流会立即出现，且 `sendUserMessage` 内部没有任何防重入/调用去重。

结论：**当前形态已检查通过（无重复订阅、无双份流）**，但上述两个偶然条件（bootstrap 不进 effect、sendUserMessage 不进 effect）是隐性前提，建议在 `installMockChatCapability`/`registerPlugin` 的重复注册路径改为「幂等 no-op + warn 日志」而非 throw，消除 StrictMode 化改造时的隐患。

---

### 3. interruptChat 与 mock-engine 的 running map：能停流，但复位语义有竞态

**[P1] interrupt 能让 mock-engine 停止后续 delta，但「停止按钮消失的时机」依赖引擎再 emit 一条 message.done；且 interrupt 与自然完成赛跑时会误清/漏清 running 项**

证据（plugins/chat-lite/index.ts:106-111）：

```ts
export function interruptChat(): void {
  const api = hostApi;
  const sessionId = useSessionStore.getState().activeId;
  if (!api || !sessionId) return;
  void api.dispatch({ target: 'cap.ai.chat', action: 'interrupt', payload: { sessionId } });
}
```

证据（plugins/mock-engine/index.ts:59-70）：

```ts
for (let i = 0; i < text.length; i += chunk) {
  if (cancelled) {
    emit({ kind: 'message.done', payload: { sessionId, messageId, interrupted: true } });
    running.delete(sessionId);
    return;
  }
  emit({ kind: 'message.delta', ... });
  await new Promise((r) => setTimeout(r, 120));
}
```

影响分析：
- **停流有效**：interrupt 触发 `cancelled = true`，下一次循环检查后 emit `message.done{interrupted:true}` 并 return，不再有 delta。最长延迟一个 chunk 间隔（120ms），可接受。
- **按钮复位有时延缝隙**：ChatInput 的 `streaming` 取决于消息的 `streaming` 字段，而它只在 chat-lite 收到 `message.done`/`stream.end` 后置 false。interrupt 后按钮要等引擎下个 tick（≤120ms）emit done 才复位——功能上正确，但若引擎实现忘记在中断时补发终止事件（契约未强制），按钮会永久停在「停止」态。建议 chat-lite 在 dispatch interrupt 成功后乐观置 `streaming:false`，事件后到再校正。
- **running map 竞态**：`running.set(sessionId, cancel)` 在流开始时覆盖旧值。若同会话上一条流尚未结束就启动新流（见第 5 项），旧流的 cancel 引用被覆盖，旧流**再也无法被中断**（只能等它自然跑完）。反向亦然：interrupt 只能停「最后注册的那条」。
- **误清**：自然完成路径 `emit(done); running.delete(sessionId)` 无条件按 key 删——若此时同会话已有第二条流注册进 map，会把**新流的 cancel 误删**，之后 interrupt 失效。

建议修复：running map 的 value 改为 `Set<() => void>` 或 key 改为 `sessionId::messageId`；interrupt payload 增加 messageId；中断路径与完成路径都只删除自己的条目。

---

### 4. 流式过程中切换会话/新建会话：流还会写进旧会话吗

**[P1] 流会继续写进旧会话（数据不丢，这是对的），但 chat-lite 监听器闭包绑定旧 sessionId，切走后旧流的 done 事件会错误地尝试复位；新建会话不影响旧流。真正的问题是「旧流的写路径不经过当前 activeId」，UI 上用户无法再中断旧流**

证据（plugins/chat-lite/index.ts:80-86）：监听器闭包捕获发起时的 `sessionId` 与 `assistantId`，`updateMessage(sessionId, assistantId, ...)` 也用闭包变量——所以切换会话后，旧流 delta 仍写入旧会话的消息（内容不串到新会话，这点正确）。

影响分析：
- **切换会话后无法停止旧流**：`interruptChat`（index.ts:106-111）取的是**当前** `activeId`。用户从会话 A 切到 B 后，A 里还在跑的流无法被中断——按钮在 B 会话下即使显示「停止」，点的也是 B 的 sessionId（B 无流，interrupt 空转）。旧流只能自己跑完。
- **新建会话**：`createSession` 只新增会话并改 activeId，不触碰旧会话消息，旧流继续写旧会话，无串写。
- **多流并存**：若用户在 A 发起流、切到 B 又发起流，两个监听器都在，各自按闭包 sessionId 写各自会话——此时若 A、B 事件都到达，过滤逻辑正确（sessionId 不同互斥）。但结合第 1 项，若两条流恰好同 sessionId（同会话）则串台。
- **副作用**：SessionSidebar 显示 `messages.length`，旧会话在后台持续 +1，用户切回时会发现消息「凭空多了一条已完成的回复」——这是预期行为，但若旧流在用户视角已「放弃」，持续写入可能不符合直觉，产品上可选：切走时自动 interrupt 旧流。

结论：**跨会话串写：已检查通过（闭包 sessionId 隔离正确）**；但「切换会话后旧流失控/不可中断」判 P1。

建议修复：interruptChat 增加「按会话中断」与「中断全部在途流」两种语义；或在 `setActive` 时对离开会话的在途流自动 dispatch interrupt；监听器注册表应可按 sessionId 枚举（现在 unbind 闭包散落在 sendUserMessage 局部作用域，无全局登记）。

---

### 5. mock-engine running map 只按 sessionId 存 cancel：同一会话并发两条流会怎样

**[P0] 同会话并发两条流时：后流覆盖前流的 cancel，前流不可中断；前流自然结束时误删后流的 cancel；且两条流的 delta 都带同一 sessionId，chat-lite 端互相串字（与第 1 项叠加）**

证据（plugins/mock-engine/index.ts:8、51-53、61-63、71-72）：

```ts
const running = new Map<string, () => void>(); // sessionId -> cancel
...
running.set(sessionId, () => { cancelled = true; });   // 后流覆盖前流
...
if (cancelled) { emit(...done interrupted...); running.delete(sessionId); return; }  // 前流被中断时删的是 key，可能删掉后流刚 set 的
...
emit({ kind: 'message.done', payload: { sessionId, messageId } });
running.delete(sessionId);                              // 无条件删 key
```

影响分析：
1. `running.set` 直接覆盖：前流的 cancel 函数丢失，前流永远无法再被 interrupt。
2. 前流先自然结束 → `running.delete(sessionId)` 把后流刚注册的 cancel 一起删掉 → 后流也不可中断。
3. 若 interrupt 恰好发生在「前流已过最后一个 cancelled 检查、后流已 set」之间，cancel 落到后流头上 → **中断误伤**：想停前流，实际停了后流（前流继续 emit 到自然结束）。
4. 结合 chat-lite 侧不过滤 messageId，两条流的 delta 混写进同一个 assistant 消息，文本交错错乱。

建议修复：
- key 改为 `${sessionId}::${messageId}`（引擎已持有 messageId）；
- 或 value 改为 `Map<messageId, cancel>`；
- interrupt handler 按 `(sessionId, messageId?)` 精确取消；delete 只删自己的组合键。
- chat-lite 侧同步加 messageId 过滤（第 1 项修复），双保险。

---

### 6. message.done 处理里 unbind 后，引擎还在 emit（如 stream.end），是否有泄漏或报错

**[P2] 无崩溃、无监听器泄漏，但存在一个真实的时序缝隙：done 先到会提前 unbind，随后总线补发的 stream.end 将无人消费——若未来有「在 stream.end 里做收尾」的逻辑会静默丢失；反向顺序（stream.end 先到）则 done 变成孤儿事件**

证据（src/core/bus.ts:93-95，流式 handler 结束后总线**额外**补发 stream.end）：

```ts
await reg.streaming(req, (ev) => this.pushStream(key, ev));
entry.ok = true;
this.pushStream(key, { kind: 'stream.end', payload: null });
```

注意：`main.tsx:29-31` 的装配把引擎 emit 转成 `host.broadcastStream('chat-event', ev)`，而 `stream.end` 这条补发事件走的是 `bus.pushStream`（发给 `streamSubs`），**并不经 broadcastStream**——也就是说 chat-lite 实际上**收不到 stream.end**（dispatchStream 的 onEvent 传的是 `() => undefined`，hostRuntime.ts:44）。chat-lite 的 `else if (ev.kind === 'message.done' || ev.kind === 'stream.end')` 里 stream.end 分支当前是死代码。

影响分析：
- chat-lite 在 `message.done` 时 `unbind()`：把 handler 从 `runtime.listeners.get('chat-event')` Set 中删除。之后引擎若还有 emit（当前实现中，`emit(done)` 之后只有 `running.delete`，不再 emit，所以正常路径无泄漏、无报错）。
- **异常路径**：若引擎在 done 后继续 emit（契约允许引擎多发事件），handler 已移除，`listeners.forEach` 不会命中，事件被静默丢弃——**无报错也无泄漏**，但任何依赖「结束事件必达」的收尾逻辑（如持久化、统计）会丢。
- **孤儿事件窗口**：`unbind` 在收到 done 时立即执行，而引擎的 `running.delete` 与总线 audit 在同一 tick；若 stream.error 在 done 之后才被总线补发（不会，error 与 end 互斥且都只发一次），无实际双发。真正需要提防的是第 3 项的中断路径：`emit(done interrupted)` 之后引擎 return，总线随后 pushStream stream.end——chat-lite 已 unbind，stream.end 无人听（当前无影响）。

建议修复：
- 明确事件终结契约：要么让引擎的终止事件（done）为唯一终态，总线不再补发 stream.end（或补发也走同一广播通道）；要么 chat-lite 等 stream.end 再 unbind，done 只做 UI 复位。
- unbind 前置一个 `settled` 布尔，保证 done/error/end 多次到达时幂等，避免未来双通道下重复复位。

---

### 7. ChatInput 的 streaming 判断（任一消息 streaming 就全局禁发）是否合理

**[P1] 判断范围是「当前激活会话」而非全局——跨会话不会误禁；但同会话内一旦出现残留 streaming 消息（中断事件丢失、引擎异常退出），输入框将永久锁死，无任何恢复入口**

证据（plugins/chat-lite/ChatInput.tsx:8-10）：

```ts
const streaming = useSessionStore((s) =>
  s.sessions.find((x) => x.id === s.activeId)?.messages.some((m) => m.streaming),
);
```

影响分析：
- **范围澄清**：选择器先 `find(x => x.id === s.activeId)`，只检查当前会话——所以 A 会话在流式时，切到 B 会话仍可发送。这一点设计是合理的（不会跨会话误禁），与题目中「全局禁发」的担心不同，实际实现是「当前会话禁发」。
- **真正的问题——锁死无解**：`streaming` 标志只有两个清除途径：收到 `message.done`/`stream.error`（index.ts:85-94）。若引擎插件抛异常前没来得及 emit 任何事件、或事件在广播前丢失（如第 2 项的重复注册异常导致引擎失联）、或 done 事件因第 6 项的时序问题未被消费，该消息的 `streaming` 永远为 true → **该会话的发送按钮永久变为「停止」，且点击停止调用 interruptChat 对已死的流无效（running map 里无此项），死锁**。用户唯一出路是切到别的会话或刷新页面。
- **次要**：`useSessionStore((s) => ...some(...))` 每次渲染都新建布尔，zustand 默认 Object.is 比较，布尔稳定，无多余重渲染问题——这点没问题。

建议修复：
1. interruptChat 对「running map 中不存在的 sessionId」返回明确结果，chat-lite 收到后直接把该会话所有 `streaming:true` 的消息复位（自愈）。
2. 或在引擎侧用 `try/finally` 保证任何退出路径都 emit 终止事件（mock-engine 当前 `registerStreaming` 的 async 函数若 throw，总线会补 `stream.error`——bus.ts:96-102，这条路径其实有兜底；真正漏的是「引擎注册被覆盖/失联」这类装配期故障）。
3. 长期：给 streaming 消息加超时看门狗（如 30s 无 delta 自动复位 + 提示）。

---

### 8. updateMessage 的 patch 合并是否会丢字段

**已检查通过**。证据（src/core/sessionStore.ts:38-48）：

```ts
updateMessage: (sessionId, msgId, patch) =>
  set((st) => ({
    sessions: st.sessions.map((s) =>
      s.id === sessionId
        ? { ...s, messages: s.messages.map((m) => (m.id === msgId ? { ...m, ...patch } : m)) }
        : s,
    ),
  })),
```

- `{ ...m, ...patch }` 是浅合并：只覆盖 patch 中出现的键，其余字段（id/role/createdAt 等）保留，不会丢字段。
- chat-lite 的三处调用（index.ts:84 content、86 streaming:false、89-91 content+streaming:false）都只传增量键，语义正确。
- 两个边界说明（非缺陷）：
  1. 浅合并意味着若未来消息带嵌套对象（如 `meta:{tokens, model}`），patch 传 `meta:{tokens}` 会整个覆盖 `meta` 丢掉 `model`——当前 ChatMessage 类型（types.ts:55-61）无嵌套字段，暂不构成问题，建议在类型注释中写明「patch 为浅合并」。
  2. `msgId` 不存在时 map 无命中、静默无操作——不会报错也不会误伤其他消息，行为安全；但结合第 1 项的 id 撞车风险，同 id 多条消息会被同时 patch，这是 id 生成的问题而非 merge 的问题。

---

## 汇总表

| # | 检查项 | 结论 | 级别 |
|---|---|---|---|
| 1 | 连发两条消息串台 | 同会话必串（无 messageId 过滤 + 全量广播）；跨会话依赖 sessionId 弱过滤 | P0 |
| 2 | StrictMode 双挂载 | 当前无重复订阅/双份流（已检查通过，附 2 个隐性前提风险） | 通过（附 P2 隐患） |
| 3 | interrupt 停流与按钮复位 | 能停流（≤120ms 延迟）；复位依赖引擎补发 done；running 覆盖/误删竞态 | P1 |
| 4 | 切换/新建会话时在途流 | 无跨会话串写（已检查通过）；但旧流切换后不可中断 | P1 |
| 5 | running map 按 sessionId 存 cancel | 同会话并发流：前流不可中断、cancel 误删、中断误伤 | P0 |
| 6 | done 后 unbind 的泄漏/报错 | 无泄漏无报错（已检查通过）；stream.end 实际不可达，终结契约含糊 | P2 |
| 7 | ChatInput streaming 禁发范围 | 实为「当前会话禁发」，不跨会话误禁；但 streaming 残留会永久锁死输入 | P1 |
| 8 | updateMessage patch 合并 | 浅合并不丢字段 | 已检查通过 |

## 修复优先级建议

1. **P0-1 + P0-5 一起修**（同一根因：流没有按 messageId 维度隔离）：
   - mock-engine：running key 改 `sessionId::messageId`；interrupt 接收可选 messageId。
   - chat-lite：事件过滤加 `ev.messageId === assistantId`。
   - 总线（可选加固）：dispatchStream 的 key 已含 `pluginId::target::action`（bus.ts:127-129），不含 payload 维度——同插件同 cap 的两次流式调用共享同一个 subs Set，这正是全量广播的机制根源；建议 streamKey 纳入调用序号，事件定向回传。
2. **P1-3 + P1-4 + P1-7 一起修**（中断语义与自愈）：interrupt 返回结果；chat-lite 对无效 interrupt 自愈复位 streaming；setActive 可选自动 interrupt 离开会话的在途流。
3. **P2**：统一终结事件契约（done 为唯一终态或 end 可达且幂等），`settled` 标志防重复复位。
