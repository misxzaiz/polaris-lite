import q, { useState as x, useCallback as v, useEffect as S } from "react";
var f = { exports: {} }, k = {};
/**
 * @license React
 * react-jsx-runtime.production.min.js
 *
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
var j = q, _ = Symbol.for("react.element"), w = Symbol.for("react.fragment"), b = Object.prototype.hasOwnProperty, T = j.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentOwner, O = { key: !0, ref: !0, __self: !0, __source: !0 };
function g(i, n, a) {
  var o, l = {}, r = null, d = null;
  a !== void 0 && (r = "" + a), n.key !== void 0 && (r = "" + n.key), n.ref !== void 0 && (d = n.ref);
  for (o in n) b.call(n, o) && !O.hasOwnProperty(o) && (l[o] = n[o]);
  if (i && i.defaultProps) for (o in n = i.defaultProps, n) l[o] === void 0 && (l[o] = n[o]);
  return { $$typeof: _, type: i, key: r, ref: d, props: l, _owner: T.current };
}
k.Fragment = w;
k.jsx = g;
k.jsxs = g;
f.exports = k;
var s = f.exports;
const m = ".claude/skills/extquad-note/SKILL.md", N = [
  "---",
  "name: extquad-note",
  "description: extquad 外部插件携带的示例技能：验证 外部插件→工作区技能落盘→下轮对话进系统提示附录 全链路。",
  "---",
  "",
  "# extquad-note",
  "",
  "这是由外部插件 extquad 落盘的示例技能。",
  "当用户提到「extquad 技能验证」时，回答“外部插件 skill 通道 OK”。",
  ""
].join(`
`), P = {
  hooks: {
    PostToolUse: [
      {
        matcher: "*",
        hooks: [
          { type: "command", command: `node -e "require('fs').appendFileSync('extquad-hook.log', String(Date.now())+' post-tool-use\\n')"`, timeout: 10 }
        ]
      }
    ]
  }
};
async function h(i, n) {
  try {
    const a = await fetch("/api/files-write/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ action: "write", path: i, content: n, sessionId: "extquad-panel" })
    }), o = await a.json().catch(() => null);
    return a.ok && (o != null && o.ok) ? { ok: !0, msg: "ok" } : { ok: !1, msg: (o == null ? void 0 : o.error) ?? `HTTP ${a.status}` };
  } catch (a) {
    return { ok: !1, msg: String((a == null ? void 0 : a.message) ?? a) };
  }
}
function C() {
  const [i, n] = x({ kv: "unknown", skill: "unknown", mcp: "unknown", hook: "unknown", log: [] }), [a, o] = x(null), l = v((e) => {
    n((t) => ({ ...t, log: [`${(/* @__PURE__ */ new Date()).toLocaleTimeString()}  ${e}`, ...t.log].slice(0, 40) }));
  }, []);
  S(() => {
    (async () => {
      try {
        const e = await fetch("/api/kv/set", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ namespace: "extquad", key: "ping", value: { at: Date.now() } })
        }), t = await fetch("/api/kv/get?namespace=extquad&key=ping", { credentials: "include" }), c = e.ok && t.ok;
        n((p) => ({ ...p, kv: c ? "ok" : "fail" })), l(`kv 探活 ${c ? "成功" : "失败"}`);
      } catch (e) {
        n((t) => ({ ...t, kv: "fail" })), l(`kv 探活失败：${String((e == null ? void 0 : e.message) ?? e)}`);
      }
    })();
  }, [l]);
  const r = async () => {
    o("skill");
    const e = await h(m, N);
    n((t) => ({ ...t, skill: e.ok ? "written" : "fail" })), l(`skill 写入 ${e.ok ? "成功（下轮对话进技能附录）" : `失败：${e.msg}`}`), o(null);
  }, d = async () => {
    o("mcp");
    try {
      const e = await fetch("/api/mcp/servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          name: "extquad-echo",
          command: "node",
          // MCP server 是本地进程脚本（stdio），走文件系统路径而非 /ext-plugins URL
          //（安装器只复制 plugin.js/plugin.json/style.css 三个文件）。
          args: ["D:/space/base/polaris-lite/ext-plugins-src/extquad/mcp-server.mjs"],
          enabled: !0
        })
      }), t = await e.json().catch(() => null), c = e.ok && (t == null ? void 0 : t.ok) !== !1 && !(t != null && t.error);
      n((p) => ({ ...p, mcp: c ? "registered" : "fail" })), l(`mcp 登记 ${c ? "成功（下轮对话出现 mcp__extquad-echo__*）" : `失败：${(t == null ? void 0 : t.error) ?? e.status}`}`);
    } catch (e) {
      n((t) => ({ ...t, mcp: "fail" })), l(`mcp 登记失败：${String((e == null ? void 0 : e.message) ?? e)}`);
    }
    o(null);
  }, y = async () => {
    o("hook");
    const e = await h(".claude/settings.json", JSON.stringify(P, null, 2) + `
