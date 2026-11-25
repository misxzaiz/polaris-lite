#!/usr/bin/env node
/**
 * article-sources 随包 MCP server（stdio JSON-RPC 2.0）。
 * 让 AI 直接检索开源文章源知识库：
 *   sources_sections            → 分类列表
 *   sources_list { section }    → 某分类条目列表
 *   sources_get { id }          → 单条详情
 *   sources_search { query }    → 关键词检索（标题/摘要/正文）
 * 知识库与前端面板共享同一份静态数据（knowledge.ts 编译进 bundle；
 * 此处以内联 JSON 维护同一份——两者需同步更新）。
 */
process.stdin.setEncoding('utf8');

const DOCS = [
  {
    "id": "blog-wordpress",
    "section": "blog",
    "title": "WordPress",
    "summary": "全球最大开源博客/CMS，几乎每站自带 RSS（/feed/），极易聚合。",
    "body": "类型：开放博客平台（PHP 开源，自建免费）。\n接口：RSS 标配（?feed=rss2 或 /feed/），另有 WP REST API（/wp-json/wp/v2/posts）。\n反爬：低；多为独立站，欢迎订阅。\n适合：大规模内容聚合、按主题批量订阅独立博客。\n注意：商用抓取请遵守站点 robots 与版权。"
  },
  {
    "id": "blog-ghost",
    "section": "blog",
    "title": "Ghost",
    "summary": "现代开源出版平台，自带 Content API 与 RSS，界面体验佳。",
    "body": "类型：开放博客/出版平台（Node.js 开源）。\n接口：Ghost Content API（/ghost/api/content/posts/）+ RSS（/rss/）。\n反爬：低。\n适合：做优雅的独立写作站，或聚合高质量英文博客。"
  },
  {
    "id": "blog-writefreely",
    "section": "blog",
    "title": "WriteFreely",
    "summary": "极简开源写作平台，无追踪无脚本，支持 ActivityPub 联邦。",
    "body": "类型：极简长文平台（Go 开源）。\n接口：ActivityPub 联邦 + 简单 web 结构，RSS 部分实例可用。\n反爬：低。\n适合：极简主义者、去中心化写作场景。"
  },
  {
    "id": "blog-typecho-halo",
    "section": "blog",
    "title": "Typecho / Halo",
    "summary": "国内常用开源博客系统，个人博客多，结构简单。",
    "body": "类型：开源博客系统（PHP/Java）。\n接口：多数自带 RSS（/feed/ 或 /atom）；结构简单易解析。\n反爬：低。\n适合：聚合中文个人独立博客，源站质量取决于作者。"
  },
  {
    "id": "cn-juejin",
    "section": "cn",
    "title": "掘金",
    "summary": "技术社区，内容质量不错，网页结构清晰。",
    "body": "类型：中文技术内容社区。\n接口：无官方 RSS；可走 RSSHub 路由或自有网页解析。\n反爬：中；频繁抓取会触发限流。\n适合：前端/移动/AI 技术文章聚合，适合轻量使用。"
  },
  {
    "id": "cn-cnblogs",
    "section": "cn",
    "title": "博客园",
    "summary": "老牌技术博客，RSS 一直可用，抓取友好。",
    "body": "类型：中文技术博客平台。\n接口：官方 RSS 支持（按分类/按作者均可）。\n反爬：低。\n适合：.NET/后端/架构类技术内容，聚合首选。"
  },
  {
    "id": "cn-sspai",
    "section": "cn",
    "title": "少数派",
    "summary": "数字生活/效率工具，高质量长文，有官方 RSS。",
    "body": "类型：中文知识/数字生活内容站。\n接口：官方 RSS（sspai.com/feed）。\n反爬：低。\n适合：效率工具、数码、生活工作流类内容聚合。"
  },
  {
    "id": "cn-v2ex",
    "section": "cn",
    "title": "V2EX",
    "summary": "技术讨论社区，可按节点抓，讨论质量参差。",
    "body": "类型：技术讨论论坛。\n接口：官方 API（部分公开）+ RSSHub 节点路由。\n反爬：中；需控制频率，遵守规则。\n适合：话题式内容，不适合纯文章流。"
  },
  {
    "id": "cn-zhihu",
    "section": "cn",
    "title": "知乎",
    "summary": "内容量大，反爬强，只适合轻度使用。",
    "body": "类型：问答/专栏社区。\n接口：无公开 RSS；需 cookie/登录态或第三方中转。\n反爬：高。\n适合：单篇精读，不适合批量聚合。"
  },
  {
    "id": "agg-rsshub",
    "section": "agg",
    "title": "RSSHub",
    "summary": "把无数无 RSS 站点（微博/B站/公众号相关）转成 RSS，聚合神器。",
    "body": "类型：开源 RSS 生成器（可自建，npm/docker 一键起）。\n接口：REST 风格路由，每个站点对应一条 /<domain>/<path> 路由。\n反爬：取决于上游站点；部分路由需配置 cookie。\n适合：把没有 RSS 的站点转成订阅流；是聚合方案的核心组件。"
  },
  {
    "id": "agg-freshrss",
    "section": "agg",
    "title": "FreshRSS",
    "summary": "自托管 RSS 阅读器，可当后端内容池。",
    "body": "类型：自托管 RSS 服务（PHP 开源）。\n接口：Google Reader 兼容 API + Web UI。\n适合：做私有订阅中心，配合前端展示或 API 给 AI/自动化工具消费。"
  },
  {
    "id": "agg-miniflux",
    "section": "agg",
    "title": "Miniflux",
    "summary": "轻量自托管 RSS，Go 实现，部署极简。",
    "body": "类型：自托管 RSS 服务（Go 开源，单二进制）。\n接口：REST API + Fever 兼容接口。\n适合：喜欢极简、资源少的自托管场景。"
  },
  {
    "id": "agg-huginn",
    "section": "agg",
    "title": "Huginn",
    "summary": "开源自动化编排工具，定时抓取+处理+推送全流程。",
    "body": "类型：自动化 agent 平台（Ruby 开源）。\n接口：内置众多抓取/过滤/通知 agent，可自由组合工作流。\n适合：需要「定时抓取 → 清洗 → 推送到 IM/RSS」的自动化场景。"
  },
  {
    "id": "diy-arch-recipe",
    "section": "diy",
    "title": "自建文章聚合站方案",
    "summary": "RSSHub + FreshRSS/Miniflux + 自定义前端，一套成熟开源组合。",
    "body": "定位：想自建类似「公众号聚合」的阅读/导航站。\n架构：RSSHub（转源）→ FreshRSS/Miniflux（存储+订阅管理）→ 自写前端展示。\n公众号现实：无官方公开 API，常见走 RSSHub 部分路由、搜狗微信缓存、wechat2rss 类第三方服务，稳定性一般；商用注意合规。\n部署建议：docker-compose 起三件套，成本极低；先小规模跑几个源，观察抓取成功率再扩容。"
  }
];

