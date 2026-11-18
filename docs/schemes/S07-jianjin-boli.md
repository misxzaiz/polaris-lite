# S7 渐进剥离：从 Polaris HEAD 分阶段瘦身

> 矩阵第 7 格：**S7 渐进剥离**。不新建仓库从零写，而是把 Polaris 主仓（HEAD `ff386fad`）作为起点，制定多阶段剥离计划，每阶段产出可运行、可验证的版本，最终收敛为 polaris-lite。剥离对象、批次编号、已完成批次均沿用 `D:\space\base\Polaris\plans\core-slimdown-plugin-extraction-plan.md`（下称 core-slimdown 总纲）——那是本仓已在跑的同一套剥离工程，本方案是它的「终局形态」：把最后一批该剥的（AI 对话后端、存储、代理、工具引擎）也剥完，主仓收敛为纯宿主核，即 lite。
>
> 已验证事实：git、scheduler、browser、IM、translate、语音、LSP、PRD、Agnes、Requirement、PersonalHub、Computer、Pet 等域已完成出仓/移除（commit 可查）；chat-desk 插件已接管 mainSurface 对话席（22,310 行，`mainSurface`/`chat.main`/`slotMode:"shadow"`）；LeftPanel 全部席位已插件化。**主仓仍剩约 101k 行 Rust + 50k 行 TS，其中约 60% 是 AI 对话后端与工具引擎**——S7 要剥的就是这最后 60%。

---

## 0. 差异化定位声明

| 维度 | S7 的回答 |
|---|---|
| 与其他 9 方案的本质区别 | 唯一**不在新建仓库写代码**的方案：起点就是 Polaris HEAD 本身，工作内容是「删 + 摘 + 迁」，每个阶段都是一次已验证过套路的重复执行 |
| 核心形态 | Polaris 主仓本身，剥离完成后重命名/重定位为 polaris-lite |
| AI 对话 UI | 已由 chat-desk 插件完成（mainSurface shadow 席位），S7 只需收尾宿主侧残留（对话工具渲染 utils、aiEventBus 上的业务块） |
| 插件机制 | **原样沿用** Polaris manifest + plugin-system + RouterBus，不新设计契约；新增的只有「剥离清单」这个工程文档 |
| 前端栈 | React + Zustand + Vite 原栈原样保留，零迁移 |
| 风险特征 | 最低——每一步都踩在前一个已完成出仓域的脚印上；代价是终点形态受历史包袱约束（详见 §10 风险） |

---

## 1. 架构图：起点 → 终点演进（文字图）

```
【起点：Polaris HEAD ff386fad】
┌────────────────────────── polaris（单仓 monolith）──────────────────────────┐
│ 前端 src/ 49.8k 行                                                          │
│  ├─ App.tsx/Layout 壳（席位骨架，已空壳化）←── 保留                          │
│  ├─ plugin-system（席位/overlay/uiSlot/面板加载）←── 保留                    │
│  ├─ stores 37 个（fileExplorer 804 / fileEditor 587 / tab 500 …业务残留）    │
│  ├─ utils toolConfig(974)/toolSummary(852)/mermaid-config(417) ←── 业务渲染  │
│  └─ types chat(832)/aiEvent(1303)/browserContext/scmDiff/terminalScript …   │
│ 后端 src-tauri 101.0k 行                                                    │
│  ├─ router/mod.rs(1786) + 34 capability ←── cap 总线，保留                  │
│  ├─ plugin_service(2904)/supervisor(2169)/mcp_config_service(1874) ←── 保留 │
│  ├─ ai/ 21.5k（claude.rs 1772 + simple_ai 10.1k + plugin_engine 2.6k）       │
│  ├─ services/ai_chat_core 3.0k / storage_exec 5.9k / proxy 5.0k             │
│  ├─ services/computer_control 0.9k / ask_listener 1.9k / form 1.6k          │
│  │   / nexus_pipeline 1.1k / context_core 0.4k / mcp_* 2.9k                 │
│  └─ commands/file_explorer 1227 / dialog_storage 776 / terminal 647 …       │
└────────────────────────────────────────────────────────────────────────────┘
        │  P0~P6 阶段：每阶段 = 一次「cap 化 → 插件承接 → 主仓删码 → 验证」
        ▼
【中间态示例：P3 完成后】
┌──────────── polaris-lite 骨架 ────────────┐   ┌─ Polaris-plugin 仓（承接方）─┐
│ 前端 ~32k：壳 + plugin-system + 通用 store │◄──│ chat-desk（已有）            │
│ 后端 ~55k：总线 + 插件系统 + ai_chat_core  │   │ ai-runtime-desk（新，P3）    │
│            + storage_exec + proxy          │   │ storage-desk（新，P4）       │
│ 仍含：AI 业务核、引擎、代理（待剥）          │   │ proxy-desk（新，P5）         │
└──────────────────────────────────────────┘   └─────────────────────────────┘
        │  P7~P8 阶段：收口 + 更名
        ▼
【终点：polaris-lite】
┌──────────── lite 核心（~38k 行）───────────┐   ┌─ 插件仓（不变）──────────────┐
│ 前端 ~25k：Layout 壳 + plugin-system        │◄──│ chat-desk / ai-runtime-desk  │
│   + transport/theme/i18n/config + 通用 store│   │ storage-desk / proxy-desk    │
│ 后端 ~13k：RouterBus + 20 个通用 capability │   │ files-desk / polaris-git / … │
│   + 插件生命周期 + web 桥 + 数据根           │   │ （157 个，全部外置）          │
│ 零业务：无 Chat/引擎/存储/代理/工具实现       │   └─────────────────────────────┘
└──────────────────────────────────────────┘
```

**不变量**（贯穿所有阶段）：`router_dispatch` 入口、cap id 命名、chat-event 事件流、plugin.json schema、mainSurface 席位机制、数据根路径规则——全部不动。插件与宿主之间的既有契约是剥离心智的「安全带」：只要契约在，删哪层实现都不破坏对端。

