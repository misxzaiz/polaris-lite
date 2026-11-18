# Polaris 事实基线（polaris-lite 设计输入）

> 调查对象：`D:\space\base\Polaris`（分支 `feat/s3-storage-takeover`，HEAD `ff386fad`）。本文只陈述事实与路径，不含建议。另注：仓库内存在两个活 worktree `.claude/worktrees/browser-desk-extraction`、`.claude/worktrees/opencode-plugin-migration`，其中保留着尚未进入主分支的 `src/ai-runtime/`、`src/session-v2/`、`src/components/Chat/` 完整实现；外部插件源码在姊妹仓 `D:\space\base\Polaris-plugin\plugins\`（150+ 插件）。

## 1. 前端对话交互布局

**挂载骨架**（`src/App.tsx`，522 行）：

```
ErrorBoundary > Layout (src/components/Common/Layout.tsx, 112 行)
  ├─ ConnectingOverlay（连接/Token 门）
  ├─ TopMenuBar（src/components/TopMenuBar/index.tsx, 372 行）
  ├─ div.flex
  │   ├─ ActivityBar（Layout/ActivityBar.tsx, 185 行；图标栏，席位来自 pluginRegistry activityBar 贡献）
  │   ├─ LeftPanel（Layout/LeftPanel.tsx, 350 行）+ LeftPanelTabStrip（271 行）
  │   │    └─ LeftPanelContent：files/git/browser/translate/terminal/developer/aiConsole 各席位
  │   ├─ CenterStage（Layout/CenterStage.tsx, 675 行；编辑器/预览 tab，!isCompact && hasOpenTabs）
  │   └─ RightPanel（Layout/RightPanel.tsx, 102 行）← 对话主区
  ├─ 设置页覆盖层（settings 席位，PluginPanelHost 承载）
  ├─ CreateWorkspaceModal / CreateSessionModal / FileSearch
  ├─ RightSlideOver：会话历史抽屉（session-history overlay 槽）、消息中心
  └─ ToastContainer / PermissionPromptHost / FocusOverlay
