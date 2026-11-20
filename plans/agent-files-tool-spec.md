# polaris-lite AI 文件编辑工具（agent-files）— 方案

> 状态：方案稿（待确认后实施）
> 日期：2026-11-20
> 落点：`D:\space\base\polaris-lite`（9825），**不是** Polaris 插件仓
> 背景：此前误把该需求做成 Polaris 宿主插件 shell-plus（已交付但 polaris-lite 不认）。本方案纠正落点。

## 一、现状（读码实证）

polaris-lite 的 AI 工具链：

```
模型 ── agent-loop（cap.agent.loop 编排器）
          │  discoverTools(): cap.meta/list → 过滤 cap.tool.* → /describe
          │  组装 OpenAI tools；按 name 排序 + 指纹缓存（稳定 tools 集合保 prompt 缓存）
          ▼
   cap.tool.bash   agent-bash   exec 语义（POST /api/tool/exec；服务端裁决三档审批+
                                 denylist+cwd 锁+审计；输出 64KB 头尾保留）
   cap.tool.fs     file-browser 动作语义（roots/list/read 只读；GET /api/fs/*；
                                 roots 白名单 + realpath 防逃逸 + 审计）
   cap.tool.render / cap.tool.ledger / cap.tool.browser / cap.interactive …
```

关键机制（决定新插件怎么写）：
- **工具发现**：agent-loop 启动时 `cap.meta/list` 过滤 `cap.tool.*`，逐个 `describe` 拿 `{name, description, parameters, danger}`；另监听 `tool-registered` 事件兜底。
- **执行分发**：agent-loop 对每类工具有特化分支（fs/ledger/browser/render/interactive 走动作语义，bash 走 exec 语义 + `approved:true`）。
- **审批**：`decideApproval` 按服务端模式（confirm/allowlist/yolo）；confirm 模式弹审批卡，支持「本会话信任」沉淀；120s 无人审批自动拒绝并给 AI 继续指令。
- **服务端半边**：`plugins/server-registry.mjs` 登记一行 `{id, entry}`，宿主 host.mjs 装配；新后端插件=写 `plugins/<id>/server.mjs` + 登记一行，宿主零改动。
- **前端构建**：`plugins/build-plugins.mjs` 的 `plugins` 数组加一行；fail-fast 校验 id 一致、grants 登记、provides 覆盖 requires。
- **权限**：`public/grants.json` 声明 capabilities/provides/events；构建期校验申请 ⊆ 授权。

## 二、缺口

- `files` 工具只读（roots/list/read），**没有 write/edit**——写文件全靠 bash 命令凑（`echo >`、`Set-Content` 等），模型易踩转义/编码/行尾坑，也没有精确替换语义。
- 无 `read_file`（带行号定位）、`edit_file`（精确 old_string 替换）、`apply_patch`（多文件补丁）这类结构化编辑工具。

## 三、方案：新增 `agent-files` 插件（写/编辑面）

沿用 file-browser 的「前端薄壳 + 服务端实核」双入口形态：

### 3.1 服务端半边 `plugins/agent-files/server.mjs`

- `POST /api/files-write/exec`（动作语义：write/edit/patch；describe 走前端 cap）
- 安全模型（对齐 agent-bash 既有红线）：
  - 会话 cookie / 本地 Bearer 门禁（同 agent-bash ①）
  - 路径锁定：内建 workspace + workspace-roots.json 已登记根（realpath 防逃逸，同 agent-bash ⑥；file-browser 的 roots 白名单同一份文件，天然一致）
  - 二进制扩展名拒写（BINARY_EXT 同款清单）
  - 单文件大小上限（写 2MB / patch 总量 4MB）
  - edit_file 冲突检测：登记 read 时的 mtime，写前不符则拒绝（防覆盖外部修改）
  - 全量审计落 `files-write-audit.log`
  - `PLITE_FILES_WRITE=0` 一键整体禁用
- 审批：danger 标 `write`，走 agent-loop 既有 decideApproval（confirm 模式下弹卡；yolo/allowlist/会话信任放行）。服务端不做二次审批（与 bash 的 approved 语义一致——服务端只做门禁+边界+审计）。

### 3.2 前端 `plugins/agent-files/index.ts`

- `cap.tool.files-write` 能力：describe + exec 两动作（形态同 agent-bash 的 handler）
- 工具描述（一个工具多动作，参数 `action: write|edit|patch`；命名 `files_write` 避免与只读 `files` 混淆）：
  - `write_file`：path + content；建父目录；保持既有行尾（CRLF 探测同 shell-core 逻辑）
  - `edit_file`：path + old_string + new_string + expected_replacements?；唯一性校验、0 命中给最近行提示（相似度算法同 shell-core）、多命中要求 expected
  - `apply_patch`：codex V4A 信封（Add/Delete/Update/Move to），锚点+子序列匹配，多文件一次提交
- 面板：极简（模式开关透传服务端配置 + 审计尾几条），slot order 靠后

### 3.3 装配清单（三处登记）

1. `plugins/build-plugins.mjs` `plugins` 数组 +`{ id: 'agent-files', ... order: 19 }`
2. `plugins/server-registry.mjs` `SERVER_PLUGINS` +`{ id: 'agent-files', entry: './agent-files/server.mjs' }`
3. `public/grants.json` `plugins['agent-files'] = { capabilities: ['cap.config'], provides: ['cap.tool.files-write'], events: ['tool-registered'] }`；并给 `agent-loop.capabilities` 追加 `cap.tool.files-write`

> agent-loop 的工具执行分发需要加一个 `cap.tool.files-write` 分支（动作语义透传，形态同 ledger/browser 分支）——这是宿主编排器唯一要动的点；也可以评估并入通用 exec 形态（服务端 exec 动作），则 agent-loop 零改动。**取舍**：走通用 exec 形态（`POST /api/files-write/exec`，action 进 payload），agent-loop 完全不用改，风险最小，定这个。

### 3.4 测试

- 纯函数单测：行尾保持、edit 唯一性/多命中/0 命中提示、patch 解析（Add/Delete/Update/Move/锚点）、路径边界（越界/绝对路径/..）
- 服务端集成：node:test 起假 req/res 或直接函数调用——门禁 401、禁用 403、越界 403、写读往返、edit 冲突拒绝、patch 多文件、审计落行
- 构建：`npm run build:plugins` fail-fast 全链路（grants 一致性）
- 真机：9825 起会话让 AI 实际调用三工具

## 四、不做（显式）

- 不动 Polaris 主仓 / Polarision 插件仓（shell-plus 已在彼处交付，与本方案无关）
- 不做删除/移动目录级工具（bash 已覆盖，避免重复危险面）
- 不做后台任务管理（polaris-lite bash 是同步短任务模型）