---

## 2. 各阶段目录树

### 2.1 起点（Polaris HEAD，现状，实测行数）

```
polaris/（即未来 polaris-lite，先在主仓分支上作业）
├── src/                          # 49,794 行 TS/TSX（279 文件）
│   ├── App.tsx(522) main.tsx(250)
│   ├── components/
│   │   ├── Common/               # 3,729 行：Layout/Modal/Toast/ErrorBoundary…【留】
│   │   ├── Layout/               # 2,555 行：ActivityBar/LeftPanel/CenterStage/RightPanel【留】
│   │   ├── Plugins/              #   268 行：PluginPanelHost【留】
│   │   ├── TopMenuBar/           #   458 行【留】
│   │   ├── Preview/ UiFrame/     # 1,322 行：chart/模板渲染【P6 剥→cap.ui.render 归插件】
│   │   ├── FocusMode/ Notification/ Workspace/  #   274 行【留/小删】
│   │   └── Chat/                 # 已删除（worktree 有 104 文件 26.9k 参照）【无需再动】
│   ├── plugin-system/            # 5,524 行：registry/schema/loader/bridge【留，P7 收窄 appCoreBridge】
│   ├── services/                 # 12,369 行
│   │   ├── transport/ themeEngine/themeService/merger   #【留】
│   │   ├── tauri/                # chatService 等 1,292 行薄包装【留】
│   │   ├── aiEventBus.ts(472) eventBus.ts(111) uiDispatchService(348)【留】
│   │   ├── pluginDiscoveryService(831)/pluginServiceManager(183)【留】
│   │   └── editorScmService(227)/diffService(205)【P2 剥→polaris-git 已承接】
│   ├── stores/                   # 7,427 行 / 37 文件
│   │   ├── fileExplorerStore(804) fileEditorStore(587) tabStore(500)【P2 剥→files-desk】
│   │   ├── configStore(416) themeStore(305) workspaceStore(323) viewStore(378)
│   │   ├── toastStore pluginStore overlayStore uiSlotStore capCatalogStore…【留】
│   │   └── sessionConfigStore(172) inputUIStore(229)【P3 随对话域移交 chat-desk】
│   ├── utils/                    # 6,129 行：toolConfig(974) toolSummary(852)
│   │   ├── mermaid-config(417) toolInputExtractor(394) messageCompactor(363)【P3 剥→chat-desk】
│   │   └── logger(552) path lru-cache promptHistory【留】
│   ├── types/                    # 6,404 行：aiEvent(1303) chat(832)【P3 剥】；
│   │   │                         # browserContext/scmDiff/terminalScript/fileExplorer/fileEditor【P2 剥】
│   │   └── config/theme/workspace/errors/command/promptSnippet…【留】
│   ├── i18n/ locales/            # 73 行 + 2.6MB 词典【留，随出仓域词典递减】
│   └── hooks/                    # 1,589 行 / 12 文件【留（useAppInit 瘦身）】
│   （ai-runtime/ session-v2/ 已随 B3-1 出仓，主仓 0 文件）
├── src-tauri/src/                # 101,032 行 Rust（250 文件）
│   ├── lib.rs(1241) state.rs(1036) config_store.rs(1175) data_root.rs(710)
│   │   logger.rs(571) error.rs anchor_store.rs(145)【留】
│   ├── router/（services/router/）# 19,445 行 / 39 文件
│   │   ├── mod.rs(1786) policy_permission(949) audit_sink(652) permission_prompt【留】
│   │   ├── ai_chat_capability(950)【P3 剥→ai-runtime-desk】
│   │   ├── bash_capability(846) fs_capability http_capability kv_capability【留（通用工具面）】
│   │   ├── ui_render_capability(1072) ui_chat/ui_input/ui_theme【P6 瘦身】
│   │   ├── storage_forward/history_capability(711)/session_capability【P4 剥→storage-desk】
│   │   └── data_root(936)/config(976)/registry(798)/meta/help/usage/dynamic…【留】
│   ├── ai/                       # 21,513 行 / 51 文件：engine/claude(1772)、simple_ai/(10.1k)、
│   │   │                         #   plugin_engine(1452)/plugin_process(1138)、registry【P3 剥→ai-runtime-desk】
│   ├── services/
│   │   ├── ai_chat_core/         # 3,042 行 / 13 文件【P3 剥】
│   │   ├── storage_exec/         # 5,869 行 / 7 文件【P4 剥→storage-desk】
│   │   ├── proxy/                # 5,039 行 / 10 文件 + provider_router(777)
│   │   │                         #   + provider_stats_collector(565) + model_profile_service(736)
│   │   │                         #   + usage_db(701)【P5 剥→proxy-desk】
│   │   ├── computer_control/(934) ask_listener/(1898)+ask_mcp_server(740)
│   │   │   nexus_pipeline/(1108) form/(1586) context_core/(379)【P6 剥/删】
│   │   ├── plugin_service.rs(2904) supervisor/(2169) plugin_events(385)
│   │   │   plugin_capability_assembly(248) plugin_skills(148) plugin_state_service(87)【留】
│   │   ├── mcp_config_service(1874) mcp_manager_service(713) mcp_server_common(172)
│   │   │   bus_mcp_server(836) adapter_discovery(942)【P6 裁：只留插件 MCP 汇入面】
│   │   └── cli_info_service(368) auto_update(323) instance(315) hook_registry(277)【留】
│   ├── commands/                 # 5,353 行 / 21 文件
│   │   ├── router(302) plugin_config(116) window(91) data_root_cmd(53) dispatch(240)【留】
│   │   └── file_explorer(1227) dialog_storage(776) terminal(647) file_clipboard(253)
│   │       agent_corpus(204) session_state_commands(324) session_messages(201)
│   │       claude_settings(128) engine_install(263) nexus(55)…【P2/P3/P4 剥】
│   ├── models/                   # 4,743 行：ai_event(1868)【P3 剥一半：chat 事件→插件，
│   │                             #   宿主留信封类型】；config(1340) plugin(862)【留】
│   ├── capabilities/             # registry/filesystem/shell/compaction/subagent 契约层【留】
│   └── web/                      # 4,651 行：server/router/auth/event_broadcaster/ipc【留，ipc 死臂已清】
└── plugins/needs/                # 主仓仅存示例插件【留作样例或移出】
```

