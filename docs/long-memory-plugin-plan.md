# 长期记忆插件规划（long-memory）

> 状态：**规划确定，待实施**（2026-11-27 分析定稿）
> 定位：纯插件实现——核心零改动；agent-runner / chat-lite 两处为与 system-prompt 完全
> 同款的插件级 service 消费/设置分区改动（先例成立，见「边界核查」一节）。

## 一、产品语义

| 状态 | 行为 |
|---|---|
| **关闭**（默认） | 现状不变：无记忆注入、memory 工具调用返回「未开启」；已有记忆保留不清空 |
| **开启** | AI 像熟悉你的人：记得既往偏好、决定、约定与配置事实，并主动运用；可主动记录新信息、遗忘过时信息 |

- 记忆是**全局池**（跨会话共享），不做 session 级记忆隔离。
- 记忆内容两类：**对话事实**（用户偏好、决定、约定）与**配置事实**（常用模型、
  工具偏好等会话设置相关选择）。
- 关闭 ≠ 清空：停用只停注入/写入，数据保留；「清空记忆」为面板内独立操作（二次确认）。

## 二、架构（四段既有链路拼接，零新基建）

```
存储：kv-store（namespace='long-memory'，sqlite 落盘，多端一致）
注入：agent-runner seedShadow → registry.getService('long-memory') → 追加记忆段
工具：本插件 server 半边 registry.registerTool × 3
开关：chat-lite SessionSettingsPanel 新增「长期记忆」分区（读写走本插件 HTTP）
```

### 2.1 存储布局（kv-store，不自建 sqlite）

| key | 内容 |
|---|---|
| `settings` | `{ enabled: boolean, injectLimit: number }` 全局开关与注入上限 |
| `item.<id>` | 单条记忆 `{ text, kind, reason, createdAt, updatedAt }`，id 自增 |

- kind 枚举：`fact`（对话事实）/ `config`（配置事实）。
- 开关只有**全局一级**（简化一期）：会话级三态覆盖留作二期，不做。
- 条目上限一期 200 条；注入段超过上限字符数（默认 2000）时截断并提示走 recall。

### 2.2 注入（agent-runner seedShadow，~20 行）

位置：system-prompt 注入块**之后**追加（顺序：内置纪律段 → 用户自定义指令 → 记忆段）。

注入段文案（骨架）：

```
【长期记忆已开启】以下是关于用户的既有记忆（你过往对话中记录）：
- <条目 1>
- <条目 2>
使用它们让回复更贴合用户；发现过时信息可用 memory_forget 更新。
值得长期记住的新信息（偏好/决定/配置选择），主动用 memory_save 记录，可先征询用户。
```

- service 不存在（插件未装）或开关关闭时静默跳过——与 system-prompt 同款容错。
- runner 只消费拼好的单一段字符串，不感知条目结构（组合逻辑收敛在本插件）。

### 2.3 工具（registry.registerTool，invoke 内判开关）

| 工具 | 语义 |
|---|---|
| `memory_save` | 写入一条记忆，附一句话理由（reason），供面板清理时判读 |
| `memory_recall` | 按关键词检索记忆（注入段截断后的补充通道） |
| `memory_forget` | 删除指定 id 的过时/错误记忆 |

工具常驻注册（引擎工具表不随开关动态增删）；关闭状态 invoke 返回明确错误
「长期记忆未开启」。工具描述中写明该语义。

### 2.4 设置开关（chat-lite SessionSettingsPanel）

- 新增「长期记忆」分区：开关 + 记忆条数展示 + 「管理面板」直达按钮。
- 读写走本插件 HTTP（`/api/long-memory/settings`），chat-lite 不经 cap 授权面
  （与 modelRef 读 /api/providers/list 同款 HTTP 口径）。
- 面板入口文案明示：关闭仅停用不清空；清空需在管理面板操作。

### 2.5 管理面板（本插件 UI 半边，panel 槽位）

- 列表（text/kind/reason/时间）+ 单条删改 + 批量清理 + 导出 JSON + 清空（二次确认）。
- 显示「本实例记忆 N 条」（记忆按实例数据目录隔离，属正确行为，面板如实标注）。

## 三、边界核查（合规性）

| 改动面 | 性质 | 先例 |
|---|---|---|
| 新插件 `plugins/long-memory/`（index.tsx + server.mjs + vite.config.ts） | 纯新增 | — |
| agent-runner seedShadow 加 getService('long-memory') 消费块 | 插件级 service 消费 | system-prompt 完全同款 |
| chat-lite SessionSettingsPanel 加设置分区 | 插件级 UI | 分区（模型/执行/队列/分享）既有模式 |
| plugin-list.mjs / server-registry.mjs / grants 登记 | 各一行/数行 | 铁律流程 |
| server/ 核心目录、宿主壳层 | **零改动** | — |

## 四、登记清单（实施时逐项过）

1. `plugins/plugin-list.mjs`：PLUGIN_LIST 加一行（order 排 kv-store 之后）。
2. `plugins/server-registry.mjs`：`{ id: 'long-memory', entry: './long-memory/server.mjs' }`。
3. `public/grants.json`：manifest 申请项 ⊆ 授权项；requires 需有已启用插件覆盖（kv-store）。
4. manifest.id 与目录名一致；contributes slots 声明 panel 槽位。
5. 门禁：`npm run check:plugins` + `npm run typecheck && npm test && npm run build:plugins`。

## 五、HTTP 端点（server 半边自有路由）

```
GET  /api/long-memory/settings → { enabled, injectLimit }
POST /api/long-memory/settings { enabled?, injectLimit? }
GET  /api/long-memory/items?kind=&q= → { items: [...] }
POST /api/long-memory/items   { text, kind, reason }
POST /api/long-memory/delete  { id }
POST /api/long-memory/clear   （清空，二次确认由 UI 承担）
```

安全模型对齐 kv-store：会话 cookie 硬门禁（未登录 401）；value 尺寸上限；无 SQL 拼接
（kv-store 预编译语句）。`PLITE_LONG_MEMORY=0` 一键禁用（对齐 PLITE_KV 模式）。

## 六、风险与对策

| 风险 | 对策 |
|---|---|
| 记忆膨胀挤上下文 | 注入上限 2000 字符 + 条目上限 200 + recall 检索通道 |
| 自动写入噪音 | save 强制附 reason；面板批量清理 |
| 注入失效无感知 | e2e 用例：开启后对话可见记忆段生效（参照 system-prompt 验收口径） |
| 隐私边界 | 开关注释明示 + 面板导出/清空；记忆仅存本实例数据目录 |
| 关闭≠清空的误解 | 设置分区与面板文案双处写明 |

## 七、实施顺序与验收

1. server 半边：kv 封装 + service 注册 + 3 工具 + HTTP 路由 + 环境开关。
2. seedShadow 消费块（agent-runner）。
3. UI 半边：管理面板（panel 槽位）。
4. chat-lite 设置分区 + 直达按钮。
5. 三处登记 + grants。
6. 门禁四连 + 开发环境（5000）冒烟 + e2e-final。

预估 ~500 行（server ~200 / UI 面板 ~200 / chat-lite 分区 ~80 / 杂项 ~20），一天量级。
