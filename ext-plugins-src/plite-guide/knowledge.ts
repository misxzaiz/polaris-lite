/**
 * plite-guide 知识库：polaris-lite 规范与使用说明的结构化数据。
 *
 * 全部内容从 docs/plugin-contract.md、docs/server-gateway-contract.md、
 * docs/ai-engine-contract.md、docs/baseline.md、docs/brief.md、README.md
 * 提炼，供面板分页展示与 MCP 工具检索。新增条目按 schema 补 id/section/title。
 */

export const GUIDE_VERSION = '0.1.0';

export interface GuideDoc {
  id: string;
  section: 'overview' | 'architecture' | 'plugin' | 'ui' | 'server' | 'ai' | 'market' | 'ops';
  title: string;
  summary: string;
  body: string;
}

export const GUIDE_DOCS: GuideDoc[] = [
  {
    id: 'overview-what',
    section: 'overview',
    title: 'polaris-lite 是什么',
    summary: '核心零业务、一切皆插件的轻量 AI 工作台。',
    body: [
      'polaris-lite 是参考 Polaris 产出的轻量版：在 AI 对话交互布局完全不变的前提下，把「核心只留平台能力、业务全部插件化」走完。',
      '',
      '核心（src/ + server/）只保留：cap 总线（权限/审计/转发）、插件生命周期、会话契约、主题/i18n/窗口壳、鉴权/供应商/模型中继/静态服务。',
      '所有业务功能——AI 对话 UI、文件浏览、Git、浏览器、翻译、账本、商城……——都由 plugins/ 下的插件提供。',
      '',
      '三条硬边界（构建期 + 测试期 + 运行时三层强制）：',
      '1. 核心零业务：server/ 目录不得出现领域端点（tests/server-boundary.test.mjs 守卫）；',
      '2. 插件不经宿主 import：插件只能 import @sdk（类型契约），误引宿主实现会构建失败；',
      '3. 申请 ≠ 授权：插件 manifest 声明权限，实际生效 = manifest ∩ grants.json。',
    ].join('\n'),
  },
  {
    id: 'overview-instances',
    section: 'ops',
    title: '实例与发版纪律',
    summary: '5000=开发，9825=生产，9826=钉住分析实例；判断环境只看端口。',
    body: [
      '· 5000 开发环境：npm run dev:standalone 启动；数据目录 .polaris-lite-dev/。开发调试一律用它。',
      '· 9825 生产环境：npm run build && npm start；数据目录 .polaris-lite/。生产只读观察，禁止把测试数据写进去。',
      '· 9826 分析实例：代码在独立 clone polaris-lite-9826，数据目录 .polaris-lite-pm2/，PM2 托管；升级走 npm run deploy:9826。',
      '· 发版：一律 npm run release（自动 commit→push→deploy:9826→build+restart 9825→三处一致性终检）。禁止手工拼 deploy/build/restart 组合，会出现版本漂移。',
      '· 运行态数据目录（.polaris-lite*）不入库；其中的敏感配置不属于插件说明范畴。',
    ].join('\n'),
  },
  {
    id: 'arch-dual-entry',
    section: 'architecture',
    title: '插件双入口：UI 半边 + server 半边',
    summary: 'plugins/<id>/index.ts(x) 浏览器装配；可选 server.mjs Node 中间件。',
    body: [
      '插件目录：',
      '  plugins/<id>/',
      '  ├── index.ts(x)   # UI 半边：组件 + manifest，浏览器动态 import 装配',
      '  └── server.mjs    # server 半边（可选）：Node 中间件，读本地 FS/spawn 子进程',
      '',
      'server 半边契约：导出 createServerPart({ dataDir, getSession, store, policy, logger })',
      '→ 返回 connect 风格中间件 (req,res,next)。宿主只注入这五项平台能力，插件拿不到其它宿主单例。',
      '',
      '装配：plugins/server-registry.mjs 登记 { id, entry }；server/host.mjs 顶层 await loadServerParts()',
      '按清单顺序装配。加载失败 fail-fast（宿主启动失败），不静默 404。删除某个 server 半边，宿主照常启动，',
      '该能力端点 404——这是判断「领域是否真的解耦」的试金石。',
      '',
      '边界：server/ 目录只放平台能力（auth/provider/relay/静态服务），领域端点（/api/fs/*、/api/tool/* 等）',
      '一律在插件 server 半边。tests/server-boundary.test.mjs + tests/arch.test.mjs 强制。',
    ].join('\n'),
  },
  {
    id: 'arch-cap-bus',
    section: 'architecture',
    title: 'cap 总线与信任模型',
    summary: '跨插件协作唯一通道：dispatch({target,action,payload})；权限=manifest∩grants。',
    body: [
      'cap 总线是插件间唯一允许的调用通道，自带三重治理：授权（capabilities∩grants）、审计留痕、authGuard。',
      '不要开第二条通道（裸 window 全局、直连宿主单例都是越界）。',
      '',
      'SlotHostApi（插件拿到的运行时 API）：',
      '  api.dispatch<T>(req)          // cap 调用',
      '  api.listen(evt, fn) / api.emit(evt, payload)   // 仅 manifest.events 声明过的事件',
      '  api.registerCapability        // 仅 manifest.provides 声明过、仅 setup 内可用',
      '  api.theme / api.t / api.layout / api.overlay / api.workspace（需 cap.ui.layout 授权）',
      '',
      '信任模型：public/grants.json 是宿主侧授权表（进版本控制）；manifest 只是申请。',
      '实际生效权限 = manifest ∩ grants；grants 未登记的插件按 unlistedPolicy（当前 declare）',
      '自声明放行并告警。未在 grants 出现的权限不生效，记录在 denied 供追溯。',
    ].join('\n'),
  },
  {
    id: 'plugin-manifest',
    section: 'plugin',
    title: '编写插件：manifest 与生命周期',
    summary: 'LitePlugin = manifest + setup(hostApi)；外部插件还需要 plugin.json + plugin.js。',
    body: [
      '内置插件（随构建发布）：',
      '  plugins/<id>/index.tsx 导出 default LitePlugin：',
      '    manifest: { id, name, version, capabilities?, provides?, events?, requires?,',
      '                 contributes: { slots?/views?/containers? } }',
      '    setup(hostApi) { ... }    // 装配钩子，注册能力在这里做',
      '  在 plugins/build-plugins.mjs 清单登记 { id, config, dist, order }；',
      '  有 server 半边再在 plugins/server-registry.mjs 加一行。',
      '',
      '外部插件（商城安装，免构建宿主）：',
      '  包内必须 plugin.json（manifest 子集）+ plugin.js（ESM bundle，react 走宿主 import map）；',
      '  style.css 可选。安装后落 <dataDir>/plugins/<id>/，registry 双写 module=/ext-plugins/<id>/plugin.js?v=hash8。',
      '  id 规则 ^[a-z0-9][a-z0-9._-]*$，且不得与内置插件撞名。',
      '',
      '前端加载三阶段（顺序即正确性）：① fetch registry.json+grants.json → 动态 import → 解析权限（不执行 setup）；',
      '② 按 manifest.requires 拓扑排序（能力提供方先装配）；③ 依序 registerPlugin（此时才跑 setup）。',
    ].join('\n'),
  },
  {
    id: 'plugin-slots',
    section: 'ui',
    title: 'UI 贡献：槽位 / 视图 / 容器',
    summary: 'slots 填固定位置；views 可被布局树摆放；containers 接管宿主 chrome。',
    body: [
      '① 槽位贡献（存量契约）：',
      '  contributes.slots = [{ slot, component, order, title? }]',
      '  slot ∈ sidebar | stream | input | panel | auth（auth 是门禁特例，不进 tab 体系）。',
      '  同一槽位 order 必须唯一；panel 槽必须给 title（≤4 字，tab 宽度所限）。',
      '',
      '② 视图贡献（布局树契约）：',
      '  contributes.views = [{ viewType, component, title, defaultAnchor? }]',
      '  viewType 必须 <pluginId>. 开头、全局唯一；组件必须在入口真实导出；host. 是保留前缀。',
      '',
      '③ 容器贡献：containers = [{ container: \'slot-tabs\'|\'layout-root\', component, order? }]',
      '  插件接管一段宿主 chrome 渲染（状态权威仍在宿主）。禁用时宿主回退内置简版。',
      '',
      '样式规则：插件 CSS 全局注入、无隔离。禁止 :root/html/body/#root/.slot-*/.shell-*/@import/',
      '裸 */position:fixed/!important（prefers-reduced-motion 块内除外）。选择器以自己的插件前缀为根；',
      '颜色一律消费宿主令牌（--bg/--text/--accent/--border-rgb 等），不得写死，否则暗色主题必炸。',
    ].join('\n'),
  },
  {
    id: 'ui-workspace',
    section: 'ui',
    title: '工作区布局树',
    summary: 'anchor/split/tabs/view 四种节点；四个锚点：sidebar/stream/input/panel。',
    body: [
      '布局唯一数据模型是一棵可校验的树：',
      '  anchor（四个保留锚点 sidebar/stream/input/panel）',
      '  split（严格二分；尺寸 ratio/px/auto + of 作用侧）',
      '  tabs（≥2 子项、不嵌套、≤12 项、active 必须指向子节点 id）',
      '  view（id 实例标识 + viewType 指向注册视图）',
      '',
      '插件经 api.workspace 操作（全部是 cap.ui.layout 的薄包装）：',
      '  getTree/listViews/open(viewType,{where,anchor})/close/split/move/applyTree/reset',
      '  where: split-right（默认）/split-bottom/tab。',
      '',
      '归属规则：只能 close/move 自己前缀（pluginId）的视图；host.slot.* 是结构视图不可动；',
      'applyTree/reset 需 cap.ui.layout.global 且必须含四个锚点。',
      '',
      '校验器硬不变量（违反整体拒绝）：深度≤8、叶子≤16、节点≤64、ratio∈[0.05,0.95]、',
      'px≥120、锚点不重复且齐全、无环、序列化≤256KB。恢复失败一律回默认树+备份原件，绝不白屏。',
    ].join('\n'),
  },
  {
    id: 'server-gateway',
    section: 'server',
    title: '服务端能力网关（/api/cap）',
    summary: '统一转发/鉴权/审计；请求 {target,action,payload}，能力由插件注册。',
    body: [
      '设计稿（docs/server-gateway-contract.md）：把前端 CapBus 的 gate→审计→转发模型延伸到服务端。',
      '',
      '浏览器插件发 fetch(/api/cap, {target, action, payload})；宿主唯一端口内：',
      '  识别 target → 查能力注册表定位提供方插件 → 鉴权（会话 + grants 细化到动作/限制级）→',
      '  转发执行 → 落审计（谁/调了什么/何时/结果）。',
      '',
      '能力命名 cap.<域>.<能力>；注册表记录提供方与描述；授权从能力名级细化到「能力+动作+限制」。',
      '平台端点（/api/auth/*、/api/providers/*、/api/model-relay）不走网关，保持专用中间件。',
      '商城化衔接：网关裁决点固定后，第三方插件 server 半边未来可平移到 worker/子进程隔离，只换传输层。',
    ].join('\n'),
  },
  {
    id: 'ai-engine',
    section: 'ai',
    title: 'AI 引擎契约（ai-engine）',
    summary: '引擎即插件：接入新模型=新增插件，宿主与对话 UI 零改动。',
    body: [
      '角色：对话 UI 插件（chat-lite）面向 AiEnginePlugin 契约编程，不 import 任何具体引擎；',
      '引擎插件自行适配厂商差异（思考等级/工具/采样/流格式/CLI 子进程）；',
      '宿主只做能力网关/权限裁决/审计；引擎分派器按 engineId 路由，real-engine 兜底。',
      '',
      '统一流事件协议：文本增量/工具调用/思考/用量/错误/完成走同一种事件流（StreamEvent {kind,payload,seq,source}）。',
      '密钥不出后端：上游调用在插件 server 半边，对外仅宿主一个端口。',
      '',
      '当前默认引擎 real-engine（OpenAI 兼容中继）；codebuddy-engine 为 CLI 型备选（与 real-engine 互斥，',
      'cap.ai.chat 单注册位）。模型/供应商配置在 model-admin 插件（面板 + /api/providers）。',
    ].join('\n'),
  },
  {
    id: 'market-external',
    section: 'market',
    title: '外部插件与商城',
    summary: 'dir/http/cc-marketplace 三类源；安装=校验→落盘 dataDir/plugins→registry 双写。',
    body: [
      '商城源（market-sources.json）：',
      '  dir            本地目录：<ref>/index.json 清单 + <ref>/<id>/{plugin.json,plugin.js,style.css}',
      '  http           远程清单 URL（本仓库新增）：清单 JSON 同目录按 <id>/ 相对寻址包文件；',
      '                 sha256 强校验必填（64 位指纹），fetch 走上游策略闸',
      '  cc-marketplace Claude Code 商城（owner/repo）：只导入声明型资源（skills/hooks/mcpServers），不运行外部 JS',
      '',
      '安装流程：校验（sha256/manifest/id 冲突）→ 落 <dataDir>/plugins/<id>/ → registry 双写增项',
      '（module=/ext-plugins/<id>/plugin.js?v=hash8）→ 刷新页面生效。',
      '卸载=删目录+registry 移除；/ext-plugins/<id>/* 自服务路由带穿越校验。',
      '',
      '已知边界：① 安装器只复制 plugin.js/plugin.json/style.css 三个文件，附属文件（如 MCP 脚本）',
      '需自行提供可访问路径；② 外部插件无 server 半边（动态挂载列 P3），纯 UI 刷新即用；',
      '③ npm run build 会重新生成 registry.json——发版后外部插件条目会丢，需重装；',
      '④ 未登记 grants 的插件按 declare 放行并告警（权限告警的来源）。',
    ].join('\n'),
  },
  {
    id: 'ext-four-channels',
    section: 'market',
    title: '外部插件四通道：面板/Skill/MCP/Hook',
    summary: '面板刷新即用；Skill/MCP/Hook 是「落盘登记」式，插件面板引导写入。',
    body: [
      '面板：bundle 动态 import 后按 manifest.contributes.slots 挂载，刷新页面即生效，免重启。',
      '',
      'Skill：运行时通道是 <workspace>/.claude/skills/<名>/SKILL.md（frontmatter: name/description）。',
      'skill-loader 插件扫描并注入系统提示附录，下轮对话生效；AI 可用 read_skill 工具按需读全文。',
      '外部插件可随包带 SKILL.md，由面板按钮经 /api/files-write/exec 写入工作区。',
      '',
      'MCP：登记式——<dataDir>/mcp-servers.json { servers: { name: { command,args,enabled } } }。',
      'mcp-bridge 拉起 stdio JSON-RPC 进程，下轮对话 AI 工具面出现 mcp__<name>__*。可由面板调',
      'POST /api/mcp/servers 登记，或 AI 用 mcp_server_add 工具（带审批）。',
      '',
      'Hook：<workspace>/.claude/settings.json 的 hooks 键（CC 兼容格式）。hook-bridge 按内容指纹缓存、',
      '变更即重载；workspace 级新钩子默认免确认（PLITE_HOOK_CONFIRM=1 恢复确认闸）。事件：',
      'PreToolUse/PostToolUse/UserPromptSubmit/SessionStart/Stop。命令型钩子在 shell 里执行，',
      '注意转义（\\n 会被 shell 吃掉，用 String.fromCharCode(10) 之类替代）。',
    ].join('\n'),
  },
  {
    id: 'ops-build',
    section: 'ops',
    title: '构建 / 测试 / 常用命令',
    summary: 'typecheck → test → build:plugins；dev:standalone 起开发环境。',
    body: [
      '常用命令：',
      '  npm run dev:standalone        # 开发环境（5000，.polaris-lite-dev/）',
      '  npm run typecheck             # tsc 主工程 + 插件工程',
      '  npm test                      # 全量 node:test（含 server-boundary/arch 等边界守卫）',
      '  npm run build:plugins         # 构建全部内置插件 + registry.json',
      '  npm run check:plugins         # 只跑静态一致性校验（CI 快速门禁）',
      '  npm run build                 # typecheck + check:plugins + vite build + sw manifest + sync-dist',
      '  npm run release               # 一键发版（commit→push→deploy:9826→build+restart 9825→终检）',
      '  npm run deploy:9826 / status:9826   # 分析实例发布/查看落后',
      '',
      '插件约束的门禁落点：manifest-views.mjs（viewType/槽位校验）、build-plugins.mjs（fail-fast 清单校验）、',
      'lintPluginCss（样式越界）、server-boundary.test.mjs（核心零业务）、arch.test.mjs（依赖方向）。',
      '改契约 = 同步改门禁 + 守卫测试 + docs/plugin-contract.md 三处；不一致时以代码门禁为准。',
    ].join('\n'),
  },
  {
    id: 'ops-extquad',
    section: 'ops',
    title: 'extquad 示例：外部插件全链路',
    summary: 'ext-plugins-src/extquad 是面板+Skill+MCP+Hook 四合一的最小可跑样例。',
    body: [
      '目录：ext-plugins-src/index.json（清单，含 sha256）+ ext-plugins-src/extquad/（plugin.json/plugin.js/style.css/index.tsx/mcp-server.mjs/vite.config.ts）。',
      '',
      '构建：npx vite build --config ext-plugins-src/extquad/vite.config.ts，把 dist 产物复制到包根，更新 index.json 的 sha256。',
      '',
      '安装：商城添加 dir 源（ref=…/ext-plugins-src）或 http 源（ref=raw index.json URL）→ install → 刷新页面。',
      '',
      '面板四个动作：kv 探活（/api/kv）、Skill 写入（/api/files-write/exec → .claude/skills/extquad-note/）、',
      'MCP 登记（POST /api/mcp/servers → extquad-echo，stdio echo 工具）、Hook 写入（.claude/settings.json PostToolUse）。',
      '',
      '验证点：技能出现在 /api/skills/list；mcp servers 状态 connected 且 1 个工具；hooks-audit.log 有执行记录且 exit 0。',
    ].join('\n'),
  },
];

export function getDoc(id: string): GuideDoc | undefined {
  return GUIDE_DOCS.find((d) => d.id === id);
}

export function searchDocs(query: string): GuideDoc[] {
  const q = query.trim().toLowerCase();
  if (!q) return GUIDE_DOCS;
  const terms = q.split(/\s+/);
  return GUIDE_DOCS
    .map((d) => {
      const hay = `${d.id} ${d.title} ${d.summary} ${d.body}`.toLowerCase();
      const score = terms.reduce((acc, t) => acc + (hay.includes(t) ? 1 : 0), 0);
      return { d, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.d);
}