### 2.2 终点：polaris-lite 目录树（目标形态）

```
polaris-lite/
├── src/                          # ~25,000 行 TS/TSX（约 170 文件）
│   ├── App.tsx(~430) main.tsx(~200)      # 删 chat 残留分支，挂载链不变
│   ├── components/
│   │   ├── Common/               # 3,700 行 原样
│   │   ├── Layout/               # 2,555 行 原样（席位骨架 = 对话布局不变 guarantees）
│   │   ├── Plugins/              # 268 行 PluginPanelHost
│   │   └── TopMenuBar/           # 458 行
│   ├── plugin-system/            # ~5,100 行：registry/schema/loader/types/styles/iconResolver
│   │   ├── appCoreBridge.ts      # 收窄：21 store → 8 个通用 store；30 命令白名单 → 12
│   │   └── chatCardRegistry.ts   # 保留（chat-desk 经此注册消息卡片，属通用贡献点）
│   ├── services/
│   │   ├── transport/            # tauri/http/auth/detector 原样
│   │   ├── tauri/                # configService/fileService/windowService（chatService 删）
│   │   ├── aiEventBus.ts eventBus.ts uiDispatchService.ts   # 通用事件面
│   │   └── pluginDiscoveryService.ts pluginServiceManager.ts themeEngine.ts …
│   ├── stores/                   # ~2,600 行 / 15 文件：config/theme/workspace/view/overlay/
│   │   │                         #   toast/plugin/uiSlot/capCatalog/dispatch/engineMetadata…
│   │   └── （fileExplorer/fileEditor/tab/sessionConfig/inputUI/cliInfo 全删）
│   ├── utils/                    # ~1,100 行：logger/path/lru-cache/promptHistory（工具渲染 4 件套删）
│   ├── types/                    # ~2,400 行：config/theme/workspace/errors/command/plugin/
│   │   │                         #   aiEvent 信封子集（~400 行，由 1303 瘦身）
│   ├── i18n/ locales/            # ~40 个 key 文件（出仓域词典已随域删）
│   └── hooks/                    # 12 文件（useAppInit 删对话域初始化段）
├── src-tauri/src/                # ~13,000 行 Rust（约 70 文件）
│   ├── lib.rs(~700) state.rs(~450) config_store.rs(1175) data_root.rs(710)
│   │   logger.rs(571) error.rs anchor_store.rs(145) instance.rs(315) auto_update.rs(323)
│   ├── router/                   # ~11,000 行 / 26 文件
│   │   ├── mod.rs policy_permission audit_sink permission_prompt dynamic
│   │   ├── bash/fs/http/kv/config/data_root/registry/meta/help/usage/prompt_snippet
│   │   ├── plugin_discovery/plugin_service_manager/plugin_state
│   │   ├── ui_theme/ui_input/ui_render(瘦身至 ~400)/self_inspect/self_mutate
│   │   ├── hook_capability context_capability stream_echo event_adapter
│   │   └── （ai_chat/history/session/storage_forward/terminal capability 删）
│   ├── services/
│   │   ├── plugin_service.rs supervisor/ plugin_events plugin_capability_assembly
│   │   │   plugin_skills plugin_state_service hook_registry
│   │   ├── mcp_config_service(瘦身 ~600：只汇入插件 stdio MCP)
│   │   └── cli_info_service.rs
│   ├── commands/                 # router/plugin_config/window/data_root_cmd/dispatch/mod
│   ├── models/                   # plugin(862) config(瘦身 ~800) events(122) ai_event 信封(~350)
│   ├── capabilities/             # registry/filesystem/shell（compaction/subagent 随引擎出仓）
│   └── web/                      # server/router/auth/event_broadcaster/rate_limit/middleware/ipc
├── plugins/                      # 空（或仅留 needs 示例）
└── docs/schemes/S07-jianjin-boli.md   # 本方案 = 剥离清单权威
```

**终点量化**：前端 49.8k→~25k（-50%），后端 101k→~13k（-87%），合计 **151k→~38k（-75%）**。核心目录白名单 = 上树；业务黑名单 = 已删目录。

---

## 3. 核心契约：沿用 Polaris manifest + 剥离验收标准

### 3.1 沿用的契约（不新设计，逐条引用现状）

S7 的全部契约就是 Polaris 现有契约，**一个都不改语义**：

1. **插件 manifest**（`src-tauri/src/models/plugin.rs:154-215`，schema 版本 `1.0`，deny_unknown_fields）：`views[] {id, area, panelType, icon, labelKey, order, slot, slotMode}`、`overlays[] {id, slot, panelType}`、`panel {entry, supportsFullscreen}`、`services[] {id, type, command, argsTemplate, port, healthCheck, autoStart, restartOnFailure, maxRestarts}`、`mcpServers[] {id, transport, command, argsTemplate}`、`capabilities[] {id(cap.*), summary, handler(forward|plugin-rpc), replaces, replaceMode}`、`engines[] / chatCards[] / toolProviders[] / skills[] / hooks[] / configSchema[] / uiSlots[]`、`permissions {appConfigRead/appConfigWrite/aiToolAccess/chatEvents(full|lifecycle|none)}`。前端镜像 `src/plugin-system/schema.ts`。
2. **席位白名单**：`area ∈ {activityBar, mainSurface, settings, notificationOverlay}`；overlay 槽白名单 `{session-history}`（Rust `plugin_service::OVERLAY_SLOTS` 镜像）。
3. **总线入口**：`invoke('router_dispatch', {target, payload})` / `router_dispatch_stream`；权限裁决 → 审计 → 转发的 `RouterBus.dispatch` 语义不动。
4. **事件流**：`chat-event` 经 EventBroadcaster，前端 `__POLARIS_HOST_LISTEN__` 按 `permissions.chatEvents` 三级过滤（full / lifecycle / none）。
5. **宿主桥**：`window.__POLARIS_APP_CORE__`（store/service 共享）、`__POLARIS_HOST_INVOKE__`（白名单命令）、`__POLARIS_HOST_REACT__/REACT_DOM/USE_TRANSLATION__`。

