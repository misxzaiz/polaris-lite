# 插件管理面板（plugin-manager）规划与实施记录

> **状态：已实施并真机验收（2026-11-20）。** 规划原文保留如下，文末附实施记录。

## 目标

提供一个**纯插件**实现的插件管理面板——查看全部插件、启用/禁用（重启生效）、
调整插件在界面上的位置（打开/关闭/移动视图、切换面板、恢复默认布局）。
不新增宿主能力：只消费既有 `cap.ui.layout`（视图注册表在 `cap.meta` 侧补充暴露）。

## 一、能力盘点（代码事实，2026-11-20）

| 既有机制 | 位置 | 对本插件的意义 |
|---|---|---|
| `registry.json`（前端清单，`enabled` 字段） | `public/plugins/registry.json`（构建产物，gitignore） | 启用/禁用的落点；运行时 `loadExternalPlugins` 按 `enabled===false` 跳过装配 |
| `grants.json`（授权表，入库） | `public/grants.json` | 权限申请 ⊆ 授权；新增插件必须登记 |
| `cap.ui.layout` | `src/core/workspace/layoutCap.ts` | open/close/split/move/applyTree/reset，授权+归属+审计三闸 |
| `cap.meta`（describe） | `src/core/metaCapability.ts` | 已返回 capabilities/audit/policies，**缺 viewRegistry 清单** |
| `cap.kv` | kv-store 插件 | 面板自身偏好持久化（无敏感数据也可用 localStorage，但约定优先 cap.kv） |
| 面板槽位 | `contributes.slots[].slot='panel'` | 面板入口；order 需唯一（现占用 1..10） |

## 二、方案比较

| 方案 | 说明 | 结论 |
|---|---|---|
| A. 宿主新增 `cap.plugin.admin` | 宿主实现启停/枚举 | 违背「新增面向用户能力一律插件实现」；否 |
| B. 纯插件：server 半边读写 `registry.json`/`grants.json` + UI 面板 | 与 file-browser/agent-bash 同构；宿主零改动 | **采纳** |
| C. 只读面板（提示用户手改 registry） | 不满足「支持开关」目标 | 否 |

**禁用语义的关键事实**：插件装配发生在浏览器启动时（`loadExternalPlugins`），
`enabled=false` 只有**下次加载**才生效——即修改后需要刷新页面（或重启应用）。
面板的职责是把这一点明确告知用户（显示「已安排禁用，刷新后生效」），而不是伪装成即时生效。
服务端写 `registry.json` 时同步 bump `?v=` 版本号，保证刷新后拉到新清单。

**位置调整的能力边界**：槽位贡献（slots）的 order/title 由构建期校验、随 manifest 打包，
运行时改不了（也不该由面板改——那是插件作者的决定）。运行时可调整的是**工作区树**里的
视图实例：open/close/move/split/激活 tabs/整体重排（applyTree 需 `.global`）。
因此面板的「位置」页签 = 工作区树可视化 + open/close/move/reset 操作。

## 三、契约设计

### cap.plugin.admin（本插件提供，UI 半边注册处理器，经 server 半边 /api/plugin-admin/* 落盘）

| action | payload | 返回 | 说明 |
|---|---|---|---|
| `list` | — | `{ plugins: [{id,name,version,enabled,listed,capabilities,provides,events,denied,hasServer}] }` | registry.json ∩ 运行时 policyTable ∩ manifests |
| `setEnabled` | `{ id, enabled }` | `{ ok, applied }` | 写 registry.json 的 enabled + bump ?v=；`applied` 恒 false（重启/刷新生效） |
| `getLayout` | — | `{ tree, views }` | cap.ui.layout getTree + listViews 转发（只读快照） |
| `resetLayout` | — | `{ ok }` | cap.ui.layout reset（需 .global 授权） |

为什么经 server 半边而不是浏览器直接 fetch：registry.json 在 `public/plugins/`（静态产物），
写它必须走 Node；会话 cookie 硬门禁沿用 kv-store/html-preview 同款（未登录 401）。
`PLITE_PLUGIN_ADMIN=0` 一键禁用（对齐既有插件的环境开关惯例）。

### cap.meta 扩展（宿主，1 行级改动）

`describe` 返回值增加 `views: viewRegistry.list()`（viewType/title/pluginId）。
理由：`cap.ui.layout.listViews` 要求 `cap.ui.layout` 授权且登录后才可用；插件管理面板
需要在**未登录也可自省**的通道里拿到「装了哪些视图」。viewRegistry 本就是运行时注册表，
describe 已暴露 policies（同一信任级别），新增 views 不扩大攻击面。
（若不想动宿主，退路是面板在 setup 期缓存 `api.workspace.listViews()`——但那要求
plugin-manager 自己持有 cap.ui.layout 授权，权限面反而更大。取 describe 扩展。）