```

**对话区（Chat）现状**：内置 Chat 已从主仓删除。`src/components/Layout/ChatMainSlot.tsx`（18 行）只是空态引导卡；`App.tsx:364-383` 的逻辑是：`pluginRegistry.getMainSurfaceClaim()` 命中且插件启用 → 渲染懒加载 `PluginPanelHost`（`src/components/Plugins/PluginPanelHost.tsx`，133 行），否则渲染 `ChatMainSlot`。真实对话 UI 在 **chat-desk 插件**（`Polaris-plugin/plugins/chat-desk/`，396 个 TS/TSX 文件、23,763 行，`plugin.json` 声明 `core:true`、`area:"mainSurface"`、`slot:"chat.main"`、`slotMode:"shadow"`、`permissions.chatEvents:"full"`）。其内部结构（`plugins/chat-desk/src/`）：`Session/`（MultiSessionGrid、SessionCell、NewSessionPanel、SessionConfigSelector、ChatNavigator 等）、`host/`、`QuickSwitchPanel/`、`session-config/`、`bootstrap.ts`。

**完整 Chat 组件树参照**（主分支删除前的形态，保留在 `.claude/worktrees/browser-desk-extraction/src/components/Chat/`）：104 个文件、26,904 行，子目录：`session/`（会话侧栏/多会话网格）、`messages/`（SessionMessagesView、renderChatMessage、自动滚动）、`input/`（ChatInput、AttachmentPreview、ContextChips、chatCommandRouter）、`chatBubbles/`（Assistant/User/SystemBubble）、`tool-calls/`、`chatBlocks/`、`compact-handoff/`、`dynamic-island/`、`common/`、`search/`。即「会话侧栏 + 消息流 + 底部输入区 + 面板区」四段式布局。

## 2. 前端面板体系

- **席位（view contributions）**：`src/plugin-system/registry.ts`（543 行）提供 `listViewContributions(area)`、`getMainSurfaceClaim()`（取 mainSurface 第一个贡献）、`getOverlayClaim(slotId)`；`area` 白名单在 `src/plugin-system/schema.ts:27`：`activityBar | mainSurface | settings | notificationOverlay`；overlay 槽白名单 `session-history`（schema.ts:33，与 Rust `plugin_service::OVERLAY_SLOTS` 镜像）。
- **面板加载**：`src/plugin-system/panelRegistry.ts`（80 行，`pluginPanelRegistry.load(panelType)` 返回 React 组件）+ `src/plugin-system/pluginModuleLoader.ts`（155 行：读插件磁盘 JS → import 重写 → Blob URL 动态 `import()`，同窗口同源非沙箱）。宿主入口统一为 `PluginPanelHost`（按 panelType 加载并注入 onSendToChat/onClose）。
- **LeftPanel 各席位**：全部已插件化（`App.tsx:244-304` 全部渲染 `PluginSlotPlaceholder` 占位）——files-desk、polaris-git、browser-desk、translate、terminal-desk、dev-desk、im-bridge(aiConsole)；内置席位声明残留在 `src/plugin-system/builtinPlugins.ts`（118 行，`polaris.core`，仅声明 views/编辑器 SCM 扩展，无面板实现）。
- **宿主桥**：`src/plugin-system/appCoreBridge.ts`（181 行）在 main.tsx 挂 `window.__POLARIS_APP_CORE__`，向插件共享 21 个 store、约 30 个 service、公共组件、i18n 同实例——插件面板与宿主 UI 共享同一 Zustand 状态。
- **其余挂载点**：`uiContributions.ts`（uiSlots：fileExplorerToolbar/diffRefresh）、`chatCardRegistry.ts`（323 行，会话内卡片渲染器）、`uiTemplateRegistry.ts`、`editorExtensionRegistry.ts`、`styles.ts`（插件 CSS 注入）。

## 3. AI 对话链路

**职责划分（现状主链路）**：

```
chat-desk 面板 / 宿主
  → invoke('router_dispatch', {target:'cap.ai.chat', payload:{action:'start'|'continue'|...}})
     src/services/tauri/chatService.ts:25-33
  → commands/router.rs router_dispatch（lib.rs 注册）
  → RouterBus.dispatch（services/router/mod.rs:661，权限 gate + 审计）
  → AiChatCapability（services/router/ai_chat_capability.rs, 950 行；
     动作表 start/continue/interrupt/send_input/ask/plan/register_pending_* ，STREAM_ACTIONS=["start","continue"]）
  → ai_chat_core（services/ai_chat_core/，13 文件 3,042 行，传输无关业务核）：
     start_chat.rs(668)/continue_chat.rs(434)/interrupt/send_input/ask_question(245)/plan_mode/attachments(422)/profile_options/provider_routing(253)
     → 附件处理、Profile/供应商分组路由与 failover、MCP 准备（launcher）
  → EngineRegistry（ai/registry.rs）：启动时注册 ClaudeEngine + SimpleAIEngine（lib.rs:493-496）；
     插件可经 register_plugin_engine 动态注册（ai/engine/plugin_engine.rs 1452 行、plugin_process_engine.rs 1138 行）
  → 引擎执行：ai/engine/claude.rs(1772, Claude Code CLI)、simple_ai/（10153 行引擎目录总量，
     含 agent/chat_loop/compact/context/tools/{bash,fs,computer,plan,skill,agent,search,apply_patch}/mcp）、
     simple_ai_protocol/（anthropic/openai/responses/wire）
  → 事件回流：ChatCallbacks → EventBroadcaster（web/event_broadcaster.rs）→ 'chat-event'
     → 前端 listen（main.tsx HOST_LISTEN 分级过滤）→ chat-desk sessionStoreManager → aiEventBus(472 行)/uiDispatch