**新增的唯一「契约性文档」是剥离清单本身**（§6）：每个条目记录「cap id / 事件名 / manifest 贡献点 / 数据根命名空间」四元组，作为该域出仓后宿主与插件的对账依据。

### 3.2 剥离验收标准（每个条目、每个阶段通用，全部门槛可执行）

| # | 验收项 | 判定方式 |
|---|---|---|
| V1 | 编译门 | `pnpm typecheck` + `pnpm lint` + `cargo check` + `cargo check --no-default-features --bin polaris-web --bin polaris-mcp` 全绿 |
| V2 | 行数对账 | 实际净删行数 vs 清单预估偏差 ≤ ±20%，且无孤儿残留（`grep` 死符号 / 死 i18n key / 死 manifest 声明为零） |
| V3 | 功能等价 | 该域回归清单逐项通过；插件侧经 `update.json` 热更新链路安装验证 |
| V4 | 双端可用 | 桌面（`pnpm tauri:dev`）+ Web（`pnpm tauri:dev:web`）两模式均可用；Web 不可用能力在插件 manifest 描述中显式声明 |
| V5 | 契约不变 | cap id、chat-event 事件名、manifest 字段、数据根路径与剥离前一致（diff 审查确认无协议字段漂移） |
| V6 | 可回滚 | 主仓删除为独立 commit 序列；插件仓保留前一版 zip；revert 后宿主可独立运行（席位渲染 PluginSlotPlaceholder 空态） |
| V7 | 对话布局不回归 | 每阶段结束跑固定冒烟：会话侧栏 + 消息流 + 输入区 + 面板区四段均在位，chat-desk mainSurface shadow 接管正常 |

---

## 4. AI 对话插件挂载（mainSurface 席位机制，参照 chat-desk）

对话 UI 的插件化**已经完成**（B3-1，chat-desk v0.1.0）。S7 不重做，只固化机制并把宿主侧最后残留交给它。

### 4.1 挂载机制（现状，逐行可查）

```
App.tsx:364-383
  const claim = pluginRegistry.getMainSurfaceClaim()   // 取 mainSurface 第一个贡献
  if (claim && pluginEnabled(claim.pluginId))
      → React.lazy(() => PluginPanelHost)              // 懒加载，不进主 bundle
        <PluginPanelHost panelType="chat-desk" … />
  else
      → <ChatMainSlot />                               // 18 行空态引导卡（src/components/Layout/ChatMainSlot.tsx）
```

chat-desk 的 `plugin.json` 贡献：

```json
{ "id": "chat-desk", "core": true, "enabledByDefault": true,
  "contributes": { "views": [{ "id": "chat-desk.main", "area": "mainSurface",
      "panelType": "chat-desk", "slot": "chat.main", "slotMode": "shadow", "order": 10 }],
    "panel": { "entry": "./dist/panel.js" } },
  "permissions": { "chatEvents": "full" } }
```

### 4.2 该机制的四个关键点（S7 沿用并推广到其余面板）

1. **shadow 接管**：`slotMode:"shadow"` 表示插件面板完全替换宿主默认内容；宿主只保留 `ChatMainSlot` 空态兜底。插件卸载/禁用时席位回落空态，布局四段（侧栏/消息流/输入区/面板区）由插件自己撑起——**布局不变性由「席位契约 + PluginPanelHost 容器尺寸」保证**，不靠宿主代码。
2. **懒加载边界**：`PluginPanelHost` 是唯一宿主入口（133 行），按 panelType 经 `pluginModuleLoader` 从插件 installPath 动态加载 Blob URL 模块——对话 UI 永不进宿主构建产物。
3. **数据通道**：面板内一切后端交互走 `__POLARIS_HOST_INVOKE__('router_dispatch', …)` → cap 总线；流式走 `router_dispatch_stream`；事件走 `__POLARIS_HOST_LISTEN__('chat-event')`（full 级）。**插件永远不直连 Tauri command 之外的后端实现**。
4. **P7 收窄点**：`appCoreBridge` 当前泄漏 21 个 store；lite 终点收窄为 8 个通用 store（config/theme/workspace/view/overlay/toast/uiSlot/capCatalog），对话域 store（sessionConfig/inputUI/cliInfo）从桥上摘除——chat-desk 已自持会话状态，不依赖宿主 store（useAppInit.ts 已注明「宿主不再初始化对话域」）。

### 4.3 P3 阶段：对话后端剥离后，chat-desk 的对接面变化

chat-desk 现在调 `cap.ai.chat`，由宿主 `ai_chat_capability → ai_chat_core → EngineRegistry` 执行。P3 后该链路变为：`cap.ai.chat`（cap id 不变）→ RouterBus → **ai-runtime-desk 插件注册的 DynamicHandler**（经 `plugin_capability_assembly` 装配，复用现有 `capabilities` 声明机制，参考 polaris-git 的 `contributes.services` + stdio 服务模式）。chat-desk **零改动**——这正是沿用现有体系的收益：契约消费者与实现提供方解耦，两端可以各自出仓。

---

## 5. 插件清单（lite 终点态的外置插件全集）

