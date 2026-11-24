#!/usr/bin/env node
/**
 * plite-guide 随包 MCP server（stdio JSON-RPC 2.0）。
 * 让 AI 直接检索 polaris-lite 规范知识库：
 *   guide_sections           → 全部条目 id/标题/摘要
 *   guide_get { id }         → 单篇全文
 *   guide_search { query }   → 关键词检索（标题/摘要/正文）
 * 知识库与前端面板共享同一份静态数据（knowledge.ts 编译进 bundle；
 * 此处以内联 JSON 维护同一份——两者需同步更新）。
 */
process.stdin.setEncoding('utf8');

const DOCS = [
  {
    "id": "overview-what",
    "section": "overview",
    "title": "polaris-lite 是什么",
    "summary": "核心零业务、一切皆插件的轻量 AI 工作台。",
    "body": "polaris-lite 是参考 Polaris 产出的轻量版：在 AI 对话交互布局完全不变的前提下，把「核心只留平台能力、业务全部插件化」走完。\n\n核心（src/ + server/）只保留：cap 总线（权限/审计/转发）、插件生命周期、会话契约、主题/i18n/窗口壳、鉴权/供应商/模型中继/静态服务。\n所有业务功能——AI 对话 UI、文件浏览、Git、浏览器、翻译、账本、商城……——都由 plugins/ 下的插件提供。\n\n三条硬边界（构建期 + 测试期 + 运行时三层强制）：\n1. 核心零业务：server/ 目录不得出现领域端点（tests/server-boundary.test.mjs 守卫）；\n2. 插件不经宿主 import：插件只能 import @sdk（类型契约），误引宿主实现会构建失败；\n3. 申请 ≠ 授权：插件 manifest 声明权限，实际生效 = manifest ∩ grants.json。"
  },
  {
    "id": "overview-instances",
    "section": "ops",
    "title": "实例与发版纪律",
    "summary": "5000=开发，9825=生产，9826=钉住分析实例；判断环境只看端口。",
    "body": "· 5000 开发环境：npm run dev:standalone 启动；数据目录 .polaris-lite-dev/。开发调试一律用它。\n· 9825 生产环境：npm run build && npm start；数据目录 .polaris-lite/。生产只读观察，禁止把测试数据写进去。\n· 9826 分析实例：代码在独立 clone polaris-lite-9826，数据目录 .polaris-lite-pm2/，PM2 托管；升级走 npm run deploy:9826。\n· 发版：一律 npm run release（自动 commit→push→deploy:9826→build+restart 9825→三处一致性终检）。禁止手工拼 deploy/build/restart 组合，会出现版本漂移。\n· 运行态数据目录（.polaris-lite*）不入库；其中的敏感配置不属于插件说明范畴。"
  },
  {
    "id": "arch-dual-entry",
    "section": "architecture",
    "title": "插件双入口：UI 半边 + server 半边",
    "summary": "plugins/<id>/index.ts(x) 浏览器装配；可选 server.mjs Node 中间件。",
    "body": "插件目录：\n  plugins/<id>/\n  ├── index.ts(x)   # UI 半边：组件 + manifest，浏览器动态 import 装配\n  └── server.mjs    # server 半边（可选）：Node 中间件，读本地 FS/spawn 子进程\n\nserver 半边契约：导出 createServerPart({ dataDir, getSession, store, policy, logger })\n→ 返回 connect 风格中间件 (req,res,next)。宿主只注入这五项平台能力，插件拿不到其它宿主单例。\n\n装配：plugins/server-registry.mjs 登记 { id, entry }；server/host.mjs 顶层 await loadServerParts()\n按清单顺序装配。加载失败 fail-fast（宿主启动失败），不静默 404。删除某个 server 半边，宿主照常启动，\n该能力端点 404——这是判断「领域是否真的解耦」的试金石。\n\n边界：server/ 目录只放平台能力（auth/provider/relay/静态服务），领域端点（/api/fs/*、/api/tool/* 等）\n一律在插件 server 半边。tests/server-boundary.test.mjs + tests/arch.test.mjs 强制。"
  },
  {
    "id": "arch-cap-bus",
    "section": "architecture",
    "title": "cap 总线与信任模型",
    "summary": "跨插件协作唯一通道：dispatch({target,action,payload})；权限=manifest∩grants。",
    "body": "cap 总线是插件间唯一允许的调用通道，自带三重治理：授权（capabilities∩grants）、审计留痕、authGuard。\n不要开第二条通道（裸 window 全局、直连宿主单例都是越界）。\n\nSlotHostApi（插件拿到的运行时 API）：\n  api.dispatch<T>(req)          // cap 调用\n  api.listen(evt, fn) / api.emit(evt, payload)   // 仅 manifest.events 声明过的事件\n  api.registerCapability        // 仅 manifest.provides 声明过、仅 setup 内可用\n  api.theme / api.t / api.layout / api.overlay / api.workspace（需 cap.ui.layout 授权）\n\n信任模型：public/grants.json 是宿主侧授权表（进版本控制）；manifest 只是申请。\n实际生效权限 = manifest ∩ grants；grants 未登记的插件按 unlistedPolicy（当前 declare）\n自声明放行并告警。未在 grants 出现的权限不生效，记录在 denied 供追溯。"
  },
  {
    "id": "plugin-manifest",
    "section": "plugin",
    "title": "编写插件：manifest 与生命周期",
    "summary": "LitePlugin = manifest + setup(hostApi)；外部插件还需要 plugin.json + plugin.js。",
    "body": "内置插件（随构建发布）：\n  plugins/<id>/index.tsx 导出 default LitePlugin：\n    manifest: { id, name, version, capabilities?, provides?, events?, requires?,\n                 contributes: { slots?/views?/containers? } }\n    setup(hostApi) { ... }    // 装配钩子，注册能力在这里做\n  在 plugins/build-plugins.mjs 清单登记 { id, config, dist, order }；\n  有 server 半边再在 plugins/server-registry.mjs 加一行。\n\n外部插件（商城安装，免构建宿主）：\n  包内必须 plugin.json（manifest 子集）+ plugin.js（ESM bundle，react 走宿主 import map）；\n  style.css 可选。安装后落 <dataDir>/plugins/<id>/，registry 双写 module=/ext-plugins/<id>/plugin.js?v=hash8。"
  },
  {
    "id": "plugin-slots",
    "section": "ui",
    "title": "UI 贡献：槽位 / 视图 / 容器",
    "summary": "slots 填固定位置；views 可被布局树摆放；containers 接管宿主 chrome。",
    "body": "① 槽位贡献（存量契约）："
  },
  {
    "id": "ui-workspace",
    "section": "ui",
    "title": "工作区布局树",
    "summary": "anchor/split/tabs/view 四种节点；四个锚点：sidebar/stream/input/panel。",
    "body": "布局唯一数据模型是一棵可校验的树：\n  anchor（四个保留锚点 sidebar/stream/input/panel）\n  split（严格二分；尺寸 ratio/px/auto + of 作用侧）\n  tabs（≥2 子项、不嵌套、≤12 项、active 必须指向子节点 id）\n  view（id 实例标识 + viewType 指向注册视图）\n\n插件经 api.workspace 操作（全部是 cap.ui.layout 的薄包装）：\n  getTree/listViews/open(viewType,{where,anchor})/close/split/move/applyTree/reset\n  where: split-right（默认）/split-bottom/tab。\n\n归属规则：只能 close/move 自己前缀（pluginId）的视图；host.slot.* 是结构视图不可动；\napplyTree/reset 需 cap.ui.layout.global 且必须含四个锚点。\n"
  },
  {
    "id": "server-gateway",
    "section": "server",
    "title": "服务端能力网关（/api/cap）",
    "summary": "统一转发/鉴权/审计；请求 {target,action,payload}，能力由插件注册。",
    "body": "设计稿（docs/server-gateway-contract.md）：把前端 CapBus 的 gate→审计→转发模型延伸到服务端。\n\n浏览器插件发 fetch(/api/cap, {target, action, payload})；宿主唯一端口内：\n  识别 target → 查能力注册表定位提供方插件 → 鉴权（会话 + grants 细化到动作/限制级）→\n  转发执行 → 落审计（谁/调了什么/何时/结果）。\n\n能力命名 cap.<域>.<能力>；注册表记录提供方与描述；授权从能力名级细化到「能力+动作+限制」。\n平台端点（/api/auth/*、/api/providers/*、/api/model-relay）不走网关，保持专用中间件。\n商城化衔接：网关裁决点固定后，第三方插件 server 半边未来可平移到 worker/子进程隔离，只换传输层。"
  },
  {
    "id": "ai-engine",
    "section": "ai",
    "title": "AI 引擎契约（ai-engine）",
    "summary": "引擎即插件：接入新模型=新增插件，宿主与对话 UI 零改动。",
    "body": "角色：对话 UI 插件（chat-lite）面向 AiEnginePlugin 契约编程，不 import 任何具体引擎；\n引擎插件自行适配厂商差异（思考等级/工具/采样/流格式/CLI 子进程）；\n宿主只做能力网关/权限裁决/审计；引擎分派器按 engineId 路由，real-engine 兜底。\n\n统一流事件协议：文本增量/工具调用/思考/用量/错误/完成走同一种事件流（StreamEvent {kind,payload,seq,source}）。\n密钥不出后端：上游调用在插件 server 半边，对外仅宿主一个端口。\n\n当前默认引擎 real-engine（OpenAI 兼容中继）；codebuddy-engine 为 CLI 型备选（与 real-engine 互斥，\ncap.ai.chat 单注册位）。模型/供应商配置在 model-admin 插件（面板 + /api/providers）。"
  },
  {
    "id": "market-external",
    "section": "market",
    "title": "外部插件与商城",
    "summary": "dir/http/cc-marketplace 三类源；安装=校验→落盘 dataDir/plugins→registry 双写。",
    "body": "商城源（market-sources.json）：\n  dir            本地目录：<ref>/index.json 清单 + <ref>/<id>/{plugin.json,plugin.js,style.css}\n  http           远程清单 URL（本仓库新增）：清单 JSON 同目录按 <id>/ 相对寻址包文件；\n                 sha256 强校验必填（64 位指纹），fetch 走上游策略闸\n  cc-marketplace Claude Code 商城（owner/repo）：只导入声明型资源（skills/hooks/mcpServers），不运行外部 JS\n\n安装流程：校验（sha256/manifest/id 冲突）→ 落 <dataDir>/plugins/<id>/ → registry 双写增项\n（module=/ext-plugins/<id>/plugin.js?v=hash8）→ 刷新页面生效。\n卸载=删目录+registry 移除；/ext-plugins/<id>/* 自服务路由带穿越校验。\n\n已知边界：① 安装器只复制 plugin.js/plugin.json/style.css 三个文件，附属文件（如 MCP 脚本）\n需自行提供可访问路径；② 外部插件无 server 半边（动态挂载列 P3），纯 UI 刷新即用；\n③ npm run build 会重新生成 registry.json——发版后外部插件条目会丢，需重装；\n④ 未登记 grants 的插件按 declare 放行并告警（权限告警的来源）。"
  },
  {
    "id": "ext-four-channels",
    "section": "market",
    "title": "外部插件四通道：面板/Skill/MCP/Hook",
    "summary": "面板刷新即用；Skill/MCP/Hook 是「落盘登记」式，插件面板引导写入。",
    "body": "面板：bundle 动态 import 后按 manifest.contributes.slots 挂载，刷新页面即生效，免重启。\n\nSkill：运行时通道是 <workspace>/.claude/skills/<名>/SKILL.md（frontmatter: name/description）。\nskill-loader 插件扫描并注入系统提示附录，下轮对话生效；AI 可用 read_skill 工具按需读全文。\n外部插件可随包带 SKILL.md，由面板按钮经 /api/files-write/exec 写入工作区。\n\nMCP：登记式——<dataDir>/mcp-servers.json { servers: { name: { command,args,enabled } } }。\nmcp-bridge 拉起 stdio JSON-RPC 进程，下轮对话 AI 工具面出现 mcp__<name>__*。可由面板调\nPOST /api/mcp/servers 登记，或 AI 用 mcp_server_add 工具（带审批）。\n\nHook：<workspace>/.claude/settings.json 的 hooks 键（CC 兼容格式）。hook-bridge 按内容指纹缓存、\n变更即重载；workspace 级新钩子默认免确认（PLITE_HOOK_CONFIRM=1 恢复确认闸）。事件：\nPreToolUse/PostToolUse/UserPromptSubmit/SessionStart/Stop。命令型钩子在 shell 里执行，\n注意转义（\\\n 会被 shell 吃掉，用 String.fromCharCode(10) 之类替代）。"
  },
  {
    "id": "ops-build",
    "section": "ops",
    "title": "构建 / 测试 / 常用命令",
    "summary": "typecheck → test → build:plugins；dev:standalone 起开发环境。",
    "body": "常用命令：\n  npm run dev:standalone        # 开发环境（5000，.polaris-lite-dev/）\n  npm run typecheck             # tsc 主工程 + 插件工程\n  npm test                      # 全量 node:test（含 server-boundary/arch 等边界守卫）\n  npm run build:plugins         # 构建全部内置插件 + registry.json\n  npm run check:plugins         # 只跑静态一致性校验（CI 快速门禁）\n  npm run build                 # typecheck + check:plugins + vite build + sw manifest + sync-dist\n  npm run release               # 一键发版（commit→push→deploy:9826→build+restart 9825→终检）\n  npm run deploy:9826 / status:9826   # 分析实例发布/查看落后\n\n插件约束的门禁落点：manifest-views.mjs（viewType/槽位校验）、build-plugins.mjs（fail-fast 清单校验）、\nlintPluginCss（样式越界）、server-boundary.test.mjs（核心零业务）、arch.test.mjs（依赖方向）。\n改契约 = 同步改门禁 + 守卫测试 + docs/plugin-contract.md 三处；不一致时以代码门禁为准。"
  },
  {
    "id": "ops-extquad",
    "section": "ops",
    "title": "extquad 示例：外部插件全链路",
    "summary": "ext-plugins-src/extquad 是面板+Skill+MCP+Hook 四合一的最小可跑样例。",
    "body": "目录：ext-plugins-src/index.json（清单，含 sha256）+ ext-plugins-src/extquad/（plugin.json/plugin.js/style.css/index.tsx/mcp-server.mjs/vite.config.ts）。\n\n构建：npx vite build --config ext-plugins-src/extquad/vite.config.ts，把 dist 产物复制到包根，更新 index.json 的 sha256。\n\n安装：商城添加 dir 源（ref=…/ext-plugins-src）或 http 源（ref=raw index.json URL）→ install → 刷新页面。\n\n面板四个动作：kv 探活（/api/kv）、Skill 写入（/api/files-write/exec → .claude/skills/extquad-note/）、\nMCP 登记（POST /api/mcp/servers → extquad-echo，stdio echo 工具）、Hook 写入（.claude/settings.json PostToolUse）。\n\n验证点：技能出现在 /api/skills/list；mcp servers 状态 connected 且 1 个工具；hooks-audit.log 有执行记录且 exit 0。"
  }
];

