# 宿主瘦身审计报告（host-slimming audit）

日期:2026-11-21 · 方法:逐项以代码/提交历史实测,非评估打分 · 范围:src/ + server/(核心 7526 行)+ 与前几轮结论合并 · **v2:新增 §7 逐项可行性核查,修正初版三处误判**

> **v2 修订说明**(核查依据均可复核):
> ① chrome 外移:初版判「机械搬移」→ 实测发现**存在两套 tab chrome**(SlotOutlet + WorkspaceTree 各一套),且插件契约无「包裹宿主渲染」机制(SlotEntryView 直接 `<Comp />`),修正为「契约先行」;
> ② workspace 抽出:初版判「目录自包含可搬」→ 实测 `src/core/types.ts:160` 反向依赖 workspace/schema,且 SlotLayout 以 WorkspaceTree 为渲染路径本身,修正为「重构核心渲染路径」;
> ③ 探测搬移:初版判「零契约变更」→ 注入依赖核实成立,但补「写回双头」风险。
> 证实项:chat-lite 零外部 import(实测空)、engine-kit 纯函数无依赖、冻结 workspace 零风险。
> **§8 为改造后成功图景:分项行数账 + 三档成功标准(A 立闸/B 止血瘦身/C 理念兑现)。**

## 0. 一句话结论

核心超重不是均匀漂移,而是**两次无守卫的功能冲刺**造成的:2026-11-19 的 workspace 布局树(+2633 行,当前零插件消费者)与 2026-11-20 的 tab chrome(+380 行 + 215 行 CSS,自述理由是「宿主最小改」)。原始理念「核心零业务」在前端核心上已名存实亡,且**没有任何机制阻止下一次**。本报告给出:可插件化清单(7 项,含证据与去向)、防膨胀机制(4 道闸)、与 engine-kit/chat-lite 拆分合并后的总路线图。

---

## 1. 事实账本:核心 7526 行的构成与归属判定

| 模块 | 行数 | 判定 | 证据 |
|---|---|---|---|
| src/core/workspace/ 全目录 | **2633** | ❌ **应插件化(或冻结)** | 零插件消费(见 §2.1) |
| src/styles.css | 819 | ⚠️ 应拆分 | 基线 603 → 819;tab chrome 占 283-497 段 |
| server/providers-api.mjs | 590 | ⚠️ 平台+业务混合 | CRUD/密钥保管=平台;probe/catalog=业务(见 §2.4) |
| src/core/SlotOutlet.tsx | 468 | ❌ 应瘦身 | 基线 87 行 → 468;300 行是 tab 管理业务 |
| server/auth-session.mjs | 398 | ✅ 平台 | 鉴权 |
| src/core 契约面(types/bus/hostRuntime/slotRegistry/policy/…) | ~980 | ✅ 平台 | 总线/注册表/审计,四槽容器本职 |
| src/core/SlotLayout + shellState + externalPlugins | ~530 | ✅ 平台 | |
| server 其余(relay/store/prod/policy/http) | ~600 | ✅ 平台 | 中继与配置保管 |
| src/plite-tokens.css + main.tsx | ~280 | ✅ 平台 | |

**时间线实锤(核心膨胀史)**:

```
2026-11-18  基线:      SlotOutlet 87 行 / styles.css 603 行 / 无 workspace
2026-11-19  workspace:  +2633 行(布局树三连提交,一天落地)
2026-11-20  tab chrome: SlotOutlet 87→468 / styles.css 603→819(提交自述「方案C,宿主最小改」)
```

「核心零业务」的服务端侧有 server-boundary.test.mjs 守卫(只盯 /api/fs/、/api/tool/ 两个前缀),**前端核心完全无守卫**——两次膨胀都从前端进来,不是巧合,是漏洞所在。

---

## 2. 可插件化清单(逐项证据 + 去向)

### 2.1 workspace 布局树(2633 行)——最大单项,当前零消费者

