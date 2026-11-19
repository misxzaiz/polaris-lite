# 文件浏览器插件分析（file-browser-analysis）· 仅分析未实施

> 需求：一个简单的文件浏览器插件；服务于后续 AI 对话「选择工作区 / 关联工作区」；要考虑盘符选择；并要求比需求原文想得更远。
> 日期：2026-11-19。前置事实全部实读自当前代码。

---

## 0. 现状关键事实（决定方案的约束）

| 事实 | 出处 | 影响 |
|---|---|---|
| bash 工具 cwd **硬锁** `<dataDir>/workspace`，越界 403 | server/tool-exec.mjs:267 EXEC_CWD_ESCAPED | 「工作区」不只是 UI 概念——选区必须落到这个根，否则 bash 读不到 |
| 服务端已有统一鉴权/路由模式（`GET/POST /api/xxx`，cookie 硬门禁，providers-api 是样板） | server/providers-api.mjs | 文件 API 照此模式新增中间件，**唯一宿主改动 = host.mjs 挂链 2 行**（与 tool-exec 同例） |
| 宿主已有「视图贡献」体系（ViewDescriptor/viewType 前缀校验/defaultAnchor），并行 AI 刚落地 workspace 布局树 | src/core/workspace/viewRegistry.ts | 浏览器面板可作为视图挂进布局树，**零宿主改动** |
| AI 工具发现协议已存在：`cap.tool.*` + describe + tool-registered | agent-loop discoverTools | 将来「读文件工具」可无缝进 loop；bash 已能读写，但**大文件/二进制**它处理不了 |
| 该宿主跑在公网穿透（120.79.164.155:9825，用户当前正开着） | in-app browser | **盘符级暴露在公网 = 不可逆灾难**，安全设计是第一议题 |
| dataDir 由 PLITE_DATA_DIR 决定；provider key/auth-owner 均在 dataDir 下 | vite.config/prod-server | 读文件 API 必须把 `<dataDir>/**`（providers.json/auth-owner.json/tool-exec.json/审计日志）列为禁区 |

## 1. 命名与定位

**file-browser** 插件（显示名「文件」）。三个角色一肩挑，但分层清晰：

1. **人用浏览器**：panel 视图（树 + 面包屑 + 文件预览），人浏览、人选工作区；
2. **会话工作区状态的持有者**：当前工作区根（activeRoot）+ 关联列表（linkedRoots）的唯一权威，广播 `workspace-changed` 事件；
3. **AI 通道**：提供 `cap.tool.fs`（第一批动作 list/read），并消费「工作区」语义——loop 的 bash 调用自动带 cwd=activeRoot。

## 2. 核心概念：工作区根（Workspace Root）

### 2.1 三层结构（从需求「盘符选择」展开）

```
盘符层  [C:] [D:] [E:]（服务端枚举，只读，永不可设为工作区）
   │
根层   workspace（内建默认，<dataDir>/workspace，AI 默认 cwd）
       + 用户添加的「工作区根」：如 D:\projects\polaris-lite、D:\space\base
   │
内容层  浏览树只在「根」之下展开；跨根不可越界（服务端按根校验 path）
```

- **盘符 ≠ 工作区**：盘符只是导航起点（进盘符后只能看，要「选为工作区」必须落在目录上）。直接把 C:\ 设为工作区等于把整台机器交给 AI——服务端拒绝根过浅的目录（可配置最小深度，默认禁止盘符一级）。
- **root 的持久化**：`<dataDir>/workspace-roots.json`（服务端持有，0600 原子写，同 provider-store 模式）。activeRoot/linkedRoots 属于会话偏好，存 config-manager（前端 localStorage）即可，**服务端只管 roots 白名单**。

### 2.2 安全模型（与 bash 工具同构，裁决权在服务端）

