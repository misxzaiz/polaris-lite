# AI 对话多设备共享（spec v0.1，2026-11-20）

> 目标：AI 对话会话从「浏览器本地（localStorage）」上移为「服务端权威 + 多端同步」，同一账号在桌面/手机/另一台电脑打开 polaris-lite，看到同一份会话列表与会话内容；不做历史数据迁移。
> 参照：`docs/ai-events-plugin-plan.md` §七（C 档多设备草案，本 spec 落地并扩展它）；`docs/context-insight-plan.md` 的 spec 体例；Polaris 主仓 session-v2「日志即真相、前端只是缓存」的对账思想。
> 范围：新增 1 个服务端中间件（chat-store）、改造 `plugins/chat-lite/store.ts` 数据源、`chat-lite` manifest/grants 增权。**不改动** cap 总线、鉴权、agent-loop、real-engine。

---

## 1. 需求与边界

| # | 需求 | 说明 |
|---|---|---|
| R1 | 多设备共享会话 | 任一设备登录后能看到全部会话（列表 + 正文 + 工具卡/交互卡/产物块） |
| R2 | 新消息近实时可见 | 设备 A 发消息，设备 B 下次进入该会话（或轮询到期）能看到；不做打字级实时推送 |
| R3 | 冲突不丢数据 | 两端同时改同一会话，后写者被 409 拦住并提示，可选择覆盖或以服务端为准 |
| R4 | 离线可用性降级 | 服务端不可达时本地仍可读（最近缓存）与写（标记未同步），恢复后补偿上传 |
| R5 | 不做历史迁移 | localStorage 旧数据不搬运；首次进入服务端为空即空，旧数据随版本自然废弃 |
| R6 | 单 owner 权限模型不变 | 服务端数据按「登录会话」把守（cookie），不引入多用户/多租户概念 |

**明确不做**：多用户隔离、端到端加密、OT/CRDT 合并、SSE/WebSocket 推送、跨账号分享、删除同步墓碑之外的回收站。

## 2. 现状（调研结论，2026-11-20 实测）

- **会话存储在浏览器**：`plugins/chat-lite/store.ts` 以 localStorage 键 `chat-lite.sessions.v1` 持久化全部会话（防抖 800ms + 1.5MB 容量裁剪 + pagehide 兜底）。换浏览器/清缓存即丢；多端天然不共享。
- **chat-lite 周边本地态**：草稿（sessionStorage `chat-lite.draft.<sid>`）、prompt 历史（localStorage `chat-lite.prompt-history`）、上下文策略（localStorage `chat-lite.ctx-policies.v1`）、工作区偏好（localStorage `chat-lite.workspace-prefs.v1`）。
- **已验证的服务端先例**：kv-store 插件已把插件数据上收服务端 sqlite（`<dataDir>/stores/kv-store.db`，`/api/kv/*`，会话 cookie 门禁），pocket-ledger 已迁移并明确宣传「多端打开同一份数据」。
- **鉴权**：`server/auth-session.mjs` 单 owner（auth-owner.json）+ cookie 会话（plite.sid，12h，落盘 auth-sessions.json）；`/api/auth/status` 可判登录态。**多设备 = 同一账号多个 sid，无第二账号**。
- **服务端插件装配**：`plugins/server-registry.mjs` 登记 server 半边，`server/host.mjs` 注入 `{ dataDir, getSession, store, policy }`；测试基线 `tests/server.test.mjs` 用 `createProdServer` 起独立实例。
- **AI 引擎链路**：chat-lite 每次发送时把「可见历史」从 store 组装进 `start` payload（`history` 字段）传给 agent-loop/real-engine；agent-loop 另有内存 shadow transcript（按会话自持，刷新后由 history 重新播种）。**引擎不落盘会话**——会话真相目前只有浏览器里那一份。
- **消息形态**：`StoreMessage = ChatMessage | ToolCardMessage | AssistantBlockMessage`；assistant 消息含 `blocks[]`（text/thinking/tool/interactive/artifact），tool 卡带 stdout/stderr（单卡 16KB 截断），artifact 卡只存引用（如 `shotId`/`previewId`，真身在服务端 `<dataDir>/browser-shots`、`previews/`）。
- **此前定论**：`docs/ai-events-plugin-plan.md` §7 已论证「单 owner + 多设备并发概率低 → 版本号 + last-write-wins 足够，不需要 OT/CRDT；轮询足够，暂不做 SSE」。本 spec 沿用该结论。

## 3. 方案总览

