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

/** 工具卡一行式（个人阅读版）：名称/命令摘要/状态/耗时 */
function toolOneLine(c) {
  const parts = [`[工具] ${c.name}`];
  if (c.command) parts.push(`\`${String(c.command).replace(/\n+/g, ' ').slice(0, 60)}\``);
  parts.push(stIcon(c.status));
  if (c.durationMs !== undefined) parts.push(`${c.durationMs}ms`);
  if (c.exitCode !== undefined && c.exitCode !== 0) parts.push(`exit=${c.exitCode}`);
  return `  ${parts.join(' ')}`;
}

/** 交互卡一行式（个人阅读版）：问题 + 作答摘要 */
function interactiveOneLine(b) {
  const ans = b.answer !== undefined ? capOne(JSON.stringify(b.answer), 80) : '（未作答）';
  return `  [${b.kind}] ${b.title} → ${ans}`;
}

function capOne(s, n) {
  return String(s).length > n ? `${String(s).slice(0, n)}…` : String(s);
}

function kFmt(n) {
  if (!Number.isFinite(n) || n <= 0) return '0';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** 从转录派生统计（免费指标：tokens 汇总/缓存命中/重试/压缩/审批决策分布） */
export function deriveStats(t) {
  const calls = Array.isArray(t.apiCalls) ? t.apiCalls : [];
  const events = Array.isArray(t.events) ? t.events : [];
  const turns = Array.isArray(t.turns) ? t.turns : [];
  let promptTokens = 0;
  let completionTokens = 0;
  let cachedTokens = 0;
  let hasCacheData = false;
  let totalApiMs = 0;
  let failed = 0;
  for (const c of calls) {
    totalApiMs += c.durMs || 0;
    if (c.status === 0 || (c.status >= 400 && c.status < 600)) failed += 1;
    const u = c.sse?.usage;
    if (u && typeof u === 'object') {
      const p = Number(u.prompt_tokens ?? u.input_tokens ?? 0);
      const cmp = Number(u.completion_tokens ?? u.output_tokens ?? 0);
      promptTokens += p;
      completionTokens += cmp;
      const cached = Number(u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? u.cached_tokens ?? 0);
      if (u.prompt_tokens_details?.cached_tokens !== undefined || u.prompt_cache_hit_tokens !== undefined || u.cached_tokens !== undefined) {
        hasCacheData = true;
        cachedTokens += cached;
      }
    }
  }
  const approvals = { once: 0, always: 0, trust: 0, deny: 0, autoRejected: 0 };
  let retries = 0;
  let compactions = 0;
  let toolCallEvents = 0;
  for (const e of events) {
    if (e.kind === 'stream.retry') retries += 1;
    else if (e.kind === 'context.compacted') compactions += 1;
    else if (e.kind === 'tool.calls') toolCallEvents += 1;
    else if (e.kind === 'tool.approval.resolved' && e.payload && typeof e.payload === 'object') {
      const d = String(e.payload.decision ?? '');
      if (d in approvals) approvals[d] += 1;
      if (e.payload.autoRejected === true) approvals.autoRejected += 1;
    }
  }
  let toolBlocks = 0;
  for (const m of t.messages ?? []) {
    if (Array.isArray(m.blocks)) for (const b of m.blocks) if (b.type === 'tool') toolBlocks += 1;
    if (m.role === 'tool') toolBlocks += 1;
  }
  return {
    messages: (t.messages ?? []).length,
    turns: turns.length,
    apiCalls: calls.length,
    toolCalls: toolBlocks,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    cacheHitRate: hasCacheData && promptTokens > 0 ? Number((cachedTokens / promptTokens).toFixed(3)) : null,
    totalApiMs,
    failedCalls: failed,
    retries,
    compactions,
    toolCallEvents,
    approvals,
  };
}

/** AI 分析版（结构化 + 分析任务书 + 派生指标）：schema plite-transcript-ai-v1 */
export function buildAiAnalysis(t) {
  return {
    schema: 'plite-transcript-ai-v1',
    generatedAt: new Date().toISOString(),
    analysisGuide: {
      goal: '复盘本对话的引擎行为：定位工具选择/参数错误/循环重试/上下文管理/成本延迟问题，产出可执行的引擎优化建议',
      checklist: [
        '工具选择与参数是否合理：对照 events 里 tool.calls 的完整 arguments 与工具卡结果（stdout/stderr/exitCode）',
        '是否存在循环重试或同参数重复调用：stream.retry 事件、apiCalls 里相似 reqBody 的连续请求',
        '上下文管理：context.compacted 的 summary 是否丢失关键信息、压缩前后 tokens 变化、压缩后行为是否退化',
        '成本与延迟异常：apiCalls 的 usage 递增链、cacheHitRate、慢跳（durMs 离群）、finishReason 分布',
        '失败与中断根因：sse.errors 帧、resHeaders 限流头（429/retry-after）、status=0 网络失败、审批 deny',
        '交互卡行为：interactive 块的 payload 与 answer，是否重复追问/超时',
      ],
      knownLimits: [
        'reqBody 上限 256KB（超长截断）',
        '工具卡 stdout/stderr 上限 16KB（引擎落库即截断）',
        '轨迹由发起对话的浏览器采集：其它设备发起的轮次可能缺 apiCalls/events',
        'events 过滤了 message.delta/message.reasoning 高频噪声（正文已在 messages 里）',
      ],
    },
    meta: {
      sessionId: t.sessionId,
      title: t.title,
      createdAt: t.createdAt,
      lastActiveAt: t.lastActiveAt,
      version: t.version,
      capturedAt: t.capturedAt,
    },
    stats: deriveStats(t),
    messages: t.messages ?? [],
    apiCalls: t.apiCalls ?? [],
    events: t.events ?? [],
    turns: t.turns ?? [],
  };
}

/** 个人阅读版 Markdown（做减法：叙事流 + 一行式工具 + API 一览表；无 JSON/帧） */
export function renderHumanMarkdown(t) {
  const lines = [];
  const st = deriveStats(t);
  lines.push(`# ${t.title}`);
  lines.push('');
  const headParts = [
    `${st.messages} 条消息`,
    st.turns ? `${st.turns} 轮` : '',
    st.toolCalls ? `${st.toolCalls} 次工具` : '',
    st.totalTokens ? `${kFmt(st.totalTokens)} tokens` : '',
    st.compactions ? `${st.compactions} 次上下文压缩` : '',
    `转录于 ${fmtTime(t.capturedAt)}`,
  ].filter(Boolean);
  lines.push(`> ${headParts.join(' · ')} · 内容已脱敏`);
  lines.push('');

  lines.push('## 对话');
  lines.push('');
  for (const m of t.messages ?? []) {
    if (m.role === 'user') {
      lines.push(`**用户** · ${fmtTime(m.createdAt)}`, '', m.content || '（空）', '');
    } else if (m.role === 'assistant') {
      lines.push(`**AI** · ${fmtTime(m.createdAt)}`, '');
      if (m.blocks) {
        for (const b of m.blocks) {
          if (b.type === 'tool') lines.push(toolOneLine(b.tool));
          else if (b.type === 'interactive') lines.push(interactiveOneLine(b));
          else if (b.type === 'artifact') lines.push(`  [产物] ${b.title}（${b.rendererType}）`);
          else if (b.type === 'thinking') lines.push(`  （思考 ${b.text.length} 字，已省略）`);
          else if (b.type === 'text') lines.push('', b.text, '');
          else lines.push(`  （${b.text}）`); // notice / truncated
        }
        lines.push('');
      } else {
        lines.push('', m.content || '（空）', '');
      }
    } else if (m.role === 'tool' && m.tool) {
      lines.push(toolOneLine(m.tool), '');
    }
  }

  const calls = Array.isArray(t.apiCalls) ? t.apiCalls : [];
  if (calls.length > 0) {
    lines.push('---', '', '## 模型调用一览', '');
    lines.push('| # | 时间 | 模型 | 耗时 | tokens | 结果 |');
    lines.push('|---|---|---|---|---|---|');
    calls.forEach((c, i) => {
      const u = c.sse?.usage;
      const tok = u && typeof u === 'object'
        ? `${kFmt(Number(u.prompt_tokens ?? u.input_tokens ?? 0))}→${kFmt(Number(u.completion_tokens ?? u.output_tokens ?? 0))}`
        : '-';
      const result = c.status === 0 ? '网络失败' : (c.sse?.finishReason ?? `HTTP ${c.status}`);
      const flag = c.error || c.status !== 200 ? ' [异常]' : '';
      lines.push(`| ${i + 1} | ${fmtTime(c.at)} | ${c.model ?? c.providerId ?? '-'} | ${c.durMs}ms | ${tok} | ${result}${flag} |`);
    });
    lines.push('');
  }

  if (st.retries > 0 || st.compactions > 0 || st.failedCalls > 0) {
    const notes = [];
    if (st.failedCalls > 0) notes.push(`${st.failedCalls} 次请求失败`);
    if (st.retries > 0) notes.push(`${st.retries} 次流重试`);
    if (st.compactions > 0) notes.push(`${st.compactions} 次上下文压缩（详情见网页版 AI 轨迹）`);
    lines.push(`> 注意：${notes.join('；')}`, '');
  }
  lines.push('---', '', '> transcript-share · 个人阅读版 · 完整 API 轨迹与编排事件见网页版或 AI 分析版');
  return maskByPattern(lines.join('\n'));
}

/** 个人版 HTML 预览（服务端直渲染，无 JS）：点开即见排版效果，而非 .md 原文。
 *  工具栏提供「下载 .md / AI 分析版」——下载意图与预览意图分离。 */
export function renderHumanHtml(t) {
  const sid = encodeURIComponent(t.sessionId);
  const st = deriveStats(t);
  const headParts = [
    `${st.messages} 条消息`,
    st.turns ? `${st.turns} 轮` : '',
    st.toolCalls ? `${st.toolCalls} 次工具` : '',
    st.totalTokens ? `${kFmt(st.totalTokens)} tokens` : '',
    st.compactions ? `${st.compactions} 次上下文压缩` : '',
  ].filter(Boolean);

  const msgHtml = (t.messages ?? []).map((m) => {
    const who = m.role === 'user' ? '用户' : m.role === 'assistant' ? 'AI' : `[工具] ${m.tool?.name ?? m.role}`;
    let body = '';
    if (m.blocks) {
      for (const b of m.blocks) {
        if (b.type === 'tool') {
          const c = b.tool;
          body += `<div class="t1l">[工具] ${esc(c.name)}${c.command ? ` <code>${esc(String(c.command).replace(/\n+/g, ' ').slice(0, 60))}</code>` : ''} ${esc(stIcon(c.status))}${c.durationMs !== undefined ? ` ${c.durationMs}ms` : ''}${c.exitCode !== undefined && c.exitCode !== 0 ? ` exit=${c.exitCode}` : ''}</div>`;
        } else if (b.type === 'interactive') {
          body += `<div class="t1l">[${esc(b.kind)}] ${esc(b.title)} → ${esc(b.answer !== undefined ? capOne(JSON.stringify(b.answer), 80) : '（未作答）')}</div>`;
        } else if (b.type === 'artifact') {
          body += `<div class="t1l">[产物] ${esc(b.title)}（${esc(b.rendererType)}）</div>`;
        } else if (b.type === 'thinking') {
          body += `<div class="t1l dim">（思考 ${b.text.length} 字，已省略）</div>`;
        } else if (b.type === 'text') {
          body += `<div class="bubble">${esc(b.text)}</div>`;
        } else {
          body += `<div class="t1l dim">（${esc(b.text)}）</div>`;
        }
      }
    } else if (m.tool) {
      const c = m.tool;
      body += `<div class="t1l">[工具] ${esc(c.name)}${c.command ? ` <code>${esc(c.command)}</code>` : ''} ${esc(stIcon(c.status))}</div>`;
    } else {
      body += `<div class="bubble">${esc(m.content || '（空）')}</div>`;
    }
    return `<div class="msg ${esc(m.role)}"><div class="who">${who}<span class="time">${fmtTime(m.createdAt)}</span></div>${body}</div>`;
  }).join('');

  const callRows = (t.apiCalls ?? []).map((c, i) => {
    const u = c.sse?.usage;
    const tok = u && typeof u === 'object'
      ? `${kFmt(Number(u.prompt_tokens ?? u.input_tokens ?? 0))}→${kFmt(Number(u.completion_tokens ?? u.output_tokens ?? 0))}`
      : '-';
    const result = c.status === 0 ? '网络失败' : (c.sse?.finishReason ?? `HTTP ${c.status}`);
    const flag = c.error || c.status !== 200 ? ' <b class="bad">[异常]</b>' : '';
    return `<tr><td>${i + 1}</td><td>${fmtTime(c.at)}</td><td>${esc(c.model ?? c.providerId ?? '-')}</td><td>${c.durMs}ms</td><td>${tok}</td><td>${esc(result)}${flag}</td></tr>`;
  }).join('');
  const apiTable = callRows
    ? `<h2>模型调用一览</h2><table class="apitbl"><tr><th>#</th><th>时间</th><th>模型</th><th>耗时</th><th>tokens</th><th>结果</th></tr>${callRows}</table>`
    : '';
  const warnParts = [];
  if (st.failedCalls > 0) warnParts.push(`${st.failedCalls} 次请求失败`);
  if (st.retries > 0) warnParts.push(`${st.retries} 次流重试`);
  if (st.compactions > 0) warnParts.push(`${st.compactions} 次上下文压缩`);
  const warnHtml = warnParts.length ? `<div class="warn">注意：${esc(warnParts.join('；'))}</div>` : '';

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>个人版预览：${esc(t.title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: #f7f7f8; color: #1a1a1a; }
  .wrap { max-width: 780px; margin: 0 auto; padding: 24px 16px 60px; }
  header { border-bottom: 1px solid #e3e3e3; padding: 12px 0 14px; margin-bottom: 16px; }
  h1 { font-size: 19px; margin: 0 0 6px; }
  .meta { font-size: 12px; color: #777; }
  .toolbar { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
  .toolbar a { font-size: 12px; padding: 4px 10px; border-radius: 6px; border: 1px solid #ddd; background: #fff; color: #555; text-decoration: none; }
  .msg { margin: 16px 0; }
  .who { font-size: 12px; font-weight: 600; color: #666; margin-bottom: 6px; display: flex; gap: 6px; }
  .who .time { font-weight: 400; color: #999; }
  .bubble { padding: 10px 14px; border-radius: 10px; white-space: pre-wrap; word-break: break-word; font-size: 14px; line-height: 1.6; }
  .user .bubble { background: #e8f0fe; border-radius: 10px 10px 10px 2px; }
  .assistant .bubble { background: #fff; border: 1px solid #e8e8e8; border-radius: 10px 10px 2px 10px; }
  .t1l { font-size: 12.5px; color: #555; margin: 6px 0 6px 4px; }
  .t1l code { font-family: ui-monospace, monospace; background: #f0f0f0; padding: 1px 5px; border-radius: 4px; font-size: 11.5px; }
  .t1l.dim { color: #999; }
  h2 { font-size: 15px; margin: 26px 0 8px; }
  .apitbl { width: 100%; border-collapse: collapse; font-size: 12px; }
  .apitbl th, .apitbl td { border: 1px solid #e3e3e3; padding: 5px 8px; text-align: left; }
  .apitbl th { background: #f2f2f4; }
  .warn { margin-top: 10px; font-size: 12px; color: #b06000; background: #fef7e0; border-radius: 8px; padding: 8px 12px; }
  .bad { color: #c5221f; }
  .foot { margin-top: 30px; padding-top: 12px; border-top: 1px solid #e3e3e3; font-size: 11px; color: #aaa; text-align: center; }
  @media (prefers-color-scheme: dark) {
    body { background: #141517; color: #e6e6e6; }
    header { border-color: #2c2c2c; }
    .user .bubble { background: #1d2b45; }
    .assistant .bubble { background: #1c1c1e; border-color: #2c2c2c; }
    .t1l code { background: #111; }
    .apitbl th, .apitbl td { border-color: #2c2c2c; }
    .apitbl th { background: #1a1a1c; }
    .warn { background: #2a2312; color: #d8a348; }
    .toolbar a { background: #222; border-color: #333; color: #aaa; }
  }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>${esc(t.title)}</h1>
    <div class="meta">${esc(headParts.join(' · '))} · 转录于 ${fmtTime(t.capturedAt)} · 内容已脱敏</div>
    <div class="toolbar">
      <a href="/api/share/export?sessionId=${sid}&format=human">下载 .md</a>
      <a href="/api/share/export?sessionId=${sid}&format=ai">下载 AI 分析版</a>
      <a href="/api/share/export?sessionId=${sid}&format=html">网页完整版预览</a>
    </div>
  </header>
  <h2>对话</h2>
  ${msgHtml}
  ${apiTable}
  ${warnHtml}
  <div class="foot">transcript-share · 个人阅读版预览 · 完整 API 轨迹与编排事件见网页完整版</div>
</div>
</body>
</html>`;
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
  function renderApiCall(call, idx) {
    var u = call.sse && call.sse.usage;
    var tok = u && typeof u === 'object'
      ? ' · tokens ' + String(u.prompt_tokens != null ? u.prompt_tokens : (u.input_tokens != null ? u.input_tokens : '?'))
        + '→' + String(u.completion_tokens != null ? u.completion_tokens : (u.output_tokens != null ? u.output_tokens : '?'))
      : '';
    var status = call.status ? 'HTTP ' + call.status : '网络失败';
    var head = '<div class="apicall"><div class="tool-head"><span class="tool-name">API #' + (idx + 1) + '</span>' +
      '<span class="tool-status ' + (call.status >= 200 && call.status < 300 ? 'done' : 'error') + '">' + status + '</span>' +
      '<span class="dur">' + (call.durMs || 0) + 'ms</span>' +
      '<span class="api-model">' + esc(call.model || call.providerId || '') + '</span>' +
      (call.sse && call.sse.finishReason ? '<span class="dur">finish=' + esc(call.sse.finishReason) + '</span>' : '') +
      (tok ? '<span class="dur">' + tok + '</span>' : '') + '</div>';
    var body = '';
    if (call.error) body += '<div class="tool-out err">' + esc(call.error) + '</div>';
    if (call.sse) {
      body += '<div class="tool-out">SSE ' + call.sse.frames + ' 帧 · 文本 ' + call.sse.textLen + ' 字' +
        (call.sse.toolCalls && call.sse.toolCalls.length ? ' · 模型请求工具 ' + call.sse.toolCalls.length + ' 个' : '') + '</div>';
      for (var i = 0; i < (call.sse.toolCalls || []).length; i++) {
        var tc = call.sse.toolCalls[i];
        body += '<div class="tool-out"><b>' + esc(tc.name) + '</b>(' + esc(tc.args) + ')</div>';
      }
    }
    if (call.reqBody) body += '<details class="think"><summary>请求体（messages/tools）</summary><div class="body">' + esc(call.reqBody) + '</div></details>';
    if (call.sse && call.sse.first && call.sse.first.length) {
      body += '<details class="think"><summary>SSE 首帧样本</summary><div class="body">' + esc(call.sse.first.join('\\n')) + '</div></details>';
    }
    return head + body + '</div>';
  }
  function renderApiCalls(calls) {
    if (!calls || !calls.length) return '';
    var html = '<div class="api-section"><div class="section-title">API 调用轨迹 · ' + calls.length + ' 次模型请求</div>';
    for (var i = 0; i < calls.length; i++) html += renderApiCall(calls[i], i);
    return html + '</div>';
  }
  function renderMsg(m) {
    var who = m.role === 'user' ? '用户' : m.role === 'assistant' ? 'AI' : '[工具] ' + (m.tool ? m.tool.name : m.role);
    var html = '<div class="msg ' + esc(m.role) + '"><div class="who">' + who + '<span class="time">' + fmtTime(m.createdAt) + '</span></div>';
    if (m.blocks) {
      m.blocks.forEach(function (b) {
        if (b.type === 'tool') html += renderTool(b.tool);
        else if (b.type === 'thinking') html += '<details class="think"><summary>思考</summary><div class="body">' + esc(b.text) + '</div></details>';
        else if (b.type === 'interactive') {
          var ansText = b.answer !== undefined ? esc(JSON.stringify(b.answer).slice(0, 200)) : '';
          html += '<div class="tool"><div class="tool-head"><span class="tool-name">[' + esc(b.kind) + '] ' + esc(b.title) + '</span>' + (b.answer !== undefined ? '<span class="tool-status done">已作答</span>' : '<span class="tool-status awaiting">待作答</span>') + '</div>' +
            (b.payload ? '<details class="think"><summary>问题内容</summary><div class="body">' + esc(JSON.stringify(b.payload, null, 1)) + '</div></details>' : '') +
            (ansText ? '<div class="tool-out">作答：' + ansText + '</div>' : '') + '</div>';
        }
        else if (b.type === 'artifact' && b.rendererType === 'image' && b.data && b.data.url) {
          html += '<div class="tool"><div class="tool-head"><span class="tool-name">[图片] ' + esc(b.title) + '</span></div>' +
            '<div style="padding:8px 12px"><img src="' + esc(String(b.data.url)) + '" alt="' + esc(b.title) + '" style="max-width:100%;max-height:420px;border-radius:8px;" loading="lazy" /></div></div>';
        }
        else if (b.type === 'artifact') {
          var dataKeys = b.data ? Object.keys(b.data).map(function (k) { return k + '=' + esc(String(b.data[k]).slice(0, 60)); }).join(' · ') : '';
          html += '<div class="tool"><div class="tool-head"><span class="tool-name">[产物] ' + esc(b.title) + '</span><span class="tool-status ' + (b.status === 'ready' ? 'done' : 'error') + '">' + esc(b.rendererType) + '</span></div>' + (dataKeys ? '<div class="tool-out">' + dataKeys + '</div>' : '') + '</div>';
        }
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
    var apiCount = d.apiCalls ? d.apiCalls.length : 0;
    // 子路径必须基于 location.pathname 拼绝对路径：页面 URL 是 /share/<token>（无尾斜杠），
    // 相对 ./json 会被浏览器解析到 /share/json → 404（实测踩坑）。
    // 不用 replace(/\/+$/,) 正则——模板字符串会吃掉 \/ 转义产出 // 注释掉整行
    var base = location.pathname;
    if (base.charAt(base.length - 1) === '/') base = base.slice(0, -1);
    return '<header><h1>' + esc(d.title) + '</h1><div class="meta">' + d.messages.length +
      ' 条消息 · ' + apiCount + ' 次模型 API 调用 · 转录于 ' + fmtTime(d.capturedAt) + live +
      '</div><div class="toolbar"><a href="' + base + '/markdown">个人版 MD</a><a href="' + base + '/ai">AI 分析版</a><a href="' + base + '/json">JSON</a><button id="refresh-btn">刷新</button></div></header>';
  }
  function rerender(d) {
    root.innerHTML = headHtml(d) + renderApiCalls(d.apiCalls) + d.messages.map(renderMsg).join('') +
      '<div class="foot">transcript-share · 只读分享 · 内容已脱敏</div>';
  }
  rerender(DATA);

  if (META.live) {
    var lastCount = DATA.messages.length;
    var lastVersion = DATA.version;
    var lastApiCount = DATA.apiCalls ? DATA.apiCalls.length : 0;
    var timer = setInterval(function () {
      fetch(location.pathname + '/json', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
          if (!j) return;
          var jc = j.apiCalls ? j.apiCalls.length : 0;
          if (j.messages.length !== lastCount || j.version !== lastVersion || jc !== lastApiCount) {
            lastCount = j.messages.length;
            lastVersion = j.version;
            lastApiCount = jc;
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
  .api-section { margin: 4px 0 18px; }
  .section-title { font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #888; margin: 10px 0 6px; }
  .apicall { margin: 8px 0; border: 1px solid #d8d0e8; border-radius: 8px; background: #fbfaff; font-size: 13px; overflow: hidden; }
  .api-model { font-family: ui-monospace, monospace; font-size: 11px; color: #6b4fa0; }
  .tool-out b { color: #1a56b0; }
  .foot { margin-top: 30px; padding-top: 12px; border-top: 1px solid #e3e3e3; font-size: 11px; color: #aaa; text-align: center; }
  .toolbar { display: flex; gap: 8px; margin-top: 6px; flex-wrap: wrap; }
  .toolbar a, .toolbar button { font-size: 12px; padding: 4px 10px; border-radius: 6px; border: 1px solid #ddd; background: #fff; color: #555; text-decoration: none; cursor: pointer; }
  @media (prefers-color-scheme: dark) {
    body { background: #141517; color: #e6e6e6; }
    header { border-color: #2c2c2c; }
    .apicall { background: #1a181e; border-color: #36304a; }
    .api-model { color: #a88fd4; }
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
