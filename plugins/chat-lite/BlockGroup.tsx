/**
 * 可折叠块组（参考 Polaris chat-desk blockGrouping 的收敛版）。
 *
 * 规则：
 * - 连续 tool 块归为一个折叠组（lite 无 thinking 块）；非空 text 块打断分组；
 * - 默认折叠为一条汇总条（含流式期间，过程密度可控）：
 *   · 流式中显示「执行中 · N 项」，有失败即时显示「有失败」；
 *   · 结束后显示「全部完成 / 有失败 · N 项」；
 * - 展开态：块平铺，工具卡自身仍可展开看命令/输出 + 底部轻量「收起」。
 *
 * 变更说明：旧版流式全程平铺，4~6 个 bash 调用会把消息区铺满（截图中 4 张卡
 * 连续展开即此场景）。改为默认折叠，想看过程点一下汇总条即可，兼顾密度与可见性。
 */
import { useEffect, useState } from 'react';
import { Markdown } from './markdown';
import type { AsstBlock, ArtifactCardData, ToolCardData, ToolCardMessage } from './store';
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

function GroupSummary({ count, anyFail, streaming, onExpand }: {
  count: number; anyFail: boolean; streaming: boolean; onExpand: () => void;
}) {
  return (
    <button type="button" className={`tc-group-summary ${streaming ? 'live' : ''}`} onClick={onExpand} aria-expanded={false}>
      <svg className="tc-group-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 6h16M4 12h10M4 18h7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
      <span className="tc-group-label">工具调用</span>
      <span className={`tc-group-chip ${anyFail ? 'fail' : ''}`}>
        {anyFail ? '有失败' : streaming ? '执行中' : '全部完成'}
      </span>
      <span className="tc-group-count">{count} 项{streaming ? ' · 点击查看' : ''}</span>
      <svg className="tc-chevron" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </button>
  );
}

/**
 * 单个折叠组：默认折叠汇总条，点开看平铺。
 * 流式期间也默认折叠（但用户可点开看实时过程）；流结束时若处于展开态则自动收起，
 * 回到汇总条——与「结束后收敛」的既有语义保持一致。
 */
function CollapsibleGroup({ blocks, streaming }: { blocks: ToolBlock[]; streaming: boolean }) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!streaming && expanded) setExpanded(false);
  }, [streaming]); // eslint-disable-line react-hooks/exhaustive-deps -- 仅在流结束那一瞬收起，用户主动展开不应被其它渲染打断

  const anyFail = blocks.some((b) => b.card.status === 'error' || b.card.status === 'denied');

  return (
    <div className="tc-group">
      {!expanded && (
        <GroupSummary count={blocks.length} anyFail={anyFail} streaming={streaming} onExpand={() => setExpanded(true)} />
      )}
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
      result.push(<InteractiveCard key={`ia-${b.card.callId}`} callId={b.card.callId} kind={b.card.kind} title={b.card.title} payload={b.card.payload} status={b.card.status} answer={b.card.answer} />);
    } else if (b.type === 'artifact') {
      // 通用产物块：渲染器由产物插件经 __PLITE_ARTIFACT_RENDERERS__ 登记（rendererType → 组件），
      // chat-lite 不再为每种可视化产物加硬编码分支。未登记（插件被停用）渲兜底提示，不崩不空白。
      result.push(<ArtifactSlot key={`af-${b.card.callId}`} card={b.card} />);
    } else if (b.type === 'text') {
      result.push(<div key={`t-${i}`} className="tc-text"><Markdown text={b.text} /></div>);
      if (streaming && i === blocks.length - 1) result.push(<span key={`cur-${i}`} className="cursor" />);
    }
  });
  return result;
}

/** 产物渲染器类型（window 桥；组件由 html-preview 等产物插件在 setup 时登记） */
type ArtifactRenderer = (props: { callId: string; title: string; data: Record<string, unknown> }) => React.ReactNode;

function ArtifactSlot({ card }: { card: ArtifactCardData }): React.ReactNode {
  const registry = (window as unknown as Record<string, unknown>).__PLITE_ARTIFACT_RENDERERS__ as
    | Record<string, ArtifactRenderer>
    | undefined;
  const Renderer = card.rendererType ? registry?.[card.rendererType] : undefined;
  if (!Renderer) {
    return (
      <div className="tc-text" data-testid={`af-missing-${card.rendererType}`}>
        产物「{card.title}」的渲染插件未启用（{card.rendererType}）
      </div>
    );
  }
  return <Renderer callId={card.callId} title={card.title} data={card.data} />;
}