**服务端权威 + 版本化整会话读写 + 索引轮询 + 本地缓存兜底。**

```
设备 A（浏览器）                     服务端（Node，<dataDir>/chat-store/）                设备 B（浏览器）
┌──────────────┐   ①启动拉索引    ┌──────────────────────────┐   ①启动拉索引    ┌──────────────┐
│ chat-lite    │ ───────────────▶ │ GET /api/chat/sessions   │ ◀─────────────── │ chat-lite    │
│ store.ts     │   ②打开拉全文    │ GET /api/chat/sessions/:id│                 │ store.ts     │
│ (本地缓存)   │   ③防抖整写      │ PUT /api/chat/sessions/:id│                 │ (本地缓存)   │
│              │ ───────────────▶ │   {baseVersion} 409 冲突  │ ◀───────────────│              │
│              │   ④删除          │ DELETE /api/chat/sessions/:id│               │              │
└──────────────┘                  └──────────────────────────┘                 └──────────────┘
        ▲                                   │
        └──── ⑤轮询索引（30s / visibilitychange 回前台）──────────────────────────────┘
```

- **写路径（唯一权威）**：store 每次变更（appendMessage/appendAssistantBlock/patchXxx/rename/delete…）仍走既有 `schedulePersist` 防抖窗口；窗口到期时**不再写 localStorage，而是 PUT 整个会话到服务端**（带该会话的 baseVersion）。成功后更新本地 version。
- **读路径**：启动 `GET /api/chat/sessions`（索引：id/title/updatedAt/msgCount/version），进入会话时 `GET /api/chat/sessions/:id` 拉全文；本地 IndexedDB（或内存）缓存最近打开的会话全文作为离线兜底与秒开缓存。
- **多端可见性**：30s 间隔轮询索引（仅登录态、document.visibilityState==='visible' 时），发现「新会话 / version 变化」才拉对应会话全文；当前正在流式输入的会话跳过覆盖（见 §5 时序）。
- **冲突**：PUT 带 `baseVersion`，不匹配返回 409 + 服务端当前 {version, updatedAt}。前端默认「以服务端为准」（重新拉取），若本地确有未同步的新消息则提示「另一台设备已更新」并提供「仍要覆盖」按钮（一次显式覆盖 = 强制 PUT `force:true`）。
- **删除**：DELETE 软墓碑（`deletedAt` 标记，保留 7 天后物理清理）；其他设备轮询索引时按墓碑移除本地对应会话。

## 4. 服务端设计（新插件 server 半边：`plugins/chat-store/server.mjs`）

遵循「领域进插件、宿主零业务」：新目录 `plugins/chat-store/`，在 `plugins/server-registry.mjs` 登记，宿主零改动（通过 `tests/server-boundary.test.mjs` 既有约束）。

### 4.1 端点（全部要求会话 cookie，未登录 401）

| 方法 | 路径 | 语义 |
|---|---|---|
| GET | `/api/chat/sessions` | 索引：`[{id,title,updatedAt,createdAt,msgCount,lastMsgPreview,version,deletedAt?}]`，按 updatedAt 倒序；`?since=<ts>` 增量（返回 updatedAt>since 的条目 + 全量墓碑列表） |
| GET | `/api/chat/sessions/:id` | 单会话全文：`{session, version, updatedAt}`（含 messages 全量） |
| PUT | `/api/chat/sessions/:id` | 整会话写入：body `{session, baseVersion, force?}`；版本不符 409 `{error, currentVersion, updatedAt}`；成功 `{ok, version, updatedAt}` |
| DELETE | `/api/chat/sessions/:id` | 软删除（墓碑）；成功 `{ok, version}` |

- **存储**：`<dataDir>/chat-store/<sessionId>.json`，单文件 `{version, updatedAt, deletedAt?, session}`；原子写 `tmp + rename`（照 provider-store 写法）。索引内存维护 + 变更时重扫目录（会话量级 ≤ 数百，扫描可忽略）。
- **sessionId 校验**：`^[A-Za-z0-9_-]{1,64}$`（前端 id 形如 `s-<base36>-<base36>`，天然匹配），**防路径穿越**。
- **体积限制**：单会话 JSON ≤ 4MB（localStorage 时代全库才 1.5MB，单会话 4MB 已宽松；附件 base64 大图可能到 MB 级，超限返回 413，前端提示「本条含过大附件，已截断保存」并按既有 CARD_STORE_CAP 逻辑先裁剪再重试）。
- **版本号**：从 1 起，每次 PUT 成功 +1。**不比较内容**，只认版本单调。
- **并发**：Node 单进程内每会话一把 Promise 互斥锁（读写串行化），消除「同会话并发 PUT 交错读改写」的进程内竞态；多进程部署不在本 spec 范围（lite 是单机单进程形态）。
- **body 上限**：沿用 `http-util.mjs` 的 `BODY_LIMIT_LARGE`（5MB）+ 自身 4MB 校验，畸形 JSON 400。
- **审计**：写操作（PUT/DELETE）落一行到 `<dataDir>/chat-store-audit.log`（JSON Lines：at/op/sessionId/version/ok），读不打点（轮询高频）。