## 四、UI 形态（panel 槽，order 11）

两页签（沿用 pocket-ledger 的内嵌 tab 模式，不占工作区树）：

1. **插件**：全部插件列表（名称/版本/身份徽章/权限摘要/启停开关）。
   - 开关 = setEnabled；点击后行内显示「重启/刷新后生效」；
   - mock-engine 这类构建期 `enabled:false` 的插件同样展示（默认关）；
   - 顶部一行提示：启用/禁用在**下次加载**生效。
2. **布局**：当前工作区树只读渲染（split/tabs/view/anchor 层级 + 每个视图的标题与归属）+
   操作：打开自己关心的视图（listViews 下拉）、关闭视图、恢复默认布局（reset）。
   - 移动/拆分已有拖拽交互（宿主 TabsView/Splitter），面板不重复造轮子，先提供
     「关闭/打开/重置」三个低风险动作；树形可视化给出 id/viewType 归属，便于手动拖拽定位。

## 五、安全与边界

- server 半边：cookie 硬门禁；只允许写 `public/plugins/registry.json` 的 `enabled` 字段
  （白名单键，id 必须已存在于清单；`?v=` 重算 sha256 前 8 位）；
  禁止改 module 路径/grants（权限变更仍走代码评审链）。
- UI 半边：`capabilities: ['cap.plugin.admin', 'cap.meta', 'cap.ui.layout']`；
  `provides: ['cap.plugin.admin']`。`reset` 属全局动作，`.global` 授权写入 grants。
- CSS 全部 `pm-` 前缀；只消费宿主令牌；不用 fixed。
- 失败姿态：registry.json 读不到/解析失败 → 面板显示错误行，不白屏；写失败 toast 行内提示。

## 六、实施清单

1. `plugins/plugin-manager/index.ts`（UI 半边 + cap.plugin.admin 处理器）
2. `plugins/plugin-manager/Panel.tsx`（两页签面板）
3. `plugins/plugin-manager/panel.css`（pm- 前缀）
4. `plugins/plugin-manager/server.mjs`（/api/plugin-admin/list|setEnabled，读写 registry.json）
5. `plugins/plugin-manager/vite.config.ts`
6. `plugins/build-plugins.mjs` 清单 + `plugins/server-registry.mjs` 登记
7. `public/grants.json` 登记（capabilities/provides + cap.ui.layout.global）
8. `src/core/metaCapability.ts`：describe 增加 views（需注入 viewRegistry）
9. 测试：server 半边单测（启停写盘/白名单/401）+ 既有套件回归

## 七、验收

- [ ] `npm run typecheck` 通过
- [ ] `npm test` 全绿（含新增用例）
- [ ] `npm run build:plugins` 通过（18 个插件，registry 回读校验）
- [ ] 5000 开发环境真机：面板可见插件清单；禁用某插件 → registry.json 变更 + ?v= bump；
      刷新后该插件不再装配；重新启用恢复；布局页签可关视图/恢复默认。

---

## 八、实施记录（2026-11-20）

按规划落地，宿主侧仅 2 处小改（metaCapability 透出 views + main.tsx 传入注册表），
其余全部在 `plugins/plugin-manager/`。

### 交付物

- `plugins/plugin-manager/index.ts`：manifest（capabilities: cap.plugin.admin/cap.meta/
  cap.ui.layout/cap.ui.layout.global；provides: cap.plugin.admin；panel 槽 order 11 title「插件」）
  + cap.plugin.admin 处理器（list/setEnabled 薄包装，落盘在 server 半边）。
- `plugins/plugin-manager/Panel.tsx`：两页签面板。插件页签=清单 + 启停开关 +
  「未登记/收紧」徽章 + 「刷新/重启后生效」提示；布局页签=工作区树只读可视化
  （kind/标题/viewType）+ 打开视图（views 下拉 + 落位锚点）+ 关闭已开视图 + 恢复默认布局。
- `plugins/plugin-manager/server.mjs`：GET /api/plugin-admin/list、POST /api/plugin-admin/set-enabled。
  会话 cookie 硬门禁；PLITE_PLUGIN_ADMIN=0 一键禁用；只允许改已存在插件的 enabled 字段
  （id 白名单，module/style/增删/ grants 一律拒绝）；写入原子化（tmp+rename）；
  每次写盘重算 bundle 内容 hash 同步 ?v=。
- `plugins/plugin-manager/panel.css`：pm- 前缀，只消费宿主令牌。
- 登记：build-plugins.mjs 清单（order 17）、server-registry.mjs、public/grants.json。
- 测试：`tests/plugin-manager.test.mjs`（401/硬关闭 next/往返写盘+版本号/未知 id 404/非法参数 400），
  已加入 `npm test` 脚本。

### cap.meta 扩展