| 层 | 规则 |
|---|---|
| API 门禁 | 会话 cookie 硬门禁（照抄 tool-exec ①） |
| 根白名单 | **只有登记过的 root 才可列目录/读文件**（服务端 resolve 后逐一前缀匹配 + `sep` 精确判断，防 `..`/junction/符号链接逃逸——realpath 校验） |
| 永久禁区 | `<dataDir>/**`（凭据/配置/审计）、系统目录（Windows/Program Files/System32）、其他盘的 `**\.polaris-lite`——即使被登记为 root 也硬拒 |
| 写权限 | **第一期不做写**。read/list/预览 + 选择/关联，全部只读。写入走既有 bash 工具（有审批/审计/denylist 全套），不再造第二套写通道 |
| 大小/深度限 | 单文件预览 ≤512KB（>则只显示元信息+提示用 bash 取片段）、目录单次 ≤500 项、树深度 ≤12 |
| 公网形态 | `PLITE_FS=0` 一键禁用（同 PLITE_TOOL_EXEC 先例）；公网部署建议禁用或只保留默认 workspace 根 |
| 审计 | list/read 各落一行（rootId/path/size/耗时）到 `fs-audit.log` |

### 2.3 服务端 API（新文件 `server/fs-api.mjs`，host.mjs +2 行装配）

```
GET  /api/fs/roots        → { roots: [{id, path, label, builtin}] }        # 登记表
POST /api/fs/roots        → 添加 root（path + label）；校验：存在/是目录/不在禁区/非盘符一级
POST /api/fs/roots/remove → 移除（builtin workspace 不可移除）
GET  /api/fs/drives       → 盘符列表（Windows：遍历 A-Z existsSync；跨平台：根 '/'）
GET  /api/fs/list         → { rootId, path } → { entries: [{name, isDir, size, mtime}] }（按根校验）
GET  /api/fs/read         → { rootId, path } → 文本内容（≤512KB）或二进制 base64（≤1MB，白名单扩展名）
GET  /api/fs/stat         → 单项元信息（预览前探测）
```

读文件不提供 POST/流式——保持中间件自包含（与 relay/providers 同风格，不引 WS）。

### 2.4 插件形态

```
plugins/file-browser/
  index.ts        # manifest + cap.tool.fs handler（list/read/roots）
  Panel.tsx       # 浏览器视图：盘符条 → 根选择器 → 树/网格 + 面包屑 + 预览抽屉
  roots.ts        # 前端 roots/activeRoot 状态 + workspace-changed 广播（复用 cap.config 存偏好）
  fs.css
provides: ['cap.tool.fs']
capabilities: ['cap.config']            # 存 activeRoot/linkedRoots 偏好
events: ['tool-registered', 'workspace-changed']
contributes: { slots: [{ slot: 'panel', component: 'FileBrowserPanel', order: 4 }] }
（或经 ViewDescriptor 挂布局树——两种宿主出口都已可用，选 slot 更简单）
```

## 3. 与 AI 对话的联动（需求正文，但要做对语义）

### 3.1 选择工作区 = 改 activeRoot，联动三方

```
用户在浏览器点「设为工作区」
  → file-browser 写偏好（cap.config ns=file-browser key=activeRoot）+ emit workspace-changed
  → agent-loop 监听：更新 system prompt（"当前工作区是 X，bash cwd 即此处"）
    并在后续 exec 请求里带 cwd=activeRoot（服务端 roots 白名单内放行——
    **tool-exec 的 cwd 校验需从「仅 workspace」扩展为「roots 白名单」**：这是唯一
    需要动的既有服务端逻辑，约 15 行，属安全边界扩展必须服务端裁决，无法插件化）
  → agent-bash 面板显示当前工作区路径（监听同事件）
```

### 3.2 关联工作区（linkedRoots）= 多根只读上下文

- 一批可勾选的「参考目录」：AI 能 list/read（经 cap.tool.fs），但 **bash cwd 不变**；
- 语义：activeRoot 是「可写操作区」（bash 落点），linkedRoots 是「只读素材区」。这个区分比单一 workspace 重要——防止 AI 把参考项目目录当工作区乱改；
- loop 的 system prompt 里列出：「工作区 X（可执行操作）；关联只读 Y、Z」。

### 3.3 cap.tool.fs（AI 的文件眼睛，bash 的补充）

| 动作 | 说明 |
|---|---|
| `roots` | 返回 roots + 哪个 active 哪些 linked（模型空间感知） |
| `list` | 列目录（参数 rootId/相对 path） |
| `read` | 读文本文件（≤512KB 截断标记）；参数支持 head/tail 行数（大文件自取片段） |