### 4.2 为什么「整会话读写」而不是「逐消息追加」

- 会话就是聊天产品的自然事务边界：工具卡/思考块/交互卡回填都发生在「一条 assistant 消息的生命周期内」，整会话写保证块序与 content 镜像一致，绝不出现半条消息。
- 消息级追加要设计消息 id 稳定性、去重、乱序合并三套机制，收益仅是省几 KB 流量——lite 形态不值得。
- 与既有 store.ts 的防抖整写模型完全同构：把「写 localStorage」换成「PUT 服务端」，改动面最小。

## 5. 前端设计（chat-lite store 改造）

### 5.1 数据源切换（`plugins/chat-lite/store.ts`）

- `hydrate()` 改为：**同步读 IndexedDB 缓存**（秒开旧数据）→ 异步 `GET /api/chat/sessions` 索引 → 与缓存 merge → 渲染；进入会话时按需拉全文。
- `schedulePersist(get)` 改为 `scheduleSync(get)`：防抖 800ms 不变，到期把「脏会话集合」逐个 PUT（带各自 baseVersion）。**pending 队列、草稿仍只存本地**（流式预输入/未发送文本是纯本机交互态，不上传）。
- localStorage 键 `chat-lite.sessions.v1` **停止写入**（保留一次性读：若存在且服务端索引为空，提示「检测到本机旧会话数据，多端同步版不包含它们」——只提示，不自动迁移，兑现 R5）。
- 新增同步状态（内存态，不入会话数据）：`syncState: 'idle'|'syncing'|'offline'|'conflict'`，驱动侧栏/输入区的小状态点；offline 时写操作照常进内存与 IndexedDB，恢复在线后重放 PUT。

### 5.2 多端轮询与冲突收敛

- 轮询器：`setInterval(30s)` + `visibilitychange`（回到前台立即拉一次）+ 发送消息后 2s 内延迟拉取（自己刚写的会话优先用本地态）。
- 收到索引后：新会话 → 拉全文插入；version 升高的会话 → 若**不在流式中且无未同步脏标记**，拉全文替换本地；若是当前正在流式的会话 → 跳过（等 settle 后下一轮再拉，避免把远端半截状态盖掉本地正在增长的块）。
- 409 处理：默认拉服务端版本覆盖本地；若本地该会话有「未同步新增消息」（脏会话且消息数 > 服务端 msgCount），在侧栏该会话条目上弹「另一台设备已更新」条：`以服务端为准` / `覆盖服务端`（force PUT）。不做自动合并（与 ai-events-plan §7.2 结论一致）。

### 5.3 流式中断与「刷新即丢」的边界

- 流式产生的中间块仍只进内存 + 防抖上云；页面刷新/切设备后，未 settle 的流不会自动恢复（与现状一致——引擎在浏览器端，刷新即断）。B 端打开同一会话看到的是「最后一条 assistant 消息 streaming=true 但无新增」→ store 载入时把 `streaming` 复位为 false 并补一个 `[连接已由其他设备接管或中断]` 提示块？**否——保持简单**：hydrate 时照旧 `streaming:false`，不加提示块（避免污染正文；中断语义维持本地现状）。

### 5.4 不上云的本地态清单（保持现状）

| 态 | 存储 | 不上云理由 |
|---|---|---|
| 待发队列 pending | 内存 | 流式预输入是本机交互态；重开页面视为放弃（现状即如此） |
| 输入草稿 | sessionStorage | 半成品文本无共享价值，且按会话键控，换设备无意义 |
| prompt 历史 | localStorage | 输入习惯属个人本机行为 |
| 上下文策略 ctxPolicies | localStorage | 会话级微调，量大价低；后续若要共享再并入会话 JSON 的 meta 字段（预留 `session.meta`） |
| 工作区偏好 workspace-prefs | localStorage | 引用 root id；root 是本机路径概念，跨设备无意义 |