**消费面实测(2026-11-21)**:
- 全仓 30 个插件,`grep views:` 于 plugins/*/index.ts:**零命中**——没有任何插件声明过 ViewDescriptor;
- `grep cap.ui.layout|applyTree|api.workspace` 于 plugins/:**零命中**;
- grants.json:无任何插件持有 ui.layout 相关授权;
- 唯一「用户」是 hostViews.ts 自己发明的 `host.slot.*` 保留视图——为了让布局树能兼容四槽,先造了 2633 行机器,再造 65 行机器让机器认识槽位。

**判定**:这是「插件可声明视图、自由改布局」的前瞻能力,设计本身不差(归属校验/审计齐全),但它**住错了地方**:按本项目自己的理念,前瞻能力应该以插件形态存在,等有消费者再进核心——现在是反过来,零消费者先占核心 35%。

**去向(二选一)**:
- **A. 冻结(推荐先做,零成本)**:不再给 workspace 加任何新功能;等出现第一个真实插件消费者时,若证明能力正确,再执行 B。
- **B. 抽出为 workspace-layout 插件**:目录自包含(src/core/workspace/* 只被 main.tsx:44 接线 + 3 个测试文件引用),抽出后核心失去的只是「树里摆 host.slot 视图」——SlotLayout 仍在,四槽照常渲染。工作量中等(接线、grants、宿主自留 viewRegistry 锚点渲染)。
- **不建议**:留在原地继续演进——那是 35% 的核心预算养一个没人用的能力。

### 2.2 SlotOutlet tab chrome(300 行 + styles.css 215 行)→ shell-chrome 插件

置顶/溢出收纳/搜索/＋n 菜单/⟳ 按钮(SlotOutlet.tsx:118-420,styles.css:283-497)是「面板管理」产品语义,非容器本职。代码高度聚合,搬移是机械的:
- 核心保留:渲染注册表条目 + 激活态持久化 + a11y 骨架;
- shell-chrome 插件提供:tab 条容器组件(含 chrome 全部),经现有 slot 机制挂载;
- 预期:SlotOutlet 468 → ~150,styles.css 同步 -215。

### 2.3 src/styles.css 拆分(819 行)

「核心只持有 .shell-* 与 .slot-*」的注释(592 行)写着原则,但文件里混着 tab chrome(215)、auth 门禁样式、启动告警等。拆分归属:shell-chrome 随 §2.2 走;auth 告警随 mock-auth 走;核心目标 ≤300 行(壳 flex + 槽位 + tokens)。

### 2.4 providers-api 探测半边(~200-250 行)→ model-admin 的 server 半边

providers-api.mjs 已从「CRUD+密钥保管」长到 590 行,新增的探测链(modelsdev-catalog 引用、/api/providers/probe、note-probe、逐模型探针)与 model-admin/detect.ts 是同一件事的两半——detect.ts 头注释自己写明「服务端负责真实探测,本模块只做纯计算合并」。server 半边本就接收 `store` 注入(server-registry 契约),探测端点搬去 model-admin/server.mjs **零契约变更**。留在宿主的理由(密钥不出后端)依然成立——密钥仍在宿主 store,探测只是用它。modelsdev-catalog(105 行)随迁。

### 2.5 mock-auth 语义渗入核心的清理(小项)

`CAP_AUTH`/`SLOT_AUTH`/`EVENT_AUTH_CHANGED` 契约常量在核心是对的;但 chat-lite/index.ts:27 硬编码 `mock-auth.session.v1` sessionStorage 键属 P0 暗通道项(见 §4 路线图),此处不重复。

### 2.6 chat-lite(8662 行)——纵切三层,不横切三槽

10 个文件共享同一 useSessionStore,横拆三槽会制造第四个状态插件;正确切口是把事实契约上移:
1. 消息模型(store.ts:35-104 的 ToolCardData/AssistantBlocks/InteractiveCardData/ArtifactCardData)→ @sdk;
2. `__PLITE_ARTIFACT_RENDERERS__`(12 处 window 引用)→ 渲染器注册 cap;
3. UI 壳(sidebar/stream/input)保持单插件。

### 2.7 新引擎成本 → engine-kit 框架插件

三引擎实测:codebuddy-engine 137 行靠手抄 real-engine 的 SSE 循环才这么薄;real-engine 内有 ~300-400 行可复用资产(emitUsage 方言链 55 / 断流重试续写 100 / 限值揭示 40 / tool_calls 聚合+interrupt map+estimateTokens 150)没被共享。且 chat-lite 消费的 **17 种事件 kind 不存在于任何契约文档**——只靠三个引擎实现互相看齐。

engine-kit(纯函数共享构建时模块,precedented 于 shared.plugin-config.ts):sse / toolcalls / usage / retry / limits / interrupt / **events(事件词汇表,入 @sdk)**。新引擎期望成本 ≈ 100-150 行接线层。docs/ai-engine-contract.md 的 v0.1 草案(未实施)是它的重型前身,不必等。

### 2.8 已核查、判定不动的

- server/auth-session(398)、relay/store/prod/policy(~600):平台本体;
- bus/types/hostRuntime 等契约面(~980):平台本体;
- SlotLayout/externalPlugins/shellState(~530):平台本体;
- 四槽容器本身:理念核心,不是臃肿。

---

## 3. 防膨胀机制(回应「后面无节制加东西」)

膨胀不是意志问题,是**路径阻力问题**:今天往宿主加一行代码比写一个插件容易 10 倍,所以功能总是走捷径进核心。四道闸把阻力反转:

### 闸 1:核心行数预算门禁(host-budget.test.mjs)
```text
assert: src/core + src/styles.css + plite-tokens.css + main.tsx + server/ 总行数 ≤ N
豁免清单:显式列在测试文件内,新增豁免必须附一行理由
```
N 按本报告 §5 瘦身后水位定(建议 4200,含 server)。豁免清单本身成为「核心变更台账」。**原理:让「往核心加东西」从沉默操作变成需要留名留理由的操作。**

### 闸 2:前端边界测试补位(对称于服务端 boundary 测试)
server-boundary.test.mjs 只守两个 URL 前缀。补:
- src/core/ 禁止出现 UI 产品语义词汇(pins/溢出菜单/置顶/搜索框等 chrome 概念),如同服务端禁领域端点;
- 新增 src/core/ 文件(非豁免清单)→ 失败:防 workspace 式整目录进场;
- window.__ 双下划线全局 → 构建期 fail-fast(build-plugins 十步校验加一步):现有 5 条暗通道(22 引用)全部收编后此闸归零成本。

### 闸 3:manifest 单一事实来源 + 死能力探测器
- 4 处手写登记(manifest / build-plugins 清单 / server-registry / grants)→ manifest 派生,「漏登记」类错误从「靠十条校验抓」变「不可能发生」;
- 构建期死能力检查:某 provides 在 grants 无消费者授权且宿主无引用 → 警告。**此检查若早两周上线,cap.ui.layout 的 2633 行当时就会被当众质疑。**

### 闸 4:新功能默认路径声明
新增任何面向用户的能力,默认形态 = 插件;确需进核心的(如总线新事件类型),走 docs/ 下一条 5 行 ADR(动机/为何不能是插件/撤除条件)。workspace 若当时被要求写这条 ADR,「等第一个消费者」的答案会直接否决它进核心。

---

## 4. 总路线图(合并前几轮结论;规模/依赖列已按 §7 可行性核查修订)

**实施状态(2026-11-21 回写)**:
- ✅ **P0-1 已实施**:5 条 window 通道 + 1 条存储键收编进 @sdk 契约常量(CHANNEL_*/KEY_*),8 个插件 12 处引用改接线;build-plugins 新增暗通道门禁(5 个受保护通道,负例验证会拦截)。
- ✅ **P0-2 已实施**:plugins/engine-kit/ 落地(usage/sse/limits/interrupt/vocabulary 五模块,纯函数零依赖);事件词汇表两层登记 18 kind(引擎 11 + 编排 8,tool.card 双层);real-engine 接线(851→723 行)、codebuddy-engine 接线(137→132 行,删手抄 SSE);tests/engine-kit.test.mjs 7 测试固化为契约。
- ✅ **P0-3 已实施**:闸 1 tests/host-budget.test.mjs(预算 7600,当前水位 7527,豁免台账制,正/负例双验证);闸 3 死能力探测进 build-plugins(实测捕获 1 条:phone-agent cap.tool.phone)。
- ✅ **P1-1 已实施**:tests/workspace-freeze.test.mjs(文件清单快照 + 行数水位 2729 ±3% + 解冻条件监测 3 测试)。
- ✅ **P2-1 已实施**:探测半边(test/probe/note-probe/fetch-models + modelsdev 目录)迁至 plugins/model-admin/server.mjs(553 行,server-registry 登记);宿主 providers-api 590→148 行,modelsdev-catalog.mjs 删除;写回仍走宿主注入的 store.updateModels(防双头,§7.3 对冲落实);providers-api 未命中路由改 pass-through(插件链可认领)。providers-probe 集成测试 2/2 经真实 mock 上游验证。
- ✅ **P1-2 已实施**:契约扩展 TabChromeProps/ContainerDescriptor 入 types.ts+@sdk(contributes.containers);slotRegistry 增容器注册;SlotOutlet 保留状态权威(激活/置顶/懒挂载/刷新序号),chrome 渲染委托 shell-chrome 插件(置顶/＋n/搜索/⟳/roving/几何测量),无注册回退内置简版;SlotOutlet 468→281 行,styles.css 819→628 行;CSS 全部作用域化(.sc-*),窄屏 sheet 因门禁禁 fixed 改为下拉加宽形态。WorkspaceTree 冻结段未动(共用基础 .slot-tab 类)。
- ✅ **P1-3 已实施**:消息模型(ToolCardData/ToolCardMessage/InteractiveCardData/ArtifactCardData/AsstBlock/AssistantBlocks/AssistantBlockMessage/SessionStoreMessage)上移 src/core/types.ts 并经 @sdk 暴露;chat-lite/store.ts 改 re-export(文件内引用零改动);替换对话 UI 从「抄 16+ 私有类型」变为「按公开契约编程」。源码守卫测试同步改指契约层。
- ✅ **P2-2 已实施(2026-11-22,所有者决议启动 §7.1 抽出)**:布局树实现迁 plugins/workspace-layout(WorkspaceTree/store/treeOps/layoutCap/hostViews/hostStore 六文件 + layout.css);schema 契约经 @sdk/schema 单一事实源(核心 re-export 同源);SlotLayout 委托 layout-root 容器(renderAnchor/resolveView 注入,布局插件不认识 SlotOutlet),无插件回退固定四槽;layoutCap 经 api.registerCapability 注册(grants 双闸);restore→变更时序不变量机械化(ensureRestored);viewRegistry 留核心(manifest 解析层,与 slots 平级);核心 workspace 目录仅剩契约四文件(workspace-freeze 守卫改档为迁出守卫:实现回流即红)。
- **门禁全绿**:typecheck ✅ / npm test 332/332 ✅ / build:plugins 32 插件 42 项 ok ✅ / 宿主 bundle 重建 ✅(渲染路径 import 全链编译)。
- **必修包(2026-11-22,三 agent 交叉审查后)**:修1 drawer 双向通知链(P0:宿主 setDrawer 派发 CHANNEL_DRAWER_EVENT+初值发布,插件订阅同步,双向防环);修2 containers 构建期校验(kind 枚举 fail-fast,负例验证);修3 暗通道门禁 5→7 条;修4 wire 从渲染体移 main.tsx 装载后(wire 缺失 boot notice);修5 本文档容器贡献节。
- **C 档决议(三 agent 评估)**:不做完整 C 档。①auth-session 是注入源(getSession/verifyTempToken 由 host.mjs 先造再注入全部插件),下沉=鸡生蛋;②全沉 server 平台面仅到 ~3720,离 1600 甚远,1600 须再剥前端壳层=否定平台定位;③relay 是 2026-11-20 事故修复高危区,搬移=回归风险换 138 行。折中:providers-api(-148)可选;预算 4800 维持。
- **核心水位变化(全程)**:7527 → **4679(-38%)**,预算下调锁定 B 档(4800)。分项:providers-api -442、workspace -2650(核心)→插件、SlotOutlet -187、styles.css -306、types.ts +契约扩展。C 档剩余(核心 ~1600)需把 auth/providers 平台面进一步下沉,见 §8.2。

