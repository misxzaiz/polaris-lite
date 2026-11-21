/**
 * 转录渲染（分享页 HTML / Markdown / 错误页）。
 * 自包含 HTML：数据与渲染 JS 全部内联，免登录、无外部依赖。
 */
import { maskByPattern } from './redact.mjs';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const ST_ICONS = { done: '[完成]', error: '[失败]', denied: '[拒绝]' };
const stIcon = (st) => ST_ICONS[st] ?? '[进行中]';

/** 工具条目 → Markdown 片段 */
function toolMd(c) {
  const lines = [];
  lines.push(`### [工具] ${c.name} ${stIcon(c.status)}${c.durationMs !== undefined ? ` (${c.durationMs}ms)` : ''}`);
  if (c.command) lines.push('```sh', c.command, '```');
  if (c.exitCode !== undefined) lines.push(`exit=${c.exitCode}${c.truncated ? ' · 输出已截断' : ''}`);
  if (c.stdout) lines.push('```', c.stdout, '```');
  if (c.stderr) lines.push('```', c.stderr, '```');
  return lines.join('\n');
}

/** 转录 JSON → Markdown（AI 可直接读） */
export function renderMarkdown(t) {
  const lines = [];
  lines.push(`# ${t.title}`);
  lines.push('');
  lines.push(`> 会话 ${t.sessionId} · ${t.messages.length} 条消息 · 转录于 ${fmtTime(t.capturedAt)} · 内容已脱敏`);
  lines.push('');
  for (const m of t.messages) {
    if (m.role === 'user') {
      lines.push(`## 用户 · ${fmtTime(m.createdAt)}`, '', m.content || '（空）', '');
    } else if (m.role === 'assistant') {
      lines.push(`## AI · ${fmtTime(m.createdAt)}`, '');
      if (m.blocks) {
        for (const b of m.blocks) {
          if (b.type === 'tool') lines.push(toolMd(b.tool), '');
          else if (b.type === 'thinking') lines.push('<details><summary>思考</summary>', '', b.text, '', '</details>', '');
          else if (b.type === 'interactive') {
            lines.push(`**[${b.kind}] ${b.title}**`);
            if (b.answer !== undefined) lines.push('', '作答：', '```json', JSON.stringify(b.answer, null, 2), '```');
            lines.push('');
          } else if (b.type === 'artifact') lines.push(`**产物：${b.title}**（${b.rendererType}）`, '');
          else if (b.type === 'text') lines.push(b.text, '');
          else lines.push(`> ${b.text}`, ''); // notice / truncated
        }
      } else {
        lines.push(m.content || '（空）', '');
      }
    } else if (m.role === 'tool' && m.tool) {
      lines.push(toolMd(m.tool), '');
    }
  }
  return maskByPattern(lines.join('\n'));
}