## 6. 协议类型（前后端对齐）

沿用 `StoreMessage` 原样 JSON 序列化（blocks/tool 卡/interactive 卡字段全保留），服务端**不理解消息语义、只存取整包**——这与「核心零业务」一致：chat-store 不 import 任何消息类型，前端是唯一解释者。服务端仅校验外壳：

```ts
// PUT /api/chat/sessions/:id body
interface ChatSessionPut {
  session: { id: string; title: string; createdAt: number; messages: unknown[]; workspaceId?: string; linkedWorkspaceIds?: string[] };
  baseVersion: number;   // 客户端持有的版本；0 = 新建
  force?: boolean;       // true = 覆盖服务端（用户显式选择后）
}
```

服务端校验：id 正则、`session.id === :id`、messages 为数组、序列化后 ≤4MB；**不校验消息内部结构**（协议演进不锁服务端）。

## 7. 安全与隐私

- 全部端点过 `getSession` 硬门禁（照 kv-store 模式），未登录 401；路径穿越由 id 正则 + `resolve` 前缀校验双保险。
- 服务端不落 API key；对话正文含用户贴入的密钥时**原样存储**（与现状 localStorage 一致，不新增脱敏面——ai-events 的 redact 只覆盖取证库）。文档标注：数据目录属本机磁盘，请勿分享 `.polaris-lite/`。
- 审计日志只记元数据（op/sessionId/version），不记正文。
- CSRF：与既有 `/api/kv/*` 同一威胁模型（SameSite=Lax cookie + 同源 fetch），不新增豁免。

## 8. 实施步骤（P0 → P3，每步可独立验收）

| 期 | 内容 | 改动面 | 验收 |
|---|---|---|---|
| **P0** | chat-store server 半边 + 单测 | 新增 `plugins/chat-store/{server.mjs}`、`server-registry.mjs` 加一行、`tests/chat-store.test.mjs`（复用 `tests/server.test.mjs` 的 createProdServer + cookie client 模式：未登录 401 / 首登注册 / PUT 建会话 / 版本冲突 409 / force 覆盖 / DELETE 墓碑 / id 穿越 400 / 超 4MB 413） | `npm test` 全绿；两个 client（两台「设备」）互读写同一会话可见 |
| **P1** | store 数据源切换 | `store.ts`：hydrate/schedulePersist 改造 + IndexedDB 缓存 + syncState；chat-lite manifest/grants 增 `cap.kv`？**否**——chat-store 走自己的 HTTP 端点，与 cap.kv 无关；仅改 chat-lite 无新 cap（fetch 同源直连，与 ChatInput 的 `/api/tool/config` 同模式） | 桌面发一条消息 → 手机（另一浏览器）打开同账号能看到；`npm run typecheck && npm test` 绿 |
| **P2** | 轮询 + 冲突 UI | 30s/visibility 轮询、409 提示条、offline 降级标记 | 双浏览器同时改同一会话，后写方 409 有提示且数据不丢 |
| **P3**（可选） | 体验补齐 | 索引 lastMsgPreview 优化、会话 meta 预留字段启用（ctxPolicy 上云）、旧 localStorage 数据存在性一次性提示 | — |

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| 流式中高频 patch（每帧 delta 合并）触发频繁 PUT | 防抖 800ms 已有；再加「流式期间只进内存、settle 时强制 flush」——即现状行为平移，写放大与 localStorage 时代相同 |
| 双端同时流式同一会话（A 在问、B 也在问） | 服务端按会话锁串行化；前端轮询对「正在流式的会话」跳过远端覆盖；两端消息都会保留（分别 append，后写者版本胜出但内容含自己的新消息）——可接受的 lite 语义，文档明示 |
| IndexedDB/服务端都不可用 | 退化为纯内存会话（现状隐私模式行为），输入仍可用，刷新即丢——如实提示 |
| 会话文件损坏 | 读失败按「该会话不存在」处理并告警日志；不 brick 整个索引 |
| 旧 localStorage 残留误导 | 只读提示不迁移；键保留但永不写入 |

## 10. 明确的非目标重申

- 不做实时协作（SSE/WebSocket/typing 指示）：30s 轮询 + 打开会话时拉取已覆盖「手机看桌面聊到哪了」的主诉求。
- 不做历史迁移：兑现需求原文「可以不用关注历史数据迁移」。
- 不做后台执行（B1 编排上服务端）：那是独立课题（ai-events-plan §8），本 spec 只保证「会话数据」多端一致，不承诺「任务在后台继续跑」。