const SECTION_LABELS = [
  { key: 'blog', label: '博客平台' },
  { key: 'cn', label: '中文社区' },
  { key: 'agg', label: '聚合工具' },
  { key: 'diy', label: '自建方案' },
];

const TOOLS = [
  {
    name: 'sources_sections',
    description: '列出开源文章源知识库全部分类',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'sources_list',
    description: '按分类列出开源文章源条目（section: blog/cn/agg/diy）',
    inputSchema: {
      type: 'object',
      properties: { section: { type: 'string', enum: ['blog', 'cn', 'agg', 'diy'] } },
      required: ['section'],
      additionalProperties: false,
    },
  },
  {
    name: 'sources_get',
    description: '按 id 获取单条文章源详情',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'sources_search',
    description: '关键词检索开源文章源知识库（标题/摘要/正文）',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
];

function textResult(text) {
  return { content: [{ type: 'text', text }] };
}

function search(q) {
  const s = String(q || '').toLowerCase();
  return DOCS.filter((d) => `${d.id} ${d.title} ${d.summary} ${d.body}`.toLowerCase().includes(s));
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

let buf = '';

process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line) handle(line);
  }
});

function handle(line) {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = req;
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'article-sources', version: '0.1.0' },
      },
    });
    return;
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }
  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments ?? {};
    if (name === 'sources_sections') {
      send({
        jsonrpc: '2.0', id,
        result: textResult(
          SECTION_LABELS.map((s) => `${s.key} — ${s.label}（${DOCS.filter((d) => d.section === s.key).length} 条）`).join('\n')
        ),
      });
      return;
    }
    if (name === 'sources_list') {
      const hits = DOCS.filter((d) => d.section === args.section);
      if (!hits.length) {
        send({ jsonrpc: '2.0', id, result: textResult('该分类没有条目。先用 sources_sections 查看分类。') });
        return;
      }
      send({
        jsonrpc: '2.0', id,
        result: textResult(hits.map((d) => `[${d.id}] ${d.title}\n${d.summary}`).join('\n\n')),
      });
      return;
    }
    if (name === 'sources_get') {
      const d = DOCS.find((x) => x.id === args.id);
      if (!d) {
        send({ jsonrpc: '2.0', id, result: textResult(`未找到条目：${args.id}。先用 sources_list 浏览。`) });
        return;
      }
      send({ jsonrpc: '2.0', id, result: textResult(`[${d.id}] ${d.title}\n${d.summary}\n\n${d.body}`) });
      return;
    }
    if (name === 'sources_search') {
      const hits = search(args.query);
      if (!hits.length) {
        send({ jsonrpc: '2.0', id, result: textResult('没有命中。可换关键词或用 sources_sections 浏览分类。') });
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
