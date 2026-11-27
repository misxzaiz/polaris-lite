# polaris-lite 项目全面分析报告

> 生成时间：2026-11-25 12:22（宿主本地时区）
> 分析范围：仓库根目录关键文件（package.json / AGENTS.md / README.md）、docs/、plugins/、server/、src/、scripts/、tests/
> 分析方法：静态阅读清单与契约文档 + 目录结构枚举；未运行服务、未改动生产数据。

---

## 一、项目定位

polaris-lite 是「Polaris 主项目」的轻量版落地实验：在 AI 对话交互布局保持不变的前提下，把宿主核心削到只剩平台能力（cap 总线、插件生命周期、布局树、主题/i18n/窗口壳、鉴权、模型中继），而 AI 对话 UI 与全部业务面板都由插件提供，即 README 所述「核心零业务、一切皆插件」。

- 形态：React 18 + Vite 5 前端壳 + Node ESM 服务端（server/）+ 双入口插件体系（UI 半边 + 可选 server 半边）。
- 版本：package.json v0.2.3；仓库内已有 0.2.2/0.2.3/0.2.4 三个 APK 产物与 portable zip，说明移动端（Capacitor 8）发布链路已跑通。
- 运行形态：开发 5000（dev:standalone，数据目录 .polaris-lite-dev/）、生产 9825（PM2，数据目录 .polaris-lite/）、钉住分析实例 9826（独立 clone + deploy:9826 升级）。

## 二、根目录关键文件速览

| 文件/目录 | 作用 | 要点 |
|---|---|---|
| package.json | 构建与脚本入口 | build = typecheck + check:plugins + vite build + sw manifest + sync-dist；test 覆盖 40+ 个 node:test 文件；build:plugins/check:plugins 由 plugins/build-plugins.mjs 承担 |
| AGENTS.md | AI/agent 协作纪律 | 端口判环境（5000 开发 / 9825 生产 / 9826 钉住）；发版一律 npm run release；上游默认不限制，PLITE_UPSTREAM_STRICT=1 可恢复白名单；插件数据用 cap.kv 而非 localStorage |
| README.md | 项目总纲 | 记录 S01~S10 十种实现方案与评分，最终落地为「微核 + 双入口插件」形态 |
| docs/ | 设计与运维文档 | plugin-contract.md（插件契约）、server-gateway-contract.md、agent-loop-analysis.md、release-runbook.md、pm2-9826-isolation.md、host-slimming-report 等 70+ 篇 |
| plugins/ | 插件与构建/注册表 | build-plugins.mjs（前端清单 36 项）、server-registry.mjs（服务端清单 23 项）、manifest-views.mjs、shared/、sdk/ |
| server/ | 宿主服务端 | 仅平台能力：host.mjs、auth-session、provider-store、providers-api、relay-core、upstream-policy、prod-server、http-util |
| src/ | 宿主前端壳 | core/（cap 总线、布局、生命周期）+ main.tsx + 全局样式 |
| scripts/ | 运维脚本 | dev-server、release、deploy-9826、soft-deploy-9826、sync-dist、make-portable、gen-sw-manifest 等 |
| tests/ | 质量守卫 | arch/server-boundary 守「核心零业务」；plugin-manager/mcp-bridge/hook-bridge 等守插件机制 |

## 三、架构归纳（文字版架构图）

```
┌────────────────────────── 浏览器 / Capacitor App ──────────────────────────┐
│  宿主前端壳 src/core：cap 总线 · 插件生命周期 · 布局树 · 主题 · 会话导航      │
│  ┌──────────── 插件 UI 半边（plugins/<id>/index.ts → dist/plugin.js）────┐  │
│  │ sidebar / stream / input / panel 四锚点：slots（存量）+ views（新契约）│  │
│  │ chat-lite · file-browser · agent-bash · kv-store · plugin-manager …  │  │
│  └──────────────────────────┬───────────────────────────────────────────┘  │
│                    SlotHostApi（能力最小化）│ cap.* 权限化调用               │
└─────────────────────────────┼──────────────────────────────────────────────┘
                              │ HTTP（鉴权 session / 临时 token）
┌─────────────────────────────▼──────────── Node 服务端（server/host.mjs）────┐
│ 平台能力：auth-session · provider-store · providers-api · relay-core        │
│           upstream-policy · 静态资源/SW · PM2 生产编排                        │
│  ┌────── 插件 server 半边（plugins/<id>/server.mjs，server-registry 装配）──┐│
│  │ createServerPart({dataDir,getSession,store,policy,logger}) → 中间件     ││
│  │ /api/fs/* · /api/tool/* · /api/kv/* · /api/plugins/* · /api/mcp/* …    ││
│  └────────────────────────────────────────────────────────────────────────┘│
│  外部：LLM 供应商（relay）· MCP servers · puppeteer（browser-lite）· sqlite │
└─────────────────────────────────────────────────────────────────────────────┘
```

