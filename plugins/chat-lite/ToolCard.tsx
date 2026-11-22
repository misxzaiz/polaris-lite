/**
 * 工具调用卡（参考 Polaris ToolCallBlockRenderer / PermissionRequestRenderer 收敛版）。
 *
 * 视觉结构（对齐 Polaris 双卡分工）：
 * - 工具卡：折叠头（左 2px 分类色条 + 字母缩写块 + 工具名 + 命令摘要 + 状态图标 + 耗时）
 *   + 展开体（命令 pre / 输出 pre max-height 滚动 / 退出码）；
 * - 审批卡：warning 色边 + 三按钮（允许一次 / 总是允许该前缀 / 拒绝）；
 *   resolved 后收敛为一行回执（ShieldCheck/ShieldX 语义用文字代替，不引图标库）。
 */
import { useState } from 'react';
import { resolveApproval } from './index';
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
        try { await navigator.clipboard.writeText(text); } catch { /* 剪贴板受限：静默 */ }
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? '已复制' : '复制'}
    </button>
  );
}

export function ToolCard({ msg }: { msg: ToolCardMessage }) {
  const [open, setOpen] = useState(false);
  const tool = msg.tool;
  const isApproval = tool.status === 'awaiting';
  const hasBody = !isApproval && !!(tool.command || tool.argsJson || tool.stdout || tool.stderr || tool.exitCode !== undefined);
  const spin = tool.status === 'running';

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
          <span className={`tc-state ${tool.status === 'done' ? 'ok' : tool.status === 'running' ? '' : 'fail'}`}>
            {statusLabel(tool)}
          </span>
          {hasBody && <span className="tc-chevron">{open ? '˄' : '˅'}</span>}
        </button>
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
