# polaris-lite 运行时扩展 + 外部插件商城 — 分析稿（仅分析，未实施）
>
> ⚠ **已由定稿稿取代：见 [plans/runtime-extensions-and-market-final.md](runtime-extensions-and-market-final.md)**（含 §1-3 修正：外部插件 bundle 改由 /ext-plugins 自服务路由，不可复制进 dist——vite build emptyOutDir 会清掉）

> 状态：**分析稿（仅方案，未实施）** · 2026-11-20 · 仓库：polaris-lite
> 需求澄清（用户定调）：四类扩展（Skill / Hook / MCP / 插件）**全部要求运行时扩展 + 实时生效**；插件本就该支持"放到外面"（外部插件目录 / 商城），只是一直没做。
> 前序：`plans/extension-capability-pure-plugin-plan.md`（能力插件已实施）、`plans/ai-self-authoring-extensions-analysis.md`（AI 自建分析）。

---

## 1. 可行性结论（已核实代码）

**四类全部可以做到运行时扩展 + 实时生效**，无需改 CapBus/宿主加载模型：

| 扩展 | 运行时化 | 实时生效机制 | 缺口 |
|---|---|---|---|
| Skill | ✅ 已就绪 | 文件即真相：AI/用户写 SKILL.md → skill-loader 每轮扫描（mtime 缓存 5s）→ 下一轮对话进 system 附录 | 无（最多加"AI 写完自动 reload"提示文案） |
| Hook | ✅ 已就绪（差安全闸） | hook-bridge 缓存 key 含文件内容指纹，文件一变立即重载 | 建议补 workspace 级变更确认闸（防 AI 写 hook 绕审批） |
| MCP | ✅ 差一个入口 | agent-loop 每轮 `discoverTools()` → cap.tool.mcp#describe → 按需 spawn；配置写入即下轮生效 | AI/用户缺"写 mcp-servers.json 的工具面"（推荐 `mcp_server_add` 工具，走审批） |
| 插件 | ✅ **技术可行**（此前"不可行"结论仅针对"AI 运行时生成任意代码"；外部安装是另一回事） | registry.json 的 `module` 就是 URL——宿主 `loadExternalPlugins` 每次页面加载都 fetch registry → 动态 import → resolvePolicy（未登记按 `unlistedPolicy: declare` 放行+告警） | 缺**安装通道**（下载/落盘/登记/校验）与**商城源**；plugin-manager 已有 registry 双写+bump 机制可复用 |

关键事实：`public/plugins/registry.json` 的条目形如 `{id, module:"/plugins/<id>/plugin.js?v=hash", enabled, style?}`——`module` 是 URL，宿主并不关心 bundle 是 `build:plugins` 产的还是运行时装进来的。**"运行时安装外部插件"在技术上 = 取回 bundle + 写入 public/plugins/<id>/ + registry 增项 + 刷新页面**。plugin-manager 已经在运行时双写 registry（set-enabled），缺的只是 install 动作。

---

## 2. 方案：运行时插件安装 + 商城（纯插件实现）

### 2.1 新插件 `plugin-market`（商城 + 安装器 + 管理面板）

一个插件承载三件事，全部走 server 半边 + panel 槽（order 24，title「商城」）：