| # | 事项 | 规模 | 依赖与先决条件(§7 核查后) |
|---|---|---|---|
| P0-1 | **闸 2 的 window 全局 fail-fast + 收编 5 条暗通道** | 小 | — (chat-lite 拆分的前置阻断项) |
| P0-2 | **engine-kit + 事件词汇表入 @sdk(分两层:引擎词汇 / 编排层词汇)** | 中 | — (新增引擎成本 400 行 → 150 行);词汇表必须分层,`tool.card` 在 agent-loop:812 与 codebuddy/server.mjs:117 两层出现是实证 |
| P0-3 | **闸 1+闸 3:预算门禁 + manifest 派生 + 死能力检查** | 小 | 按当前水位先立闸,再瘦身 |
| P1-1 | **workspace 冻结**(零成本停止失血) | 冻结零成本 | — ;冻结 ≠ 省行数:2633 行仍是核心,且它是当前唯一渲染路径(SlotLayout 经 WorkspaceTree) |
| P1-2 | tab chrome → shell-chrome 插件 + styles.css 拆分 | **中→大** | P0-1;**先决:扩 manifest 契约新增 container/chrome 贡献类型**(现契约插件拿不到 tab 条渲染权),且需**合并两套 chrome**(SlotOutlet 与 WorkspaceTree 各一套 tab 条,后者 398 行注释自述与前者同构) |
| P1-3 | chat-lite 纵切:消息模型上移 @sdk → 渲染注册 cap → UI 壳保持单体 | 大 | P0-1;P0-2 事件词汇表;**已实测零外部插件 import chat-lite,上移无阻力** |
| P2-1 | providers-api 探测半边(~250 行)→ model-admin server 半边 | 中 | 注入依赖核实成立;**须防写回双头**:store.updateModels 是共享写路径,探测结论写回应继续经宿主 store 注入,不得在插件侧另立 |
| P2-2 | workspace 抽出为插件(2633 行出核心) | **大(重构核心渲染路径,非目录搬移)** | P1-1 验证有真实消费者;**三个先决**:① AnchorId/WorkspaceNode 从 types.ts:160 剥入 @sdk(核心契约面现反向依赖 workspace);② SlotLayout 回退固定四槽渲染;③ 与 P1-2 的 chrome 合并统一 |

