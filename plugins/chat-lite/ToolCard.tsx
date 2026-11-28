/**
 * 工具调用卡（参考 Polaris ToolCallBlockRenderer / PermissionRequestRenderer 收敛版）。
 *
 * 视觉结构（对齐 Polaris 双卡分工）：
 * - 工具卡：折叠头（左 2px 分类色条 + 字母缩写块 + 工具名 + 命令摘要 + 状态图标 + 耗时）
 *   + 展开体（命令 pre / 输出 pre max-height 滚动 / 退出码）；
 * - 审批卡：warning 色边 + 三按钮（允许一次 / 总是允许该前缀 / 拒绝）；
 *   resolved 后收敛为一行回执（ShieldCheck/ShieldX 语义用文字代替，不引图标库）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { resolveApproval } from './index';
import { copyText } from '../shared/copyText';
import type { ToolCardData, ToolCardMessage } from './store';

/** 分类色（Polaris：execute=purple；lite 不引图标库，用左缘色条 + 字母块） */
const CARD_ACCENT = '#a78bfa';

/**
 * 状态图标：统一 SVG 细线（项目约定：不用 emoji / 符号字符，符号字符在各平台字体里
 * 宽度与基线都不一致，且读屏会念出符号名）。
 * `spin` 类仍挂在外层 span 上，旋转动画对 SVG 同样生效。
 */
function StatusIcon({ status }: { status: ToolCardData['status'] }) {
  const box = { viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true } as const;
  const line = (d: string) => (
    <path d={d} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  );
  switch (status) {
    case 'running':
      return <svg {...box}><path d="M12 3a9 9 0 1 0 9 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>;
    case 'done':
    case 'resolved':
      return <svg {...box}>{line('M5 13l4 4L19 7')}</svg>;
    case 'error':
      return <svg {...box}>{line('M6 6l12 12')}{line('M18 6L6 18')}</svg>;
    case 'denied':
      return (
        <svg {...box}>
          <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.6" />
          {line('M6.5 17.5l11-11')}
        </svg>
      );
    case 'skipped':
      return <svg {...box}>{line('M5 12h14')}</svg>;
    case 'awaiting':
      return <svg {...box}>{line('M9.5 6v12')}{line('M14.5 6v12')}</svg>;
  }
}

/** 审批卡的警示图标（比把感叹号字符塞进文本更可控：可着色、可对齐、读屏不念符号） */
function AlertIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="tc-approval-icon">
      <path d="M12 4.5 21 20H3L12 4.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M12 10v4.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="12" cy="17.1" r="0.9" fill="currentColor" />
    </svg>
  );
}

function statusLabel(data: ToolCardData): string {
  switch (data.status) {
    case 'running': return '执行中';
    case 'done': return '完成';
    case 'error': return `失败${data.exitCode !== undefined && data.exitCode !== 0 ? ` (exit ${data.exitCode})` : ''}`;
    case 'denied': return '已拒绝';
    case 'skipped': return '已跳过';
    case 'awaiting': return '等待审批';
    case 'resolved': return data.decision === 'deny' ? '已拒绝' : '已允许';
  }
}

/**
 * 单行命令摘要（限宽省略）。
 * 旧实现直接 slice(0,64)，会把 `grep -n "cap.tool.fs\|fi...` 断在转义符中间——
 * grep 的 `\|`（BRE 或）对普通用户也是噪音。这里做两件事：
 * 1. 去掉转义反斜杠（`\|` → `|`、`\(` → `(` 等），只保留可读 token；
 * 2. 超长按「完整参数」边界截断，宁可少显示一个 token，也不切在词中间。
 */