**A. 插件源（商城）**
- 商城清单 `index.json`：`{name, plugins:[{id, name, version, description, icon?, downloadUrl, sha256, tags?, homepage?}]}`（形态对齐主仓 marketplace/index.json 的字段习惯）。
- 源类型：本地目录（如 `D:\space\base\Polaris-plugin\dist\`——现有插件仓天然是第一个商城）、file://、http(s) URL。支持多个源（内置默认源 + 用户添加）。
- `GET /api/market/sources|list`：拉取/聚合各源清单（带缓存）；`POST /api/market/sources` 添加/删除源。

**B. 安装器（运行时）**
- `POST /api/market/install {source, id}`：
  1. 从源取插件包（zip 或目录）；校验 **sha256**（清单里带）；
  2. 解包校验：必须含 `plugin.json`（`{id, name, version, capabilities, provides, events, contributes}`——与 LiteManifest 同构的**声明子集**）与 `plugin.js`（bundle）；可选 `style.css`、`server.mjs`；
  3. 写入 **外部插件目录** `<dataDir>/plugins/<id>/`（不进 public/ 构建产物区，与内置插件物理隔离）；
  4. **server.mjs 处理**：外部插件的 server 半边不能走 `server-registry.mjs` 硬编码清单——host.mjs 装配后追加"动态 server 中间件"：读取 `<dataDir>/plugins/*/server.mjs`（存在则 import），失败 fail-fast 该插件。这一步是唯一需要动 `server/host.mjs` 装配逻辑的点（纯增量，不动既有链）。
  5. 更新 `public/plugins/registry.json` + `dist/plugins/registry.json`（复用 plugin-manager 的双写 + `?v=` bump），`enabled` 默认 true；
  6. 返回结果；**前端提示"刷新页面生效"**（registry 是页面加载时拉的，刷新即装）。
- `POST /api/market/uninstall {id}`：删目录 + registry 移除 + 刷新生效。
- 卸载/停用语义对齐 plugin-manager：启用/停用改 registry.enabled 即可（已有能力）。

**C. 管理面板（panel 槽）**
- 页签一「商城」：源列表 + 插件卡片（版本/描述/哈希/安装按钮/已安装标记）；
- 页签二「已安装」：外部插件列表（启停复用 plugin-admin、卸载、更新检查——源上 version 更高即提示）；
- 页签三「说明」：外部插件的能力边界（无宿主源码权限、cap 需 grants 登记或按 declare 放行、server 半边隔离等）。

### 2.2 外部插件的信任模型（关键设计）

1. **sha256 校验**：商城清单必须带包哈希，安装时强校验（防传输篡改）。
2. **来源分级**：内置默认源（自家插件仓构建产物）= 可信；用户添加的 http 源 = 安装时面板红字提示 + 逐个确认。
3. **cap 权限**：外部插件未登记 grants 时按现有 `unlistedPolicy: declare` 放行（manifest 自声明）+ 界面明示"未登记插件，权限自声明"。更严格可选项：安装时把其 manifest 写进 grants（升级 grants version）——二选一，建议 P1 先用 declare + 醒目告警，P2 再做登记制。
4. **server 半边隔离**：外部 server.mjs 与内置同权（同进程中间件）——这点要在面板明示"外部插件的 server 代码与宿主同进程运行，请只安装可信来源"。进程隔离（像主仓 supervisor）是 P3 可选加固，不建议首期做。
5. **AI 自建插件**的口子：如果要让 AI 走这条通道，等价于"AI 产出 bundle+manifest → 用户在商城面板点安装"（人工过闸）。不建议给 AI 直接 install 的工具面。

### 2.3 四类扩展的"运行时 + 实时"总表（实施后）

| 扩展 | 谁创建 | 运行时安装 | 实时生效 |
|---|---|---|---|
| Skill | 用户/AI（files_write 写 ws 内目录）| —（文件即装） | ✅ ≤5s / 下轮对话 |
| Hook | 用户/AI（编辑 settings.json 或经导入） | —（文件即装） | ✅ 立即（内容指纹重载）|
| MCP | 用户（MCP 面板）/ AI（mcp_server_add 工具，走审批）| —（配置即装） | ✅ 下一轮对话工具列表 |
| 插件 | 用户从商城装 / 开发流构建 | ✅ plugin-market 安装器 | ✅ 刷新页面即加载（server 半边随宿主下次启动挂载，见 §2.4）|

### 2.4 一个需要说清的"实时"边界

- **前端半边**（views/panel/cap 注册）：刷新页面即生效（registry 每次加载都拉）。
- **server 半边**（中间件）：宿主进程启动时装配（`server/host.mjs` 顶层 await）。运行时新装外部插件的 server.mjs 要么 (a) 提示"重启服务生效"，要么 (b) 在 host.mjs 增加动态挂载通道（把 `pluginMiddlewares` 从静态数组改为可追加的动态链——中等改动）。建议首期 (a)，P2 再做 (b)。

---

## 3. 实施切分（供拍板，本期不做）

| 期 | 内容 |
|---|---|
| P0 | hook 变更确认闸（前稿遗留）+ mcp_server_add/remove 工具（AI 自建 MCP）+ 商城清单格式定稿 |
| P1 | plugin-market 插件：源管理 + 安装/卸载/更新 + 面板（商城/已安装/说明）+ 外部插件目录隔离 |
| P2 | 动态 server 中间件挂载（装完即用不重启）；grants 登记制（安装时写授权）；AI 产出插件的人工过闸流程文档 |

每期照例：typecheck / check:plugins / npm test / build:plugins 全绿 + 真实外部插件（拿现成插件打 zip）安装冒烟。