```

**前端 ai-runtime / session-v2 / conversationStore 的位置**：均不在主仓 `src/`，只存在于 worktree：
- `.claude/worktrees/browser-desk-extraction/src/ai-runtime/`：16 文件（engine.ts、engine-registry.ts、event-bus.ts、task.ts、tool-registry.ts、base/base-session.ts 等）——前端侧引擎抽象层；
- `.../src/session-v2/`：kernel/v2-kernel.ts(535 行)、core/（reconcile、plugin-host、in-memory-log/state、v2-message-log、v2-session-event-log，共 1,022 行）、hooks/useKernelSessionState.ts；
- `.../src/stores/conversationStore/`：33 文件 11,383 行（sessionStoreManager.ts、createConversationStore.ts、eventHandler.ts 等）——会话状态权威（多会话、事件消费、去重、compact）。

主仓现状仅保留：`src/types/session.ts`、`src/stores/sessionConfigStore.ts`、`src/plugin-system/sessionHostApi.ts`（`__POLARIS_SESSION_API__` 恢复/分支桥，main.tsx:164）。**结论**：会话状态管理已随 chat-desk 外置（useAppInit.ts:131-32 注明「宿主不再初始化对话域」），主仓的 AI 链路 = chatService → cap.ai.chat → ai_chat_core → EngineRegistry。

## 4. cap 总线（RouterBus）

- **核心文件**：`src-tauri/src/services/router/mod.rs`（1,786 行）——`trait Router`，`dispatch()`（行 661，权限裁决 PermissionRequest → audit → invoke，含 dispatch.start/ok/deny 事件）、`dispatch_stream()`（行 367）、`register_handle/register_handle_arc`（同 id 拒绝）、`register_streaming`、override 链（`register_override`/`override_chain_of`）、`list_capabilities/described_capabilities`。命令入口 `src-tauri/src/commands/router.rs`（240 行）：`router_dispatch`、`router_dispatch_stream`、`router_list_caps`、`audit_tail`、`audit_verify`、`respond_permission_request`。Web 端 HTTP 桥：`src-tauri/src/web/api/ipc.rs`（1,065 行）。
- **注册点**：`src-tauri/src/state.rs:449-646`（Hook/Kv/Http/Bash/Fs/Usage/Meta/PromptSnippet/Context/DataRoot/PluginDiscovery/PluginServiceManager/PluginState/Config/Help/UiTheme/UiChat/Registry/UiInput/SelfInspect/SelfMutate/StreamEcho）；`src-tauri/src/lib.rs:554-591、1113-1146`（AiChatCapability[streaming]、History、Session、Storage、UiRender、Terminal）；插件声明的 cap 由 `services/plugin_capability_assembly.rs` 的 `sync_plugin_capabilities` 装配。
- **现有 capability 文件（services/router/，39 个文件）与 cap id**：

| capability 文件 | cap id |
|---|---|
| ai_chat_capability.rs | `cap.ai.chat`（streaming）；另 `cap.ai`、`cap.ai.engine.simple-ai` |
| history_capability.rs | `cap.history` |
| session_capability.rs | `cap.session` |
| storage_capability.rs / storage_forward.rs | `cap.storage` |
| ui_render_capability.rs (1,072) | `cap.ui.render` |
| ui_chat / ui_input / ui_theme | `cap.ui.chat` / `cap.ui.input` / `cap.ui.theme` |
| terminal_capability.rs | `cap.terminal` |
| bash_capability.rs (846) | `cap.bash`（run/status/log/wait/kill/list） |
| fs_capability.rs | `cap.fs` |
| http_capability.rs | `cap.http` |
| kv_capability.rs | `cap.kv` |
| config_capability.rs (976) | `cap.config` |
| mcp_capability.rs | `cap.mcp` |
| hook_capability.rs | `cap.hook` |
| context_capability.rs | `cap.context` |
| data_root_capability.rs (936) | `cap.data_root` |
| plugin_discovery / plugin_service_manager / plugin_state | `cap.pluginDiscovery` / `cap.pluginServiceManager` / `cap.pluginState` |
| registry_capability.rs (798) | `cap.registry` |
| meta_capability.rs / help_capability.rs / usage_capability.rs | `cap.meta` / `cap.help` / `cap.usage` |
| prompt_snippet_capability.rs | `cap.prompt_snippet` |
| self_capability.rs / self_mutate_capability.rs | `cap.self.inspect` / `cap.self.mutate` |
| app_autolaunch / app_update | `cap.app.autolaunch` / `cap.app.update` |
| dynamic_capability.rs | `cap.dyn.*`（动态注册） |
| demo/echo/faulty、stream_echo、event_adapter、audit_sink、policy_permission、permission_prompt | 测试/基础设施（`cap.echo`、`cap.stream.echo` 等） |

（`cap.git` 已随 Git 域出仓删除，见 lib.rs:41、commands/mod.rs:9 注释；浏览器命令同样退役。）

## 5. 插件契约

**Manifest 结构**（Rust 权威定义 `src-tauri/src/models/plugin.rs:154-215` `PluginManifestContributes`，前端镜像 `src/plugin-system/schema.ts`，schema 版本 `1.0`，deny_unknown_fields）：

- `views[]`：`{id, area, panelType, icon, labelKey, labelDefault?, order, badge?, slot?, slotMode?(shadow|chain|append)}`
- `overlays[]`：`{id, slot(白名单 session-history), panelType, mode?}`（PluginOverlayContribution, plugin.rs:414）
- `panel`：`{entry(./相对路径), supportsFullscreen}`（plugin.rs:401）
- `services[]`：`{id, type(http|...), command, argsTemplate[](支持 {{pluginDir}}/{{port}}/{{appConfigDir}}), port?, healthCheck?, healthCheckTimeout?, autoStart, restartOnFailure, maxRestarts, description}`（plugin.rs:465）
- `mcpServers[]`：`{id, transport(stdio|http), command, argsTemplate[]}`
- `engines[]` / `chatCards[]` / `toolProviders[]`（capability+mcpServerId 覆盖内置工具面）
- `capabilities[]`：`{id(cap.*), summary, handler(JSON: forward|plugin-rpc), replaces, replaceMode}` → 注册进 RouterBus
- `skills[]`、`styles[]`、`hooks[]`（`{id: ai.session.start 等, capId}`）、`configSchema[]`、`executors[]`、`adapters[]`（方言翻译）、`uiTemplates[]`、`uiSlots[]`
- 顶层：`id/name/version/description/builtin/enabledByDefault/core/manifestVersion/contributes/permissions/origin/compat/source/dev/installPath`；permissions 含 `appConfigRead/appConfigWrite/aiToolAccess/chatEvents(full|lifecycle|none)` 等（PluginManifestPermissions, plugin.rs:644）。

**发现/加载/通信（`src-tauri/src/services/plugin_service.rs`，2,904 行）要点**：
- 发现：`discover_installed_plugins`（行 421）→ `install_locations`（行 478：用户级 `<appConfigDir>/plugins`，项目级 `<workspace>/.polaris/plugins`）→ `scan_plugin_root`（行 1488，读目录下 `plugin.json`）→ `validate_manifest_file_path`/`validate_manifest_fields`（行 509/1972，L1 校验）。
- 安装/卸载：`install_local_plugin`(532)、`install_plugin_package`(560)、`install_remote_plugin`(570，marketplace)、`dev_link_plugin`(586，源码直连)、`uninstall_plugin_with_cleanup`(1075)。
- 运行时通信：`services` 由 `services/supervisor/`（ServiceSupervisor，2,169 行）拉起子进程并做健康检查/重启；`mcpServers` 由 `services/mcp_config_service.rs`（1,874 行）汇入引擎 MCP 配置；`capabilities` 经 `plugin_capability_assembly.rs` 注册为 RouterBus DynamicHandler；`hooks` 经 cap.hook 绑定回调 cap；生命周期事件 `plugin_events.rs`。
- 前端侧：`src/services/pluginDiscoveryService.ts`（831 行）→ `pluginRegistry.replaceInstalled`；配置读写走 `plugin_get_config/plugin_set_config` IPC；插件面板 invoke 走 main.tsx 的 `__POLARIS_HOST_INVOKE__` 白名单（30 个命令）与 `__POLARIS_HOST_LISTEN__` chat-event 分级过滤（main.tsx:56-146）。
- 插件实例：`Polaris-plugin/plugins/` 下 150+ 目录（chat-desk、files-desk、settings-desk、history-desk、terminal-desk、browser-desk、polaris-git、translate、dev-desk、model-desk、notification-desk、im-bridge、workspace-manager、needs 等）；主仓 `plugins/` 下仅 needs（含 `plugin.json` 全字段示例）与文档。

## 6. 规模数据

| 指标 | 数值 |
|---|---|
| `src/` TS+TSX 文件 | **279** 个（含 53 个 `.test.*`；非测试 226：172 ts + 54 tsx） |
| `src/` 总行数 | **49,794** 行 |
| `src-tauri/src/` Rust 文件 | **250** 个，**101,032** 行 |
| Zustand stores | `src/stores/` 37 个文件（27 个非测试 store 模块） |
| Tauri commands | **36** 个 `#[tauri::command]` 函数（lib.rs:925 注册；大量域已注释退役） |
| RouterBus capability | 34 个 `impl Capability/StreamingCapability`，约 30 个对外 cap id |
| 最大后端文件 | plugin_service.rs 2,904；mcp_config_service.rs 1,874；models/ai_event.rs 1,868；router/mod.rs 1,786；ai/engine/claude.rs 1,772 |
| 最大前端文件 | types/aiEvent.ts 1,303；utils/toolConfig.ts 974；utils/toolSummary.ts 852；types/chat.ts 832；pluginDiscoveryService.ts 831；stores/fileExplorerStore.ts 804 |
| chat-desk 插件本体 | 396 文件 / 23,763 行（不含 dist） |
| worktree 中旧主 Chat 树 | 104 文件 / 26,904 行；conversationStore 11,383 行；session-v2 kernel+core ~1,557 行 |