function oneLine(s: string | undefined, max = 48): string {
  const raw = (s ?? '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  const clean = raw.replace(/\\([|(){}?+*\[\]])/g, '$1');
  if (clean.length <= max) return clean;
  // 找 max 之前最后一个空格作为截断点，避免半个参数；找不到就硬截（单个超长 token）
  const cut = clean.lastIndexOf(' ', max);
  return `${clean.slice(0, cut > max * 0.5 ? cut : max)}…`;
}

/**
 * 参数 JSON 折叠块（2026-11-21 用户反馈「json格式最好可以折叠展开」）：
 * 默认折叠一行预览，点开看 pretty JSON；bash 的参数就是 {command, timeoutMs}——
 * 命令区已展示，自动跳过避免重复。非法 JSON 降级显示原文，不抛错。
 */
function ArgsBlock({ argsJson }: { argsJson?: string }) {
  const [open, setOpen] = useState(false);
  if (!argsJson) return null;
  let parsed: Record<string, unknown> | null = null;
  try {
    const p = JSON.parse(argsJson) as unknown;
    if (p && typeof p === 'object' && !Array.isArray(p)) parsed = p as Record<string, unknown>;
  } catch { /* 非法 JSON：显示原文 */ }
  if (parsed && parsed.command !== undefined && Object.keys(parsed).every((k) => k === 'command' || k === 'timeoutMs')) return null;
  const pretty = parsed ? JSON.stringify(parsed, null, 2) : argsJson;
  const line = pretty.replace(/\s+/g, ' ').trim();
  const preview = line.length > 72 ? `${line.slice(0, 72)}…` : line;
  return (
    <>
      <button type="button" className="tc-args-toggle" onClick={() => setOpen(!open)} aria-expanded={open} data-testid={`tc-args-${open ? 'open' : 'closed'}`}>
        <span className="tc-section-label">参数</span>
        {!open && <span className="tc-args-preview">{preview}</span>}
        <svg className="tc-chevron" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d={open ? 'M9 6l6 6-6 6' : 'M6 9l6 6 6-6'} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && <pre className="tc-args">{pretty}</pre>}
    </>
  );
}

