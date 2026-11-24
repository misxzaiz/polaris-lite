# Claude Code 插件商城 × polaris-lite plugin-market 适配分析（2026-11-24）

## 一、polaris-lite 现有商城能力（plugins/plugin-market）

- 源模型：`market-sources.json` 登记源；**当前只支持 `dir` 本地目录源**（内含 `index.json` 清单 + 各插件包目录 `<id>/plugin.json|plugin.js|style.css`）。
- 安装：复制文件 + sha256 强校验 + manifest 校验 → 落 `<dataDir>/plugins/<id>/`（与内置插件物理隔离）→ registry 双写（public+dist）增项 `module: /ext-plugins/<id>/plugin.js?v=hash8`。
- 服务：`/ext-plugins/<id>/*` 自服务路由（穿越校验 + no-store）。
- AI 自助：`cap.market.tool` 提供 `market_list / market_install / market_uninstall` 三个工具，**在 agent-loop 的 FREE_PASS 名单里（无需人工审批即可安装/卸载）**——AI 可以自己加商城源（走 bash/curl 或面板）、自己装插件。
- 安全：PLITE_MARKET=0 一键禁用；路径逃逸拒绝；id 冲突拒绝（不能覆盖内置插件）。

**已实测**（dev 环境 5000）：加源 → list → install → registry 增项 → /ext-plugins 200 → uninstall，全链路通。

## 二、Claude Code 商城是什么形态

- 本机已装两个 CC 商城：`claude-plugins-official`（anthropics/claude-plugins-official，317 个插件条目）与 `pua-skills`（tanweai/pua）。
- 结构：`.claude-plugin/marketplace.json` 清单（name/owner/plugins[]），每个插件条目 `{name, description, source}`；source 有三种：`./plugins/xxx`（仓库内相对目录，官方已 checkout 43 个到 plugins/ 下）、`git-subdir`（第三方仓库+子目录+ref+sha）、`url`（git 仓库）。
- **CC 插件内容物是声明型资源**：`commands/*.md`（slash 命令）、`skills/`、`agents/`、`hooks/`、可选 `mcpServers`——**没有 plugin.js 运行时 bundle**。CC 宿主加载的是这些 markdown/配置，不是 JS 模块。

## 三、能不能直接把 CC 商城加进来？

**结论：源可以接，但「安装」需要一层转换，不能直接复制了事。**

| 维度 | CC 商城 | polaris-lite 商城 |
| --- | --- | --- |
| 清单 | `.claude-plugin/marketplace.json`（plugins[].source 三态） | `index.json`（plugins[].downloadUrl/sha256） |
| 插件内容 | commands/skills/agents/hooks 的 .md + 配置 | plugin.js（ESM bundle）+ plugin.json + style.css |
| 分发 | git 仓库（本地已 clone 的 43 个官方插件可直接读） | 本地目录复制（http/zip 是 P3 未接） |
| 运行时 | CC 宿主解析 md/配置 | polaris-lite 加载 ESM 模块 |

直接把 `~/.claude/plugins/marketplaces/claude-plugins-official` 作为一个 `dir` 源加进来，`/api/market/list` 会因找不到 `index.json` 返回「清单不可读」——结构不同，清单层不兼容。

## 四、可行的适配方案（按成本排序）

### 方案 A：CC 商城只读浏览 + 官方插件「能力转译」（推荐先做）
1. **新增 `cc-market` 目录源类型**：ref 指向 `~/.claude/plugins/marketplaces/<name>`，listAll 时读 `.claude-plugin/marketplace.json` 转成商城条目（id=name、description、source 标注 git/url/本地）。纯只读展示，零风险。
2. **安装走 zcode-compat 的声明型导入**：polaris-lite 已有 CC 配置发现/导入管线（`zcode-compat/server.mjs` 的 discoverSkills/discoverHooks/discoverPlugins）。把「从 CC 商城安装」实现为：把该插件目录登记进 zcode-compat 的发现路径（或复制到 `<dataDir>/skills/compat-claude-<name>/`），其 skills/commands/hooks 即被现有链路消化——**不运行外部 JS，供应链面最小**。
3. 317 个插件里绝大多数是 skills/commands 型，此方案能覆盖；带 `mcpServers` 的条目可继续走 mcp-bridge 原生配置导入（已有）。