/** 页面脚本：渲染 + live 轮询（内联在 HTML 里；保持 ES5 以兼容老 WebView） */
function pageScript() {
  return `
(function () {
  var DATA = window.__SHARE__.data;
  var META = window.__SHARE__.meta;
  var root = document.getElementById('root');
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    function p(n) { return String(n).padStart(2, '0'); }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function stClass(st) {
    return ['done','error','denied','running','awaiting','resolved'].indexOf(st) >= 0 ? st : 'running';
  }
  function renderTool(c) {
    var dur = c.durationMs != null ? '(' + c.durationMs + 'ms)' : '';
    var html = '<div class="tool"><div class="tool-head"><span class="tool-name">' + esc(c.name) + '</span>' +
      '<span class="tool-status ' + stClass(c.status) + '">' + esc(c.status) + '</span>' +
      '<span class="dur">' + dur + '</span></div>';
    if (c.command) html += '<div class="tool-cmd">' + esc(c.command) + '</div>';
    if (c.stdout) html += '<div class="tool-out">' + esc(c.stdout) + '</div>';
    if (c.stderr) html += '<div class="tool-out err">' + esc(c.stderr) + '</div>';
    if (c.exitCode != null) html += '<div class="tool-out">exit=' + c.exitCode + (c.truncated ? ' &middot; 输出已截断' : '') + '</div>';
    return html + '</div>';
  }
  function renderMsg(m) {
    var who = m.role === 'user' ? '用户' : m.role === 'assistant' ? 'AI' : '[工具] ' + (m.tool ? m.tool.name : m.role);
    var html = '<div class="msg ' + esc(m.role) + '"><div class="who">' + who + '<span class="time">' + fmtTime(m.createdAt) + '</span></div>';
    if (m.blocks) {
      m.blocks.forEach(function (b) {
        if (b.type === 'tool') html += renderTool(b.tool);
        else if (b.type === 'thinking') html += '<details class="think"><summary>思考</summary><div class="body">' + esc(b.text) + '</div></details>';
        else if (b.type === 'interactive') html += '<div class="tool"><div class="tool-head"><span class="tool-name">[' + esc(b.kind) + '] ' + esc(b.title) + '</span>' + (b.answer !== undefined ? '<span class="tool-status done">已作答</span>' : '') + '</div></div>';
        else if (b.type === 'artifact') html += '<div class="notice">产物：' + esc(b.title) + '（' + esc(b.rendererType) + '）</div>';
        else if (b.type === 'text') html += '<div class="bubble">' + esc(b.text) + '</div>';
        else html += '<div class="notice">' + esc(b.text) + '</div>';
      });
    } else if (m.tool) {
      html += renderTool(m.tool);
    } else {
      html += '<div class="bubble">' + esc(m.content || '（空）') + '</div>';
    }
    return html + '</div>';
  }
  function headHtml(d) {
    var live = META.live ? ' · <span class="live-dot"></span><b id="live-badge">实时中</b>' : '';
    return '<header><h1>' + esc(d.title) + '</h1><div class="meta">' + d.messages.length +
      ' 条消息 · 转录于 ' + fmtTime(d.capturedAt) + live +
      '</div><div class="toolbar"><a href="./json">JSON</a><a href="./markdown">Markdown</a><button id="refresh-btn">刷新</button></div></header>';
  }
  function rerender(d) {
    root.innerHTML = headHtml(d) + d.messages.map(renderMsg).join('') +
      '<div class="foot">transcript-share · 只读分享 · 内容已脱敏</div>';
  }
  rerender(DATA);

  if (META.live) {
    var lastCount = DATA.messages.length;
    var lastVersion = DATA.version;
    var timer = setInterval(function () {
      fetch(location.pathname + '/json', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
          if (!j) return;
          if (j.messages.length !== lastCount || j.version !== lastVersion) {
            lastCount = j.messages.length;
            lastVersion = j.version;
            rerender(j);
          }
        })
        .catch(function () {});
    }, 3000);
    document.getElementById('refresh-btn').addEventListener('click', function () { location.reload(); });
    void timer;
  } else {
    document.getElementById('refresh-btn').addEventListener('click', function () { location.reload(); });
  }
})();
`;
}

