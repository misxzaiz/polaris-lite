/**
 * 可折叠块组（参考 Polaris chat-desk blockGrouping 的收敛版）。
 *
 * 规则（对齐 Polaris plans/tool-block-collapse-behavior-fix.md）：
 * - 连续 tool 块归为一个折叠组（lite 无 thinking 块）；非空 text 块打断分组；
 * - 流式期间平铺（过程可见，无组壳）；结束后自动折叠为一条汇总条；
 * - 展开态：块平铺 + 底部轻量「收起」。
 */
import { useEffect, useState } from 'react';
import { Markdown } from './markdown';
import type { AsstBlock, ToolCardData, ToolCardMessage } from './store';
import { ToolCard } from './ToolCard';
import { InteractiveCard } from './InteractiveCard';

/** ToolCard 契约是 ToolCardMessage（msg.tool）；块内只有 card 数据——shim 适配 */
function CardShim({ card }: { card: ToolCardData }) {
  return <ToolCard msg={{ id: '', role: 'tool', content: '', createdAt: 0, tool: card } as ToolCardMessage} />;
}

type ToolBlock = Extract<AsstBlock, { type: 'tool' }>;

/** 识别相邻 tool 块分组（非空 text 打断） */
function identifyGroups(blocks: AsstBlock[]): { start: number; blocks: ToolBlock[] }[] {
  const groups: { start: number; blocks: ToolBlock[] }[] = [];
  let current: ToolBlock[] = [];
  let start = -1;
  const flush = () => {
    if (current.length > 0) {
      groups.push({ start, blocks: current });
      current = [];
      start = -1;
    }
  };
  blocks.forEach((b, i) => {
    if (b.type === 'tool') {
      if (current.length === 0) start = i;
      current.push(b);
      return;
    }
    if (b.type === 'text' && b.text.trim().length > 0) flush();
  });
  flush();
  return groups;
}

function GroupSummary({ count, anyFail, onExpand }: { count: number; anyFail: boolean; onExpand: () => void }) {
  return (
    <button type="button" className="tc-group-summary" onClick={onExpand} aria-expanded={false}>
      <svg className="tc-group-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 6h16M4 12h10M4 18h7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
      <span className="tc-group-label">工具调用</span>
      <span className={`tc-group-chip ${anyFail ? 'fail' : ''}`}>{anyFail ? '有失败' : '全部完成'}</span>
      <span className="tc-group-count">{count} 项</span>
      <svg className="tc-chevron" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </button>
  );
}

/** 单个折叠组：流式平铺 / 结束折叠汇总条 */
function CollapsibleGroup({ blocks, streaming }: { blocks: ToolBlock[]; streaming: boolean }) {
  const [expanded, setExpanded] = useState(streaming);
  useEffect(() => {
    if (!streaming && expanded) setExpanded(false);
  }, [streaming]);

  const anyFail = blocks.some((b) => b.card.status === 'error' || b.card.status === 'denied');

  if (streaming) {
    return <>{blocks.map((b, i) => <CardShim key={b.card.callId || i} card={b.card} />)}</>;
  }
  return (
    <div className="tc-group">
      {!expanded && <GroupSummary count={blocks.length} anyFail={anyFail} onExpand={() => setExpanded(true)} />}
      {expanded && (
        <>
          {blocks.map((b, i) => <CardShim key={b.card.callId || i} card={b.card} />)}
          <button type="button" className="tc-group-collapse" onClick={() => setExpanded(false)}>收起</button>
        </>
      )}
    </div>
  );
}

/**
 * assistant blocks 渲染入口：分组 + 平铺（text→Markdown，tool→ToolCard，
 * interactive→InteractiveCard）。连续 tool 块归组；非空 text 块打断分组并原序渲染
 * （流式末尾带光标）；interactive 块独立渲染（不归组）。
 */
export function renderBlocks(blocks: AsstBlock[], streaming: boolean): React.ReactNode {
  const groups = identifyGroups(blocks);

  // 块索引 → 所属组序号（组内 tool 块连续）
  const owner = new Map<number, number>();
  let gi = -1;
  let inGroup = false;
  blocks.forEach((b, i) => {
    if (b.type === 'tool') {
      if (!inGroup) { gi += 1; inGroup = true; }
      owner.set(i, gi);
    } else if (b.type === 'text' && b.text.trim().length > 0) {
      inGroup = false;
    }
  });

  const result: React.ReactNode[] = [];
  const processed = new Set<number>();
  blocks.forEach((b, i) => {
    if (processed.has(i)) return;
    const g = owner.get(i);
    if (g !== undefined) {
      const group = groups[g];
      result.push(<CollapsibleGroup key={`g-${group.start}`} blocks={group.blocks} streaming={streaming} />);
      // 组内所有 tool 块索引标记已处理（从 i 起连续 tool 块）
      let seen = 0;
      for (let k = i; k < blocks.length && seen < group.blocks.length; k++) {
        if (blocks[k].type === 'tool') { processed.add(k); seen += 1; }
      }
    } else if (b.type === 'interactive') {
      result.push(<InteractiveCard key={`ia-${b.card.callId}`} callId={b.card.callId} kind={b.card.kind} title={b.card.title} payload={b.card.payload} />);
    } else if (b.type === 'text') {
      result.push(<div key={`t-${i}`} className="tc-text"><Markdown text={b.text} /></div>);
      if (streaming && i === blocks.length - 1) result.push(<span key={`cur-${i}`} className="cursor" />);
    }
  });
  return result;
}