四条主干：

1. 前端面：src/core 只做壳与总线；36 个 UI 插件经 build-plugins.mjs 独立构建为 dist/plugin.js，运行时按 manifest 装配进 sidebar/stream/input/panel 四锚点。
2. 服务端面：server/ 只做鉴权、供应商配置、模型中继、上游策略与静态服务，tests/server-boundary.test.mjs 禁止领域端点回流宿主。
3. 插件总线：UI 经 SlotHostApi/cap.* 最小能力面调用；服务端经 server-registry 装配 23 个 server 半边，注入 {dataDir, getSession, store, policy, logger} 五项平台能力，加载 fail-fast。
4. 工具面：agent-bash/agent-files（shell/文件工具）、browser-lite（puppeteer 内核）、mcp-bridge（MCP 接入）、hook-bridge/skill-loader（扩展机制）、git-core（git 能力）构成 agent 执行工具箱。

## 四、插件清单表

### 4.1 前端 UI 插件（build-plugins.mjs，36 项；enabled:false 表示不出场）

| # | 插件 id | 职责（据目录/命名/文档） | server 半边 |
|---|---|---|---|
| 1 | config-manager | 供应商/密钥等配置管理面板 | — |
| 2 | chat-lite | AI 对话主界面（消息流/输入区核心体验） | — |
| 3 | model-admin | 模型与供应商管理（承接原 providers-api UI） | ✔ |
| 4 | real-engine | 真实 AI 引擎对接（对话生成） | — |
| 5 | agent-bash | Agent shell 工具面板 + /api/tool 执行 | ✔ |
| 6 | agent-loop | Agent 循环过程可视化（工具调用时间线） | — |
| 7 | agent-files | Agent 文件读写工具 UI | ✔ |
| 8 | cap-panel | cap 总线能力/权限查看面板 | — |
| 9 | mock-auth | 演示用登录/鉴权组件（auth 槽） | — |
| 10 | mock-engine | 假引擎（离线演示，默认关闭） | — |
| 11 | file-browser | 文件树/文件浏览（/api/fs/*） | ✔ |
| 12 | theme-switcher | 主题切换 | — |
| 13 | ai-events | AI 事件/网络面板（netTap/turnStore 观测） | — |
| 14 | interactive-cards | 富交互卡片（工具结果/审批等块） | — |
| 15 | html-preview | HTML/前端产物预览 | ✔ |
| 16 | pocket-ledger | 个人记账面板（含迁移方案文档） | — |
| 17 | kv-store | cap.kv 键值存储（服务端 sqlite） | ✔ |
| 17 | browser-lite | 内置浏览器（puppeteer-core，截图/读取） | ✔ |
| 18 | plugin-manager | 插件安装/启停/市场管理 | ✔ |
| 19 | chat-store | 会话持久化（多设备同步） | ✔ |
| 20 | mobile-companion | 移动端伴生能力 | — |
| 21 | app-updater | 应用版本检查/更新引导 | ✔ |
| 22 | phone-agent | 手机侧 agent（语音/远程指令） | ✔ |
| 22 | standalone-mode | 单机模式适配 | — |
| 23 | codebuddy-engine | CodeBuddy 引擎对接（默认关闭） | ✔ |
| 23 | git-core | git 能力提供方（cap.git，白名单+审计） | ✔ |
| 24 | git-panel | git 状态/操作面板 | — |
| 24 | skill-loader | 技能（SKILL.md）加载器 | ✔ |
| 25 | hook-bridge | 运行时钩子桥（settings.json hooks） | ✔ |
| 26 | mcp-bridge | MCP server 接入桥 | ✔ |
| 27 | zcode-compat | zcode 兼容层 | ✔ |
| 28 | plugin-market | 插件市场（服务端目录/安装） | ✔ |
| 29 | transcript-share | 对话记录分享 | ✔ |
| 30 | shell-chrome | 壳层外观/窗口装饰 | — |
| 31 | workspace-layout | 工作区布局（树/锚点编排） | — |
| 32 | personal-hub | 个人中心 | — |
| 33 | voice-radio | AI 语音电台（TTS 代理+缓存） | ✔ |
| 34 | starter-suggestions | 开场建议 | — |
| 35 | translate | 翻译（百度翻译代理） | ✔ |
| 36 | notification-center | 通知中心 | — |

另有支撑目录：agent-runner（AI 编排循环服务端执行器，仅 server）、engine-kit（引擎套件）、shared/ 与 sdk/（插件共享类型与工具）、esm-shim.mjs、relay-hosts.json、manifest-views.mjs。

### 4.2 服务端插件注册表（server-registry.mjs，23 项）

file-browser、agent-bash、agent-files、html-preview、browser-lite、kv-store、plugin-manager、chat-store、agent-runner、phone-agent、codebuddy-engine、skill-loader、hook-bridge、mcp-bridge、zcode-compat、plugin-market、model-admin、transcript-share、app-updater、git-core、voice-radio、translate。
（注：与前端清单基本一一对应，前端多出的纯 UI 插件无 server 半边。）

## 五、构建 / 测试 / 发布链路

- 构建：npm run build = typecheck（双 tsconfig）→ check:plugins（清单/契约静态校验）→ vite build → gen-sw-manifest（PWA）→ sync-dist（同步到服务端可托管目录）。
- 插件构建：build-plugins.mjs 按清单逐个 vite 构建，产物 plugins/<id>/dist/plugin.js(+style.css)；--check 模式做只读校验，违规即失败。
- 测试：node:test 跑 40+ 文件，含 arch（依赖方向）、server-boundary（核心零业务）、plugin-manager、mcp-bridge、hook-bridge、browser-engine、workspace-freeze 等。
- 发布：npm run release 一条龙 commit→push→deploy:9826→build+restart 9825→三处 commit 一致性终检；禁止手工拼装部署命令，防「9825 新代码、9826 旧 commit」版本漂移。移动端经 Capacitor 打 APK（仓库已有 0.2.2~0.2.4 产物）。

## 六、风险清单

| # | 级别 | 风险 | 说明 / 缓解 |
|---|---|---|---|
| 1 | 高 | 仓库根目录杂物堆积 | 大量 .tmp-*、日志、APK、zip、备份目录、gui-test-screenshots 等与源码混放，干扰检索且易误提交；建议移动到 artifacts/ 或加入 .gitignore 并清理 |
| 2 | 高 | 安全边界依赖约定 | 上游默认不限制（任意 http/https、含私网），agent-bash 可执行命令；一旦暴露到非本机网络风险陡增。文档已有 PLITE_UPSTREAM_STRICT 逃生门，建议默认收紧或至少对 0.0.0.0 监听加鉴权告警 |
| 3 | 高 | 生产/开发实例同机共存 | 9825 生产与 5000 开发共享仓库与部分脚本；AGENTS.md 已立纪律，但机器层面（cookie 文件 dev-cookies.tmp.txt 等）仍可能串环境 |
| 4 | 中 | 前后端插件清单双维护 | build-plugins.mjs 与 server-registry.mjs 需人工保持 id 对齐，已有构建期校验，但仍可能出现「UI 有、server 缺」的半成品插件 |
| 5 | 中 | 清单 order 撞号 | 前端清单中 git-core/codebuddy-engine 同为 23、browser-lite/kv-store 同为 17、app-updater/phone-agent/standalone-mode 涉及 22；插件契约要求「同槽位 order 唯一」，清单级撞号与契约精神不一致，建议复核 |
| 6 | 中 | 重依赖内嵌 | browser-lite 自带 node_modules（puppeteer-core 等），体积与供应链面扩大；升级需单独维护 |
| 7 | 中 | 文档与实现漂移 | docs/ 70+ 篇方案/截图更新频率高，contract 类文档质量高，但旧方案文档若不标注「已过时」易误导 |
| 8 | 低 | 测试文件手工罗列 | package.json test 逐个列 40+ 文件，新增测试易漏登记；建议改为 glob 或目录扫描 |
| 9 | 低 | PWA/移动端双轨 | PWA manifest 生成与 Capacitor 打包并存，版本号需在 package.json、APK、9826 版本戳多处同步，release 脚本已兜底但新增产物需跟进 |

## 七、总体评价

polaris-lite 的核心价值在于把「核心零业务、一切皆插件」从口号落成了可执行约束：构建期 check:plugins、测试期 arch/server-boundary、运行时 resolvePolicy+CapBus 三层强制，配合双入口插件（UI index.ts + server server.mjs）与 fail-fast 装配，边界纪律明显强于一般插件化项目。AGENTS.md 的环境纪律（端口判环境、release 一条龙）也针对真实事故做了防御。主要短板不在架构而在工程卫生：根目录杂物、双清单维护成本、内嵌重依赖与安全默认值。若继续演进，优先级建议为：清库 → 收紧默认安全面 → 清单/测试自动化 → 文档保鲜。