## 5. 量化预期

| 指标 | 当前 | 瘦身后 |
|---|---|---|
| 核心总行数 | 7526 | **~4200**(workspace 冻结计) / **~1600**(workspace 抽出计) |
| src/styles.css | 819 | ≤300 |
| SlotOutlet | 468 | ~150 |
| 核心占全仓比例 | ~18% | ~10%(冻结) / ~4%(抽出) |
| 新引擎成本 | 300-400 行(含手抄方言知识) | 100-150 行 |
| 跨插件暗通道 | 5 条 window 全局 + 1 条共享存储键,零可见性 | 0(构建期禁止) |
| 无守卫面 | 前端核心完全无守卫 | 预算门禁 + 边界测试 + 死能力检查三重 |

> 注:§5「冻结」档的 4200 行不含 workspace 抽出收益;若只冻结不抽出,核心仍保留 2633 行零消费者能力——冻结是止血,不是瘦身。

## 6. 结论

「核心零业务」在这个项目里**服务端做到了,前端核心失守了**——失守点清晰(workspace +2633 / tab chrome +600),失守原因清晰(无门禁 + 「宿主最小改」的捷径文化),失守证据清晰(零消费者能力占核心 35%)。修复顺序应当是:**先立闸(P0-3,防再次失血)→ 收编暗通道与 engine-kit(小中成本,立刻兑现「任意替换」)→ 冻结 workspace(停止最大失血点)→ 再做 chat-lite 纵切与两项物理搬移**。所有判定均附文件级证据,可按表逐项复核。