danger 分级 `read`。**刻意不提供 write**——写经 bash（已有审批），保持单一写路径；也避免 loop 里两条写通道审批策略打架。

### 3.4 文件 → 对话的快捷动作（人用）

预览抽屉里放「插入对话」按钮：把文件名/相对路径/片段注入输入框（复用 chat-lite 的 onCompose 通道，零新契约）。后续可加「把此目录作为本次提问的上下文」。

## 4. 我替你多想到的问题

1. **盘符枚举的跨平台**：Windows 遍历盘符 OK；Linux/Docker 下 `/` 单根——drives 接口返回挂载点（`/` 起步），UI 同一套面包屑即可，不搞平台分支组件。
2. **junction/符号链接逃逸**：roots 校验必须 `realpathSync`（Windows junction 会骗过字符串前缀匹配——Polaris 主仓实测踩过 junction 变质坑）；list/read 每次也 realpath 后再验界。
3. **root 被外部移动/删除**：list 时 ENOENT → 返回友好错误，面板标灰提示重设；roots 列表启动时校验存活但不自动删（用户可能只是临时拔盘）。
4. **同名目录多盘共存**：root 有服务端生成的稳定 id（`r-<hash>`），UI 显示 label（默认目录名+盘符），避免用户改目录名后断链。
5. **预览的文件类型安全**：文本统一按 UTF-8 读 + 换行规范化；二进制只白名单（png/jpg/pdf 预览后续期）；`.html` 预览必须**纯文本渲染**（防本地文件 XSS 打 cookie——innerHTML 严禁，与 Polaris amber 的教训同源）。
6. **大目录性能**：单次 500 项分页 + 前端虚拟滚动不做（lite 不引库，靠分页即可）；不递归统计目录大小（慢且无意义），size 只对文件显示。
7. **与并行 AI 的 workspace 布局树**：浏览器视图可被 cap.ui.layout 摆位，但「文件浏览器的工作区 roots」与「布局树 workspace」是两个正交概念——命名必须区分（布局文档里用「视图树」，文件插件用「工作区根」），否则后人必混。
8. **AI 上下文里的路径语义**：给模型的 path 一律相对 root（`projects/app/index.ts`），完整盘符路径不出现在 prompt——省 token 且降低模型把绝对路径写进输出的倾向；bash 的 cwd 错觉由 loop 负责。
9. **workspace-roots.json 与 grants 的边界**：roots 白名单是**运行时数据**（服务端文件），grants 是**能力授权**（静态审计）——登记 root ≠ 授予任何 cap，别把两者耦合。
10. **最小可用裁剪**：第一期砍掉 linkedRoots 也完整可用（单 activeRoot + 浏览 + AI read）；linkedRoots 是第二期 5 行量级的增量，不阻塞。

## 5. 实施分期与改动面

| 期 | 内容 | 改动 |
|---|---|---|
| P1 | `server/fs-api.mjs`（roots/list/read/drives + 全套安全）+ host.mjs 挂链 | 服务端 ~200 行（唯一宿主接触点） |
| P2 | file-browser 插件：面板（根条/树/面包屑/预览）+ roots 状态 + workspace-changed | 插件 ~400 行 |
| P3 | 联动：tool-exec cwd 白名单化（15 行）；loop 监听 workspace-changed 更新 system prompt 与 exec cwd；agent-bash 面板显示当前工作区 | ~60 行 |
| P4 | cap.tool.fs 进 loop 工具集 + 「插入对话」快捷动作 + linkedRoots | ~150 行 |

**总计约 800 行；宿主改动仅 host.mjs 2 行 + tool-exec 15 行白名单化**，其余全在插件与服务端新文件（与 bash 工具同先例：进程/文件系统属平台设施，业务在插件）。

**风险首指**：公网 + 盘符浏览的组合。建议 P1 就带上 `PLITE_FS=0` 开关与 dataDir 禁区，且默认只读——上线公网前用户必须意识到「任何能登录的人可以浏览你登记的目录」。
