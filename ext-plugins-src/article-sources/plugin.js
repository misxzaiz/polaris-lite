import x, { useState as u, useMemo as k } from "react";
var R = { exports: {} }, d = {};
/**
 * @license React
 * react-jsx-runtime.production.min.js
 *
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
var P = x, v = Symbol.for("react.element"), I = Symbol.for("react.fragment"), N = Object.prototype.hasOwnProperty, _ = P.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentOwner, A = { key: !0, ref: !0, __self: !0, __source: !0 };
function f(n, i, r) {
  var o, a = {}, l = null, c = null;
  r !== void 0 && (l = "" + r), i.key !== void 0 && (l = "" + i.key), i.ref !== void 0 && (c = i.ref);
  for (o in i) N.call(i, o) && !A.hasOwnProperty(o) && (a[o] = i[o]);
  if (n && n.defaultProps) for (o in i = n.defaultProps, i) a[o] === void 0 && (a[o] = i[o]);
  return { $$typeof: v, type: n, key: l, ref: c, props: a, _owner: _.current };
}
d.Fragment = I;
d.jsx = f;
d.jsxs = f;
R.exports = d;
var e = R.exports;
const g = "0.1.0", S = [
  {
    id: "blog-wordpress",
    section: "blog",
    title: "WordPress",
    summary: "全球最大开源博客/CMS，几乎每站自带 RSS（/feed/），极易聚合。",
    body: [
      "类型：开放博客平台（PHP 开源，自建免费）。",
      "接口：RSS 标配（?feed=rss2 或 /feed/），另有 WP REST API（/wp-json/wp/v2/posts）。",
      "反爬：低；多为独立站，欢迎订阅。",
      "适合：大规模内容聚合、按主题批量订阅独立博客。",
      "注意：商用抓取请遵守站点 robots 与版权。"
    ].join(`
`)
  },
  {
    id: "blog-ghost",
    section: "blog",
    title: "Ghost",
    summary: "现代开源出版平台，自带 Content API 与 RSS，界面体验佳。",
    body: [
      "类型：开放博客/出版平台（Node.js 开源）。",
      "接口：Ghost Content API（/ghost/api/content/posts/）+ RSS（/rss/）。",
      "反爬：低。",
      "适合：做优雅的独立写作站，或聚合高质量英文博客。"
    ].join(`
`)
  },
  {
    id: "blog-writefreely",
    section: "blog",
    title: "WriteFreely",
    summary: "极简开源写作平台，无追踪无脚本，支持 ActivityPub 联邦。",
    body: [
      "类型：极简长文平台（Go 开源）。",
      "接口：ActivityPub 联邦 + 简单 web 结构，RSS 部分实例可用。",
      "反爬：低。",
      "适合：极简主义者、去中心化写作场景。"
    ].join(`
`)
  },
  {
    id: "blog-typecho-halo",
    section: "blog",
    title: "Typecho / Halo",
    summary: "国内常用开源博客系统，个人博客多，结构简单。",
    body: [
      "类型：开源博客系统（PHP/Java）。",
      "接口：多数自带 RSS（/feed/ 或 /atom）；结构简单易解析。",
      "反爬：低。",
      "适合：聚合中文个人独立博客，源站质量取决于作者。"
    ].join(`
`)
  },
  {
    id: "cn-juejin",
    section: "cn",
    title: "掘金",
    summary: "技术社区，内容质量不错，网页结构清晰。",
    body: [
      "类型：中文技术内容社区。",
      "接口：无官方 RSS；可走 RSSHub 路由或自有网页解析。",
      "反爬：中；频繁抓取会触发限流。",
      "适合：前端/移动/AI 技术文章聚合，适合轻量使用。"
    ].join(`
`)
  },
  {
    id: "cn-cnblogs",
    section: "cn",
    title: "博客园",
    summary: "老牌技术博客，RSS 一直可用，抓取友好。",
    body: [
      "类型：中文技术博客平台。",
      "接口：官方 RSS 支持（按分类/按作者均可）。",
      "反爬：低。",
      "适合：.NET/后端/架构类技术内容，聚合首选。"
    ].join(`
`)
  },
  {
    id: "cn-sspai",
    section: "cn",
    title: "少数派",
    summary: "数字生活/效率工具，高质量长文，有官方 RSS。",
    body: [
      "类型：中文知识/数字生活内容站。",
      "接口：官方 RSS（sspai.com/feed）。",
      "反爬：低。",
      "适合：效率工具、数码、生活工作流类内容聚合。"
    ].join(`
`)
  },
  {
    id: "cn-v2ex",
    section: "cn",
    title: "V2EX",
    summary: "技术讨论社区，可按节点抓，讨论质量参差。",
    body: [
      "类型：技术讨论论坛。",
      "接口：官方 API（部分公开）+ RSSHub 节点路由。",
      "反爬：中；需控制频率，遵守规则。",
      "适合：话题式内容，不适合纯文章流。"
    ].join(`
`)
  },
  {
    id: "cn-zhihu",
    section: "cn",
    title: "知乎",
    summary: "内容量大，反爬强，只适合轻度使用。",
    body: [
      "类型：问答/专栏社区。",
      "接口：无公开 RSS；需 cookie/登录态或第三方中转。",
      "反爬：高。",
      "适合：单篇精读，不适合批量聚合。"
    ].join(`
`)
  },
  {
    id: "agg-rsshub",
    section: "agg",
    title: "RSSHub",
    summary: "把无数无 RSS 站点（微博/B站/公众号相关）转成 RSS，聚合神器。",
    body: [
      "类型：开源 RSS 生成器（可自建，npm/docker 一键起）。",
      "接口：REST 风格路由，每个站点对应一条 /<domain>/<path> 路由。",
      "反爬：取决于上游站点；部分路由需配置 cookie。",
      "适合：把没有 RSS 的站点转成订阅流；是聚合方案的核心组件。"
    ].join(`
`)
  },
  {
    id: "agg-freshrss",
    section: "agg",
    title: "FreshRSS",
    summary: "自托管 RSS 阅读器，可当后端内容池。",
    body: [
      "类型：自托管 RSS 服务（PHP 开源）。",
      "接口：Google Reader 兼容 API + Web UI。",
      "适合：做私有订阅中心，配合前端展示或 API 给 AI/自动化工具消费。"
    ].join(`
`)
  },
  {
    id: "agg-miniflux",
    section: "agg",
    title: "Miniflux",
    summary: "轻量自托管 RSS，Go 实现，部署极简。",
    body: [
      "类型：自托管 RSS 服务（Go 开源，单二进制）。",
      "接口：REST API + Fever 兼容接口。",
      "适合：喜欢极简、资源少的自托管场景。"
    ].join(`
`)
  },
  {
    id: "agg-huginn",
    section: "agg",
    title: "Huginn",
    summary: "开源自动化编排工具，定时抓取+处理+推送全流程。",
    body: [
      "类型：自动化 agent 平台（Ruby 开源）。",
      "接口：内置众多抓取/过滤/通知 agent，可自由组合工作流。",
      "适合：需要「定时抓取 → 清洗 → 推送到 IM/RSS」的自动化场景。"
    ].join(`
`)
  },
  {
    id: "diy-arch-recipe",
    section: "diy",
    title: "自建文章聚合站方案",
    summary: "RSSHub + FreshRSS/Miniflux + 自定义前端，一套成熟开源组合。",
    body: [
      "定位：想自建类似「公众号聚合」的阅读/导航站。",
      "架构：RSSHub（转源）→ FreshRSS/Miniflux（存储+订阅管理）→ 自写前端展示。",
      "公众号现实：无官方公开 API，常见走 RSSHub 部分路由、搜狗微信缓存、wechat2rss 类第三方服务，稳定性一般；商用注意合规。",
      "部署建议：docker-compose 起三件套，成本极低；先小规模跑几个源，观察抓取成功率再扩容。"
    ].join(`
`)
  }
], w = [
  { key: "all", label: "全部" },
  { key: "blog", label: "博客平台" },
  { key: "cn", label: "中文社区" },
  { key: "agg", label: "聚合工具" },
  { key: "diy", label: "自建方案" }
], C = ".claude/skills/article-sources/SKILL.md", O = [
  "---",
  "name: article-sources",
  "description: 开源文章源知识库：博客平台(WordPress/Ghost/WriteFreely/Typecho)、中文社区(掘金/博客园/少数派/V2EX/知乎)、聚合工具(RSSHub/FreshRSS/Miniflux/Huginn)、自建聚合方案。回答「找文章源/聚合方案/RSS 搭建」类问题先查这里。",
  "---",
  "",
  "# article-sources：开源文章源知识库",
  "",
  "本技能由外部插件 article-sources 提供。用法：",
  "",
  "1. 优先用 MCP 工具 sources_search（关键词）或 sources_get（按 id）取条目；",
  "2. 面板里也能人工浏览同一份知识库（article-sources 面板）；",
  "3. 覆盖主题：开放博客平台及其 RSS/API、中文内容社区及反爬强度、",
  "   RSSHub/FreshRSS/Miniflux/Huginn 等聚合工具、自建文章聚合站架构、公众号无官方 API 的现实。",
  "",
  "本知识库为静态整理，条目可能过时；实际接入前请验证源站可用性与版权条款。",
  ""
].join(`
`);
function T() {
  var h;
  const [n, i] = u("all"), [r, o] = u(""), [a, l] = u(((h = S[0]) == null ? void 0 : h.id) ?? null), [c, m] = u("idle"), [y, b] = u(!1), p = k(() => {
    const s = r.trim().toLowerCase();
    return S.filter((t) => n === "all" || t.section === n ? s ? `${t.id} ${t.title} ${t.summary} ${t.body}`.toLowerCase().includes(s) : !0 : !1);
  }, [n, r]), j = async () => {
    b(!0);
    try {
      const s = await fetch("/api/files-write/exec", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ action: "write", path: C, content: O, sessionId: "article-sources-panel" })
      }), t = await s.json().catch(() => null);
      m(s.ok && (t != null && t.ok) ? "ok" : "fail");
    } catch {
      m("fail");
    }
    b(!1);
  };
  return /* @__PURE__ */ e.jsxs("div", { className: "as-panel article-sources-panel", children: [
    /* @__PURE__ */ e.jsxs("div", { className: "as-head", children: [
      /* @__PURE__ */ e.jsx("h3", { children: "文章源导航" }),
      /* @__PURE__ */ e.jsxs("p", { children: [
        "开源文章源知识库 v",
        g,
        " · ",
        S.length,
        " 条 · 仅查询"
      ] })
    ] }),
    /* @__PURE__ */ e.jsxs("div", { className: "as-toolbar", children: [
      /* @__PURE__ */ e.jsx("div", { className: "as-tabs", children: w.map((s) => /* @__PURE__ */ e.jsx(
        "button",
        {
          type: "button",
          className: `as-tab ${n === s.key ? "active" : ""}`,
          onClick: () => i(s.key),
          children: s.label
        },
        s.key
      )) }),
      /* @__PURE__ */ e.jsx(
        "input",
        {
          className: "as-search",
          placeholder: "搜索文章源…（如 RSS、掘金、聚合）",
          value: r,
          onChange: (s) => o(s.target.value)
        }
      )
    ] }),
    /* @__PURE__ */ e.jsxs("div", { className: "as-list", children: [
      p.length === 0 && /* @__PURE__ */ e.jsx("div", { className: "as-empty", children: "没有匹配的条目" }),
      p.map((s) => {
        const t = a === s.id;
        return /* @__PURE__ */ e.jsxs("div", { className: `as-item ${t ? "open" : ""}`, children: [
          /* @__PURE__ */ e.jsxs("button", { type: "button", className: "as-item-head", onClick: () => l(t ? null : s.id), children: [
            /* @__PURE__ */ e.jsx("span", { className: "as-item-title", children: s.title }),
            /* @__PURE__ */ e.jsx("span", { className: "as-item-summary", children: s.summary }),
            /* @__PURE__ */ e.jsx("span", { className: "as-item-id", children: s.id })
          ] }),
          t && /* @__PURE__ */ e.jsx("pre", { className: "as-item-body", children: s.body })
        ] }, s.id);
      })
    ] }),
    /* @__PURE__ */ e.jsxs("div", { className: "as-foot", children: [
      /* @__PURE__ */ e.jsxs("div", { className: "as-skill", children: [
        /* @__PURE__ */ e.jsx("span", { children: "AI 通道：把本知识库写成工作区技能（.claude/skills/article-sources/SKILL.md）， 下轮对话 AI 即可引用；也可用随包 MCP 工具 sources_search / sources_get 直接检索。" }),
        /* @__PURE__ */ e.jsx("button", { type: "button", disabled: y, onClick: j, children: y ? "写入中…" : c === "ok" ? "已写入 ✓" : "写入 AI 技能" })
      ] }),
      c === "fail" && /* @__PURE__ */ e.jsx("div", { className: "as-error", children: "技能写入失败：检查 files-write 写面是否可用。" })
    ] })
  ] });
}
const L = {
  manifest: {
    id: "article-sources",
    name: "文章源导航",
    version: g,
    capabilities: [],
    contributes: {
      slots: [{ slot: "panel", component: "ArticleSourcesPanel", order: 42, title: "文章源导航" }]
    }
  },
  setup(n) {
  }
};
export {
  T as ArticleSourcesPanel,
  L as articleSourcesPlugin,
  L as default
};