---

## 7. 逐项可行性核查(v2 新增:对 §2 每个迁移建议的依赖方向 / 契约缺口 / 搬移风险实证)

**核查方法**:对每项建议回答三个问题——①依赖方向是否允许搬移(谁 import 谁)?②插件契约是否有承接机制?③搬移后什么会破?

### 7.1 workspace 抽出 —— 判定修正:重构核心渲染路径,非目录搬移

- **依赖方向实测**:`src/core/types.ts:160` `import { AnchorId, WorkspaceNode } from './workspace/schema'` ——**核心契约面(平台本体)反向依赖 workspace**。抽出必须先把 AnchorId/WorkspaceNode 提升进 @sdk,否则插件侧无法引用这两个类型。
- **渲染路径实测**:`SlotLayout.tsx:11-12,167` 直接渲染 `<WorkspaceTree node={snapshot.tree} />`,头注释自述「四个固定槽位不再写死在 JSX 里,而是由工作区树渲染」。**workspace 已是核心渲染骨架本身**,不是挂在 main.tsx 上的可摘附件。抽出 = SlotLayout 回退固定四槽(或经新的容器契约动态取渲染器)。
- **隐藏耦合**:WorkspaceTree.tsx:147,210 内部又渲染 `<SlotOutlet>`,且自带一套与 SlotOutlet 同构的 tab 条(见 7.2)——workspace 与 SlotOutlet 互相咬合,抽出会牵动两者。
- **结论**:可行,但是三步重构(类型上移 → 渲染骨架回退 → chrome 合并),非机械搬移。「冻结」则零风险:默认树与四槽等价,冻结只是停止演进,不破坏任何现状。