| 插件 | 状态 | 承接的宿主域 | 对接契约 |
|---|---|---|---|
| **chat-desk** | ✅ 已承接（v0.1.0，core） | 对话 UI 全部（会话侧栏/消息流/输入区/面板区） | mainSurface shadow 席位 + cap.ai.chat + chat-event(full) |
| **ai-runtime-desk** | 🆕 P3 新建 | AI 业务核：ai_chat_core、EngineRegistry、claude/simple_ai 引擎、工具执行、MCP 工具面 | `cap.ai.chat` DynamicHandler + `contributes.services`（常驻执行服务）+ `contributes.mcpServers` |
| **storage-desk** | 🆕 P4 新建 | 会话/消息/回合存储：storage_exec 五库、dialog_storage、session_state | `cap.storage` + `cap.history` + `cap.session` DynamicHandler（转发面已就绪：S3.6 已把 history/session 读面收口到 cap.storage） |
| **proxy-desk** | 🆕 P5 新建 | 供应商代理与用量：proxy/、provider_router、model_profile_service、usage_db、provider_stats_collector | `contributes.services`（本地代理端口）+ `contributes.capabilities`（cap.proxy 新声明）+ configSchema（凭证） |
| **model-desk** | ✅ 已有 | 模型供应商管理台 UI | 已走 usage 白名单命令，P5 后改走 cap.proxy |
| **files-desk** | ✅ 已承接 | 文件浏览器 UI | files 席位；P2 补 `cap.fs` 直连（去 file_explorer 命令残留） |
| **polaris-git** | ✅ 已承接 | Git 域 | services + stdio MCP（方案 C 已完成） |
| **terminal-desk** | ✅ 已承接 | 终端 UI | terminal 席位 + cap.terminal（PTY 核心留宿主） |
| **browser-desk** | ✅ 已承接 | 浏览器 | service(CDP) + 席位 |
| **settings-desk / history-desk / workspace-manager / needs** | ✅ 已有 | 设置/历史/工作台 | 席位 + overlay |
| **computer** | ✅ 已有 | computer_control 出仓后承接 | stdio MCP（polaris-computer-mcp 独立 bin） |
| **ask-stove** | ✅ 已有 | ask_listener 出仓后承接 | AskListener 帧协议 |
| 其余 140+ 插件 | ✅ 已有 | —— | 不受 S7 影响 |

原则重申（AGENTS.md §五已定案）：新增功能一律插件；主仓（lite）只修缺陷、安全与性能。S7 的插件清单不是「新造 157 个」，而是把**还留在核心里的最后几个业务域**补齐到既有插件体系里。

---

## 6. 剥离清单（本方案的权威工作清单，按阶段组织）

> 每条格式：`路径（行数）→ 去向`。行数为 2026-11-18 实测。清单覆盖 brief 硬性约束 7（复制/重写/放弃三分法在 §8）。

### P0 批次：零风险清扫（预计 -3,200 行）
- `src/types/browserContext.ts`(约120) `scmDiff.ts`(约950B) `terminalScript.ts`(约1.1k) `fileExplorer.ts`(约4.4k) `fileEditor.ts`(约4.3k) → 删（域已出仓，类型残留）
- `src/stores/schedulerStoreUtils.ts`(74) `editorSettingsStore.ts`(75) `editorContextStore.ts`(42) → 删
- `src/plugin-system/builtinPlugins.ts`(118) 中 files/git/browser/translate/terminal/developer/aiConsole 死声明 → 删（席位已由 PluginSlotPlaceholder 接管）
- `src/services/editorScmService.ts`(227) `diffService.ts`(205) → 删（git 域已出仓）
- 各处死 i18n key → 随上述删除清点

### P1 批次：命令层残尾（预计 -4,300 行 Rust）
- `src-tauri/src/commands/file_explorer.rs`(1227) → 删；文件 UI 域走 files-desk + cap.fs
- `src-tauri/src/commands/terminal.rs`(647) `terminal_script.rs`(124) → 删命令包装（PTY 核心与 cap.terminal 留守）
- `src-tauri/src/commands/file_clipboard.rs`(253) `file_watcher.rs`(60) `file_io.rs`(80) → 删/并入 cap.fs 动作
- `src-tauri/src/services/file_watcher.rs`(246) → 删
- `src-tauri/src/commands/agent_corpus.rs`(204) `claude_settings.rs`(128) → 删（对话域配置随 P3 走插件 configSchema）

### P2 批次：前端业务 store 与工具渲染（预计 -5,600 行 TS）
- `src/stores/fileExplorerStore.ts`(804) `fileEditorStore.ts`(587) `tabStore.ts`(500) → 删
- `src/utils/toolConfig.ts`(974) `toolSummary.ts`(852) `toolInputExtractor.ts`(394) `mermaid-config.ts`(417) `messageCompactor.ts`(363) → 迁 chat-desk（对话工具渲染是 chat-desk 的职责，worktree 旧 Chat 树即其前身）
- `src/components/Preview/`(126) `UiFrame/`(1196) → 迁 chat-desk / 由 cap.ui.render 模板承担
- `src/stores/inputUIStore.ts`(229) `sessionConfigStore.ts`(172) `cliInfoStore.ts`(291) → 随 P3 移交 chat-desk / ai-runtime-desk
- `src/components/Common/JsonTreeView.tsx`(632) → 迁需要它的插件（storage-desk 调试用）

### P3 批次：AI 对话后端（预计 -27,000 行 Rust，本方案最大单步）
- `src-tauri/src/ai/`（21,513 行 / 51 文件：engine/claude.rs(1772)、engine/simple_ai/(10.1k)、engine/plugin_engine.rs(1452)、plugin_process_engine.rs(1138)、registry 等）→ **ai-runtime-desk**（插件 service 进程，Rust 独立 bin 或 Node 重写二选一，建议 Rust bin 直迁以保行为等价）
- `src-tauri/src/services/ai_chat_core/`（3,042 行 / 13 文件）→ 同上
- `src-tauri/src/services/router/ai_chat_capability.rs`(950) → 删宿主实现，cap.ai.chat 改由插件 DynamicHandler 承接（经 plugin_capability_assembly 装配，机制现成）
- `src-tauri/src/services/ai_history_core.rs`(655) → 并入 storage-desk（P4）或 ai-runtime-desk
- `src-tauri/src/commands/dialog_storage.rs`(776) `session_state_commands.rs`(324) `session_messages.rs`(201) `engine_install.rs`(263) → 删（走 cap.storage / 插件服务）
- `src-tauri/src/models/ai_event.rs`(1868) → 宿主保留事件信封与枚举子集（~350 行），chat 事件体类型随插件
- `src/services/tauri/chatService.ts` → 删（前端一律 router_dispatch）
- 前置：与 chat-desk 联调 cap.ai.chat 动作表（start/continue/interrupt/send_input/ask/plan/register_pending_*）在插件实现中逐动作对齐；STREAM_ACTIONS 语义不变
- 风险专项：中断/晚到 stop 语义（记忆 ai-chat-interrupt-continue-root-cause）在插件进程中保持幂等——中断归属以 contextId 判定，不因进程重启误杀无关运行