## 7. 业务功能在核心里的分布

**明显是具体业务（候选插件化/移出核心）**

前端（主仓残留）：
- `src/stores/fileExplorerStore.ts`(804)、`fileEditorStore.ts`(587)、`tabStore.ts`(500)、`editorSettingsStore.ts`、`editorContextStore.ts`、`schedulerStoreUtils.ts` — 文件/编辑器/终端/调度域状态
- `src/types/browserContext.ts`、`scmDiff.ts`、`terminalScript.ts`、`fileExplorer.ts`、`fileEditor.ts` — 已出仓域的类型残留
- `src/utils/toolConfig.ts`(974)、`toolSummary.ts`(852)、`toolInputExtractor.ts`、`mermaid-config.ts`(417)、`messageCompactor.ts` — AI 工具/消息渲染业务
- `src/components/Preview/`、`src/components/UiFrame/`（chart/模板渲染）、`Common/JsonTreeView.tsx`(632)
- `src/plugin-system/editor*`（editorScmProvider、editorExtensionRegistry）— SCM 编辑器集成

后端：
- `services/ai_chat_core/`(3,042)、`services/router/ai_chat_capability.rs`(950)、`services/ai_history_core.rs` — 对话业务核
- `ai/engine/claude.rs`(1,772)、`ai/engine/simple_ai/`（含 tools/ bash/fs/computer/plan/skill/agent）、`ai/engine/plugin_*` — 引擎与工具面
- `services/storage_exec/`(4,964：session_db/session_state/turn_persist/dialog_index) — 会话/消息存储
- `services/proxy/`(5,039) — 供应商代理；`provider_router.rs`、`provider_stats_collector.rs`、`model_profile_service.rs`、`usage_db.rs`
- `services/computer_control/`(934)、`services/ask_listener/`(1,898)+ask_mcp_server、`services/nexus_pipeline/`(1,108)+nexus_verdict、`services/form/`(1,586) — 领域业务服务
- `commands/file_explorer.rs`(1,227)、`commands/terminal.rs`、`commands/file_watcher.rs`、`commands/file_clipboard.rs`、`commands/agent_corpus.rs`、`commands/nexus.rs`、`commands/claude_settings.rs`、`commands/dialog_storage.rs`
- `services/context_core/`、`services/mcp_tool_gates.rs`（SimpleAI 工具门控）