### 7.2 tab chrome 外移 —— 判定修正:契约缺口先行,且须合并两套 chrome

- **两套 chrome 实测**:①SlotOutlet.tsx:118-420(置顶/＋n/搜索);②WorkspaceTree.tsx:396-412(tab 条 + 滚轮转横向 + scrollIntoView,注释自述「与 SlotOutlet 的 tab 条同一交互约定」)。初版报告漏计第二套。
- **契约缺口实测**:`SlotEntryView`(SlotOutlet.tsx:87-99)对插件组件直接 `<Comp />`,**manifest 无任何 container/chrome 贡献类型**(types.ts grep 零命中)。插件今天拿不到 tab 条的渲染权——「外移」前必须扩展契约:新增 `contributes.containers` 之类的贡献点,宿主把 tab 条挂载权交给插件组件,激活态/持久化经 props 或注入 API 下放。
- **规模修正**:契约扩展 + 两套 chrome 合并 → 「中」升「中大」。若不扩契约,替代路径是把 chrome 留在核心、只把 styles.css 的 tab 段迁给插件样式文件——收益减半,不推荐。

### 7.3 providers-api 探测搬移 —— 判定维持:可行,补一个风险

- **注入依赖核实**:探测端点(providers-api.mjs:410-470)只使用 `store.get`、`policy.assertAllowedUrl`、`getSession`——三者均在 server-registry 的 createServerPart 注入契约内,**零契约变更成立**。
- **新增风险(写回双头)**:探测结论经 `store.updateModels`(542 行)写回供应商存储。搬移后 model-admin 若在插件侧另立写回逻辑,会形成宿主/插件双头写同一数据。**约束:探测搬移,写回仍走宿主注入的 store 方法**,不复制。
- **modelsdev-catalog(105 行)随迁**:其缓存文件路径派生自 `store.file`(providers-api.mjs:36),随探测一起走即可。

### 7.4 chat-lite 纵切 —— 判定强化:实测零外部依赖,上移无阻力

- **依赖实测**:`grep "from.*chat-lite"` 于 plugins/(排除自身)→ **零命中**。没有任何插件 import chat-lite 内部模块。消息模型(ToolCardData/AssistantBlocks 等)上移 @sdk 时,不存在隐藏的反向依赖需要处理。
- **事件流链路实测**(决定词汇表形态):引擎 emit →(cap.ai.chat:event)→ agent-loop:371 消费并**重发/自产**事件 →(cap.agent.loop:event)→ chat-lite 消费。`tool.card` 在**两个层**产生:agent-loop:812(编排层,审批流)与 codebuddy-engine/server.mjs:117(引擎层,服务端直发)。**事件词汇表必须分两层登记**(引擎词汇:delta/reasoning/done/error/usage/tool.calls…;编排层词汇:tool.card/approval/context.compact/stream.retry…),不能混一张表。
- **三引擎发射面实测**:mock-engine 只发 message.delta/message.done——**词汇表事实上只被 real-engine 全量实现过一次**。这正是「新引擎照谁实现」没有答案的实证,词汇表入契约的必要性由此确立,而非仅是「应当」。

### 7.5 engine-kit —— 判定强化:纯函数无依赖,前置为零

- **依赖实测**:WireUsage(58 行)/estimateTokens(68 行)等候选模块均为纯函数,无 store、无 fetch、无插件间引用。precedent(shared.plugin-config.ts)已在构建期共享,路径畅通。
- **新引擎成本验证样本**:codebuddy-engine 137 行,其中 SSE 循环(~30 行)是手抄 real-engine 的同构代码(其注释自认)。kit 落地后同类引擎只剩端点/鉴权/直连降级接线,期望 100-150 行。

