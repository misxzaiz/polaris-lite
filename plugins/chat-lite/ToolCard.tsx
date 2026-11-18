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

function statusIcon(status: ToolCardData['status']): string {
  switch (status) {
    case 'running': return '◐';
    case 'done': return '✓';
    case 'error': return '✕';
    case 'denied': return '⊘';
    case 'awaiting': return '⏸';
    case 'resolved': return '✓';
  }
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

/** 单行命令摘要（去换行，限宽省略） */
function oneLine(s: string | undefined, max = 64): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export function ToolCard({ msg }: { msg: ToolCardMessage }) {
  const [open, setOpen] = useState(false);
  const tool = msg.tool;
  const isApproval = tool.status === 'awaiting';
  const hasBody = !isApproval && (tool.command || tool.stdout || tool.stderr || tool.exitCode !== undefined);
  const spin = tool.status === 'running';

  // 审批卡：独立视觉（warning 色边 + 按钮组）；决策直接回填 cap.agent.loop
  if (isApproval) {
    return (
      <div className="chat-msg tool">
        <div className="chat-avatar" aria-hidden="true"><span className="tc-letter">{tool.name.slice(0, 1).toUpperCase()}</span></div>
        <div className="tc-approval" data-testid={`tc-approval-${tool.callId}`}>
          <div className="tc-approval-head">⚠ 工具请求执行（{tool.name}）</div>
          <pre className="tc-cmd">{tool.command}</pre>
          <div className="tc-approval-btns">
            <button className="tc-btn primary" onClick={() => resolveApproval(tool.callId, 'once')}>允许一次</button>
            <button className="tc-btn" onClick={() => resolveApproval(tool.callId, 'always')}>总是允许该前缀</button>
            <button className="tc-btn danger" onClick={() => resolveApproval(tool.callId, 'deny')}>拒绝</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="chat-msg tool">
      <div className="chat-avatar" aria-hidden="true"><span className="tc-letter">{tool.name.slice(0, 1).toUpperCase()}</span></div>
      <div
        className={`tc-card ${tool.status === 'error' || tool.status === 'denied' ? 'tc-fail' : ''} ${open ? 'tc-open' : ''}`}
        data-testid={`tc-${tool.callId}`}
        style={{ borderLeftColor: CARD_ACCENT }}
      >
        <button className="tc-head" onClick={() => hasBody && setOpen(!open)} disabled={!hasBody}>
          <span className={`tc-status ${spin ? 'spin' : ''}`} aria-hidden="true">{statusIcon(tool.status)}</span>
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
            {(tool.stdout || tool.stderr) && (
              <>
                <div className="tc-section-label">输出</div>
                <pre className={`tc-output ${tool.stderr && !tool.stdout ? 'tc-stderr' : ''}`}>
                  {tool.stdout}
                  {tool.stderr ? `\n[stderr]\n${tool.stderr}` : ''}
                </pre>
              </>
            )}
            {tool.exitCode !== undefined && <div className="tc-exit">退出码 {tool.exitCode}{tool.truncated ? ' · 输出已截断' : ''}</div>}
          </div>
        )}
      </div>
    </div>
  );
}