### 方案 B：真 JS 插件桥（P3 级，慎做）
把 CC 插件包装成 polaris-lite ESM 插件（plugin.js 里读 manifest 并注册等价 cap）。工作量大且语义不对齐（CC 的 commands/agents 没有直接对应的 cap），仅当确实需要某个 CC 插件的深度集成时逐个做。

### 方案 C：AI 自建商城源（已支持，可演示）
AI 用 bash 写一个 `index.json` + 插件目录，再调 `market_install` 自助上架/安装——现有 FREE_PASS 语义下完全可行；配合 sha256 校验与「只装可信来源」提示兜底。

## 五、建议落地顺序

1. `cc-market` 源类型（只读 list，把 317 个 CC 插件展示在商城面板，标 `claude-code` 来源徽标）；
2. 安装 = 复制插件目录到 `<dataDir>/skills/compat-cc-<id>/`（走 zcode-compat 既有消费链，纯声明型资源）；
3. 面板与 `market_list` 工具透出「CC 商城」分区；安全提示沿用「外部内容只装可信来源」。

## 六、补充：当前项目对「声明型资源」的实际支持矩阵（2026-11-24 复查）

| 资源类型 | 当前项目消化链路 | 商城（plugin-market）是否支持 | 结论 |
| --- | --- | --- | --- |
| **skills（SKILL.md）** | skill-loader 扫 `<dataDir>/skills`（第 1 优先级）+ workspace 下 .claude/.zcode/.agents/skills；zcode-compat importAll 已把 skills 复制到 `<dataDir>/skills/compat-<来源>-<名>/` | ❌ 商城本身不认识，但其复制目标目录正是 skill-loader 的扫描根 → **装完即生效** | ✅ 可直接参考复用 |
| **hooks** | hook-bridge 读 `<dataDir>/hooks-import.json`（zcode-compat 归一产物）+ settings 同构规则 | ❌ 同上，zcode-compat 的 hooks 导入产物即被消费 | ✅ 可直接参考复用 |
| **mcpServers** | mcp-bridge 原生配置 `<dataDir>/mcp-servers.json`；zcode-compat 已把插件内嵌 mcpServers 固化导入（`plugin-<id>-<name>` 条目） | ❌ 商城不认识，但导入目标即 mcp-bridge 配置 | ✅ 可直接参考复用 |
| **commands（slash .md）** | **无任何消费者**（chat-lite 无 slash 命令注册表；skill-loader 只认 SKILL.md） | ❌ | ⚠️ 需新做映射（可转成 skill 或提示词注入） |
| **agents（.md 子代理定义）** | 无消费者（ZCode 有 Agent 工具但清单/加载器未接） | ❌ | ⚠️ 需新做（低优先） |
| **plugin.js 运行时** | plugin-market 原生支持（sha256 + registry 双写 + /ext-plugins） | ✅ | 已有能力 |

CC 官方商城 317 个插件：55 个本地相对目录（已 clone 43 个到 `~/.claude/plugins/marketplaces/claude-plugins-official/plugins/`）、98 git-subdir、163 url/github。43 个本地插件资源覆盖：skills=18、commands=13、agents=10、hooks=8、内嵌 .mcp.json=2（如 playwright → `npx @playwright/mcp@latest`，可直接进 mcp-bridge）。本机还装有 `~/.claude/plugins/cache/claude-plugins-official/`（12 个已安装插件的版本缓存，superpowers 含 15 个 SKILL.md）。

## 七、参考实现路径（若做）

最小改动方案 = 在 zcode-compat 的 `importAll()` 加一步「CC 商城导入」：
1. 扫 `~/.claude/plugins/marketplaces/*/.claude-plugin/marketplace.json` → 商城式清单（只读展示可先行，纯 GET）；
2. 「安装」= 对选中的本地 checkout 插件目录执行既有三件套：skills → `<dataDir>/skills/compat-cc-<id>-<skill>/`；hooks → 归并进 `hooks-import.json`；mcpServers → `mcp-servers.json`（`cc-<id>-<name>` 条目）。
3. plugin-market 面板加「Claude Code 商城」分区（或独立 tab），安装按钮指向同一导入端点；`market_list` 工具同步透出。
不引入任何新运行时（不跑外部 JS），全部走既有三条消化链，改动集中在 zcode-compat + plugin-market 面板。
