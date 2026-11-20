# Polaris Lite

参考 [Polaris](../Polaris) 产出的**轻量版设计方案集**：在 AI 对话交互布局完全不变的前提下，探索「核心零业务、一切皆插件」的十种不同实现路径，并用多代理评审团投票选出最优解。

> 本项目与 Polaris 主仓完全独立：不修改 Polaris 任何文件，产物全部落在本目录。

## 背景

Polaris 现状（2026-11-18，HEAD `ff386fad`）：前端 ~5.0 万行 TS + 后端 ~10.1 万行 Rust，对话域与业务面板已大量插件化（chat-desk 以 mainSurface 席位接管对话），但核心仍保留 ai_chat_core、storage_exec、AI 引擎、proxy 等业务代码。本项目的目标是把「最后一公里」走完：核心只留平台能力（cap 总线、插件生命周期、会话契约、主题/i18n/窗口壳），AI 对话 UI 与全部业务面板都由插件提供。

**落地形态（2026-11 更新）**：插件是**双入口**——`plugins/<id>/index.ts`（UI 半边）+ 可选 `plugins/<id>/server.mjs`（server 半边，Node 中间件）。宿主 `server/` 只保留平台能力（鉴权/供应商/模型中继/静态服务），领域能力（文件浏览 `/api/fs/*`、工具执行 `/api/tool/*`）均在插件 server 半边，经 `plugins/server-registry.mjs` 装配，宿主零领域 import。约束细节见 [docs/plugin-contract.md](docs/plugin-contract.md) 的「双入口」节；`npm test` 有 `server-boundary.test.mjs` 守卫这条边界。

## 目录

```
polaris-lite/
├── docs/
│   ├── brief.md      # 总纲：用户目标逐字拆解（P1~P8）+ 硬性约束 + 十方案差异化矩阵 + 评分体系
│   ├── baseline.md   # Polaris 事实基线（布局/总线/插件契约/规模数据/业务分布，含文件路径证据）
│   ├── schemes/      # 十份实现方案（S01~S10，每份 370~640 行，含架构图/契约签名/迁移步骤/风险）
│   ├── judging/      # 五份评委独立评分表（judge-1~5）
│   └── verdict.md    # 汇总排名 + 冠军方案 + 落地路线建议
└── README.md
```

实现侧（设计方案集的落地）：

```
polaris-lite/
├── src/                    # 宿主前端壳：cap 总线 / 插件生命周期 / 布局树 / 主题
├── server/                 # 宿主服务端：仅平台能力（auth/provider/relay/静态服务）
├── plugins/<id>/
│   ├── index.ts            # UI 半边 + manifest
│   └── server.mjs          # server 半边（可选，Node 中间件）
├── plugins/server-registry.mjs  # 服务端插件清单（对称于前端 build-plugins.mjs 清单）
└── tests/server-boundary.test.mjs  # 「核心零业务」服务端边界守卫
```

## 十个方案速览

| # | 代号 | 一句话 | 核心量化目标 |
|---|------|--------|--------------|
| S01 | 微核直译 | 复制 Polaris 壳删业务，Chat 树整体变成首个内置插件 | 150.8k → ≤55k 行（-64%） |
| S02 | 契约优先 | 重写极薄核心，贡献点从 17 类瘦身为 4 类 | 核心 ~9k 行（-94%） |
| S03 | 插槽容器 | 核心只是 sidebar/stream/input/panel 四槽容器 | 核心 ~15.5k 行（-90%） |
| S04 | Web-Only 单进程 | 砍掉 Tauri，Node/Bun + HTTP/SSE，浏览器访问 | Rust 归零，前端 -84% |
| S05 | 微前端 | Module Federation，每个面板是独立构建的 remote | 前端核心 -81%，Rust -68% |
| S06 | Web Components | 核心零框架依赖，面板=自定义元素，可混栈 | 前端 ≤9k 行，Rust ≤55k |
| S07 | 渐进剥离 | 从 Polaris HEAD 出发分 P0~P8 九批剥离 | 151k → ~38k 行（-75%） |
| S08 | 事件溯源微核 | 核心只存事件日志，UI 全是投影插件 | 核心 ~10k 行（-93%） |
| S09 | Vite 模板 | 脚手架模板 + npm 插件包，构建期集成 | 核心 ~9.3k 行（-94%） |
| S10 | 桌面双进程 | Rust 极简壳 + Node 插件宿主进程 | Rust -92%，桥面积 -90% |

## 共同硬性约束（全部方案必须满足）

1. AI 对话布局 = Polaris 现状四段式（会话侧栏 + 消息流 + 底部输入区 + 面板区），不重新发明；
2. 核心零业务：核心目录不出现任何具体业务功能模块；
3. AI 对话 UI 与业务面板均为插件，经统一契约挂载；
4. 保留 cap 总线思想（统一权限/审计/转发，不退化为组件直调后端）；
5. 独立目录、可独立构建，不依赖对 Polaris 的修改。

## 评审方法

5 位评委代理（工程落地 / 架构演进 / 产品体验 / 安全治理 / 成本核算五种视角）独立按 5 维度加权打分：

| 维度 | 权重 |
|------|------|
| A 目标符合度 | 30% |
| B 具体可实现性 | 25% |
| C 轻量收益 | 20% |
| D 架构优雅/可维护 | 15% |
| E 迁移成本/风险 | 10% |

汇总见 [docs/verdict.md](docs/verdict.md)。

## 阅读建议

- 只想知道结论 → 读 `docs/verdict.md`；
- 想了解 Polaris 为什么能轻量化 → 读 `docs/baseline.md` 总结节；
- 想评估某个具体路线 → 按上表读对应 `docs/schemes/Sxx.md`；
- 想复现整个评审流程 → 读 `docs/brief.md` 后按矩阵分派子代理即可。