`);
    n((t) => ({ ...t, hook: e.ok ? "written" : "fail" })), l(`hook 写入 ${e.ok ? "成功（新钩子需在钩子面板确认后执行）" : `失败：${e.msg}`}`), o(null);
  }, u = ({ v: e }) => /* @__PURE__ */ s.jsx("span", { className: `extquad-dot ${e === "ok" || e === "written" || e === "registered" ? "extquad-ok" : e === "fail" ? "extquad-fail" : "extquad-idle"}` });
  return /* @__PURE__ */ s.jsxs("div", { className: "extquad-panel", children: [
    /* @__PURE__ */ s.jsxs("div", { className: "extquad-head", children: [
      /* @__PURE__ */ s.jsx("h3", { children: "extquad 四合一验证" }),
      /* @__PURE__ */ s.jsx("p", { children: "外部插件 → 面板 / Skill / MCP / Hook 全链路冒烟" })
    ] }),
    /* @__PURE__ */ s.jsxs("ul", { className: "extquad-list", children: [
      /* @__PURE__ */ s.jsxs("li", { children: [
        /* @__PURE__ */ s.jsx(u, { v: i.kv }),
        " 面板 + kv 探活（/api/kv）"
      ] }),
      /* @__PURE__ */ s.jsxs("li", { children: [
        /* @__PURE__ */ s.jsx(u, { v: i.skill }),
        " Skill：写 ",
        m,
        /* @__PURE__ */ s.jsx("button", { type: "button", disabled: a === "skill", onClick: r, children: a === "skill" ? "…" : "写入" })
      ] }),
      /* @__PURE__ */ s.jsxs("li", { children: [
        /* @__PURE__ */ s.jsx(u, { v: i.mcp }),
        " MCP：登记 stdio server（extquad-echo）",
        /* @__PURE__ */ s.jsx("button", { type: "button", disabled: a === "mcp", onClick: d, children: a === "mcp" ? "…" : "登记" })
      ] }),
      /* @__PURE__ */ s.jsxs("li", { children: [
        /* @__PURE__ */ s.jsx(u, { v: i.hook }),
        " Hook：写 .claude/settings.json（PostToolUse）",
        /* @__PURE__ */ s.jsx("button", { type: "button", disabled: a === "hook", onClick: y, children: a === "hook" ? "…" : "写入" })
      ] })
    ] }),
    /* @__PURE__ */ s.jsx("div", { className: "extquad-log", children: i.log.length === 0 ? /* @__PURE__ */ s.jsx("div", { className: "extquad-log-empty", children: "暂无日志" }) : i.log.map((e, t) => /* @__PURE__ */ s.jsx("div", { children: e }, t)) }),
    /* @__PURE__ */ s.jsx("p", { className: "extquad-note", children: "注意：Skill/Hook 写入后下轮对话生效；Hook 新规则需在钩子面板确认一次；MCP 下轮 discoverTools 可见。" })
  ] });
}
const E = {
  manifest: {
    id: "extquad",
    name: "extquad 四合一",
    version: "0.1.0",
    capabilities: [],
    contributes: {
      slots: [{ slot: "panel", component: "ExtQuadPanel", order: 40, title: "extquad 验证台" }]
    }
  },
  setup(i) {
  }
};
export {
  C as ExtQuadPanel,
  E as default,
  E as extquadPlugin
};