### 7.6 预算门禁 —— 判定维持:操作面有现成先例

- server-boundary.test.mjs 已示范 stripComments + 白名单模式,预算门禁豁免制是同一模式的行数版;豁免清单物理上就是「核心变更台账」,无新技术风险。

### 7.7 mock-auth 会话键 —— 判定维持

- chat-lite/index.ts:27 与 mock-auth/index.tsx:14 双写 `'mock-auth.session.v1'`,属 P0-1 暗通道收编范围,收编进 @sdk 常量 + 构建期禁 window/storage 裸通道即可,无独立重构需求。

### 7.8 核查总结

| 建议 | 初版判定 | 核查后 | 关键证据 |
|---|---|---|---|
| workspace 抽出 | 目录自包含可搬 | **重构核心渲染路径**(类型反向依赖 + 渲染骨架咬合) | types.ts:160 / SlotLayout.tsx:167 / WorkspaceTree 内嵌 SlotOutlet |
| chrome 外移 | 机械搬移 | **契约缺口先行 + 双套 chrome 合并** | SlotEntryView 直渲染 / manifest 无 container 类型 / WorkspaceTree 第二套 tab 条 |
| 探测搬移 | 零契约变更 | **成立,防写回双头** | 注入契约全覆盖(providers-api.mjs:410-470) |
| chat-lite 纵切 | 方向正确 | **强化:零外部依赖,无阻力** | 全仓 grep 零命中;事件两层产生(agent-loop:812 vs codebuddy server:117) |
| engine-kit | 方向正确 | **强化:词汇表单点实现实证** | mock-engine 仅 2 kind;codebuddy 手抄 SSE 30 行自认 |
| workspace 冻结 | 零成本止损 | **成立(渲染路径在用,冻结不破坏)** | 默认树 = 四槽等价(hostViews) |

**对路线图的影响**:P1-2 与 P2-2 的真实成本高于初版估计,排序不变(先闸 → 暗通道 → engine-kit → 冻结 → 纵切 → 物理搬移),但两者开工前各有明确先决条件,不可跳步。

---

## 8. 改造后成功图景(逐项行数账:v2 按当前 HEAD 精确重算)

**口径说明**:「当前」列为实测值(2026-11-21 HEAD);「改造后」为分项推算,推算依据逐格标注。核心口径 = src/(不含 workspace 时也不含其测试)+ server/。

### 8.1 核心分项账(当前 7527 → 目标 1374-2154)

| 核心模块 | 当前(实测) | 改造后 | 推算依据 |
|---|---|---|---|
| src/core/workspace/ 全目录 | **2650** | **0**(P2-2 抽出)或 2650(仅冻结) | 抽出后随迁 3 个测试文件(workspace.test 609 + workspace-cap 247 + host-views 192,测试不计核心口径) |
| server/providers-api.mjs | 590 | **~330** | 探测半边迁出:test(415-447,33)+ probe(448-520,73)+ note-probe(521-557,37)+ probeCatalog(71-105,35)+ modelsdev-catalog(105)≈ 283 行;CRUD/密钥/直连档留宿主 |
| server/modelsdev-catalog.mjs | 105 | **0**(随探测迁 model-admin) | 同上 |
| src/core/SlotOutlet.tsx | 468 | **~170** | chrome 区段(置顶/＋n/搜索/几何测量,实测 47 处引用散布 118-420)外移 shell-chrome;保留渲染/激活持久化/a11y 骨架 |
| src/styles.css | 819 | **~380** | tab chrome 段(283-497,215 行)随 shell-chrome 走;auth 门禁段(498-570)评估后部分随 mock-auth;壳/锚点/槽位/移动端段保留 |
| src/core 其余(types/bus/hostRuntime/slotRegistry/policy/shellState/externalPlugins/metaCapability/useAuthGate/Brand/SlotLayout) | 1403 | **~1450** | 平台本体不动;types.ts 因 AnchorId/WorkspaceNode 上移 @sdk 净 ±50;P1-2 契约扩展(container 贡献类型)+~50 |
| server 平台其余(auth-session 398 + relay 138 + provider-store 177 + host 41 + http-util 66 + prod-server 120 + upstream-policy 79) | 1019 | **~1019** | 平台本体不动 |
| src/main.tsx + plite-tokens.css | 282 | **~282** | 不动 |
| **核心总计** | **7527** | **1374-2154** | 见 8.2 分档 |