`describe` 返回值增加 `views`（viewType/title/pluginId，来自 viewRegistry）。
理由：cap.ui.layout.listViews 需要授权+登录；自省型面板需要免授权只读通道。
宿主改动仅 `src/core/metaCapability.ts`（可选第三参）与 `src/main.tsx`（传入 viewRegistry）。

### 实测踩坑（全部实锤复现并修复）

1. **registry.json 双副本不同步（核心坑）**：build-plugins.mjs 产物写在 `public/plugins/`，
   vite build 再整体拷贝到 `dist/plugins/`；而 dev（vite middleware 静态层）与 prod
   （node server 静态层）都从 **dist/** 提供文件。server 半边最初只写 public/，
   表现为「面板显示已禁用、刷新后浏览器仍装配该插件」——浏览器 fetch 的 registry
   来自 dist/ 的旧副本（curl 验证：public 与 dist 内容不一致，页面 fetch 与磁盘不一致）。
   修法：写盘双写（dist+public），读取以 dist（服务实况）优先。写后页面 fetch 与磁盘逐字段一致。
2. **repoRoot 推导**：不能用 dataDir 向上推（.polaris-lite-dev 向上两级是 D:\space\base），
   必须用 import.meta.url 定位（plugins/plugin-manager/ → 两级上到仓库根）。
3. **chat-lite 产物是 dev runtime**（`e.jsxDEV is not a function`）：并行会话改动后
   dist/plugins/chat-lite 里的旧产物内联了 react-jsx-dev-runtime 且 jsxDEV=void 0，
   壳层渲染为空白。与插件管理面板无关，但会阻塞一切真机冒烟——重建该插件产物后恢复。
   （顺带发现：vite build 会把 public/ 拷进 dist/，但 build:plugins 只更新 public/，
   两者时间戳错位是本插件双写修复的根因。）

### 真机验收（5000 开发环境，Chrome headless CDP，全部通过）

- 登录（真实表单流）→ 壳层渲染，panel tabs 含第 11 个「插件」；
- 插件页签：18 行清单（含 mock-engine=false），18 个开关，提示文案正确；
- 禁用 browser-lite：面板行即时变灰、registry.json（dist+public）enabled=false、?v= 保留；
  刷新后 tab 条里「浏览器」消失；重新启用 → 刷新后「浏览器」回归；
- 布局页签：树可视化 7 行（split/anchor 层级与 id/viewType 正确）；恢复默认布局动作生效；
- `npm run typecheck` 通过；`npm test` 207/207 全绿；`npm run build:plugins` 18 个插件回读校验通过；
  `npm run build`（宿主）通过。

### 边界与已知限制（如实声明）

- 插件槽位 order/title 是构建期 manifest 属性，运行时不可改（也不应改——那是插件作者的决定）；
  面板的「位置调整」指工作区树里的视图实例（open/close/reset）。
- 当前没有插件声明 contributes.views，布局页签的「打开视图」下拉暂无可选项
  （host.slot.* 是结构视图被过滤）；树可视化和 reset 已可用。后续插件按
  plugin-contract 声明 views 后该下拉自动获得选项。
- 启停生效需要刷新/重启（插件在浏览器启动时装配），面板已明确提示。

---

## 九、二次迭代：布局页签重构为「面板排序」（1787b50）

用户反馈：布局页签「看不懂，看着不好用，没有实际意义」。成立——树可视化是开发者
视角；且当前没有插件声明 contributes.views，打开/关闭操作项全是空摆设。

用户真正要的「调整插件位置」是 **panel 槽 11 个面板 tab 的排列顺序**。重构为
「排序」页签（commit 1787b50）：

- 宿主 `slotRegistry.ts` 新增 `orderEntriesByUserOrder` 纯函数：用户顺序表覆盖
  构建期 order（表内按用户排列、表外保持原顺序续后、脏 key 静默忽略、空表直通），
  单测 4 断言进 core.test.mjs；
- `SlotOutlet` 消费 `plite.slot.order.<slot>`（localStorage），监听 storage +
  `plite-slot-order-changed` 自定义事件（storage 事件不触发同文档，面板写侧 dispatch）
  ——**排序立即生效，无需刷新**；
- `cap.meta` describe 增加 `slots` 清单（panel 槽贡献：pluginId/component/title/order），
  作为面板排序的数据源；
- 面板「排序」页签：序号 + 面板名 + 插件 id + ↑/↓/置顶 + 恢复默认顺序，自定义行高亮；
- plugin-manager 不再需要 cap.ui.layout(.global) 授权（不再碰工作区树）。

真机验收：置顶「插件」→ tab 条立即重排；「记账」上移一位生效；恢复默认回原排列；
刷新后自定义顺序保持。typecheck 0 错（提交树），npm test 208/208。