function find(id) {
  return DOCS.find((d) => d.id === id) || null;
}

function search(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return DOCS.map(({ body, ...rest }) => rest);
  const terms = q.split(/\s+/);
  return DOCS
    .map((d) => {
      const hay = `${d.id} ${d.title} ${d.summary} ${d.body}`.toLowerCase();
      const score = terms.reduce((acc, t) => acc + (hay.includes(t) ? 1 : 0), 0);
      return { d, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ d }) => d);
}

const tools = [
  {
    name: 'guide_sections',
    description: '列出 polaris-lite 使用说明知识库的全部条目（id/所属节/标题/摘要）。想系统浏览规范时先调这个。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'guide_get',
    description: '按 id 取一篇 polaris-lite 规范说明全文（如 plugin-slots、market-external、arch-cap-bus）。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '知识条目 id，来自 guide_sections' } },
      required: ['id'],
    },
  },
  {
    name: 'guide_search',
    description: '按关键词检索 polaris-lite 规范知识库（如 sha256、槽位、cap 总线、http 源、发版），返回命中条目全文。',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: '关键词（空格分词，多词 AND 计分排序）' } },
      required: ['query'],
    },
  },
];

let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function textResult(text) {
  return { content: [{ type: 'text', text }] };
}

function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'plite-guide', version: '0.1.0' } } });
    return;
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools } });
    return;
  }
  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments ?? {};
    if (name === 'guide_sections') {
      const lines = DOCS.map((d) => `[${d.id}] (${d.section}) ${d.title} —— ${d.summary}`);
      send({ jsonrpc: '2.0', id, result: textResult(`共 ${DOCS.length} 篇：\n` + lines.join('\n')) });
      return;
    }
    if (name === 'guide_get') {
      const d = find(String(args.id ?? ''));
      if (!d) {
        send({ jsonrpc: '2.0', id, result: textResult(`未找到条目：${args.id}。先用 guide_sections 列出全部 id。`) });
        return;
      }
      send({ jsonrpc: '2.0', id, result: textResult(`[${d.id}] ${d.title}\n${d.summary}\n\n${d.body}`) });
      return;
    }
    if (name === 'guide_search') {
      const hits = search(args.query);
      if (!hits.length) {
        send({ jsonrpc: '2.0', id, result: textResult('没有命中。可先 guide_sections 浏览全部条目。') });
        return;
      }
      send({
        jsonrpc: '2.0', id,
        result: textResult(hits.map((d) => `[${d.id}] ${d.title}\n${d.summary}\n\n${d.body}`).join('\n\n———\n\n')),
      });
      return;
    }
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown tool: ${name}` } });
    return;
  }
  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

process.on('exit', () => process.stdout.write(''));