/** 工具输出复制（P0 消息操作）：输出区标题行的小字按钮，点击后短暂变为「已复制」 */
function OutputCopy({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  if (!text.trim()) return null;
  return (
    <button
      type="button"
      className={`tc-copy${copied ? ' done' : ''}`}
      title="复制输出"
      aria-label="复制输出"
      onClick={async () => {
        setCopied(await copyText(text)); // 失败不标「已复制」
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? '已复制' : '复制'}
    </button>
  );
}

/** 增量 JSON 字符串的字符串值抽取（流式预览用）：
 *  累积中的 argsDelta 形如 `{"html":"<!DOCTYPE html>...` ——按 JSON 转义规则反解析出
 *  html 字段当前已到达的内容。残缺尾部的处理：走不出一个完整 token 就返回已确认段。
 *  反解析器遇到非法转义/未闭合时容错降级（返回当前累积），保证半成品永远可渲染。 */
function extractHtmlFromPartialJson(partial: string): string {
  const key = '"html"';
  const ki = partial.indexOf(key);
  if (ki < 0) return '';
  let i = ki + key.length;
  while (i < partial.length && /\s/.test(partial[i])) i += 1;
  if (partial[i] !== ':') return '';
  i += 1;
  while (i < partial.length && /\s/.test(partial[i])) i += 1;
  if (partial[i] !== '"') return '';
  i += 1;
  let out = '';
  while (i < partial.length) {
    const ch = partial[i];
    if (ch === '"') return out; // 值闭合：完整到达
    if (ch === '\\') {
      const esc = partial[i + 1];
      if (esc === undefined) return out; // 转义符被截断：返回已确认段
      if (esc === 'n') out += '\n';
      else if (esc === 't') out += '\t';
      else if (esc === 'r') out += '\r';
      else if (esc === 'b') out += '\b';
      else if (esc === 'f') out += '\f';
      else if (esc === 'u') {
        const hex = partial.slice(i + 2, i + 6);
        if (hex.length < 4 || !/^[0-9a-fA-F]+$/.test(hex)) return out; // \u 截断
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
        continue;
      } else out += esc; // \" \\ \/ 等
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out; // 值未闭合（仍在生成）：返回半成品，浏览器容错渲染
}

/** bootstrap iframe 骨架（流式预览「实时预览」Tab 用）：
 *  只写一次，之后经 postMessage 收增量；子页累计全文后按完整文档重解析 morph
 *  （见 bootstrapSource）——不能按帧 insertAdjacentHTML 追加：fragment 解析在
 *  帧尾强制闭合未完成标签，跨帧的 <style>/<div> 会被切碎成正文文本，样式全丢。
 *  换 srcDoc = iframe 销毁重建（白屏一帧 + CSS 重初始化），是更早前预览闪烁的主因。
 *  子页回传 {type:'height', h} 供外层做整页可见的自适应量测。
 *  函数源码必须原样内联并立即执行：不能用 JSON.stringify 包一层——那会把
 *  IIFE 变成字符串字面量，监听器永不安装，实时预览整块空白（线上踩坑）。
 *  防御性转义 </script 防函数体意外闭合脚本标签。 */
const STREAM_BOOTSTRAP =
  '<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;font-family:system-ui,sans-serif}</style></head><body></body>' +
  '<script>(' + bootstrapSource.toString().replace(/<\/script/gi, '<\\/script') + ')()<\/script></html>';

/** 必须自包含：函数体只依赖 window/document 等全局——构建产物里经
 *  toString() 注入 srcdoc 子页独立执行，引用闭包/导入变量在子页全是未定义。
 *
 *  渲染策略：子页累计全文，每收到一帧就**同步**按完整文档 morph（合帧在父页做——
 *  沙箱子框架的 setTimeout/rAF 会被浏览器节流，实测 morph 迟到 ~1s 甚至 rAF 整块
 *  不触发，父页定时器无此问题）。delta 按字符位切帧，任何按帧追加（fragment
 *  解析帧尾强制闭合未完成标签）都会把跨帧的 <style>/<div> 切碎漏成正文（实测
 *  样式全丢、源码满屏）；每次把**累计全文**交给 DOMParser 按完整文档解析，
 *  head 有变才替换、body 属性同步后替换 innerHTML——跨帧标签天然正确，
 *  残缺尾部按文档语义容错渐进生效，且全程 0 次 iframe 重载（无 srcDoc 白闪）。 */
function bootstrapSource() {
  let full = '';
  let lastHead = '';
  let lastBody = '';
  let follow = true; // 贴底跟滚：内容长到哪看到哪；用户触摸/滚轮接管后暂停
  let takeOverUntil = 0; // 接管滞回窗口（期间恢复检查不跑，防触摸即贴底的瞬时回弹）
  const morph = () => {
    const doc = new DOMParser().parseFromString(full, 'text/html');
    const headHtml = doc.head.innerHTML;
    if (headHtml !== lastHead) {
      lastHead = headHtml;
      document.head.innerHTML = headHtml;
    }
    const bodyHtml = doc.body.innerHTML;
    if (bodyHtml === lastBody) return; // 同值跳过：重复 morph 的整树重建（图片重建/动画重启）是「偶尔闪」的来源之一
    lastBody = bodyHtml;
    // 生成页 <body class/style=...> 等属性同步
    for (const a of Array.from(document.body.attributes)) {
      if (!doc.body.hasAttribute(a.name)) document.body.removeAttribute(a.name);
    }
    for (const a of Array.from(doc.body.attributes)) {
      document.body.setAttribute(a.name, a.value);
    }
    document.body.innerHTML = bodyHtml;
    const h = document.documentElement.scrollHeight;
    (window.parent as Window).postMessage({ type: 'height', h }, '*');
    // 临时诊断（.tmp-streamfix 调试期，验证后删除）
    const W2 = window as unknown as { __m?: Array<[number, boolean, number, number, number]> };
    W2.__m = W2.__m ?? [];
    W2.__m.push([Date.now() % 100000, follow, window.scrollY, document.documentElement.scrollHeight, window.innerHeight]);
    // 恢复检查放在 morph 里：沙箱 iframe 的 scroll 事件不可靠（实测程序化滚动
    // 不触发），而 morph 在流式期间 ≤200ms 一帧，天然是可靠的检查节拍。
    // takeOverUntil 滞回：触摸瞬间视口往往恰好贴底（gap<40），立即恢复检查会在
    // 下一个 morph 就把跟滚重新打开——接管后给 600ms 让新内容先拉开距离
    if (!follow && Date.now() >= takeOverUntil) {
      const doc = document.documentElement;
      if (doc.scrollHeight - window.innerHeight - window.scrollY < 40) {
        follow = true;
        postFollow(true);
      }
    }
    // 生成期贴底跟滚：直设不用 smooth（180ms 一帧的 morph 节奏下 smooth 动画互相打架）
    if (follow) window.scrollTo(0, document.documentElement.scrollHeight);
  };
  const postFollow = (on: boolean) => {
    (window.parent as Window).postMessage({ type: 'follow', on }, '*');
  };
  // MessageChannel 合帧：chunk 只累计 full，每轮事件循环排空后才 morph 一次。
  // 直接逐帧 morph 会跟不上到达速率——morph 成本随内容增长（实测 ~430ms/帧），
  // 消息队列积压几十秒，触摸暂停/贴底全部被积压的旧 morph 淹没。MessageChannel
  // 任务不受沙箱定时器节流影响（React 调度器同款原语），且天然「排空合并」。
  const channel = new MessageChannel();
  let morphQueued = false;
  channel.port1.onmessage = () => {
    morphQueued = false;
    morph();
  };
  channel.port2.start();
  window.addEventListener('message', (e) => {
    const d = e.data || {};
    if (d.type === 'chunk' && typeof d.html === 'string') {
      full += d.html;
      if (!morphQueued) {
        morphQueued = true;
        channel.port2.postMessage(0);
      }
    } else if (d.type === 'follow-bottom') {
      // 父页胶囊「回到底部」：恢复跟滚并立即贴底
      follow = true;
      window.scrollTo(0, document.documentElement.scrollHeight);
      postFollow(true);
    }
  });
  // 用户接管识别：touchstart/wheel 只会由真人操作触发（程序化 scrollTo 不发这些
  // 事件），不会自己误杀自己。接管后滚回接近底部（与源码流同阈值 40px）自动恢复。
  const takeOver = () => {
    if (follow) {
      follow = false;
      takeOverUntil = Date.now() + 600;
      postFollow(false);
    }
  };
  document.addEventListener('touchstart', takeOver, { passive: true });
  document.addEventListener('wheel', takeOver, { passive: true });
  window.addEventListener('scroll', () => {
    if (follow) return;
    const doc = document.documentElement;
    if (doc.scrollHeight - window.innerHeight - window.scrollY < 40) {
      follow = true;
      postFollow(true);
    }
  }, { passive: true });
  // 就绪握手：监听器装好即回执，父页收到才投递——srcdoc 的 load 事件与子页
  // 脚本就绪之间存在竞态（实测 chunk 会落在窗口初始化空档被丢弃），不能靠时序猜。
  (window.parent as Window).postMessage({ type: 'ready' }, '*');
}

/** 流式预览（render 类大参数工具 running 态）：源码流 + 实时预览双 Tab。
 *  数据源是 argsDelta（tool.args.delta 累积）；无增量（非流式引擎）时不渲染。
 *  - 源码流：贴底自动跟滚（rAF 直设 scrollTop），用户上滚即暂停跟随、
 *    出「回到底部」胶囊，贴底自动恢复——与主聊天区跟滚同一语义；
 *  - 实时预览：持久 iframe（0 重载、无白闪），投递走 ready 握手 +
 *    差量发送，子页累计全文后按完整文档 morph 渲染（见 bootstrapSource）；
 *  - 高度自适应：容器高度跟随内容（上限 FIT_CAP），超出走 iframe 内部滚动——
 *    不做 scale 缩略图：手机上整页塞进 420px 会缩到不可读（17% 实测教训）。 */
const STREAM_FIT_CAP = 420;
const STREAM_STD_H = 200;
const STREAM_SEND_GAP = 180; // 实时预览发送节流（父页合帧间隔）
function StreamPreview({ argsDelta, done }: { argsDelta: string; done?: boolean }) {
  const html = extractHtmlFromPartialJson(argsDelta);
  // 默认直接看实时预览（源码流是给想盯着原始 HTML 的场景的备选 Tab）
  const [tab, setTab] = useState<'code' | 'live'>('live');
  const codeRef = useRef<HTMLPreElement>(null);
  const [follow, setFollow] = useState(true); // 源码流是否贴底跟随
  // live iframe：htmlRef=最新累计 html；sentRef=已送达「当前」iframe 的字符数
  // （iframe 重挂即归零）；loadedRef=子页 bootstrap 是否就绪（onLoad 后才投递）
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const htmlRef = useRef('');
  const sentRef = useRef(0);
  const loadedRef = useRef(false);
  const lastSendRef = useRef(0);
  const sendTimerRef = useRef<number | null>(null);
  const [contentH, setContentH] = useState<number | null>(null); // 子页回报的文档高度
  const [liveFollow, setLiveFollow] = useState(true); // 实时预览贴底跟滚状态（用户接管即暂停，出胶囊）

  // 实时预览投递：持久 iframe + ready 握手 + 差量发送 + 180ms 节流（渲染策略见
  // bootstrapSource——合帧在父页，子页同步 morph 不吃子框架定时器节流）。
  // 节流用「距上次发送 ≥GAP 立即发，否则排一个尾帧定时器」：突发 delta 合并、
  // 尾帧不丢。投递时机只认子页 ready 握手（onLoad 与子页脚本就绪存在竞态）：
  // ready 前到达的内容先攒在 htmlRef，握手后补发全量——切 Tab 重挂 iframe 后
  // （html 未变、[html] effect 不再触发）也靠这条补发，否则整块永远空白。
  const sendDiff = useCallback(() => {
    const frame = frameRef.current;
    if (!frame || !frame.contentWindow || !loadedRef.current) return;
    const now = htmlRef.current;
    if (now.length < sentRef.current) sentRef.current = 0; // 异常缩短：全量重发兜底
    const diff = now.slice(sentRef.current);
    if (!diff) return;
    sentRef.current = now.length;
    lastSendRef.current = Date.now();
    frame.contentWindow.postMessage({ type: 'chunk', html: diff }, '*');
  }, []);

  const flush = useCallback(() => {
    const frame = frameRef.current;
    if (!frame || !frame.contentWindow || !loadedRef.current) return;
    const elapsed = Date.now() - lastSendRef.current;
    if (elapsed >= STREAM_SEND_GAP) {
      if (sendTimerRef.current !== null) { clearTimeout(sendTimerRef.current); sendTimerRef.current = null; }
      sendDiff();
    } else if (sendTimerRef.current === null) {
      sendTimerRef.current = window.setTimeout(() => {
        sendTimerRef.current = null;
        sendDiff();
      }, STREAM_SEND_GAP - elapsed) as unknown as number;
    }
  }, [sendDiff]);

  // 只在元素真正（重）挂载时归零进度——ref 回调每次渲染都会以 null/el 成对触发，
  // 用 frameRef.current !== el 区分真实挂载，防止渲染期误清已投递进度。
  // 卸载时清掉待发的尾帧定时器（新 iframe 由 ready 握手重新武装）。
  const attachFrame = useCallback((el: HTMLIFrameElement | null) => {
    if (el && frameRef.current !== el) { sentRef.current = 0; loadedRef.current = false; }
    if (!el && sendTimerRef.current !== null) { clearTimeout(sendTimerRef.current); sendTimerRef.current = null; }
    frameRef.current = el;
  }, []);

  useEffect(() => {
    htmlRef.current = html;
    flush();
  }, [html, flush]);

  // 高度回传（容器自适应量测）+ 子页就绪握手 + 跟滚状态：只认当前 iframe 发来
  // 的消息，多张 render 卡同时流式时互不串扰。ready 到达即视为可投递并补发积压。
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; h?: number; on?: boolean } | null;
      if (!d) return;
      if (d.type === 'ready' && e.source === frameRef.current?.contentWindow) {
        loadedRef.current = true;
        flush();
        return;
      }
      if (e.source !== frameRef.current?.contentWindow) return;
      if (d.type === 'follow' && typeof d.on === 'boolean') {
        setLiveFollow(d.on); // 用户在子页触摸/滚轮接管 → 暂停跟滚并出胶囊；滚回底部自动恢复
        return;
      }
      if (d.type !== 'height' || typeof d.h !== 'number') return;
      setContentH(d.h);
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [flush]);

  // 源码流贴底跟随
  useEffect(() => {
    const el = codeRef.current;
    if (!el || !follow) return;
    requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
  }, [html, follow]);

  if (!html.trim()) return null;
  const lines = html.split('\n').length;
  const kb = (new Blob([html]).size / 1024).toFixed(1);
  const boxH = contentH ? Math.min(contentH, STREAM_FIT_CAP) : STREAM_STD_H;
  return (
    <div className="tc-stream">
      <div className="tc-stream-tabs">
        <button type="button" className={tab === 'code' ? 'on' : ''} onClick={() => setTab('code')}>源码流</button>
        <button type="button" className={tab === 'live' ? 'on' : ''} onClick={() => setTab('live')}>实时预览</button>
        <span className="tc-stream-stats">{lines} 行 · {kb} KB</span>
      </div>
      {tab === 'code' ? (
        <div className="tc-stream-codewrap">
          <pre
            className="tc-stream-code"
            aria-label="生成中的 HTML 源码"
            ref={codeRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
              if (atBottom !== follow) setFollow(atBottom);
            }}
          >{html}</pre>
          {!follow && (
            <button type="button" className="tc-stream-pill" onClick={() => setFollow(true)}>有更新 ↓ 回到底部</button>
          )}
        </div>
      ) : (
        <div className={`tc-stream-stage ${done ? 'settled' : ''}`} style={{ height: boxH }}>
          {/* 自然尺寸渲染（100%×100%）：页面按舞台宽度（≈手机内容宽）排版，可读性
              与最终呈现一致；内容超高走 iframe 内部滚动，不缩放 */}
          <iframe
            title="实时预览（生成中）"
            className="tc-stream-frame"
            sandbox="allow-scripts allow-forms allow-pointer-lock"
            referrerPolicy="no-referrer"
            srcDoc={STREAM_BOOTSTRAP}
            ref={attachFrame}
          />
          {/* 跟滚暂停（用户在子页触摸/滚轮接管）时出胶囊，点击回发 follow-bottom */}
          {!liveFollow && (
            <button
              type="button"
              className="tc-stream-pill"
              onClick={() => frameRef.current?.contentWindow?.postMessage({ type: 'follow-bottom' }, '*')}
            >
              有更新 ↓ 回到底部
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function ToolCard({ msg }: { msg: ToolCardMessage }) {
  const [open, setOpen] = useState(false);
  const tool = msg.tool;
  const isApproval = tool.status === 'awaiting';
  const hasBody = !isApproval && !!(tool.command || tool.argsJson || tool.stdout || tool.stderr || tool.exitCode !== undefined);
  const spin = tool.status === 'running';
  // 判空下沉到「能否解析出 html」：外层旧口径（running && argsDelta 非空）会让
  // bash/files 等所有收到 argsDelta 的工具都冒出一条空的 tc-stream-wrap（十几像素
  // 空白条，跑完消失）——视觉即「单卡展开一点再折叠」。解析不出 html 整块不渲染。
  const streamHtml = spin ? extractHtmlFromPartialJson(tool.argsDelta ?? '') : '';
  const streaming = spin && streamHtml.trim().length > 0;

  // 审批卡：独立视觉（warning 色边 + 按钮组）；决策直接回填 cap.agent.loop。
  // 卡片内嵌于 assistant 气泡（blocks 模式），左侧已有 AI 头像——不再重复放字母块。
  if (isApproval) {
    return (
      <div className="tc-approval" data-call-id={tool.callId} data-testid={`tc-approval-${tool.callId}`}>
      <div className="tc-approval-head"><AlertIcon />工具请求执行（{tool.name}）</div>
      <pre className="tc-cmd">{tool.command}</pre>
      <ArgsBlock argsJson={tool.argsJson} />
        <div className="tc-approval-btns">
          <button className="tc-btn primary" onClick={() => resolveApproval(tool.callId, 'once')}>允许一次</button>
          <button className="tc-btn" onClick={() => resolveApproval(tool.callId, 'always')}>总是允许该前缀</button>
          <button className="tc-btn" onClick={() => resolveApproval(tool.callId, 'trust')}>本会话信任</button>
          <button className="tc-btn danger" onClick={() => resolveApproval(tool.callId, 'deny')}>拒绝</button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`tc-card ${tool.status === 'error' || tool.status === 'denied' ? 'tc-fail' : ''} ${open ? 'tc-open' : ''}`}
      data-call-id={tool.callId}
      data-testid={`tc-${tool.callId}`}
      style={{ borderLeftColor: CARD_ACCENT }}
    >
        <button className="tc-head" onClick={() => hasBody && setOpen(!open)} disabled={!hasBody}>
          <span className={`tc-status ${spin ? 'spin' : ''}`} aria-hidden="true"><StatusIcon status={tool.status} /></span>
          <span className="tc-name">{tool.name}</span>
          <span className="tc-summary">{oneLine(tool.command) || statusLabel(tool)}</span>
          {tool.durationMs !== undefined && tool.durationMs > 1000 && (
            <span className="tc-duration">{(tool.durationMs / 1000).toFixed(1)}s</span>
          )}
          <span className={`tc-state ${tool.status === 'done' ? 'ok' : tool.status === 'running' || tool.status === 'skipped' ? '' : 'fail'}`}>
            {statusLabel(tool)}
          </span>
          {hasBody && <span className="tc-chevron">{open ? '˄' : '˅'}</span>}
        </button>
        {streaming && (
          <div className="tc-stream-wrap">
            <StreamPreview argsDelta={tool.argsDelta ?? ''} done={!spin} />
          </div>
        )}
        {open && (
          <div className="tc-body">
            {tool.command && (
              <>
                <div className="tc-section-label">命令</div>
                <pre className="tc-cmd">{tool.command}</pre>
              </>
            )}
            <ArgsBlock argsJson={tool.argsJson} />
            {(tool.stdout || tool.stderr) && (
              <>
                <div className="tc-section-head">
                  <div className="tc-section-label">输出</div>
                  <OutputCopy text={`${tool.stdout ?? ''}${tool.stderr ? `${tool.stdout ? '\n' : ''}[stderr]\n${tool.stderr}` : ''}`} />
                </div>
                <pre className={`tc-output ${tool.stderr && !tool.stdout ? 'tc-stderr' : ''}`}>
                  {tool.stdout}
                  {tool.stderr ? `\n[stderr]\n${tool.stderr}` : ''}
                </pre>
              </>
            )}
            {/* 退出码 0 是成功默认值，属于噪音；仅在非 0（失败）时显示，输出截断提示同样只在有意义时出现 */}
            {tool.exitCode !== undefined && tool.exitCode !== 0 && (
              <div className="tc-exit fail">退出码 {tool.exitCode}</div>
            )}
            {tool.truncated && <div className="tc-exit">输出已截断</div>}
          </div>
        )}
    </div>
  );
}
