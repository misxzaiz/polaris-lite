# polaris-lite 运行时扩展体系 + 外部插件商城 — 定稿实施规划 v2

> 状态：**定稿（技术点全部核实，待实施）** · 2026-11-20 · 仓库：polaris-lite
> 取代：`plans/runtime-extensions-and-market-analysis.md` 与 `plans/ai-self-authoring-extensions-analysis.md`（二者合并升级为本稿；skill/hook/mcp 部分结论不变，插件商城部分有一处**修正**，见 §1-4）。
> 用户定调的需求：四类扩展（Skill/Hook/MCP/插件）全部**运行时创建 + 实时生效**；插件支持**外部安装**（商城），不再绑定构建期产出。

---

## 1. 技术核实结论（本轮新增 5 项，全部代码级确认）

1. **files_write 围栏覆盖 AI 自建面**：写路径校验允许"内建 workspace 与任一已登记根"（agent-files/server.mjs:91,141）——`<ws>/.claude/skills/` 与 `<ws>/.claude/settings.json` 都在围栏内，AI 用现有 `files_write` 工具即可自建 Skill 与 Hook，无需新写面。
2. **registry 双写 + `?v=` bump 机制现成可复用**（plugin-manager/server.mjs：改 enabled 时 `currentVersion(id)` 重写 module URL）——安装器只需按同一惯例插入新条目。
3. **【修正前稿】外部插件 bundle 不能复制进 dist/public**：① prod 静态服务有 realpath 路径穿越严防，只服务 dist；② **vite build 默认 emptyOutDir 会清空 dist**——复制进去的外部插件下次构建即被清掉。
   → **定稿方案 B**：plugin-market server 半边提供 **`/ext-plugins/<id>/plugin.js|style.css` 自服务路由**（从 `<dataDir>/plugins/<id>/` 读文件 + 穿越校验 + MIME + no-store），registry 的 `module` 指向该 URL。隔离、dev/prod 一致、不受构建清空影响。
4. **外部插件 server 半边首期不动态挂载**：host.mjs 装配是启动期顶层 await；首期装完提示"重启服务生效"（前端半边刷新即生效），动态挂载列 P3。
5. **未登记插件按 `unlistedPolicy: declare` 放行**（policy.ts:61，现值为 declare）——外部插件装完即可跑，grants 登记制列 P2 增强。

---

## 2. 定稿架构

```
运行时扩展四通道（全部实时/近实时）：
┌─────────────────────────────────────────────────────────────┐
│ Skill   AI/用户 files_write 写 <ws>/.claude/skills/<n>/SKILL.md │ → skill-loader 5s 缓存 → 下轮对话进附录 ✅
│ Hook    AI/用户 files_write 编辑 <ws>/.claude/settings.json#hooks│ → 内容指纹缓存 → 立即重载 ✅
│ MCP     AI 用 mcp_server_add 工具（审批+审计）│ 用户在 MCP 面板   │ → 写 mcp-servers.json → 下轮 discoverTools ✅
│ 插件    用户在商城面板安装（sha256 校验）                       │ → 刷新页面加载前端半边 ✅（server 半边重启生效，P3 免重启）│
└─────────────────────────────────────────────────────────────┘
新插件 2 个：ext-tools（AI 的 MCP 自建工具面）+ plugin-market（商城/安装器/面板）
新能力   1 项：hook 变更确认闸（hook-bridge 内）
```

## 3. 分期实施（P1 → P2 → P3，每期门禁全绿一个 commit）

### P1 — AI 自建三通道补齐（改动最小，收益立得）
| # | 内容 | 文件 | 验收 |
|---|---|---|---|
| 1.1 | `mcp_server_add` / `mcp_server_remove` / `mcp_server_list` 工具（describe/exec 协议，danger='execute'，exec 内部调 /api/mcp/servers 既有校验与写配置） | mcp-bridge/index.ts | AI 会话实测：说"帮我加个 MCP server"→ 审批 → 配置落盘 → 下轮工具列表出现 `mcp__<新>__*` |
| 1.2 | hook 变更确认闸：workspace 级 hooks 规则集（含 hooks-import.json）首次出现需面板确认（内容指纹存 kv），未确认只审计不执行 | hook-bridge/server.mjs + 钩子台面板加确认按钮 | 写入新 hook → 未确认时 preToolUse 返回 allow + warns 提示；面板确认后立即生效 |
| 1.3 | 系统提示附录补"自建扩展操作法"一段（skill 写法/hook 写法/mcp 工具用法各一行） | skill-loader/server.mjs buildAppendix | 附录文本含操作指引 |
| 1.4 | grants 同步（mcp-bridge 若新增 cap 需 manifest∩grants 双补） | index.ts + grants.json | check:plugins 通过 |