### P4 批次：存储域（预计 -7,300 行 Rust）
- `src-tauri/src/services/storage_exec/`（5,869 行 / 7 文件：session_db/session_state/turn_persist/dialog_index）→ **storage-desk**（sqlite/文件引擎随插件进程）
- `src-tauri/src/services/anchor_store.rs`(145) → **留守**（锚点是宿主自持的根，不属于业务存储）
- `src-tauri/src/services/legacy_storage_migrate.rs`(504) → 删（迁移完成即退役）
- `src-tauri/src/services/router/storage_forward.rs history_capability.rs(711) session_capability.rs` → 删转发壳，cap.storage/cap.history/cap.session 由 storage-desk DynamicHandler 承接（S3.6 已完成「唯一路由收口」，本步只是把唯一路由的实现方从宿主换成插件）
- 数据迁移：存量库文件保留在 DataRoot 原命名空间，storage-desk 首启只读校验 schema 版本后接管；不做二次搬迁

### P5 批次：供应商代理与用量（预计 -8,100 行 Rust）
- `src-tauri/src/services/proxy/`（5,039 行 / 10 文件）→ **proxy-desk** service 进程
- `src-tauri/src/services/provider_router.rs`(777) `provider_stats_collector.rs`(565) `model_profile_service.rs`(736) `usage_db.rs`(701) → 同上
- `src-tauri/src/services/cli_info_service.rs`(368) → 留守（cli_get_* 是宿主桥白名单依赖的元数据面）
- 新增 `cap.proxy` 声明（走 dynamic_capability 机制，不硬编码）；model-desk 改走 cap.proxy
- 凭证：经 configSchema + cap.config 读写，代理进程经启动参数注入，不落插件可见明文

### P6 批次：领域杂项与 MCP 收口（预计 -6,900 行 Rust）
- `src-tauri/src/services/computer_control/`(934) → 已由 computer 插件承接 MCP 面，本步删宿主残留业务核
- `src-tauri/src/services/ask_listener/`(1898) + `ask_mcp_server.rs`(740) + `ask_listener_meta.rs`(253) → ask-stove 插件承接（stdio MCP 模式现成）
- `src-tauri/src/services/nexus_pipeline/`(1108) + `nexus_verdict.rs`(204) + `commands/nexus.rs`(55) → 删（/nexus 基础设施已随调度出仓，残留为死代码）
- `src-tauri/src/services/form/`(1586) → 表单渲染归 cap.ui.render DSL + uiTemplates 贡献点，宿主删实现
- `src-tauri/src/services/context_core/`(379) → 并入 ai-runtime-desk
- `src-tauri/src/services/mcp_config_service.rs`(1874→~600) `mcp_manager_service.rs`(713) `bus_mcp_server.rs`(836) `adapter_discovery.rs`(942) → 大幅瘦身：宿主只保留「插件 mcpServers 清单汇入 + stdio 生命周期」，方言适配/总线 MCP/适配器发现随 ai-runtime-desk
- `src-tauri/src/services/router/ui_render_capability.rs`(1072→~400)：chart/DSL 模板节点实现迁插件，宿主留分发壳

### P7 批次：宿主桥收窄与 web/ipc 清尾（预计 -2,500 行）
- `src/plugin-system/appCoreBridge.ts`(181)：共享 store 21 → 8，service 引用清理
- `src/main.tsx` HOST_INVOKE_ALLOWLIST：30 → 12 条（plugin_* 6 条、router_dispatch×2、health_check、message_read、cli_get 元数据 3 条合并、data_root）
- `src-tauri/src/web/api/ipc.rs`：随各域出仓核对死臂（延续 S3.6-3 的清法）
- `src/hooks/useAppInit.ts`：删除对话域/业务域初始化残留分支

### P8 批次：更名与收口
- 仓库更名 polaris-lite；README/AGENTS 按 lite 语境重写；`pnpm tauri:build:test` 产 lite 安装包；跑 §3.2 全部验收 + §4 冒烟

**合计预估**：Rust 约 -57,000 行，TS 约 -12,500 行，加 P0 清扫 → 主仓 151k → **~38k 行（-75%）**。

---

## 7. 启动流程（终点态）

