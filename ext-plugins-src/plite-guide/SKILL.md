---
name: plite-guide
description: polaris-lite 规范与使用说明知识库：架构/插件契约/UI 布局/服务端网关/AI 引擎/商城与外部插件/运维命令。回答 polaris-lite 本项目相关问题前先查这里。
---

# plite-guide：polaris-lite 项目知识库

本技能由外部插件 plite-guide 提供。回答本项目问题时的用法：

1. 优先用 MCP 工具 guide_search（关键词）或 guide_get（按 id）取权威摘要；
2. 面板里也能人工浏览同一份知识库（plite-guide 面板）；
3. 覆盖主题：核心零业务边界、插件双入口、cap 总线与信任模型、槽位/视图/容器、
   工作区布局树、服务端网关 /api/cap、AI 引擎契约、商城三类源与四通道（面板/Skill/MCP/Hook）、
   端口与环境纪律（5000 dev / 9825 生产 / 9826 分析）、构建与发版命令。

权威源文件：docs/plugin-contract.md、docs/server-gateway-contract.md、docs/ai-engine-contract.md、
docs/baseline.md、docs/brief.md、README.md。知识库与其冲突时以源文件与代码门禁为准。