**通用宿主能力（核心应保留）**

后端：`services/router/mod.rs`(1,786)+`audit_sink`+`policy_permission`(949)+`permission_prompt`+`registry_capability`+`meta/help/dynamic`；`capabilities/{registry,filesystem,shell,compaction,subagent}` 契约层；`services/plugin_service.rs`+`plugin_events`+`plugin_state_service`+`plugin_capability_assembly`+`plugin_skills`（插件生命周期，半通用）；`services/supervisor/`（插件服务进程管理，半通用）；`web/`（server/router/auth/event_broadcaster/rate_limit/api/ipc）；`config_store.rs`、`data_root.rs`、`logger.rs`、`error.rs`、`state.rs`(1,036)、`lib.rs`(1,241)。
前端：`services/transport/`（tauri/http/auth/detector）、`services/eventBus.ts`、`services/aiEventBus.ts`(472)、`services/themeEngine.ts`(364)/`themeService.ts`/`themeMerger.ts`、`src/i18n/`+`src/locales/`、`stores/configStore.ts`(416)/`workspaceStore.ts`/`viewStore.ts`/`overlayStore.ts`/`toastStore.ts`/`pluginStore.ts`/`themeStore.ts`/`capCatalogStore.ts`、`plugin-system/` 核心（registry/panelRegistry/schema/pluginModuleLoader/uiContributions/styles/iconResolver/types.ts 582）、`components/Common/`（Layout/Modal/Toast/ErrorBoundary/RightSlideOver/PermissionPromptHost/Icons）、`components/Layout/` 壳（ActivityBar/LeftPanel/RightPanel/CenterStage 空壳化后）。