```
polaris-lite 启动
│
├─ [Rust] polaris-lite 进程（~13k 行）
│   1. data_root 解析（env > anchor > 默认；anchor_store 读锚点）
│   2. config_store 装载 + logger 初始化
│   3. RouterBus 构建注册：20 个通用 capability
│      （bash/fs/http/kv/config/data_root/registry/meta/help/usage/
│        prompt_snippet/hook/context/ui.theme/ui.input/ui.render(壳)/
│        pluginDiscovery/pluginServiceManager/pluginState/self.*）
│   4. plugin_service 扫描 <appConfigDir>/plugins 与 <workspace>/.polaris/plugins
│      → manifest 校验（validate_manifest_fields）
│      → plugin_capability_assembly 把各插件 capabilities[] 注册为 DynamicHandler
│        （cap.ai.chat / cap.storage / cap.history / cap.session / cap.proxy …
│          宿主代码里已无这些名字，只有总线上的动态条目）
│   5. supervisor 拉起 contributes.services（ai-runtime-desk / storage-desk /
│      proxy-desk 常驻进程），healthCheck + restartOnFailure 接管
│   6. mcp_config_service 汇入各插件 mcpServers（stdio 清单）
│   7. web/server 监听（桌面 9829 / web 模式同端口），EventBroadcaster 就绪
│
├─ [TS] main.tsx（~200 行）
│   1. installAppCoreBridge()：挂 8 个通用 store + 通用 service（收窄后）
│   2. 挂宿主桥：__POLARIS_HOST_INVOKE__(12 条白名单) / __POLARIS_HOST_LISTEN__
│      (chat-event 分级过滤) / __POLARIS_HOST_REACT__ / THEME_API …
│   3. bootstrapTheme()（防 FOUC）
│   4. render(<RootApp/>)
│
└─ [TS] App.tsx 初始化
    1. useAppInit：loadConfig → pluginStore.loadPluginStates → workspaceStore.syncFromServer
       → themeStore.syncFromRemote → discoverInstalledPlugins → pluginRegistry.replaceInstalled
       → applyPluginStyles → pluginServiceManager.autoStartAll
    2. 席位渲染：ActivityBar/LeftPanel 各槽 = PluginSlotPlaceholder（插件注册后填充）；
       RightPanel = mainSurface claim → 懒加载 PluginPanelHost(chat-desk)；
       chat-event 流接通 → chat-desk 撑起 会话侧栏+消息流+输入区+面板区
```

与现状（baseline §8）的差异只有两点：初始化清单更短（无业务域分支）、capability 表里业务 cap 变成插件动态条目。**用户可感知的启动体验不变，首屏依赖反而更少**（对话/存储/代理均懒加载自插件进程）。

---

## 8. 与 Polaris 的复用 / 差异清单

### 8.1 直接复制（原样保留，不改动）
- `src/components/Common/`（3,729）、`src/components/Layout/`（2,555）、`src/components/Plugins/`（268）、`src/components/TopMenuBar/`（458）
- `src/plugin-system/` 主体（registry/schema/panelRegistry/pluginModuleLoader/types/styles/iconResolver/uiContributions/chatCardRegistry）
- `src/services/transport/`、theme 三件套、`aiEventBus/eventBus/uiDispatchService`、`pluginDiscoveryService/pluginServiceManager`
- 通用 stores（config/theme/workspace/view/overlay/toast/plugin/uiSlot/capCatalog/dispatch/engineMetadata/focusMode）
- Rust：`router/mod.rs` + 权限/审计三件套、20 个通用 capability、`plugin_service/supervisor/plugin_*`、`web/`、`config_store/data_root/logger/error/anchor_store/instance/auto_update/cli_info_service/hook_registry`、`capabilities/{registry,filesystem,shell}`、`models/{plugin,config(瘦身),events}`
- `i18n` 机制与通用词典、`hooks/` 12 件、`package.json` 依赖面（删 @xterm 等已随域走的依赖）

### 8.2 重写 / 改造（在原位修改，不是新写）
- `appCoreBridge.ts`：21→8 store（收窄式重写，接口签名不变）
- `main.tsx` 白名单：30→12（删行，不改机制）
- `App.tsx`：删业务分支（~90 行），骨架不动
- `models/ai_event.rs`：拆出信封子集留守（类型瘦身，枚举值不删）
- `mcp_config_service.rs` / `ui_render_capability.rs`：保留分发/汇入职责，删实现体
- `useAppInit.ts`：删业务初始化段

### 8.3 放弃（从 lite 中删除，去向见 §6）
- 全部 §6 清单条目；以及：`plugins/needs`（可移插件仓）、`src/locales` 中出仓域词典、`commands/` 业务命令、`ai/` 整目录、`storage_exec/`、`proxy/`、`computer_control/`、`ask_listener/`、`nexus_pipeline/`、`form/`、`context_core/`、`adapter_discovery`、`bus_mcp_server`、`legacy_storage_migrate`
- 不做垫层、不留兼容分支（沿 core-slimdown §9 纪律）

---

## 9. 裁剪量化表（每阶段删多少行）

| 阶段 | 内容 | 删 Rust | 删 TS | 阶段后累计（Rust+TS） | 累计降幅 |
|---|---|---:|---:|---:|---:|
| 起点 | Polaris HEAD `ff386fad` | — | — | 150,826 | — |
| P0 | 类型/死声明/死 service 清扫 | 0 | ~3,200 | 147,600 | -2% |
| P1 | 命令层残尾（file_explorer 等） | ~4,300 | 0 | 143,300 | -5% |
| P2 | 前端业务 store + 工具渲染四件套 | 0 | ~5,600 | 137,700 | -9% |
| P3 | AI 对话后端（ai/ + ai_chat_core + capability） | ~27,000 | ~700 | 110,000 | -27% |
| P4 | 存储域（storage_exec + 转发壳） | ~7,300 | 0 | 102,700 | -32% |
| P5 | 代理与用量（proxy + provider* + usage_db） | ~8,100 | 0 | 94,600 | -37% |
| P6 | 领域杂项 + MCP 收口 | ~6,900 | 0 | 87,700 | -42% |
| P7 | 宿主桥收窄 + web/ipc 清尾 | ~1,300 | ~1,200 | 85,200 | -44% |
| P8 | 更名收口（无删码） | 0 | 0 | 85,200 | -44% |

> 说明：①P2/P3 的前端删除与 chat-desk 已承接面重叠，实际以「宿主 grep 零引用」为准逐文件确认，预估含连带测试文件；②P3 是风险与收益的峰值步，允许拆成 P3a（引擎出仓）/P3b（ai_chat_core 出仓）两个可独立回滚的子步；③终点形态 §2.2 估算 ~38k vs 本表 85k 的差额 = 测试文件、locales 资产、以及「重写/瘦身类」条目（§8.2）按行数折算后的进一步压缩；两表口径不同（本表只计「整目录删除」，§2.2 含瘦身折算），评审时以本表为保守下界、§2.2 为目标上界。