### P2 — plugin-market 商城（外部插件运行时安装）
| # | 内容 | 验收 |
|---|---|---|
| 2.1 | 商城清单格式定稿：`{name, plugins:[{id,name,version,description,downloadUrl,sha256,tags?}]}`；默认源指向 Polaris-plugin 仓构建产物目录（本地 file 源）；`GET/POST /api/market/sources` | 源增删改查；清单聚合（带缓存） |
| 2.2 | 安装器 `POST /api/market/install {source,id}`：下载→sha256 强校验→解包校验（必须含 plugin.json 声明子集 + plugin.js；拒绝路径逃逸/绝对路径）→落 `<dataDir>/plugins/<id>/`→registry 双写增项（module=`/ext-plugins/<id>/plugin.js?v=hash8`）→返回"刷新生效" | 拿 Polaris-plugin 现成插件打 zip 实测安装成功；恶意包（哈希不符/缺 manifest）被拒 |
| 2.3 | `/ext-plugins/<id>/*` 自服务路由：读 `<dataDir>/plugins/`，realpath 穿越校验、MIME 表、no-store；vite dev 与 prod 均通 | 刷新页面外部插件加载、cap 注册、面板出现 |
| 2.4 | 卸载 `POST /api/market/uninstall`（删目录+registry 移除）；更新检查（源 version > 本地即提示） | 卸载后刷新即消失；更新流程走 install 覆盖 |
| 2.5 | 商城面板（panel 槽 order 24「商城」）：源管理/插件卡片（版本/哈希/安装态）/已安装列表（启停复用 plugin-admin、卸载、更新提示）/说明页（信任模型红字：外部插件与宿主同进程） | E2E：装→用→停→卸全链 |
| 2.6 | 测试：market-config（清单解析/哈希校验/逃逸拒绝）、market-install（真 zip 安装）、ext-plugins 路由（穿越拒绝/404）三个 test.mjs | 全绿 |

### P3 — 增强（按需立项）
- 外部插件 server 半边**动态挂载**（host.mjs 中间件链改可追加）：装完即用免重启；
- grants **登记制**：安装时把 manifest 写进 grants（升 version），关掉 declare 放行；
- 商城源 http 化 + 多源聚合页面分页/搜索；
- AI 产出插件源码→打包→用户点装的人工过闸流程文档与脚本。

## 4. 风险与边界（定稿声明）

1. **外部插件与宿主同进程**（前端 bundle 动态 import + server 中间件同进程）——面板红字明示"只装可信来源"；sha256+源分级（本地默认源可信/外部 http 源逐个确认）是对冲。
2. **hook 确认闸**是 AI 自建 hook 的安全前提（AI 可写 hook 绕审批），P1 必须先于/同批于"宣传 AI 可自建 hook"落地。
3. **mcp_server_add 属危险工具**：审批走 agent-loop 既有 confirm 链（danger='execute'），服务端二次校验 command 合法性，全程审计。
4. 插件 **server 半边首期重启生效**——面板如实提示，不伪装即时。
5. build 清空 dist 的坑已用 `/ext-plugins` 自服务路由规避（§1-3）。

## 5. 与既有成果的关系

- P0–P2 能力插件（skill-loader/hook-bridge/mcp-bridge/zcode-compat）+ 三管理面板 + read_skill/safeArgs/[object Object] 修复全部保留不动；
- 本规划的 P1 在其上加两个小插件+一个闸；P2 加一个插件；宿主 core 仍零改动（host.mjs 动态挂载在 P3 才触碰）。