## 8. 启动链路

`src/main.tsx`（250 行）顺序：
1. `installAppCoreBridge()`（appCoreBridge.ts，挂 `__POLARIS_APP_CORE__`，含 21 个 store 与 ~30 个 service 的同实例共享）；
2. 挂载宿主桥：`__POLARIS_HOST_REACT__/REACT_DOM/USE_TRANSLATION__`、`__POLARIS_HOST_INVOKE__`（30 命令白名单）、`__POLARIS_HOST_LISTEN__`（chat-event 三级过滤）、`__POLARIS_SEND_TO_CHAT__`（空实现兜底）、`__POLARIS_WORKSPACE_API__/THEME_API/SESSION_API/CHAT_CARDS_API__`、`__POLARIS_HOST_WORKSPACE__`；
3. `bootstrapTheme()`（render 前同步注入 CSS 变量防 FOUC）；
4. `initPluginToolUsageObserver()`（fire-and-forget）；
5. PROD 下注册 PWA Service Worker；DEV 纯 Web 模式先 `ensureDevDiscoveryReady()`；
6. `ReactDOM.createRoot(#root).render(<StrictMode><RootApp/></StrictMode>)`。

`App.tsx` 初始化（无全局 Provider 树，纯 Zustand + i18n 单例）：`useAppInit`（loadConfig → pluginStore.loadPluginStates → workspaceStore.syncFromServer → themeStore.syncFromRemote → discoverInstalledPlugins → pluginRegistry.replaceInstalled → applyPluginStyles → pluginServiceManager.autoStartAll → initPerformanceHotSwitch → maybeAutoMigrateOpfs）→ `usePluginServiceSync` → `useAppEvents` → `useWindowManager`（isCompact）→ `useWorkspaceSync`。**会话域初始化已随 chat-desk 插件 bootstrap.ts 迁出宿主**。轻量版最小启动集 = transport + configStore.loadConfig + theme bootstrap + pluginRegistry/discovery + Layout 壳 + 席位空态渲染。

---

## 总结：轻量化的最大杠杆点

最大杠杆点在于**对话域与业务面板已经完成插件化拆分的"最后一公里"**：cap 总线（router/mod.rs 1.8k 行 + 34 个 capability）与 plugin-system（manifest 契约 + Blob 模块加载 + 席位/overlay/uiSlot 贡献点）已能承载包括 AI 对话在内的全部 UI，主仓 10.1 万行 Rust + 5.0 万行 TS 中，ai_chat_core(3.0k)、storage_exec(5.0k)、ai/ 引擎(10k+)、proxy(5.0k)、chat-desk(23.7k) 等约 40% 代码都可沿「cap.ai.chat 契约 + chat-event 事件 + session 存储接口」三条既有边缘外移。其次是**收窄宿主桥**：appCoreBridge 当前向插件泄漏 21 个 store 与 30 命令白名单，把通用宿主与对话业务黏在一起——轻量版只需保留「cap dispatch + 事件订阅 + 面板槽位 + 主题/i18n/窗口壳」这一最小核心（合计约 6-8k 行），其余全部走插件契约即可达成核心零业务目标。
