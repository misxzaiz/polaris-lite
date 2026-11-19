# AI 对话工作区管理分析（chat-workspace-mgmt）· 仅分析未实施

> 需求：AI 对话支持「工作区管理」——设置/管理工作区、给工作区命名、**给每个 AI 对话设置工作区**（会话 ↔ 工作区绑定）。
> 前置：file-browser v2 已交付（roots 白名单/树浏览/cap.tool.fs/workspace-changed 广播）；bash cwd 已跟随 activeRoot。本文把「工作区」从**全局单选**升级为**按对话会话绑定**，并给出纯插件实施方案。

---

## 一、现状盘点与差距

| 能力 | 现状 | 差距 |
|---|---|---|
| 工作区根登记/浏览 | file-browser 面板（v2） | ✅ 已有 |
| 全局 activeRoot | file-browser 持有，bash cwd 跟随 | ❌ 所有对话共享一个工作区 |
| **对话级工作区** | 无——chat-lite 会话模型里没有 workspace 字段；loop 的 shadow transcript 与 cwd 都是全局的 | 本需求核心 |
| 工作区命名 | 根有 label（登记时默认目录名），无用户自定义改名 | 需要改名入口 |
| AI 感知 | loop system prompt 里有一句 wsHint（每次编排开始时读 roots） | 需升级为「当前会话绑定的工作区」 |

**关键架构判断**：会话 ↔ 工作区绑定关系应该放在 **chat-lite 的会话模型**里（每个 ChatSession 加 `workspaceId`），而不是放在 file-browser——因为「哪个对话用哪个工作区」是对话的属性。file-browser 继续当「工作区仓库」（登记/命名/浏览），chat-lite 当「绑定关系的持有者」。跨插件通信走既有事件总线，不新增宿主契约。

---

## 二、数据模型（纯插件，不动宿主）

```
file-browser（工作区仓库）
  workspace-roots.json（服务端，白名单）: [{id, path, label, builtin}]
  cap.config ns=file-browser: { activeRootId, linkedRootIds, names: {rootId: 自定义名} }

chat-lite（会话模型扩展，向后兼容）
  ChatSession + workspaceId?: string      # 该对话绑定的根 id（=服务端 roots.id）
  无 workspaceId 的旧会话 → 视为绑定 builtin workspace（零迁移）

agent-loop（执行语义）
  每次 start 时读「该会话的 workspaceId」→ 解析 roots → bash exec 带 cwd=该根
  system prompt 的 wsHint 改为会话绑定的工作区 + 全局 linkedRoots
```

**命名设计**：`names` 映射放 file-browser 的 cap.config（rename 是对「根」的操作，与浏览面板同域）；chat-lite 展示时若根有自定义名则优先显示自定义名。会话侧不复制名字，只存 id——改名后所有引用自动更新。

## 三、交互设计

### 3.1 对话侧（chat-lite）
- **会话侧栏**：每个会话项下加一行小字「📁 工作区名」（无绑定显示「默认工作区」）；
- **会话设置入口**：会话项右键/更多菜单 →「设置工作区」弹层：
  - 列出 file-browser 的所有 roots（名称 + 路径），当前绑定高亮 ✓；
  - 支持「新建工作区」快捷入口（跳文件浏览器登记，或直接输路径调 from-path——走 file-browser 暴露的 bridge）；
  - 支持「跟随全局」（清空 workspaceId，回落 builtin/全局 activeRoot）。
- **输入区上方胶囊**（复用待审批胶囊样式语言）：当前会话绑定了非默认工作区时显示「📁 {名}」；点击打开设置弹层。
- **AI 感知**：loop start 时按 sessionId 读绑定 → 解析根路径 → bash cwd 与 system prompt 都用会话级工作区。

### 3.2 工作区仓库侧（file-browser 面板）
- 根条目加「重命名」铅笔钮（服务端 roots 的 label 更新——`POST /api/fs/roots` 已支持 label 参数，补 rename 语义即可，或复用 add 的 upsert）；
- 根条目显示「N 个对话使用中」（可选，通过监听 chat-lite 广播的会话绑定快照；第一期可砍）；
- 事件补齐：file-browser 发 `workspace-renamed`（chat-lite 侧栏立即改字）。

## 四、跨插件契约（全部走既有通道）

| 通道 | 方向 | 载荷 |
|---|---|---|
| `workspace-changed`（既有） | file-browser → 众 | {activeRootId, linkedRootIds, names} |
| `workspace-renamed`（新增事件名） | file-browser → 众 | {rootId, label} |
| `session-workspace-changed`（新增） | chat-lite → 众 | {sessionId, workspaceId} （agent-bash 面板可显示「N 个对话绑定」） |
| cap.tool.fs/roots 增强 | loop/file-browser | roots 返回里带 names 合并后的显示名 |
| **桥接函数** | file-browser ← chat-lite | file-browser 需要读「会话绑定表」做统计 → 由 chat-lite setup 挂 `window.__CHAT_WORKSPACE_QUERY__`（与 __FILE_BROWSER_COMPOSE__ 同模式） |

**权限**：新增事件名进双方 manifest.events + grants 登记（构建脚本会强制校验，漏了 build 就红）。

## 五、loop 执行语义修正（比“读全局”多一步）

```
start(sessionId)：
  binding = chat-lite 会话.workspaceId ?? 'builtin'
  root = roots.find(binding)（不存在/失效 → 回落 builtin + prompt 里说明）
  exec cwd = root.path；system prompt wsHint = root 显示名 + linkedRoots
  shadow transcript 不变
```

边界：绑定的根被用户从仓库移除 → 回落 builtin 并在对话里提示一次「工作区已失效，回落默认」。

## 六、实施切分（4 批，每批可独立验收）

| 批 | 内容 | 量 |
|---|---|---|
| W1 | chat-lite 会话模型 +workspaceId；侧栏显示；loop 按会话绑定解析 cwd/prompt（回落链完备） | ~120 行 |
| W2 | 会话「设置工作区」弹层（roots 列表/跟随全局/新建快捷） + 输入区胶囊 | ~150 行 |
| W3 | file-browser 重命名（服务端 label upsert + rename 事件 + 面板铅笔钮） + 显示名合并 | ~80 行 |
| W4 | 统计/联动打磨（agent-bash 面板显示绑定数、失效回落提示、旧会话兼容断言） | ~60 行 |

**回归清单**：旧会话（无 workspaceId）行为不变；绑定 A 会话与 B 会话互不影响（bash cwd 按 start 时的会话取）；移除根后回落；改名后侧栏/胶囊即时更新；tsc + build + 浏览器 E2E。

## 七、风险与开放问题

1. **并行 AI 正在重构 chat/会话域**（git log 里已有 theme/workspace 布局树提交）——实施前必须 rebase 现状再动手，会话模型字段以最新代码为准；
2. loop 的 cwd 现在是 exec 请求参数——**服务端白名单校验已覆盖**（roots/from-path），无新增风险；
3. 多会话并发各绑不同工作区：bash exec 天然按请求 cwd，无共享态，安全；唯一要小心的是 loop 内缓存（shadow transcript）仍按 sessionId 隔离，不混工作区；
4. 「跟随全局」与「显式绑定」的优先级要在 UI 文案里写清，避免用户困惑为什么切了全局某个会话没变。
