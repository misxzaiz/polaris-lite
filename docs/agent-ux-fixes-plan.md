# Agent 对话 UX 修复整合方案 v2（工具卡排序 + 审批卡可见性 + 完全信任开关）

> **历史文档**：文中 agent-loop 相关实现已随 2026-11-26 后端编排化迁移到服务端
> agent-runner（工具卡/审批卡事件形状不变，渲染层零改动）。现状见
> docs/agent-runner-implementation.md。

> 前置：docs/tool-block-ordering-analysis.md（排序根因 + Polaris 折叠设计，已实读源码）。
> 本文档整合三组用户反馈为一次改造包，全部纯插件实现（chat-lite + agent-loop），宿主零改动。整理定稿待确认后实施。

---

## 问题 1：工具卡沉底（答案之下）——根因与方案

**根因（已实锤）**：一次编排的所有轮次文本挤进一条 assistant 消息，工具卡是独立消息只能排在其后；模型在调工具前后都输出文本时，卡片必然沉底。线性消息列表无法表达「文本→工具→文本」交错。

**方案（Polaris 同构，~210 行）**：assistant 消息改 `blocks[]`（text 块/tool 块按事件序追加）+ agent-loop 的 `message.delta` 增加 `turn` 字段显式传递轮次边界 + 收敛版 blockGrouping（连续 tool 块归组折叠：流式平铺→结束自动折叠汇总条→点击展开）。详见 docs/tool-block-ordering-analysis.md，此处不赘述。

---

## 问题 2：审批卡被输入框盖住 / 要上拉才看到

### 根因（MessageStream.tsx 实测）

1. **自动跟随有条件**：`useEffect` 仅在 `atBottom === true` 时 `scrollIntoView`——用户在第 0 轮流式期间往上翻阅内容，`atBottom` 变 false；随后审批卡到达（追加/更新消息），**不触发任何滚动**，卡片留在视口之下，用户必须往下拉才看到；
2. **无 scroll-padding**：即使 atBottom，`block:'end'` 把卡片底边对齐流底部，审批卡较高（命令块+三按钮），在矮视口下顶部会被裁切/贴着输入区，观感是"被输入框盖住"；
3. 审批到达用**消息更新**而非追加（tool.card 先建 running 卡 → approval.required 更新为 awaiting），`[msgCount, lastContent]` 依赖都不变 → 滚动 effect 完全不重跑。

### 修复方案（chat-lite 内，~30 行）

1. **审批到达强制居中滚入**：`handleToolEvent` 收到 `tool.approval.required` 时，对对应卡片元素 `scrollIntoView({ block: 'center', behavior: 'smooth' })` ——无视 atBottom（审批是需要用户行动的高优先级事件，抢焦点是正确语义）；MessageStream 暴露一个经 context/注册表的 `scrollCardIntoView(callId)` 助手（同 ToolCard 直接 import 模块函数的既有模式）；
2. **流容器加 `scroll-padding-bottom`**（= 输入区实际高度 + 间距，约 120px），让 `block:'end'` 的常规跟随也不再贴着输入区下缘裁切；
3. **待审批角标兜底**：审批挂起期间输入框上方浮一条「⚠ 1 项工具执行待确认 · 点击定位」胶囊（复用 chat-queue-pill 样式），点击即 scrollIntoView——双保险，用户上翻多屏也能一键回到审批点。

### 顺带（Polaris 语义对齐）
- 审批卡 resolved 后收敛为一行回执（「✓ 已允许 · type notes.txt」/「⊘ 已拒绝」），释放视觉空间（Polaris approved/denied 收敛模式）。

---

## 问题 3：完全信任 AI（关闭权限确认）——能力已有，可达性不足

### 现状
`mode: yolo` 已实现且服务端裁决：全放行、无审批卡、denylist 仍硬拦截。但开关藏在「Bash」面板 tab 的 radio 里，用户不知道/不顺手。

### 方案（三层暴露 + 一个决策点）

**a. 审批卡上直接给「本次会话信任本工具」快捷项**（最顺手）：
- 审批卡按钮组扩为四个：`允许一次 / 总是允许该前缀 / 本会话信任 bash / 拒绝`；
- 「本会话信任」= loop 内把该工具 cap 加入会话级信任集（已有 sessionAllow 机制，键从 command 前缀升格为工具名）+ 服务端配置不动（服务端仍 confirm，执行时由 loop 带 approved=true——服务端已支持 approved 标记放行）；
- 会话级、不持久化，新会话恢复 confirm——安全边界清晰。

**b. 输入区常驻信任状态徽标 + 一键切换**：
- 输入区左下角小 chip：「🛡 审批模式」/「⚡ 信任模式」（点击切到 Bash 面板对应项，或直接就地切换）；
- 数据源 = agent-bash 的 getConfig（已有），切换走 setMode；
- 信任模式下 chip 高亮，明确告知"当前 AI 可直接执行命令"。

**c. Bash 面板现有 radio 保留**（已是完整管理面）。

**决策点（需要用户拍板）**：denylist 是否在"完全信任"下也可豁免？
- **推荐：不可豁免**（现状）。denylist 拦的是 `rm -rf /`、`curl|sh`、写凭据存储这类不可逆破坏，yolo 信任的是"AI 的判断"，不该等同"AI 可以执行任何破坏性命令"——被拒时 loop 会把拒绝原因喂回模型，模型会改用安全方式；
- 若确实要完全无限制：加一个独立 `mode: 'unrestricted'`（服务端单独校验 + 面板二次确认 + 红色警示），不建议与 yolo 合并。

**推荐做法**：denylist 保持硬底线 + 提供 a+b 的快捷入口。若用户要 unrestricted 再加。

---

## 实施批次（确认后一次做完，预计总量 ~300 行纯插件改动）

| 批 | 内容 | 涉及 |
|---|---|---|
| B1 | blocks 数据层 + loop turn 字段 + 渲染分支（修排序） | store/index/MessageStream/agent-loop |
| B2 | blockGrouping 收敛版（流式平铺/结束折叠汇总条/失败摘要/耗时>1s） | chat-lite 新组件 |
| B3 | 审批可见性：居中滚入 + scroll-padding + 待审批胶囊 + 回执收敛 | MessageStream/ToolCard |
| B4 | 信任快捷项：审批卡第 4 按钮 + 输入区信任徽标 | ToolCard/ChatInput/agent-loop/agent-bash |

**回归清单**：yolo 全链路 / confirm 审批闭环 / 总是允许持久化 / 中断即时收敛 / denylist 403 / 旧会话（无 blocks）渲染 / 排序正确性（模型工具前后都有文本的用例）/ tsc + build-plugins + 三档宽度截图。