/** 转录 JSON → 自包含 HTML 分享页 */
export function renderShareHtml(t, meta) {
  const dataJson = JSON.stringify(t).replace(/</g, '\\u003c');
  const metaJson = JSON.stringify(meta).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>分享的对话：${esc(t.title)}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: #f7f7f8; color: #1a1a1a; }
  .wrap { max-width: 860px; margin: 0 auto; padding: 24px 16px 60px; }
  header { padding: 12px 0 16px; border-bottom: 1px solid #e3e3e3; margin-bottom: 20px; }
  h1 { font-size: 20px; margin: 0 0 6px; }
  .meta { font-size: 12px; color: #777; }
  .live-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #e00; animation: pulse 1.2s infinite; margin-right: 4px; vertical-align: 1px; }
  @keyframes pulse { 50% { opacity: .3; } }
  .msg { margin: 18px 0; }
  .who { font-size: 12px; font-weight: 600; color: #666; margin-bottom: 6px; display: flex; align-items: center; gap: 6px; }
  .who .time { font-weight: 400; color: #999; }
  .dur { color: #999; font-size: 11px; }
  .bubble { padding: 10px 14px; border-radius: 10px; white-space: pre-wrap; word-break: break-word; font-size: 14px; line-height: 1.6; }
  .user .bubble { background: #e8f0fe; border-radius: 10px 10px 10px 2px; }
  .assistant .bubble { background: #fff; border: 1px solid #e8e8e8; border-radius: 10px 10px 2px 10px; }
  .tool { margin: 10px 0; border: 1px solid #e0e0e0; border-radius: 8px; background: #fff; font-size: 13px; overflow: hidden; }
  .tool-head { padding: 8px 12px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .tool-name { font-weight: 600; font-family: ui-monospace, monospace; }
  .tool-status { font-size: 11px; padding: 1px 7px; border-radius: 99px; }
  .tool-status.done { background: #e6f4ea; color: #137333; }
  .tool-status.error { background: #fce8e6; color: #c5221f; }
  .tool-status.denied { background: #fef7e0; color: #b06000; }
  .tool-status.running, .tool-status.awaiting, .tool-status.resolved { background: #e8f0fe; color: #1a56b0; }
  .tool-cmd { font-family: ui-monospace, monospace; font-size: 12px; color: #444; background: #f5f5f5; padding: 6px 10px; border-radius: 6px; overflow-x: auto; white-space: pre; margin: 0 10px 8px; }
  .tool-out { font-family: ui-monospace, monospace; font-size: 12px; padding: 8px 12px; border-top: 1px solid #eee; max-height: 260px; overflow: auto; white-space: pre-wrap; }
  .tool-out.err { color: #c5221f; }
  details.think { border: 1px dashed #d0d0d0; border-radius: 8px; padding: 6px 12px; margin: 8px 0; background: #fafafa; }
  details.think summary { font-size: 12px; color: #888; cursor: pointer; }
  details.think .body { font-size: 13px; white-space: pre-wrap; margin: 8px 0; color: #555; }
  .notice { font-size: 12px; color: #999; margin: 6px 0; }
  .foot { margin-top: 30px; padding-top: 12px; border-top: 1px solid #e3e3e3; font-size: 11px; color: #aaa; text-align: center; }
  .toolbar { display: flex; gap: 8px; margin-top: 6px; flex-wrap: wrap; }
  .toolbar a, .toolbar button { font-size: 12px; padding: 4px 10px; border-radius: 6px; border: 1px solid #ddd; background: #fff; color: #555; text-decoration: none; cursor: pointer; }
  @media (prefers-color-scheme: dark) {
    body { background: #141517; color: #e6e6e6; }
    header { border-color: #2c2c2c; }
    .user .bubble { background: #1d2b45; }
    .assistant .bubble { background: #1c1c1e; border-color: #2c2c2c; }
    .tool { background: #1c1c1e; border-color: #2c2c2c; }
    .tool-cmd { background: #111; color: #bbb; }
    .tool-out { border-color: #2c2c2c; }
    details.think { background: #18181a; border-color: #333; }
    .toolbar a, .toolbar button { background: #222; border-color: #333; color: #aaa; }
  }
</style>
</head>
<body>
<div class="wrap" id="root"></div>
<script>window.__SHARE__ = { data: ${dataJson}, meta: ${metaJson} };</script>
<script>${pageScript()}</script>
</body>
</html>`;
}

/** 错误页（token 无效/过期/吊销/会话不存在） */
export function errorPage(msg) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>分享不可用</title>
<style>body{font-family:system-ui;margin:0;background:#f7f7f8;color:#1a1a1a}.err-page{max-width:520px;margin:80px auto;text-align:center}h1{font-size:18px}a{color:#1a56b0}</style>
</head><body><div class="err-page"><h1>${esc(msg)}</h1><p><a href="/">返回首页</a></p></div></body></html>`;
}