### 8.2 分档成功标准(三档,对应执行深度)

| 档 | 内容 | 核心行数 | 较当前 | 达成判据(全部可测) |
|---|---|---|---|---|
| **A. 立闸档**(P0 全部) | 三重门禁立起 + 5 暗通道归零 + engine-kit 落地 + 事件词汇表入 @sdk | **7527(不变)** | ±0% | ① host-budget 测试存在且豁免清单=核心变更台账;② 构建期 window.__ 扫描零命中;③ kit 被三引擎引用,新引擎 ≤150 行;④ 词汇表两层(引擎/编排)入 @sdk 且 chat-lite 消费的 17 kind 全部有出处 |
| **B. 止血+瘦身档**(A + P1-1/P1-2/P1-3) | + workspace 冻结 + chrome 外移 + chat-lite 纵切 | **~4300** | **-43%** | ① workspace 目录 90 天零新提交;② SlotOutlet ≤200 行、styles.css ≤400 行;③ 消息模型在 @sdk,chat-lite 不再私持 ToolCardData 等 16+ 类型;④ 换 UI 插件不需读 chat-lite 源码即可对齐协议 |
| **C. 理念兑现档**(B + P2-1/P2-2) | + 探测迁 model-admin + workspace 抽出为插件 | **~1374-1600** | **-80~-82%** | ① providers-api ≤350 行且探测端点在 model-admin/server.mjs;② src/core/workspace 目录不存在;③ 核心占比 ≤4%(对 Polaris 基线 151k 的兑现:S02 方案核心 ~9k 的 1/6) |

### 8.3 全仓与质量指标(改造前后)

| 指标 | 当前(实测) | 改造后 | 依据 |
|---|---|---|---|
| 核心占全仓比例(核心 7.5k / 全仓 src+server+plugins ~41.8k) | 18% | **3-5%**(C 档) | 核心瘦身不增插件总量(搬移=位移,非复制;chat-lite 上移的 70 行类型进 @sdk 计契约不计核心) |
| 新 AI 引擎成本 | 300-400 行(codebuddy 手抄 30 行 SSE 自认 + emitUsage 54 行方言链 + retry ~165 行 + toolcalls/interrupt ~150 行全要重抄) | **≤150 行**(kit 接线 + 引擎特有) | §7.5;codebuddy 重写后预期 137→~100 行 |
| 事件 kind 契约化率 | 0/17(chat-lite 消费 17 种,文档零登记) | **17/17**(两层词汇表) | §7.4 |
| 跨插件暗通道 | 6 条(5 window 全局 22 引用 + 1 共享存储键) | **0**(构建期 fail-fast) | §2/§3 闸 2 |
| 无守卫面 | 前端核心零守卫 | 预算门禁 + 边界测试 + 死能力检查 | §3 |
| 核心变更留痕 | 无(膨胀零摩擦,11-19 一天 +2633 无任何记录) | 每次豁免留名留理由(豁免清单=台账) | §3 闸 1 |

### 8.4 风险与对冲(行数目标的两条最可能跑偏路径)

1. **「搬移变复制」**:P2-1 探测迁移时若 model-admin 复制写回逻辑 → 核心瘦了但全仓变胖。对冲:§7.3 已写死「写回走宿主注入的 store 方法」;死能力检查可扩展为「同语义双实现」警报。
2. **chrome 合并失控**:P1-2 的两套 tab chrome(SlotOutlet + WorkspaceTree)合并时若各留一份 → 行数不降反升。对冲:先合并再外移(一次搬移,一份实现),预算门禁兜底——超 380 行即红。

### 8.5 成功的定义(一句话)

**行数不是目的,是约束的读数**:A 档证明「没人再能悄悄膨胀」(闸在工作),B 档证明「臃肿可逆」(2633+600 行业务语义离核),C 档证明原始理念成立——核心 1.4k 行、全仓 4%、新引擎 150 行、换 UI 只读契约不读源码。到 C 档时,这个仓就是当初十方案评审想要的那个答案的**完成态**。