每阶段均要求产出：commit 序列清单 + `wc -l` 对账 + V1~V7 验收记录。

---

## 10. 迁移步骤（阶段化里程碑，每步可验证）

**总原则**：在 Polaris 主仓开长驻分支 `feat/polaris-lite`（从 `main` 切出），P0~P8 逐批合入；每批 = 独立 spec（复用 core-slimdown 模板）→ 实现 → §3.2 验收 → 合并。插件侧工作全部落在 `D:\space\base\Polaris-plugin` 仓。

| 里程碑 | 交付物 | 可验证信号 |
|---|---|---|
| M0（P0） | 死码清扫完成 | typecheck/cargo check 绿；grep 死符号为零；行数对账表 |
| M1（P1） | 命令残尾删除 | web-only 门禁绿；files/terminal 席位经插件回归 |
| M2（P2） | 前端业务面清空 | 主 bundle 体积下降可测；chat-desk 工具渲染回归通过 |
| M3（P3a） | ai/ 引擎出仓为 ai-runtime-desk | 引擎经插件 service 注册进总线；cap.ai.chat start/continue 流式冒烟通过；中断幂等专项通过 |
| M4（P3b） | ai_chat_core 出仓 | 同上 + ask/plan/send_input 动作对齐表全绿 |
| M5（P4） | storage-desk 接管 cap.storage | 历史会话可读；新会话落库；cap.history/session 转发对账 |
| M6（P5） | proxy-desk 接管供应商面 | model-desk 经 cap.proxy 连通测试/用量统计回归 |
| M7（P6） | 杂项域清零 | ask-stove/computer 回归；mcp 清单汇入正常 |
| M8（P7） | 宿主桥收窄 | appCoreBridge 只含 8 store；白名单 12 条；越权命令被拒（含负向测试） |
| M9（P8） | **polaris-lite v1.0** | 独立构建 MSI/Web 包；§4 四段布局冒烟；对比基线行数报告 |

每步回滚预案：主仓单 commit 序列 revert；插件保留前版 zip；席位空态兜底保证「插件挂了宿主仍可启动」。

---

## 11. 风险与对策

| # | 风险 | 等级 | 对策 |
|---|---|---|---|
| R1 | **与主仓演进冲突**：Polaris 主线（main）持续开发，长驻分支 `feat/polaris-lite` 会漂移 | 高 | ①剥离批次尽量小步快合（每批 ≤1 周合回 main），而不是养大分支——S7 的本质是「主仓自己的瘦身」，合并方向就是 main，冲突面天然最小；②锁存量契约：批次期间冻结 ai_event/cap 命名/manifest 字段（V5 项）；③主线新功能一律走插件（已有定案），不新增核心业务，漂移源被制度性掐断；④若主线出现不可调和分叉，以 tag `lite-base-ff386fad` 为界 fork 收尾，已剥批次不受影响 |
| R2 | P3 引擎出仓后中断/流式语义回归（晚到 stop、误杀、事件乱序） | 高 | 中断归属以 contextId 单权威判定；插件 service 进程内保留原有 ChatCallbacks→EventBroadcaster 回流路径（经总线转发）；上线前跑中断专项回归（含「continue 中 stop」「进程重启后 stop」用例）；P3a/P3b 拆步降低爆炸半径 |
| R3 | 插件 JS 零沙箱 + 动态 Handler 扩权 | 高 | 沿用 §6 地基项：宿主级白名单已落地，补插件级 permissions 裁剪（main.tsx:82 已有全局闸）；DynamicHandler 注册须经 plugin_capability_assembly 的 manifest 声明（deny_unknown_fields），不开放任意注册口 |
| R4 | 协议无运行时 schema 校验，多跳转发后字段漂移 | 中 | V5 契约冻结 + 每批 diff 审查；关键枚举（AIEvent kind、cap 动作名）在宿主信封类型中保留编译期校验；插件侧对账表（§6 四元组）进 CI 比对 |
| R5 | 存储出仓后数据丢失/版本不兼容 | 中 | storage-desk 首启只读校验 schema 版本，不匹配则拒绝接管并保宿主只读降级；存量库文件不搬迁；legacy_storage_migrate 保留一个发布周期再删 |
| R6 | 插件进程故障导致对话/存储不可用 | 中 | supervisor restartOnFailure + healthCheck 已有；席位空态与错误卡片兜底；storage-desk 故障时宿主进入「只读禁写」而非崩溃 |
| R7 | 每步「功能等价」回归工作量累积 | 中 | 复用各已出仓域的现成回归清单（git/browser/terminal 均有先例）；把 V1 编译门 + V7 布局冒烟做成脚本，每批机械执行 |
| R8 | 裁剪过度伤及通用能力（把该留的删了） | 中 | §3.1 契约清单 + §2.2 白名单树是唯一裁决依据；任何「看起来像业务」的通用件（如 chatCardRegistry、aiEventBus）删除前必须过四问（core-slimdown §3） |

---

## 12. 结语：为什么 S7 是风险最低的 lite 路线

polaris-lite 的目标形态（核心零业务 + UI 全插件 + cap 总线 + 布局不变）在 Polaris HEAD 上**已经完成约 55%**：UI 面板全部插件化、对话 UI 已由 chat-desk shadow 接管、git/scheduler/browser/IM/translate 等域已出仓、cap.storage 路由已收口。S7 不发明任何新架构，只把同一套已验证的「cap 化 → 插件承接 → 删码 → 验收」流程再执行 P0~P8 九个批次，终点即 lite。它牺牲的是「从零设计一个更纯粹的核心」的理论优雅度（S2/S8 的强项），换来的是每一步都有真实 commit、真实回归、真实回滚路径的工程确定性——对一个已有 25 万行、157 个插件、仍在活跃演进的系统来说，这是唯一不需要「大爆炸」就能走完的路。
